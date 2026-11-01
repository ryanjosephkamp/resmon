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
import { dayCount, dayWords, listed, startWhy, type StartNeeded } from '../watches/window';

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

/**
 * Ask the sources' line for a chosen source that needs a start date: the start
 * the form filled in, when it did (`filled`), or why Any time is not offered.
 */
export function askStartSentence(needs: StartNeeded, filled: { day: string; before: 'today' | 'end' } | null): string {
  const names = listed(needs.entries.map((entry) => entry.name));
  const need = needs.entries.length === 1 ? 'needs' : 'need';
  if (!filled) {
    return `${names} ${need} a start date, so Any time is not offered while ${needs.entries.length === 1 ? 'it is' : 'they are'} `
      + `chosen: ${startWhy(needs)}.`;
  }
  const when = filled.before === 'end'
    ? `on ${dayWords(filled.day)}, ${dayCount(needs.days)} before its end date`
    : `${dayCount(needs.days)} back, on ${dayWords(filled.day)}`;
  return `${names} ${need} a start date, so this search starts ${when}: ${startWhy(needs)}.`;
}

/**
 * Ask the sources' one line where both apply: why Any time is not offered, and
 * that a window longer than the sources' own default may not be read back to
 * its start (their `beyond_default_start` notice), said together rather than
 * as two lines about the same sources.
 */
export function askStartLongSentence(needs: StartNeeded): string {
  const names = listed(needs.entries.map((entry) => entry.name));
  const one = needs.entries.length === 1;
  return `${names} ${one ? 'needs' : 'need'} a start date, so Any time is not offered while ${one ? 'it is' : 'they are'} `
    + `chosen. resmon reads ${one ? 'it' : 'them'} from the newest preprints in your window back, for at most 45 seconds, `
    + `so a window longer than ${dayCount(needs.days)} may not be read back to its start; the run says how far back it read.`;
}

/** A sentence the catalog says a chosen source carries in the form's present state. */
export interface FormNotice {
  slug: string;
  effect: string;
  /** The notice's `applies_when`, so a form can say two of them as one line. */
  scope: string;
}

/**
 * The catalog's notices that the form's own state makes true, before anything
 * is asked: what resmon does in place of a start date that is not set
 * (bioRxiv and medRxiv are asked for the days before the run, which a form
 * fills in rather than leave blank), that a window longer than those days may
 * not be read back to its start (`span`, its length in days), and how it asks
 * a source for more than it returns in one request. A notice is shown only in
 * the state its `applies_when` names, as the catalog requires.
 */
export function formNotices(
  picked: readonly CatalogEntry[], state: { start: boolean; cap: number; span?: number | null },
): FormNotice[] {
  const out: FormNotice[] = [];
  for (const entry of picked) {
    const own = entry.constraints.default_start_days;
    for (const notice of entry.constraints.notices) {
      const applies = (notice.applies_when === 'without_start_date' && !state.start)
        || (notice.applies_when === 'above_record_cap' && entry.constraints.records_per_request !== null
          && state.cap > entry.constraints.records_per_request)
        || (notice.applies_when === 'beyond_default_start' && state.start && typeof own === 'number'
          && typeof state.span === 'number' && state.span > own);
      if (applies) out.push({ slug: entry.slug, effect: notice.effect, scope: notice.applies_when });
    }
  }
  return out;
}
