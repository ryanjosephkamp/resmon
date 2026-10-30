import type { components } from '../../api/schema';
import { count, number } from '../today/format';

/**
 * What narrows Search › Your collection, held in the address: `?source=`,
 * `?category=` and `?author=` (each may repeat), and `?from=` and `?to=` (a
 * publication date, `YYYY-MM-DD`, either end inclusive). A chart's link on
 * Analytics writes the same keys, so arriving from one is the same state as
 * ticking it here, and Back undoes a change.
 *
 * Within a group the values widen (papers from arXiv or from Crossref); the
 * groups narrow each other (from arXiv and in cs.LG), as the engine's
 * `/api/explorer/search` applies them.
 */
export interface Filters {
  sources: string[];
  categories: string[];
  authors: string[];
  from: string;
  to: string;
}

export type FacetKey = 'source' | 'category' | 'author';
export type DateKey = 'from' | 'to';
export type Ranking = 'newest' | 'similarity';

const FILTER_KEYS = ['source', 'category', 'author', 'from', 'to'] as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function listed(params: URLSearchParams, key: FacetKey): string[] {
  return [...new Set(params.getAll(key).map((v) => v.trim()).filter(Boolean))];
}

function day(params: URLSearchParams, key: DateKey): string {
  const value = params.get(key)?.trim() ?? '';
  return ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : '';
}

/** The filters an address holds. A date that is not a calendar day is not a filter. */
export function readFilters(params: URLSearchParams): Filters {
  return {
    sources: listed(params, 'source'),
    categories: listed(params, 'category'),
    authors: listed(params, 'author'),
    from: day(params, 'from'),
    to: day(params, 'to'),
  };
}

/** How many filters are set: each ticked value, and each date. */
export function filterCount(f: Filters): number {
  return f.sources.length + f.categories.length + f.authors.length + (f.from ? 1 : 0) + (f.to ? 1 : 0);
}

const GROUP: Record<FacetKey, keyof Pick<Filters, 'sources' | 'categories' | 'authors'>> = {
  source: 'sources', category: 'categories', author: 'authors',
};

/** The values ticked in one group. */
export function chosenIn(f: Filters, key: FacetKey): string[] {
  return f[GROUP[key]];
}

/** Whether anything outside this group narrows the collection. */
export function othersSet(f: Filters, key: FacetKey): boolean {
  return filterCount(f) - chosenIn(f, key).length > 0;
}

/** The address with one value ticked, or unticked if it was. Other keys are kept as they are. */
export function toggled(params: URLSearchParams, key: FacetKey, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  const now = listed(params, key);
  next.delete(key);
  for (const v of now.includes(value) ? now.filter((x) => x !== value) : [...now, value]) next.append(key, v);
  return next;
}

/** The address with one end of the date range set, or taken off when empty. */
export function withDate(params: URLSearchParams, key: DateKey, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value) next.set(key, value);
  else next.delete(key);
  return next;
}

/** The address with every filter taken off; anything else it holds is kept. */
export function withoutFilters(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of FILTER_KEYS) next.delete(key);
  return next;
}

/**
 * The words that narrow the collection. In newest order the phrase is a filter;
 * ranked by meaning it orders every paper the other filters allow and narrows
 * nothing (the engine's `_search_by_similarity`), so the counts beside the
 * filters and the export leave it out, as the list does.
 */
export function narrowingWords(query: string, ranking: Ranking): string {
  return ranking === 'newest' ? query : '';
}

export type EngineFilters = components['schemas']['ExplorerFilters'];

/** The engine's filter body, for the facets, the search, and the export. */
export function engineFilters(f: Filters, words: string): EngineFilters {
  return {
    query: words || null,
    sources: f.sources,
    categories: f.categories,
    authors: f.authors,
    date_from: f.from || null,
    date_to: f.to || null,
  };
}

// ----------------------------------------------------------------- counts

export interface FacetValue { value: string; count: number }

/** `POST /api/explorer/facets`, which the engine answers without a response model. */
export interface Facets {
  sources: FacetValue[];
  categories: FacetValue[];
  authors: FacetValue[];
  /** The engine lists at most this many values in a group, those with the most papers. */
  max_values: number;
}

export interface FacetRow {
  value: string;
  /** Null where the engine gave no number and none can be inferred. */
  count: number | null;
  chosen: boolean;
}

/**
 * A group's values as its menu lists them: the engine's, most papers first,
 * then any ticked value it did not list. The engine leaves out a value with no
 * papers under the other filters, so a ticked value missing from a list it did
 * not cut is a true 0. Missing from a list it cut at its limit, the value may
 * only rank lower, so it has no number rather than a wrong one.
 */
export function facetRows(listedValues: readonly FacetValue[], chosen: readonly string[], max: number): FacetRow[] {
  const rows: FacetRow[] = listedValues.map((v) => ({ value: v.value, count: v.count, chosen: chosen.includes(v.value) }));
  const cut = listedValues.length >= max;
  for (const value of chosen) {
    if (!listedValues.some((v) => v.value === value)) rows.push({ value, count: cut ? null : 0, chosen: true });
  }
  return rows;
}

