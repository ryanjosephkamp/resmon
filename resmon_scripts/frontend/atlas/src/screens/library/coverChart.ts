/**
 * A paper's piece of the night chart, for its cover: the stretch of the
 * collection's map around it, with its grid, its lettered and numbered
 * margins, its neighbors, its region's name and the paper itself crossed.
 *
 * Every mark is the map's own (`/api/map`, as Today draws it): nothing here
 * is decoration, and a paper the map has not placed has no crop at all. The
 * map is read once per gallery; the stars are bucketed once per map, so a
 * cover reads only the buckets its window touches, and its neighbors are
 * drawn as one path per brightness, not one element per star.
 */
import { GRID, GRID_LETTERS, gridCell, RAMP_DAYS, type MapRegion, type Sky } from '../today/model';

/** The crop's own drawing: a 240 by 150 frame, its neat line inset as the comps draw it. */
export const VIEW = { width: 240, height: 150, left: 14, top: 13, inner: 218, innerHeight: 129 } as const;
/** How much of the plate's side a crop shows: 160 of 720, about a cell and three quarters. */
const SHARE = 160 / 720;
/** Stars past this in one crop are left out, faintest first: a cover is a picture, not the map. */
const MOST_STARS = 900;
const BUCKETS = 64;

export interface CropStar { x: number; y: number; r: number }
export interface Crop {
  /** One path a brightness class, newest first, as the ramp orders them. */
  stars: { d: string; opacity: number }[];
  grid: { x: number[]; y: number[] };
  /** Regions near the crop, as soft disks: where the map's papers gather. */
  glows: { x: number; y: number; r: number }[];
  /** The paper's region's name, where it can be set inside the frame. */
  label: { x: number; y: number; text: string } | null;
  /** The paper, in the frame's own units. */
  at: { x: number; y: number };
  /** The margins' letters and numbers the crop shows, and which name the paper's cell. */
  columns: { x: number; text: string; here: boolean }[];
  rows: { y: number; text: string; here: boolean }[];
  cell: string;
}

interface Index { sky: Sky; buckets: Int32Array[] }
const indexes = new WeakMap<Sky, Index>();

/** Plate units: 0 to 1 across, and 0 to 1 down from the top, as the margins are read. */
function unit(sky: Sky, i: number): [number, number] {
  const { minX, minY, size } = sky.bounds;
  return [((sky.x[i] ?? 0) - minX) / size, (minY + size - (sky.y[i] ?? 0)) / size];
}

function index(sky: Sky): Index {
  let found = indexes.get(sky);
  if (found) return found;
  const lists: number[][] = Array.from({ length: BUCKETS * BUCKETS }, () => []);
  for (let i = 0; i < sky.count; i += 1) {
    const [u, v] = unit(sky, i);
    const bx = Math.min(BUCKETS - 1, Math.max(0, Math.floor(u * BUCKETS)));
    const by = Math.min(BUCKETS - 1, Math.max(0, Math.floor(v * BUCKETS)));
    lists[by * BUCKETS + bx]!.push(i);
  }
  found = { sky, buckets: lists.map((l) => Int32Array.from(l)) };
  indexes.set(sky, found);
  return found;
}

const RADIUS = [1.55, 1.25, 1.0, 0.8, 0.62];
const OPACITY = [1, 0.82, 0.62, 0.46, 0.32];

