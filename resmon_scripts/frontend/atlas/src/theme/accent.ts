/**
 * One chosen color, and every tone the interface draws from it.
 *
 * The person may choose any color at all, so nothing here may assume the
 * accent is bright, saturated, or legible. Each tone keeps the chosen hue and
 * saturation and moves only lightness, until it reaches the contrast its job
 * needs against every surface the theme has (ground, panels, raised cards),
 * measured against the one it contrasts with least:
 *
 * - `ink`, accent-colored text (links, a selected row's number): 4.5:1, the
 *   WCAG AA line for body text.
 * - `mark`, rings, the current tab's underline, focus outlines: 3:1, the line
 *   for a non-text mark a person has to see.
 * - `fill`, a primary button or a selected badge: 3:1, with `onFill`, the
 *   theme's near-black or white, at 4.5:1 on it. Where neither reaches that (a
 *   mid-tone fill can sit between them), the fill moves further from the
 *   surface until the one on that side does.
 *
 * So the color on screen can differ from the one chosen: a dark navy is drawn
 * lighter on the night chart, and a pale yellow deeper on the white page.
 * `adjusted` says whether that happened, so Settings can say so instead of
 * letting the swatch and the screen quietly disagree.
 */

export type ThemeName = 'light' | 'dark';

/** The default when nobody has chosen: the night chart's red-flashlight amber. */
export const DEFAULT_ACCENT = '#ff8a3d';

/** Suggestions shown beside the picker. Any other color is as valid. */
export const SUGGESTED_ACCENTS: readonly { name: string; hex: string }[] = [
  { name: 'Amber', hex: '#ff8a3d' },
  { name: 'Vermilion', hex: '#f2552c' },
  { name: 'Rose', hex: '#e8457a' },
  { name: 'Violet', hex: '#8f6cf0' },
  { name: 'Blue', hex: '#3d8aff' },
  { name: 'Teal', hex: '#1fb5a8' },
  { name: 'Green', hex: '#4fb342' },
  { name: 'Chalk', hex: '#d8d2c4' },
];

/**
 * Every surface each theme puts accent tones on, from `tokens.css` (ground,
 * panel, panel-2, raise), and the two colors text on a fill can be. A theme's
 * surfaces all sit on one side of the middle, so moving a tone away from one
 * moves it away from all of them.
 */
export const SURFACES: Record<ThemeName, { surfaces: readonly string[]; nearBlack: string; white: string }> = {
  dark: { surfaces: ['#0a0a0b', '#111112', '#18181a', '#1f1f21'], nearBlack: '#0a0a0b', white: '#ffffff' },
  light: { surfaces: ['#ffffff', '#f7f6f3', '#efeee9'], nearBlack: '#141413', white: '#ffffff' },
};

export const TARGETS = { ink: 4.5, mark: 3, fill: 3, onFill: 4.5 } as const;

export interface AccentTones {
  /** The color chosen, normalized to lowercase `#rrggbb`. */
  chosen: string;
  ink: string;
  mark: string;
  fill: string;
  onFill: string;
  /** Translucent washes of the chosen color, for hover and selection grounds. */
  wash: string;
  washStrong: string;
  /** Whether any drawn tone differs from the chosen color. */
  adjusted: boolean;
}

type Rgb = [number, number, number];
type Hsl = [number, number, number];

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#abc`, `abc`, `#aabbcc` or `aabbcc` to lowercase `#aabbcc`; anything else to null. */
export function normalizeHex(value: string): string | null {
  const match = HEX.exec(value.trim());
  if (!match || !match[1]) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1];
  return `#${digits.toLowerCase()}`;
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio between two `#rrggbb` colors, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function rgbToHsl([r, g, b]: Rgb): Hsl {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb([h, s, l]: Hsl): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

/** The lowest contrast `hex` has against any of `surfaces`. */
export function leastContrast(hex: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((surface) => contrast(hex, surface)));
}

/**
 * The nearest color to `hex` in lightness, same hue and saturation, that has at
 * least `target` contrast against every one of `surfaces`, which must all be
 * dark or all be light. Lightens against dark surfaces and deepens against
 * light ones. White and black bound the walk, and each clears every target used
 * here against its theme's surfaces, so the result always meets it.
 */
export function towardContrast(hex: string, surfaces: readonly string[], target: number): string {
  const passes = (c: string) => leastContrast(c, surfaces) >= target;
  if (passes(hex)) return hex;
  const [h, s, l0] = rgbToHsl(hexToRgb(hex));
  const lighten = luminance(hexToRgb(surfaces[0] ?? '#000000')) < 0.2;
  // Bisect lightness between the chosen value and the bound, so the answer is
  // the *nearest* passing tone rather than whichever a fixed step lands on.
  let pass = lighten ? 1 : 0;
  let fail = l0;
  for (let i = 0; i < 24; i++) {
    const mid = (pass + fail) / 2;
    if (passes(rgbToHex(hslToRgb([h, s, mid])))) pass = mid;
    else fail = mid;
  }
  // Rounding to whole channels can land a hair under the line; step until it
  // does not.
  let out = rgbToHex(hslToRgb([h, s, pass]));
  let l = pass;
  while (!passes(out) && l > 0 && l < 1) {
    l = lighten ? Math.min(1, l + 0.002) : Math.max(0, l - 0.002);
    out = rgbToHex(hslToRgb([h, s, l]));
  }
  return out;
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function accentTones(chosen: string | null | undefined, theme: ThemeName): AccentTones {
  const hex = (chosen && normalizeHex(chosen)) || DEFAULT_ACCENT;
  const { surfaces, nearBlack, white } = SURFACES[theme];
  const ink = towardContrast(hex, surfaces, TARGETS.ink);
  const mark = towardContrast(hex, surfaces, TARGETS.mark);
  let fill = towardContrast(hex, surfaces, TARGETS.fill);
  let onFill = contrast(fill, nearBlack) >= contrast(fill, white) ? nearBlack : white;
  if (contrast(fill, onFill) < TARGETS.onFill) {
    // Away from the surface: lighter on the night chart, so near-black text;
    // deeper on the page, so white text. Either direction also raises the
    // fill's contrast with the surface, so its own target still holds.
    onFill = theme === 'dark' ? nearBlack : white;
    fill = towardContrast(fill, [onFill], TARGETS.onFill);
  }
  return {
    chosen: hex,
    ink,
    mark,
    fill,
    onFill,
    wash: rgba(hex, theme === 'dark' ? 0.09 : 0.08),
    washStrong: rgba(hex, theme === 'dark' ? 0.3 : 0.22),
    adjusted: ink !== hex || mark !== hex || fill !== hex,
  };
}

/** The tones as the CSS custom properties `tokens.css` reads. */
export function accentProperties(tones: AccentTones): Record<string, string> {
  return {
    '--accent': tones.chosen,
    '--accent-ink': tones.ink,
    '--accent-mark': tones.mark,
    '--accent-fill': tones.fill,
    '--on-accent': tones.onFill,
    '--accent-wash': tones.wash,
    '--accent-wash-2': tones.washStrong,
  };
}
