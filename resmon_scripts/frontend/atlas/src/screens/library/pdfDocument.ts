import { useEffect, useState } from 'react';
import { evidence } from './evidenceApi';
import {
  MAX_DRAWN_PAGES, PDF_VERSION, RENDER_TIMEOUT, loadPdfJs, pdfAsset,
  type PdfDocument, type PdfLoadingTask, type PdfModule, type PdfWorker,
} from './pdfjs';
import type { Size } from './readerModel';
import type { FindText } from './findModel';

/** The identity of the exact version being drawn, as plain values, so a project's new revision does not redraw it. */
export interface Drawn { vault_id: string; project_id: string; file_id: string; version_id: string; sha256: string; byte_size: number }

/**
 * Drawing work, a few jobs at a time and nearest first. A job's priority is
 * asked for when a slot frees, so it is measured from where the view is then,
 * not from where it was when the job was queued. A page on screen waits for
 * nothing but the pages beside it; a thumbnail waits for every page. A job no
 * longer wanted is taken out of the queue, or told to stop.
 */
interface Job { job: (signal: AbortSignal) => Promise<void>; priority: () => number; abort: AbortController }

export class Drawer {
  private readonly waiting: Job[] = [];
  private readonly running = new Set<Job>();

  constructor(private readonly slots = 2) {}

  /** Queue a job; the function returned withdraws it, or aborts it if it has started. */
  schedule(job: (signal: AbortSignal) => Promise<void>, priority: () => number): () => void {
    const entry = { job, priority, abort: new AbortController() };
    this.waiting.push(entry);
    this.next();
    return () => {
      const at = this.waiting.indexOf(entry);
      if (at >= 0) this.waiting.splice(at, 1);
      entry.abort.abort();
    };
  }

  /** Every queued job is dropped and every running one aborted: the document is going. */
  stop(): void {
    for (const entry of [...this.waiting.splice(0), ...this.running]) entry.abort.abort();
  }

  private next(): void {
    while (this.running.size < this.slots && this.waiting.length) {
      let best = 0;
      let rank = this.waiting[0]!.priority();
      for (let i = 1; i < this.waiting.length; i += 1) {
        const r = this.waiting[i]!.priority();
        if (r < rank) { best = i; rank = r; }
      }
      const [entry] = this.waiting.splice(best, 1);
      if (!entry) return;
      this.running.add(entry);
      void entry.job(entry.abort.signal).catch(() => undefined).finally(() => {
        this.running.delete(entry);
        this.next();
      });
    }
  }
}

/**
 * The text layers drawn so far, by page (1-based), each as its runs' elements:
 * what find marks its matches in. A page let go takes its layer with it.
 */
export class TextLayers {
  private readonly layers = new Map<number, HTMLElement[]>();
  private readonly listeners = new Set<() => void>();

  set(page: number, runs: HTMLElement[] | null): void {
    if (runs) this.layers.set(page, runs); else if (!this.layers.delete(page)) return;
    for (const listener of this.listeners) listener();
  }

