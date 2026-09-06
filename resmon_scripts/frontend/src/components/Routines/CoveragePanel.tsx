import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client';

/**
 * "Is this routine finding what I meant?" — the coverage audit, on one routine.
 *
 * Two lists and a caveat, and the caveat is not a footnote. resmon has no idea
 * what exists in the literature and is not in its corpus, so *missed* here means
 * "this routine never returned it and something else found it" — never "missed
 * by resmon". The sentence comes from the backend (`cannot_see`) rather than
 * being written here, so the page, the report and the MCP surface cannot drift
 * into three different promises.
 *
 * **Distance is not relevance and the wording never says it is.** A paper far
 * from the intent vector is one this model places elsewhere; the model has not
 * read it and is wrong sometimes. So the off-target list is headed as the
 * results that sit *furthest from the intent*, which is what was measured, and
 * not as the results that are wrong — the same grading the watchdog uses for
 * "looks unusual" rather than "broken".
 *
 * Fetched on demand. The audit runs two vector queries and embeds the intent, so
 * a Routines page with eight routines must not run eight of them on mount.
 */

interface Row {
  id: number;
  distance: number;
  title: string;
  source_repository: string;
  publication_date: string | null;
  url: string | null;
}

interface Distribution {
  count: number;
  min: number;
  median: number;
  p75_cutoff: number;
  max: number;
}

interface Coverage {
  routine_id: number;
  routine_name: string | null;
  intent: string;
  intent_source: 'stated' | 'keywords';
  model: string | null;
  cannot_see: string;
  results: number;
  results_embedded: number;
  off_target: Row[];
  missed_in_corpus: Row[];
  distribution: Distribution | null;
  reason: string | null;
  summary?: string | null;
}

const nf = new Intl.NumberFormat();

const PaperList: React.FC<{ rows: Row[] }> = ({ rows }) => (
  <ul className="coverage-list">
    {rows.map((row) => (
      <li key={row.id} className="coverage-item">
        <span className="coverage-distance" title="Distance from the routine's intent">
          {row.distance.toFixed(3)}
        </span>
        <span className="coverage-title">
          {row.url ? (
            <a href={row.url} target="_blank" rel="noreferrer noopener">{row.title}</a>
          ) : row.title}
        </span>
        <span className="coverage-source">{row.source_repository}</span>
        {row.publication_date && (
          <span className="coverage-date">{row.publication_date}</span>
        )}
      </li>
    ))}
  </ul>
);

const CoveragePanel: React.FC<{ routineId: number }> = ({ routineId }) => {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Coverage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.get<Coverage>(`/api/routines/${routineId}/coverage`));
    } catch (err: any) {
      setError(err?.message || 'Could not audit this routine.');
    } finally {
      setLoading(false);
    }
  }, [routineId]);

  useEffect(() => {
    if (open && !data && !loading && !error) void load();
  }, [open, data, loading, error, load]);

  return (
    <div className="coverage-panel">
      <button
        type="button"
        className="why-toggle"
        aria-expanded={open}
        data-testid="coverage-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide coverage' : 'Is this finding what I meant?'}
      </button>

      {open && (
        <div className="coverage-body" data-testid="coverage-body">
          {loading && <p className="text-muted">Checking…</p>}
          {error && <p className="why-error">{error}</p>}

          {data && (
            <>
              <p className="coverage-intent" data-testid="coverage-intent">
                Comparing against{' '}
                <strong>{data.intent || '(nothing)'}</strong>
                {data.intent_source === 'keywords' ? (
                  <>
                    {' '}— this routine&rsquo;s <em>keywords</em>, because no intent has been
                    written for it. That measures the query against results the query
                    produced, so read it as a rough guide: write a sentence describing what
                    the routine is for and this becomes a real check.
                  </>
                ) : (
                  <> — the intent written for this routine.</>
                )}
              </p>

              {data.reason && (
                <p className="text-muted" data-testid="coverage-reason">{data.reason}</p>
              )}

              {data.distribution && (
                <p className="text-muted" data-testid="coverage-distribution">
                  {nf.format(data.results_embedded)} of {nf.format(data.results)} results
                  are embedded. Distance from the intent runs{' '}
                  {data.distribution.min.toFixed(3)} to {data.distribution.max.toFixed(3)},
                  median {data.distribution.median.toFixed(3)}; the quarter beyond{' '}
                  {data.distribution.p75_cutoff.toFixed(3)} is listed below.
                </p>
              )}

              {data.off_target.length > 0 && (
                <>
                  <h4>Furthest from the intent</h4>
                  <p className="text-muted">
                    These sit at the far end of this routine&rsquo;s own distribution. That
                    is a prompt to look, not a verdict — the model has not read them.
                  </p>
                  <PaperList rows={data.off_target} />
                </>
              )}

              {data.missed_in_corpus.length > 0 && (
                <>
                  <h4>Already collected, never returned by this routine</h4>
                  <p className="text-muted">
                    Close to the intent, and found by some other routine or manual sweep.
                    A keyword gap is the usual explanation.
                  </p>
                  <PaperList rows={data.missed_in_corpus} />
                </>
              )}

              {/*
                Never collapsed, never a tooltip — the same treatment
                `WhyThisPaper` gives its limits, and for the same reason: the
                boundary of the evidence is part of the answer.
              */}
              <div className="why-limits">
                <p className="why-limits-label">What this cannot see</p>
                <p data-testid="coverage-cannot-see">{data.cannot_see}</p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default CoveragePanel;