const EACH: Record<FacetKey, { noun: string; with: string; widen: string }> = {
  source: { noun: 'sources', with: 'from that source', widen: 'Tick several to see papers from any of them.' },
  category: { noun: 'categories', with: 'in that category', widen: 'A paper can be in several, and ticking several shows papers in any of them.' },
  author: { noun: 'authors', with: 'by that author', widen: 'A paper can have several, and ticking several shows papers by any of them.' },
};

/**
 * What the numbers in one group's menu count. The engine counts each value
 * under the words and every other filter, but not the group's own ticks
 * (`explorer.facets`), so the numbers there do not move as values in the same
 * group are ticked, and the sentence says so rather than leaving it to look
 * like a fault.
 */
export function facetCaption(key: FacetKey, scope: { words: boolean; others: boolean }, listedCount: number, max: number): string {
  const each = EACH[key];
  const against = scope.words && scope.others ? 'that match your words and your other filters'
    : scope.words ? 'that match your words'
      : scope.others ? 'that match your other filters'
        : 'in your collection';
  const cut = listedCount >= max ? ` Only the ${number(max)} ${each.noun} with the most papers are listed.` : '';
  return `Each number counts the papers ${each.with} ${against}. ${each.widen}${cut}`;
}

// ------------------------------------------------------------------ words

const US_DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** `2026-10-01` as "October 1, 2026". */
export function dayWords(iso: string): string {
  return US_DAY.format(new Date(`${iso}T00:00:00Z`));
}

export interface Chip {
  key: FacetKey | DateKey;
  value: string;
  text: string;
  /** The remove button's name: what taking this filter off does. */
  remove: string;
}

/** Each filter as the chip that names it and takes it off. */
export function chips(f: Filters, nameOf: (slug: string) => string): Chip[] {
  const out: Chip[] = [];
  const one = (n: number, only: string, of: string) => (n === 1 ? only : of);
  for (const s of f.sources) {
    const name = nameOf(s);
    out.push({ key: 'source', value: s, text: `From ${name}`,
      remove: one(f.sources.length, `Show papers from every source, not only ${name}`, `Stop showing papers from ${name}`) });
  }
  for (const c of f.categories) {
    out.push({ key: 'category', value: c, text: `In ${c}`,
      remove: one(f.categories.length, `Show papers in every category, not only ${c}`, `Stop showing papers in ${c}`) });
  }
  for (const a of f.authors) {
    out.push({ key: 'author', value: a, text: `By ${a}`,
      remove: one(f.authors.length, `Show papers by every author, not only ${a}`, `Stop showing papers by ${a}`) });
  }
  if (f.from) out.push({ key: 'from', value: f.from, text: `Published from ${dayWords(f.from)}`, remove: 'Take off the earliest publication date' });
  if (f.to) out.push({ key: 'to', value: f.to, text: `Published through ${dayWords(f.to)}`, remove: 'Take off the latest publication date' });
  return out;
}

/** Said beside the dates when no paper can be inside them. */
export function dateRangeProblem(f: Filters): string | null {
  return f.from && f.to && f.from > f.to
    ? `${dayWords(f.from)} is after ${dayWords(f.to)}, so no paper can be published between them.`
    : null;
}

/** The sentence above the list: how many papers, and against what. */
export function countSentence(page: { total: number; total_is_capped: boolean }, filtered: boolean, query: string): string {
  const papers = `${number(page.total)}${page.total_is_capped ? '+' : ''} ${page.total === 1 ? 'paper' : 'papers'}`;
  if (filtered) return `${papers} matching your filters${query ? ' and these words' : ''}`;
  return `${papers} ${query ? 'match' : 'in your collection'}`;
}

// ----------------------------------------------------------------- export

/**
 * What an export of the collection will hold, said before the file is asked
 * for. The engine writes every paper the search counts, up to its cap
 * (`explorer.matching_ids`, bounded by `COUNT_CAP`, the `count_cap` a search
 * reports), the newest first. Past the cap the newest that fit are written and
 * the rest are left out, which the note says before anyone saves.
 */
export function exportWords(
  page: { total: number; total_is_capped: boolean; count_cap: number },
  ranking: Ranking,
): { lead: string; note: string | null } | null {
  if (page.total === 0) return null;
  const order = ranking === 'similarity' ? 'The file lists them newest first, not in order of meaning.' : null;
  if (!page.total_is_capped) {
    return { lead: `Export ${page.total === 1 ? 'this paper' : `these ${count(page.total, 'paper')}`} as`, note: order };
  }
  const cap = number(page.count_cap);
  return {
    lead: `Export the newest ${cap} as`,
    note: `An export holds at most ${cap} papers, so this file will hold the newest ${cap} of the ${cap}+ that match; narrow the filters to reach the rest.${order ? ` ${order}` : ''}`,
  };
}

/** Said once the engine has written the file and the system has it. */
export function exportedWords(records: number | null, filename: string): string {
  const what = records === null ? 'Exported' : count(records, 'paper');
  return `${what} into ${filename}; the save dialog asks where it goes.`;
}
