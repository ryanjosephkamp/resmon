/**
 * A mark that carries meaning is 3:1 against what it is drawn on, in both
 * themes: a map's papers, lit or left out, and the Source Wall's marks and the
 * line through each row. Read from the tokens the screens draw with, so a
 * token changed later is held to the same line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast, DEFAULT_ACCENT, hexToRgb, rgbToHex } from '../../../theme/accent';
import { RAMP_ALPHA } from '../../today/Plate';

const css = readFileSync(join(__dirname, '../../../theme/tokens.css'), 'utf8');
const atlas = readFileSync(join(__dirname, '../../../atlas.css'), 'utf8');

/** One theme's tokens, from its own block in `tokens.css`. */
function theme(name: 'dark' | 'light'): Record<string, string> {
  const start = css.indexOf(`:root[data-theme="${name}"]`);
  const block = css.slice(start, css.indexOf('}', start));
  const tokens: Record<string, string> = {};
  for (const [, key, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[key!] = value!;
  return tokens;
}

/** *color* at *alpha* over *ground*, as the canvas composites it. */
function over(color: string, alpha: number, ground: string): string {
  const [r, g, b] = hexToRgb(color);
  const [R, G, B] = hexToRgb(ground);
  return rgbToHex([R + alpha * (r - R), G + alpha * (g - G), B + alpha * (b - B)]);
}

describe.each(['dark', 'light'] as const)('the %s theme', (name) => {
  const t = theme(name);

  test('every lit paper on a map, the oldest included, is 3:1 against the plate', () => {
    const faintest = Math.min(...RAMP_ALPHA);
    expect(contrast(over(t.ink!, faintest, t.plate!), t.plate!)).toBeGreaterThanOrEqual(3);
  });

  test('a paper left out, or a small map\'s other paper, is 3:1 against the plate and quieter than any lit one', () => {
    const dim = contrast(t['dim-mark']!, t.plate!);
    expect(dim).toBeGreaterThanOrEqual(3);
    expect(dim).toBeLessThan(contrast(over(t.ink!, Math.min(...RAMP_ALPHA), t.plate!), t.plate!));
  });

  test('the Source Wall\'s marks and the line through a row are 3:1 against its panel', () => {
    // A point, a ring, a half-filled ring (ink), a struck circle, a dotted ring, a dot, and the line that
    // joins a row's answers.
    const below = ['ink', 'ink-2', 'fault', 'ink-3', 'chart-context']
      .filter((token) => !(contrast(t[token]!, t.panel!) >= 3));
    expect(below).toEqual([]);
  });

  test('the Source Wall\'s not-asked mark is seen in a cell, its chosen column, and the key, and is quieter than an answer', () => {
    const dash = t[markToken('dash')]!;
    const chosenColumn = over(DEFAULT_ACCENT, 0.05, t.panel!);
    for (const ground of [t.panel!, chosenColumn, t.ground!]) expect(contrast(dash, ground)).toBeGreaterThanOrEqual(3);
    expect(contrast(dash, t.panel!)).toBeLessThan(contrast(t.ink!, t.panel!));
    // On a chosen cell, under its wash, it is drawn in the stronger quiet ink.
    expect(contrast(t[chosenToken('dash')]!, over(DEFAULT_ACCENT, 0.3, t.panel!))).toBeGreaterThanOrEqual(3);
  });

  test('the Source Wall\'s gap in the record, a dot, is 3:1 against the cell and the key', () => {
    const dot = t[markToken('dot')]!;
    for (const ground of [t.panel!, t.ground!]) expect(contrast(dot, ground)).toBeGreaterThanOrEqual(3);
  });
});

/** The token a Source Wall mark is drawn in, from its own rule in `atlas.css`. */
function markToken(mark: string): string {
  return ruleToken(`.wall-mark[data-mark="${mark}"]`, (selectors) => selectors.includes(`.wall-mark[data-mark="${mark}"]`));
}

/** The token a mark is drawn in on the chosen cell. */
function chosenToken(mark: string): string {
  return ruleToken(`chosen ${mark}`, (selectors) => selectors.some((s) => s.includes('[aria-pressed="true"]')
    && s.endsWith(`.wall-mark[data-mark="${mark}"]`)));
}

function ruleToken(what: string, matches: (selectors: string[]) => boolean): string {
  for (const [, selector, body] of atlas.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = selector!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
    const color = /(?:^|;)\s*color:\s*var\(--([\w-]+)\)/.exec(body!);
    if (matches(selectors) && color) return color[1]!;
  }
  throw new Error(`atlas.css has no color rule for ${what}`);
}
