import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { bridge, isMac, systemName } from '../../bridge';
import { Fallback } from '../../shell/Fallback';
import { Icon } from '../../shell/Icon';
import { blockingDialogOpen, FIND_CHORD, isTyping, keysText, pressed } from '../../shell/shortcuts';
import { count, number, when } from '../today/format';
import { errorWords } from './Cards';
import { CompareButton, FileWording } from './FileWording';
import { fileLabel } from './galleryModel';
import { ConfirmRemoval, PaperPicker, removalSummaries } from './LibraryDialogs';
import { kindOf, LIBRARY, LIBRARY_KEY, readable, retryLibrary, rich, sizeWords, type LibraryFile, type LibraryRemoval } from './libraryApi';
import { usePdfSession, type Drawn } from './pdfDocument';
import { PdfView, type PdfViewHandle } from './PdfView';
import { OPENING_ZOOM, FOCUS_ZOOM, ZOOM_STEPS, stepZoom, zoomPercent, type Zoom } from './readerModel';

import { TextFind } from './TextFind';
import { invalidatePlacesForFiles } from './PaperPlaces';

const RichView = lazy(() => import('./richViewChunk'));

/**
 * One kept file, read here: a PDF's pages drawn by the same PDF.js the
 * Evidence reader uses, read-only, with its zoom, find, every page at once and
 * focus mode; a Markdown or TeX file in a rich view beside its plain text; a
 * text file as literal text. Beside it, what the file is tied to, and its
 * record last: the hash and the ids are there for whoever needs them, not
 * leading the page.
 *
 * Opened from a To Read cover (`?paper=`), the paper it came from is named at
 * the top with its Mark read, so reading and marking happen in one place.
 */
export function FilePage() {
  const { fileId = '' } = useParams();
  const [params] = useSearchParams();
  const paperId = Number(params.get('paper')) || null;
  const status = useQuery({ queryKey: LIBRARY_KEY, queryFn: () => answer(engine().GET('/api/library', LIBRARY)), retry: retryLibrary });
  const vault = status.data?.status === 'ready' ? status.data.vault?.vault_id ?? null : null;
  const detail = useQuery({
    queryKey: ['library-file', vault, fileId],
    enabled: !!vault,
    queryFn: () => answer(engine().GET('/api/library/files/{file_id}', {
      ...LIBRARY, params: { path: { file_id: fileId }, query: { expected_vault_id: vault! } },
    })),
  });
  const file = detail.data?.file;
  return (
    <div className="page lib-file-page" data-file={fileId} data-media={file?.media_type}>
      <nav className="lib-back" aria-label="Back to the Library">
        <Link to={file ? '/library?show=files' : '/library'}><Icon name="back" size={14} />Library</Link>
      </nav>
      {status.isPending || (vault && detail.isPending) ? <p className="page-lede">Reading the file’s record.</p> : null}
      {status.data && !vault && (
        <p className="page-lede" role="alert">The Library folder is not ready, so its files cannot be read. <Link to="/library?show=files">Open Your Files</Link> to see why.</p>
      )}
      {detail.isError && <p className="field-error" role="alert">{errorWords(detail.error)}</p>}
      {file && vault && <FileBody key={file.version_id} file={file} vault={vault} paperId={paperId} />}
    </div>
  );
}

function PaperLine({ paperId }: { paperId: number }) {
  const client = useQueryClient();
  const paper = useQuery({ queryKey: ['paper', paperId], queryFn: () => answer(engine().GET('/api/documents/{doc_id}', { params: { path: { doc_id: paperId } } })) });
  const status = paper.data?.queue_status ?? null;
  const mark = useMutation({
    mutationFn: () => answer(engine().PUT('/api/reading-queue/{document_id}', {
      params: { path: { document_id: paperId } }, body: { status: status === 'read' ? 'to_read' : 'read' },
    })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['paper', paperId] });
      void client.invalidateQueries({ queryKey: ['reading-queue'] });
      void client.invalidateQueries({ queryKey: ['paper-places', paperId] });
    },
  });
  if (!paper.data) return null;
  return (
    <p className="lib-paper-line">
      <span>The PDF you linked to <Link to={`/papers/${paperId}`}>{paper.data.title}</Link></span>
      {status && (
        <button type="button" className="btn sm" disabled={mark.isPending} onClick={() => mark.mutate()}>
          {status === 'read' ? 'Mark Unread' : 'Mark Read'}
        </button>
      )}
    </p>
  );
}