  entries(): IterableIterator<[number, HTMLElement[]]> {
    return this.layers.entries();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** A page's text for find, and where each run starts on the page: its left and top, in PDF units. */
export interface FindPage extends FindText { boxes: Float32Array }

/** One open document: its pages, the queue that draws them, and the small images the page gallery keeps. */
export interface PdfSession {
  api: PdfModule;
  doc: PdfDocument;
  pages: number;
  /** Every page's size at scale 1, as the first page's: `useSizes` reads the rest. */
  sizes: Size[];
  drawer: Drawer;
  /** Thumbnails already drawn, as JPEG data URLs, the oldest let go past a few hundred. */
  thumbs: Map<number, string>;
  /** The text layers on screen, for find to mark. */
  layers: TextLayers;
  /** Each page's text for find, read once a document. */
  finds: Map<number, FindPage>;
  /** Stop the worker and say why; every page stops drawing. */
  fail(message: string): void;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'ready'; session: PdfSession }
  | { status: 'failed'; error: string };

const MAX_THUMBS = 400;

export function keepThumb(session: PdfSession, page: number, url: string): void {
  session.thumbs.delete(page);
  session.thumbs.set(page, url);
  while (session.thumbs.size > MAX_THUMBS) {
    const oldest = session.thumbs.keys().next().value;
    if (oldest === undefined) break;
    session.thumbs.delete(oldest);
  }
}

/**
 * The PDF of one exact version, opened once for as long as the reader shows
 * it: its bytes fetched and checked against the recorded size and hash, then
 * parsed by the fixed PDF.js in a worker of its own. Pages, their text and
 * their links are read from this one document as they are wanted. A page that
 * takes longer than the draw limit stops the worker, and with it the document.
 * `attempt` opens it again after a failure.
 */
export function usePdfSession(drawn: Drawn | null, attempt: number): SessionState {
  const { vault_id, project_id, file_id, version_id, sha256, byte_size } = drawn ?? {} as Partial<Drawn>;
  /** Which opening the state is about: an answer about an earlier version or attempt is not this one's. */
  const opening = `${vault_id}/${project_id}/${file_id}/${version_id}/${sha256}/${byte_size}/${attempt}`;
  const [state, setState] = useState<{ opening: string; said: SessionState } | null>(null);

  useEffect(() => {
    if (!vault_id || !project_id || !file_id || !version_id || !sha256 || byte_size === undefined) return undefined;
    let live = true;
    const abort = new AbortController();
    const drawer = new Drawer();
    let native: Worker | undefined;
    let worker: PdfWorker | undefined;
    let loading: PdfLoadingTask | undefined;
    const clear = () => {
      drawer.stop();
      void loading?.destroy().catch(() => undefined);
      worker?.destroy();
      native?.terminate();
    };
    const fail = (message: string) => {
      if (!live) return;
      live = false;
      abort.abort();
      clear();
      setState({ opening, said: { status: 'failed', error: message } });
    };
    const timeout = window.setTimeout(
      () => fail(`Opening the PDF took longer than ${RENDER_TIMEOUT / 1000} seconds, so its worker was stopped.`), RENDER_TIMEOUT);
    void (async () => {
      try {
        const data = await evidence.pdf({ vault_id, project_id }, { file_id, version_id, sha256, byte_size }, abort.signal);
        if (!live) return;
        const api = await loadPdfJs();
        if (!live) return;
        native = new Worker(pdfAsset('build/pdf.worker.min.js'), { type: 'module', name: `resmon-pdf-${PDF_VERSION}` });
        native.onerror = () => fail('The PDF.js worker failed, and nothing draws the pages in its place.');
        worker = new api.PDFWorker({ port: native, name: `resmon-pdf-${PDF_VERSION}` });
        await worker.promise;
        if (!live) return;
        loading = api.getDocument({
          data, worker, enableXfa: false, useWasm: false, useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true,
          disableAutoFetch: true, disableStream: true, disableRange: true, cMapUrl: pdfAsset('cmaps/'), cMapPacked: true,
          standardFontDataUrl: pdfAsset('standard_fonts/'), maxImageSize: 4_000_000, canvasMaxAreaInBytes: 16 * 1024 * 1024,
        });
        const doc = await loading.promise;
        if (!live) return;
        if (doc.numPages < 1) throw new Error('the PDF has no pages');
        if (doc.numPages > MAX_DRAWN_PAGES) throw new Error(`the PDF has ${doc.numPages.toLocaleString('en-US')} pages, more than the ${MAX_DRAWN_PAGES.toLocaleString('en-US')} the reader lays out`);
        const first = (await doc.getPage(1)).getViewport({ scale: 1 });
        if (!live) return;
        window.clearTimeout(timeout);
        const sizes = Array.from({ length: doc.numPages }, () => ({ width: first.width, height: first.height }));
        setState({ opening, said: { status: 'ready', session: {
          api, doc, pages: doc.numPages, sizes, drawer, thumbs: new Map(), layers: new TextLayers(), finds: new Map(), fail,
        } } });
      } catch (reason) {
        window.clearTimeout(timeout);
        fail(`The PDF could not be drawn: ${reason instanceof Error ? reason.message : 'the PDF is not supported'}.`);
      }
    })();
    return () => { live = false; window.clearTimeout(timeout); abort.abort(); clear(); };
  }, [vault_id, project_id, file_id, version_id, sha256, byte_size, attempt, opening]);

  return state && state.opening === opening ? state.said : { status: 'loading' };
}

/**
 * Every page's size, read once in the background after the document opens.
 * Pages start out the first page's size, which is right for most documents;
 * a page that differs is corrected as it is read, in batches, so the layout
 * moves a few times rather than once a page.
 */
export function useSizes(session: PdfSession | null): Size[] {
  const [read, setRead] = useState<{ session: PdfSession; sizes: Size[] } | null>(null);
  useEffect(() => {
    if (!session) return undefined;
    let live = true;
    void (async () => {
      const sizes = session.sizes.slice();
      let changed = false;
      let since = performance.now();
      for (let page = 2; page <= session.pages && live; page += 1) {
        try {
          const view = (await session.doc.getPage(page)).getViewport({ scale: 1 });
          const was = sizes[page - 1]!;
          if (Math.abs(was.width - view.width) > 0.5 || Math.abs(was.height - view.height) > 0.5) {
            sizes[page - 1] = { width: view.width, height: view.height };
            changed = true;
          }
        } catch {
          return;
        }
        if (changed && live && (performance.now() - since > 250 || page === session.pages)) {
          setRead({ session, sizes: sizes.slice() });
          changed = false;
          since = performance.now();
        }
      }
    })();
    return () => { live = false; };
  }, [session]);
  if (!session) return [];
  return read && read.session === session ? read.sizes : session.sizes;
}
