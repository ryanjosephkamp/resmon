import React, { useCallback, useEffect, useRef, useState } from 'react';
import PaperCard from '../Reading/PaperCard';
import {
  ExecutionPaper, ExecutionPapersPage, READING_PAGE_SIZE, readingQueueApi,
} from '../../api/readingQueue';

/**
 * The Papers tab of a run: what this execution actually found, one paper at a
 * time, each with a Save button.
 *
 * Results & Logs could show a run's Markdown report and export the whole run's
 * references, and nothing in between — there was no way to pick out the three
 * papers worth reading from a sweep that returned four hundred. Reading the
 * ids out of the rendered report was never an option: the report is prose, and
 * an execution id is not a paper id.
 *
 * Paged rather than infinite, because the point of this tab is to work through
 * a run rather than to browse the corpus — the Explorer is for browsing. The
 * default page is `READING_PAGE_SIZE`, matching the backend's own default.
 *
 * **Saved state comes from the backend, never from what the user clicked.**
 * Each row shows `queue_status` as the server returned it, and a Save updates
 * the row only after the response arrives. A save that fails leaves the row
 * saying what is true — not saved — and puts the reason on screen.
 */

interface Props {
  executionId: number;
}

const ExecutionPapers: React.FC<Props> = ({ executionId }) => {
  const [page, setPage] = useState<ExecutionPapersPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<Set<number>>(new Set());
  const [saveError, setSaveError] = useState('');

  /**
   * Which fetch is the current one.
   *
   * Clicking Next twice quickly starts two requests, and the first can answer
   * last. `ReportViewer` carries the same guard for the same reason: a stale
   * response that wins is a page of papers belonging to an offset the user has
   * already left.
   */
  const requestId = useRef(0);

  const load = useCallback(async (nextOffset: number) => {
    const mine = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const result = await readingQueueApi.papers(executionId, READING_PAGE_SIZE, nextOffset);
      if (mine !== requestId.current) return;
      setPage(result);
      setOffset(result.offset);
    } catch (err: unknown) {
      if (mine !== requestId.current) return;
      setPage(null);
      setError(err instanceof Error
        ? `Could not load this run’s papers: ${err.message}`
        : 'Could not load this run’s papers.');
    } finally {
      if (mine === requestId.current) setLoading(false);
    }
  }, [executionId]);

  useEffect(() => {
    setOffset(0);
    void load(0);
  }, [load]);

  const handleSave = async (paper: ExecutionPaper) => {
    setSaveError('');
    setSaving((prev) => new Set(prev).add(paper.id));
    try {
      const entry = await readingQueueApi.save(paper.id);
      // The backend answers with the entry as it stands, which for a paper the
      // user already read is still `read` — saving never resets that.
      setPage((prev) => (prev ? {
        ...prev,
        papers: prev.papers.map((p) => (
          p.id === paper.id ? { ...p, queue_status: entry.status } : p
        )),
      } : prev));
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Could not save that paper.');
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(paper.id);
        return next;
      });
    }
  };

  const total = page?.total ?? 0;
  const shown = page?.papers.length ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + shown;
  const hasPrev = offset > 0;
  const hasNext = offset + shown < total;

  return (
    <div className="reading-papers" data-testid="execution-papers">
      {loading && <p className="text-muted" role="status">Loading papers…</p>}

      {!loading && error && (
        <div className="form-error" role="alert" data-testid="papers-error">{error}</div>
      )}

      {!loading && !error && total === 0 && (
        <p className="text-muted" data-testid="papers-empty">
          This run stored no papers, so there is nothing to save from it.
        </p>
      )}

      {!loading && !error && total > 0 && (
        <>
          <div className="reading-pager" data-testid="papers-pager">
            <p className="text-muted" data-testid="papers-range">
              Papers {first}–{last} of {total}
            </p>
            <div className="form-actions">
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => void load(Math.max(0, offset - READING_PAGE_SIZE))}
                disabled={!hasPrev}
              >
                Previous
              </button>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => void load(offset + READING_PAGE_SIZE)}
                disabled={!hasNext}
              >
                Next
              </button>
            </div>
          </div>

          {saveError && (
            <div className="form-error" role="alert" data-testid="papers-save-error">{saveError}</div>
          )}

          <ul className="reading-list">
            {page!.papers.map((paper) => (
              <PaperCard
                key={paper.id}
                document={paper}
                executionId={executionId}
                actions={paper.queue_status ? (
                  <span className="reading-saved-badge" data-testid={`saved-${paper.id}`}>
                    {paper.queue_status === 'read' ? 'In queue · Read' : 'In queue · To read'}
                  </span>
                ) : (
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => void handleSave(paper)}
                    disabled={saving.has(paper.id)}
                    aria-label={`Save “${paper.title}” to the reading queue`}
                    data-testid={`save-${paper.id}`}
                  >
                    {saving.has(paper.id) ? 'Saving…' : 'Save to read'}
                  </button>
                )}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

export default ExecutionPapers;
