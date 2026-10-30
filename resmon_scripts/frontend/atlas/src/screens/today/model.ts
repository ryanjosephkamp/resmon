/**
 * The plate's model: everything about the sky that is not drawing.
 *
 * Plate space is the collection map's own (`/api/map`), roughly [-1, 1] on
 * each axis with y pointing up. Screen space is CSS pixels with y down. Every
 * derived structure here (the density field, the watch outlines, the
 * constellation lines) is computed once per data load, never per frame.
 */

export interface MapPoints {
  id: number[];
  x: number[];
  y: number[];
  region: number[];
  seen_day: number[];
}

export interface MapRegion {
  id: number;
  label: string;
  terms: string[];
  x: number;
  y: number;
  r: number;
  size: number;
}

/** The days-since-collected classes of the magnitude ramp, brightest first. */
export const RAMP_DAYS = [0, 7, 30, 90, 180] as const;

/** Which ramp class a paper collected `age` days ago falls in (0 = newest). */
export function rampClass(age: number): number {
  for (let i = RAMP_DAYS.length - 1; i >= 0; i--) {
    const days = RAMP_DAYS[i];
    if (days !== undefined && age >= days) return i;
  }
  return 0;
}

export interface Sky {
  count: number;
  ids: Int32Array;
  x: Float32Array;
  y: Float32Array;
  region: Int16Array;
  ramp: Uint8Array;
  /** Index of each id, for joining Today's papers and the watches onto the plate. */
  indexOf: Map<number, number>;
  /** The square of plate space the grid is drawn over. */
  bounds: { minX: number; minY: number; size: number };
}

/** Days since 1970-01-01 (UTC) for a moment, matching `seen_day`. */
export function epochDay(at: Date): number {
  return Math.floor(at.getTime() / 86_400_000);
}

export function buildSky(points: MapPoints, regions: readonly MapRegion[], today: number): Sky {
  const count = points.id.length;
  const ids = new Int32Array(count);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const region = new Int16Array(count);
  const ramp = new Uint8Array(count);
  const indexOf = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const id = points.id[i] ?? 0;
    ids[i] = id;
    x[i] = points.x[i] ?? 0;
    y[i] = points.y[i] ?? 0;
    region[i] = points.region[i] ?? 0;
    ramp[i] = rampClass(Math.max(0, today - (points.seen_day[i] ?? today)));
    indexOf.set(id, i);
  }
  return { count, ids, x, y, region, ramp, indexOf, bounds: plateBounds(x, y, regions) };
}

/**
 * The square the plate's grid covers: every region disc and every paper, with
 * a little air, centered. Square so a grid cell is square.
 */
