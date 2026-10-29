import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { useAppearance } from '../../theme/appearance';
import { MAP_KEY } from '../Today';

/** Up to this many marked papers are ringed; more are drawn as accent points. */
const RING_LIMIT = 80;
/** The fewest marked papers a dashed outline goes around. */
const OUTLINE_MIN = 5;

/** What the sky could establish about the papers it was asked to mark. */
export interface SkyFacts {
  /** How many of the marked papers the map has placed; `null` until the map is read. */
  placed: number | null;
  total: number;
  /** The map is fitted and has points. */
  ready: boolean;
  /** How the map placed papers: by their embeddings or by shared wording. */
  basis: 'embeddings' | 'words' | null;
}

interface Props {
  /** The papers to mark among the whole collection. */
  marked: readonly number[];
  /** One paper drawn larger, at the center of attention (a paper's own page). */
  focus?: number | null;
  /** The accessible name of the figure. */
  label: string;
  caption: (facts: SkyFacts) => string;
  /** Square by default; `tall` fills the height it is given. */
  shape?: 'square' | 'tall';
  /**
   * Of the marked papers, the ones to ring however many there are (a watch's
   * latest night); the rest of the marked are drawn as accent points.
   */
  bright?: readonly number[];
  /**
   * Draw a dashed line around each close group of marked papers (five or more
   * placed near one another), which is where a watch's papers gather on the
   * map. A group is found by distance on the drawing, not by any model.
   */
  outline?: boolean;
}

/**
 * Where some papers sit in the whole collection: every placed paper as a faint
 * point, the marked ones in the accent. The same positions as Today's plate,
 * read from `/api/map`. Not interactive: Today's plate is the one to explore.
 *
 * A paper the map has not placed (it arrived after the last fit, or has too
 * little text to place) is not drawn, so the caption is told how many of the
 * marked papers were placed and can say so rather than imply the whole set.
 */
