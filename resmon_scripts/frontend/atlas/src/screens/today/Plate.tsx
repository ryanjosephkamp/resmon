import {
  forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState,
  type KeyboardEvent, type PointerEvent, type ReactNode,
} from 'react';
import { Icon } from '../../shell/Icon';
import {
  GRID, GRID_LETTERS, RAMP_DAYS, gridCell, placeName, type Box, type Field, type MapRegion, type Sky, type WatchShape,
} from './model';

/** Which papers are lit, and the color each lit one wears; see `sky/look.ts`. */
export interface PlateLook {
  /** 1 where lit; null when every paper is. */
  lit: Uint8Array | null;
  /** An index into `colors` per paper; null when every lit paper wears the ink. */
  group: Uint8Array | null;
  /** CSS colors, `var(--token)` or literal, read once per theme. */
  colors: readonly string[];
  /** The find's matches, ringed; at most `FOUND_RINGS` of them. */
  found: Int32Array;
}

/** Where the plate is looking: a plate-space center and pixels per plate unit. */
interface View { cx: number; cy: number; scale: number }

export interface PlateHandle {
  /** Fly to a plate-space box, or home when none is given. */
  flyTo: (box?: { x: number; y: number; r: number }) => void;
  /** Give the plate the keyboard, as a way back from beside it lands. */
  focus: () => void;
}

/** The paper under the pointer, where it is on the plate, and the plate's size, so a tip can stay inside it. */
export interface PlateHover { index: number; screenX: number; screenY: number; width?: number; height?: number }

interface Props {
  sky: Sky;
  regions: readonly MapRegion[];
  shapes: readonly WatchShape[];
  field: Field;
  /** Sky indices of the new papers, in the order they were collected: ring 1 first. */
  arrivals: readonly number[];
  /** How many arrivals are lit; the rest wait for the opening to reach them. */
  lit: number;
  selected: number | null;
  /** A paper hovered in the index, ringed here too. */
  pointed: number | null;
  /** A paper chosen, or the choice cleared: by a click, or from the keyboard (Enter, Shift and an arrow, Escape). */
  onSelect: (index: number | null, via: 'pointer' | 'keyboard') => void;
  /** Enter on the paper already chosen: where a page opens papers elsewhere, it opens it. */
  onOpen?: (index: number) => void;
  onHover: (hover: PlateHover | null) => void;
  /** Read when the theme or accent changes, so the canvas redraws in it. */
  paletteKey: string;
  label: string;
  children?: ReactNode;
  onAway: (away: boolean) => void;
  /** The zoom buttons' corner: bottom left, unless the title block is there. */
  toolsAt?: 'left' | 'right';
  /** Filters, colors, and the find's matches. Without one, every paper is lit in the ink. */
  look?: PlateLook | null;
  /** What the whole plate is, for the button and the keys that return to it: "the whole collection". */
  whole?: string;
  /**
   * What the wheel does over the plate. `zoom` where the plate is the page
   * (Today, a run's map tab); `page` where it sits in a page that scrolls,
   * where the wheel scrolls the page, a pinch zooms, and a sideways swipe pans.
   */
  wheel?: 'zoom' | 'page';
}

const MARGIN = 26;
/**
 * The most a watch's name may cover, as a share of the papers a box its size
 * holds on average where the papers are: beside an outline, at the edge of the
 * crowd, a name covers a few; across the middle of it, many.
 */
const NAME_COVER = 0.35;
const RAMP_RADIUS = [2.3, 1.8, 1.4, 1.1, 0.85];
const RAMP_ALPHA = [1, 0.86, 0.66, 0.46, 0.32];
/** A paper the filters leave out: still drawn, so the collection keeps its shape, but faint. */
const DIM_ALPHA = 0.2;
/** A lit paper wearing a color is drawn at least this opaque, so its color can be read at any age. */
const COLOR_ALPHA = 0.8;
/** The most round dots drawn as one path; see the draw loop. */
const PATH_DOTS = 512;
/** Past this many, the find's matches are lit but not each ringed: rings that many overlap into a texture. */
const FOUND_RINGS = 400;

interface Palette {
  plate: string; ink: string; ink2: string; ink3: string; grid: string; frame: string;
  band: string; bound: string; mark: string; accentInk: string; fill: string; onFill: string;
}

function readPalette(element: HTMLElement): Palette {
  const css = getComputedStyle(element);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    plate: v('--plate'), ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), grid: v('--grid'),
    frame: v('--frame'), band: v('--band'), bound: v('--bound'), mark: v('--accent-mark'),
    accentInk: v('--accent-ink'), fill: v('--accent-fill'), onFill: v('--on-accent'),
  };
}

/** A color as the canvas takes it: a `var(--token)` read from the element, anything else as written. */
function resolveColor(element: HTMLElement, color: string): string {
  const token = /^var\((--[\w-]+)\)$/.exec(color);
  return token?.[1] ? getComputedStyle(element).getPropertyValue(token[1]).trim() : color;
}

/** One run of the draw order that shares a size, a color, and an opacity. */
interface Span { start: number; end: number; cls: number; group: number; dim: boolean }