function FileBody({ file, vault, paperId }: { file: LibraryFile; vault: string; paperId: number | null }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [linking, setLinking] = useState(false);
  const [confirming, setConfirming] = useState<LibraryRemoval[] | null>(null);
  const isPdf = file.media_type === 'application/pdf';
  const changed = () => {
    void client.invalidateQueries({ queryKey: ['library-file'] });
    void client.invalidateQueries({ queryKey: ['library-files'] });
    void client.invalidateQueries({ queryKey: LIBRARY_KEY });
  };
  const open = useMutation({
    mutationFn: async (how: 'open' | 'reveal') => {
      const verified = await answer(engine().POST('/api/library/files/{file_id}/open', {
        ...LIBRARY, params: { path: { file_id: file.file_id } }, body: { expected_vault_id: vault, expected_version_id: file.version_id },
      }));
      const desktop = bridge();
      if (how === 'reveal') { await desktop?.revealPath?.(verified.path); return; }
      const failed = await desktop?.openPath?.(verified.path);
      if (failed) throw new Error(failed);
    },
  });
  const remove = useMutation({
    mutationFn: async (cascade: boolean) => {
      await answer(engine().DELETE('/api/library/files/{file_id}', {
        ...LIBRARY, params: { path: { file_id: file.file_id } }, body: { expected_vault_id: vault, expected_version_id: file.version_id, cascade },
      }));
    },
    onSuccess: () => {
      setConfirming(null);
      void invalidatePlacesForFiles(client, [file]);
      changed();
      navigate('/library?show=files', { state: { removed: { file_id: file.file_id, name: file.original_name, vault, paper_links: file.paper_links } } });
    },
  });
  const ask = useMutation({
    mutationFn: () => removalSummaries([file]),
    onSuccess: ([summary]) => { if (summary?.needs_confirmation) setConfirming([summary]); else remove.mutate(false); },
  });
  useEffect(() => {
    if (hash === '#links') document.getElementById('lib-file-links')?.scrollIntoView({ block: 'start' });
  }, [hash]);

  return (
    <div className="lib-file">
      <header className="lib-file-head">
        {paperId && <PaperLine paperId={paperId} />}
        <h1 className="page-title lib-file-name">{file.original_name}</h1>
        <p className="meta">
          <span>{kindOf(file.media_type)}</span><span className="sep" /><span>{sizeWords(file.byte_size)}</span>
          <span className="sep" /><span>{fileLabel(file)}</span>
        </p>
        <div className="lib-actions">
          <button type="button" className="btn sm" disabled={open.isPending} onClick={() => open.mutate('open')}>Open in the System’s Viewer</button>
          <button type="button" className="btn sm" disabled={open.isPending} onClick={() => open.mutate('reveal')}>
            Show in {systemName() === 'macOS' ? 'Finder' : 'Its Folder'}
          </button>
          <button type="button" className="btn sm" onClick={() => setLinking(true)}><Icon name="link" size={14} />Link to a Paper</button>
          <Link className="btn sm" to={`/library/evidence?file=${encodeURIComponent(file.file_id)}`}>Open in Evidence</Link>
          <CompareButton vaultId={vault} file={file} />
          <span className="grow" />
          <button type="button" className="btn quiet sm" disabled={ask.isPending || remove.isPending} onClick={() => ask.mutate()}>Remove from Your Files</button>
        </div>
        {(open.error || ask.error || remove.error) && <p className="field-error" role="alert">{errorWords(open.error ?? ask.error ?? remove.error)}</p>}
      </header>
      <div className="lib-file-body">
        <div className="lib-file-main">
          {isPdf ? <PdfReader file={file} vault={vault} /> : readable(file.media_type) ? <TextReader file={file} vault={vault} /> : null}
        </div>
        <aside className="lib-file-side" aria-label="What this file is tied to">
          <FileWording vaultId={vault} file={file} />
          <section id="lib-file-links" className="lib-side-part">
            <h2 className="record-sub">Papers You Linked It To</h2>
            {file.paper_links.length === 0
              ? <p className="record-cap">None yet.</p>
              : (
                <ul className="lib-links" data-library="links">
                  {file.paper_links.map((l) => <li key={l.document_id}><Link to={`/papers/${l.document_id}`}>{l.title ?? `Paper ${l.document_id}`}</Link></li>)}
                </ul>
              )}
            <button type="button" className="btn sm" onClick={() => setLinking(true)}>Link to a Paper</button>
            <p className="form-hint">A link is your association, not verified publication identity.</p>
          </section>
          <section className="lib-side-part">
            <h2 className="record-sub">Evidence Projects</h2>
            <p className="record-cap">{file.project_count ? `In ${count(file.project_count, 'project')}.` : 'In no project.'} <Link to={`/library/evidence?file=${encodeURIComponent(file.file_id)}`}>Open in Evidence</Link></p>
          </section>
          <details className="lib-record">
            <summary>The File’s Record</summary>
            <dl className="facts lib-facts">
              <div><dt>Kind</dt><dd><span data-library="media">{file.media_type}</span></dd></div>
              <div><dt>Kept</dt><dd>{when(file.created_at_utc, new Date())}</dd></div>
              <div><dt>SHA-256</dt><dd><code className="path" data-library="sha256">{file.sha256}</code></dd></div>
              <div><dt>File id</dt><dd><code className="path" data-library="file-id">{file.file_id}</code></dd></div>
              <div><dt>Version id</dt><dd><code className="path" data-library="version-id">{file.version_id}</code></dd></div>
              <div><dt>In the folder</dt><dd><code className="path">{file.relative_path}</code></dd></div>
            </dl>
            <p className="form-hint">The hash is the one recorded when the file was kept; every read checks the bytes against it.</p>
          </details>
        </aside>
      </div>
      {linking && <PaperPicker vault={vault} file={file} onClose={() => setLinking(false)} onLinked={changed} />}
      {confirming && (
        <ConfirmRemoval summaries={confirming} busy={remove.isPending} onCancel={() => setConfirming(null)} onConfirm={() => remove.mutate(true)} />
      )}
    </div>
  );
}

