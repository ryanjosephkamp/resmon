#!/usr/bin/env node
/**
 * Check the built site.
 *
 * Every check here is about the output as it stands, not about any other
 * version of it:
 *
 *   - the output ships `.nojekyll` and no Jekyll scaffolding, and every
 *     page's scripts are this site's own, within their budget;
 *   - every internal link, every link written inside a document, and every
 *     image resolves to something the site serves, and none is a GitHub `blob`
 *     page;
 *   - every source document has a published page that carries its text;
 *   - every page has exactly one `<h1>`.
 *
 * Exits non-zero on any failure, and prints a line per check either way.
 *
 * Usage, from `site/`:   node scripts/verify-output.mjs [--dir <tree>]
 *
 * The default tree is `../docs`, the published one, and it has to be: `dist/`
 * is the Astro build and by construction is *not* what GitHub Pages serves.
 * `sync-docs.mjs` is what adds the preserved sources — the Markdown documents
 * and `api-contract/openapi.json` — and only `docs/` has them. Run against
 * `dist/` this script fails three checks on `openapi.json` alone and says
 * nothing true about the site.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');

const dirArgIndex = process.argv.indexOf('--dir');
const OUT = resolve(SITE, dirArgIndex === -1 ? '../docs' : process.argv[dirArgIndex + 1]);

const SITE_ORIGIN = 'https://ryanjosephkamp.github.io';
const BASE_PATH = '/resmon';

let failures = 0;
const fail = (message) => {
  failures += 1;
  process.stdout.write(`  FAIL  ${message}\n`);
};
const pass = (message) => process.stdout.write(`  ok    ${message}\n`);

/** `/resmon/guide/install/` -> the file GitHub Pages would serve. */
function fileFor(urlPath) {
  const relative = urlPath.startsWith(`${BASE_PATH}/`)
    ? urlPath.slice(BASE_PATH.length + 1)
    : urlPath.replace(/^\//, '');
  if (relative === '' || relative.endsWith('/')) return join(OUT, relative, 'index.html');
  return join(OUT, relative);
}

process.stdout.write('\nOutput\n');

if (existsSync(join(OUT, '.nojekyll'))) pass('.nojekyll present — GitHub Pages serves the files as they are');
else fail('.nojekyll is missing — GitHub Pages would run Jekyll over the built site');

for (const guard of ['_config.yml', 'Gemfile']) {
  if (existsSync(join(OUT, guard))) fail(`${guard} is still in the output — Jekyll scaffolding left behind`);
}

/** Every built HTML file, for the two whole-output properties below. */
function htmlFiles(root, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(root, prefix))) {
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const full = join(root, relativePath);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(root, relativePath));
    else if (relativePath.endsWith('.html')) out.push(relativePath);
  }
  return out;
}

const pages = htmlFiles(OUT);

/*
 * Scripts are this site's own, and small. A page may carry two kinds: the one
 * classic inline script in the head that sets a theme and color chosen on an
 * earlier visit before the page paints, the same on every page, and modules
 * built from this site's sources, served from `/resmon/static/` or, where
 * Astro finds one small enough, written inline. Nothing is loaded from anywhere
 * else, and each page's modules, compressed as GitHub Pages sends them, stay
 * under its budget: the home page carries the plate, which is the app's own
 * map, and every other page only the appearance control.
 */
