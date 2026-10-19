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

/* ---------------------------------------------------------------------------
 * Contrast, on the tokens themselves.
 *
 * Every color on this site is a token, which means the question "is the text
 * readable" can be answered here, from the file, instead of needing a browser
 * and a page to measure. It was not being asked, and the answer was no:
 * `--color-text-faint` — the "UPDATE" eyebrow, the "On this page" heading, the
 * "Previous" label, the "README lines 1-69" provenance line — came to 3.58:1
 * against `--color-surface` in light mode, where 12.48px text needs 4.5:1.
 * Dark mode passed. It was found by opening the published site and measuring
 * it, which is the thing this check exists so that nobody has to do again.
 *
 * Each ramp is read separately, because dark is rebuilt rather than inverted
 * and a single resolved set of values would be neither one.
 * ------------------------------------------------------------------------- */

const tokenSource = readFileSync(TOKENS, 'utf8');
const darkStart = tokenSource.indexOf('prefers-color-scheme: dark');

/** The token declarations in one slice of the file, later wins. */
function declarationsIn(slice) {
  const map = new Map();
  for (const [, name, value] of slice.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(name, value.trim());
  }
  return map;
}

/** Resolve `var(--x)` chains down to a literal. */
function resolve(name, declarations) {
  let value = declarations.get(name);
  for (let hops = 0; hops < 8 && value?.startsWith('var('); hops += 1) {
    value = declarations.get(value.slice(4, value.indexOf(')')).trim());
  }
  return value;
}

const relativeLuminance = (hex) =>
  [1, 3, 5]
    .map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((total, channel, index) => total + [0.2126, 0.7152, 0.0722][index] * channel, 0);

function contrast(a, b) {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Text token, surface token, and the ratio it has to reach.
 *
 * 4.5:1 is AA for text below 18.66px bold or 24px regular, which is all of
 * these: `--color-text-faint` is set at the smallest step in the scale.
 */
const CONTRAST_PAIRS = [
  ['--color-text', '--color-canvas', 4.5],
  ['--color-text', '--color-surface', 4.5],
  ['--color-text-muted', '--color-canvas', 4.5],
  ['--color-text-muted', '--color-surface', 4.5],
  ['--color-text-faint', '--color-canvas', 4.5],
  ['--color-text-faint', '--color-surface', 4.5],
  ['--color-link', '--color-canvas', 4.5],
  ['--color-link', '--color-surface', 4.5],
  ['--color-code-text', '--color-code-bg', 4.5],
];

let contrastChecked = 0;
for (const [label, slice] of [
  ['light', tokenSource.slice(0, darkStart)],
  ['dark', tokenSource.slice(darkStart)],
]) {
  // The dark block overrides part of the ramp; the rest is inherited.
  const declarations =
    label === 'dark'
      ? new Map([...declarationsIn(tokenSource.slice(0, darkStart)), ...declarationsIn(slice)])
      : declarationsIn(slice);
  for (const [text, surface, minimum] of CONTRAST_PAIRS) {
    const fg = resolve(text, declarations);
    const bg = resolve(surface, declarations);
    if (!/^#[0-9a-f]{6}$/i.test(fg ?? '') || !/^#[0-9a-f]{6}$/i.test(bg ?? '')) {
      problems.push({
        file: relative(SITE, TOKENS),
        line: 0,
        name: 'unresolvable color',
        match: `${text} on ${surface} (${label})`,
        text: `${fg} on ${bg}`,
      });
      continue;
    }
    contrastChecked += 1;
    const ratio = contrast(fg, bg);
    if (ratio < minimum) {
      problems.push({
        file: relative(SITE, TOKENS),
        line: 0,
        name: 'contrast below WCAG AA',
        match: `${text} on ${surface} (${label}) is ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
        text: `${fg} on ${bg}`,
      });
    }
  }
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

const tokenCount = (tokenSource.match(/^\s*--[\w-]+:/gm) ?? []).length;
process.stdout.write(
  `check-tokens: OK — ${files.length} file(s) checked, 0 hard-coded values, ` +
    `${tokenCount} token declarations in src/styles/tokens.css, ` +
    `${contrastChecked} text-on-surface pairs at or above WCAG AA\n`,
);