/** The crop around one paper, or null when the map has not placed it. */
export function cropFor(sky: Sky, regions: readonly MapRegion[], documentId: number): Crop | null {
  const at = sky.indexOf.get(documentId);
  if (at === undefined) return null;
  const { left: L, top: T, inner: W, innerHeight: H } = VIEW;
  const ww = SHARE;
  const wh = (ww * H) / W;
  const [pu, pv] = unit(sky, at);
  const u0 = Math.max(0, Math.min(1 - ww, pu - ww * 0.46));
  const v0 = Math.max(0, Math.min(1 - wh, pv - wh * 0.55));
  const k = W / ww;
  const X = (u: number) => L + (u - u0) * k;
  const Y = (v: number) => T + (v - v0) * k;

  const { buckets } = index(sky);
  const bx0 = Math.max(0, Math.floor(u0 * BUCKETS) - 1), bx1 = Math.min(BUCKETS - 1, Math.floor((u0 + ww) * BUCKETS) + 1);
  const by0 = Math.max(0, Math.floor(v0 * BUCKETS) - 1), by1 = Math.min(BUCKETS - 1, Math.floor((v0 + wh) * BUCKETS) + 1);
  const found: { x: number; y: number; ramp: number }[] = [];
  for (let by = by0; by <= by1; by += 1) {
    for (let bx = bx0; bx <= bx1; bx += 1) {
      for (const i of buckets[by * BUCKETS + bx]!) {
        if (i === at) continue;
        const [u, v] = unit(sky, i);
        if (u < u0 - 0.004 || u > u0 + ww + 0.004 || v < v0 - 0.004 || v > v0 + wh + 0.004) continue;
        found.push({ x: X(u), y: Y(v), ramp: sky.ramp[i] ?? 0 });
      }
    }
  }
  if (found.length > MOST_STARS) {
    // Keep the brightest, then a stable even spread of the rest: the same cover every time.
    found.sort((a, b) => a.ramp - b.ramp || a.x - b.x || a.y - b.y);
    found.length = MOST_STARS;
  }
  const paths = RAMP_DAYS.map(() => [] as string[]);
  for (const s of found) {
    const r = RADIUS[s.ramp] ?? 0.62;
    paths[s.ramp]?.push(`M${(s.x - r).toFixed(1)} ${s.y.toFixed(1)}a${r} ${r} 0 1 0 ${(2 * r).toFixed(2)} 0a${r} ${r} 0 1 0 ${(-2 * r).toFixed(2)} 0`);
  }
  const stars = paths.map((d, i) => ({ d: d.join(''), opacity: OPACITY[i] ?? 0.3 })).filter((p) => p.d);

  const grid = { x: [] as number[], y: [] as number[] };
  for (let g = 1; g < GRID; g += 1) {
    const at8 = g / GRID;
    if (at8 > u0 && at8 < u0 + ww) grid.x.push(X(at8));
    if (at8 > v0 && at8 < v0 + wh) grid.y.push(Y(at8));
  }
  const { minX, minY, size } = sky.bounds;
  const regionUnit = (r: MapRegion): [number, number, number] => [(r.x - minX) / size, (minY + size - r.y) / size, r.r / size];
  const glows: Crop['glows'] = [];
  for (const r of regions) {
    const [u, v, rr] = regionUnit(r);
    if (u + rr * 2 < u0 || u - rr * 2 > u0 + ww || v + rr * 2 < v0 || v - rr * 2 > v0 + wh) continue;
    glows.push({ x: X(u), y: Y(v), r: Math.max(8, rr * 1.6 * k) });
  }
  const own = regions.find((r) => r.id === sky.region[at]);
  let label: Crop['label'] = null;
  if (own?.label) {
    const [u, v, rr] = regionUnit(own);
    const lx = Math.max(L + 6, Math.min(L + W - 6 - own.label.length * 4.4, X(u) - own.label.length * 2.2));
    const ly = Math.max(T + 12, Math.min(T + H - 8, Y(v) + rr * k * 0.9 + 10));
    label = { x: lx, y: ly, text: own.label };
  }
  const px = sky.x[at] ?? 0, py = sky.y[at] ?? 0;
  const cell = gridCell(px, py, sky.bounds);
  const columns: Crop['columns'] = [];
  const rows: Crop['rows'] = [];
  for (let c = 0; c < GRID; c += 1) {
    const a = Math.max(u0, c / GRID), b = Math.min(u0 + ww, (c + 1) / GRID);
    if ((b - a) * k > 14) columns.push({ x: X((a + b) / 2), text: GRID_LETTERS[c]!, here: cell[0] === GRID_LETTERS[c] });
  }
  for (let r = 0; r < GRID; r += 1) {
    const a = Math.max(v0, r / GRID), b = Math.min(v0 + wh, (r + 1) / GRID);
    if ((b - a) * k > 12) rows.push({ y: Y((a + b) / 2), text: String(r + 1), here: cell.slice(1) === String(r + 1) });
  }
  return { stars, grid, glows, label, at: { x: X(pu), y: Y(pv) }, columns, rows, cell };
}
