import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EngineError } from '../../api/client';
import { count, number } from '../today/format';
import { evidence, readerBusy, type Anchor, type FileRecord, type PageText, type Project } from './evidenceApi';
import { PAGE_STATUS, examinedWords, matches, resolutionWords, selectionAnchor, utf16Range, type Pin } from './evidenceModel';
import { PdfPage } from './PdfPage';

function errorWords(error: unknown): string {
  if (error instanceof EngineError && error.detail) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

/**
 * One file's page and its canonical text. The text is what a passage is taken
 * from: select it, or find a literal match, then use the selection. A saved
 * passage reopened here is resolved against this exact page, or said not to be.
 */
export function Reader({ project, file, member, pin, onAnchor, onRemove, removing, readOnly = false }: {
  project: Project; file: FileRecord; member: boolean; pin: Pin | null;
  onAnchor?: (a: Anchor | null) => void; onRemove?: () => void; removing?: boolean;
  /** A citation's check: the page and its text, and nothing that saves or changes the project. */
  readOnly?: boolean;
}) {
  const isPdf = file.media_type === 'application/pdf';
  const [page, setPage] = useState(pin?.page_number ?? 1);
  const [draft, setDraft] = useState(String(pin?.page_number ?? 1));
  /** The page count the last read reported, kept while the next page is being read. */
  const [pages, setPages] = useState<number | null>(null);
  const turn = (n: number) => { setPage(n); setDraft(String(n)); };
  const [selected, setSelected] = useState<Anchor | null>(null);
  const [find, setFind] = useState('');
  const [found, setFound] = useState<string | null>(null);
  const pane = useRef<HTMLTextAreaElement>(null);
  const text = useQuery({
    queryKey: ['evidence-text', project.project_id, file.file_id, file.version_id, page],
    queryFn: async ({ signal }) => {
      const read = await evidence.text(project, file, page, signal);
      setPages(read.page_count ?? null);
      return read;
    },
    // A version's page text never changes, so a page read once is not read again:
    // every read is a child process, and only one runs at a time.
    staleTime: Infinity,
    // Only a busy reader is retried: the page before this one may still be finishing.
    retry: (failures, error) => readerBusy(error) && failures < 6,
    retryDelay: (attempt) => Math.min(4_000, 600 * (attempt + 1)),
  });
  const data: PageText | undefined = text.data;
  const resolution = useMemo(() => (pin ? resolutionWords(pin, data) : null), [pin, data]);
  const match = !pin ? null : !data ? 'pending' : matches(pin, data) ? 'yes' : 'no';
  // A citation's check opens on its text; the drawn page is there when asked for.
  const [drawing, setDrawing] = useState(!readOnly);
  useEffect(() => {
    if (!pin || !data || !matches(pin, data)) return;
    const [start, end] = utf16Range(data.text, pin.start_codepoint, pin.end_codepoint);
    pane.current?.focus();
    pane.current?.setSelectionRange(start, end);
  }, [pin, data]);

  const choose = () => {
    const el = pane.current;
    setSelected(data && el ? selectionAnchor(data, el.selectionStart, el.selectionEnd) : null);
  };
  const findNext = (e: FormEvent) => {
    e.preventDefault();
    if (!data || !find) return;
    const from = pane.current?.selectionEnd ?? 0;
    let at = data.text.indexOf(find, from);
    if (at < 0) at = data.text.indexOf(find);
    if (at < 0) { setFound('No literal match on this page’s text.'); return; }
    pane.current?.focus();
    pane.current?.setSelectionRange(at, at + find.length);
    setSelected(selectionAnchor(data, at, at + find.length));
    let n = 0;
    for (let i = data.text.indexOf(find); i >= 0; i = data.text.indexOf(find, i + Math.max(1, find.length))) n += 1;
    setFound(`${n} literal ${n === 1 ? 'match' : 'matches'} on this page’s text only.`);
  };

  return (
    <section className="ev-reader" aria-label="Evidence reader" data-file={file.file_id} data-media={file.media_type} data-page={page}>
      <div className="ev-reader-head">
        <h2 className="lib-detail-name ev-reader-name" title={file.original_name}>{file.original_name}</h2>
        {onRemove && (
          <button type="button" className="btn sm quiet" disabled={removing}
            onClick={() => { if (window.confirm(`Take ${file.original_name} out of this project? Its saved records stay.`)) onRemove(); }}>
            Remove from project
          </button>
        )}
      </div>
      <dl className="ev-identity">
        <div><dt>Version</dt><dd><code className="path" title={file.version_id}>{file.version_id}</code></dd></div>
        <div><dt>SHA-256</dt><dd><code className="path" title={file.sha256}>{file.sha256}</code></dd></div>
      </dl>
      {!member && !readOnly && <p className="record-cap" data-evidence="removed">This file is no longer in the project. Its saved records are kept.</p>}
      {resolution && <p className="ev-verdict" role="status" data-evidence="resolution" data-match={match}>{resolution}</p>}
      {isPdf && (
        <form className="ev-pages" onSubmit={(e) => {
          e.preventDefault();
          const n = Number(draft);
          if (Number.isInteger(n) && n >= 1 && (pages === null || n <= pages)) turn(n); else setDraft(String(page));
        }}>
          <button type="button" className="btn sm" disabled={page <= 1 || text.isFetching} onClick={() => turn(page - 1)}>Previous page</button>
          <label htmlFor="ev-page" className="num">Page</label>
          <input id="ev-page" className="ev-page-input num" inputMode="numeric" value={draft} disabled={text.isFetching}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))} autoComplete="off" />
          <span className="num">{pages !== null ? `of ${number(pages)}` : ''}</span>
          <button type="button" className="btn sm" disabled={text.isFetching || page >= (pages ?? 1)} onClick={() => turn(page + 1)}>Next page</button>
        </form>
      )}
      {isPdf && !drawing && (
        <button type="button" className="btn sm quiet ev-draw" onClick={() => setDrawing(true)}>Show the page as drawn</button>
      )}
      {isPdf && drawing && (
        <PdfPage page={page} drawn={{
          vault_id: project.vault_id, project_id: project.project_id, file_id: file.file_id,
          version_id: file.version_id, sha256: file.sha256, byte_size: file.byte_size,
        }} />
      )}
      {text.isFetching && <p className="record-cap" role="status">Reading this exact page.</p>}
      {text.isError && <p className="field-error" role="alert">{errorWords(text.error)}</p>}
      {data && (
        <>
          <p className="record-cap" data-evidence="examined">{examinedWords(data)} {data.coverage}</p>
          {data.status !== 'extracted'
            ? <p className="not-enough">{PAGE_STATUS[data.status] ?? data.status}</p>
            : (
              <>
                {!readOnly && (
                  <form className="lib-link-form" onSubmit={findNext}>
                    <label htmlFor="ev-find">Find on this page’s text</label>
                    <input id="ev-find" value={find} maxLength={200} onChange={(e) => setFind(e.target.value)} autoComplete="off" />
                    <button type="submit" className="btn sm" disabled={!find}>Find</button>
                    {found && <span className="record-cap" role="status" data-evidence="found">{found}</span>}
                  </form>
                )}
                <textarea ref={pane} className="ev-text" aria-label="Canonical page text" readOnly value={data.text} data-page={data.page_number}
                  onSelect={choose} onKeyUp={choose} rows={14} />
                {!readOnly && (
                  <div className="ev-use">
                    <button type="button" className="btn sm primary" disabled={!selected || !member} onClick={() => onAnchor?.(selected)}>Use selected passage</button>
                    <span className="record-cap">
                      {selected ? `${count(selected.end_codepoint - selected.start_codepoint, 'codepoint')} selected. The engine checks this exact quote before saving.` : 'Select text in the page’s text, or find it, to keep a passage.'}
                    </span>
                  </div>
                )}
              </>
            )}
        </>
      )}
    </section>
  );
}
