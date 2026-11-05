/**
 * The runs going now and the runs waiting for a free slot, as
 * `GET /api/executions/active` says them: one query, read every two seconds
 * while anything runs or waits and every fifteen otherwise, shared by every
 * screen that shows them, so two of them on screen cost one request.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { bridge } from '../../bridge';
import type { components } from '../../api/schema';
import { liveStage, secondsSince } from './live';
import { liveSources, runKind, type LiveSource, type ProgressEvent } from './model';

export type ActiveRuns = components['schemas']['ActiveRuns'];
export type ActiveRun = components['schemas']['ActiveRun'];
export type WaitingRun = components['schemas']['WaitingRun'];

/** Under the runs key, so whatever invalidates the runs reads these again too. */
export const ACTIVE_KEY = ['runs', 'active'] as const;

/** How often the active runs are read: while anything runs or waits, and otherwise (a watch may fire). */
export const ACTIVE_BUSY_MS = 2_000;
export const ACTIVE_IDLE_MS = 15_000;

/**
 * Another window saw the failed runs, or stopped, started, or dequeued one
 * (`client.ts`, `CHANGES_THE_RUNS`): read the runs going now at once, so the
 * run monitor's mark and the lists change in every window together. One
 * listener for the window, however many screens show the runs, and none while
 * no screen does: the next one to show them reads them anyway.
 */
let following: { client: QueryClient; readers: number; stop: () => void } | null = null;

function useFollowOtherWindows(): void {
  const client = useQueryClient();
  useEffect(() => {
    if (following?.client !== client) {
      following?.stop();
      const stop = bridge()?.onRunsChanged?.(() => { void client.invalidateQueries({ queryKey: ACTIVE_KEY }); }) ?? (() => {});
      following = { client, readers: 0, stop };
    }
    const mine = following;
    mine.readers += 1;
    return () => {
      mine.readers -= 1;
      if (mine.readers === 0 && following === mine) {
        mine.stop();
        following = null;
      }
    };
  }, [client]);
}

export function useActiveRuns() {
  useFollowOtherWindows();
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

/**
 * The signature each list of runs last answered to, by the list's name. Kept
 * here, outside any component, so a list that was not on screen when a run
 * ended reads itself again when it comes back, rather than taking the
 * signature it finds as the one it already answered to.
 */
const answered = new Map<string, string>();

/**
 * Reads `key` again whenever a run has started, ended, or joined or left the
 * queue since the list named `name` last looked, whether or not it was on
 * screen at the time: the history after a run's own page, say, where the run
 * ended while the history was not mounted.
 */
export function useReadAgainWhenRunsChange(name: string, key: readonly unknown[]): void {
  const client = useQueryClient();
  const active = useActiveRuns();
  const signature = active.data ? activeSignature(active.data) : null;
  const keyText = JSON.stringify(key);
  useEffect(() => {
    if (signature === null) return;
    const before = answered.get(name);
    answered.set(name, signature);
    if (before !== undefined && before !== signature) void client.invalidateQueries({ queryKey: JSON.parse(keyText) as unknown[] });
  }, [name, signature, keyText, client]);
}

/** For tests: forget what every list last answered to. */
export function forgetAnswered(): void {
  answered.clear();
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

/**
 * Whether a run has gone quiet: no word for fifteen seconds while it asks its
 * sources. Only then is silence a sign: the engine sends each source's
 * heartbeat every two seconds while it is being asked, and after the sources
 * it sends nothing while it stores the papers (a large run's store can take
 * longer than fifteen seconds), and its counts only now and then. So a run
 * past its sources is never drawn as stalled.
 */
export function isStalled(run: ActiveRun, now: number): boolean {
  if (liveStage(run.events as unknown as ProgressEvent[]).stage !== 'querying') return false;
  if (!activeSources(run).some((source) => source.state === 'asking')) return false;
  const silent = silentFor(run, now);
  return silent !== null && silent >= STALLED_SECONDS;
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
