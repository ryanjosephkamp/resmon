import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { listWords } from '../today/format';
import { errorWords, pending, requestWords, storedWords } from './fullText';

/** How often the list is read again while one of its PDFs is still being got. */
const WHILE_GETTING_MS = 1500;

/**
 * The PDFs a watch's run asked for, with its opt-in on: what it got into the
 * Library, what it skipped and why (no open copy, no stated license, the
 * run's or the day's cap), and what failed and why. Nothing is drawn for a run
 * that asked for none.
 */
export function RunPdfs({ runId }: { runId: number }) {
  const asked = useQuery({
    queryKey: ['run-full-text', runId],
    queryFn: () => answer(engine().GET('/api/executions/{exec_id}/full-text', { params: { path: { exec_id: runId } } })),
    refetchInterval: (query) => (query.state.data?.requests.some((r) => pending(r)) ? WHILE_GETTING_MS : false),
  });
  const ids = asked.data?.requests.map((r) => r.document_id) ?? [];
  const briefs = useQuery({
    queryKey: ['briefs', ids], enabled: ids.length > 0,
    queryFn: () => answer(engine().POST('/api/documents/briefs', { body: { ids } })),
  });
  if (asked.isError) return <p className="field-error" role="alert">The run’s PDFs could not be read ({errorWords(asked.error)}).</p>;
  if (!asked.data || !asked.data.requests.length) return null;
  const titles = new Map((briefs.data ?? []).map((b) => [b.id, b.title]));
  const n = (state: string) => asked.data.counts[state] ?? 0;
  const going = n('waiting') + n('downloading');
  const parts = [
    n('stored') ? `${n('stored')} got into the Library` : null,
    going ? `${going} still being got` : null,
    n('skipped') ? `${n('skipped')} skipped` : null,
    n('failed') ? `${n('failed')} failed` : null,
  ].filter((part): part is string => part !== null);
  return (
    <section className="run-pdfs" aria-labelledby="run-pdfs" data-run="pdfs">
      <h2 id="run-pdfs" className="run-pdfs-head">PDFs <span>{listWords(parts)}</span></h2>
      <ul className="run-pdfs-list">
        {asked.data.requests.map((r) => (
          <li key={r.id ?? r.document_id} data-state={r.state} data-reason={r.reason ?? undefined}>
            <Link to={r.state === 'stored' && r.file_id && r.file_held !== false
              ? `/library/files/${r.file_id}?paper=${r.document_id}` : `/papers/${r.document_id}`}>
              {titles.get(r.document_id) ?? `Paper ${r.document_id}`}
            </Link>
            <span data-held={r.state === 'stored' ? String(r.file_held !== false) : undefined}>
              {r.state === 'stored' ? storedWords(r) : requestWords(r)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
