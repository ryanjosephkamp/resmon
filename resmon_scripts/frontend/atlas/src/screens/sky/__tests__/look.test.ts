import { buildSky, subSky, type MapPoints, type MapRegion } from '../../today/model';
import { paintOrder } from '../../today/Plate';
import { placementWords } from '../../runs/RunMap';
import {
  DEFAULT_VIEW, NO_DAY, calendarDay, colorsBy, filterCount, joinFacts, litBy, lookOf, needsFacts, shownWords,
  type Facets, type MapView,
} from '../look';
import { arxivPdf, webLink } from '../MapPaper';

/** Six papers, ids 11 to 16, in two regions; collected 0, 3, 10, 40, 100, and 400 days before day 1000. */
function points(): MapPoints {
  return {
    id: [11, 12, 13, 14, 15, 16],
    x: [0, 0.1, 0.2, 0.6, 0.7, 0.8],
    y: [0, 0.1, 0, 0.6, 0.7, 0.6],
    region: [0, 0, 0, 1, 1, 1],
    seen_day: [1000, 997, 990, 960, 900, 600],
  };
}
const REGIONS: MapRegion[] = [
  { id: 0, label: 'protein folding', terms: [], x: 0.1, y: 0.05, r: 0.3, size: 3 },
  { id: 1, label: 'traffic flow', terms: [], x: 0.7, y: 0.65, r: 0.3, size: 3 },
];

function facets(): Facets {
  const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
  const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime() / 1000;
  return {
    // A paper the map does not hold (99) is in the facets and is left out of the join.
    ids: [11, 12, 13, 14, 15, 16, 99],
    source: [0, 0, 1, 1, 2, 0, 1],
    sources: ['arxiv', 'crossref', 'dblp'],
    published_day: [day('2024-03-15'), null, day('2023-01-01'), day('2024-06-01'), null, day('2025-01-01'), null],
    found_at: [local(2026, 10, 30), local(2026, 10, 27), local(2026, 10, 20), local(2026, 9, 30), local(2026, 8, 1),
      local(2025, 9, 1), null],
    saved: [12],
    read: [14],
    since: '2026-10-29T12:00:00Z',
    window: 'since_last_look',
    new: [11, 99],
    watches: [
      { id: 1, name: 'Protein structure', is_active: true, members: [11, 12, 13] },
      { id: 2, name: 'Traffic', is_active: true, members: [13, 14, 15, 99] },
      { id: 3, name: 'Paused', is_active: false, members: [] },
    ],
  } as Facets;
}

const sky = () => buildSky(points(), REGIONS, 1000);
const names = (slug: string) => ({ arxiv: 'arXiv', crossref: 'Crossref', dblp: 'DBLP' } as Record<string, string>)[slug] ?? slug;
const lit = (look: { lit: Uint8Array | null }) => (look.lit ? Array.from(look.lit) : null);
const view = (change: Partial<MapView>): MapView => ({ ...DEFAULT_VIEW, ...change });

describe('the facets, joined onto the map', () => {
  test('each paper takes its own facts, and a paper the map does not hold is left out', () => {
    const facts = joinFacts(sky(), facets());
    expect(Array.from(facts.source)).toEqual([0, 0, 1, 1, 2, 0]);
    expect(facts.published[1]).toBe(NO_DAY);
    expect(Array.from(facts.queue)).toEqual([0, 1, 0, 2, 0, 0]);
    expect(Array.from(facts.fresh)).toEqual([1, 0, 0, 0, 0, 0]);
    expect(facts.watches.map((w) => Array.from(w.members))).toEqual([[0, 1, 2], [2, 3, 4], []]);
  });
});

