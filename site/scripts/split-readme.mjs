#!/usr/bin/env node
/**
 * Split the long-form README into the guide pages under `src/content/guide/`.
 *
 * `README.md` at commit b4fd7a3 was 165,523 bytes over 1,608 lines — a manual
 * living in a readme. This script cuts it into pages by line range and proves
 * it lost nothing: the ranges below must tile 1..N exactly once, with no gap
 * and no overlap, and the concatenation of the extracted bodies in line order
 * must equal the original file byte for byte. Both are asserted, and the script
 * exits non-zero rather than writing a partial split.
 *
 * It is a one-shot migration, kept in the tree because the mapping from README
 * section to page is the audit trail for "nothing was lost", and a mapping in a
 * pull-request table is a claim while a mapping in a script that re-derives the
 * original is a check.
 *
 * Usage, from `site/`:
 *
 *     git show b4fd7a3:README.md | node scripts/split-readme.mjs
 *     node scripts/split-readme.mjs path/to/README.md
 *
 * `--check` verifies the split against the source without writing anything.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'src', 'content', 'guide');

/**
 * section -> README line ranges, inclusive, 1-based.
 *
 * Two pages are built from more than one range. `sources` gathers the repository
 * catalog with the terms, date-precision and attribution sections that belong
 * with it but sat 280 lines further down; everything between them is its own
 * page. The ranges still tile the file, which is what the assertion checks.
 */
const PAGES = [
  {
    slug: 'overview',
    order: 1,
    title: 'What resmon is',
    summary:
      'The project in one page: what it monitors, what it promises about what it knows, and the header that tells you which running app you are looking at.',
    ranges: [[1, 69]],
  },
  {
    slug: 'sources',
    order: 2,
    title: 'Sources and their terms',
    summary:
      'The 27 shipped repositories, what each one is asked and how often, which fields its terms permit resmon to keep, and why IEEE Xplore was withdrawn.',
    ranges: [
      [70, 118],
      [399, 476],
    ],
  },
  {
    slug: 'library',
    order: 3,
    title: 'Your local library',
    summary:
      'Managed vaults, importing PDF, TXT and MD files, and the rules for what counts as the same document.',
    ranges: [[119, 165]],
  },
  {
    slug: 'projects',
    order: 4,
    title: 'Projects and selected evidence',
    summary: 'Grouping work into projects and choosing the evidence an answer is allowed to rest on.',
    ranges: [[166, 223]],
  },
  {
    slug: 'assistant',
    order: 5,
    title: 'The assistant and MCP',
    summary:
      'The in-app assistant, the tools it is given, and driving resmon from an external AI harness over MCP.',
    ranges: [[224, 398]],
  },
  {
    slug: 'install',
    order: 6,
    title: 'Install and launch',
    summary:
      'Prerequisites, the backend and frontend setup, installing a published build, opening an unsigned build, and starting the app.',
    ranges: [[477, 615]],
  },
  {
    slug: 'quick-start',
    order: 7,
    title: 'Quick start',
    summary: 'A first Deep Dive, a first Deep Sweep, and a first scheduled routine.',
    ranges: [[616, 669]],
  },
  {
    slug: 'architecture',
    order: 8,
    title: 'Architecture',
    summary:
      'The backend, the renderer, the scheduler, the admission controller, the progress stream, the technology stack and the layout of the source tree.',
    ranges: [[670, 868]],
  },
  {
    slug: 'configuration',
    order: 9,
    title: 'Configuration',
    summary: 'Configuration types, the JSON shape they are stored in, and the export and import workflow.',
    ranges: [[869, 906]],
  },
  {
    slug: 'api-reference',
    order: 10,
    title: 'HTTP API reference',
    summary:
      'The endpoint-by-endpoint tour of the local API. The generated, guarded contract for every route is in the reference section.',
    ranges: [[907, 1254]],
  },
  {
    slug: 'ai-summarization',
    order: 11,
    title: 'AI summarization',
    summary:
      'The provider whitelist, configuring a remote, custom or local provider, fallback chains, using your own subscription as a lane, and per-execution overrides.',
    ranges: [[1255, 1428]],
  },
  {
    slug: 'email-notifications',
    order: 12,
    title: 'Email notifications',
    summary: 'Configuring SMTP, where the password is stored, testing it, and the per-routine controls.',
    ranges: [[1429, 1468]],
  },
  {
    slug: 'backup',
    order: 13,
    title: 'Backup and restore',
    summary: 'Local backup and restore, and the optional Google Drive backup.',
    ranges: [[1469, 1510]],
  },
  {
    slug: 'license',
    order: 14,
    title: 'License',
    summary: 'The project license and where the third-party notices live.',
    ranges: [[1511, 1520]],
  },
  {
    slug: 'contributing',
    order: 15,
    title: 'Contributing',
    summary:
      'Reporting issues, the blog, the Danger Zone, submitting pull requests, commit messages and the code of conduct.',
    ranges: [[1521, 1566]],
  },
  {
    slug: 'acknowledgments',
    order: 16,
    title: 'Acknowledgments',
    summary:
      'The open-access repository providers, the open-source foundations and the standards bodies resmon is built on.',
    ranges: [[1567, Infinity]],
  },
];