export function plateBounds(x: Float32Array, y: Float32Array, regions: readonly MapRegion[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions) {
    minX = Math.min(minX, r.x - r.r); maxX = Math.max(maxX, r.x + r.r);
    minY = Math.min(minY, r.y - r.r); maxY = Math.max(maxY, r.y + r.r);
  }
  for (let i = 0; i < x.length; i++) {
    const px = x[i] ?? 0, py = y[i] ?? 0;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  if (!Number.isFinite(minX)) return { minX: -1, minY: -1, size: 2 };
  const size = Math.max(maxX - minX, maxY - minY, 1e-3) * 1.06;
  return { minX: (minX + maxX) / 2 - size / 2, minY: (minY + maxY) / 2 - size / 2, size };
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * The corner of the plate with the fewest papers under a box `w` by `h` (as
 * shares of the plate), where the title block covers the least of the sky.
 */
export function emptiestCorner(sky: Sky, w = 0.34, h = 0.48): Corner {
  const { minX, minY, size } = sky.bounds;
  const counts: Record<Corner, number> = { tl: 0, tr: 0, bl: 0, br: 0 };
  for (let i = 0; i < sky.count; i++) {
    const fx = ((sky.x[i] ?? 0) - minX) / size;
    const fy = ((sky.y[i] ?? 0) - minY) / size;
    const left = fx <= w, right = fx >= 1 - w, top = fy >= 1 - h, bottom = fy <= h;
    if (top && left) counts.tl++;
    if (top && right) counts.tr++;
    if (bottom && left) counts.bl++;
    if (bottom && right) counts.br++;
  }
  // Top right first on a tie: it is where the reference put the title block.
  return (['tr', 'tl', 'br', 'bl'] as Corner[]).reduce((best, c) => (counts[c] < counts[best] ? c : best), 'tr');
}

export const GRID = 8;
export const GRID_LETTERS = 'ABCDEFGH';

/** The grid cell a plate point is in, as the margins label it: "B3". Rows count down from the top. */
export function gridCell(px: number, py: number, bounds: Sky['bounds']): string {
  const col = Math.min(GRID - 1, Math.max(0, Math.floor(((px - bounds.minX) / bounds.size) * GRID)));
  const row = Math.min(GRID - 1, Math.max(0, Math.floor(((bounds.minY + bounds.size - py) / bounds.size) * GRID)));
  return `${GRID_LETTERS[col] ?? 'A'}${row + 1}`;
}

// ---------------------------------------------------------------------------
// Density: a blurred count of papers per cell, for the "more papers nearby"
// shading and the watch outlines.
// ---------------------------------------------------------------------------

export interface Field {
  n: number;
  values: Float32Array;
  max: number;
}

function boxBlur(src: Float32Array, n: number, radius: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const width = radius * 2 + 1;
  for (let row = 0; row < n; row++) {
    let sum = 0;
    for (let c = -radius; c <= radius; c++) sum += src[row * n + Math.min(n - 1, Math.max(0, c))] ?? 0;
    for (let c = 0; c < n; c++) {
      tmp[row * n + c] = sum / width;
      const add = src[row * n + Math.min(n - 1, c + radius + 1)] ?? 0;
      const drop = src[row * n + Math.max(0, c - radius)] ?? 0;
      sum += add - drop;
    }
  }
  for (let c = 0; c < n; c++) {
    let sum = 0;
    for (let r = -radius; r <= radius; r++) sum += tmp[Math.min(n - 1, Math.max(0, r)) * n + c] ?? 0;
    for (let r = 0; r < n; r++) {
      out[r * n + c] = sum / width;
      const add = tmp[Math.min(n - 1, r + radius + 1) * n + c] ?? 0;
      const drop = tmp[Math.max(0, r - radius) * n + c] ?? 0;
      sum += add - drop;
    }
  }
  return out;
}

/**
 * Counts of the chosen papers (all of them when `only` is absent) on an n×n
 * grid over the plate bounds, blurred three times (close to a Gaussian).
 * Row 0 is the top of the plate.
 */
export function density(sky: Sky, n: number, radius: number, only?: Iterable<number>): Field {
  const counts = new Float32Array(n * n);
  const { minX, minY, size } = sky.bounds;
  const add = (i: number) => {
    const col = Math.floor((((sky.x[i] ?? 0) - minX) / size) * n);
    const row = Math.floor(((minY + size - (sky.y[i] ?? 0)) / size) * n);
    if (col >= 0 && col < n && row >= 0 && row < n) counts[row * n + col] = (counts[row * n + col] ?? 0) + 1;
  };
  if (only) {
    for (const i of only) add(i);
  } else {
    for (let i = 0; i < sky.count; i++) add(i);
  }
  let values: Float32Array = counts;
  for (let pass = 0; pass < 3; pass++) values = boxBlur(values, n, radius);
  let max = 0;
  for (let i = 0; i < values.length; i++) if ((values[i] ?? 0) > max) max = values[i] ?? 0;
  return { n, values, max };
}

// ---------------------------------------------------------------------------
// Outlines: where a watch's density crosses a level, by marching squares.
// ---------------------------------------------------------------------------

export type Segment = [number, number, number, number];

/**
 * The line segments where `field` crosses `level`, in plate coordinates. Each
 * grid cell contributes at most two segments; the saddle cases split by the
 * cell's mean, as usual.
 */
export function contour(field: Field, level: number, bounds: Sky['bounds']): Segment[] {
  const { n, values } = field;
  const step = bounds.size / n;
  // Cell centers in plate space: column c at minX + (c + 0.5) * step, row r at top - (r + 0.5) * step.
  const px = (c: number) => bounds.minX + (c + 0.5) * step;
  const py = (r: number) => bounds.minY + bounds.size - (r + 0.5) * step;
  const v = (r: number, c: number) => values[r * n + c] ?? 0;
  const lerp = (a: number, b: number) => (a === b ? 0.5 : (level - a) / (b - a));
  const out: Segment[] = [];
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const tl = v(r, c), tr = v(r, c + 1), br = v(r + 1, c + 1), bl = v(r + 1, c);
      const index = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (index === 0 || index === 15) continue;
      const top: [number, number] = [px(c) + lerp(tl, tr) * step, py(r)];
      const right: [number, number] = [px(c + 1), py(r) - lerp(tr, br) * step];
      const bottom: [number, number] = [px(c) + lerp(bl, br) * step, py(r + 1)];
      const left: [number, number] = [px(c), py(r) - lerp(tl, bl) * step];
      const seg = (a: [number, number], b: [number, number]) => out.push([a[0], a[1], b[0], b[1]]);
      const centerHigh = (tl + tr + br + bl) / 4 >= level;
      switch (index) {
        case 1: case 14: seg(left, bottom); break;
        case 2: case 13: seg(bottom, right); break;
        case 3: case 12: seg(left, right); break;
        case 4: case 11: seg(top, right); break;
        case 6: case 9: seg(top, bottom); break;
        case 7: case 8: seg(left, top); break;
        case 5: if (centerHigh) { seg(left, top); seg(bottom, right); } else { seg(left, bottom); seg(top, right); } break;
        case 10: if (centerHigh) { seg(top, right); seg(left, bottom); } else { seg(left, top); seg(bottom, right); } break;
        default: break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constellations: faint lines through a watch's regions.
// ---------------------------------------------------------------------------

/**
 * The minimum spanning tree over points, by straight-line distance (Prim's,
 * fine for the few dozen regions a watch touches). Returns index pairs.
 */
export function spanningTree(points: readonly [number, number][]): [number, number][] {
  const n = points.length;
  if (n < 2) return [];
  const inTree = new Array<boolean>(n).fill(false);
  const best = new Array<number>(n).fill(Infinity);
  const from = new Array<number>(n).fill(-1);
  best[0] = 0;
  const edges: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u === -1 || (best[i] ?? Infinity) < (best[u] ?? Infinity))) u = i;
    if (u === -1) break;
    inTree[u] = true;
    const fu = from[u] ?? -1;
    if (fu >= 0) edges.push([fu, u]);
    const [ux, uy] = points[u] ?? [0, 0];
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      const [ix, iy] = points[i] ?? [0, 0];
      const d = Math.hypot(ix - ux, iy - uy);
      if (d < (best[i] ?? Infinity)) { best[i] = d; from[i] = u; }
    }
  }
  return edges;
}

