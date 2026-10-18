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

  if (before.length !== after.length) {
    fail(`entry count ${before.length} -> ${after.length}`);
  } else {
    pass(`${after.length} entries, same count as the captured feed`);
  }

  const FIELDS = ['id', 'title', 'link', 'published', 'summary'];
  let mismatches = 0;
  const rows = [];
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    const a = before[index];
    const b = after[index];
    if (!a || !b) {
      mismatches += 1;
      rows.push(`  [${index}] present in only one feed`);
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
  process.stdout.write(`${rows.join('\n')}\n`);

  if (mismatches === 0) {
    pass(
      `all ${FIELDS.length} fields the app reads (${FIELDS.join(', ')}) are identical ` +
        `for all ${after.length} entries`,
    );
  } else {
    fail(`${mismatches} of ${before.length} entries differ in a field the app reads`);
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

// ---------------------------------------------------------------------------
// 3. Sanity on the output as a whole
// ---------------------------------------------------------------------------

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
