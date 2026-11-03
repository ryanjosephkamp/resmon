/**
 * The top bar's color dial: one hue, turned, and every tone the site draws
 * from it.
 *
 * The app lets a person choose any color and draws each tone from it with
 * `accentTones` (`atlas/src/theme/accent.ts`), which keeps the hue and moves
 * only lightness until the tone reaches the contrast its job needs against
 * every surface of the theme. The dial chooses the color by hue alone: amber's
 * lightness and strength in OKLCH, at the hue the reader turns to, its strength
 * lowered only where that hue cannot carry it inside sRGB. The tones then come
 * from the app's own function, so every position is drawn as the app would
 * draw that color, and `scripts/check-tokens.mjs` measures all 360 of them.
 */
import { DEFAULT_ACCENT, accentTones, type ThemeName } from '../../../resmon_scripts/frontend/atlas/src/theme/accent';

type Rgb = [number, number, number];

const D2R = Math.PI / 180;

const toLinear = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const encode = (v: number) => {
  const x = Math.min(1, Math.max(0, v));
  return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
};

function rgbOf(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hexOfRgb = (rgb: Rgb) =>
  `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/** A color's OKLCH lightness, chroma, and hue in degrees (Björn Ottosson's OKLab). */
export function oklchOf(hex: string): { l: number; c: number; h: number } {
  const [r, g, b] = rgbOf(hex).map(toLinear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) / D2R) + 360) % 360 };
}

/** OKLCH to linear sRGB, unclipped. */
function linearOf(l: number, c: number, hue: number): Rgb {
  const a = c * Math.cos(hue * D2R);
  const b = c * Math.sin(hue * D2R);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

/** The most chroma a hue can carry at a lightness and stay inside sRGB. */
function maxChroma(l: number, hue: number): number {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(linearOf(l, mid, hue))) lo = mid;
    else hi = mid;
  }
  return lo;
}

const AMBER = oklchOf(DEFAULT_ACCENT);

/** Where the dial rests: amber's own hue, in whole degrees. */
export const DEFAULT_HUE = Math.round(AMBER.h);

/** The color at a position of the dial; at rest, the app's default itself. */
export function colorAt(hue: number): string {
  if (hue === DEFAULT_HUE) return DEFAULT_ACCENT;
  const c = Math.min(AMBER.c, maxChroma(AMBER.l, hue));
  return hexOfRgb(linearOf(AMBER.l, c, hue).map(encode) as Rgb);
}

/**
 * A name for a position, for the dial's label and its spoken value: the app's
 * own names for the colors it suggests where they sit (rose, vermilion, amber,
 * green, teal, blue, violet), and plain names between them.
 */
const NAMES: readonly [number, string][] = [
  [5, 'rose'], [35, 'vermilion'], [DEFAULT_HUE, 'amber'], [85, 'gold'], [118, 'lime'], [141, 'green'],
  [185, 'teal'], [215, 'cyan'], [259, 'blue'], [292, 'violet'], [328, 'magenta'],
];

export function hueName(hue: number): string {
  const away = (at: number) => Math.min(Math.abs(at - hue), 360 - Math.abs(at - hue));
  return NAMES.reduce((best, entry) => (away(entry[0]) < away(best[0]) ? entry : best))[1];
}

/** `a` moved toward `b` by `t`, channel by channel in sRGB. */
function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgbOf(a), rgbOf(b)];
  return hexOfRgb(x.map((v, i) => v + ((y[i] ?? 0) - v) * t) as Rgb);
}

/** The page each theme's washes are laid on, and how much of the mark shows through. */
const WASH: Record<ThemeName, { paper: string; share: number }> = {
  light: { paper: '#ffffff', share: 0.09 },
  dark: { paper: '#0a0a0b', share: 0.125 },
};

/** Every property the dial sets, in a fixed order. */
export const DIAL_PROPERTIES = (['light', 'dark'] as const).flatMap((theme) =>
  ['ink', 'mark', 'fill', 'on', 'wash', 'hover'].map((tone) => `--dial-${theme}-${tone}`),
);

/**
 * The `--dial-*` properties `tokens.css` reads, for one position, in both
 * themes. A hover on the night chart is the fill a fifth of the way to white;
 * on paper, it is the ink.
 */
export function dialProperties(hue: number): Record<string, string> {
  const chosen = colorAt(hue);
  const out: Record<string, string> = {};
  for (const theme of ['light', 'dark'] as const) {
    const tones = accentTones(chosen, theme);
    const wash = WASH[theme];
    out[`--dial-${theme}-ink`] = tones.ink;
    out[`--dial-${theme}-mark`] = tones.mark;
    out[`--dial-${theme}-fill`] = tones.fill;
    out[`--dial-${theme}-on`] = tones.onFill;
    out[`--dial-${theme}-wash`] = mix(wash.paper, tones.mark, wash.share);
    out[`--dial-${theme}-hover`] = theme === 'light' ? tones.ink : mix(tones.fill, '#ffffff', 0.21);
  }
  return out;
}

/** The dial's track: the color at every thirtieth degree. */
export const TRACK = `linear-gradient(90deg, ${Array.from({ length: 13 }, (_, i) => colorAt((i * 30) % 360)).join(', ')})`;
