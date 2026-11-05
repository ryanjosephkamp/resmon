/**
 * The runs going now and the runs waiting for a free slot, as
 * `GET /api/executions/active` says them: one query, read every two seconds
 * while anything runs or waits and every fifteen otherwise, shared by every
 * screen that shows them, so two of them on screen cost one request.
 */
import { useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import type { components } from '../../api/schema';
import { secondsSince } from './live';
import { liveSources, runKind, type LiveSource, type ProgressEvent } from './model';

export type ActiveRuns = components['schemas']['ActiveRuns'];
export type ActiveRun = components['schemas']['ActiveRun'];
export type WaitingRun = components['schemas']['WaitingRun'];

/** Under the runs key, so whatever invalidates the runs reads these again too. */
export const ACTIVE_KEY = ['runs', 'active'] as const;

/** How often the active runs are read: while anything runs or waits, and otherwise (a watch may fire). */
export const ACTIVE_BUSY_MS = 2_000;
export const ACTIVE_IDLE_MS = 15_000;

export function useActiveRuns() {
  return useQuery({
    queryKey: ACTIVE_KEY,
    queryFn: () => answer(engine().GET('/api/executions/active')),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && (data.running.length || data.waiting.length) ? ACTIVE_BUSY_MS : ACTIVE_IDLE_MS;
    },
    refetchOnWindowFocus: true,
  });
}

/**
 * What changes when a run starts, ends, joins the queue, or leaves it: the
 * run log is read again when this does, and at no other time on its own. The
 * newest run and the latest end are in it, so a run that started and ended
 * between two reads still changes it.
 */
export function activeSignature(data: ActiveRuns | undefined): string {
  if (!data) return '';
  return [
    data.running.map((run) => run.id).join(','), data.waiting.map((run) => run.ticket).join(','),
    data.newest_run_id ?? '', data.last_ended_at ?? '',
  ].join('|');
}

/** A running run's sources, folded from its events as its own page folds them. */
export function activeSources(run: ActiveRun): LiveSource[] {
  return liveSources(run.repositories ?? [], run.events as unknown as ProgressEvent[]);
}

/** When the engine last said anything about a running run, as its newest event's time. */
export function lastWord(run: ActiveRun): string | null {
  for (let i = run.events.length - 1; i >= 0; i -= 1) {
    const at = (run.events[i] as { timestamp?: unknown }).timestamp;
    if (typeof at === 'string') return at;
  }
  return null;
}

/** How long a run may say nothing before it is drawn as stalled, as the run monitor's comp sets it. */
export const STALLED_SECONDS = 15;

/** Seconds since the run last said anything, or null when it has said nothing with a time. */
export function silentFor(run: ActiveRun, now: number): number | null {
  return secondsSince(lastWord(run), now);
}

/** What a run going now, or waiting, is called: its watch for a watch's, otherwise its terms. */
export function activeTitle(
  run: { keywords?: string[] | null; query?: string | null; routine_id?: number | null },
  watchName: (id: number) => string | null,
): string {
  const watch = run.routine_id ? watchName(run.routine_id) : null;
  if (watch) return watch;
  if (run.keywords && run.keywords.length) return run.keywords.join(', ');
  return run.query?.trim() || 'A search with no terms recorded';
}

/** "Deep Sweep", "Watch run", or for a watch's fire that has not started, "Watch run". */
export function waitingKind(run: WaitingRun): string {
  if (run.kind === 'watch') return 'Watch run';
  return run.execution_type ? runKind(run.execution_type) : 'Run';
}

/** "next in line", "2nd in line". */
export function placeWords(position: number): string {
  if (position <= 1) return 'next in line';
  const tens = position % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[position % 10] ?? 'th';
  return `${position}${suffix} in line`;
}
