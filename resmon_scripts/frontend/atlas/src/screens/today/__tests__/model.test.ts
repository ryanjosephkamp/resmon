import { listWords, troubleParts } from '../format';
import {
  GRID, buildSky, contour, density, emptiestCorner, epochDay, gridCell, labelSpots, placeName, rampClass, spanningTree,
  watchShape, type Box, type MapPoints, type MapRegion,
} from '../model';

describe('a run’s sources that did not answer, as one line', () => {
  test('grouped by what happened, each group named once, failures before unknowns', () => {
    const parts = troubleParts([
      { name: 'arXiv', category: 'non_answer', label: 'did not answer' },
      { name: 'DBLP', category: 'non_answer', label: 'could not answer this window' },
      { name: 'Crossref', category: 'unknown', label: 'zero, reason not recorded' },
      { name: 'DOAJ', category: 'non_answer', label: 'did not answer' },
      { name: 'IEEE Xplore', category: 'non_answer', label: 'withdrawn' },
      { name: 'PLOS', category: 'non_answer', label: 'did not answer' },
    ]);
    expect(parts.map((p) => [p.category, p.text])).toEqual([
      ['non_answer', 'arXiv, DOAJ, and PLOS did not answer'],
      ['non_answer', 'DBLP could not answer this window'],
      ['non_answer', 'IEEE Xplore was withdrawn'],
      ['unknown', 'Crossref: zero, reason not recorded'],
    ]);
  });

  test('two names take "and", and one stands alone', () => {
    expect(listWords(['arXiv', 'DOAJ'])).toBe('arXiv and DOAJ');
    expect(listWords(['arXiv'])).toBe('arXiv');
    expect(troubleParts([])).toEqual([]);
  });
});

function sky(points: [number, number][], seen: number[] = points.map(() => 100)) {
  const map: MapPoints = {
    id: points.map((_, i) => i + 1),
    x: points.map(([x]) => x),
    y: points.map(([, y]) => y),
    region: points.map(() => 0),
    seen_day: seen,
  };
  const regions: MapRegion[] = [{ id: 0, label: 'all', terms: [], x: 0, y: 0, r: 1, size: points.length }];
  return buildSky(map, regions, 100);
}

describe('the magnitude ramp', () => {
  test.each([[0, 0], [6, 0], [7, 1], [29, 1], [30, 2], [90, 3], [179, 3], [180, 4], [5000, 4]])(
    'a paper collected %i days ago is class %i', (age, cls) => expect(rampClass(age)).toBe(cls));

  test('ages are counted from the day the plate is drawn', () => {
    const s = sky([[0, 0], [0.1, 0.1]], [100, 60]);
    expect(Array.from(s.ramp)).toEqual([0, 2]);
    expect(epochDay(new Date(Date.UTC(1970, 0, 3, 12)))).toBe(2);
  });
});

describe('grid cells, as the margins letter them', () => {
  const bounds = { minX: -1, minY: -1, size: 2 };
  test('the top-left cell is A1 and the bottom-right H8', () => {
    expect(gridCell(-0.99, 0.99, bounds)).toBe('A1');
    expect(gridCell(0.99, -0.99, bounds)).toBe(`H${GRID}`);
  });
  test('the edges stay on the grid', () => {
    expect(gridCell(1, -1, bounds)).toBe('H8');
    expect(gridCell(-5, 5, bounds)).toBe('A1');
  });
  test('the bounds are square and hold every paper', () => {
    const s = sky([[-0.5, 0.2], [0.9, 0.4], [0.1, -0.3]]);
    const { minX, minY, size } = s.bounds;
    for (let i = 0; i < s.count; i++) {
      expect(s.x[i]!).toBeGreaterThanOrEqual(minX);
      expect(s.x[i]!).toBeLessThanOrEqual(minX + size);
      expect(s.y[i]!).toBeGreaterThanOrEqual(minY);
      expect(s.y[i]!).toBeLessThanOrEqual(minY + size);
    }
  });
});

describe('density and outlines', () => {
  const blob: [number, number][] = [];
  for (let i = 0; i < 200; i++) {
    const angle = (i * 2.399963) % (Math.PI * 2);
    const r = 0.15 * Math.sqrt((i + 0.5) / 200);
    blob.push([0.3 + r * Math.cos(angle), -0.2 + r * Math.sin(angle)]);
  }
  blob.push([-0.9, 0.9], [0.9, 0.9]); // two strays to widen the plate

  test('blurring keeps the mass', () => {
    const s = sky(blob);
    const field = density(s, 64, 2);
    const total = field.values.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(s.count, 0);
  });

  test("a watch's outline closes around its papers", () => {
    const s = sky(blob);
    const shape = watchShape(s, [{ id: 0, label: 'a', terms: [], x: 0.3, y: -0.2, r: 0.2, size: 200 }],
      { id: 1, name: 'Blob', members: Array.from({ length: 200 }, (_, i) => i + 1) }, 64);
    expect(shape.outline.length).toBeGreaterThan(8);
    // Every segment end lies near the blob, and the blob's middle is inside the extent.
    const xs = shape.outline.flatMap(([x1, , x2]) => [x1, x2]);
    const ys = shape.outline.flatMap(([, y1, , y2]) => [y1, y2]);
    expect(Math.min(...xs)).toBeLessThan(0.3);
    expect(Math.max(...xs)).toBeGreaterThan(0.3);
    expect(Math.min(...ys)).toBeLessThan(-0.2);
    expect(Math.max(...ys)).toBeGreaterThan(-0.2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.8);
    // Places for its name lie on the outline, each pointing out of the blob, away from its middle.
    expect(shape.spots.length).toBeGreaterThan(4);
    for (const spot of shape.spots) {
      expect(Math.hypot(spot.nx, spot.ny)).toBeCloseTo(1, 5);
      const out = (spot.x - 0.3) * spot.nx + (spot.y + 0.2) * spot.ny;
      expect(out).toBeGreaterThan(0);
    }
  });

  test('a watch whose papers are not on the plate has no shape', () => {
    const s = sky(blob);
    const shape = watchShape(s, [], { id: 2, name: 'Elsewhere', members: [99999] });
    expect(shape.outline).toEqual([]);
    expect(shape.spots).toEqual([]);
  });

  test('places for a name spread along the outline, a bounded number of them', () => {
    const s = sky(blob);
    const field = density(s, 64, 2);
    const outline = contour(field, field.max * 0.2, s.bounds);
    const spots = labelSpots(outline, field, s.bounds, 12);
    expect(spots.length).toBeGreaterThan(4);
    expect(spots.length).toBeLessThanOrEqual(12);
    expect(labelSpots([], field, s.bounds)).toEqual([]);
  });

  test('contour returns nothing above the peak', () => {
    const s = sky(blob);
    const field = density(s, 32, 1);
    expect(contour(field, field.max * 1.01, s.bounds)).toEqual([]);
  });
});

