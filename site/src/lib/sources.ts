/**
 * The source catalog as the site shows it.
 *
 * `../data/sources.json` is written from `repo_catalog.py` by
 * `scripts/export_sources.py`, and a backend test fails when the two differ.
 * Everything below only renames a catalog value for reading; none of it adds a
 * fact the catalog does not hold.
 */
import data from '../data/sources.json';

export interface Source {
  slug: string;
  name: string;
  description: string;
  subject_coverage: string;
  website: string;
  api_key_requirement: 'none' | 'optional' | 'recommended' | 'required';
  rate_limit: string;
  keyword_combination: string;
  date_granularity: 'day' | 'month' | 'year';
  attribution: string;
  attribution_requirement: 'none' | 'requested' | 'required';
  author_search: 'endpoint' | 'field' | 'none' | 'param' | 'unknown';
}

export const SOURCES = data.sources as Source[];
export const SOURCE_COUNT: number = data.count;

const KEY: Record<Source['api_key_requirement'], string> = {
  none: 'no key',
  optional: 'key optional',
  recommended: 'key recommended',
  required: 'key required',
};

const KEY_LONG: Record<Source['api_key_requirement'], string> = {
  none: 'Not needed.',
  optional: 'Optional. A key raises the rate the source allows.',
  recommended: 'Recommended. Without one, expect the source to refuse some requests (HTTP 429).',
  required: 'Required: the source answers only with your own key, entered in the app.',
};

const DATES: Record<Source['date_granularity'], string> = {
  day: 'to the day',
  month: 'to the month',
  year: 'whole years',
};

const AUTHOR: Record<Source['author_search'], string> = {
  field: 'Yes, through an author field in the query.',
  param: 'Yes, through an author parameter.',
  endpoint: 'Yes, through a separate author endpoint.',
  none: 'Not offered by the source.',
  unknown: 'Not established: resmon has not been able to test it.',
};

export const keyShort = (s: Source) => KEY[s.api_key_requirement];
export const keyLong = (s: Source) => KEY_LONG[s.api_key_requirement];
export const datesShort = (s: Source) => DATES[s.date_granularity];
/** The catalog's `date_granularity`: the finest window resmon's query to the source can express. */
export const dateLong = (s: Source) =>
  ({ day: 'To the day.', month: 'To the month.', year: 'Whole years only.' })[s.date_granularity];
export const authorLong = (s: Source) => AUTHOR[s.author_search];

/** "0.33 req/s (1 per 3 s)" -> "0.33 req/s": the number before the reason. */
export const rateShort = (s: Source) => s.rate_limit.split(' (')[0];

export const creditLabel = (s: Source) =>
  s.attribution_requirement === 'required'
    ? 'Required by the source’s terms'
    : s.attribution_requirement === 'requested'
      ? 'Requested by the source'
      : '';

/** "arXiv, PubMed, OpenAlex, CrossRef" and the count of the rest. */
export function namedAndRest(names: string[]): { named: string; rest: number } {
  const picked = names.filter((n) => SOURCES.some((s) => s.name === n));
  return { named: picked.join(', '), rest: SOURCE_COUNT - picked.length };
}
