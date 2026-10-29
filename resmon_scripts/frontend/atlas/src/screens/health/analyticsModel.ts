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

export type Overview = components['schemas']['AnalyticsOverview'];
export type KeywordContribution = components['schemas']['KeywordContribution'];
export type SourceRow = components['schemas']['SourceContributionRow'];
export type LagRow = components['schemas']['DiscoveryLagRow'];
export type WatchRow = components['schemas']['RoutineHealthRow'];
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
 * many runs or more with nothing new; below `minimum_runs` it is not judged.
 */
export function watchStatusWords(row: Pick<WatchRow, 'status' | 'runs_since_new' | 'runs'>, staleAfter: number, minimumRuns: number): string {
  if (row.status === 'healthy') return `New papers within its last ${staleAfter} runs`;
  if (row.status === 'stale') return `Nothing new in its last ${row.runs_since_new} runs`;
  if (row.status === 'insufficient_data') return `${row.runs} of the ${minimumRuns} completed runs needed to judge`;
  return row.status;
}

/** Where a chart's row leads: the collection, narrowed to that source or category. */
export function collectionFor(filter: { source?: string; category?: string }): string {
  const params = new URLSearchParams();
  if (filter.source) params.set('source', filter.source);
  if (filter.category) params.set('category', filter.category);
  return `/search?${params.toString()}`;
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
