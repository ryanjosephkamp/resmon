import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { answer, engine, EngineError } from '../../api/client';
import { count, number } from '../today/format';
import { libraryMatchWords, libraryProgressWords, type SharedWordingLibrary } from '../collection/wordingModel';
import { LIBRARY, type LibraryFile } from './libraryApi';

function errorWords(error: Error): string {
  return error instanceof EngineError && error.detail ? error.detail : error.message;
}

export function wordingKey(vaultId: string, file: Pick<LibraryFile, 'file_id' | 'version_id'>) {
  return ['library-wording', vaultId, file.file_id, file.version_id] as const;
}

/**
 * Library › Your files › Compare with your collection: the button, and the
 * answer for this file.
 *
 * The engine reads the file page by page through its own PDF reader (one page
 * at a time for the whole engine, so a page another screen is reading is
 * waited for) and compares each page with the collection's abstracts and with
 * every other file in this Library. What it found names the page and the
 * passage; what it could not read is said, not skipped.
 */
export function useFileWording(vaultId: string, file: LibraryFile) {
  const client = useQueryClient();
  const key = wordingKey(vaultId, file);
  const state = useQuery({
    queryKey: key,
    queryFn: () => answer(engine().GET('/api/library/files/{file_id}/shared-wording', {
      ...LIBRARY,
      params: { path: { file_id: file.file_id }, query: { expected_vault_id: vaultId, expected_version_id: file.version_id } },
    })),
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1000 : false),
  });
  const start = useMutation({
    mutationFn: () => answer(engine().POST('/api/library/files/{file_id}/shared-wording', {
      ...LIBRARY, params: { path: { file_id: file.file_id } },
      body: { expected_vault_id: vaultId, expected_version_id: file.version_id },
    })),
    onSuccess: (started) => client.setQueryData(key, started),
    // A refusal to start (another file is being compared) is said where the
    // answer is drawn, rather than lost with the button's own state.
    onError: (error) => client.setQueryData<SharedWordingLibrary>(key, {
      state: 'failed', file_id: file.file_id, version_id: file.version_id, reason: 'not_started', error: errorWords(error),
    }),
  });
  return { state, start };
}

/** The button, for the file's row of actions. */
export function CompareButton({ vaultId, file }: { vaultId: string; file: LibraryFile }) {
  const { state, start } = useFileWording(vaultId, file);
  const running = state.data?.state === 'running' || start.isPending;
  return (
    <button type="button" className="btn sm" data-library="compare" disabled={running} onClick={() => start.mutate()}>
      {running ? 'Comparing' : 'Compare with your collection'}
    </button>
  );
}

/** What the last comparison of this file found, since the engine started. */
export function FileWording({ vaultId, file }: { vaultId: string; file: LibraryFile }) {
  const { state } = useFileWording(vaultId, file);
  const data: SharedWordingLibrary | undefined = state.data;
  if (!data || data.state === 'never') return null;
  return (
    <section className="lib-wording" aria-label="Shared wording with your collection" data-library="wording" data-state={data.state}>
      <h3 className="record-sub">Shared wording with your collection</h3>
      {data.state === 'running' && <p className="record-cap" role="status">{libraryProgressWords(data)}</p>}
      {data.state === 'failed' && (
        <p className="field-error" role="alert">
          {data.reason === 'not_started' ? 'The comparison did not start' : 'The comparison stopped'}: {data.error}
        </p>
      )}
      {data.state === 'cancelled' && <p className="record-cap">The comparison was stopped before it finished.</p>}
      {data.state === 'done' && data.result && <Found result={data.result} />}
    </section>
  );
}

function Found({ result }: { result: NonNullable<SharedWordingLibrary['result']> }) {
  const s = result.settings;
  const pages = result.page_count ?? result.pages_read;
  return (
    <>
      <p className="settings-said" data-library="wording-read">
        Read {number(result.pages_read)} of {count(pages, 'page')} and compared {result.pages_read === 1 ? 'it' : 'each'} with{' '}
        {count(result.abstracts_compared, 'abstract')} in your collection and {count(result.files_compared, 'other file')} in this Library.
      </p>
      {result.pages_unread.length > 0 && (
        <p className="record-cap" data-library="wording-unread">
          Not compared: {result.pages_unread.map((p) => `page ${p.page} (${p.status.replace(/_/g, ' ')})`).join(', ')}.
        </p>
      )}
      {result.files_not_read.length > 0 && (
        <ul className="record-cap">
          {result.files_not_read.map((f) => <li key={f.file_id}>{f.name} could not be read: {f.reason}</li>)}
        </ul>
      )}
      {result.matches.length === 0
        ? (
          <p className="record-cap" data-library="wording-none">
            No page shares a passage of {s.shown_longest} words or more, outside common phrasing, with an abstract or another file.
          </p>
        )
        : (
          <ol className="lib-wording-matches" data-library="wording-matches">
            {result.matches.map((m, i) => (
              <li key={i} data-kind={m.kind} data-page={m.page}>
                <p className="lib-wording-where">
                  <span className="lib-wording-page">{libraryMatchWords(m)}</span>
                  {m.kind === 'paper' && m.document_id
                    ? (
                      <>
                        {' '}· the abstract of <Link to={`/papers/${m.document_id}`}>paper {m.document_id}</Link>
                        {m.title ? <>: {m.title}</> : null}
                        {m.linked ? ', which you linked this file to' : ''}
                      </>
                    )
                    : <> · {m.name}, page {m.other_page}</>}
                </p>
                {m.passages.slice(0, 3).map((p) => (
                  <blockquote key={`${p.start}-${p.end}`} className="lib-wording-passage" data-words={p.words}>{p.text}</blockquote>
                ))}
                {m.passages.length > 3 && <p className="record-cap">And {count(m.passages.length - 3, 'shorter passage')}.</p>}
              </li>
            ))}
          </ol>
        )}
      <h4 className="why-limits-label">What this comparison cannot see</h4>
      <ul className="why-limits" data-library="wording-limits">{result.limits.map((line) => <li key={line}>{line}</li>)}</ul>
    </>
  );
}
