import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
  type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent,
} from 'react';
import { Icon } from '../../shell/Icon';
import {
  GRID, GRID_LETTERS, RAMP_DAYS, gridCell, type Field, type MapRegion, type Sky, type WatchShape,
} from './model';

/** Where the plate is looking: a plate-space center and pixels per plate unit. */
interface View { cx: number; cy: number; scale: number }

export interface PlateHandle {
  /** Fly to a plate-space box, or home when none is given. */
  flyTo: (box?: { x: number; y: number; r: number }) => void;
}

export interface PlateHover { index: number; screenX: number; screenY: number }

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
  onSelect: (index: number | null) => void;
  onHover: (hover: PlateHover | null) => void;
  /** Read when the theme or accent changes, so the canvas redraws in it. */
  paletteKey: string;
  label: string;
  children?: ReactNode;
  onAway: (away: boolean) => void;
  /** The zoom buttons' corner: bottom left, unless the title block is there. */
  toolsAt?: 'left' | 'right';
}

const MARGIN = 26;
const RAMP_RADIUS = [2.3, 1.8, 1.4, 1.1, 0.85];
const RAMP_ALPHA = [1, 0.86, 0.66, 0.46, 0.32];

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

/** A spatial hash over plate space, for finding the paper under the pointer. */
function buildHash(sky: Sky, cells = 192) {
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
    label, children, onAway, toolsAt = 'left',
  } = props;
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
    for (let cls = RAMP_RADIUS.length - 1; cls >= 0; cls--) {
      const r = Math.min((RAMP_RADIUS[cls] ?? 1) * boost, cap);
      ctx.globalAlpha = (RAMP_ALPHA[cls] ?? 0.5) * crowding;
      ctx.fillStyle = p.ink;
      const round = r >= 1.15;
      if (round) ctx.beginPath();
      for (let i = 0; i < s.count; i++) {
        if (s.ramp[i] !== cls) continue;
        const sx = ((s.x[i] ?? 0) - v.cx) * v.scale + size.w / 2;
        const sy = size.h / 2 - ((s.y[i] ?? 0) - v.cy) * v.scale;
        if (sx < inner.x - pad || sx > inner.x + inner.w + pad || sy < inner.y - pad || sy > inner.y + inner.h + pad) continue;
        if (round) { ctx.moveTo(sx + r, sy); ctx.arc(sx, sy, r, 0, Math.PI * 2); }
        else ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      }
      if (round) ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Region names, largest first, only where the region is big enough on
    // screen to own one, and never over another name.
    const placed: [number, number, number, number][] = [];
    // The title block sits over the plate; no name is drawn under it.
    const block = wrap.current?.querySelector<HTMLElement>('.cartouche:not(.away)');
    if (block && canvas.current) {
      const a = block.getBoundingClientRect();
      const c = canvas.current.getBoundingClientRect();
      placed.push([a.left - c.left - 6, a.top - c.top - 6, a.width + 12, a.height + 12]);
    }
    const free = (x: number, y: number, w: number, h: number) =>
      !placed.some(([px, py, pw, ph]) => x < px + pw && px < x + w && y < py + ph && py < y + h);
    ctx.font = '500 10.5px "Geist Variable", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const byShown = [...rs].sort((a, c) => c.size - a.size);
    for (const region of byShown) {
      const screenR = region.r * v.scale;
      if (screenR < 30 || !region.label) continue;
      const [rx, ry] = toScreen(region.x, region.y, v);
      const ly = ry - screenR * 0.82;
      const width = ctx.measureText(region.label).width + 8;
      if (!free(rx - width / 2, ly - 8, width, 16)) continue;
      placed.push([rx - width / 2, ly - 8, width, 16]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = p.plate;
      ctx.strokeText(region.label, rx, ly);
      ctx.fillStyle = p.ink3;
      ctx.fillText(region.label, rx, ly);
    }

    // Watch names, in the atlas's italic.
    ctx.font = 'italic 400 21px Spectral, Georgia, serif';
    for (const w of ws) {
      if (!w.labelAt) continue;
      const [wx, wy] = toScreen(w.labelAt[0], w.labelAt[1], v);
      const ly = wy - 14;
      const width = ctx.measureText(w.name).width + 10;
      if (!free(wx - width / 2, ly - 14, width, 28)) continue;
      placed.push([wx - width / 2, ly - 14, width, 28]);
      ctx.lineWidth = 5;
      ctx.strokeStyle = p.plate;
      ctx.strokeText(w.name, wx, ly);
      ctx.fillStyle = p.ink;
      ctx.fillText(w.name, wx, ly);
    }

    // Last night's papers: ringed and numbered, as far as the opening has lit
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
    // How long this frame took to draw, where a test or a person can read it.
    node.dataset.frameMs = (performance.now() - started).toFixed(1);
    if (glide.current) frame.current = requestAnimationFrame(() => drawRef.current());
  }, [size, toScreen, arrivalRank, occupied]);
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

  useEffect(() => { schedule(); }, [lit, selected, pointed, shapes, regions, arrivals, schedule]);

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
          const d = Math.hypot((sky.x[i] ?? 0) - px, (sky.y[i] ?? 0) - py) * (arrivalRank.has(i) ? 0.6 : 1);
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
        onHover({ index: hit, screenX: sx, screenY: sy });
      }
      schedule();
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved) { reportAway(); return; }
    const [x, y] = local(event);
    onSelect(nearest(x, y));
  };
  const onPointerLeave = () => {
    if (hoverIndex.current !== null) { hoverIndex.current = null; onHover(null); schedule(); }
  };
  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    const [x, y] = local(event);
    zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018)), x, y);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const v = view.current;
    const step = 60 / v.scale;
    const moves: Record<string, () => void> = {
      '+': () => zoomAt(1.5, size.w / 2, size.h / 2),
      '=': () => zoomAt(1.5, size.w / 2, size.h / 2),
      '-': () => zoomAt(1 / 1.5, size.w / 2, size.h / 2),
      '0': () => go({ ...home.current }),
      ArrowLeft: () => go({ ...v, cx: v.cx - step }),
      ArrowRight: () => go({ ...v, cx: v.cx + step }),
      ArrowUp: () => go({ ...v, cy: v.cy + step }),
      ArrowDown: () => go({ ...v, cy: v.cy - step }),
      Escape: () => onSelect(null),
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
        aria-describedby="plate-keys"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        onDoubleClick={(event) => { const [x, y] = local(event); zoomAt(2, x, y); }}
        onKeyDown={onKeyDown}
      />
      <p id="plate-keys" className="sr-only">
        Plus and minus zoom, the arrow keys move, zero returns to the whole collection, Escape clears the selection.
        Every paper on the map is listed beside it.
      </p>
      <div className={`plate-tools ${toolsAt}`} role="group" aria-label="Map zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.6, size.w / 2, size.h / 2)}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.6, size.w / 2, size.h / 2)}>
          <Icon name="minus" size={14} />
        </button>
        <button type="button" aria-label="Show the whole collection" onClick={() => go({ ...home.current })}>
          <Icon name="fit" size={14} />
        </button>
      </div>
      {children}
    </div>
  );
});

/** The plate's legend, in its own strip under it. */
export function PlateKey({ newLabel, showWatches }: { newLabel: string; showWatches: boolean }) {
  return (
    <div className="plate-key" aria-label="Map key">
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
      <span className="plate-key-item">
        <svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="var(--accent-mark)" strokeWidth="1.25" /><circle cx="7" cy="7" r="1.5" fill="currentColor" /></svg>
        {newLabel}
      </span>
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
    </div>
  );
}