/**
 * A kept TXT, MD or TeX file. The plain view is the literal text with line
 * numbers, nothing rendered; a Markdown or TeX file also has its rich view,
 * which opens first, and the plain text is one press away.
 */
function TextReader({ file, vault }: { file: LibraryFile; vault: string }) {
  const content = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const from = useRef<HTMLElement | null>(null);
  const [finding, setFinding] = useState(false);
  const mac = isMac();
  const openFind = useCallback(() => {
    from.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFinding(true);
  }, []);
  const closeFind = () => { setFinding(false); from.current?.focus(); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !pressed(FIND_CHORD, event, mac) || blockingDialogOpen(document)) return;
      const active = document.activeElement;
      if (isTyping(active) && !section.current?.contains(active)) return;
      event.preventDefault();
      if (finding) section.current?.querySelector<HTMLInputElement>('.ev-find input')?.focus();
      else openFind();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [finding, mac, openFind]);
  const [view, setView] = useState<'rich' | 'plain'>(rich(file.media_type) ? 'rich' : 'plain');
  const text = useQuery({
    queryKey: ['library-text', vault, file.file_id, file.version_id],
    queryFn: () => answer(engine().GET('/api/library/files/{file_id}/text', {
      ...LIBRARY, params: { path: { file_id: file.file_id }, query: { expected_vault_id: vault, expected_version_id: file.version_id } },
    })),
    staleTime: Infinity,
  });
  const lines = useMemo(() => text.data?.text.split('\n') ?? [], [text.data]);
  return (
    <section ref={section} className="lib-text" aria-label={`The text of ${file.original_name}`} data-library="text" data-view={view}>
      <div className="lib-text-bar">
        {rich(file.media_type) && (
          <span className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={view === 'rich'} onClick={() => setView('rich')}>{file.media_type === 'text/x-tex' ? 'Math Drawn' : 'Rendered'}</button>
            <button type="button" aria-pressed={view === 'plain'} onClick={() => setView('plain')}>Plain Text</button>
          </span>
        )}
        {text.data && <p className="record-cap">{count(text.data.line_count, 'line')}, read from the kept bytes.</p>}
      </div>
      <button type="button" className="btn sm" aria-keyshortcuts={mac ? 'Meta+F' : 'Control+F'} onClick={openFind}>Find in the File</button>
      {finding && <TextFind content={content} onClose={closeFind} ready={!!text.data} />}
      {text.isPending && <p className="record-cap">Reading the text.</p>}
      {text.isError && <p className="field-error" role="alert">{errorWords(text.error)}</p>}
      <div ref={content}>
      {text.data && view === 'plain' && <PlainLines lines={lines} />}
      {text.data && view === 'rich' && (
        // A file whose rich view cannot be drawn shows its plain text instead of taking the page with it.
        <Fallback resetKey={file.version_id} fallback={() => (
          <>
            <p className="field-error" role="alert" data-library="rich-failed">This file’s rich view could not be drawn, so its plain text is shown.</p>
            <PlainLines lines={lines} />
          </>
        )}>
          <Suspense fallback={<p className="record-cap">Opening the rich view.</p>}>
            <RichView text={text.data.text} media={file.media_type} />
          </Suspense>
        </Fallback>
      )}
      </div>
    </section>
  );
}