const SCRIPT_BUDGET = { home: 60 * 1024, page: 6 * 1024 };
const inlineScripts = new Set();
const moduleSize = new Map();
let heaviest = { page: '', bytes: 0 };
for (const page of pages) {
  const html = readFileSync(join(OUT, page), 'utf8');
  let bytes = 0;
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc="([^"]+)"/.exec(attributes)?.[1];
    if (!src) {
      if (/\btype="module"/.test(attributes)) bytes += gzipSync(body).length;
      else inlineScripts.add(body.trim());
      continue;
    }
    if (!/\btype="module"/.test(attributes) || !src.startsWith(`${BASE_PATH}/static/`) || !src.endsWith('.js')) {
      fail(`${page} loads a script that is not one of this site's modules: ${src}`);
      continue;
    }
    const file = fileFor(src);
    if (!existsSync(file)) {
      fail(`${page} loads ${src}, which the output does not hold`);
      continue;
    }
    // A module's own imports count too: Vite splits shared code into chunks the entry imports.
    const seen = new Set();
    const visit = (path) => {
      if (seen.has(path)) return;
      seen.add(path);
      const code = readFileSync(path, 'utf8');
      if (!moduleSize.has(path)) moduleSize.set(path, gzipSync(code).length);
      for (const [, spec] of code.matchAll(/(?:import|from)\s*\(?\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) {
        visit(resolve(dirname(path), spec));
      }
    };
    visit(file);
    for (const path of seen) bytes += moduleSize.get(path) ?? 0;
  }
  const budget = page === 'index.html' ? SCRIPT_BUDGET.home : SCRIPT_BUDGET.page;
  if (bytes > budget) fail(`${page} carries ${(bytes / 1024).toFixed(1)} KB of compressed script, over its ${budget / 1024} KB budget`);
  if (bytes > heaviest.bytes) heaviest = { page, bytes };
}
if (inlineScripts.size > 1) {
  fail(`${inlineScripts.size} different classic inline scripts across the pages; only the head's appearance script is allowed`);
} else {
  pass(
    `every page's scripts are this site's own: one inline appearance script and this site's modules; ` +
      `the heaviest page, ${heaviest.page || 'none'}, carries ${(heaviest.bytes / 1024).toFixed(1)} KB compressed`,
  );
}

/*
 * Internal links resolve. The guide's links to `docs/*.md` and its in-page
 * anchors are rewritten to site URLs, and a rewrite that produced a
 * plausible-looking URL nothing serves would otherwise go unnoticed until
 * someone clicked it.
 */
const linkPattern = /(?:href|src)="(\/resmon\/[^"#?]*)/g;
const broken = new Map();
let linkCount = 0;
for (const page of pages) {
  const html = readFileSync(join(OUT, page), 'utf8');
  for (const match of html.matchAll(linkPattern)) {
    linkCount += 1;
    const target = fileFor(match[1]);
    if (!existsSync(target) || !statSync(target).isFile()) {
      if (!broken.has(match[1])) broken.set(match[1], []);
      broken.get(match[1]).push(page);
    }
  }
}
if (broken.size) {
  fail(`${broken.size} internal link target(s) do not exist, out of ${linkCount} internal links:`);
  for (const [target, sources] of [...broken].slice(0, 15)) {
    process.stdout.write(`        ${target}  <- ${sources.length} page(s), e.g. ${sources[0]}\n`);
  }
} else {
  pass(`all ${linkCount} internal links across ${pages.length} pages resolve to a file`);
}

/*
 * The links the check above cannot see.
 *
 * It matches `href="/resmon/…"` and nothing else, so it only ever examined
 * links the site's own templates wrote. The links that come out of the
 * *documents* are repository-relative — `http.md`, `../LICENSE`,
 * `../../README.md` — written for GitHub's file browser, where they work. On
 * the published site a browser resolves them against the page's own URL, and
 * they land somewhere else entirely. Nothing caught it: 34 such links were
 * live on the site, including one on the API contract index that resolved to
 * `https://ryanjosephkamp.github.io/README.md` — a different repository's
 * README, on the owner's personal site.
 *
 * So resolve every anchor the way a browser would, from the page's published
 * URL, and sort the result into three kinds of wrong:
 *
 *   - **off-base**: resolves outside `/resmon/`. Another site's problem, or
 *     nobody's.
 *   - **404**: resolves under `/resmon/` to nothing at all.
 *   - **raw source served**: resolves to a file that *is* served — because
 *     `sync-docs.mjs` preserves the Markdown sources in `docs/` — but is
 *     source text, not a page. The reader gets `text/markdown` with no
 *     navigation and no way back, next door to the rendered page. A 200 is
 *     not the same as a working link.
 *
 * **Existence is decided before extension, and that ordering is the point.**
 * Keying the buckets off the extension alone would put every `.md` link in
 * "raw source" whether or not anything served it, understating the 404s. The
 * bucket a link lands in is the answer a browser would get.
 *
 * `src/lib/markdown.ts` rewrites these at render time. This is what says it
 * worked.
 */
