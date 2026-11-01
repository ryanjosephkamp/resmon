import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { exportReferences, FORMATS, type ReferenceFormat } from '../runs/references';
import { authors, count, number } from '../today/format';
import { invalidateFor } from '../today/freshness';
import { queueWords } from '../collection/Paper';
import { LibraryTabs } from './LibraryTabs';
import { pageRange, pageToRead, QUEUE_PAGE, selectedOnPage } from './queueModel';

type Filter = 'to_read' | 'read' | 'all';

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'to_read', label: 'To read' },
  { id: 'read', label: 'Read' },
  { id: 'all', label: 'All' },
];

/**
 * Library › Reading queue: the papers saved to read, read or not yet.
 *
 * Saved from a run or from a paper's page. Marking one read keeps it here
 * under Read; removing it takes it out of the queue and leaves the paper in
 * the collection. Selected papers export together, one entry each.
 *
 * A queue longer than one page is read a page at a time (`queueModel.ts`).
 * Ticks belong to the page they were made on: moving to another page or
 * another filter clears them, and an export takes only the ticked papers
 * still on the page, so what it says it exports is what is on screen.
 */
export function ReadingQueue() {
  const client = useQueryClient();
  const [filter, setFilter] = useState<Filter>('to_read');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const queue = useQuery({
    queryKey: ['reading-queue', filter, offset],
    queryFn: () => answer(engine().GET('/api/reading-queue', { params: { query: { status: filter, limit: QUEUE_PAGE, offset } } })),
    // The page on screen stays while the next one is read, under the same
    // filter only: another filter's rows are not drawn under this one's name.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === filter ? previous : undefined),
  });
  // A page that stopped existing (its last paper removed, or marked read
  // under To read) gives way to the last page there is. Set while rendering,
  // as React's own pattern for state that follows other state: the next
  // render reads that page, and the empty one is never drawn.
  const moveTo = queue.data && !queue.isPlaceholderData ? pageToRead(queue.data) : null;
  if (moveTo !== null && moveTo !== offset) setOffset(moveTo);
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((e) => [e.slug, e.name])), [catalog.data]);
  // After a change, every other page and filter read before it holds counts
  // that are no longer true, so those are dropped rather than drawn on the way
  // to a fresh read; the page on screen is read again.
  const refresh = () => {
    client.removeQueries({ queryKey: ['reading-queue'], type: 'inactive' });
    void client.invalidateQueries({ queryKey: ['reading-queue'] });
    void invalidateFor(client, 'paper-changed');
  };
  const mark = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 'read' | 'to_read' }) => answer(engine().PUT('/api/reading-queue/{document_id}', {
      params: { path: { document_id: id } }, body: { status },
    })),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: number) => answer(engine().DELETE('/api/reading-queue/{document_id}', { params: { path: { document_id: id } } })),
    onSuccess: (_done, id) => { setSelected((s) => s.filter((x) => x !== id)); refresh(); },
  });
  const exporting = useMutation({
    mutationFn: ({ ids, format }: { ids: number[]; format: ReferenceFormat }) => (
      exportReferences({ document_ids: ids }, format, 'resmon-reading-queue')
    ),
  });

  const counts = queue.data?.counts;
  const entries = queue.data?.entries ?? [];
  // Read from the page that arrived, not from the offset asked for: while the
  // next page is read, the range and the buttons describe the rows on screen.
  const at = queue.data?.offset ?? 0;
  const total = queue.data?.total ?? 0;
  const range = pageRange(at, entries.length, total);
  const paged = at > 0 || total > entries.length;
  const ticked = queue.isPlaceholderData ? [] : selectedOnPage(selected, entries);
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const turnTo = (next: number) => { setSelected([]); exporting.reset(); setOffset(next); };

  return (
    <div className="page library">
      <LibraryTabs />
      <div className="library-head">
        <h1 className="page-title">Reading queue</h1>
      </div>
      <p className="page-lede">Papers you saved from a run or from a paper&rsquo;s page. Removing one leaves it in your collection.</p>
      {/* The list's own control, so it sits with the list at any width rather than at the far edge of an empty row. */}
      <div className="seg queue-show" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={filter === f.id}
            onClick={() => { setFilter(f.id); setOffset(0); setSelected([]); exporting.reset(); }}>
            {f.label}{counts ? <span className="seg-n num">{number(counts[f.id])}</span> : null}
          </button>
        ))}
      </div>

      {ticked.length > 0 && (
        <div className="export-bar queue-export" role="group" aria-label="Export the selected papers" data-queue="export">
          <span>{count(ticked.length, 'paper')}: export as</span>
          {FORMATS.map((format) => (
            <button key={format.id} type="button" className="btn sm" disabled={exporting.isPending}
              onClick={() => exporting.mutate({ ids: ticked, format: format.id })}>{format.label}</button>
          ))}
          <button type="button" className="btn quiet sm" onClick={() => setSelected([])}>Clear</button>
          {exporting.error && <p className="field-error" role="alert">{exporting.error.message}</p>}
        </div>
      )}

      <section className="queue" aria-label="Saved papers" aria-busy={queue.isFetching}>
        {queue.isPending && <p className="index-cap">Reading the queue.</p>}
        {queue.isError && <p className="index-cap">The queue could not be read ({queue.error.message}).</p>}
        {queue.data && !total && (
          <p className="index-empty queue-empty">
            {filter === 'read' ? 'Nothing is marked read yet.' : filter === 'to_read' ? 'Nothing is waiting to be read.' : 'The queue is empty.'}
          </p>
        )}
        <ol className="queue-list">
          {entries.map((entry) => {
            const doc = entry.document;
            return (
              <li key={entry.document_id} className="queue-row" data-document={entry.document_id} data-status={entry.status}>
                <input
                  type="checkbox"
                  checked={ticked.includes(entry.document_id)}
                  disabled={queue.isPlaceholderData}
                  onChange={() => toggle(entry.document_id)}
                  aria-label={`Select ${doc?.title ?? `paper ${entry.document_id}`} for export`}
                />
                <div className="queue-body">
                  <Link to={`/papers/${entry.document_id}`} className="queue-title">{doc?.title ?? `Paper ${entry.document_id}`}</Link>
                  <div className="meta">
                    <span className="who">{authors(doc?.authors)}</span>
                    {doc?.source_repository && (<><span className="sep" /><span>{names.get(doc.source_repository) ?? doc.source_repository}</span></>)}
                    <span className="sep" />
                    <span className="queue-state" data-status={entry.status}>{queueWords(entry.status)}</span>
                  </div>
                </div>
                <div className="queue-acts">
                  <button type="button" className="btn sm" disabled={mark.isPending}
                    onClick={() => mark.mutate({ id: entry.document_id, status: entry.status === 'read' ? 'to_read' : 'read' })}>
                    {entry.status === 'read' ? 'Mark unread' : 'Mark read'}
                  </button>
                  <button type="button" className="btn quiet sm" disabled={remove.isPending}
                    onClick={() => remove.mutate(entry.document_id)}>Remove</button>
                </div>
              </li>
            );
          })}
        </ol>
        {range && paged && (
          <nav className="queue-pager" aria-label="Pages of the queue">
            <p className="index-cap" data-queue="range">{range}</p>
            <button type="button" className="btn sm" disabled={at === 0 || queue.isFetching}
              onClick={() => turnTo(Math.max(0, at - QUEUE_PAGE))}>Previous</button>
            <button type="button" className="btn sm" disabled={at + entries.length >= total || queue.isFetching}
              onClick={() => turnTo(at + QUEUE_PAGE)}>Next</button>
          </nav>
        )}
      </section>
    </div>
  );
}
