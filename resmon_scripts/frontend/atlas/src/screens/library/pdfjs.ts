/**
 * The fixed PDF.js 6.3.289 the Evidence reader draws pages with: loaded from
 * this window's own origin, where the build copies it, and checked to be that
 * version before it is used. The same bounds as the classic reader's
 * `src/lib/pdfjs.ts`, which goes at the switch-over: at most 4 million canvas
 * pixels and 16 MiB of canvas memory, and 20 seconds to draw a page.
 */

/** Only the public PDF.js canvas and worker calls the reader makes. */
export interface PdfViewport { width: number; height: number }
export interface PdfRenderTask { promise: Promise<void>; cancel(): void }
export interface PdfPageProxy {
  getViewport(options: { scale: number }): PdfViewport;
  render(options: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; annotationMode: number }): PdfRenderTask;
  cleanup(): boolean;
}
export interface PdfDocument { numPages: number; getPage(page: number): Promise<PdfPageProxy>; destroy(): Promise<void> }
export interface PdfWorker { promise: Promise<void>; destroy(): void }
export interface PdfLoadingTask { promise: Promise<PdfDocument>; destroy(): Promise<void> }
export interface PdfModule {
  version: string;
  PDFWorker: new (options: { port: Worker; name: string }) => PdfWorker;
  AnnotationMode: { DISABLE: number };
  getDocument(options: {
    data: Uint8Array; worker: PdfWorker; enableXfa: false; useWasm: false; useSystemFonts: false; useWorkerFetch: false;
    stopAtErrors: true; disableAutoFetch: true; disableStream: true; disableRange: true; cMapUrl: string; cMapPacked: true;
    standardFontDataUrl: string; maxImageSize: number; canvasMaxAreaInBytes: number;
  }): PdfLoadingTask;
}

export const PDF_VERSION = '6.3.289';
export const MAX_PIXELS = 4_000_000;
export const MAX_CANVAS_BYTES = 16 * 1024 * 1024;
export const RENDER_TIMEOUT = 20_000;

/** A file of the fixed distribution, by its path inside it; nothing outside it is ever asked for. */
export function pdfAsset(relative: string): string {
  const root = new URL(`./pdfjs/${PDF_VERSION}/`, document.baseURI);
  const target = new URL(relative, root);
  if (target.origin !== window.location.origin || !target.href.startsWith(root.href)) {
    throw new Error('PDF.js files must come from the fixed copy beside the app.');
  }
  return target.href;
}

let pending: Promise<PdfModule> | undefined;

export function loadPdfJs(): Promise<PdfModule> {
  pending ??= import(/* @vite-ignore */ pdfAsset('build/pdf.min.js')).then((value: unknown) => {
    const api = value as PdfModule;
    if (api.version !== PDF_VERSION || typeof api.PDFWorker !== 'function' || typeof api.getDocument !== 'function'
      || api.AnnotationMode?.DISABLE !== 0) {
      throw new Error(`The page drawer is not PDF.js ${PDF_VERSION}.`);
    }
    return api;
  });
  return pending;
}

/**
 * The canvas size for a page at a requested scale, reduced to stay inside the
 * pixel and memory budgets. `reduced` says the page is drawn at less than the
 * scale asked for, so the status sentence can say so.
 */
export function canvasScale(width: number, height: number, requested: number): { scale: number; width: number; height: number; reduced: boolean } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Number.isFinite(requested) || requested <= 0) {
    throw new Error('The page has dimensions that cannot be drawn.');
  }
  const scale = Math.min(requested, Math.sqrt(MAX_PIXELS / (width * height)), Math.sqrt(MAX_CANVAS_BYTES / (width * height * 4)));
  const w = Math.floor(width * scale);
  const h = Math.floor(height * scale);
  if (w < 1 || h < 1 || w * h > MAX_PIXELS || w * h * 4 > MAX_CANVAS_BYTES) throw new Error('The page cannot be drawn inside the canvas budget.');
  return { scale, width: w, height: h, reduced: scale < requested };
}