const RAW_SOURCE = /(?:\.(?:md|markdown|py|ya?ml|txt|toml|cfg|ini)|\/LICENSE[A-Z_]*)$/;

/** `api-contract/index.html` -> the published URL path a browser would be at. */
const publishedUrlOf = (page) => `${BASE_PATH}/${page.replace(/index\.html$/, '')}`;

/**
 * What GitHub Pages serves for a path under the base, or null.
 *
 * A path ending in `/` is the directory's `index.html`. An extensionless path
 * that names a directory is redirected to it, which is a working link, so it
 * is not counted against anything.
 */
function servedFileFor(resolved) {
  const direct = fileFor(resolved);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  if (/\.[a-z0-9]+$/i.test(resolved)) return null;
  const asDirectory = fileFor(`${resolved}/`);
  return existsSync(asDirectory) ? asDirectory : null;
}

const documentLinks = { offBase: [], notFound: [], rawServed: [] };
let documentLinkCount = 0;
for (const page of pages) {
  const html = readFileSync(join(OUT, page), 'utf8');
  const pageUrl = new URL(publishedUrlOf(page), SITE_ORIGIN);
  for (const match of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
    const href = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;
    documentLinkCount += 1;
    const resolved = new URL(href, pageUrl).pathname;
    const row = `${page}  "${href}"  ->  ${resolved}`;
    if (!resolved.startsWith(`${BASE_PATH}/`)) documentLinks.offBase.push(row);
    else if (servedFileFor(resolved) === null) documentLinks.notFound.push(row);
    else if (RAW_SOURCE.test(resolved)) documentLinks.rawServed.push(row);
  }
}

const KINDS = [
  ['offBase', 'resolve outside /resmon/ altogether'],
  ['notFound', 'resolve under /resmon/ to nothing (404)'],
  ['rawServed', 'are served, but as raw source text rather than the page that renders it'],
];

let documentLinkProblems = 0;
for (const [kind, description] of KINDS) {
  const rows = documentLinks[kind];
  documentLinkProblems += rows.length;
  if (rows.length) {
    fail(`${rows.length} link(s) written inside a document ${description}:`);
    for (const row of rows.slice(0, 10)) process.stdout.write(`        ${row}\n`);
    if (rows.length > 10) process.stdout.write(`        … and ${rows.length - 10} more\n`);
  }
}
if (documentLinkProblems === 0) {
  pass(`all ${documentLinkCount} document links resolve to a rendered page or off-site`);
}

/*
 * Images, which the check above cannot see.
 *
 * It matches `<a … href>`, and an `<img src>` is not one. `rewriteLinks`
 * resolves `![alt](src)` through the same five characters of Markdown as a
 * link, so a relative image in a document source could render as
 * `<img src="https://github.com/…/blob/main/…png">`. A `blob` URL is GitHub's
 * HTML page *about* a file, so the image would render broken.
 *
 * Two properties, because either alone leaves a hole. Every internal `src` resolves to a file the site serves; and no `src`
 * anywhere is a `blob` URL, whatever host wrote it.
 */
process.stdout.write('\nImages — every <img> points at something that is an image\n');