/**
 * The order papers are drawn in, as runs that share a style: the dimmed first
 * (beneath), then the lit, oldest class first so the newest sit on top, by
 * color within a class. A counting sort, once per look, so a frame is one pass
 * over the papers however many colors there are.
 */
export function paintOrder(sky: Sky, lit: Uint8Array | null, group: Uint8Array | null, groups: number) {
  const classes = RAMP_RADIUS.length;
  const g = Math.max(1, groups);
  const keys = classes + classes * g;
  const keyOf = (i: number) => {
    const age = classes - 1 - (sky.ramp[i] ?? 0);
    if (lit && !lit[i]) return age;
    return classes + age * g + Math.min(g - 1, group ? group[i] ?? 0 : 0);
  };
  const counts = new Uint32Array(keys + 1);
  for (let i = 0; i < sky.count; i++) counts[keyOf(i) + 1]! += 1;
  for (let k = 0; k < keys; k++) counts[k + 1]! += counts[k]!;
  const starts = counts.slice(0, keys);
  const order = new Uint32Array(sky.count);
  const next = counts.slice(0, keys);
  for (let i = 0; i < sky.count; i++) order[next[keyOf(i)]!++] = i;
  const spans: Span[] = [];
  for (let k = 0; k < keys; k++) {
    const start = starts[k]!, end = k + 1 < keys ? starts[k + 1]! : sky.count;
    if (end <= start) continue;
    const dim = k < classes;
    const cls = dim ? classes - 1 - k : classes - 1 - Math.floor((k - classes) / g);
    spans.push({ start, end, cls, group: dim ? -1 : (k - classes) % g, dim });
  }
  return { order, spans };
}

// One per sky, however many plates draw it.
const hashes = new WeakMap<Sky, ReturnType<typeof makeHash>>();

/** A spatial hash over plate space, for finding the paper under the pointer. */
function buildHash(sky: Sky) {
  let hash = hashes.get(sky);
  if (!hash) {
    hash = makeHash(sky);
    hashes.set(sky, hash);
  }
  return hash;
}

function makeHash(sky: Sky, cells = 192) {
  const { minX, minY, size } = sky.bounds;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < sky.count; i++) {
    const c = Math.floor((((sky.x[i] ?? 0) - minX) / size) * cells);
    const r = Math.floor((((sky.y[i] ?? 0) - minY) / size) * cells);
    const key = r * cells + c;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i); else buckets.set(key, [i]);
  }
  return { cells, buckets };
}

