/**
 * Where a chart's tooltip goes: beside the mark it describes, never over it,
 * and inside the window.
 *
 * The tip is tried above the mark first (a reader's eye goes up from a bar or
 * a dot to its numbers), then below, then to the right, then to the left. On
 * the side it takes, it is centered on the pointer where there is one, so it
 * follows the pointer along a long bar, or on the mark where the keyboard put
 * it there, and is then slid along that side until it is inside the window.
 * Sliding along a side never brings it over the mark, because the side keeps
 * the gap between them. Only a tip larger than every side has room for is set
 * in the window's corner nearest the mark, the one case where it can cover it.
 *
 * `top` is room at the window's top the page does not own: macOS's tab bar,
 * drawn over the page while the windows are in tabs (`--tab-strip`). A tip is
 * never set under it.
 */

export interface Box { left: number; top: number; right: number; bottom: number }
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
export type Side = 'above' | 'below' | 'right' | 'left' | 'corner';
export interface Placed { left: number; top: number; side: Side }

/** Between the tip and its mark. */
export const GAP = 10;
/** Between the tip and the window's edge. */
export const EDGE = 8;

function clamp(value: number, low: number, high: number): number {
  return high < low ? low : Math.min(high, Math.max(low, value));
}

/** The tip's place for a mark, in window coordinates. */
export function placeTip(mark: Box, tip: Size, view: Size, pointer?: Point | null, top = 0): Placed {
  const first = top + EDGE;
  const cx = pointer ? clamp(pointer.x, mark.left, mark.right) : (mark.left + mark.right) / 2;
  const cy = pointer ? clamp(pointer.y, mark.top, mark.bottom) : (mark.top + mark.bottom) / 2;
  const across = clamp(cx - tip.width / 2, EDGE, view.width - EDGE - tip.width);
  const down = clamp(cy - tip.height / 2, first, view.height - EDGE - tip.height);
  const fitsAcross = tip.width <= view.width - 2 * EDGE;
  const fitsDown = tip.height <= view.height - first - EDGE;

  const above = mark.top - GAP - tip.height;
  if (fitsAcross && above >= first) return { left: across, top: above, side: 'above' };
  const below = mark.bottom + GAP;
  if (fitsAcross && below + tip.height <= view.height - EDGE) return { left: across, top: below, side: 'below' };
  const right = mark.right + GAP;
  if (fitsDown && right + tip.width <= view.width - EDGE) return { left: right, top: down, side: 'right' };
  const left = mark.left - GAP - tip.width;
  if (fitsDown && left >= EDGE) return { left, top: down, side: 'left' };
  return {
    left: cx < view.width / 2 ? EDGE : Math.max(EDGE, view.width - EDGE - tip.width),
    top: cy < view.height / 2 ? first : Math.max(first, view.height - EDGE - tip.height),
    side: 'corner',
  };
}

/** Whether two boxes share any area: a tip placed beside a mark never does. */
export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
