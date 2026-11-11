import type { MapRegion, Sky } from '../today/model';
import './regionColors.css';

export const REGION_COLORS = Array.from({ length: 6 }, (_, i) => `var(--region-${i + 1})`);
export interface RegionChoice { id: number; label: string; count: number; color: string }
const cached = new WeakMap<Sky, ReturnType<typeof makeColors>>();

/**
 * The Gabriel neighborhood graph joins two centers when the disk with their
 * connecting line as its diameter contains no third center. Unlike assigning colors by region number, coloring this
 * neighborhood graph separates spatial neighbors, while letting distant regions
 * reuse a palette. A smallest-degree ordering assigns the six colors before reusing one.
 */
function makeColors(sky: Sky) {
  const sums = new Map<number, { x: number; y: number; n: number }>();
  for (let i = 0; i < sky.count; i++) {
    const id = sky.region[i]!;
    const s = sums.get(id) ?? { x: 0, y: 0, n: 0 };
    s.x += sky.x[i]!; s.y += sky.y[i]!; s.n++;
    sums.set(id, s);
  }
  const named = new Map((sky.regions ?? []).map((r) => [r.id, r]));
  const regions: MapRegion[] = [...sums].sort(([a], [b]) => a - b).map(([id, s]) => named.get(id)
    ?? { id, label: `Region ${id + 1}`, terms: [], x: s.x / s.n, y: s.y / s.n, size: s.n, r: 0 });
  const n = regions.length;
  const distances = regions.map((a) => regions.map((b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2));
  const neighbors = regions.map(() => new Set<number>());
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    const apart = distances[a]![b]!;
    let separated = false;
    for (let c = 0; c < n; c++) {
      if (c !== a && c !== b && distances[a]![c]! + distances[b]![c]! < apart - 1e-12) { separated = true; break; }
    }
    if (!separated) { neighbors[a]!.add(b); neighbors[b]!.add(a); }
  }
  const remaining = new Set(regions.map((_, i) => i));
  const order: number[] = [];
  while (remaining.size) {
    let best = -1, degree = Infinity;
    for (const i of remaining) {
      const d = [...neighbors[i]!].filter((j) => remaining.has(j)).length;
      if (d < degree) { best = i; degree = d; }
    }
    remaining.delete(best); order.push(best);
  }
  const assignments = new Map<number, number>();
  for (const i of order.reverse()) {
    const used = new Set([...neighbors[i]!].map((j) => assignments.get(j)));
    assignments.set(i, REGION_COLORS.findIndex((_, c) => !used.has(c)));
  }
  const byId = new Map(regions.map((r, i) => [r.id, Math.max(0, assignments.get(i) ?? 0)]));
  const group = Uint8Array.from(sky.region, (id) => byId.get(id) ?? 0);
  const choices: RegionChoice[] = regions.map((r) => ({ id: r.id, label: r.label || `Region ${r.id + 1}`,
    count: sums.get(r.id)?.n ?? 0, color: REGION_COLORS[byId.get(r.id) ?? 0]! }));
  return { group, choices };
}

export function regionColors(sky: Sky) {
  let found = cached.get(sky);
  if (!found) { found = makeColors(sky); cached.set(sky, found); }
  return found;
}
