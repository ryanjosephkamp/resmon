#!/usr/bin/env node
/**
 * Fail if a design value was written anywhere but `src/styles/tokens.css`.
 *
 * The app's stylesheet is one 5,000-line file holding 13 custom properties and
 * 51 hard-coded hex values, and the reason nobody restyles it is that nobody
 * can find all 51. This check is how that does not happen again here: a color,
 * a length or a duration written literally in a component is a value that the
 * design language landing later cannot reach.
 *
 * It looks in every `.astro` file and in `src/styles/base.css` for
 *
 *   - hex colors, `rgb(`, `rgba(`, `hsl(`, `hsla(`, `oklch(`, `color(`
 *   - lengths in px, pt, em, rem, ch or vh outside a media query
 *   - durations in ms or s
 *
 * and allows a small set of values that carry no design decision: `0`, `100%`,
 * `1fr`, and the `min-width` breakpoints in media queries, which are layout
 * structure rather than style. Anything else must be a `var(--token)`.
 *
 * Usage, from `site/`:   node scripts/check-tokens.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const SRC = join(SITE, 'src');
const TOKENS = join(SRC, 'styles', 'tokens.css');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const FORBIDDEN = [
  { name: 'hex color', pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { name: 'color function', pattern: /\b(?:rgba?|hsla?|oklch|lab|color)\(/g },
  { name: 'absolute length', pattern: /(?<![\w.-])-?\d*\.?\d+(?:px|pt|em|ch|vh|vw)(?![\w-])/g },
  { name: 'duration', pattern: /(?<![\w.-])-?\d*\.?\d+m?s(?![\w-])/g },
];

/**
 * Lines exempt from the length rule. A breakpoint is where the layout changes,
 * not what it looks like, and expressing one through a custom property does not
 * work in a media query in any case — `@media (min-width: var(--x))` is invalid
 * CSS, which is the whole reason for this exemption rather than a preference.
 */
const isBreakpointLine = (line) => /@media[^{]*\((?:min|max)-(?:width|height):/.test(line);

/** `#` inside a URL fragment, an id selector or prose is not a color. */
const isNotAColor = (match, line) =>
  /href=|url\(|#\$\{|aria-|\[#|id="/.test(line) || !/^#[0-9a-fA-F]{3,8}$/.test(match);

const files = [
  ...walk(SRC).filter((file) => file.endsWith('.astro')),
  join(SRC, 'styles', 'base.css'),
].filter((file) => file !== TOKENS);

const problems = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    // Comments explain why a value is what it is; they are not the value.
    const code = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/, '');
    for (const { name, pattern } of FORBIDDEN) {
      if (name === 'absolute length' && isBreakpointLine(code)) continue;
      for (const match of code.match(pattern) ?? []) {
        if (name === 'hex color' && isNotAColor(match, code)) continue;
        problems.push({
          file: relative(SITE, file),
          line: index + 1,
          name,
          match,
          text: line.trim(),
        });
      }
    }
  });
}

if (problems.length) {
  process.stdout.write(`check-tokens: ${problems.length} hard-coded value(s)\n`);
  for (const problem of problems) {
    process.stdout.write(
      `  ${problem.file}:${problem.line}  ${problem.name} ${problem.match}\n      ${problem.text}\n`,
    );
  }
  process.stdout.write('\nEvery one of these belongs in src/styles/tokens.css as a named token.\n');
  process.exit(1);
}

const tokenCount = (readFileSync(TOKENS, 'utf8').match(/^\s*--[\w-]+:/gm) ?? []).length;
process.stdout.write(
  `check-tokens: OK — ${files.length} file(s) checked, 0 hard-coded values, ` +
    `${tokenCount} token declarations in src/styles/tokens.css\n`,
);
