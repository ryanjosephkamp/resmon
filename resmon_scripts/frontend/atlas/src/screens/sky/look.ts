/**
 * How a map looks: which papers are lit, which are dimmed, and what color each
 * lit one takes. Shared by Today's map and a run's.
 *
 * A filtered-out paper is dimmed, never removed, so the shape of the
 * collection stays where it was. Everything here is computed once per change
 * of view, find, or data, as typed arrays over the sky's indices; the draw
 * loop only reads them.
 *
 * The facts come from `/api/map/facets` and are what the database holds: a
 * paper's source, its publication date as stored, when resmon first collected
 * it, its place in the reading queue, whether it is new on Today, and the
 * watches whose runs returned it.
 */
import type { components } from '../../api/schema';
import { RAMP_DAYS, type Sky } from '../today/model';
import { count, number } from '../today/format';

export type Facets = components['schemas']['MapFacets'];
export type MapView = Pick<components['schemas']['MapView'],
  'color' | 'watches' | 'sources' | 'dates' | 'date_from' | 'date_to' | 'state' | 'list_by'>;
export type ColorBy = MapView['color'];
export type StateFilter = MapView['state'];

export const DEFAULT_VIEW: MapView = {
  color: 'region', watches: [], sources: [], dates: 'found', date_from: null, date_to: null, state: 'any', list_by: 'watch',
};

export const COLOR_WORDS: Record<ColorBy, string> = {
  region: 'Region', watch: 'Watch', source: 'Source', age: 'Age',
};

export const STATE_WORDS: Record<StateFilter, string> = {
  any: 'Any', saved: 'In your reading queue', to_read: 'Saved, not yet read', read: 'Read', new: 'New since you last looked',
};

/** The shortest find the engine runs, as `map_facets.FIND_MIN_CHARS` says. */
export const FIND_MIN = 2;

/** A day with no date, in an Int32Array. */
export const NO_DAY = -2_147_483_648;

/** A paper's facts, joined onto a sky's indices. */
export interface Facts {
  /** Index into `sources`, or -1 where the facets did not list the paper. */
  source: Int16Array;
  sources: readonly string[];
  /** Days since 1970-01-01 of the first day its publication date names, or NO_DAY. */
  published: Int32Array;
  /** When resmon first collected it, in Unix seconds; NaN where not recorded. */
  found: Float64Array;
  /** 0 not in the reading queue, 1 saved to read, 2 read. */
  queue: Uint8Array;
  /** 1 where it is new on Today. */
  fresh: Uint8Array;
  /** Every watch, with the sky indices of its papers on this map. */
  watches: { id: number; name: string; members: Int32Array }[];
  window: Facets['window'];
}

export function joinFacts(sky: Sky, facets: Facets): Facts {
  const n = sky.count;
  const source = new Int16Array(n).fill(-1);
  const published = new Int32Array(n).fill(NO_DAY);
  const found = new Float64Array(n).fill(NaN);
  const queue = new Uint8Array(n);
  const fresh = new Uint8Array(n);
  for (let k = 0; k < facets.ids.length; k++) {
    const i = sky.indexOf.get(facets.ids[k] ?? -1);
    if (i === undefined) continue;
    source[i] = facets.source[k] ?? -1;
    published[i] = facets.published_day[k] ?? NO_DAY;
    found[i] = facets.found_at[k] ?? NaN;
  }
  const mark = (ids: readonly number[], into: Uint8Array, value: number) => {
    for (const id of ids) {
      const i = sky.indexOf.get(id);
      if (i !== undefined) into[i] = value;
    }
  };
  mark(facets.saved, queue, 1);
  mark(facets.read, queue, 2);
  mark(facets.new, fresh, 1);
  const watches = facets.watches.map((w) => {
    const members: number[] = [];
    for (const id of w.members) {
      const i = sky.indexOf.get(id);
      if (i !== undefined) members.push(i);
    }
    return { id: w.id, name: w.name, members: Int32Array.from(members) };
  });
  return { source, sources: facets.sources, published, found, queue, fresh, watches, window: facets.window };
}

/** How many filters a view sets. */
export function filterCount(view: MapView): number {
  return Number(view.watches.length > 0) + Number(view.sources.length > 0)
    + Number(!!(view.date_from || view.date_to)) + Number(view.state !== 'any');
}

/** Whether a view can be drawn without the facets. */
export function needsFacts(view: MapView): boolean {
  return filterCount(view) > 0 || view.color === 'watch' || view.color === 'source';
}

/** One entry of the color key: a swatch's CSS color, what it means, and how many lit papers wear it. */
export interface LegendEntry { key: string; label: string; color: string; count: number }

