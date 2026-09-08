import React, { useCallback, useEffect, useRef, useState } from 'react';
import TutorialLinkButton from '../components/AboutResmon/TutorialLinkButton';
import PageHelp from '../components/Help/PageHelp';
import PaperCard from '../components/Reading/PaperCard';
import {
  READING_PAGE_SIZE, ReadingFilter, ReadingQueueEntry, ReadingQueuePage as QueuePage,
  readingQueueApi,
} from '../api/readingQueue';
import { downloadReferences, ReferenceFormat } from '../lib/referenceDownload';

/**
 * The papers you meant to read.
 *
 * resmon could find a paper and could export a whole run, and had nowhere to
 * put the four papers out of four hundred that were actually worth reading.
 * This page is that place: membership over the corpus, with two states, and
 * nothing else pretending to be a research workflow. There are no notes, no
 * PDFs, no reminders and no ranking here, and each of those absences is a
 * decision rather than an omission — a queue that quietly becomes a reference
 * manager is a queue nobody trusts to be complete.
 *
 * **To read is the default view**, because that is the question the page
 * answers: what is left. Read and All are there for going back to something.
 *
 * **State on screen is state the backend confirmed.** Every control waits for
 * its response before the row changes, and a failure says so and leaves the
 * row alone. A queue that shows a paper as read because a click was registered
 * is worse than one that shows an error.
 *
 * **Selection is per page and says so.** Changing the filter or the page clears
 * it, because an export that quietly carries papers the user can no longer see
 * is an export they cannot check.
 */

const FILTERS: { key: ReadingFilter; label: string }[] = [
  { key: 'to_read', label: 'To read' },
  { key: 'read', label: 'Read' },
  { key: 'all', label: 'All' },
];

function dateOnly(stamp: string | null): string {
  if (!stamp) return '';
  return stamp.slice(0, 10);
}