/** The density field as a tiny image: ink where papers crowd, transparent elsewhere. */
function shadingImage(field: Field, ink: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = field.n;
  canvas.height = field.n;
  const ctx = canvas.getContext('2d');
  if (!ctx || field.max <= 0) return canvas;
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data);
  const image = ctx.createImageData(field.n, field.n);
  for (let i = 0; i < field.values.length; i++) {
    const t = Math.min(1, (field.values[i] ?? 0) / field.max);
    image.data[i * 4] = r ?? 0;
    image.data[i * 4 + 1] = g ?? 0;
    image.data[i * 4 + 2] = b ?? 0;
    image.data[i * 4 + 3] = Math.round(255 * 0.085 * Math.pow(t, 0.55));
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export const Plate = forwardRef<PlateHandle, Props>(function Plate(props, ref) {
  const {
    sky, regions, shapes, field, arrivals, lit, selected, pointed, onSelect, onHover, paletteKey,
    label, children, onAway, toolsAt = 'left', look = null, whole = 'the whole collection', onOpen, wheel: wheelMode = 'zoom',
  } = props;
  const keysId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const view = useRef<View>({ cx: 0, cy: 0, scale: 1 });
  const home = useRef<View>({ cx: 0, cy: 0, scale: 1 });
  const frame = useRef(0);
  // The draw loop schedules itself through this, so a frame always runs the
  // newest drawing function rather than the one it was first given.
  const drawRef = useRef<() => void>(() => undefined);
  const glide = useRef<{ from: View; to: View; start: number } | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean; view: View } | null>(null);
  const hoverIndex = useRef<number | null>(null);
  const palette = useRef<Palette | null>(null);
  const shading = useRef<HTMLCanvasElement | null>(null);
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const hash = useMemo(() => buildHash(sky), [sky]);
  const paint = useMemo(
    () => paintOrder(sky, look?.lit ?? null, look?.group ?? null, look?.colors.length ?? 0),
    [sky, look],
  );
  const groupColors = useRef<string[]>([]);
  // The plate area the papers actually occupy (their regions' discs), for
  // working out how much screen each paper has at a given zoom.
  const occupied = useMemo(() => Math.max(0.05, regions.reduce((sum, r) => sum + Math.PI * r.r * r.r, 0)), [regions]);
  const arrivalRank = useMemo(() => {
    const rank = new Map<number, number>();
    arrivals.forEach((index, k) => rank.set(index, k));
    return rank;
  }, [arrivals]);

  // The latest props for the draw loop, which runs outside React's renders.
  const latest = useRef(props);
  useEffect(() => { latest.current = props; });

  useEffect(() => {
    const node = wrap.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const toScreen = useCallback((px: number, py: number, v: View = view.current): [number, number] => [
    (px - v.cx) * v.scale + size.w / 2,
    size.h / 2 - (py - v.cy) * v.scale,
  ], [size]);
  const toPlate = useCallback((sx: number, sy: number, v: View = view.current): [number, number] => [
    (sx - size.w / 2) / v.scale + v.cx,
    (size.h / 2 - sy) / v.scale + v.cy,
  ], [size]);

  /** How many papers lie under a screen box, read from the spatial hash. */
  const papersUnder = useCallback((box: Box, v: View): number => {
    const [ax, ay] = toPlate(box.x, box.y + box.h, v);
    const [bx, by] = toPlate(box.x + box.w, box.y, v);
    const { minX, minY, size } = sky.bounds;
    const cell = (value: number, min: number) => Math.min(hash.cells - 1, Math.max(0, Math.floor(((value - min) / size) * hash.cells)));
    let count = 0;
    for (let r = cell(ay, minY); r <= cell(by, minY); r++) {
      for (let c = cell(ax, minX); c <= cell(bx, minX); c++) {
        for (const i of hash.buckets.get(r * hash.cells + c) ?? []) {
          const px = sky.x[i] ?? 0, py = sky.y[i] ?? 0;
          if (px >= ax && px <= bx && py >= ay && py <= by) count++;
        }
      }
    }
    return count;
  }, [sky, hash, toPlate]);

  const draw = useCallback(() => {
    frame.current = 0;
    const node = canvas.current;
    const p = palette.current;
    if (!node || !p || size.w === 0) return;
    const ctx = node.getContext('2d');
    if (!ctx) return;
    const now = performance.now();
    const started = now;
    if (glide.current) {
      const { from, to, start } = glide.current;
      const t = Math.min(1, (now - start) / 520);
      const e = 1 - Math.pow(1 - t, 4);
      const lerp = (a: number, b: number) => a + (b - a) * e;
      view.current = {
        cx: lerp(from.cx, to.cx), cy: lerp(from.cy, to.cy),
        scale: Math.exp(lerp(Math.log(from.scale), Math.log(to.scale))),
      };
      if (t >= 1) glide.current = null;
    }
    const v = view.current;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = p.plate;
    ctx.fillRect(0, 0, size.w, size.h);

    const { sky: s, regions: rs, shapes: ws, arrivals: arr, lit: litCount, selected: sel, pointed: pt } = latest.current;
    const inner = { x: MARGIN, y: MARGIN, w: size.w - MARGIN * 2, h: size.h - MARGIN * 2 };
    const zoom = v.scale / home.current.scale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(inner.x, inner.y, inner.w, inner.h);
    ctx.clip();

    // The grid, fixed to the plate so it moves with the sky.
    const b = s.bounds;
    ctx.strokeStyle = p.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k <= GRID; k++) {
      const [gx] = toScreen(b.minX + (b.size * k) / GRID, 0, v);
      const [, gy] = toScreen(0, b.minY + (b.size * k) / GRID, v);
      ctx.moveTo(Math.round(gx) + 0.5, inner.y); ctx.lineTo(Math.round(gx) + 0.5, inner.y + inner.h);
      ctx.moveTo(inner.x, Math.round(gy) + 0.5); ctx.lineTo(inner.x + inner.w, Math.round(gy) + 0.5);
    }
    ctx.stroke();

    // Where papers crowd, the paper darkens (or the night lightens).
    if (shading.current) {
      const [x0, y0] = toScreen(b.minX, b.minY + b.size, v);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(shading.current, x0, y0, b.size * v.scale, b.size * v.scale);
    }

    // Watches: dashed outlines and faint constellation lines.
    ctx.setLineDash([3, 3.5]);
    ctx.strokeStyle = p.bound;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const w of ws) {
      for (const [x1, y1, x2, y2] of w.outline) {
        const [a, c] = toScreen(x1, y1, v);
        const [d, e] = toScreen(x2, y2, v);
        ctx.moveTo(a, c); ctx.lineTo(d, e);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = p.band;
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    for (const w of ws) {
      for (const [i, j] of w.lines) {
        const si = w.stars[i], sj = w.stars[j];
        if (!si || !sj) continue;
        const [a, c] = toScreen(si[0], si[1], v);
        const [d, e] = toScreen(sj[0], sj[1], v);
        ctx.moveTo(a, c); ctx.lineTo(d, e);
      }
    }
    ctx.stroke();

    // Every paper, oldest class first so the newest sit on top. A star is no
    // bigger, and no brighter, than the screen each paper has at this zoom
    // allows: 100,000 papers drawn at full size were one white mass.
    const boost = Math.min(2.2, Math.max(1, Math.pow(zoom, 0.32)));
    const spacing = Math.sqrt((occupied * v.scale * v.scale) / Math.max(1, s.count));
    const cap = Math.max(0.55, spacing * 0.42);
    const crowding = Math.min(1, 0.35 + spacing / 6);
    const pad = 4;
    // One pass in the look's order: dimmed papers first, faint and in the
    // third ink, then the lit ones by class and color (see `paintOrder`).
    const { order, spans } = paint;
    const colors = groupColors.current;
    for (const span of spans) {
      const base = (RAMP_RADIUS[span.cls] ?? 1) * boost;
      const r = span.dim ? Math.min(base * 0.8, cap) : Math.min(base, cap);
      const color = span.dim ? undefined : colors[span.group];
      const alpha = RAMP_ALPHA[span.cls] ?? 0.5;
      ctx.globalAlpha = (span.dim ? DIM_ALPHA : color ? Math.max(COLOR_ALPHA, alpha) : alpha) * crowding;
      ctx.fillStyle = span.dim ? p.ink3 : (color || p.ink);
      const round = r >= 1.15;
      // Round dots go into paths of at most PATH_DOTS circles each: one path of
      // tens of thousands of circles took Chromium seconds to build on a new
      // canvas, where a few hundred short paths take milliseconds.
      let inPath = 0;
      if (round) ctx.beginPath();
      for (let k = span.start; k < span.end; k++) {
        const i = order[k] ?? 0;
        const sx = ((s.x[i] ?? 0) - v.cx) * v.scale + size.w / 2;
        const sy = size.h / 2 - ((s.y[i] ?? 0) - v.cy) * v.scale;
        if (sx < inner.x - pad || sx > inner.x + inner.w + pad || sy < inner.y - pad || sy > inner.y + inner.h + pad) continue;
        if (round) {
          ctx.moveTo(sx + r, sy);
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          if (++inPath === PATH_DOTS) { ctx.fill(); ctx.beginPath(); inPath = 0; }
        } else ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      }
      if (round && inPath > 0) ctx.fill();
    }
    ctx.globalAlpha = 1;

    // The find's matches, ringed in the accent while there are few enough to
    // read as rings; past that, being lit is what marks them.
    const matches = latest.current.look?.found;
    if (matches && matches.length > 0 && matches.length <= FOUND_RINGS) {
      ctx.strokeStyle = p.mark;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (const i of matches) {
        const [sx, sy] = toScreen(s.x[i] ?? 0, s.y[i] ?? 0, v);
        if (sx < inner.x - 8 || sx > inner.x + inner.w + 8 || sy < inner.y - 8 || sy > inner.y + inner.h + 8) continue;
        ctx.moveTo(sx + 4.5, sy);
        ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    // Region names, largest first, only where the region is big enough on
    // screen to own one, and never over another name.
    const placed: [number, number, number, number][] = [];
    // The title block and the zoom buttons sit over the plate; no name is drawn under either.
    const over = ['.cartouche:not(.away)', '.plate-tools'].map((selector) => wrap.current?.querySelector<HTMLElement>(selector));
    for (const block of over) {
      if (!block || !canvas.current) continue;
      const a = block.getBoundingClientRect();
      const c = canvas.current.getBoundingClientRect();
      placed.push([a.left - c.left - 6, a.top - c.top - 6, a.width + 12, a.height + 12]);
    }
    const free = (x: number, y: number, w: number, h: number) =>
      !placed.some(([px, py, pw, ph]) => x < px + pw && px < x + w && y < py + ph && py < y + h);
    // A name sits over the densest part of the plate, so it is drawn in the
    // second ink rather than the third, a size up, on a wider halo of the
    // plate's own ground: in the third ink the dots showed through and dense
    // regions' names were hard to read in either theme.
    ctx.font = '560 11px "Geist Variable", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const byShown = [...rs].sort((a, c) => c.size - a.size);
    for (const region of byShown) {
      const screenR = region.r * v.scale;
      if (screenR < 30 || !region.label) continue;
      const [rx, ry] = toScreen(region.x, region.y, v);
      const ly = ry - screenR * 0.82;
      const width = ctx.measureText(region.label).width + 8;
      if (!free(rx - width / 2, ly - 8, width, 16)) continue;
      placed.push([rx - width / 2, ly - 8, width, 16]);
      ctx.lineWidth = 4.5;
      ctx.strokeStyle = p.plate;
      ctx.strokeText(region.label, rx, ly);
      ctx.fillStyle = p.ink2;
      ctx.fillText(region.label, rx, ly);
    }

    // Watch names, in the atlas's italic, as labels of their outlines: small,
    // set just outside the dashed line where it has the fewest papers beside
    // it, and dropped where every such place would sit across the dots (or off
    // the plate, or over another name). Set large over the plate, a long name
    // blanked a band of papers as wide as itself.
    ctx.font = 'italic 400 14.5px Spectral, Georgia, serif';
    // Papers per square pixel where the papers are, on average, at this zoom.
    const crowd = 1 / Math.max(1, spacing * spacing);
    const inside = (box: Box) => box.x >= inner.x + 4 && box.y >= inner.y + 4
      && box.x + box.w <= inner.x + inner.w - 4 && box.y + box.h <= inner.y + inner.h - 4;
    // The new papers' rings are drawn over the names, so no name is set under one.
    const rings: [number, number][] = [];
    for (let k = 0; k < Math.min(litCount, arr.length); k++) {
      const i = arr[k];
      if (i !== undefined) rings.push(toScreen(s.x[i] ?? 0, s.y[i] ?? 0, v));
    }
    const clearOfRings = (box: Box) => !rings.some(([rx, ry]) =>
      rx + 8 > box.x && rx - 8 < box.x + box.w && ry + 8 > box.y && ry - 8 < box.y + box.h);
    for (const w of ws) {
      if (!w.spots.length) continue;
      const width = ctx.measureText(w.name).width + 6;
      const height = 17;
      // Its own line, as points, so a name is never set across it.
      const line = w.outline.map(([x1, y1, x2, y2]) => toScreen((x1 + x2) / 2, (y1 + y2) / 2, v));
      const offLine = (box: Box) => !line.some(([lx, ly]) => lx > box.x && lx < box.x + box.w && ly > box.y && ly < box.y + box.h);
      const spots = w.spots.map((spot) => {
        const [sx, sy] = toScreen(spot.x, spot.y, v);
        return { x: sx, y: sy, nx: spot.nx, ny: -spot.ny };
      });
      const box = placeName(
        spots, width, height,
        (b) => inside(b) && free(b.x, b.y, b.w, b.h) && clearOfRings(b) && offLine(b),
        (b) => papersUnder(b, v),
        Math.max(2, NAME_COVER * crowd * width * height),
      );
      if (!box) continue;
      placed.push([box.x, box.y, box.w, box.h]);
      const [cx, cy] = [box.x + box.w / 2, box.y + box.h / 2 + 0.5];
      ctx.lineWidth = 3;
      ctx.strokeStyle = p.plate;
      ctx.strokeText(w.name, cx, cy);
      ctx.fillStyle = p.ink;
      ctx.fillText(w.name, cx, cy);
    }

    ctx.lineJoin = 'miter';

    // The new papers: ringed and numbered, as far as the opening has lit
    // them. Rings shrink with the sky's crowding too, down to a size still
    // read as a ring.
    const ring = Math.min(5.5, Math.max(3, spacing * 1.4));
    ctx.font = '620 10.5px "Geist Variable", sans-serif';
    ctx.textAlign = 'left';
    for (let k = 0; k < Math.min(litCount, arr.length); k++) {
      const i = arr[k];
      if (i === undefined) continue;
      const [sx, sy] = toScreen(s.x[i] ?? 0, s.y[i] ?? 0, v);
      if (sx < inner.x - 10 || sx > inner.x + inner.w + 10 || sy < inner.y - 10 || sy > inner.y + inner.h + 10) continue;
      const chosen = i === sel;
      // A new paper the filters or the find leave out keeps its ring and number, faint.
      ctx.globalAlpha = chosen || !latest.current.look?.lit || latest.current.look.lit[i] ? 1 : 0.28;
      ctx.beginPath();
      ctx.arc(sx, sy, chosen ? 7 : ring, 0, Math.PI * 2);
      if (chosen) { ctx.fillStyle = p.fill; ctx.fill(); }
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = p.mark;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, Math.min(1.6, ring * 0.3), 0, Math.PI * 2);
      ctx.fillStyle = chosen ? p.onFill : p.ink;
      ctx.fill();
      const text = String(k + 1);
      const tw = ctx.measureText(text).width;
      if (chosen || free(sx + 6, sy - 15, tw + 2, 12)) {
        placed.push([sx + 6, sy - 15, tw + 2, 12]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = p.plate;
        ctx.strokeText(text, sx + 7, sy - 9);
        ctx.fillStyle = p.accentInk;
        ctx.fillText(text, sx + 7, sy - 9);
      }
    }
    ctx.globalAlpha = 1;

    // The paper under the pointer, or pointed at from the index.
    for (const i of [hoverIndex.current, pt]) {
      if (i === null || i === undefined || i === sel) continue;
      const [sx, sy] = toScreen(s.x[i] ?? 0, s.y[i] ?? 0, v);
      ctx.beginPath();
      ctx.arc(sx, sy, 7.5, 0, Math.PI * 2);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = arrivalRank.has(i) ? p.mark : p.ink;
      ctx.stroke();
    }

    // The chosen paper: a crosshair to the margins, as an atlas plots a star.
    let selCol = -1, selRow = -1;
    if (sel !== null) {
      const [sx, sy] = toScreen(s.x[sel] ?? 0, s.y[sel] ?? 0, v);
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = p.mark;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(inner.x, Math.round(sy) + 0.5); ctx.lineTo(sx - 10, Math.round(sy) + 0.5);
      ctx.moveTo(sx + 10, Math.round(sy) + 0.5); ctx.lineTo(inner.x + inner.w, Math.round(sy) + 0.5);
      ctx.moveTo(Math.round(sx) + 0.5, inner.y); ctx.lineTo(Math.round(sx) + 0.5, sy - 10);
      ctx.moveTo(Math.round(sx) + 0.5, sy + 10); ctx.lineTo(Math.round(sx) + 0.5, inner.y + inner.h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Ringed here unless the opening has already drawn its numbered ring.
      if ((arrivalRank.get(sel) ?? Infinity) >= litCount) {
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = p.mark;
        ctx.stroke();
      }
      const cell = gridCell(s.x[sel] ?? 0, s.y[sel] ?? 0, s.bounds);
      selCol = GRID_LETTERS.indexOf(cell[0] ?? 'A');
      selRow = Number(cell.slice(1)) - 1;
    }
    ctx.restore();

    // The margins: a double rule, and the grid's letters and numbers.
    ctx.fillStyle = p.plate;
    ctx.fillRect(0, 0, size.w, MARGIN); ctx.fillRect(0, size.h - MARGIN, size.w, MARGIN);
    ctx.fillRect(0, 0, MARGIN, size.h); ctx.fillRect(size.w - MARGIN, 0, MARGIN, size.h);
    ctx.strokeStyle = p.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(inner.x + 0.5, inner.y + 0.5, inner.w - 1, inner.h - 1);
    ctx.lineWidth = 0.5;
    ctx.strokeRect(inner.x - 3.5, inner.y - 3.5, inner.w + 7, inner.h + 7);
    ctx.font = '500 10.5px "Geist Variable", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < GRID; k++) {
      const [gx] = toScreen(b.minX + (b.size * (k + 0.5)) / GRID, 0, v);
      const [, gy] = toScreen(0, b.minY + b.size - (b.size * (k + 0.5)) / GRID, v);
      ctx.fillStyle = k === selCol ? p.accentInk : p.ink3;
      if (gx > inner.x + 6 && gx < inner.x + inner.w - 6) {
        ctx.fillText(GRID_LETTERS[k] ?? '', gx, MARGIN / 2 - 1);
        ctx.fillText(GRID_LETTERS[k] ?? '', gx, size.h - MARGIN / 2 + 1);
      }
      ctx.fillStyle = k === selRow ? p.accentInk : p.ink3;
      if (gy > inner.y + 6 && gy < inner.y + inner.h - 6) {
        ctx.fillText(String(k + 1), MARGIN / 2, gy);
        ctx.fillText(String(k + 1), size.w - MARGIN / 2, gy);
      }
    }
    // How long this frame took to draw, and where it looks, where a test or a person can read them.
    node.dataset.frameMs = (performance.now() - started).toFixed(1);
    node.dataset.view = `${v.cx} ${v.cy} ${v.scale}`;
    if (glide.current) frame.current = requestAnimationFrame(() => drawRef.current());
  }, [size, toScreen, arrivalRank, occupied, papersUnder, paint]);
  useEffect(() => { drawRef.current = draw; }, [draw]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(() => drawRef.current());
  }, []);

  // Size the canvas for the screen's pixels, and fit the sky the first time.
  useEffect(() => {
    const node = canvas.current;
    if (!node || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    node.width = Math.round(size.w * dpr);
    node.height = Math.round(size.h * dpr);
    const b = sky.bounds;
    const scale = Math.min(size.w - MARGIN * 2 - 24, size.h - MARGIN * 2 - 24) / b.size;
    const fitted = { cx: b.minX + b.size / 2, cy: b.minY + b.size / 2, scale };
    const wasHome = view.current.scale === home.current.scale && view.current.cx === home.current.cx;
    home.current = fitted;
    if (wasHome) view.current = fitted;
    schedule();
  }, [size, sky, schedule]);

  useEffect(() => {
    if (wrap.current) palette.current = readPalette(wrap.current);
    shading.current = palette.current ? shadingImage(field, palette.current.ink) : null;
    schedule();
  }, [paletteKey, field, schedule]);

  useEffect(() => {
    const node = wrap.current;
    groupColors.current = node ? (look?.colors ?? []).map((color) => resolveColor(node, color)) : [];
    schedule();
  }, [paletteKey, look, schedule]);

  useEffect(() => { schedule(); }, [lit, selected, pointed, shapes, regions, arrivals, paint, schedule]);

  const reportAway = useCallback(() => {
    const v = view.current, h = home.current;
    onAway(Math.abs(v.scale / h.scale - 1) > 0.05 || Math.hypot(v.cx - h.cx, v.cy - h.cy) * h.scale > 24);
  }, [onAway]);

  const go = useCallback((to: View) => {
    if (reduced) { view.current = to; glide.current = null; schedule(); reportAway(); return; }
    glide.current = { from: { ...view.current }, to, start: performance.now() };
    schedule();
    window.setTimeout(reportAway, 540);
  }, [reduced, schedule, reportAway]);

  useImperativeHandle(ref, () => ({
    flyTo: (box) => {
      if (!box) { go({ ...home.current }); return; }
      const fit = Math.min(size.w - MARGIN * 2, size.h - MARGIN * 2) / (box.r * 2 * 1.35);
      go({ cx: box.x, cy: box.y, scale: Math.max(home.current.scale, Math.min(fit, home.current.scale * 40)) });
    },
    focus: () => canvas.current?.focus(),
  }), [go, size]);

  const zoomAt = (factor: number, sx: number, sy: number) => {
    const v = view.current;
    const scale = Math.min(home.current.scale * 40, Math.max(home.current.scale * 0.8, v.scale * factor));
    const [px, py] = toPlate(sx, sy, v);
    view.current = { scale, cx: px - (sx - size.w / 2) / scale, cy: py - (size.h / 2 - sy) / scale };
    glide.current = null;
    schedule();
    reportAway();
  };

  const nearest = (sx: number, sy: number): number | null => {
    const v = view.current;
    const [px, py] = toPlate(sx, sy, v);
    const { cells, buckets } = hash;
    const b = sky.bounds;
    const reach = 9 / v.scale;
    const c0 = Math.floor(((px - reach - b.minX) / b.size) * cells), c1 = Math.floor(((px + reach - b.minX) / b.size) * cells);
    const r0 = Math.floor(((py - reach - b.minY) / b.size) * cells), r1 = Math.floor(((py + reach - b.minY) / b.size) * cells);
    let best: number | null = null, bestD = Infinity;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const i of buckets.get(r * cells + c) ?? []) {
          // New papers win ties: their rings are what a pointer is aimed at.
          // A paper the filters dimmed can still be chosen, but a lit one near it wins.
          // Papers drawn on the same spot tie at any distance; there the lit one wins too.
          const out = look?.lit && !look.lit[i];
          const d = Math.hypot((sky.x[i] ?? 0) - px, (sky.y[i] ?? 0) - py) * (arrivalRank.has(i) ? 0.6 : 1) * (out ? 1.6 : 1)
            + (out ? 1e-9 : 0);
          if (d < reach && d < bestD) { best = i; bestD = d; }
        }
      }
    }
    return best;
  };

  const local = (event: { clientX: number; clientY: number }): [number, number] => {
    const box = canvas.current?.getBoundingClientRect();
    return box ? [event.clientX - box.left, event.clientY - box.top] : [0, 0];
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const [x, y] = local(event);
    drag.current = { x, y, moved: false, view: { ...view.current } };
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = local(event);
    const d = drag.current;
    if (d) {
      if (!d.moved && Math.hypot(x - d.x, y - d.y) > 3) d.moved = true;
      if (d.moved) {
        view.current = { ...d.view, cx: d.view.cx - (x - d.x) / d.view.scale, cy: d.view.cy + (y - d.y) / d.view.scale };
        glide.current = null;
        hoverIndex.current = null;
        onHover(null);
        schedule();
        return;
      }
    }
    const hit = nearest(x, y);
    if (hit !== hoverIndex.current) {
      hoverIndex.current = hit;
      if (hit === null) onHover(null);
      else {
        const [sx, sy] = toScreen(sky.x[hit] ?? 0, sky.y[hit] ?? 0);
        onHover({ index: hit, screenX: sx, screenY: sy, width: size.w, height: size.h });
      }
      schedule();
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved) { reportAway(); return; }
    const [x, y] = local(event);
    onSelect(nearest(x, y), 'pointer');
  };
  const onPointerLeave = () => {
    if (hoverIndex.current !== null) { hoverIndex.current = null; onHover(null); schedule(); }
  };
  // The wheel zooms the plate and nothing else: listened to directly, not
  // passively, so a plate inside a page that scrolls does not scroll it too.
  // A plate set in a scrolling page leaves the page its scroll: there a pinch
  // (which arrives as a wheel with Control held) zooms, and a sideways swipe
  // pans, as the swipe rule for a map that pans expects (`SwipeNavigation`).
  const wheel = useRef<(event: globalThis.WheelEvent) => void>(() => undefined);
  useEffect(() => {
    wheel.current = (event) => {
      if (wheelMode === 'page' && !event.ctrlKey) {
        if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
        event.preventDefault();
        const v = view.current;
        view.current = { ...v, cx: v.cx + event.deltaX / v.scale };
        glide.current = null;
        schedule();
        reportAway();
        return;
      }
      event.preventDefault();
      const [x, y] = local(event);
      zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018)), x, y);
    };
  });
  useEffect(() => {
    const node = canvas.current;
    if (!node) return undefined;
    const listener = (event: globalThis.WheelEvent) => wheel.current(event);
    node.addEventListener('wheel', listener, { passive: false });
    return () => node.removeEventListener('wheel', listener);
  }, []);

  const isLit = (i: number) => !look?.lit || look.lit[i] === 1;

  /** Choose a paper from the keyboard, and keep it on the screen. */
  const choose = (i: number | null) => {
    if (i === null) return;
    onSelect(i, 'keyboard');
    const [sx, sy] = toScreen(sky.x[i] ?? 0, sky.y[i] ?? 0);
    const edge = MARGIN + 30;
    if (sx < edge || sx > size.w - edge || sy < edge || sy > size.h - edge) {
      go({ ...view.current, cx: sky.x[i] ?? 0, cy: sky.y[i] ?? 0 });
    }
  };

  /** The lit paper nearest the middle of the plate as it is shown. */
  const nearestMiddle = (): number | null => {
    const [px, py] = toPlate(size.w / 2, size.h / 2);
    let best: number | null = null, bestD = Infinity;
    for (let i = 0; i < sky.count; i++) {
      if (!isLit(i)) continue;
      const d = Math.hypot((sky.x[i] ?? 0) - px, (sky.y[i] ?? 0) - py);
      if (d < bestD) { best = i; bestD = d; }
    }
    return best;
  };

  /**
   * The lit paper nearest the chosen one in a direction: within 60 degrees of
   * it, nearer the line counting for more than nearer the paper.
   */
  const nearestToward = (from: number, dx: number, dy: number): number | null => {
    const x0 = sky.x[from] ?? 0, y0 = sky.y[from] ?? 0;
    let best: number | null = null, bestScore = Infinity;
    for (let i = 0; i < sky.count; i++) {
      if (i === from || !isLit(i)) continue;
      const ex = (sky.x[i] ?? 0) - x0, ey = (sky.y[i] ?? 0) - y0;
      const along = ex * dx + ey * dy;
      if (along <= 0) continue;
      const across = Math.abs(ex * dy - ey * dx);
      if (across > along * Math.tan(Math.PI / 3)) continue;
      const score = along + across * 2;
      if (score < bestScore) { best = i; bestScore = score; }
    }
    return best;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const v = view.current;
    const step = 60 / v.scale;
    if (event.shiftKey && event.key.startsWith('Arrow')) {
      const ways: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
      };
      const way = ways[event.key];
      if (way) {
        event.preventDefault();
        choose(selected === null ? nearestMiddle() : nearestToward(selected, way[0], way[1]));
      }
      return;
    }
    const moves: Record<string, () => void> = {
      Enter: () => { if (selected === null) choose(nearestMiddle()); else onOpen?.(selected); },
      '+': () => zoomAt(1.5, size.w / 2, size.h / 2),
      '=': () => zoomAt(1.5, size.w / 2, size.h / 2),
      '-': () => zoomAt(1 / 1.5, size.w / 2, size.h / 2),
      '0': () => go({ ...home.current }),
      ArrowLeft: () => go({ ...v, cx: v.cx - step }),
      ArrowRight: () => go({ ...v, cx: v.cx + step }),
      ArrowUp: () => go({ ...v, cy: v.cy + step }),
      ArrowDown: () => go({ ...v, cy: v.cy - step }),
      Escape: () => onSelect(null, 'keyboard'),
    };
    const move = moves[event.key];
    if (move) { event.preventDefault(); move(); }
  };

  return (
    <div className="plate" ref={wrap}>
      <canvas
        ref={canvas}
        className="plate-canvas"
        style={{ width: size.w, height: size.h }}
        tabIndex={0}
        role="img"
        aria-label={label}
        aria-describedby={keysId}
        data-selected={selected !== null ? sky.ids[selected] : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={(event) => { const [x, y] = local(event); zoomAt(2, x, y); }}
        onKeyDown={onKeyDown}
      />
      <p id={keysId} className="sr-only">
        Plus and minus zoom, the arrow keys move, zero returns to {whole}. Enter chooses the paper nearest the
        middle, Shift and an arrow key choose the nearest paper that way, and Escape clears the choice. A chosen
        paper opens beside the map.
      </p>
      <div className={`plate-tools ${toolsAt}`} role="group" aria-label="Map zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.6, size.w / 2, size.h / 2)}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.6, size.w / 2, size.h / 2)}>
          <Icon name="minus" size={14} />
        </button>
        <button type="button" aria-label={`Show ${whole}`} title={`Show ${whole}`} onClick={() => go({ ...home.current })}>
          <Icon name="fit" size={14} />
        </button>
      </div>
      {children}
    </div>
  );
});

