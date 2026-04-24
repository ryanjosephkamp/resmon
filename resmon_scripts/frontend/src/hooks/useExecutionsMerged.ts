/**
 * useExecutionsMerged — unified Local + Cloud execution stream (IMPL-36, §12.2).
 *
 * Fetches ``/api/executions/merged`` from the local daemon, which returns
 * local SQLite executions and cloud-mirror executions sorted by
 * ``start_time`` descending. Each row carries ``execution_location`` ∈
 * ``"local" | "cloud"`` so ``ResultsPage`` can render the Local / Cloud
 * badge and the filter chip without inspecting id shapes.
 *
 * Refreshes on:
 *   - explicit ``refresh()`` from the caller,
 *   - any completion event from ExecutionContext (``completionCounter``),
 *   - the ``resmon:cloud-sync-applied`` window event emitted by
 *     ``useCloudSync`` after a successful ingest.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { useExecution } from '../context/ExecutionContext';

export type ExecutionFilter = 'all' | 'local' | 'cloud';

export interface MergedExecution {
  /** Numeric local id or cloud UUID. */
  id?: number;
  execution_id?: string;
  execution_location: 'local' | 'cloud';
  execution_type: string;
  status: string;
  start_time?: string;
  started_at?: string;
  end_time?: string | null;
  finished_at?: string | null;
  result_count?: number;
  new_result_count?: number;
  total_results?: number;
  new_results?: number;
  artifact_uri?: string | null;
  query?: string;
  keywords?: string[] | null;
  repositories?: string[] | null;
  routine_id?: string | number | null;
}

export interface UseExecutionsMergedResult {
  executions: MergedExecution[];
  filter: ExecutionFilter;
  setFilter: (f: ExecutionFilter) => void;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useExecutionsMerged(
  initialFilter: ExecutionFilter = 'all',
  limit: number = 200,
): UseExecutionsMergedResult {
  const [filter, setFilter] = useState<ExecutionFilter>(initialFilter);
  const [executions, setExecutions] = useState<MergedExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { completionCounter } = useExecution();
  const pendingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const rows = await apiClient.get<MergedExecution[]>(
        `/api/executions/merged?filter=${filter}&limit=${limit}`,
      );
      setExecutions(rows);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
      pendingRef.current = false;
    }
  }, [filter, limit]);

  useEffect(() => {
    refresh();
  }, [refresh, completionCounter]);

  // Auto-refresh when the sync hook applies new cloud rows.
  useEffect(() => {
    const handler = () => {
      refresh();
    };
    window.addEventListener('resmon:cloud-sync-applied', handler);
    return () =>
      window.removeEventListener('resmon:cloud-sync-applied', handler);
  }, [refresh]);

  const value = useMemo<UseExecutionsMergedResult>(
    () => ({ executions, filter, setFilter, loading, error, refresh }),
    [executions, filter, loading, error, refresh],
  );

  return value;
}