describe('what the filters light', () => {
  const facts = joinFacts(sky(), facets());

  test('no filter lights everything, and needs no facets unless the colors do', () => {
    expect(litBy(sky(), facts, DEFAULT_VIEW)).toEqual({ lit: null, shown: 6 });
    expect(needsFacts(DEFAULT_VIEW)).toBe(false);
    expect(needsFacts(view({ color: 'age' }))).toBe(false);
    expect(needsFacts(view({ color: 'source' }))).toBe(true);
    expect(filterCount(view({ watches: [1], state: 'read', date_to: '2026-01-01' }))).toBe(3);
  });

  test('watches and sources each light any of those chosen, and the two together light both', () => {
    expect(lit(litBy(sky(), facts, view({ watches: [1] })))).toEqual([1, 1, 1, 0, 0, 0]);
    expect(lit(litBy(sky(), facts, view({ watches: [1, 2] })))).toEqual([1, 1, 1, 1, 1, 0]);
    expect(lit(litBy(sky(), facts, view({ sources: ['crossref', 'dblp'] })))).toEqual([0, 0, 1, 1, 1, 0]);
    expect(litBy(sky(), facts, view({ watches: [2], sources: ['crossref'] })).shown).toBe(2);
  });

  test('a watch or a source this map does not have is not a filter here', () => {
    expect(litBy(sky(), facts, view({ watches: [404] })).shown).toBe(6);
    expect(litBy(sky(), facts, view({ sources: ['zenodo'] })).shown).toBe(6);
  });

  test('a publication range dims papers with no publication date, and reads the date as written', () => {
    expect(calendarDay('1970-01-02')).toBe(1);
    expect(lit(litBy(sky(), facts, view({ dates: 'published', date_from: '2024-01-01', date_to: '2024-12-31' }))))
      .toEqual([1, 0, 0, 1, 0, 0]);
    expect(lit(litBy(sky(), facts, view({ dates: 'published', date_to: '2024-03-15' })))).toEqual([1, 0, 1, 0, 0, 0]);
  });

  test('a found range counts whole days on this computer’s clock, both ends included', () => {
    expect(lit(litBy(sky(), facts, view({ dates: 'found', date_from: '2026-10-27', date_to: '2026-10-30' }))))
      .toEqual([1, 1, 0, 0, 0, 0]);
    expect(lit(litBy(sky(), facts, view({ dates: 'found', date_from: '2026-10-28' })))).toEqual([1, 0, 0, 0, 0, 0]);
  });

  test('your reading: saved is either status, and new is Today’s', () => {
    expect(lit(litBy(sky(), facts, view({ state: 'saved' })))).toEqual([0, 1, 0, 1, 0, 0]);
    expect(lit(litBy(sky(), facts, view({ state: 'to_read' })))).toEqual([0, 1, 0, 0, 0, 0]);
    expect(lit(litBy(sky(), facts, view({ state: 'read' })))).toEqual([0, 0, 0, 1, 0, 0]);
    expect(lit(litBy(sky(), facts, view({ state: 'new' })))).toEqual([1, 0, 0, 0, 0, 0]);
  });
});

describe('what the colors mean', () => {
  const facts = joinFacts(sky(), facets());

  test('by region the papers wear one ink, and by age the ramp’s five classes', () => {
    expect(colorsBy(sky(), facts, 'region', names).group).toBeNull();
    const age = colorsBy(sky(), null, 'age', names);
    expect(Array.from(age.group ?? [])).toEqual([0, 0, 1, 2, 3, 4]);
    expect(age.legend.map((l) => l.label)).toEqual([
      'Collected in the last 7 days', '7 to 30 days ago', '30 to 90 days ago', '90 to 180 days ago', '180 days ago or more',
    ]);
  });

  test('by watch: the larger watch’s color for a paper in two, and papers no watch found named as such', () => {
    const watch = colorsBy(sky(), facts, 'watch', names);
    // Both watches have three papers here; the tie goes by name, so Protein structure is first.
    expect(Array.from(watch.group ?? [])).toEqual([0, 0, 0, 1, 1, 3]);
    expect(watch.legend.map((l) => l.label)).toEqual(['Protein structure', 'Traffic', 'No watch: your own searches']);
    expect(watch.colors[3]).toBe('var(--ink-3)');
  });

  test('by source, largest first, each named as the catalog names it', () => {
    const source = colorsBy(sky(), facts, 'source', names);
    expect(Array.from(source.group ?? [])).toEqual([0, 0, 1, 1, 2, 0]);
    expect(source.legend.map((l) => l.label)).toEqual(['arXiv', 'Crossref', 'DBLP']);
  });

  test('a filter never repaints a paper: colors follow the entity, and the key counts the lit', () => {
    const all = lookOf(sky(), facts, view({ color: 'source' }), null, names);
    const some = lookOf(sky(), facts, view({ color: 'source', watches: [2] }), null, names);
    expect(Array.from(some.group ?? [])).toEqual(Array.from(all.group ?? []));
    expect(all.legend.map((l) => l.count)).toEqual([3, 2, 1]);
    expect(some.legend.map((l) => l.count)).toEqual([0, 2, 1]);
  });
});

