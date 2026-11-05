/**
 * A PDF's first page as a picture, for its cover in the gallery.
 *
 * Drawn once, here, by the same fixed PDF.js the reader uses, and handed to
 * the engine to keep beside the database (`library_thumbs`); every later
 * gallery reads the kept picture and never opens the PDF again. The window
 * keeps nothing itself (Atlas uses no browser storage) and shows the picture
 * as a `data:` URL, the only kind of image besides its own files its content
 * policy allows.
 *
 * Drawing is the costly part, so it is kept out of the way of the page: one
 * page at a time, in one shared worker, started when the browser is idle,
 * nearest the view first, and dropped when its card leaves the page before it
 * starts. The worker is let go when nothing has been drawn for half a minute.
 */
import { MAX_DRAWN_PAGES, PDF_VERSION, RENDER_TIMEOUT, canvasScale, loadPdfJs, pdfAsset, type PdfWorker } from './pdfjs';
import { keepPicture, keptPicture, pdfBytes, dataUrl, type Version } from './libraryApi';

/** The picture's width in pixels: a cover at its widest on a 2x display. */
export const PICTURE_WIDTH = 520;
const QUALITY = 0.82;
const IDLE_WORKER_MS = 30_000;

interface Job { version: Version; rank: () => number; resolve: (url: string) => void; reject: (error: unknown) => void }

const waiting: Job[] = [];
let running = false;
let shared: { native: Worker; worker: PdfWorker } | null = null;
let idleTimer: number | undefined;

function idle(callback: () => void): void {
  const request = (window as unknown as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (request) request(callback, { timeout: 600 }); else window.setTimeout(callback, 60);
}

async function worker(): Promise<PdfWorker> {
  window.clearTimeout(idleTimer);
  if (shared) return shared.worker;
  const api = await loadPdfJs();
  const native = new Worker(pdfAsset('build/pdf.worker.min.js'), { type: 'module', name: `resmon-pdf-${PDF_VERSION}-pictures` });
  const made = new api.PDFWorker({ port: native, name: `resmon-pdf-${PDF_VERSION}-pictures` });
  await made.promise;
  shared = { native, worker: made };
  return made;
}

function letGo(): void {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (running || waiting.length || !shared) return;
    shared.worker.destroy();
    shared.native.terminate();
    shared = null;
  }, IDLE_WORKER_MS);
}

/** Draw page 1 of these bytes into a WebP (JPEG where WebP is not encoded), `PICTURE_WIDTH` wide. */
async function draw(data: Uint8Array<ArrayBuffer>): Promise<Blob> {
  const api = await loadPdfJs();
  const loading = api.getDocument({
    data, worker: await worker(), enableXfa: false, useWasm: false, useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true,
    disableAutoFetch: true, disableStream: true, disableRange: true, cMapUrl: pdfAsset('cmaps/'), cMapPacked: true,
    standardFontDataUrl: pdfAsset('standard_fonts/'), maxImageSize: 4_000_000, canvasMaxAreaInBytes: 16 * 1024 * 1024,
  });
  const timeout = window.setTimeout(() => { void loading.destroy(); }, RENDER_TIMEOUT);
  try {
    const doc = await loading.promise;
    if (doc.numPages < 1 || doc.numPages > MAX_DRAWN_PAGES) throw new Error('the PDF has no page the gallery draws');
    const page = await doc.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const fit = canvasScale(natural.width, natural.height, PICTURE_WIDTH / natural.width);
    const canvas = document.createElement('canvas');
    canvas.width = fit.width;
    canvas.height = fit.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas to draw on');
    // A page is paper: white under whatever the PDF leaves transparent.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, fit.width, fit.height);
    await page.render({ canvas, canvasContext: context, viewport: page.getViewport({ scale: fit.scale }), annotationMode: api.AnnotationMode.DISABLE }).promise;
    page.cleanup();
    const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', QUALITY));
    const picture = encoded && encoded.type === 'image/webp'
      ? encoded
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    canvas.width = 0;
    canvas.height = 0;
    if (!picture) throw new Error('the page could not be encoded');
    return picture;
  } finally {
    window.clearTimeout(timeout);
    await loading.destroy().catch(() => undefined);
  }
}

function next(): void {
  if (running) return;
  waiting.sort((a, b) => a.rank() - b.rank());
  const job = waiting.shift();
  if (!job) { letGo(); return; }
  running = true;
  idle(() => {
    void (async () => {
      try {
        const bytes = await pdfBytes(job.version);
        const picture = await draw(bytes);
        // Kept for every later gallery; a refusal to keep it still shows this one.
        await keepPicture(job.version, picture).catch(() => undefined);
        job.resolve(await dataUrl(picture));
      } catch (error) {
        job.reject(error);
      } finally {
        running = false;
        next();
      }
    })();
  });
}

/**
 * The picture of this version's first page: the kept one when there is one,
 * else drawn now, in turn. `rank` is asked when a turn comes, so the card
 * nearest the view is drawn first; `signal` withdraws a card that left.
 */
export async function firstPage(version: Version, rank: () => number, signal: AbortSignal): Promise<string> {
  const kept = await keptPicture(version, signal);
  if (kept) return kept;
  if (signal.aborted) throw new DOMException('The card left the page.', 'AbortError');
  return new Promise<string>((resolve, reject) => {
    const job: Job = { version, rank, resolve, reject };
    signal.addEventListener('abort', () => {
      const at = waiting.indexOf(job);
      if (at >= 0) {
        waiting.splice(at, 1);
        reject(new DOMException('The card left the page.', 'AbortError'));
      }
    }, { once: true });
    waiting.push(job);
    next();
  });
}
