#!/usr/bin/env node
/**
 * Check the built site against the live Jekyll site that it replaces.
 *
 * Two questions, both answered against `capture/`, which was taken from the
 * published site before `docs/` was touched:
 *
 *   1. **Does the app still see the same feed?** Not "is the XML valid" and not
 *      "are the bytes the same" — the bytes are not the same and cannot be. The
 *      question is whether `BlogTab.tsx` derives the same post list from the new
 *      feed as from the old one. So this script runs the app's own
 *      `parseAtomFeed` over both feeds and diffs the five fields it produces
 *      per entry: `id`, `title`, `link`, `published` and the 240-character
 *      `summary`. That function is reproduced below from
 *      `resmon_scripts/frontend/src/components/AboutResmon/BlogTab.tsx` with one
 *      adaptation, marked where it occurs.
 *
 *   2. **Does every URL the old site served still resolve?** All 54 of them,
 *      asserted against the files on disk rather than spot-checked. A URL that
 *      ends in `/` must be a directory with an `index.html` in it, because that
 *      is what GitHub Pages serves for such a URL.
 *
 * Exits non-zero on any difference that matters, and prints a table either way.
 * Differences that are intended are listed in EXPECTED_FEED_DIFFERENCES and are
 * reported but not fatal; anything not in that list is fatal.
 *
 * Usage, from `site/`:   node scripts/verify-output.mjs [--dir ../docs]
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const CAPTURE = join(SITE, 'capture');

const dirArgIndex = process.argv.indexOf('--dir');
const OUT = resolve(SITE, dirArgIndex === -1 ? 'dist' : process.argv[dirArgIndex + 1]);

const BLOG_ORIGIN = 'https://ryanjosephkamp.github.io';
const BASE_PATH = '/resmon';

let failures = 0;
const fail = (message) => {
  failures += 1;
  process.stdout.write(`  FAIL  ${message}\n`);
};
const pass = (message) => process.stdout.write(`  ok    ${message}\n`);

// ---------------------------------------------------------------------------
// The app's parser, reproduced.
//
// Copied from `parseAtomFeed` in `BlogTab.tsx`. The one adaptation: the browser
// reports a malformed document by inserting a `<parsererror>` element, which
// the component checks for with `querySelector`. `@xmldom/xmldom` instead calls
// an error handler, so the check is wired to that. Everything else — the
// element names, the `rel="alternate"` preference, the origin lock, the
// `published`-then-`updated` fallback, the `summary`-then-`content` fallback,
// the tag strip, the whitespace collapse, the 240-character slice and the sort
// — is the component's own logic, unchanged. If this drifts from the component
// the comparison stops meaning anything, which is why it is quoted rather than
// paraphrased.
// ---------------------------------------------------------------------------

function parseAtomFeed(xml) {
  try {
    let parseError = false;
    const doc = new DOMParser({
      onError: () => {
        parseError = true;
      },
    }).parseFromString(xml, 'application/xml');
    if (parseError) return [];
    const entries = Array.from(doc.getElementsByTagName('entry'));
    const posts = [];
    for (const entry of entries) {
      const title = entry.getElementsByTagName('title')[0]?.textContent?.trim() ?? '(untitled)';
      const links = Array.from(entry.getElementsByTagName('link'));
      const altLink = links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate');
      const href = (altLink ?? links[0])?.getAttribute('href') ?? '';
      if (!href || !href.startsWith(BLOG_ORIGIN)) continue; // origin lock
      const id = entry.getElementsByTagName('id')[0]?.textContent?.trim() || href;
      const published =
        entry.getElementsByTagName('published')[0]?.textContent?.trim() ||
        entry.getElementsByTagName('updated')[0]?.textContent?.trim() ||
        null;
      const summaryRaw =
        entry.getElementsByTagName('summary')[0]?.textContent ||
        entry.getElementsByTagName('content')[0]?.textContent ||
        '';
      const summary = summaryRaw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
      posts.push({ id, title, link: href, published, summary });
    }
    posts.sort((a, b) => {
      const ta = a.published ? Date.parse(a.published) : 0;
      const tb = b.published ? Date.parse(b.published) : 0;
      return tb - ta;
    });
    return posts;
  } catch {
    return [];
  }
}

/**
 * Feed-level differences that are deliberate. Each is a difference in the XML,
 * none of them in a field the app reads, and each has a reason.
 */