function PlainLines({ lines }: { lines: readonly string[] }) {
  return <ol className="lib-lines">{lines.map((line, i) => <li key={i}><span className="lib-line">{line || ' '}</span></li>)}</ol>;
}

function inertOutside(keep: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  for (let node: HTMLElement | null = keep; node && node !== document.body; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement?.children ?? [])) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert || sibling instanceof HTMLDialogElement) continue;
      sibling.inert = true;
      changed.push(sibling);
    }
  }
  return () => { for (const element of changed) element.inert = false; };
}

/**
 * A kept PDF, read-only: its pages from the Library itself (no project), each
 * drawn as it nears the view. The page, the zoom, find in the document, every
 * page at once and focus mode work as they do in Evidence; nothing here saves
 * a passage, which is what Evidence is for.
 */
function PdfReader({ file, vault }: { file: LibraryFile; vault: string }) {
  const ids = useId();
  const mac = isMac();
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState('1');
  const [placeZoom, setPlaceZoom] = useState<Zoom>(OPENING_ZOOM);
  const [focusZoom, setFocusZoom] = useState<Zoom>(FOCUS_ZOOM);
  const [scale, setScale] = useState(1);
  const [gallery, setGallery] = useState(false);
  const [focus, setFocus] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const findInput = useRef<HTMLInputElement>(null);
  const findFrom = useRef<Element | null>(null);
  const section = useRef<HTMLElement>(null);
  const view = useRef<PdfViewHandle>(null);
  const focusButton = useRef<HTMLButtonElement>(null);
  const drawn = useMemo<Drawn>(() => ({
    vault_id: vault, project_id: null, file_id: file.file_id, version_id: file.version_id, sha256: file.sha256, byte_size: file.byte_size,
  }), [vault, file.file_id, file.version_id, file.sha256, file.byte_size]);
  const opened = usePdfSession(drawn, attempt);
  const session = opened.status === 'ready' ? opened.session : null;
  const zoom = focus ? focusZoom : placeZoom;
  const setZoom = focus ? setFocusZoom : setPlaceZoom;
  const total = session?.pages ?? null;
  const turn = (n: number) => { setPage(n); setDraft(String(n)); view.current?.go(n); };
  const onPage = useCallback((n: number) => { setPage(n); setDraft(String(n)); }, []);

  useEffect(() => {
    if (!focus) return undefined;
    const back = focusButton.current;
    const keep = section.current;
    const undo = keep ? inertOutside(keep) : () => undefined;
    view.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      setFocus(false);
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); undo(); back?.focus(); };
  }, [focus]);
  const openFind = useCallback(() => {
    if (!session) return;
    if (!finding) findFrom.current = document.activeElement;
    setGallery(false);
    setFinding(true);
    findInput.current?.focus();
    findInput.current?.select();
  }, [session, finding]);
  const closeFind = useCallback(() => {
    setFinding(false);
    const back = findFrom.current;
    findFrom.current = null;
    if (back instanceof HTMLElement && back.isConnected && back !== document.body) back.focus(); else view.current?.focus();
  }, []);
  useEffect(() => { if (finding) { findInput.current?.focus(); findInput.current?.select(); } }, [finding]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !pressed(FIND_CHORD, event, mac)) return;
      const active = document.activeElement;
      const inside = focus || !active || active === document.body || !!section.current?.contains(active);
      if (!inside || isTyping(active) && !section.current?.contains(active) || blockingDialogOpen(document)) return;
      event.preventDefault();
      openFind();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [mac, focus, openFind]);

  const percent = zoomPercent(scale);
  return (
    <section ref={section} className="ev-reader lib-pdf" aria-label="PDF reader" data-page={page} data-focus={focus ? 'true' : undefined}>
      {session && (
        <div className="ev-tools">
          <p className="ev-focus-name" title={file.original_name}>{file.original_name}</p>
          <form className="ev-pages" onSubmit={(e) => {
            e.preventDefault();
            const n = Number(draft);
            if (Number.isInteger(n) && n >= 1 && (total === null || n <= total)) turn(n); else setDraft(String(page));
          }}>
            <button type="button" className="btn sm" disabled={page <= 1} onClick={() => turn(page - 1)}>Previous Page</button>
            <label htmlFor={`${ids}-page`} className="num">Page</label>
            <input id={`${ids}-page`} className="ev-page-input num" inputMode="numeric" value={draft}
              onBlur={() => setDraft(String(page))} onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))} autoComplete="off" />
            <span className="num ev-of">{total !== null ? `of ${number(total)}` : ''}</span>
            <button type="button" className="btn sm" disabled={page >= (total ?? 1)} onClick={() => turn(page + 1)}>Next Page</button>
          </form>
          <div className="ev-zoom">
            <button type="button" className="btn sm quiet ev-icon" aria-label="Zoom Out" title="Zoom Out"
              disabled={percent <= ZOOM_STEPS[0]} onClick={() => setZoom(stepZoom(scale, -1))}><Icon name="minus" /></button>
            <label htmlFor={`${ids}-zoom`} className="sr-only">Zoom</label>
            <select id={`${ids}-zoom`} value={String(zoom)}
              onChange={(e) => setZoom(e.target.value === 'width' || e.target.value === 'page' ? e.target.value : Number(e.target.value))}>
              <option value="width">{zoom === 'width' ? `Fit Width · ${percent}%` : 'Fit Width'}</option>
              <option value="page">{zoom === 'page' ? `Fit Page · ${percent}%` : 'Fit Page'}</option>
              {ZOOM_STEPS.map((step) => <option key={step} value={String(step)}>{step}%</option>)}
            </select>
            <button type="button" className="btn sm quiet ev-icon" aria-label="Zoom In" title="Zoom In"
              disabled={percent >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!} onClick={() => setZoom(stepZoom(scale, 1))}><Icon name="plus" /></button>
          </div>
          <button type="button" className="btn sm quiet ev-icon" aria-pressed={finding} aria-keyshortcuts={mac ? 'Meta+F' : 'Control+F'}
            aria-label="Find in the Document" title={`Find in the document (${keysText(FIND_CHORD, mac)})`}
            onClick={() => (finding ? closeFind() : openFind())}><Icon name="search" /></button>
          <button type="button" className="btn sm" aria-pressed={gallery} onClick={() => setGallery((g) => !g)}>All Pages</button>
          {focus
            ? <button type="button" className="btn sm" onClick={() => setFocus(false)} aria-keyshortcuts="Escape">Leave Focus <kbd aria-hidden="true">esc</kbd></button>
            : <button type="button" className="btn sm" ref={focusButton} onClick={() => setFocus(true)} title="The pages take the whole window"><Icon name="fit" />Focus</button>}
        </div>
      )}
      <section className="ev-pdf" aria-label="PDF page image">
        {opened.status === 'loading' && <p className="record-cap ev-pdf-opening" role="status">Opening the PDF.</p>}
        {opened.status === 'failed' && (
          <div className="ev-pdf-failed">
            <p className="field-error" role="alert">{opened.error}</p>
            <button type="button" className="btn sm" onClick={() => setAttempt((n) => n + 1)}>Try Again</button>
          </div>
        )}
        {session && (
          <PdfView ref={view} session={session} zoom={zoom} start={1} label={file.original_name}
            gallery={gallery} onGallery={setGallery} onPage={onPage} onScale={setScale}
            find={finding ? { input: findInput, query: findQuery, onQuery: setFindQuery, onClose: closeFind } : null} />
        )}
        <p className="form-hint ev-pdf-hint">
          The pages as PDF.js draws them, read-only. Their text can be selected and copied. A link to a web page (http or https)
          opens in a window of its own, and a link to another place in this document goes there; forms, scripts, and attachments do
          nothing here. To pin a passage, open the file in Evidence.
        </p>
      </section>
    </section>
  );
}

