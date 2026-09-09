import { useEffect, useState } from 'react';
import { apiClient } from './client';

export interface CoverageSource {
  source: string;
  category: 'answered' | 'non_answer' | 'unknown';
  label: string;
  note: string;
  result_count: number | null;
  recorded_at: string | null;
  outcome_recorded: boolean;
  genuine_empty: boolean;
}
export interface SourceCoverage {
  execution_id: number;
  basis: 'selected' | 'recorded';
  basis_label: string;
  selection_known: boolean;
  total: number;
  counts: { answered: number; non_answer: number; unknown: number; genuine_empty: number };
  summary: string;
  sources: CoverageSource[];
  additional_sources: CoverageSource[];
  notes: string[];
}
interface SourceRow {
  coverage?: CoverageSource;
  source: string;
  records_identified: number;
  status: string;
  /** Why this source returned nothing, or "not_recorded". Null when it did. */
  zero_reason: string | null;
  /** Whether the source replied at all — not the same as status === 'ok'. */
  answered: boolean;
  note: string | null;
}

export interface DedupBlock {
  count: number | null;
  prisma: string | null;
  meaning: string;
  recorded?: boolean;
  not_recorded_reason?: string | null;
}

export interface SearchRecordData {
  coverage?: SourceCoverage;
  generated_at: string;
  software: { name: string; version: string; citation: string };
  search: {
    execution_id: number;
    run_at: string;
    completed_at: string | null;
    status: string;
    keywords: string[];
    query_as_sent: string | null;
    date_from: string | null;
    date_to: string | null;
    max_results_per_source: number | null;
    routine_name: string | null;
    routine_schedule: string | null;
    configuration_name: string | null;
  };
  sources: SourceRow[];
  identification: {
    records_identified: number;
    sources_searched: number;
    sources_that_answered: number;
    prisma: string;
  };
  deduplication: {
    records_processed: number | null;
    cross_source_duplicates: DedupBlock;
    already_held: DedupBlock;
    discarded_unusable: DedupBlock;
    records_added: DedupBlock;
  };
  caveats: string[];
}


export interface SearchRecordState {
  data: SearchRecordData | null;
  error: string | null;
  retry: () => void;
}

export function useSearchRecord(executionId: number, enabled = true, revision: unknown = null): SearchRecordState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ id: number; data: SearchRecordData | null; error: string | null }>({ id: executionId, data: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ id: executionId, data: null, error: null });
    apiClient.get<SearchRecordData>(`/api/executions/${executionId}/search-record`)
      .then(data => {
        if (cancelled) return;
        if (data.search.execution_id !== executionId || (data.coverage && data.coverage.execution_id !== executionId)) {
          throw new Error('Search record execution identity mismatch.');
        }
        setState({ id: executionId, data, error: null });
      }).catch((error: unknown) => {
        if (!cancelled) setState({ id: executionId, data: null, error: error instanceof Error ? error.message : 'Could not build the search record.' });
      });
    return () => { cancelled = true; };
  }, [executionId, enabled, attempt, revision]);
  return { data: state.id === executionId ? state.data : null,
    error: state.id === executionId ? state.error : null, retry: () => setAttempt(a => a + 1) };
}