const BLOB_URL = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/blob\//i;
const unservedImages = [];
const blobImages = [];
let imageCount = 0;
for (const page of pages) {
  const html = readFileSync(join(OUT, page), 'utf8');
  const pageUrl = new URL(publishedUrlOf(page), SITE_ORIGIN);
  for (const match of html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/g)) {
    const src = match[1];
    imageCount += 1;
    const row = `${page}  "${src}"`;
    if (BLOB_URL.test(src)) {
      blobImages.push(row);
      continue;
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue; // off-site, and not a blob page
    const resolved = new URL(src, pageUrl).pathname;
    if (!resolved.startsWith(`${BASE_PATH}/`) || servedFileFor(resolved) === null) {
      unservedImages.push(`${row}  ->  ${resolved}`);
    }
  }
}

if (blobImages.length) {
  fail(
    `${blobImages.length} of ${imageCount} <img> element(s) point at a github.com /blob/ URL, ` +
      'which is an HTML page and not an image:',
  );
  for (const row of blobImages.slice(0, 10)) process.stdout.write(`        ${row}\n`);
}
if (unservedImages.length) {
  fail(`${unservedImages.length} of ${imageCount} <img> element(s) point at nothing this site serves:`);
  for (const row of unservedImages.slice(0, 10)) process.stdout.write(`        ${row}\n`);
}
if (!blobImages.length && !unservedImages.length) {
  pass(`all ${imageCount} <img> src values are served by this site or are off-site, and none is a /blob/ page`);
}

// ---------------------------------------------------------------------------
// 4. Every rendered page actually carries its document
//
// The link checks above assert that a file exists at each published path. That
// is not the same as the page having anything on it: a page template that
// rendered an empty body would leave every page in place and every link
// check green. The source Markdown is the thing to compare against: it asks
// whether the page says what its source says.
//
// Two assertions per page, because either alone is weak. A length floor catches
// a page that lost most of itself but not a page that lost one section; a set
// of fragments spread through the document catches a missing section but could
// be satisfied by a page that kept the sampled lines and dropped the rest.
// ---------------------------------------------------------------------------

process.stdout.write('\nContent — every rendered page against its source Markdown\n');

/** Entities survive tag-stripping as text and would corrupt a comparison. */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', '#39': "'", '#x27': "'",
};

function pageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z#0-9x]+);/g, (whole, name) => ENTITIES[name] ?? whole);
}

/**
 * Compare on letters and digits only. SmartyPants turns `'` into `’`, `--` into
 * an en dash and `...` into an ellipsis, Markdown link syntax drops its target,
 * and the HTML adds whitespace wherever a tag was. None of that is a difference
 * in what the page says, and all of it would break a literal comparison.
 */
const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Strip YAML front matter, which is never rendered. */
function markdownBody(source) {
  if (!source.startsWith('---')) return source;
  const end = source.indexOf('\n---', 3);
  return end === -1 ? source : source.slice(end + 4);
}

/**
 * The part of a Markdown source that becomes visible text, so that the
 * coverage ratio below measures what reached the page rather than how many
 * URLs the document happens to contain.
 *
 * This was calibrated the wrong way round first. A floor picked from six
 * sampled documents put `docs/source-landscape.md` at 80% and failed it — not
 * because the page had lost anything, but because that document is 42 KB of
 * provider survey carrying a link on nearly every line, and a link's target is
 * source text that is never rendered. Removing the parts that are not supposed
 * to appear is the fix; moving the floor down until the failure stopped would
 * have been the bug.
 */
function renderableSource(source) {
  return markdownBody(source)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // An autolink renders its URL as the link text, so keep it.
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    // A link or image renders its label or alt text, never its target.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Reference-style definitions render as nothing at all.
    .replace(/^[ \t]*\[[^\]]+\]:[^\n]*$/gm, ' ')
    // Raw HTML in Markdown: the tags and their attributes are not text.
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
}

