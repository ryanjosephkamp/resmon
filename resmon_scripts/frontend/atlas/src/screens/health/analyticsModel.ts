/**
 * Analytics: what the collection holds, and which sources, terms and watches
 * earn their place, in the engine's own numbers.
 *
 * Every view the engine serves carries `sufficient` and, below its threshold,
 * the sentence to show instead of a chart; a share or a median over too little
 * is `null`, never 0. This file only shapes those numbers for drawing: a
 * width, a month in words, a share as a percentage. It computes no statistic
 * of its own.
 */
import type { components } from '../../api/schema';
import { exactCount, exactDays, exactShare } from '../../charts/exact';
import type { TipContent } from '../../charts/ChartTip';
import { timeTogether } from '../../lib/timeTogether';
import { count } from '../today/format';
import { instantOf } from './model';

export type Overview = components['schemas']['AnalyticsOverview'];
export type KeywordContribution = components['schemas']['KeywordContribution'];
export type SourceRow = components['schemas']['SourceContributionRow'];
export type LagRow = components['schemas']['DiscoveryLagRow'];
export type WatchRow = components['schemas']['RoutineHealthRow'];
export type WatchRun = components['schemas']['RoutineHealthRun'];
export type KeywordRow = components['schemas']['KeywordContributionRow'];
export type VolumeMonth = components['schemas']['PublicationVolumeMonth'];

export const ANALYTICS_KEY = ['analytics-overview'] as const;

/** A share as the engine served it, or a dash for `null`, which is "not enough to say". */
export function percent(share: number | null | undefined): string {
  if (share === null || share === undefined) return '—';
  return `${Math.round(share * 100)}%`;
}

