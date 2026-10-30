import { useEffect, useRef, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { instant } from '../today/format';

/**
 * How long after `readAfter` a map read must have finished to be trusted
 * without asking again. A read of a large collection takes seconds, so one
 * that finished just after a run ended may have begun before it, and hold
 * none of the run's papers.
 */
const SETTLED_MS = 30_000;

/**
 * Whether the map in hand holds what arrived before `readAfter`, an engine
 * timestamp such as a run's end. A map that does not is read again, once for
 * each `readAfter`, asked for after the moment was seen, and until that read
 * comes back the caller treats the map as not ready, rather than as a map
 * that could not place the papers it lacks.
 */
export function useReadAfter(map: UseQueryResult<unknown>, readAfter: string | null | undefined): boolean {
  const after = readAfter ? instant(readAfter).getTime() : null;
  const [readFor, setReadFor] = useState<number | null>(null);
  const asked = useRef<number | null>(null);
  const current = after === null || readFor === after || (!!map.data && map.dataUpdatedAt >= after + SETTLED_MS);
  const { refetch } = map;
  useEffect(() => {
    if (after === null || current || asked.current === after) return;
    asked.current = after;
    // A read already under way may have begun before the moment: it is replaced.
    void refetch({ cancelRefetch: true }).finally(() => setReadFor(after));
  }, [after, current, refetch]);
  return current;
}