const ReadingQueuePage: React.FC = () => {
  const [filter, setFilter] = useState<ReadingFilter>('to_read');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<QueuePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  /** Same stale-response guard as the Papers tab: the last request wins. */
  const requestId = useRef(0);

  const load = useCallback(async (nextFilter: ReadingFilter, nextOffset: number) => {
    const mine = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const result = await readingQueueApi.list(nextFilter, READING_PAGE_SIZE, nextOffset);
      if (mine !== requestId.current) return;
      setPage(result);
      setOffset(result.offset);
    } catch (err: unknown) {
      if (mine !== requestId.current) return;
      setPage(null);
      setError(err instanceof Error
        ? `Could not load your reading queue: ${err.message}`
        : 'Could not load your reading queue.');
    } finally {
      if (mine === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load('to_read', 0); }, [load]);

  /** Any move between views drops the selection along with the rows it named. */
  const go = (nextFilter: ReadingFilter, nextOffset: number) => {
    setSelected(new Set());
    setExportError('');
    setFilter(nextFilter);
    setOffset(nextOffset);
    void load(nextFilter, nextOffset);
  };

  /**
   * Re-read the current page after a change, so counts, paging and the row all
   * come from the database rather than from an edit applied locally.
   */
  const refresh = () => load(filter, offset);

  const withBusy = async (documentId: number, work: () => Promise<void>) => {
    setActionError('');
    setBusy((prev) => new Set(prev).add(documentId));
    try {
      await work();
      await refresh();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'That did not go through.');
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(documentId);
        return next;
      });
    }
  };

  const handleToggleRead = (entry: ReadingQueueEntry) => withBusy(entry.document_id, async () => {
    await readingQueueApi.setStatus(
      entry.document_id, entry.status === 'read' ? 'to_read' : 'read',
    );
  });

  const handleRemove = (entry: ReadingQueueEntry) => withBusy(entry.document_id, async () => {
    await readingQueueApi.remove(entry.document_id);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(entry.document_id);
      return next;
    });
  });

  const toggleSelected = (documentId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(documentId)) next.delete(documentId); else next.add(documentId);
      return next;
    });
  };

  const entries = page?.entries ?? [];
  const allOnPageSelected = entries.length > 0
    && entries.every((e) => selected.has(e.document_id));

  const toggleAllOnPage = () => {
    setSelected(allOnPageSelected
      ? new Set()
      : new Set(entries.map((e) => e.document_id)));
  };

  const handleExport = async (fmt: ReferenceFormat) => {
    if (selected.size === 0) return;
    setExportError('');
    setExporting(true);
    try {
      await downloadReferences(
        { document_ids: Array.from(selected) }, fmt, 'resmon-reading-queue',
      );
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : 'Reference export failed.');
    } finally {
      setExporting(false);
    }
  };

  const total = page?.total ?? 0;
  const shown = entries.length;
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + shown;
  const hasPrev = offset > 0;
  const hasNext = offset + shown < total;
  const counts = page?.counts;

  return (
    <div className="page-content">
      <div className="page-header">
        <h1>Reading queue</h1>
        <TutorialLinkButton anchor="reading-queue" />
        <div className="form-actions">
          <button
            className="btn btn-secondary"
            onClick={() => void handleExport('bibtex')}
            disabled={selected.size === 0 || exporting}
            title="Export the papers selected on this page as BibTeX"
          >
            BibTeX
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void handleExport('ris')}
            disabled={selected.size === 0 || exporting}
            title="Export the papers selected on this page as RIS"
          >
            RIS
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void handleExport('csv')}
            disabled={selected.size === 0 || exporting}
            title="Export the papers selected on this page as CSV"
          >
            CSV
          </button>
        </div>
      </div>

      <PageHelp
        storageKey="reading-queue"
        title="Reading queue"
        summary="The papers you saved from a run, and whether you have read them."
        sections={[
          {
            heading: 'What this is, and what it is not',
            body: (
              <>
                <p>
                  Save a paper from <strong>Results &amp; Logs → Papers</strong> and it
                  appears here. Each paper is either <strong>To read</strong> or{' '}
                  <strong>Read</strong>; that is the whole of the state resmon keeps.
                </p>
                <p>
                  It holds no notes, no PDFs and no reminders, and it does not rank or
                  score anything. It is a list of what you meant to read, kept beside
                  the corpus rather than inside a second one.
                </p>
              </>
            ),
          },
          {
            heading: 'The paper, not a copy of it',
            body: (
              <p>
                A saved paper is a pointer to the record resmon already stored, so the
                metadata and the <strong>Why this paper?</strong> evidence you see here
                are the same ones the Explorer shows. When a later run finds the same
                record again, it keeps the state you gave it — saving it a second time
                does not move a paper you have read back to <em>To read</em>. Two stored
                records that look like the same work stay two papers here, because they
                are two papers everywhere else in resmon.
              </p>
            ),
          },
          {
            heading: 'Removing',
            body: (
              <p>
                <strong>Remove</strong> takes the paper out of this list and does nothing
                else: the paper, its authors, and every run that found it are untouched,
                and it is still in the Explorer. Save it again later and it starts fresh
                at <em>To read</em>. The only thing in resmon that deletes a paper is{' '}
                <strong>Settings → Advanced</strong>, which you operate yourself.
              </p>
            ),
          },
          {
            heading: 'Exporting',
            body: (
              <p>
                Tick the papers you want and use <strong>BibTeX</strong>,{' '}
                <strong>RIS</strong> or <strong>CSV</strong>. The export covers the
                papers ticked <em>on the page you are looking at</em> — changing the
                page or the filter clears the ticks, so nothing you cannot see ends up
                in the file. It is the same exporter Results &amp; Logs uses, so the
                formats and the citation keys behave identically.
              </p>
            ),
          },
        ]}
      />

      <div className="card reading-controls">
        <div className="reading-filters" role="group" aria-label="Filter the reading queue">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              // `btn-secondary` and a bare `btn` are nearly the same colour, so
              // the selected filter takes the accent the app uses for a live
              // control. `aria-pressed` carries the same fact for a reader who
              // is not looking at the colour.
              className={`btn btn-sm ${filter === f.key ? 'btn-primary' : 'btn-secondary'}`}
              aria-pressed={filter === f.key}
              onClick={() => go(f.key, 0)}
              data-testid={`filter-${f.key}`}
            >
              {f.label}
              {counts && (
                <span className="reading-count">
                  {' '}
                  {f.key === 'all' ? counts.all : counts[f.key]}
                </span>
              )}
            </button>
          ))}
        </div>
        {entries.length > 0 && (
          <label className="reading-select-all">
            <input
              type="checkbox"
              checked={allOnPageSelected}
              onChange={toggleAllOnPage}
              aria-label="Select every paper on this page"
            />
            {' '}
            Select this page ({selected.size} selected on this page)
          </label>
        )}
      </div>

      {error && <div className="form-error" role="alert" data-testid="queue-error">{error}</div>}
      {actionError && (
        <div className="form-error" role="alert" data-testid="queue-action-error">{actionError}</div>
      )}
      {exportError && (
        <div className="form-error" role="alert" data-testid="queue-export-error">{exportError}</div>
      )}

      {loading && <p className="text-muted" role="status">Loading your reading queue…</p>}

      {!loading && !error && total === 0 && (
        <div className="card" data-testid="queue-empty">
          {counts && counts.all === 0 ? (
            <>
              <h2>Nothing saved yet</h2>
              <p>
                Open a run in <strong>Results &amp; Logs</strong>, switch to its{' '}
                <strong>Papers</strong> tab, and save the ones worth reading.
              </p>
            </>
          ) : (
            <p>
              Nothing in <strong>{FILTERS.find((f) => f.key === filter)?.label}</strong>.
              {' '}
              {filter === 'to_read'
                ? 'Everything you saved has been read.'
                : 'Try another filter.'}
            </p>
          )}
        </div>
      )}

      {!loading && !error && total > 0 && (
        <>
          <div className="reading-pager">
            <p className="text-muted" data-testid="queue-range">
              Showing {first}–{last} of {total}
            </p>
            <div className="form-actions">
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => go(filter, Math.max(0, offset - READING_PAGE_SIZE))}
                disabled={!hasPrev}
              >
                Previous
              </button>
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => go(filter, offset + READING_PAGE_SIZE)}
                disabled={!hasNext}
              >
                Next
              </button>
            </div>
          </div>

          <ul className="reading-list">
            {entries.map((entry) => (
              <PaperCard
                key={entry.document_id}
                document={entry.document}
                lead={(
                  <input
                    type="checkbox"
                    checked={selected.has(entry.document_id)}
                    onChange={() => toggleSelected(entry.document_id)}
                    aria-label={`Select “${entry.document.title}” for export`}
                    data-testid={`select-${entry.document_id}`}
                  />
                )}
                note={(
                  <>
                    <span
                      className={`reading-state reading-state-${entry.status}`}
                      data-testid={`state-${entry.document_id}`}
                    >
                      {entry.status === 'read' ? 'Read' : 'To read'}
                    </span>
                    <span>Saved {dateOnly(entry.saved_at)}</span>
                    {entry.read_at && <span>Read {dateOnly(entry.read_at)}</span>}
                  </>
                )}
                actions={(
                  <>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => void handleToggleRead(entry)}
                      disabled={busy.has(entry.document_id)}
                      data-testid={`toggle-${entry.document_id}`}
                    >
                      {entry.status === 'read' ? 'Mark unread' : 'Mark read'}
                    </button>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => void handleRemove(entry)}
                      disabled={busy.has(entry.document_id)}
                      title="Take this paper out of the queue. The paper itself is kept."
                      data-testid={`remove-${entry.document_id}`}
                    >
                      Remove
                    </button>
                  </>
                )}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

export default ReadingQueuePage;