export function PaperSky({ marked, focus = null, label, caption, shape = 'square', bright, outline = false }: Props) {
  const { shown, theme } = useAppearance();
  const map = useQuery({ queryKey: MAP_KEY, queryFn: () => answer(engine().GET('/api/map')) });
  const canvas = useRef<HTMLCanvasElement>(null);
  const wanted = useMemo(() => new Set(marked), [marked]);
  const ringed = useMemo(() => (bright ? new Set(bright) : null), [bright]);

  const placed = useMemo(() => {
    const points = map.data?.points;
    if (!points) return null;
    let n = 0;
    for (const id of points.id) if (wanted.has(id)) n += 1;
    return n;
  }, [map.data, wanted]);

  useEffect(() => {
    const el = canvas.current;
    const points = map.data?.points;
    if (!el || !points || !points.id.length) return undefined;
    const draw = () => {
      const box = el.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      el.width = Math.round(box.width * ratio);
      el.height = Math.round(box.height * ratio);
      const ctx = el.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const css = getComputedStyle(el);
      const ink = css.getPropertyValue('--ink-3').trim() || '#8f8b82';
      const mark = css.getPropertyValue('--accent-mark').trim() || '#ff8a3d';
      const grid = css.getPropertyValue('--grid').trim() || '#1a1a1b';
      const strong = css.getPropertyValue('--ink').trim() || '#f1eee6';
      ctx.clearRect(0, 0, box.width, box.height);

      // The collection's own bounds, padded, kept square so distances read true.
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      for (let i = 0; i < points.x.length; i += 1) {
        const x = points.x[i] ?? 0; const y = points.y[i] ?? 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const span = Math.max(maxX - minX, maxY - minY) || 1;
      const pad = 18;
      const size = Math.min(box.width, box.height) - pad * 2;
      const ox = (box.width - size) / 2; const oy = (box.height - size) / 2;
      const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
      const px = (x: number) => ox + ((x - cx) / span + 0.5) * size;
      const py = (y: number) => oy + ((y - cy) / span + 0.5) * size;

      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      for (let k = 0; k <= 4; k += 1) {
        const at = Math.round(ox + (k / 4) * size) + 0.5;
        ctx.beginPath(); ctx.moveTo(at, oy); ctx.lineTo(at, oy + size); ctx.stroke();
        const yAt = Math.round(oy + (k / 4) * size) + 0.5;
        ctx.beginPath(); ctx.moveTo(ox, yAt); ctx.lineTo(ox + size, yAt); ctx.stroke();
      }

      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.55;
      // The collection's own points grow a little with the drawing, so a large
      // sky still reads as a collection rather than as dust.
      const dot = Math.max(1.2, Math.min(2.2, size / 420));
      const hits: [number, number][] = [];
      const rings: [number, number][] = [];
      let focused: [number, number] | null = null;
      for (let i = 0; i < points.id.length; i += 1) {
        const id = points.id[i] ?? -1;
        const x = px(points.x[i] ?? 0); const y = py(points.y[i] ?? 0);
        if (id === focus) { focused = [x, y]; continue; }
        if (wanted.has(id)) {
          if (ringed?.has(id)) rings.push([x, y]); else hits.push([x, y]);
          continue;
        }
        ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot);
      }
      ctx.globalAlpha = 1;
      if (outline) {
        ctx.strokeStyle = mark;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        for (const group of closeGroups([...hits, ...rings], Math.max(14, size * 0.045), OUTLINE_MIN)) {
          const hull = convexHull(group);
          if (hull.length < 3) continue;
          // Pushed out from the hull's middle, so the line passes around the
          // outermost papers rather than through them.
          const [mx, my] = centroid(hull);
          ctx.beginPath();
          hull.forEach(([x, y], k) => {
            const d = Math.hypot(x - mx, y - my) || 1;
            const ex = x + ((x - mx) / d) * 9; const ey = y + ((y - my) / d) * 9;
            if (k === 0) ctx.moveTo(ex, ey); else ctx.lineTo(ex, ey);
          });
          ctx.closePath(); ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      // A ring per paper reads while there are a handful; past that the rings
      // overlap into a texture, so many are drawn as accent points instead.
      // Papers named `bright` are ringed however many the rest are.
      const ringAll = !ringed && hits.length <= RING_LIMIT;
      if (!ringAll) {
        ctx.fillStyle = mark;
        for (const [x, y] of hits) {
          ctx.beginPath(); ctx.arc(x, y, 1.7, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.strokeStyle = mark;
      ctx.fillStyle = strong;
      ctx.lineWidth = 1.25;
      for (const [x, y] of ringAll ? hits : rings) {
        ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 1.3, 0, Math.PI * 2); ctx.fill();
      }
      if (focused) {
        const [x, y] = focused;
        ctx.strokeStyle = mark;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillStyle = mark;
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    return () => observer.disconnect();
  }, [map.data, wanted, ringed, outline, focus, shown, theme]);

  const ready = !!map.data && map.data.state === 'ready' && map.data.points.id.length > 0;
  const facts: SkyFacts = {
    placed,
    total: marked.length + (focus !== null && !wanted.has(focus) ? 1 : 0),
    ready,
    basis: map.data?.basis ?? null,
  };
  return (
    <figure className={shape === 'tall' ? 'sky tall' : 'sky'} aria-label={label}>
      {map.data && map.data.points.id.length > 0
        ? <canvas ref={canvas} className="sky-canvas" role="img" aria-label={caption(facts)} />
        : <div className="sky-empty">{map.isPending ? 'Reading the map.' : 'The collection map has no papers placed yet.'}</div>}
      <figcaption>{caption(facts)}</figcaption>
    </figure>
  );
}

/** The convex hull of some points, counterclockwise (Andrew's monotone chain). */
export function convexHull(points: readonly [number, number][]): [number, number][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * Points within `radius` of one another, chained: single linkage on a grid of
 * `radius` cells, so each point is compared only with its neighbors. Groups
 * smaller than `min` are dropped.
 */
export function closeGroups(points: readonly [number, number][], radius: number, min: number): [number, number][][] {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) { const next = parent[i]!; parent[i] = root; i = next; }
    return root;
  };
  const cells = new Map<string, number[]>();
  points.forEach(([x, y], i) => {
    const key = `${Math.floor(x / radius)}:${Math.floor(y / radius)}`;
    cells.set(key, [...(cells.get(key) ?? []), i]);
  });
  const r2 = radius * radius;
  points.forEach(([x, y], i) => {
    const cx = Math.floor(x / radius); const cy = Math.floor(y / radius);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const j of cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (j <= i) continue;
          const [qx, qy] = points[j]!;
          if ((qx - x) ** 2 + (qy - y) ** 2 <= r2) parent[find(i)] = find(j);
        }
      }
    }
  });
  const groups = new Map<number, [number, number][]>();
  points.forEach((p, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), p]);
  });
  return [...groups.values()].filter((g) => g.length >= min);
}

function centroid(points: readonly [number, number][]): [number, number] {
  let x = 0; let y = 0;
  for (const [px, py] of points) { x += px; y += py; }
  return [x / points.length, y / points.length];
}

/** "placed by shared wording" or "placed by meaning", for a caption. */
export function basisWords(basis: SkyFacts['basis']): string {
  if (basis === 'embeddings') return 'placed by meaning';
  if (basis === 'words') return 'placed by shared wording';
  return 'placed on the map';
}
