/**
 * The reader's arithmetic, apart from PDF.js and the DOM: how large a page is
 * drawn at each zoom, where every page sits in the stacked scroll, which page
 * is on screen, which pages are drawn and which are let go, where a link in a
 * page leads, and where a selection on the drawn page is in the page's text.
 */

/** PDF.js measures a page in points; a CSS pixel is 1/96 inch and a point 1/72, so 100% is this scale. */
export const CSS_UNITS = 96 / 72;

/** The zoom a person chooses: the window's width, the whole page, or a fixed percentage. */
export type Zoom = 'width' | 'page' | number;
export const ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300] as const;

/** Space around and between the stacked pages, in CSS pixels. */
export const PAGE_GAP = 12;
export const PAGE_PAD = 16;

export interface Size { width: number; height: number }

/** The CSS scale a page of `page` points is drawn at, inside a frame of `frame` pixels. */
export function zoomScale(zoom: Zoom, frame: Size, page: Size): number {
  if (typeof zoom === 'number') return (zoom / 100) * CSS_UNITS;
  const room = { width: Math.max(80, frame.width - 2 * PAGE_PAD), height: Math.max(80, frame.height - 2 * PAGE_PAD) };
  const width = room.width / page.width;
  const scale = zoom === 'width' ? width : Math.min(width, room.height / page.height);
  return Math.min(Math.max(scale, 0.1), 10);
}

/** A scale as the percentage the zoom control names it by. */
export function zoomPercent(scale: number): number {
  return Math.round((scale / CSS_UNITS) * 100);
}

/** The next fixed step from the scale on screen, up or down; the same scale when there is none. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  const now = zoomPercent(scale);
  const steps = direction > 0 ? ZOOM_STEPS.filter((s) => s > now) : ZOOM_STEPS.filter((s) => s < now).reverse();
  return steps[0] ?? (direction > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1]! : ZOOM_STEPS[0]!);
}

/** Every page's top edge in the stacked scroll, its drawn height, and the whole column's size. */
export interface Layout { tops: number[]; heights: number[]; widths: number[]; height: number; width: number }

export function layout(sizes: readonly Size[], scale: number): Layout {
  const tops: number[] = [];
  const heights: number[] = [];
  const widths: number[] = [];
  let at = PAGE_PAD;
  let widest = 0;
  for (const size of sizes) {
    const h = Math.floor(size.height * scale);
    const w = Math.floor(size.width * scale);
    tops.push(at);
    heights.push(h);
    widths.push(w);
    widest = Math.max(widest, w);
    at += h + PAGE_GAP;
  }
  return { tops, heights, widths, height: at - (sizes.length ? PAGE_GAP : 0) + PAGE_PAD, width: widest + 2 * PAGE_PAD };
}

/** The index of the last page whose top is at or above `y`: the page `y` falls in, or the gap after it. */
export function indexAt(tops: readonly number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid]! <= y) lo = mid; else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** The pages any part of which is between `top` and `bottom`, as 0-based indexes, first and last. */
export function pagesBetween(view: Layout, top: number, bottom: number): [number, number] {
  if (!view.tops.length) return [0, -1];
  let first = indexAt(view.tops, top);
  if (view.tops[first]! + view.heights[first]! < top && first < view.tops.length - 1) first += 1;
  const last = indexAt(view.tops, bottom);
  return [first, Math.max(first, last)];
}

/**
 * The page on screen: the one with the most of itself in view, the first of
 * equals. 1-based. Scrolled to the very end, the last page counts as on
 * screen even when a taller one above it shows more, or the last pages of a
 * document could never be the page on screen. A view that has not scrolled
 * at all is not at the end, however much of the document it shows.
 */
export function currentPage(view: Layout, top: number, height: number): number {
  const count = view.tops.length;
  if (!count) return 1;
  const bottom = top + height;
  const [first, last] = pagesBetween(view, top, bottom);
  let best = first;
  let shown = -1;
  for (let i = first; i <= last; i += 1) {
    const visible = Math.min(bottom, view.tops[i]! + view.heights[i]!) - Math.max(top, view.tops[i]!);
    if (visible > shown + 0.5) { best = i; shown = visible; }
  }
  if (top > 0 && bottom >= view.height - 1 && last === count - 1 && view.tops[last]! >= top) best = last;
  return best + 1;
}

/**
 * Which pages stay drawn: the ones within one screen of the view are drawn,
 * and a page already drawn is let go only once it is three screens away, so
 * scrolling back and forth over a boundary does not draw the same page again
 * and again. At most `cap` pages, nearest first, whatever the zoom.
 */
export function keptPages(view: Layout, top: number, height: number, kept: readonly [number, number] | null, cap = 24): [number, number] {
  const count = view.tops.length;
  if (!count) return [0, -1];
  const near = pagesBetween(view, top - height, top + 2 * height);
  const far = pagesBetween(view, top - 3 * height, top + 4 * height);
  let [from, to] = near;
  if (kept && kept[0] >= far[0] && kept[0] <= near[0]) from = kept[0];
  if (kept && kept[1] <= far[1] && kept[1] >= near[1]) to = kept[1];
  if (to - from + 1 > cap) {
    const middle = currentPage(view, top, height) - 1;
    from = Math.max(0, Math.min(middle - Math.floor(cap / 3), count - cap));
    to = Math.min(count - 1, from + cap - 1);
  }
  return [from, to];
}

/** The scroll position that keeps the same part of the same page at the top of the view after the layout changes. */
export interface Anchor { index: number; fraction: number }

