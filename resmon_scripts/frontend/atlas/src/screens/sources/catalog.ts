/**
 * The source catalog as the screens that choose sources read it: Ask the
 * sources, and a watch's editor.
 *
 * Every fact here is the catalog's own statement about an upstream, or is
 * derived from one for the sources chosen: which source sets the pace, which
 * cannot date papers as finely as a window asks, which cannot be asked about
 * an author. Nothing here estimates how many papers a source will return.
 */
import type { CatalogEntry } from '../runs/model';

/** Requests per second, from the catalog's stated limit ("0.33 req/s (1 per 3 s)"). */
export function ratePerSecond(rate: string): number | null {
  const match = rate.match(/^\s*([\d.]+)\s*req\/s/);
  return match ? Number(match[1]) : null;
}

/** The stated limit, short, for the catalog: "10 a second", "1 every 3 s", "1 a minute". */
export function rateShort(perSecond: number | null, stated: string): string {
  if (perSecond === null || perSecond <= 0) return stated;
  if (perSecond >= 1) return `${Number(perSecond.toFixed(1))} a second`;
  const every = 1 / perSecond;
  return every >= 59 ? `1 every ${Math.round(every / 60)} min` : `1 every ${Math.round(every)} s`;
}

/** The same limit as a phrase: "one request every 3 seconds". */
export function rateLong(perSecond: number): string {
  if (perSecond >= 1) return `${Number(perSecond.toFixed(1))} requests a second`;
  const every = 1 / perSecond;
  return every >= 59
    ? `one request every ${Math.round(every / 60) === 1 ? 'minute' : `${Math.round(every / 60)} minutes`}`
    : `one request every ${Math.round(every)} seconds`;
}

/** Whole days between two ISO dates; `null` when the window is open at either end. */
export function windowLength(from: string, to: string): number | null {
  if (!from || !to) return null;
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  return Number.isFinite(days) ? days : null;
}

/** The slowest of several chosen sources, which sets how long a sweep takes; `null` for one source. */
export function paceOf(picked: readonly CatalogEntry[]): { entry: CatalogEntry; rate: number } | null {
  const rated = picked.map((entry) => ({ entry, rate: ratePerSecond(entry.rate_limit) }))
    .filter((r): r is { entry: CatalogEntry; rate: number } => r.rate !== null && r.rate > 0)
    .sort((a, b) => a.rate - b.rate);
  return picked.length > 1 && rated[0] ? rated[0] : null;
}

/** The chosen sources that date papers more coarsely than a window this short. */
export function coarseFor(picked: readonly CatalogEntry[], from: string, to: string): CatalogEntry[] {
  const days = windowLength(from, to);
  if (days === null || days >= 365) return [];
  return picked.filter((entry) => entry.date_granularity === 'year'
    || (entry.date_granularity === 'month' && days < 31));
}

/** The sentence for the coarse sources, or null when there are none. */
export function coarseSentence(coarse: readonly CatalogEntry[]): string | null {
  if (!coarse.length) return null;
  const one = coarse.length === 1;
  return `${coarse.map((entry) => entry.name).join(', ')} ${one ? 'dates' : 'date'} papers only to the `
    + `${one ? coarse[0]?.date_granularity : 'month or year'}; a window this short may come back as one `
    + `${one ? 'it' : 'they'} could not answer.`;
}

/**
 * Whether a source can be asked about a person, as the catalog states it. A
 * watch on a person through a source that cannot be asked finds nothing, and
 * the run says so on that source's own row; this says it before asking.
 */
export function authorWords(query: string): string {
  if (query === 'none') return 'cannot be asked about an author';
  if (query === 'unknown') return 'not known whether it can be asked about an author';
  return 'can be asked about an author';
}

/**
 * True when sources are chosen and not one of them can be asked about an
 * author: a watch on a person's new papers there runs correctly and finds
 * nothing, for ever. The engine says the same when such a watch is made
 * (`_entity_source_warning`); this says it while it is being chosen.
 */
export function noneAskableAboutAuthors(picked: readonly CatalogEntry[]): boolean {
  return picked.length > 0 && picked.every((entry) => entry.entity_search.author_query === 'none');
}