const EXPECTED_FEED_DIFFERENCES = [
  ['<generator>', 'Jekyll 3.10.0 -> Astro. The site is built by Astro now; the app does not read it.'],
  [
    '<updated> (feed level)',
    'was the build clock, now the newest post\'s timestamp, so two builds of the same ' +
      'content produce the same bytes. The app does not read it.',
  ],
  [
    '<content> HTML',
    'rendered by remark/rehype rather than kramdown. Equivalent, not identical: attribute ' +
      'order, some entity spellings and the code-block markup differ. The app strips every ' +
      'tag out of this before using it, and the stripped text is compared below.',
  ],
  ['feed element whitespace', 'jekyll-feed emitted a stray space in the opening <feed ...> tag.'],
];

// ---------------------------------------------------------------------------
// 0. Is the copy above still the component's parser?
//
// Everything the feed comparison claims rests on `parseAtomFeed` being the
// app's function and not a paraphrase of it. That is true on the day it is
// copied and silently stops being true afterwards, so it is pinned.
//
// The copy is NOT byte-identical to the component and cannot be: the component
// is TypeScript, the copy is JavaScript with the annotations removed, and the
// browser's `<parsererror>` check is replaced by `@xmldom/xmldom`'s error
// callback because the browser mechanism does not exist in Node. What is
// pinned instead is the component's own function, comments and whitespace
// removed, so a comment or a reformat does not trip it and a change to what it
// reads from an entry does. When it trips, re-read the component, bring the
// copy into line, and update the hash in the same change.
// ---------------------------------------------------------------------------

const COMPONENT_PATH = join(
  SITE, '..', 'resmon_scripts', 'frontend', 'src', 'components', 'AboutResmon', 'BlogTab.tsx',
);

/** sha256 of the component's `parseAtomFeed`, comments and whitespace stripped. */
const PINNED_PARSER = 'd8b289296668585bc553c989b0c7174357af1cb252241d1d526ce893cdaf7915';

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  let index = source.indexOf('{', start);
  let depth = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

const stripNoise = (code) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();

process.stdout.write('\nParser — is the copy in this file still the component\'s?\n');