describe('the find', () => {
  const facts = joinFacts(sky(), facets());

  test('lights its matches on this map in the engine’s order, and counts those the filters dim', () => {
    const look = lookOf(sky(), facts, view({ watches: [1] }), [15, 12, 99, 11], names);
    expect(Array.from(look.found)).toEqual([1, 0]);
    expect(look.foundDimmed).toBe(1);
    expect(lit(look)).toEqual([1, 1, 0, 0, 0, 0]);
    expect(shownWords(look, 6, true)).toBe('2 papers match; 1 more is dimmed by the filters');
  });

  test('says when nothing matches, and how many are shown otherwise', () => {
    expect(shownWords(lookOf(sky(), null, DEFAULT_VIEW, [], names), 6, true)).toBe('No paper on this map matches');
    expect(shownWords(lookOf(sky(), null, DEFAULT_VIEW, null, names), 6, false)).toBe('All 6 papers shown');
    expect(shownWords(lookOf(sky(), facts, view({ state: 'saved' }), null, names), 6, false)).toBe('Showing 2 of 6 papers');
  });

  test('waits for the facets a view needs, lighting everything meanwhile', () => {
    const look = lookOf(sky(), null, view({ watches: [1] }), null, names);
    expect(look.waiting).toBe(true);
    expect(look.lit).toBeNull();
  });
});

describe('the draw order', () => {
  test('dimmed papers first, then the lit oldest first, one run per class and color', () => {
    const s = sky();
    const { order, spans } = paintOrder(s, Uint8Array.from([1, 1, 0, 1, 1, 1]), Uint8Array.from([0, 1, 0, 0, 1, 0]), 2);
    expect(order.length).toBe(6);
    expect(new Set(order).size).toBe(6);
    expect(spans[0]).toMatchObject({ dim: true, cls: 1 });
    expect(order[spans[0]?.start ?? 0]).toBe(2);
    const lit = spans.filter((span) => !span.dim);
    expect(lit.map((span) => span.cls)).toEqual([...lit.map((span) => span.cls)].sort((a, b) => b - a));
    expect(lit[lit.length - 1]).toMatchObject({ cls: 0 });
  });

  test('with no look, every paper is lit in one ink, by class', () => {
    const { spans } = paintOrder(sky(), null, null, 0);
    expect(spans.every((span) => !span.dim && span.group === 0)).toBe(true);
    expect(spans.reduce((n, span) => n + span.end - span.start, 0)).toBe(6);
  });
});

describe('a run’s own map', () => {
  test('only its papers, at the whole map’s positions, framed to them', () => {
    const { sky: run, regions } = subSky(points(), REGIONS, [14, 15, 16, 404], 1000);
    expect(Array.from(run.ids)).toEqual([14, 15, 16]);
    expect(run.x[0]).toBeCloseTo(0.6);
    expect(run.bounds.minX).toBeGreaterThan(0.4);
    expect(run.bounds.size).toBeLessThan(0.5);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ id: 1, label: 'traffic flow', size: 3 });
    expect(regions[0]?.x).toBeCloseTo(0.7);
  });

  test('a handful of papers close together is not magnified past the least frame', () => {
    const { sky: run } = subSky(points(), REGIONS, [11, 12], 1000, 0.5);
    expect(run.bounds.size).toBe(0.5);
  });

  test('says how many are placed, and why the rest are not, in the map’s own basis', () => {
    const map = { state: 'ready', basis: 'words', error: null } as Parameters<typeof placementWords>[0];
    expect(placementWords(map, 18, 15)).toMatchObject({
      sentence: '15 of the 18 papers this run stored are on the map.',
      unplaced: '3 are not: they have too little text in their titles and abstracts to place by wording. They are still in the Papers tab.',
    });
    expect(placementWords({ ...map!, basis: 'embeddings' }, 2, 1).unplaced)
      .toBe('1 is not: your embedding model has not read them yet, or they have too little text to place. It is still in the Papers tab.');
    expect(placementWords(map, 4, 4)).toMatchObject({ sentence: 'All 4 papers this run stored are on the map.', unplaced: null });
    expect(placementWords(map, 0, 0).sentence).toBe('This run stored no papers that are still in your collection.');
  });
});

describe('a paper’s links', () => {
  test('only web addresses are links, and a PDF is offered only where arXiv serves one', () => {
    expect(webLink('javascript:alert(1)')).toBeNull();
    expect(webLink('not a url')).toBeNull();
    expect(webLink('https://doi.org/10.1/x')).toBe('https://doi.org/10.1/x');
    expect(arxivPdf('http://arxiv.org/abs/2401.01234v2')).toBe('https://arxiv.org/pdf/2401.01234v2');
    expect(arxivPdf('https://arxiv.org/abs/hep-th/9901001v1')).toBe('https://arxiv.org/pdf/hep-th/9901001v1');
    expect(arxivPdf('https://example.org/abs/2401.01234')).toBeNull();
    expect(arxivPdf(null)).toBeNull();
  });
});