function readSource() {
  const arg = process.argv.slice(2).find((value) => !value.startsWith('--'));
  if (arg) return readFileSync(arg, 'utf8');
  return readFileSync(0, 'utf8');
}

function fail(message) {
  process.stderr.write(`split-readme: ${message}\n`);
  process.exit(1);
}

const source = readSource();
if (!source.trim()) fail('no input — pipe README.md in, or pass its path');

// Reported alongside the character count because they differ: the README is
// full of em dashes and curly quotes, so its UTF-8 byte count is larger than
// its JavaScript string length. The equality check below is on the string, so
// it is exact either way; only the number printed needs saying which it is.
const sourceBytes = Buffer.byteLength(source, 'utf8');

// `split('\n')` on a file ending in a newline yields a trailing empty element.
// Keeping it means the join below reproduces the original exactly.
const lines = source.split('\n');
const lastLine = lines.length;

// ---- Proof 1: the ranges tile the file exactly once ------------------------

const resolved = PAGES.map((page) => ({
  ...page,
  ranges: page.ranges.map(([from, to]) => [from, to === Infinity ? lastLine : to]),
}));

const owner = new Array(lastLine + 1).fill(null);
for (const page of resolved) {
  for (const [from, to] of page.ranges) {
    if (from < 1 || to > lastLine || from > to) fail(`${page.slug}: range ${from}..${to} is out of bounds (file has ${lastLine} lines)`);
    for (let line = from; line <= to; line += 1) {
      if (owner[line]) fail(`line ${line} is claimed by both ${owner[line]} and ${page.slug}`);
      owner[line] = page.slug;
    }
  }
}
const unclaimed = [];
for (let line = 1; line <= lastLine; line += 1) if (!owner[line]) unclaimed.push(line);
if (unclaimed.length) fail(`${unclaimed.length} line(s) land nowhere, first is ${unclaimed[0]}`);

// ---- Proof 2: reassembly reproduces the source byte for byte ---------------

const bodies = new Map(
  resolved.map((page) => [
    page.slug,
    page.ranges.map(([from, to]) => lines.slice(from - 1, to).join('\n')),
  ]),
);

const flat = [];
for (const page of resolved) {
  for (let index = 0; index < page.ranges.length; index += 1) {
    flat.push({ from: page.ranges[index][0], text: bodies.get(page.slug)[index] });
  }
}
flat.sort((a, b) => a.from - b.from);
const reassembled = flat.map((chunk) => chunk.text).join('\n');
if (reassembled !== source) {
  fail(
    `reassembly does not match the source (${reassembled.length} bytes vs ${source.length}) — ` +
      'the split would lose or alter content',
  );
}

// ---- Write -----------------------------------------------------------------

const yamlString = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

if (process.argv.includes('--check')) {
  process.stdout.write(
    `split-readme: OK — ${lastLine} lines, ${sourceBytes} bytes (${source.length} characters), ` +
      `${resolved.length} pages, every line claimed exactly once, reassembly identical\n`,
  );
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const page of resolved) {
  const rangeLabels = page.ranges.map(([from, to]) => `${from}-${to}`);
  const frontmatter = [
    '---',
    `title: ${yamlString(page.title)}`,
    `summary: ${yamlString(page.summary)}`,
    `order: ${page.order}`,
    'readmeLines:',
    ...rangeLabels.map((label) => `  - ${yamlString(label)}`),
    '---',
    '',
  ].join('\n');
  const body = bodies.get(page.slug).join('\n');
  writeFileSync(join(OUT_DIR, `${page.slug}.md`), `${frontmatter}${body}`, 'utf8');
}

const total = resolved.reduce((sum, page) => sum + page.ranges.reduce((n, [from, to]) => n + (to - from + 1), 0), 0);
process.stdout.write(
  `split-readme: wrote ${resolved.length} pages covering ${total} of ${lastLine} lines ` +
    `(${sourceBytes} bytes, ${source.length} characters), reassembly identical to the source\n`,
);
for (const page of resolved) {
  const labels = page.ranges.map(([from, to]) => `${from}-${to}`).join(', ');
  process.stdout.write(`  ${page.slug.padEnd(20)} README lines ${labels}\n`);
}