/**
 * Lines whose rendering is their own text.
 *
 * The filter is narrower than it first looks, because the comparison normalizes
 * to letters and digits. Emphasis markers, inline-code backticks, table pipes
 * and list bullets all vanish from both sides, so a line carrying them is still
 * safe to sample. What is not safe is a link or image, whose target is source
 * text that never renders; raw HTML, whose tags and attributes are not text;
 * and an entity, which survives tag-stripping as its name. Those three are the
 * exclusions.
 *
 * The filter allows everything normalization makes safe, so heavily formatted
 * documents still have lines to sample, and the count of documents with none is
 * reported rather than being allowed to read as full coverage.
 */
function proseFragments(body, wanted) {
  const candidates = body
    .split('\n')
    .map((line) => line.trim().replace(/^(?:[#>\-*+]+|\d+[.)])\s*/, ''))
    .filter((line) => line.length >= 40 && !/[[\]()<>&]/.test(line));
  if (candidates.length === 0) return [];
  const take = Math.min(wanted, candidates.length);
  const step = candidates.length / take;
  const out = [];
  for (let index = 0; index < take; index += 1) {
    const line = candidates[Math.floor(index * step)];
    const fragment = normalize(line).slice(0, 50);
    if (fragment.length >= 25) out.push({ line, fragment });
  }
  return out;
}

/** page path under OUT -> source Markdown path, for every rendered document. */
function documentPairs() {
  const repo = join(SITE, '..');
  const pairs = [];

  // Reference documents.
  const docsDir = join(repo, 'docs');
  for (const file of readdirSync(docsDir)) {
    if (!file.endsWith('.md') || file === 'README.md' || file === 'index.md') continue;
    const name = file.replace(/\.md$/, '');
    pairs.push({ page: `${name}/index.html`, source: join(docsDir, file), label: `docs/${file}` });
  }

  // The API contract.
  const contractDir = join(docsDir, 'api-contract');
  for (const file of readdirSync(contractDir).filter((name) => name.endsWith('.md'))) {
    const name = file.replace(/\.md$/, '');
    pairs.push({
      page: name === 'README' ? 'api-contract/index.html' : `api-contract/${name}/index.html`,
      source: join(contractDir, file),
      label: `docs/api-contract/${file}`,
    });
  }

  // The guide, split out of the README.
  const guideDir = join(SITE, 'src', 'content', 'guide');
  for (const file of readdirSync(guideDir).filter((name) => name.endsWith('.md'))) {
    const name = file.replace(/\.md$/, '');
    pairs.push({
      page: `guide/${name}/index.html`,
      source: join(guideDir, file),
      label: `site/src/content/guide/${file}`,
    });
  }

  return pairs;
}

/**
 * The floor for how much of the source's text must reach the page. The ratio
 * is never below 1 for a complete page — the page adds its own chrome, and
 * Markdown syntax is the only thing normalization removes from the source —
 * while an emptied body scores near 0. 0.90 sits clear of both.
 */
const COVERAGE_FLOOR = 0.9;

const pairs = documentPairs();
const emptyPages = [];
const thinPages = [];
const missingFragments = [];
const unsampled = [];
let fragmentsChecked = 0;
let worstRatio = Infinity;
let worstPage = '';

for (const pair of pairs) {
  const file = join(OUT, pair.page);
  if (!existsSync(file)) {
    emptyPages.push({ ...pair, why: 'the page does not exist' });
    continue;
  }
  const source = readFileSync(pair.source, 'utf8');
  const pageNormal = normalize(pageText(readFileSync(file, 'utf8')));

  /*
   * Two different readings of the same file, deliberately.
   *
   * The ratio measures how much of what *should* render did, so it reads the
   * source with link targets and raw HTML taken out. Fragments are sampled
   * from the raw body instead, because `proseFragments` rejects a line that
   * contains angle brackets and it can only do that if the brackets are still
   * there. Sampling from the stripped text produced five false failures:
   * `` `api-token-<port>` `` had its placeholder removed from the source while
   * the page rendered it as escaped text, so the fragment could never match.
   */
  const sourceNormal = normalize(renderableSource(source));
  const rawBody = markdownBody(source);

  const ratio = sourceNormal.length === 0 ? 1 : pageNormal.length / sourceNormal.length;
  if (ratio < worstRatio) {
    worstRatio = ratio;
    worstPage = pair.page;
  }
  if (ratio < COVERAGE_FLOOR) {
    thinPages.push({ ...pair, ratio, pageChars: pageNormal.length, sourceChars: sourceNormal.length });
  }

  const fragments = proseFragments(rawBody, 10);
  if (fragments.length === 0) {
    // A document that is all tables, code or headings offers no line whose
    // rendering is its own text. Those rest on the coverage ratio alone, and
    // are named rather than quietly counted as checked.
    unsampled.push(pair.label);
    continue;
  }
  for (const { line, fragment } of fragments) {
    fragmentsChecked += 1;
    if (!pageNormal.includes(fragment)) {
      missingFragments.push({ page: pair.page, label: pair.label, line: line.slice(0, 70) });
    }
  }
}

process.stdout.write(`  ${pairs.length} rendered documents, ${fragmentsChecked} prose fragments sampled\n`);

if (emptyPages.length) {
  fail(`${emptyPages.length} source document(s) have no published page:`);
  for (const row of emptyPages.slice(0, 5)) process.stdout.write(`        ${row.label}: ${row.why}\n`);
} else {
  pass(`every one of the ${pairs.length} source documents has a published page`);
}

if (thinPages.length) {
  fail(
    `${thinPages.length} of ${pairs.length} pages carry less than ${COVERAGE_FLOOR * 100}% of ` +
      'their source text:',
  );
  for (const row of thinPages.slice(0, 6)) {
    process.stdout.write(
      `        ${row.page}: ${row.pageChars} chars from a source of ${row.sourceChars} ` +
        `(${(row.ratio * 100).toFixed(1)}%)  <- ${row.label}\n`,
    );
  }
} else {
  pass(
    `every page carries at least ${COVERAGE_FLOOR * 100}% of its source's text ` +
      `(lowest ${(worstRatio * 100).toFixed(1)}%, ${worstPage})`,
  );
}

if (missingFragments.length) {
  fail(`${missingFragments.length} of ${fragmentsChecked} sampled source fragments are absent from their page:`);
  for (const row of missingFragments.slice(0, 6)) {
    process.stdout.write(`        ${row.page} is missing: "${row.line}…"\n`);
  }
} else {
  pass(
    `all ${fragmentsChecked} sampled source fragments appear on their page, across ` +
      `${pairs.length - unsampled.length} of ${pairs.length} documents`,
  );
}
if (unsampled.length) {
  process.stdout.write(
    `  note  ${unsampled.length} document(s) offer no plain prose line to sample and rest on ` +
      `the coverage ratio alone: ${unsampled.join(', ')}\n`,
  );
}

// ---------------------------------------------------------------------------
// 5. Sanity on the output as a whole
// ---------------------------------------------------------------------------

/*
 * Exactly one `<h1>` per page. The guide pages are cut from the README with
 * their heading levels left as they were, so a chunk that happened to begin
 * with the README's own `# resmon — Research Monitor` produced a second
 * top-level heading under the page title. Nothing renders wrong; the document
 * outline is just untrue, and a screen reader reads it.
 */
const wrongH1 = pages
  .map((page) => ({ page, count: (readFileSync(join(OUT, page), 'utf8').match(/<h1[\s>]/g) ?? []).length }))
  .filter((row) => row.count !== 1);
if (wrongH1.length) {
  fail(`${wrongH1.length} of ${pages.length} pages do not have exactly one <h1>:`);
  for (const row of wrongH1.slice(0, 5)) process.stdout.write(`        ${row.page}: ${row.count}\n`);
} else {
  pass(`all ${pages.length} pages have exactly one <h1>`);
}

process.stdout.write(
  failures === 0 ? '\nverify-output: PASS\n' : `\nverify-output: FAIL (${failures})\n`,
);
process.exit(failures === 0 ? 0 : 1);
