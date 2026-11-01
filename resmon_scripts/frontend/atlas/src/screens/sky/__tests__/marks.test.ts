/**
 * A mark that carries meaning is 3:1 against what it is drawn on, in both
 * themes: a map's papers, lit or left out, and the Source wall's marks and the
 * line through each row. Read from the tokens the screens draw with, so a
 * token changed later is held to the same line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast, hexToRgb, rgbToHex } from '../../../theme/accent';
import { RAMP_ALPHA } from '../../today/Plate';

const css = readFileSync(join(__dirname, '../../../theme/tokens.css'), 'utf8');

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

  test('the Source wall\'s marks and the line through a row are 3:1 against its panel', () => {
    // A point, a ring, a struck circle, a dotted ring, a dash, and the line that joins a row's answers.
    const below = ['ink', 'ink-2', 'fault', 'ink-3', 'chart-context']
      .filter((token) => !(contrast(t[token]!, t.panel!) >= 3));
    expect(below).toEqual([]);
  });
});