export function anchorAt(view: Layout, top: number): Anchor {
  if (!view.tops.length) return { index: 0, fraction: 0 };
  const index = indexAt(view.tops, top);
  const height = view.heights[index] || 1;
  return { index, fraction: Math.min(1, Math.max(0, (top - view.tops[index]!) / height)) };
}

export function topOf(view: Layout, anchor: Anchor): number {
  const index = Math.min(anchor.index, view.tops.length - 1);
  if (index < 0) return 0;
  return view.tops[index]! + anchor.fraction * view.heights[index]!;
}

// — links -----------------------------------------------------------------------------

/** Where a link drawn on a page leads, as far as the reader follows it. */
export type LinkTarget =
  | { kind: 'web'; href: string }
  | { kind: 'dest'; dest: string | unknown[] }
  | { kind: 'page'; action: 'FirstPage' | 'LastPage' | 'NextPage' | 'PrevPage' };

/** A link annotation as PDF.js reports it; nothing else of an annotation is read. */
export interface LinkData {
  annotationType: number; rect: number[];
  url?: unknown; dest?: unknown; action?: unknown; attachment?: unknown;
}

const PAGE_ACTIONS = new Set(['FirstPage', 'LastPage', 'NextPage', 'PrevPage']);

/** A web address the app may open: http or https only, as the window's link handling allows. */
export function webHref(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * What a link annotation does here, or null when it does nothing. A web
 * address opens through the app's link handling; a destination in the same
 * document, or one of the four page-turning actions, goes to its page. An
 * attachment, a script, a form action, a link to another file and any other
 * address scheme are not followed.
 */
export function linkTarget(data: LinkData, linkType: number): LinkTarget | null {
  if (data.annotationType !== linkType || !Array.isArray(data.rect) || data.rect.length !== 4) return null;
  if (data.url !== undefined) {
    const href = webHref(data.url);
    return href ? { kind: 'web', href } : null;
  }
  if (data.attachment !== undefined) return null;
  if (data.action !== undefined) {
    return typeof data.action === 'string' && PAGE_ACTIONS.has(data.action)
      ? { kind: 'page', action: data.action as 'FirstPage' | 'LastPage' | 'NextPage' | 'PrevPage' }
      : null;
  }
  if ((typeof data.dest === 'string' && data.dest) || (Array.isArray(data.dest) && data.dest.length)) {
    return { kind: 'dest', dest: data.dest as string | unknown[] };
  }
  return null;
}

/** An explicit destination's page (a reference, or a 0-based index) and the height on it to show, in PDF units. */
export function explicitDest(dest: readonly unknown[]): { ref: { num: number; gen: number } | null; index: number | null; top: number | null } | null {
  const [target, mode, ...args] = dest;
  let ref: { num: number; gen: number } | null = null;
  let index: number | null = null;
  if (target && typeof target === 'object' && Number.isInteger((target as { num?: unknown }).num) && Number.isInteger((target as { gen?: unknown }).gen)) {
    ref = { num: (target as { num: number }).num, gen: (target as { gen: number }).gen };
  } else if (Number.isInteger(target) && (target as number) >= 0) {
    index = target as number;
  } else {
    return null;
  }
  const name = mode && typeof mode === 'object' ? (mode as { name?: unknown }).name : null;
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  let top: number | null = null;
  if (name === 'XYZ') top = number(args[1]);
  else if (name === 'FitH' || name === 'FitBH') top = number(args[0]);
  else if (name === 'FitR') top = number(args[3]);
  return { ref, index, top };
}

/** A link's place on its page, as percentages of the page, from its rectangle in viewport pixels. */
export function linkBox(corners: [number, number, number, number], page: Size): { left: number; top: number; width: number; height: number } {
  const [x1, y1, x2, y2] = corners;
  const left = Math.max(0, Math.min(x1, x2));
  const top = Math.max(0, Math.min(y1, y2));
  const right = Math.min(page.width, Math.max(x1, x2));
  const bottom = Math.min(page.height, Math.max(y1, y2));
  return {
    left: (left / page.width) * 100, top: (top / page.height) * 100,
    width: (Math.max(0, right - left) / page.width) * 100, height: (Math.max(0, bottom - top) / page.height) * 100,
  };
}

// — a selection on the drawn page, in the page's text ----------------------------------

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where text selected on the drawn page is in the page's canonical text, as
 * UTF-16 offsets, and how many times it is there. The drawing's text layer and
 * the engine's extraction break lines and space words differently, so any run
 * of whitespace in the selection matches any run of whitespace in the text,
 * and a word broken after its hyphen matches with or without the break.
 * Nothing else is loosened: every other character must be the same, hyphen
 * included.
 */
export function findSelection(text: string, selected: string): { start: number; end: number; count: number } | null {
  const words = selected.trim().split(/\s+/).filter(Boolean);
  if (!words.length || selected.trim().length > 20_000) return null;
  const pattern = words.map((word, i) => {
    const body = escape(word);
    if (i === words.length - 1) return body;
    return word.endsWith('-') ? `${body}\\s*` : `${body}\\s+`;
  }).join('');
  const search = new RegExp(pattern, 'gu');
  let first: { start: number; end: number } | null = null;
  let count = 0;
  for (const match of text.matchAll(search)) {
    if (!match[0]) continue;
    count += 1;
    first ??= { start: match.index, end: match.index + match[0].length };
  }
  return first ? { ...first, count } : null;
}
