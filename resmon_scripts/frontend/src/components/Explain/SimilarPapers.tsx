import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client';

/**
 * "Papers like this one" — the nearest neighbours of one paper, by vector.
 *
 * Sits beside `WhyThisPaper` and borrows its shape deliberately: collapsed by
 * default, fetched on first open, one request per paper. Fifty of these firing
 * on page load would be indefensible even though each is cheap.
 *
 * **The distance is shown, not hidden behind a word.** "Similar" is a judgement
 * and resmon is not making one; a number a user can compare between neighbours
 * is a fact. Two papers at 0.12 and 0.71 are not equally like this one, and a
 * list that presented them identically would be implying they are.
 *
 * **The source is on every row.** "The same paper from another repository" and
 * "a different paper on the same subject" look identical in a list of titles,
 * and the source is what tells them apart. Cross-source near-duplicates are
 * 1.9b's subject; until then this is where a user notices them.
 *
 * An empty list always carries the backend's reason. "This paper is not
 * embedded", "nothing else is" and "this build cannot load the extension" are
 * three different situations, and rendering a bare "nothing similar" for any of
 * them would be a claim about the corpus made from a fact about the setup.
 */

export interface Neighbour {
  id: number;
  title: string;
  authors: string | null;
  publication_date: string | null;
  doi: string | null;
  url: string | null;
  source_repository: string;
  distance: number;
}

interface SimilarResponse {
  document_id: number;
  model: string | null;
  neighbours: Neighbour[];
  reason: string | null;
}

interface Props {
  documentId: number;
  /** How many neighbours to ask for. */
  k?: number;
}

const SimilarPapers: React.FC<Props> = ({ documentId, k = 5 }) => {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SimilarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiClient.get<SimilarResponse>(
        `/api/documents/${documentId}/similar?k=${k}`,
      ));
    } catch (err: any) {
      setError(err?.message || 'Could not look for similar papers.');
    } finally {
      setLoading(false);
    }
  }, [documentId, k]);

  useEffect(() => {
    if (open && !data && !loading && !error) void load();
  }, [open, data, loading, error, load]);

  return (
    <div className="similar-panel">
      <button
        type="button"
        className="why-toggle"
        aria-expanded={open}
        data-testid="similar-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide similar papers' : 'Papers like this one'}
      </button>

      {open && (
        <div className="similar-body" data-testid="similar-body">
          {loading && <p className="text-muted">Looking…</p>}
          {error && <p className="why-error">{error}</p>}

          {data && data.neighbours.length === 0 && (
            <p className="text-muted" data-testid="similar-reason">
              {data.reason || 'No similar papers were found.'}
            </p>
          )}

          {data && data.neighbours.length > 0 && (
            <>
              <ul className="similar-list">
                {data.neighbours.map((n) => (
                  <li key={n.id} className="similar-item">
                    <span className="similar-distance" title="Vector distance — smaller is closer">
                      {n.distance.toFixed(3)}
                    </span>
                    <span className="similar-title">
                      {n.url ? (
                        <a href={n.url} target="_blank" rel="noreferrer noopener">{n.title}</a>
                      ) : n.title}
                    </span>
                    <span className="similar-source">{n.source_repository}</span>
                    {n.publication_date && (
                      <span className="similar-date">{n.publication_date}</span>
                    )}
                  </li>
                ))}
              </ul>
              {/*
                Not a footnote. A neighbour list is the one place a reader is
                most likely to read a machine's arithmetic as a judgement, and
                the model that produced it is part of the answer.
              */}
              <p className="similar-limits">
                Distances come from <strong>{data.model}</strong> and compare the title
                and abstract resmon stored — not the full text, which resmon does not
                have. A close paper is one whose wording this model places nearby; it is
                not a claim that the two are about the same thing.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default SimilarPapers;