export interface Watch {
  id: number;
  name: string;
  members: number[];
}

export interface WatchShape {
  id: number;
  name: string;
  outline: Segment[];
  /** Where along its outline the watch's name may sit, each with the way out of the watch. */
  spots: LabelSpot[];
  /** Region centers the watch spans, and the tree through them. */
  stars: [number, number][];
  lines: [number, number][];
}

/**
 * A point on a watch's outline, in plate space, and the unit direction its
 * density falls there (out of the watch). A name set beside its outline, on
 * that side, reads as the region's label without covering the region.
 */
export interface LabelSpot { x: number; y: number; nx: number; ny: number }

/**
 * Up to `most` places spread along an outline. Each one's outward direction is
 * down the slope of the watch's own density, read between grid cells, so it
 * points out of the watch however the outline curves.
 */
export function labelSpots(outline: readonly Segment[], field: Field, bounds: Sky['bounds'], most = 40): LabelSpot[] {
  if (!outline.length || field.max <= 0) return [];
  const { n, values } = field;
  const step = bounds.size / n;
  // The field at a plate point, bilinear between cell centers; row 0 is the top.
  const at = (x: number, y: number) => {
    const fc = Math.min(n - 1, Math.max(0, (x - bounds.minX) / step - 0.5));
    const fr = Math.min(n - 1, Math.max(0, (bounds.minY + bounds.size - y) / step - 0.5));
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const c1 = Math.min(n - 1, c0 + 1), r1 = Math.min(n - 1, r0 + 1);
    const tc = fc - c0, tr = fr - r0;
    const v = (r: number, c: number) => values[r * n + c] ?? 0;
    return (v(r0, c0) * (1 - tc) + v(r0, c1) * tc) * (1 - tr) + (v(r1, c0) * (1 - tc) + v(r1, c1) * tc) * tr;
  };
  const every = Math.max(1, Math.ceil(outline.length / most));
  const spots: LabelSpot[] = [];
  for (let k = Math.floor(every / 2); k < outline.length; k += every) {
    const [x1, y1, x2, y2] = outline[k] ?? [0, 0, 0, 0];
    const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
    // Down the slope: the negative gradient, by central differences one cell apart.
    let nx = at(x - step, y) - at(x + step, y);
    let ny = at(x, y - step) - at(x, y + step);
    const length = Math.hypot(nx, ny);
    if (length === 0) continue;
    nx /= length; ny /= length;
    spots.push({ x, y, nx, ny });
  }
  return spots;
}