if (!existsSync(COMPONENT_PATH)) {
  process.stdout.write('  note  BlogTab.tsx not found; the pin could not be checked\n');
} else {
  const fn = extractFunction(readFileSync(COMPONENT_PATH, 'utf8'), 'function parseAtomFeed(');
  if (!fn) {
    fail('parseAtomFeed is no longer a top-level function in BlogTab.tsx — re-read it');
  } else {
    const digest = createHash('sha256').update(stripNoise(fn)).digest('hex');
    if (digest === PINNED_PARSER) {
      pass(`BlogTab.tsx's parseAtomFeed is unchanged (sha256 ${digest.slice(0, 12)}…)`);
    } else {
      fail(
        `BlogTab.tsx's parseAtomFeed has changed. The copy in this file may no longer be the ` +
          `app's parser, which is what the feed comparison below depends on.\n` +
          `        pinned  ${PINNED_PARSER}\n        now     ${digest}\n` +
          `        Re-read the component, update the copy, then update PINNED_PARSER.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 1. The feed
// ---------------------------------------------------------------------------

process.stdout.write('\nFeed — the app\'s own parser over the old feed and the new one\n');

const oldFeedPath = join(CAPTURE, 'jekyll-feed.xml');
const newFeedPath = join(OUT, 'feed.xml');

if (!existsSync(newFeedPath)) {
  fail(`${newFeedPath} does not exist — the build produced no feed`);
} else {
  const oldXml = readFileSync(oldFeedPath, 'utf8');
  const newXml = readFileSync(newFeedPath, 'utf8');

  const before = parseAtomFeed(oldXml);
  const after = parseAtomFeed(newXml);

  if (before.length === 0) fail('the captured feed parsed to zero entries — the capture is unusable');
  if (after.length === 0) {
    fail('the new feed parsed to ZERO entries. The in-app Blog tab would show an empty post list.');
  }

  /*
   * The entry count is the one thing about this feed that is deliberately not
   * what the capture holds.
   *
   * `jekyll-feed` capped the feed at its own default of 10 and the old
   * `_config.yml` never overrode it, so the capture is a 10-entry feed. The
   * app's Blog tab has no pagination: its post list is whatever the feed
   * carries, which meant 17 of the 27 updates could not be opened from inside
   * the app at all. `FEED_LIMIT` in `src/pages/feed.xml.ts` now carries every
   * post, so the count is expected to differ and the capture is *not* reissued
   * to match — it is the record of what the old site served and stays that way.
   *
   * What replaces the equal-count assertion is two stronger ones:
   *
   *   1. every post source on disk has an entry, so the expectation is derived
   *      from the posts rather than from a number typed here that would go
   *      stale on the 28th post; and
   *   2. the 10 entries the captured feed carried are still the first 10 of the
   *      new feed, in the same order, identical in all five fields the app
   *      reads. A feed that grew by reordering or by rewriting an `<id>` would
   *      make every row in the app's list look new, and that is what this
   *      catches.
   */
  const postSources = readdirSync(join(SITE, '..', 'docs', '_posts')).filter((name) =>
    name.endsWith('.md'),
  );

  if (after.length !== postSources.length) {
    fail(
      `the feed carries ${after.length} of the ${postSources.length} posts in docs/_posts. ` +
        'The Blog tab shows the feed and nothing else, so the rest cannot be opened in the app.',
    );
  } else {
    pass(
      `${after.length} entries — every one of the ${postSources.length} posts in docs/_posts ` +
        `(the captured feed carried ${before.length})`,
    );
  }

  const FIELDS = ['id', 'title', 'link', 'published', 'summary'];
  let mismatches = 0;
  const rows = [];
  for (let index = 0; index < before.length; index += 1) {
    const a = before[index];
    const b = after[index];
    if (!b) {
      mismatches += 1;
      rows.push(`  [${index}] in the captured feed only: ${a.id}`);
      continue;
    }
    const differing = FIELDS.filter((field) => a[field] !== b[field]);
    if (differing.length === 0) {
      rows.push(`  [${index}] identical  ${a.id.replace(`${BLOG_ORIGIN}${BASE_PATH}`, '')}`);
    } else {
      mismatches += 1;
      rows.push(`  [${index}] DIFFERS in ${differing.join(', ')}`);
      for (const field of differing) {
        rows.push(`        old ${field}: ${JSON.stringify(a[field])}`);
        rows.push(`        new ${field}: ${JSON.stringify(b[field])}`);
      }
    }
  }
  for (let index = before.length; index < after.length; index += 1) {
    rows.push(
      `  [${index}] added     ${after[index].id.replace(`${BLOG_ORIGIN}${BASE_PATH}`, '')}`,
    );
  }
  process.stdout.write(`${rows.join('\n')}\n`);

  if (mismatches === 0) {
    pass(
      `all ${FIELDS.length} fields the app reads (${FIELDS.join(', ')}) are identical ` +
        `for all ${before.length} entries the captured feed carried, and in the same order`,
    );
  } else {
    fail(`${mismatches} of ${before.length} captured entries differ in a field the app reads`);
  }

  // Byte comparison, reported rather than asserted — the answer is known to be
  // "no", and saying so precisely is more useful than pretending otherwise.
  const identicalBytes = oldXml === newXml;
  process.stdout.write(
    `  note  bytes ${identicalBytes ? 'identical' : 'differ'}: ` +
      `${Buffer.byteLength(oldXml)} -> ${Buffer.byteLength(newXml)}\n`,
  );
  for (const [what, why] of EXPECTED_FEED_DIFFERENCES) {
    process.stdout.write(`  note  intended difference — ${what}: ${why}\n`);
  }
}

// ---------------------------------------------------------------------------
// 2. Every URL the old site served
// ---------------------------------------------------------------------------

process.stdout.write('\nURLs — every path the live Jekyll site linked to\n');

const captured = readFileSync(join(CAPTURE, 'jekyll-urls.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

/** `/resmon/2026/09/21/resmon-update-26/` -> the file GitHub Pages would serve. */
function fileFor(urlPath) {
  const relative = urlPath.startsWith(`${BASE_PATH}/`)
    ? urlPath.slice(BASE_PATH.length + 1)
    : urlPath.replace(/^\//, '');
  if (relative === '' || relative.endsWith('/')) return join(OUT, relative, 'index.html');
  return join(OUT, relative);
}

const missing = [];
const present = [];
for (const urlPath of captured) {
  const file = fileFor(urlPath);
  if (existsSync(file) && statSync(file).isFile()) present.push(urlPath);
  else missing.push(urlPath);
}

const posts = captured.filter((p) => /^\/resmon\/\d{4}\/\d{2}\/\d{2}\//.test(p));
const missingPosts = missing.filter((p) => posts.includes(p));

process.stdout.write(`  ${present.length} of ${captured.length} captured URLs resolve to a file\n`);
if (missingPosts.length) {
  fail(`${missingPosts.length} of the ${posts.length} post permalinks do not resolve:`);
  for (const p of missingPosts) process.stdout.write(`        ${p}\n`);
} else {
  pass(`all ${posts.length} post permalinks resolve`);
}

/**
 * URLs that are gone on purpose. `assets/main.css` was the `minima` theme's
 * stylesheet; the theme is gone, so the file is too. Nothing outside the old
 * site's own pages ever linked to it, and the app does not fetch it.
 */
const INTENTIONALLY_GONE = new Set([`${BASE_PATH}/assets/main.css`]);

const unexpected = missing.filter((p) => !INTENTIONALLY_GONE.has(p));
if (unexpected.length) {
  fail(`${unexpected.length} URL(s) no longer resolve and are not on the intended-removal list:`);
  for (const p of unexpected) process.stdout.write(`        ${p}\n`);
} else {
  const gone = missing.filter((p) => INTENTIONALLY_GONE.has(p));
  pass(
    `every other captured URL resolves` +
      (gone.length ? `; ${gone.length} removed on purpose: ${gone.join(', ')}` : ''),
  );
}

process.stdout.write('\nOutput\n');

if (existsSync(join(OUT, '.nojekyll'))) pass('.nojekyll present — GitHub Pages serves the files as they are');
else fail('.nojekyll is missing — GitHub Pages would run Jekyll over the built site');

for (const guard of ['_config.yml', 'Gemfile', '_posts/index.html']) {
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

// No client JavaScript. The site is content; a script tag on a content page
// would be something that crept in rather than something that was chosen.
const withScripts = pages.filter((page) => /<script[\s>]/i.test(readFileSync(join(OUT, page), 'utf8')));
if (withScripts.length) {
  fail(`${withScripts.length} of ${pages.length} pages carry a <script> tag: ${withScripts.slice(0, 5).join(', ')}`);
} else {
  pass(`all ${pages.length} built pages ship zero client JavaScript`);
}

/*
 * Internal links resolve. This is the check that covers the README split: the
 * old readme's `docs/backup.md` links and its two in-page anchors were
 * rewritten to site URLs, and a rewrite that produced a plausible-looking URL
 * nothing serves would otherwise go unnoticed until someone clicked it.
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
 *   - **raw source**: resolves to a `.md`, `.py`, `.yml` or `LICENSE` path.
 *     Some of those paths really are served, because `sync-docs.mjs` preserves
 *     the Markdown sources in `docs/` — so the reader gets plain source text
 *     with no navigation and no way back, rather than the rendered page that
 *     exists one directory over. A 200 is not the same as a working link.
 *   - **404**: resolves under `/resmon/` to nothing at all.
 *
 * `src/lib/markdown.ts` rewrites these at render time. This is what says it
 * worked.
 */
const RAW_SOURCE = /(?:\.(?:md|markdown|py|ya?ml|txt|toml|cfg|ini)|\/LICENSE[A-Z_]*)$/;

/** `api-contract/index.html` -> the published URL path a browser would be at. */
const publishedUrlOf = (page) => `${BASE_PATH}/${page.replace(/index\.html$/, '')}`;

const documentLinks = { offBase: [], rawSource: [], notFound: [] };
let documentLinkCount = 0;
for (const page of pages) {
  const html = readFileSync(join(OUT, page), 'utf8');
  const pageUrl = new URL(publishedUrlOf(page), BLOG_ORIGIN);
  for (const match of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
    const href = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;
    documentLinkCount += 1;
    const resolved = new URL(href, pageUrl).pathname;
    const row = `${page}  "${href}"  ->  ${resolved}`;
    if (!resolved.startsWith(`${BASE_PATH}/`)) documentLinks.offBase.push(row);
    else if (RAW_SOURCE.test(resolved)) documentLinks.rawSource.push(row);
    else if (!existsSync(fileFor(resolved))) documentLinks.notFound.push(row);
  }
}

const KINDS = [
  ['offBase', 'resolve outside /resmon/ altogether'],
  ['rawSource', 'resolve to raw source text instead of the page that renders it'],
  ['notFound', 'resolve under /resmon/ to nothing'],
];

/**
 * Four links in three posts point at files that are not in the repository at
 * all — `update_4_25_26_workflow.md` and three like it, written when those
 * files sat beside the post and gone before the repository was public. There
 * is nowhere to rewrite them to. They are listed by name so that the number
 * below is a decision rather than a tolerance, and they stay in the posts
 * because a post is a dated record and is not edited after the fact.
 */
const UNRESOLVABLE = new Set([
  '/resmon/2026/04/25/update_4_25_26/update_4_25_26_workflow.md',
  '/resmon/2026/04/27/update_4_27_26/update_4_27_26_workflow.md',
  '/resmon/2026/05/05/resmon-update-4/resmon_update_4_overview.md',
  '/resmon/2026/05/05/resmon-update-4/update_5_5_26_workflow.md',
]);

let documentLinkProblems = 0;
for (const [kind, description] of KINDS) {
  const rows = documentLinks[kind].filter((row) => !UNRESOLVABLE.has(row.split('  ->  ')[1]));
  documentLinkProblems += rows.length;
  if (rows.length) {
    fail(`${rows.length} link(s) written inside a document ${description}:`);
    for (const row of rows.slice(0, 10)) process.stdout.write(`        ${row}\n`);
    if (rows.length > 10) process.stdout.write(`        … and ${rows.length - 10} more\n`);
  }
}
if (documentLinkProblems === 0) {
  const tolerated = [...documentLinks.offBase, ...documentLinks.rawSource, ...documentLinks.notFound];
  pass(
    `all ${documentLinkCount - tolerated.length} of ${documentLinkCount} document links resolve ` +
      `to a rendered page or off-site; the other ${tolerated.length} are the named files that ` +
      'left the repository before it was public',
  );
}

// ---------------------------------------------------------------------------
// 4. Every rendered page actually carries its document
//
// The URL check above asserts that a file exists at each published path. That
// is not the same as the page having anything on it, and the difference is not
// hypothetical: setting `html = ''` in `[...permalink].astro` left all 27 post
// pages in place, took the built output from 459,594 bytes to 196,108 — 57% of
// what the app's `<webview>` displays, gone — and every check in this script
// still reported PASS. A reviewer found that, not this file.
//
// `capture/` holds the old feed and the old URL list, not the old page HTML, so
// there is nothing to diff the rendering against. The source Markdown is the
// thing that is available, and it is the right thing anyway: it asks whether
// the page says what its source says, which is the property, rather than
// whether two renderers agree.
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
 * The first attempt excluded emphasis, code and pipes too, and left 5 of the 67
 * documents with nothing to sample — four early posts and one guide page, all
 * heavily formatted. Widening the filter to what normalization actually makes
 * safe covers them, and the remaining count is reported either way rather than
 * being allowed to read as full coverage.
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

  // Posts. The published directory is found by slug rather than by re-deriving
  // the date, so this does not quietly repeat whatever `postPath` decided.
  const postDir = join(repo, 'docs', '_posts');
  const postPages = pages.filter((page) => /^\d{4}\/\d{2}\/\d{2}\//.test(page));
  for (const file of readdirSync(postDir).filter((name) => name.endsWith('.md'))) {
    const slug = file.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
    const page = postPages.find((candidate) => candidate.split('/')[3] === slug);
    if (!page) {
      fail(`no published page found for docs/_posts/${file}`);
      continue;
    }
    pairs.push({ page, source: join(postDir, file), label: `docs/_posts/${file}` });
  }

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
 * The floor for how much of the source's text must reach the page. Measured
 * ratios across all 67 documents run from 1.00 to 1.61 — above 1 because the
 * page adds its own chrome, and never below because Markdown syntax is the only
 * thing normalization removes from the source. 0.90 therefore sits clear of the
 * real minimum, while an emptied body scores about 0.03.
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

/*
 * `<time datetime="...">` must be a valid HTML date string. The posts' front
 * matter is not one — `2026-04-24 12:00:00 -0400` uses a space for the
 * separator and an offset with no colon — and an attribute filled with it
 * looks machine-readable without being so, which is the kind of thing nothing
 * complains about until something tries to read it. Accepts the forms HTML
 * allows here: a date, or a date and time with `Z` or a `±HH:MM` offset.
 */
const DATETIME_OK = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const badDatetimes = [];
let datetimeCount = 0;
for (const page of pages) {
  const html = readFileSync(join(OUT, page), 'utf8');
  for (const match of html.matchAll(/<time[^>]*\sdatetime="([^"]*)"/g)) {
    datetimeCount += 1;
    if (!DATETIME_OK.test(match[1])) badDatetimes.push({ page, value: match[1] });
  }
}
if (badDatetimes.length) {
  fail(`${badDatetimes.length} of ${datetimeCount} <time datetime> values are not valid HTML date strings:`);
  for (const bad of badDatetimes.slice(0, 5)) {
    process.stdout.write(`        ${bad.page}: ${JSON.stringify(bad.value)}\n`);
  }
} else {
  pass(`all ${datetimeCount} <time datetime> values are valid HTML date strings`);
}

process.stdout.write(
  failures === 0 ? '\nverify-output: PASS\n' : `\nverify-output: FAIL (${failures})\n`,
);
process.exit(failures === 0 ? 0 : 1);
