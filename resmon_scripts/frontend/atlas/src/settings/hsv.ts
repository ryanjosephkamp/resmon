import { hexToRgb, rgbToHex } from '../theme/accent';

/**
 * Hue (0–360), saturation and value (0–1): the picker's own coordinates. Kept
 * apart from the hex it produces, because a grey or a black has no hue of its
 * own, and a picker that re-derived its hue from the hex would lose it the
 * moment the person dragged into a corner.
 */
export interface Hsv { h: number; s: number; v: number }

export function hsvToHex({ h, s, v }: Hsv): string {
  const hh = ((h % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x]
      : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return rgbToHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/** The hex's coordinates; `hue` stands in where the color has none. */
export function hexToHsv(hex: string, hue = 0): Hsv {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = hue;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
