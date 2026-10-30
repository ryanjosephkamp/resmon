/**
 * The fixed PDF.js 6.3.289 the Evidence reader draws pages with: loaded from
 * this window's own origin, where the build copies it, and checked to be that
 * version before it is used. The same bounds as the classic reader's
 * `src/lib/pdfjs.ts`, which goes at the switch-over: at most 4 million canvas
 * pixels and 16 MiB of canvas memory, and 20 seconds to draw a page.
 */

/** Only the public PDF.js calls the reader makes: drawing, a page's text to select, and its links. */
export interface PdfViewport {
  width: number; height: number; scale: number; rotation: number;
  rawDims: { pageWidth: number; pageHeight: number; pageX: number; pageY: number };
  convertToViewportPoint(x: number, y: number): number[];
}
export interface PdfRenderTask { promise: Promise<void>; cancel(): void }
/** A page's text as positioned runs, which `TextLayer` lays over the drawing so it can be selected. */
export interface PdfTextContent { items: unknown[]; styles: Record<string, unknown>; lang: string | null }
/** An annotation as PDF.js reports it; the reader reads a link's rectangle and target and nothing else. */
export interface PdfAnnotation { annotationType: number; rect: number[]; url?: unknown; dest?: unknown; action?: unknown; attachment?: unknown }
export interface PdfPageProxy {
  userUnit: number;
  getViewport(options: { scale: number }): PdfViewport;
  render(options: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: PdfViewport; annotationMode: number }): PdfRenderTask;
  getTextContent(options: { includeMarkedContent: boolean; disableNormalization: boolean }): Promise<PdfTextContent>;
  getAnnotations(options: { intent: 'display' }): Promise<PdfAnnotation[]>;
  cleanup(): boolean;
}
export interface PdfRef { num: number; gen: number }
export interface PdfDocument {
  numPages: number;
  getPage(page: number): Promise<PdfPageProxy>;
  /** A named destination's explicit form, for a link within the document. */
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: PdfRef): Promise<number>;
  destroy(): Promise<void>;
}
export interface PdfWorker { promise: Promise<void>; destroy(): void }
export interface PdfLoadingTask { promise: Promise<PdfDocument>; destroy(): Promise<void> }
export interface PdfTextLayer { render(): Promise<void>; cancel(): void }
export interface PdfModule {
  version: string;
  PDFWorker: new (options: { port: Worker; name: string }) => PdfWorker;
  AnnotationMode: { DISABLE: number };
  AnnotationType: { LINK: number };
  TextLayer: new (options: { textContentSource: PdfTextContent; container: HTMLElement; viewport: PdfViewport }) => PdfTextLayer;
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
/**
 * The most pages the reader lays out. Pages are drawn only near the view and
 * let go away from it, so the count bounds the layout, not memory. The
 * engine reads the text of PDFs up to 200 pages; a longer one is drawn here
 * and its text is said not to be read.
 */
export const MAX_DRAWN_PAGES = 5_000;

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
      || typeof api.TextLayer !== 'function' || api.AnnotationMode?.DISABLE !== 0 || api.AnnotationType?.LINK !== 2) {
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
