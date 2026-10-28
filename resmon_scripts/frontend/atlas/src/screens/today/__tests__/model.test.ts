import {
  GRID, buildSky, contour, density, emptiestCorner, epochDay, gridCell, rampClass, spanningTree, watchShape,
  type MapPoints, type MapRegion,
} from '../model';

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
    expect(shape.labelAt![1]).toBeGreaterThan(-0.2);
  });

  test('a watch whose papers are not on the plate has no shape', () => {
    const s = sky(blob);
    const shape = watchShape(s, [], { id: 2, name: 'Elsewhere', members: [99999] });
    expect(shape.outline).toEqual([]);
    expect(shape.labelAt).toBeNull();
  });

  test('contour returns nothing above the peak', () => {
    const s = sky(blob);
    const field = density(s, 32, 1);
    expect(contour(field, field.max * 1.01, s.bounds)).toEqual([]);
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
