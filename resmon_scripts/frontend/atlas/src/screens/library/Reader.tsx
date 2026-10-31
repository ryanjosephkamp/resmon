import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { EngineError } from '../../api/client';
import { isMac } from '../../bridge';
import { Icon } from '../../shell/Icon';
import { blockingDialogOpen, keysText, pressed } from '../../shell/shortcuts';
import { count, number } from '../today/format';
import { evidence, readerBusy, type Anchor, type FileRecord, type PageText, type Project } from './evidenceApi';
import { PAGE_STATUS, examinedWords, matches, resolutionWords, selectionAnchor, utf16Range, type Pin } from './evidenceModel';
import { usePdfSession, type Drawn } from './pdfDocument';
import { PdfView, type PdfViewHandle } from './PdfView';
import { FOCUS_ZOOM, OPENING_ZOOM, ZOOM_STEPS, findSelection, stepZoom, zoomPercent, type Zoom } from './readerModel';

function errorWords(error: unknown): string {
  if (error instanceof EngineError && error.detail) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

/** The engine reads the text of PDFs up to this many pages (`evidence_pdf.extract`). */
const TEXT_PAGES = 200;

/**
 * While focus mode covers the window, everything outside `keep` is inert, so
 * the keyboard cannot wander behind it. A dialog is left alone, so ⌘K still
 * opens over the reader. Returns the undoing.
 */
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
 * One file's pages and its canonical text. The text is what a passage is
 * taken from: select it, find a literal match, or select on the drawn page
 * and use that, which is looked up in the same text. A saved passage reopened
 * here is resolved against this exact page, or said not to be.
 *
 * A PDF's pages are stacked in one scroll, drawn as they come near the view.
 * The page number follows the scroll, and the canonical text follows the page
 * once the scroll rests on it, because every page read is a child process and
 * only one runs at a time. Focus mode gives the pages the whole window, and
 * opens at fit page; a zoom chosen there stays while it lasts, and the zoom
 * the reader had is back on the way out. The page is the same on the way in
 * and out, because nothing is redrawn but what the new size needs.
 */
export function Reader({
  project, file, member, pin, onAnchor, onRemove, removing, readOnly = false, focus: held, onFocus, notesOpen = false, onNotes, focusScope,
}: {
  project: Project; file: FileRecord; member: boolean; pin: Pin | null;
  onAnchor?: (a: Anchor | null) => void; onRemove?: () => void; removing?: boolean;
  /** A citation's check: the page and its text, and nothing that saves or changes the project. */
  readOnly?: boolean;
  /** Focus mode, held by the screen around the reader so it can make way; the reader holds its own when this is absent. */
  focus?: boolean; onFocus?: (on: boolean) => void;
  /** The notes column, called back as a side panel in focus mode. */
  notesOpen?: boolean; onNotes?: (open: boolean) => void;
  /** What stays reachable in focus mode, the reader included; the reader alone when absent. */
  focusScope?: RefObject<HTMLElement | null>;
}) {
  const isPdf = file.media_type === 'application/pdf';
  const ids = useId();
  const [page, setPage] = useState(pin?.page_number ?? 1);
  const [draft, setDraft] = useState(String(pin?.page_number ?? 1));
  /** The page whose canonical text is read: the page on screen, once the scroll has rested on it. */
  const [textPage, setTextPage] = useState(pin?.page_number ?? 1);
  /** The page count the last read reported, kept while the next page is being read. */
  const [pages, setPages] = useState<number | null>(null);
  const [selected, setSelected] = useState<Anchor | null>(null);
  const [find, setFind] = useState('');
  const [found, setFound] = useState<string | null>(null);
  const [placeZoom, setPlaceZoom] = useState<Zoom>(OPENING_ZOOM);
  const [focusZoom, setFocusZoom] = useState<Zoom>(FOCUS_ZOOM);
  const [scale, setScale] = useState(1);
  const [gallery, setGallery] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [bridge, setBridge] = useState<string | null>(null);
  const [ownFocus, setOwnFocus] = useState(false);
  /** Find in the document: open or not, and the query kept between openings. */
  const [finding, setFinding] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const findInput = useRef<HTMLInputElement>(null);
  /** Where the keyboard was when find opened, to go back to when it closes. */
  const findFrom = useRef<Element | null>(null);
  const setFocus = onFocus ?? setOwnFocus;
  const section = useRef<HTMLElement>(null);
  const pane = useRef<HTMLTextAreaElement>(null);
  const pageInput = useRef<HTMLInputElement>(null);
  const focusButton = useRef<HTMLButtonElement>(null);
  const galleryButton = useRef<HTMLButtonElement>(null);
  const view = useRef<PdfViewHandle>(null);
  const client = useQueryClient();

  // A citation's check opens on its text; the drawn pages are there when asked for.
  const [drawing, setDrawing] = useState(!readOnly);
  const drawn = useMemo<Drawn | null>(() => (isPdf && drawing ? {
    vault_id: project.vault_id, project_id: project.project_id, file_id: file.file_id,
    version_id: file.version_id, sha256: file.sha256, byte_size: file.byte_size,
  } : null), [isPdf, drawing, project.vault_id, project.project_id, file.file_id, file.version_id, file.sha256, file.byte_size]);
  const opened = usePdfSession(drawn, attempt);
  const session = drawn && opened.status === 'ready' ? opened.session : null;
  const total = session?.pages ?? pages;
  /** Focus mode is for drawn pages; a text file, or a citation's text alone, is read in place. */
  const focus = (held ?? ownFocus) && !!drawn;
  // Each time focus mode is entered it opens at fit page; the zoom beside the notes is kept for the way out.
  const [wasFocused, setWasFocused] = useState(focus);
  if (focus !== wasFocused) {
    setWasFocused(focus);
    if (focus) setFocusZoom(FOCUS_ZOOM);
  }
  const zoom = focus ? focusZoom : placeZoom;
  const setZoom = focus ? setFocusZoom : setPlaceZoom;

  const textOptions = useCallback((n: number) => ({
    queryKey: ['evidence-text', project.project_id, file.file_id, file.version_id, n],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const read = await evidence.text(project, file, n, signal);
      setPages(read.page_count ?? null);
      return read;
    },
    // A version's page text never changes, so a page read once is not read again:
    // every read is a child process, and only one runs at a time.
    staleTime: Infinity,
    // Only a busy reader is retried: the page before this one may still be finishing.
    retry: (failures: number, error: Error) => readerBusy(error) && failures < 6,
    retryDelay: (attempt: number) => Math.min(4_000, 600 * (attempt + 1)),
  }), [project, file]);
  const beyond = isPdf && textPage > TEXT_PAGES;
  const text = useQuery({ ...textOptions(textPage), enabled: !beyond });
  const data: PageText | undefined = beyond ? undefined : text.data;
  const resolution = useMemo(() => (pin ? resolutionWords(pin, data) : null), [pin, data]);
  const match = !pin ? null : !data ? 'pending' : matches(pin, data) ? 'yes' : 'no';
  useEffect(() => {
    if (!pin || !data || !matches(pin, data)) return;
    const [start, end] = utf16Range(data.text, pin.start_codepoint, pin.end_codepoint);
    pane.current?.focus();
    pane.current?.setSelectionRange(start, end);
  }, [pin, data]);

  // The text follows the page on screen once the scroll rests there.
  useEffect(() => {
    if (page === textPage) return undefined;
    const settle = window.setTimeout(() => setTextPage(page), 350);
    return () => window.clearTimeout(settle);
  }, [page, textPage]);

  /** Go to a page: by scrolling to it when the pages are drawn, by reading it when only the text is shown. */
  const turn = (n: number) => {
    setPage(n);
    setDraft(String(n));
    setTextPage(n);
    view.current?.go(n);
  };
  const onPage = useCallback((n: number) => {
    setPage(n);
    if (document.activeElement !== pageInput.current) setDraft(String(n));
  }, []);

  // Focus mode: everything else inert, Escape leaves, and the keyboard goes to the pages and back to the button.
  const leave = useRef(setFocus);
  useEffect(() => { leave.current = setFocus; }, [setFocus]);
  const entered = useRef(false);
  useEffect(() => {
    if (!focus) {
      if (entered.current) focusButton.current?.focus();
      entered.current = false;
      return undefined;
    }
    entered.current = true;
    const keep = focusScope?.current ?? section.current;
    const undo = keep ? inertOutside(keep) : () => undefined;
    view.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      leave.current(false);
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); undo(); };
  }, [focus, focusScope]);

  // ⌘F (Ctrl+F off macOS) while the keyboard is in the reader, or in focus mode: find in the
  // document, or in a text file's page text. Anywhere else it is left alone, as it was.
  const mac = isMac();
  const openFind = useCallback(() => {
    if (!session) {
      const field = section.current?.querySelector<HTMLInputElement>(`input[id="${ids}-find"]`);
      field?.focus();
      field?.select();
      return;
    }
    if (!finding) findFrom.current = document.activeElement;
    setGallery(false);
    setFinding(true);
    findInput.current?.focus();
    findInput.current?.select();
  }, [session, finding, ids]);
  const closeFind = useCallback(() => {
    setFinding(false);
    const back = findFrom.current;
    findFrom.current = null;
    if (back instanceof HTMLElement && back.isConnected && !back.closest('[inert]') && back !== document.body) back.focus();
    else view.current?.focus();
  }, []);
  useEffect(() => {
    if (finding) { findInput.current?.focus(); findInput.current?.select(); }
  }, [finding]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !pressed({ key: 'f', command: true }, event, mac)) return;
      const inside = focus || (!!section.current && section.current.contains(document.activeElement));
      if (!inside || blockingDialogOpen(document)) return;
      event.preventDefault();
      openFind();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [mac, focus, openFind]);

  // A gallery closed without choosing a page gives the keyboard back to its button.
  const galleryWas = useRef(false);
  useEffect(() => {
    if (galleryWas.current && !gallery && (!document.activeElement || document.activeElement === document.body)) galleryButton.current?.focus();
    galleryWas.current = gallery;
  }, [gallery]);

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

  /** Text selected on a drawn page, looked up in that page's canonical text and offered to the notes as a passage. */
  const passageFrom = useCallback(async (n: number, chosen: string) => {
    setBridge(null);
    if (n > TEXT_PAGES) {
      setBridge(`The engine reads the text of PDFs up to ${TEXT_PAGES} pages, so nothing on page ${n} can be kept as an exact passage.`);
      return;
    }
    let read: PageText;
    try {
      read = await client.fetchQuery(textOptions(n));
    } catch (error) {
      setBridge(errorWords(error));
      return;
    }
    if (read.status !== 'extracted') {
      setBridge(`Page ${n} has no text the engine could read, so nothing on it can be kept as an exact passage.`);
      return;
    }
    const at = findSelection(read.text, chosen);
    const anchor = at ? selectionAnchor(read, at.start, at.end) : null;
    if (!at || !anchor) {
      setBridge(`That selection is not in page ${n}’s text as the engine read it, so it cannot be kept as an exact passage.`);
      return;
    }
    onAnchor?.(anchor);
    // In focus mode the notes are where the passage is saved, so they come back beside the pages.
    if (focus) onNotes?.(true);
    setBridge(at.count > 1 ? `Page ${n}’s text has that ${at.count} times; the first is the one kept.` : null);
  }, [client, textOptions, onAnchor, onNotes, focus]);
  const canKeep = !readOnly && member && !!onAnchor;

  const percent = zoomPercent(scale);
  const tools = (
    <div className="ev-tools">
      <p className="ev-focus-name" title={file.original_name}>{file.original_name}</p>
      {isPdf && (
        <form className="ev-pages" onSubmit={(e) => {
          e.preventDefault();
          const n = Number(draft);
          if (Number.isInteger(n) && n >= 1 && (total === null || n <= total)) turn(n); else setDraft(String(page));
        }}>
          <button type="button" className="btn sm" disabled={page <= 1 || (!session && text.isFetching)} onClick={() => turn(page - 1)}>Previous page</button>
          <label htmlFor={`${ids}-page`} className="num">Page</label>
          <input id={`${ids}-page`} ref={pageInput} className="ev-page-input num" inputMode="numeric" value={draft}
            disabled={!session && text.isFetching} onBlur={() => setDraft(String(page))}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))} autoComplete="off" />
          <span className="num ev-of">{total !== null ? `of ${number(total)}` : ''}</span>
          <button type="button" className="btn sm" disabled={page >= (total ?? 1) || (!session && text.isFetching)} onClick={() => turn(page + 1)}>Next page</button>
        </form>
      )}
      {session && (
        <>
          <div className="ev-zoom">
            <button type="button" className="btn sm quiet ev-icon" aria-label="Zoom out" title="Zoom out"
              disabled={percent <= ZOOM_STEPS[0]} onClick={() => setZoom(stepZoom(scale, -1))}>
              <Icon name="minus" />
            </button>
            <label htmlFor={`${ids}-zoom`} className="sr-only">Zoom</label>
            <select id={`${ids}-zoom`} value={String(zoom)}
              onChange={(e) => setZoom(e.target.value === 'width' || e.target.value === 'page' ? e.target.value : Number(e.target.value))}>
              <option value="width">{zoom === 'width' ? `Fit width · ${percent}%` : 'Fit width'}</option>
              <option value="page">{zoom === 'page' ? `Fit page · ${percent}%` : 'Fit page'}</option>
              {ZOOM_STEPS.map((step) => <option key={step} value={String(step)}>{step}%</option>)}
            </select>
            <button type="button" className="btn sm quiet ev-icon" aria-label="Zoom in" title="Zoom in"
              disabled={percent >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!} onClick={() => setZoom(stepZoom(scale, 1))}>
              <Icon name="plus" />
            </button>
          </div>
          <button type="button" className="btn sm quiet ev-icon" aria-pressed={finding} aria-keyshortcuts={mac ? 'Meta+F' : 'Control+F'}
            aria-label="Find in the document" title={`Find in the document (${keysText({ key: 'f', command: true }, mac)})`}
            onClick={() => (finding ? closeFind() : openFind())}>
            <Icon name="search" />
          </button>
          <button type="button" className="btn sm" ref={galleryButton} aria-pressed={gallery} onClick={() => setGallery((g) => !g)}>All pages</button>
          {focus
            ? (
              <>
                {onNotes && <button type="button" className="btn sm" aria-pressed={notesOpen} onClick={() => onNotes(!notesOpen)}>Notes</button>}
                <button type="button" className="btn sm" onClick={() => setFocus(false)} aria-keyshortcuts="Escape">
                  Leave focus <kbd aria-hidden="true">esc</kbd>
                </button>
              </>
            )
            : (
              <button type="button" className="btn sm" ref={focusButton} onClick={() => setFocus(true)}
                title="The pages take the whole window">
                <Icon name="fit" />Focus
              </button>
            )}
        </>
      )}
    </div>
  );

  return (
    <section ref={section} className="ev-reader" aria-label="Evidence reader" data-file={file.file_id} data-media={file.media_type}
      data-page={page} data-focus={focus ? 'true' : undefined}>
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
      {isPdf && tools}
      {bridge && (
        <p className="ev-bridge" role="status" data-evidence="bridge">
          <span>{bridge}</span>
          <button type="button" className="btn sm quiet" onClick={() => setBridge(null)}>Dismiss</button>
        </p>
      )}
      {isPdf && !drawing && (
        <button type="button" className="btn sm quiet ev-draw" onClick={() => setDrawing(true)}>Show the pages as drawn</button>
      )}
      {drawn && (
        <section className="ev-pdf" aria-label="PDF page image">
          {opened.status === 'loading' && <p className="record-cap ev-pdf-opening" role="status">Opening the PDF.</p>}
          {opened.status === 'failed' && (
            <div className="ev-pdf-failed">
              <p className="field-error" role="alert">{opened.error}</p>
              <button type="button" className="btn sm" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
            </div>
          )}
          {session && (
            <PdfView ref={view} session={session} zoom={zoom} start={page} label={file.original_name}
              gallery={gallery} onGallery={setGallery} onPage={onPage} onScale={setScale}
              find={finding ? { input: findInput, query: findQuery, onQuery: setFindQuery, onClose: closeFind } : null}
              onSelect={canKeep ? passageFrom : undefined} />
          )}
          <p className="form-hint ev-pdf-hint">
            The pages as PDF.js draws them. Their text can be selected and copied{canKeep ? ', or used as a passage' : ''}. A link to a web
            page (http or https) opens in a window of its own, and a link to another place in this document goes there. Forms, scripts,
            attachments, and other links do nothing here. Passages come from each page’s text as the engine reads it, which can differ
            from the drawing.
          </p>
        </section>
      )}
      {beyond && (
        <p className="not-enough" data-evidence="beyond">
          The engine reads the text of PDFs up to {TEXT_PAGES} pages, so page {number(textPage)}’s text is not read and nothing on it can be kept as a passage.
        </p>
      )}
      {!beyond && text.isFetching && <p className="record-cap" role="status">Reading this exact page.</p>}
      {!beyond && text.isError && <p className="field-error" role="alert">{errorWords(text.error)}</p>}
      {data && (
        <>
          <p className="record-cap" data-evidence="examined">{examinedWords(data)} {data.coverage}</p>
          {data.status !== 'extracted'
            ? <p className="not-enough">{PAGE_STATUS[data.status] ?? data.status}</p>
            : (
              <>
                {!readOnly && (
                  <form className="lib-link-form" onSubmit={findNext}>
                    <label htmlFor={`${ids}-find`}>Find on this page’s text</label>
                    <input id={`${ids}-find`} value={find} maxLength={200} onChange={(e) => setFind(e.target.value)} autoComplete="off" />
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
