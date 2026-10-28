import {
  DEFAULT_ACCENT, SUGGESTED_ACCENTS, SURFACES, TARGETS,
  accentTones, contrast, hexToRgb, hslToRgb, leastContrast, normalizeHex, rgbToHex, rgbToHsl,
  type ThemeName,
} from '../accent';

const THEMES: ThemeName[] = ['dark', 'light'];

/**
 * Every hue in 15-degree steps at five saturations and seven lightnesses, plus
 * the greys and the two extremes: 530 colors, the worst of them included on
 * purpose (navy on the night chart, pale yellow on the page, mid grey on both).
 */
function sweep(): string[] {
  const colors = new Set<string>(['#000000', '#ffffff', '#808080', '#777777', '#0000ff', '#ffff00', '#1a1a40']);
  for (let h = 0; h < 360; h += 15) {
    for (const s of [0.15, 0.4, 0.65, 0.85, 1]) {
      for (const l of [0.08, 0.2, 0.35, 0.5, 0.65, 0.8, 0.94]) {
        colors.add(rgbToHex(hslToRgb([h / 360, s, l])));
      }
    }
  }
  for (let g = 0; g <= 255; g += 17) colors.add(rgbToHex([g, g, g]));
  return [...colors];
}

describe('accent tones hold their contrast for any color, in both themes', () => {
  const colors = sweep();

  test.each(THEMES)('%s: text, marks, fills and the text on fills all clear their lines', (theme) => {
    const { surfaces } = SURFACES[theme];
    const failures: string[] = [];
    for (const color of colors) {
      const t = accentTones(color, theme);
      if (leastContrast(t.ink, surfaces) < TARGETS.ink) failures.push(`${color} ink ${t.ink}`);
      if (leastContrast(t.mark, surfaces) < TARGETS.mark) failures.push(`${color} mark ${t.mark}`);
      if (leastContrast(t.fill, surfaces) < TARGETS.fill) failures.push(`${color} fill ${t.fill}`);
      if (contrast(t.fill, t.onFill) < TARGETS.onFill) failures.push(`${color} on-fill ${t.onFill} on ${t.fill}`);
    }
    expect(failures).toEqual([]);
    expect(colors.length).toBeGreaterThan(500);
  });

  test.each(THEMES)('%s: a tone keeps the chosen hue when the color has one', (theme) => {
    for (const color of colors) {
      const [h, s] = rgbToHsl(hexToRgb(color));
      if (s < 0.25) continue;
      const t = accentTones(color, theme);
      for (const tone of [t.ink, t.mark, t.fill]) {
        const [th, ts, tl] = rgbToHsl(hexToRgb(tone));
        // Rounding to whole channels moves hue a little, most near black and
        // white, where there is little hue left to keep.
        if (tl < 0.06 || tl > 0.94 || ts < 0.1) continue;
        const delta = Math.min(Math.abs(th - h), 1 - Math.abs(th - h)) * 360;
        expect({ color, tone, delta: delta < 6 }).toEqual({ color, tone, delta: true });
      }
    }
  });
});

describe('what is drawn is the color chosen whenever it already reads', () => {
  test('the default amber is drawn as itself on the night chart', () => {
    const t = accentTones(DEFAULT_ACCENT, 'dark');
    expect([t.ink, t.mark, t.fill]).toEqual([DEFAULT_ACCENT, DEFAULT_ACCENT, DEFAULT_ACCENT]);
    expect(t.adjusted).toBe(false);
  });

  test('the default amber is deepened on the page, and says so', () => {
    const t = accentTones(DEFAULT_ACCENT, 'light');
    expect(t.ink).not.toBe(DEFAULT_ACCENT);
    expect(t.adjusted).toBe(true);
  });

  test('a tone that is moved is the nearest one that passes, not just any', () => {
    const t = accentTones('#1a1a40', 'dark');
    const { surfaces } = SURFACES.dark;
    // One step back toward the chosen lightness fails the line.
    const [h, s, l] = rgbToHsl(hexToRgb(t.ink));
    expect(leastContrast(rgbToHex(hslToRgb([h, s, l - 0.01])), surfaces)).toBeLessThan(TARGETS.ink);
  });

  test('no color and an unreadable color both mean the default', () => {
    expect(accentTones(null, 'dark').chosen).toBe(DEFAULT_ACCENT);
    expect(accentTones('not a color', 'light').chosen).toBe(DEFAULT_ACCENT);
  });

  test('every suggestion is a distinct, valid color', () => {
    const hexes = SUGGESTED_ACCENTS.map((s) => normalizeHex(s.hex));
    expect(hexes).not.toContain(null);
    expect(new Set(hexes).size).toBe(hexes.length);
    expect(hexes[0]).toBe(DEFAULT_ACCENT);
  });
});

describe('normalizeHex', () => {
  test.each([
    ['#FF8A3D', '#ff8a3d'], ['ff8a3d', '#ff8a3d'], ['#abc', '#aabbcc'], [' #abc ', '#aabbcc'],
    ['#ff8a3', null], ['#ff8a3d00', null], ['orange', null], ['', null],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeHex(input)).toBe(expected);
  });
});