/** A part of a whole as a width, in percent of the widest row. */
export function widthOf(value: number, largest: number): number {
  if (largest <= 0 || value <= 0) return 0;
  return Math.max(0.5, (100 * value) / largest);
}

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "2026-10" as "Oct 2026": a calendar month, read in no time zone. */
export function monthWords(month: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(month);
  if (!match) return month;
  return MONTH.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

const SHORT_MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** "2026-10" as "Oct ’26", for a column's label. */
export function monthShort(month: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(month);
  if (!match) return month;
  return `${SHORT_MONTH.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)))} ’${(match[1] ?? '').slice(2)}`;
}

/** Days, as a person reads them: "under a day", "1.5 days", "12 days". */
export function daysWords(days: number | null | undefined): string {
  if (days === null || days === undefined) return '—';
  // A source can date a paper after resmon first saw it (an issue date in the future).
  if (days < 0) return `${Number(Math.abs(days).toFixed(1))} days before its stated date`;
  if (days < 1) return 'under a day';
  return `${Number(days.toFixed(1))} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * A watch's status in words, with the count it rests on (`analytics.routine_health`):
 * healthy is something new within its last `stale_after` runs; stale is that
 * many runs or more with nothing new; not recorded is neither, because some of
 * those runs did not record how many papers were new; below `minimum_runs` it
 * is not judged.
 */
export function watchStatusWords(row: Pick<WatchRow, 'status' | 'runs_since_new' | 'runs' | 'series'>, staleAfter: number, minimumRuns: number): string {
  if (row.status === 'healthy') return `New papers within its last ${staleAfter} runs`;
  if (row.status === 'stale') return `Nothing new in its last ${row.runs_since_new} runs`;
  if (row.status === 'insufficient_data') return `${row.runs} of the ${minimumRuns} completed runs needed to judge`;
  if (row.status === 'not_recorded') {
    const unrecorded = row.series.slice(-staleAfter).filter((run) => run.new_results === null).length;
    return `Not judged: ${unrecorded} of its last ${staleAfter} runs did not record how many papers were new`;
  }
  return row.status;
}

/**
 * Where a chart's mark leads: Search › Your collection narrowed to a source,
 * a category, or the month a paper was published in (`?from=` and `?to=`,
 * that month's first and last day), or searched for a keyword's words.
 */
export function collectionFor(filter: { source?: string; category?: string; month?: string; words?: string }): string {
  const params = new URLSearchParams();
  if (filter.words) params.set('q', filter.words);
  if (filter.source) params.set('source', filter.source);
  if (filter.category) params.set('category', filter.category);
  const range = filter.month ? monthRange(filter.month) : null;
  if (range) {
    params.set('from', range.from);
    params.set('to', range.to);
  }
  return `/search?${params.toString()}`;
}

/**
 * A publication month's first and last day, as the collection's date filter
 * takes them: the engine buckets a paper into a month by its date's first
 * seven characters, and the filter compares whole dates, so 2026-02 is
 * 2026-02-01 to 2026-02-28.
 */
export function monthRange(month: string): { from: string; to: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const mm = Number(match[2]);
  if (mm < 1 || mm > 12) return null;
  const last = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return { from: `${match[1]}-${match[2]}-01`, to: `${match[1]}-${match[2]}-${String(last).padStart(2, '0')}` };
}

const LONG_MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "2026-10" as "October 2026", for a sentence. */
export function monthLong(month: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(month);
  if (!match) return month;
  return LONG_MONTH.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

/**
 * A keyword the collection's search can be handed as words. A term with
 * search operators in it (quotes, OR, a minus) is matched here by the
 * engine's own rule, which the collection's search box does not share: handed
 * over, its operators would be searched for as words, so its row opens
 * nothing.
 */
export function searchable(row: Pick<KeywordRow, 'keyword' | 'contains_operators'>): boolean {
  return !row.contains_operators && row.keyword.trim().length > 0;
}

const opensFor = (what: string) => `Opens Search › Your collection ${what}`;

/** A source's two-part bar: its papers, those only it supplied, and those another also did. */
export function sourceTip(row: SourceRow, name: string, compared: boolean): TipContent {
  const share = exactShare(row.unique_share);
  return {
    name,
    value: count(row.total, 'paper'),
    lines: compared ? [
      { value: exactCount(row.unique_papers), label: 'only from this source', key: 'accent' },
      { value: exactCount(row.duplicated), label: 'also from another source', key: 'context' },
    ] : undefined,
    notes: compared && share ? [`${share} of its papers came from no other source.`] : undefined,
    opens: opensFor(`narrowed to ${name}`),
  };
}

/** A keyword's two-part bar: the papers it matched, those no other term did, and those another did too. */
export function keywordTip(row: KeywordRow, minimum: number): TipContent {
  const share = exactShare(row.unique_share);
  return {
    name: row.keyword,
    value: `${exactCount(row.matched)} ${row.matched === 1 ? 'paper' : 'papers'} matched`,
    lines: [
      { value: exactCount(row.unique), label: 'only this term', key: 'accent' },
      { value: exactCount(row.shared), label: 'another term too', key: 'context' },
    ],
    notes: [
      share ? `${share} matched this term and no other.` : `A share needs ${count(minimum, 'match', 'matches')}.`,
      ...(row.contains_operators ? ['It has search operators, so it is matched here by the engine’s own rule.'] : []),
    ],
    opens: searchable(row) ? opensFor('searched for these words') : null,
  };
}

/** A source's range of days, from the fastest paper to the slowest, with its median. */
export function lagTip(row: LagRow, name: string, minimum: number): TipContent {
  const median = row.sufficient ? exactDays(row.median_days) : null;
  const leftOut = notADayWords(row.not_a_day);
  if (!median) {
    return {
      name,
      value: count(row.sample_size, 'paper') + ' dated to the day',
      notes: [`A median needs ${count(minimum, 'dated paper')}.`, ...(leftOut ? [leftOut] : [])],
      opens: opensFor(`narrowed to ${name}`),
    };
  }
  return {
    name,
    value: `${median}, the median`,
    lines: [
      { value: exactDays(row.fastest_days) ?? '—', label: 'the fastest' },
      { value: exactDays(row.slowest_days) ?? '—', label: 'the slowest' },
    ],
    notes: [
      `From each paper’s stated publication date to resmon first seeing it, over ${count(row.sample_size, 'paper')} dated to the day.`,
      ...(leftOut ? [leftOut] : []),
    ],
    opens: opensFor(`narrowed to ${name}`),
  };
}

/**
 * The papers a view left out because their stated date is a year or a month
 * alone, or is not a day at all, as a sentence; nothing when there are none.
 */
export function notADayWords(n: number): string | null {
  if (n <= 0) return null;
  return `${count(n, 'paper')} whose stated date is not a whole day ${n === 1 ? 'is' : 'are'} left out.`;
}

const STARTED = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** One completed run of a watch, as a tick on its strip: what it found that was new, and what it found in all. */
export function watchRunTip(run: WatchRun, watch: string): TipContent {
  const at = instantOf(run.start_time);
  return {
    name: `${watch} · ${at ? timeTogether(STARTED.format(at)) : 'a time not recorded'}`,
    // A count the run did not record is said so, never drawn or said as none.
    value: run.new_results === null ? 'New papers not recorded' : count(run.new_results, 'new paper'),
    lines: run.total_results === null ? undefined : [{ value: exactCount(run.total_results), label: 'found in all' }],
    opens: `Opens run ${run.execution_id}`,
  };
}

/** What a group in the publication volume is called: a source by name, a category as written. */
export function groupName(group: string, by: 'source' | 'category', nameOf: (slug: string) => string): string {
  if (group === 'other') return 'Everything else';
  if (group === '(uncategorised)') return 'No category given';
  return by === 'source' ? nameOf(group) : group;
}

/**
 * A month's column: its total, and each group's count in it, largest first.
 * By source the total is papers, each counted once; by category a paper is
 * counted once in each of its categories, so the total is said as a count
 * of those, not of papers.
 */
export function volumeTip(month: VolumeMonth, by: 'source' | 'category', nameOf: (slug: string) => string): TipContent {
  const groups = Object.entries(month.groups)
    .sort(([a, x], [b, y]) => (a === 'other' ? 1 : b === 'other' ? -1 : y - x || a.localeCompare(b)));
  return {
    name: monthLong(month.month),
    value: by === 'source' ? count(month.total, 'paper') : `${exactCount(month.total)} in all`,
    lines: groups.map(([group, n]) => ({ value: exactCount(n), label: groupName(group, by, nameOf) })),
    notes: by === 'category' ? ['A paper in several categories is counted in each.'] : undefined,
    opens: opensFor(`narrowed to papers published in ${monthLong(month.month)}`),
  };
}

/** The groups a publication-volume window holds, each with its total over the window, largest first. */
export function groupTotals(series: readonly VolumeMonth[]): { group: string; total: number }[] {
  const totals = new Map<string, number>();
  for (const month of series) {
    for (const [group, n] of Object.entries(month.groups)) totals.set(group, (totals.get(group) ?? 0) + n);
  }
  return [...totals.entries()]
    .map(([group, total]) => ({ group, total }))
    .sort((a, b) => (a.group === 'other' ? 1 : b.group === 'other' ? -1 : b.total - a.total));
}