/** The categorical colors, in their fixed order; checked together, for every pair, in both themes. */
export const CATEGORY_COLORS = ['var(--map-1)', 'var(--map-2)', 'var(--map-3)', 'var(--map-4)'] as const;
/** Newest to oldest, one hue. */
export const AGE_COLORS = ['var(--age-0)', 'var(--age-1)', 'var(--age-2)', 'var(--age-3)', 'var(--age-4)'] as const;
const OTHER_COLOR: string = 'var(--ink-2)';
const NONE_COLOR: string = 'var(--ink-3)';

type Keyed = Omit<LegendEntry, 'count'> & { group: number };

export interface Look {
  /** 1 where the paper is lit; null when every paper is. */
  lit: Uint8Array | null;
  /** How many are lit. */
  shown: number;
  /** The color group of each paper, an index into `colors`; null when they all wear the ink. */
  group: Uint8Array | null;
  colors: readonly string[];
  legend: LegendEntry[];
  /** The find's matches on this map, as sky indices, in the order Enter steps through them. */
  found: Int32Array;
  /** Matches the filters dim, which Enter does not step to. */
  foundDimmed: number;
  /** The view needs the facets, and they have not been read yet: everything is lit meanwhile. */
  waiting: boolean;
}

/** Local midnight of a `YYYY-MM-DD`, in Unix seconds. */
function localDay(day: string, end: boolean): number {
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + (end ? 1 : 0));
  return at.getTime() / 1000 - (end ? 0.001 : 0);
}

/** A `YYYY-MM-DD` as days since 1970-01-01, the calendar date as written. */
export function calendarDay(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/**
 * Which papers a view lights. A watch or a source the view names that is not
 * on this map is left out of the test, so a view kept from another map never
 * leaves this one dark for a reason it cannot show.
 */
export function litBy(sky: Sky, facts: Facts, view: MapView): { lit: Uint8Array | null; shown: number } {
  if (filterCount(view) === 0) return { lit: null, shown: sky.count };
  const n = sky.count;
  const lit = new Uint8Array(n).fill(1);
  const chosen = new Set(view.watches);
  const watches = facts.watches.filter((w) => chosen.has(w.id));
  if (watches.length > 0) {
    const inWatch = new Uint8Array(n);
    for (const w of watches) for (const i of w.members) inWatch[i] = 1;
    for (let i = 0; i < n; i++) if (!inWatch[i]) lit[i] = 0;
  }
  const sources = new Set(view.sources.map((slug) => facts.sources.indexOf(slug)).filter((k) => k >= 0));
  if (sources.size > 0) {
    for (let i = 0; i < n; i++) if (!sources.has(facts.source[i] ?? -1)) lit[i] = 0;
  }
  if (view.date_from || view.date_to) {
    // A paper with no date of that kind cannot be said to fall in the range.
    if (view.dates === 'found') {
      const from = view.date_from ? localDay(view.date_from, false) : -Infinity;
      const to = view.date_to ? localDay(view.date_to, true) : Infinity;
      for (let i = 0; i < n; i++) {
        const at = facts.found[i] ?? NaN;
        if (!(at >= from && at <= to)) lit[i] = 0;
      }
    } else {
      const from = view.date_from ? calendarDay(view.date_from) : -Infinity;
      const to = view.date_to ? calendarDay(view.date_to) : Infinity;
      for (let i = 0; i < n; i++) {
        const day = facts.published[i] ?? NO_DAY;
        if (day === NO_DAY || day < from || day > to) lit[i] = 0;
      }
    }
  }
  if (view.state !== 'any') {
    const keep = (i: number) => {
      const q = facts.queue[i] ?? 0;
      switch (view.state) {
        case 'saved': return q > 0;
        case 'to_read': return q === 1;
        case 'read': return q === 2;
        case 'new': return facts.fresh[i] === 1;
        default: return true;
      }
    };
    for (let i = 0; i < n; i++) if (!keep(i)) lit[i] = 0;
  }
  let shown = 0;
  for (let i = 0; i < n; i++) shown += lit[i] ?? 0;
  return { lit, shown };
}

/**
 * Each paper's color group under a view, and the key that names them.
 *
 * Watches and sources get the four categorical colors by how many papers each
 * has on this map, largest first, and keep them whatever the filters do, so a
 * filter never repaints a paper. A paper two colored watches found wears the
 * larger one's color. The rest are named together in a neutral.
 */
export function colorsBy(sky: Sky, facts: Facts | null, color: ColorBy, names: (slug: string) => string,
): { group: Uint8Array | null; colors: string[]; legend: Keyed[] } {
  const n = sky.count;
  if (color === 'region') return { group: null, colors: [], legend: [] };
  if (color === 'age') {
    const group = new Uint8Array(n);
    for (let i = 0; i < n; i++) group[i] = sky.ramp[i] ?? 0;
    const labels = RAMP_DAYS.map((days, k) => {
      const next = RAMP_DAYS[k + 1];
      if (k === 0) return `Collected in the last ${next} days`;
      return next === undefined ? `${number(days)} days ago or more` : `${days} to ${next} days ago`;
    });
    return {
      group, colors: [...AGE_COLORS],
      legend: labels.map((label, k) => ({ key: `age:${k}`, label, color: AGE_COLORS[k] ?? NONE_COLOR, group: k })),
    };
  }
  if (!facts) return { group: null, colors: [], legend: [] };
  const group = new Uint8Array(n);
  if (color === 'watch') {
    const ranked = [...facts.watches].filter((w) => w.members.length > 0)
      .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
    const top = ranked.slice(0, CATEGORY_COLORS.length);
    const OTHER = top.length, NONE = top.length + 1;
    group.fill(NONE);
    for (const w of ranked.slice(top.length)) for (const i of w.members) group[i] = OTHER;
    // Smallest first, so a paper in two colored watches ends with the larger's color.
    for (let k = top.length - 1; k >= 0; k--) for (const i of top[k]?.members ?? []) group[i] = k;
    const legend: Keyed[] = top.map((w, k) => ({
      key: `watch:${w.id}`, label: w.name, color: CATEGORY_COLORS[k] ?? NONE_COLOR, group: k,
    }));
    if (ranked.length > top.length) legend.push({ key: 'watch:other', label: 'Other watches', color: OTHER_COLOR, group: OTHER });
    legend.push({ key: 'watch:none', label: 'No watch: your own searches', color: NONE_COLOR, group: NONE });
    return { group, colors: [...top.map((_, k) => CATEGORY_COLORS[k] ?? NONE_COLOR), OTHER_COLOR, NONE_COLOR], legend };
  }
  // Sources.
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const s = facts.source[i] ?? -1;
    if (s >= 0) sizes.set(s, (sizes.get(s) ?? 0) + 1);
  }
  const ranked = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([s]) => s);
  const top = ranked.slice(0, CATEGORY_COLORS.length);
  const OTHER = top.length;
  const slot = new Map(top.map((s, k) => [s, k]));
  for (let i = 0; i < n; i++) group[i] = slot.get(facts.source[i] ?? -1) ?? OTHER;
  const legend: Keyed[] = top.map((s, k) => ({
    key: `source:${facts.sources[s] ?? s}`, label: names(facts.sources[s] ?? ''), color: CATEGORY_COLORS[k] ?? NONE_COLOR,
    group: k,
  }));
  if (ranked.length > top.length) legend.push({ key: 'source:other', label: 'Another source', color: OTHER_COLOR, group: OTHER });
  return { group, colors: [...top.map((_, k) => CATEGORY_COLORS[k] ?? NONE_COLOR), OTHER_COLOR], legend };
}

