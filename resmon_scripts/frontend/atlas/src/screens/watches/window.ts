/**
 * A watch's dates: the four choices the editor offers, what each asks for in
 * words, and what the catalog says about the sources a choice reaches.
 *
 * A window that moves (`date_window` in the watch's parameters) is turned into
 * dates by the engine when the watch fires (`date_window.py`), and the run
 * records them; the watch's page shows the dates the engine says the next run
 * would ask for. Fixed dates are asked on every run as stored, and a watch
 * with no dates asks each source in the source's own order, which the catalog
 * states as `result_order`.
 */
import type { components } from '../../api/schema';
import type { CatalogEntry } from '../runs/model';

export type DateWindowComputed = components['schemas']['DateWindowComputed'];

export type WindowChoice = 'previous_run' | 'last_days' | 'between' | 'none';

/**
 * The engine's numbers (`date_window.OVERLAP_DAYS`, `DEFAULT_DAYS`,
 * `MAX_DAYS`), for the editor to say before a watch has run. Once it has, its
 * page shows the engine's own dates instead.
 */
export const OVERLAP_DAYS = 3;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 3650;
/** What "In the last N days" starts at when it is chosen. */
export const DEFAULT_LAST_DAYS = 30;

export const WINDOWS: readonly { window: WindowChoice; label: string }[] = [
  { window: 'previous_run', label: 'Papers published since the previous run' },
  { window: 'last_days', label: 'In the last N days' },
  { window: 'between', label: 'Between two dates' },
  { window: 'none', label: 'No date limit' },
];

export interface StoredWindow {
  window: WindowChoice;
  lastDays: number;
  dateFrom: string;
  dateTo: string;
}

/**
 * The window a watch's stored parameters ask for. A watch saved before the
 * choice existed has none of `date_window`, so it reads as the dates it has,
 * or as no date limit: what it already asks is what the editor shows.
 */
export function windowOf(parameters: Record<string, unknown>): StoredWindow {
  const dateFrom = typeof parameters.date_from === 'string' ? parameters.date_from : '';
  const dateTo = typeof parameters.date_to === 'string' ? parameters.date_to : '';
  const stored = parameters.date_window;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const w = stored as Record<string, unknown>;
    if (typeof w.last_days === 'number') return { window: 'last_days', lastDays: w.last_days, dateFrom: '', dateTo: '' };
    if (w.since === 'previous_run') return { window: 'previous_run', lastDays: DEFAULT_LAST_DAYS, dateFrom: '', dateTo: '' };
  }
  return { window: dateFrom || dateTo ? 'between' : 'none', lastDays: DEFAULT_LAST_DAYS, dateFrom, dateTo };
}