/**
 * The plate's legend, in its own strip under it. With the papers colored, the
 * colors' key (`colors`) takes the place of the sizes' days, which it repeats
 * or would crowd.
 */
export function PlateKey({ newLabel, showWatches, colors, extra }: {
  newLabel?: string; showWatches: boolean; colors?: ReactNode; extra?: ReactNode;
}) {
  return (
    <div className="plate-key" aria-label="Map key">
      {colors ?? (
        <span className="plate-key-ramp">
          {RAMP_DAYS.map((days, cls) => (
            <span key={days}>
              <svg width="8" height="8" aria-hidden="true">
                <circle cx="4" cy="4" r={(RAMP_RADIUS[cls] ?? 1) * 1.2} fill="currentColor" opacity={RAMP_ALPHA[cls]} />
              </svg>
              {days}
            </span>
          ))}
          <span className="plate-key-unit">days since collected</span>
        </span>
      )}
      {newLabel && (
        <span className="plate-key-item">
          <svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="var(--accent-mark)" strokeWidth="1.25" /><circle cx="7" cy="7" r="1.5" fill="currentColor" /></svg>
          {newLabel}
        </span>
      )}
      {showWatches && (
        <span className="plate-key-item">
          <svg width="22" height="8" aria-hidden="true"><path d="M1 4h20" stroke="var(--bound)" strokeDasharray="3 3.5" /></svg>
          a watch&rsquo;s papers
        </span>
      )}
      <span className="plate-key-item">
        <svg width="14" height="10" aria-hidden="true"><rect width="14" height="10" rx="2" fill="currentColor" opacity="0.12" /></svg>
        more papers nearby
      </span>
      {extra}
    </div>
  );
}
