import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client';

/**
 * "Why am I seeing this?" — the per-paper match explanation.
 *
 * The design constraint is the whole feature: resmon does not know why an
 * upstream relevance-ranked source returned a paper, and this panel must never
 * imply that it does. So the layout puts three things on equal footing rather
 * than burying the third:
 *
 *   1. Which keywords are locally verifiable, and in which field.
 *   2. A headline that grades the *explanation*, not the paper.
 *   3. What resmon cannot see — shown always, including when everything matched.
 *
 * That third block is the one a normal product would hide behind a tooltip.
 * Here it is the point: a researcher defending a search strategy needs to know
 * the limits of the evidence, and a match in the title is evidence that a paper
 * is plausible, not evidence of the upstream's reasoning.
 *
 * Collapsed by default. Nobody wants this on fifty results at once, and it
 * costs a request per paper.
 */

type Verdict =
  | 'resmon_filtered'
  | 'local_evidence'
  | 'no_local_evidence'
  | 'no_keywords_recorded';

interface KeywordMatch {
  keyword: string;
  matched: boolean;
  fields: string[];
  where: string;
  contains_operators: boolean;
}

interface Run {
  execution_id: number;
  execution_type: string;
  start_time: string;
  routine_name: string | null;
  keywords: string[];
}

interface Explanation {
  document: { id: number; title: string; source_repository: string };
  source: {
    slug: string;
    name: string;
    keyword_combination: string | null;
    keyword_combination_notes: string | null;
    resmon_filtered_locally: boolean;
  };
  runs: Run[];
  keywords: KeywordMatch[];
  matched_count: number;
  keyword_count: number;
  verdict: Verdict;
  headline: string;
  what_resmon_cannot_see: string[];
  fields_checked: string[];
}

/**
 * The verdict grades how much of the answer resmon actually has — never
 * whether the paper is any good. Judging relevance is the user's call, and a
 * tool that made it would be the opaque recommender this feature exists to be
 * an alternative to.
 */
const VERDICT_LABEL: Record<Verdict, string> = {
  resmon_filtered: 'resmon matched this itself',
  local_evidence: 'Matched locally',
  no_local_evidence: 'No local match',
  no_keywords_recorded: 'No keywords recorded',
};

interface Props {
  documentId: number;
  /** Restricts the explanation to one run's keywords. */
  executionId?: number;
}

const WhyThisPaper: React.FC<Props> = ({ documentId, executionId }) => {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = executionId ? `?execution_id=${executionId}` : '';
      setData(await apiClient.get<Explanation>(`/api/documents/${documentId}/why${q}`));
    } catch (err: any) {
      setError(err?.message || 'Could not work out why this paper is here.');
    } finally {
      setLoading(false);
    }
  }, [documentId, executionId]);

  // Fetched on first open, not on mount: this renders once per result row and
  // fifty requests to fill a panel nobody opened would be indefensible.
  useEffect(() => {
    if (open && !data && !loading && !error) void load();
  }, [open, data, loading, error, load]);

  return (
    <div className="why-panel">
      <button
        type="button"
        className="why-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide why' : 'Why am I seeing this?'}
      </button>

      {open && (
        <div className="why-body">
          {loading && <p className="text-muted">Checking…</p>}
          {error && <p className="why-error">{error}</p>}

          {data && (
            <>
              <p className={`why-verdict why-verdict-${data.verdict}`}>
                <span className="why-chip">{VERDICT_LABEL[data.verdict]}</span>
                {data.headline}
              </p>

              {data.keywords.length > 0 && (
                <ul className="why-keywords">
                  {data.keywords.map((k) => (
                    <li key={k.keyword} className={k.matched ? 'why-hit' : 'why-miss'}>
                      <span className="why-keyword">{k.keyword}</span>
                      <span className="why-where">
                        {k.matched ? `found in ${k.where}` : k.where}
                      </span>
                      {k.contains_operators && (
                        <span className="why-note">
                          contains AND/OR/NOT — resmon checked the literal text
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {data.runs.length > 1 && (
                <p className="why-runs">
                  Returned by {data.runs.length} runs
                  {data.runs.some((r) => r.routine_name) && (
                    <>
                      {' '}including{' '}
                      {data.runs
                        .filter((r) => r.routine_name)
                        .map((r) => r.routine_name)
                        .join(', ')}
                    </>
                  )}
                  . The keywords above are the union of all of them.
                </p>
              )}

              {/*
                Never collapsed, never a tooltip. The limits of the evidence are
                as much a part of the answer as the evidence.
              */}
              <div className="why-limits">
                <p className="why-limits-label">What resmon cannot see</p>
                <ul>
                  {data.what_resmon_cannot_see.map((limit) => (
                    <li key={limit}>{limit}</li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default WhyThisPaper;