/** "A", "A and B", "A, B, and C". */
export function listed(names: readonly string[]): string {
  if (names.length < 3) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

const DAY_WORDS = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** A stored `YYYY-MM-DD` as "May 4, 2026", or the text as it is when it is not one. */
export function dayWords(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(at.getTime()) ? day : DAY_WORDS.format(at);
}

/** "3 days", "1 day". */
export function dayCount(n: number): string {
  return n === 1 ? '1 day' : `${n.toLocaleString('en-US')} days`;
}

const days = dayCount;

/**
 * The chosen sources that cannot usefully be asked without a start date
 * (bioRxiv and medRxiv: each lists a date range oldest first, so asked from
 * its first preprints a search stops long before recent ones), and how many
 * days before a run the engine starts them when it sets none: the catalog's
 * `default_start_days`. `null` when no chosen source needs one.
 */
export interface StartNeeded {
  entries: CatalogEntry[];
  days: number;
}

export function startNeeded(picked: readonly CatalogEntry[]): StartNeeded | null {
  const entries = picked.filter((entry) => typeof entry.constraints?.default_start_days === 'number');
  if (!entries.length) return null;
  return { entries, days: Math.min(...entries.map((entry) => entry.constraints.default_start_days ?? Infinity)) };
}

/** The day `n` days before `now`, on this computer's calendar, as a date field holds it. */
export function daysBefore(n: number, now: Date = new Date()): string {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/**
 * The start a form fills in for sources that need one, as the engine gives it
 * a run with none: `n` days before today, or before the end date when that is
 * earlier, so the window never ends before it starts.
 */
export function formStart(n: number, to: string, now: Date = new Date()): { day: string; before: 'today' | 'end' } {
  const end = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to);
  if (end && to < daysBefore(0, now)) {
    return { day: daysBefore(n, new Date(Number(end[1]), Number(end[2]) - 1, Number(end[3]))), before: 'end' };
  }
  return { day: daysBefore(n, now), before: 'today' };
}

/** Why the sources that need a start date need one, as the end of a sentence. */
export function startWhy(needs: StartNeeded): string {
  const one = needs.entries.length === 1;
  return `${one ? 'it lists' : 'they list'} a date range oldest first, and asked from ${one ? 'its' : 'their'} first preprints `
    + 'a search stops long before recent ones';
}

/** Fixed dates in words: "from May 3, 2026 to May 4, 2026". */
export function fixedWords(from: string, to: string): string {
  if (from && to) return `from ${dayWords(from)} to ${dayWords(to)}`;
  if (from) return `from ${dayWords(from)} on`;
  return `up to ${dayWords(to)}`;
}

/** What a choice means, said under it in the editor. */
export function windowHint(choice: WindowChoice, lastDays: number, catalog: readonly CatalogEntry[]): string {
  switch (choice) {
    case 'previous_run':
      return `Each run asks for papers published since the watch’s previous run, from ${days(OVERLAP_DAYS)} before it `
        + `started, because a source often lists a paper after the date it carries. A run with no earlier run behind it `
        + `asks for the last ${days(DEFAULT_DAYS)}. A paper already in your collection is not counted as new again.`;
    case 'last_days':
      return `Each run asks for papers published in the ${days(lastDays)} before it starts.`;
    case 'between':
      return 'The same dates on every run: once an end date has passed, each run asks again for papers an earlier run '
        + 'already asked for.';
    default:
      return noLimitWords(catalog);
  }
}

/** The sources of each order, in catalog order. */
export function byOrder(entries: readonly CatalogEntry[]): Record<CatalogEntry['result_order'], CatalogEntry[]> {
  return {
    newest_first: entries.filter((e) => e.result_order === 'newest_first'),
    relevance: entries.filter((e) => e.result_order === 'relevance'),
    unstated: entries.filter((e) => e.result_order === 'unstated'),
  };
}

const namesOf = (entries: readonly CatalogEntry[]) => listed(entries.map((e) => e.name));

/**
 * "No date limit", said plainly from the catalog: every source answers in its
 * own order, and which sources put the newest first and which the most
 * relevant of all years is the catalog's `result_order`.
 */
export function noLimitWords(catalog: readonly CatalogEntry[]): string {
  const { newest_first: newest, relevance, unstated } = byOrder(catalog);
  const parts: string[] = [];
  if (newest.length) parts.push(`newest first from ${namesOf(newest)}`);
  if (relevance.length) parts.push(`the most relevant of all years from ${namesOf(relevance)}, mostly the same papers every run`);
  if (unstated.length) {
    const rest = parts.length ? `the other ${unstated.length === 1 ? 'one' : unstated.length}` : namesOf(unstated);
    parts.push(`${parts.length ? 'and ' : ''}from ${rest}, an order resmon has not established`);
  }
  const head = 'Each run asks each source with no dates, and each answers in its own order';
  return parts.length ? `${head}: ${parts.join('; ')}.` : `${head}.`;
}

/**
 * A watch with no date limit on a source that ranks by relevance: what it
 * gets there, said before and after it is saved. `null` where no chosen
 * source ranks by relevance.
 */
export function relevanceSentence(picked: readonly CatalogEntry[]): string | null {
  const ranked = byOrder(picked).relevance;
  if (!ranked.length) return null;
  const one = ranked.length === 1;
  return `${namesOf(ranked)} ${one ? 'ranks' : 'rank'} by relevance, so with no date limit every run gets the most relevant `
    + `papers of all years from ${one ? 'it' : 'them'}, mostly the same ones each time, and finds little that is new there.`;
}

/**
 * What a window that moves reaches at a source that dates papers only by year
 * or month, from the catalog's `date_granularity` and `window_rounding`. A
 * year-only source asked only for whole years inside a window gets nothing
 * this year from a window that starts after January 1; one that widens gets
 * the whole year or month the window starts in.
 */
export function coarseMovingSentences(picked: readonly CatalogEntry[]): string[] {
  const inward = picked.filter((e) => e.date_granularity === 'year' && e.constraints.window_rounding === 'inward');
  const widened = picked.filter((e) => (e.date_granularity === 'year' || e.date_granularity === 'month')
    && e.constraints.window_rounding !== 'inward');
  const out: string[] = [];
  if (inward.length) {
    const one = inward.length === 1;
    out.push(`${namesOf(inward)} ${one ? 'dates' : 'date'} papers only by year and ${one ? 'is' : 'are'} asked only for whole `
      + `years inside a window, so a window that starts after January 1 asks ${one ? 'it' : 'them'} only for papers dated in a `
      + 'later year.');
  }
  if (widened.length) {
    const one = widened.length === 1;
    const unit = widened.every((e) => e.date_granularity === 'year') ? 'year'
      : widened.every((e) => e.date_granularity === 'month') ? 'month' : 'year or month';
    out.push(`${namesOf(widened)} ${one ? 'dates' : 'date'} papers only by ${unit}, so each run asks ${one ? 'it' : 'them'} `
      + `from the start of the ${unit} its window starts in.`);
  }
  return out;
}

/**
 * What a watch with no start date asks the sources that need one, which its
 * runs give a start of their own (`default_start_days`): "except bioRxiv,
 * which each run asks for the 3 days before it starts". Empty for a watch
 * that sets a start, follows a person (whose sources are asked about the
 * person, never for a date range), or asks no such source.
 */
function exceptStartless(parameters: Record<string, unknown>, stored: StoredWindow, catalog: readonly CatalogEntry[]): string {
  if (parameters.entity || stored.window === 'previous_run' || stored.window === 'last_days' || stored.dateFrom) return '';
  const asked = new Set([
    ...(Array.isArray(parameters.repositories) ? parameters.repositories.map(String) : []),
    ...(typeof parameters.repository === 'string' ? [parameters.repository] : []),
  ]);
  const needs = startNeeded(catalog.filter((entry) => asked.has(entry.slug)));
  if (!needs) return '';
  const one = needs.entries.length === 1;
  return `, except ${namesOf(needs.entries)}, which ${one ? 'needs' : 'need'} a start date: each run asks `
    + `${one ? 'it' : 'them'} for the ${days(needs.days)} before ${stored.dateTo ? 'its end date or the run, whichever is earlier' : 'it starts'}`;
}

/**
 * A watch's dates in a sentence, for its page. For a window that moves, the
 * engine's own sentence with the dates the next run would ask for
 * (`date_window_next`); for fixed dates or none, the dates as stored, and, for
 * a source in `catalog` that needs a start date the watch does not set, the
 * start each run gives it. `null` for a watch on retractions, which searches
 * no source for papers and has no dates to ask.
 */
export function watchWindowSentence(
  parameters: Record<string, unknown>, next: DateWindowComputed | null | undefined, catalog: readonly CatalogEntry[] = [],
): { window: WindowChoice; text: string } | null {
  const entity = parameters.entity;
  if (entity && typeof entity === 'object' && (entity as Record<string, unknown>).mode === 'retractions') return null;
  const stored = windowOf(parameters);
  const except = exceptStartless(parameters, stored, catalog);
  switch (stored.window) {
    case 'previous_run':
      return { window: stored.window, text: next?.sentence ?? 'Each run asks for papers published since the previous run.' };
    case 'last_days':
      return {
        window: stored.window,
        text: next?.sentence ?? `Each run asks for papers published in the ${days(stored.lastDays)} before it starts.`,
      };
    case 'between':
      return {
        window: stored.window,
        text: `Every run asks for papers published ${fixedWords(stored.dateFrom, stored.dateTo)}, the same dates each time${except}.`,
      };
    default:
      return { window: stored.window, text: `Every run asks each source with no date limit, in the source’s own order${except}.` };
  }
}

/**
 * The dates one run asked for, from its own recorded parameters: the
 * engine's sentence where its window moved, otherwise the dates it carried.
 * `null` where the parameters cannot be read, which says nothing either way.
 */
export function runWindowSentence(parameters: string | null | undefined): string | null {
  let p: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(parameters ?? '');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    p = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const computed = p.date_window_computed;
  if (computed && typeof computed === 'object' && typeof (computed as Record<string, unknown>).sentence === 'string') {
    return (computed as { sentence: string }).sentence;
  }
  // A source that needs a start date, in a run that set none, was given one;
  // the engine recorded where and why (`default_starts`).
  const starts = p.default_starts && typeof p.default_starts === 'object' && !Array.isArray(p.default_starts)
    ? Object.values(p.default_starts as Record<string, unknown>)
      .map((start) => (start && typeof start === 'object' ? (start as Record<string, unknown>).sentence : null))
      .filter((sentence): sentence is string => typeof sentence === 'string' && !!sentence)
    : [];
  const from = typeof p.date_from === 'string' ? p.date_from : '';
  const to = typeof p.date_to === 'string' ? p.date_to : '';
  if (from || to) return [`Papers published ${fixedWords(from, to)}.`, ...starts].join(' ');
  if (starts.length) return ['No start date was set.', ...starts, 'Every other source was asked with no dates.'].join(' ');
  return 'No date limit: each source was asked with no dates.';
}
