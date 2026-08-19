/**
 * useExecutions — the execution history behind the Results page.
 *
 * Was `useExecutionsMerged`, which stitched local runs together with rows
 * mirrored from the resmon-cloud service. That service is gone, so every
 * execution is a local one and this reads `/api/executions` directly.
 *
 * Refreshes on an explicit `refresh()` and on any completion event from
 * ExecutionContext (`completionCounter`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { useExecution } from '../context/ExecutionContext';

export interface ExecutionRow {
  id: number;
  execution_type: string;
  status: string;
  start_time?: string;
  end_time?: string | null;
  result_count?: number;
  new_result_count?: number;
  total_results?: number;
  new_results?: number;
  query?: string;
  keywords?: string[] | null;
  repositories?: string[] | null;
  routine_id?: number | null;
}

export interface UseExecutionsResult {
  executions: ExecutionRow[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useExecutions(limit: number = 200): UseExecutionsResult {
  const [executions, setExecutions] = useState<ExecutionRow[]>([]);
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
      const rows = await apiClient.get<ExecutionRow[]>(
        `/api/executions?limit=${limit}`,
      );
      setExecutions(rows);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
      pendingRef.current = false;
    }
  }, [limit]);

  useEffect(() => {
    refresh();
  }, [refresh, completionCounter]);

  return useMemo<UseExecutionsResult>(
    () => ({ executions, loading, error, refresh }),
    [executions, loading, error, refresh],
  );
}