describe("a watch's name, beside its outline", () => {
  const all = () => true;
  test('it sits outside the line, at the place with the fewest papers beside it', () => {
    // A spot on the top of an outline pointing up, and one on its right pointing right.
    const spots = [{ x: 100, y: 50, nx: 0, ny: -1 }, { x: 200, y: 100, nx: 1, ny: 0 }];
    const crowdedAbove = (box: Box) => (box.y < 50 ? 30 : 0);
    const box = placeName(spots, 80, 16, all, crowdedAbove, 5);
    expect(box).toEqual({ x: 203, y: 92, w: 80, h: 16 });
    // With nothing beside either, above wins: where a reader looks for a region's name.
    expect(placeName([...spots].reverse(), 80, 16, all, () => 0, 5)).toEqual({ x: 60, y: 31, w: 80, h: 16 });
    // Below the line only where it is emptier than above.
    const down = [{ x: 100, y: 50, nx: 0, ny: -1 }, { x: 100, y: 150, nx: 0, ny: 1 }];
    expect(placeName(down, 80, 16, all, (b) => (b.y < 50 ? 4 : 1), 5)?.y).toBe(153);
  });

  test('a name with no place that fits, or none clear of the dots, is not drawn', () => {
    const spots = [{ x: 100, y: 50, nx: 0, ny: -1 }];
    expect(placeName(spots, 80, 16, all, () => 12, 5)).toBeNull();
    expect(placeName(spots, 80, 16, () => false, () => 0, 5)).toBeNull();
    expect(placeName([], 80, 16, all, () => 0, 5)).toBeNull();
  });

});

describe('constellation lines', () => {
  test('a spanning tree joins every star with n - 1 lines, shortest first', () => {
    const stars: [number, number][] = [[0, 0], [1, 0], [2, 0], [2, 1]];
    const edges = spanningTree(stars);
    expect(edges).toHaveLength(3);
    const joined = new Set(edges.flat());
    expect(joined.size).toBe(4);
    // No long diagonal from the first star to the last.
    expect(edges.some(([a, b]) => (a === 0 && b === 3) || (a === 3 && b === 0))).toBe(false);
  });
  test('one star has no lines', () => expect(spanningTree([[0, 0]])).toEqual([]));
});

describe('the title block', () => {
  test('goes to the corner with the fewest papers under it', () => {
    const crowd: [number, number][] = [];
    for (let i = 0; i < 50; i++) crowd.push([0.8 + (i % 5) * 0.03, 0.8 + Math.floor(i / 5) * 0.015]); // top right
    for (let i = 0; i < 20; i++) crowd.push([-0.8 + (i % 5) * 0.03, 0.8 - Math.floor(i / 5) * 0.02]);  // top left
    for (let i = 0; i < 30; i++) crowd.push([0.8 - (i % 5) * 0.03, -0.8 + Math.floor(i / 5) * 0.02]);  // bottom right
    crowd.push([-0.9, -0.9]); // bottom left: one paper
    expect(emptiestCorner(sky(crowd))).toBe('bl');
  });
});

describe("a watch's constellation", () => {
  test('leaves out a line across the plate', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 40; i++) pts.push([-0.9 + (i % 4) * 0.01, -0.9 + Math.floor(i / 4) * 0.01]);
    for (let i = 0; i < 40; i++) pts.push([0.9 - (i % 4) * 0.01, 0.9 - Math.floor(i / 4) * 0.01]);
    const map = { id: pts.map((_, i) => i + 1), x: pts.map(([x]) => x), y: pts.map(([, y]) => y),
      region: pts.map((_, i) => (i < 40 ? 0 : 1)), seen_day: pts.map(() => 100) };
    const regions = [
      { id: 0, label: 'a', terms: [], x: -0.88, y: -0.85, r: 0.1, size: 40 },
      { id: 1, label: 'b', terms: [], x: 0.88, y: 0.85, r: 0.1, size: 40 },
    ];
    const shape = watchShape(buildSky(map, regions, 100), regions, { id: 1, name: 'W', members: map.id });
    expect(shape.stars).toHaveLength(2);
    expect(shape.lines).toEqual([]);
  });
});