/**
 * The whole look: lit by the filters (and the find, while there is one), and
 * colored by the view. `matches` are the find's ids, newest first, or null
 * when nothing is being found.
 */
export function lookOf(sky: Sky, facts: Facts | null, view: MapView, matches: readonly number[] | null,
  names: (slug: string) => string): Look {
  const waiting = needsFacts(view) && !facts;
  const filtered = facts && !waiting ? litBy(sky, facts, view) : { lit: null, shown: sky.count };
  const colored = colorsBy(sky, facts, view.color, names);
  let lit = filtered.lit;
  let shown = filtered.shown;
  const found: number[] = [];
  let foundDimmed = 0;
  if (matches) {
    const next = new Uint8Array(sky.count);
    for (const id of matches) {
      const i = sky.indexOf.get(id);
      if (i === undefined) continue;
      if (filtered.lit && !filtered.lit[i]) { foundDimmed++; continue; }
      next[i] = 1;
      found.push(i);
    }
    lit = next;
    shown = found.length;
  }
  const legendCounts = new Map<number, number>();
  if (colored.group) {
    for (let i = 0; i < sky.count; i++) {
      if (lit && !lit[i]) continue;
      const g = colored.group[i] ?? 0;
      legendCounts.set(g, (legendCounts.get(g) ?? 0) + 1);
    }
  }
  const legend = colored.legend.map(({ group, ...entry }) => ({ ...entry, count: legendCounts.get(group) ?? 0 }));
  return { lit, shown, group: colored.group, colors: colored.colors, legend, found: Int32Array.from(found), foundDimmed, waiting };
}

/** "Showing 1,204 of 98,311 papers", or "All 98,311 papers". */
export function shownWords(look: Look, total: number, finding: boolean): string {
  if (finding) {
    const base = look.shown === 0 ? 'No paper on this map matches' : `${count(look.shown, 'paper')} ${look.shown === 1 ? 'matches' : 'match'}`;
    return look.foundDimmed > 0 ? `${base}; ${number(look.foundDimmed)} more ${look.foundDimmed === 1 ? 'is' : 'are'} dimmed by the filters` : base;
  }
  if (look.lit === null) return `All ${count(total, 'paper')} shown`;
  return `Showing ${number(look.shown)} of ${count(total, 'paper')}`;
}
