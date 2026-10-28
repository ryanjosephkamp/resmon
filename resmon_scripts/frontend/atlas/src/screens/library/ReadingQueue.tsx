import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { exportReferences, FORMATS, type ReferenceFormat } from '../runs/references';
import { authors, count, number } from '../today/format';
import { queueWords } from '../collection/Paper';

type Filter = 'to_read' | 'read' | 'all';

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'to_read', label: 'To read' },
  { id: 'read', label: 'Read' },
  { id: 'all', label: 'All' },
];

/** The most entries one read lists; the queue says when there are more. */
const PAGE = 200;

/**
 * Library › Reading queue: the papers saved to read, read or not yet.
 *
 * Saved from a run or from a paper's page. Marking one read keeps it here
 * under Read; removing it takes it out of the queue and leaves the paper in
 * the collection. Selected papers export together, one entry each.
 */
export function ReadingQueue() {
  const client = useQueryClient();
  const [filter, setFilter] = useState<Filter>('to_read');
  const [selected, setSelected] = useState<number[]>([]);
  const queue = useQuery({
    queryKey: ['reading-queue', filter],
    queryFn: () => answer(engine().GET('/api/reading-queue', { params: { query: { status: filter, limit: PAGE, offset: 0 } } })),
  });
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const names = useMemo(() => new Map((catalog.data ?? []).map((e) => [e.slug, e.name])), [catalog.data]);
  const refresh = () => void client.invalidateQueries({ queryKey: ['reading-queue'] });
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
    mutationFn: (format: ReferenceFormat) => exportReferences({ document_ids: selected }, format, 'resmon-reading-queue'),
  });

  const counts = queue.data?.counts;
  const entries = queue.data?.entries ?? [];
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="page library">
      <div className="library-head">
        <h1 className="page-title">Reading queue</h1>
        <div className="seg" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); setSelected([]); }}>
              {f.label}{counts ? <span className="seg-n num">{number(counts[f.id])}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <p className="page-lede">Papers you saved from a run or from a paper&rsquo;s page. Removing one leaves it in your collection.</p>

      {selected.length > 0 && (
        <div className="export-bar queue-export" role="group" aria-label="Export the selected papers">
          <span>{count(selected.length, 'paper')}: export as</span>
          {FORMATS.map((format) => (
            <button key={format.id} type="button" className="btn sm" disabled={exporting.isPending}
              onClick={() => exporting.mutate(format.id)}>{format.label}</button>
          ))}
          <button type="button" className="btn quiet sm" onClick={() => setSelected([])}>Clear</button>
          {exporting.error && <p className="field-error" role="alert">{exporting.error.message}</p>}
        </div>
      )}

      <section className="queue" aria-label="Saved papers" aria-busy={queue.isFetching}>
        {queue.isPending && <p className="index-cap">Reading the queue.</p>}
        {queue.isError && <p className="index-cap">The queue could not be read ({queue.error.message}).</p>}
        {queue.data && !entries.length && (
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
                  checked={selected.includes(entry.document_id)}
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
        {queue.data && queue.data.total > entries.length && (
          <p className="index-cap">The first {number(entries.length)} of {number(queue.data.total)} are listed.</p>
        )}
      </section>
    </div>
  );
}