/** A label's box in screen pixels: its left, its top, its width and its height. */
export interface Box { x: number; y: number; w: number; h: number }

/**
 * Where a watch's name goes, in screen pixels, or null where it does not fit.
 *
 * It is set just outside its outline, at whichever of `spots` (screen pixels,
 * y down, each with its outward direction) leaves the fewest papers under it,
 * a little in favor of above the line, where a map reader looks for a region's
 * name, and of beside it over below it. A place counts only where `fits` says so (inside the plate, clear of
 * other names, off the watch's own line), and the best of them only when it
 * covers no more than `allowed` papers: a name that would sit across the dots
 * is dropped, as a region's name is where its region has no room.
 */
export function placeName(
  spots: readonly LabelSpot[], width: number, height: number,
  fits: (box: Box) => boolean, papersUnder: (box: Box) => number, allowed: number, gap = 3,
): Box | null {
  let best: Box | null = null;
  let bestScore = Infinity;
  let bestPapers = Infinity;
  for (const spot of spots) {
    // A line of type reads as a boundary's label set level above or below it,
    // centered on the place, or level beside it, starting from the place; set
    // along a slanting direction, a long name drifts away from its line.
    const level = Math.abs(spot.ny) >= 0.45;
    const dx = level ? 0 : Math.sign(spot.nx);
    const dy = level ? Math.sign(spot.ny) : 0;
    const cx = spot.x + dx * (width / 2 + gap);
    const cy = spot.y + dy * (height / 2 + gap);
    const box = { x: cx - width / 2, y: cy - height / 2, w: width, h: height };
    if (!fits(box)) continue;
    const papers = papersUnder(box);
    // Above the line, then beside it, then below: a tie goes up.
    const score = papers + (dy + 1) * 0.25;
    if (score < bestScore) { bestScore = score; bestPapers = papers; best = box; }
  }
  return best && bestPapers <= allowed ? best : null;
}

/**
 * A watch's outline (the level its paper density falls to a fifth of its peak),
 * the places along it its name may sit, and its constellation: the regions
 * holding at least 3% of its papers, joined by their spanning tree.
 */
export function watchShape(sky: Sky, regions: readonly MapRegion[], watch: Watch, n = 96): WatchShape {
  const indices: number[] = [];
  for (const id of watch.members) {
    const i = sky.indexOf.get(id);
    if (i !== undefined) indices.push(i);
  }
  if (indices.length === 0) return { id: watch.id, name: watch.name, outline: [], spots: [], stars: [], lines: [] };
  const field = density(sky, n, 2, indices);
  const outline = field.max > 0 ? contour(field, field.max * 0.2, sky.bounds) : [];
  const spots = labelSpots(outline, field, sky.bounds);

  const perRegion = new Map<number, number>();
  for (const i of indices) perRegion.set(sky.region[i] ?? 0, (perRegion.get(sky.region[i] ?? 0) ?? 0) + 1);
  const byId = new Map(regions.map((r) => [r.id, r]));
  const stars: [number, number][] = [];
  for (const [regionId, count] of perRegion) {
    const region = byId.get(regionId);
    if (region && count >= Math.max(2, indices.length * 0.03)) stars.push([region.x, region.y]);
  }
  // A line across the whole plate joins two regions far apart, which is the
  // opposite of what a constellation line says; it is left out.
  const longest = sky.bounds.size / 3;
  const lines = spanningTree(stars).filter(([a, b]) => {
    const [ax, ay] = stars[a] ?? [0, 0];
    const [bx, by] = stars[b] ?? [0, 0];
    return Math.hypot(ax - bx, ay - by) <= longest;
  });
  return { id: watch.id, name: watch.name, outline, spots, stars, lines };
}
