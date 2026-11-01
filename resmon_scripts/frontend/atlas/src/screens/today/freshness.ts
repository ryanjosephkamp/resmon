import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { LIFECYCLE_FOR } from '../lifecycle/model';

/** Today's answer, from `/api/today`. */
export const TODAY_KEY = ['today'] as const;
/** The collection map, from `/api/map`: where every paper sits. */
export const MAP_KEY = ['map'] as const;
/** What the map's filters and colors read about every paper, from `/api/map/facets`. */
export const FACETS_KEY = ['map-facets'] as const;
/** The newest few runs, by how each stands: what says a run has ended. */
export const RECENT_RUNS_KEY = ['recent-runs'] as const;

/** How long Today, the map, and what is recorded against Today's papers are kept: Today's own refresh. */
export const KEPT_MS = 60_000;

/**
 * Today and the collection map are kept between visits. Coming back to Today,
 * or to any page that draws the map, draws what was read last, and reads
 * again only when the minute's refresh comes round or one of these happens:
 *
 * - `run-finished`: a run ended, with papers that are new on Today and on the map.
 * - `papers-arrived`: Today's count moved, so the map lacks the papers that moved it.
 * - `run-removed`: a run and its record were deleted.
 * - `watch-changed`: a watch was made, edited, paused, resumed, or deleted.
 *   Today groups its papers by watch and says when each runs next.
 * - `paper-changed`: a paper was saved, taken off the reading queue, or marked read.
 * - `looked`: Today was marked read, so its papers are no longer new.
 * - `map-basis-changed`: the map's basis (the embedding model) changed, so every paper may move.
 *
 * Erasing data in the Danger zone reads everything again, and so does reopening the app.
 */
export type Change =
  | 'run-finished' | 'papers-arrived' | 'run-removed' | 'watch-changed' | 'paper-changed' | 'looked'
  | 'map-basis-changed';

/** What each change makes out of date. */
export const READ_AGAIN: Readonly<Record<Change, readonly (readonly string[])[]>> = {
  'run-finished': [TODAY_KEY, MAP_KEY, FACETS_KEY],
  'papers-arrived': [MAP_KEY, FACETS_KEY],
  'run-removed': [TODAY_KEY, FACETS_KEY],
  'watch-changed': [TODAY_KEY, FACETS_KEY],
  'paper-changed': [TODAY_KEY, FACETS_KEY],
  looked: [TODAY_KEY, FACETS_KEY],
  'map-basis-changed': [MAP_KEY],
};

/**
 * Keep Today, the map, and the lifecycle of listed papers between visits, for
 * `KEPT_MS`. A map the engine is still fitting is not kept: a page that opens
 * asks again at once rather than drawing "fitting" until its next poll.
 */
export function keepBetweenVisits(client: QueryClient): void {
  for (const queryKey of [TODAY_KEY, [LIFECYCLE_FOR]]) client.setQueryDefaults(queryKey, { staleTime: KEPT_MS });
  client.setQueryDefaults(MAP_KEY, { staleTime: (query) => mapKeptFor(query.state.data) });
}

/** How long one answer from `/api/map` is kept: a minute when it is a drawn map, none while one is being fitted. */
export function mapKeptFor(data: unknown): number {
  const map = data as { state?: string; refitting?: boolean } | undefined;
  return map?.state === 'ready' && !map.refitting ? KEPT_MS : 0;
}

/** The ended runs at the last reading of the newest runs, or null before one. */
let lastEnded: string | null = null;

/** Read again what `change` made out of date: now where a page shows it, on the next visit elsewhere. */
export async function invalidateFor(client: QueryClient, change: Change): Promise<void> {
  // Today, read again, is current with the runs as they stand: the next
  // reading of them starts afresh rather than reporting this run again.
  if (change === 'run-finished') lastEnded = null;
  await Promise.all(READ_AGAIN[change].map((queryKey) => client.invalidateQueries({ queryKey })));
}

/**
 * Reports `run-finished` when the run a page watched running is running no
 * longer: a run's own page, and a watch's page while one of its runs goes.
 */
export function useRunEnding(running: number | null): void {
  const client = useQueryClient();
  const watched = useRef<number | null>(null);
  useEffect(() => {
    const before = watched.current;
    watched.current = running;
    if (before !== null && before !== running) void invalidateFor(client, 'run-finished');
  }, [running, client]);
}

/** How the runs of a reading stand, as the ids of those that have ended. */
export function endedRuns(runs: readonly { id: number; status: string }[]): string {
  return runs.filter((run) => run.status !== 'running' && run.status !== 'cancelling').map((run) => run.id).join(',');
}

/**
 * Reads the newest runs on each visit and on the minute's refresh, and
 * reports `run-finished` when one has ended since the last reading. A run ends
 * in the background service, or on a page this window has left, as often as
 * on the page watching it, and a kept Today would otherwise go on without its
 * papers until the minute's refresh. A run starting changes nothing: it has no
 * papers until it ends.
 */
export function useRunsEnded(): void {
  const client = useQueryClient();
  const recent = useQuery({
    queryKey: RECENT_RUNS_KEY,
    queryFn: () => answer(engine().GET('/api/executions', { params: { query: { limit: 5 } } })),
    staleTime: 0,
    refetchInterval: KEPT_MS,
  });
  const ended = recent.data ? endedRuns(recent.data) : null;
  useEffect(() => {
    if (ended === null) return;
    const before = lastEnded;
    lastEnded = ended;
    if (before !== null && before !== ended) void invalidateFor(client, 'run-finished');
  }, [ended, client]);
}

/** For tests: forget the last reading. */
export function forgetRunsEnded(): void {
  lastEnded = null;
}
