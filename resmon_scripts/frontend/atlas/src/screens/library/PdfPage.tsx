import { useEffect, useRef, useState } from 'react';
import { evidence } from './evidenceApi';
import {
  PDF_VERSION, RENDER_TIMEOUT, canvasScale, loadPdfJs, pdfAsset,
  type PdfLoadingTask, type PdfPageProxy, type PdfRenderTask, type PdfWorker,
} from './pdfjs';

type Zoom = 'fit' | number;
const ZOOMS: [Zoom, string][] = [['fit', 'Fit the column'], [0.5, '50%'], [1, '100%'], [1.5, '150%'], [2, '200%'], [3, '300%']];

/** The identity of the exact version being drawn, as plain values, so a project's new revision does not redraw it. */
interface Drawn { vault_id: string; project_id: string; file_id: string; version_id: string; sha256: string; byte_size: number }

/**
 * One physical page of a kept PDF, drawn by the fixed PDF.js 6.3.289 in a
 * worker of its own, from the exact version's bytes once their size and hash
 * match the record. Annotations, links, forms, actions and attachments are
 * not drawn or run. A passage is still taken from the page's canonical text,
 * which can differ from what is drawn here.
 */
export function PdfPage({ drawn, page }: { drawn: Drawn; page: number }) {
  const [zoom, setZoom] = useState<Zoom>('fit');
  return (
    <section className="ev-pdf" aria-label="PDF page image">
      <div className="ev-pdf-head">
        <label htmlFor="ev-zoom">Zoom</label>
        <select id="ev-zoom" value={String(zoom)} onChange={(e) => setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}>
          {ZOOMS.map(([value, words]) => <option key={String(value)} value={String(value)}>{words}</option>)}
        </select>
      </div>
      <PageCanvas key={`${drawn.version_id}:${page}:${zoom}`} drawn={drawn} page={page} zoom={zoom} />
      <p className="form-hint">
        The page as PDF.js draws it. Its links, forms, actions and attachments do nothing here. Passages come from the page’s text, which can differ from the drawing.
      </p>
    </section>
  );
}

function PageCanvas({ drawn, page, zoom }: { drawn: Drawn; page: number; zoom: Zoom }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState<{ status: string } | { error: string } | null>(null);
  const { vault_id, project_id, file_id, version_id, sha256, byte_size } = drawn;

  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    let native: Worker | undefined;
    let worker: PdfWorker | undefined;
    let loading: PdfLoadingTask | undefined;
    let rendering: PdfRenderTask | undefined;
    let pdfPage: PdfPageProxy | undefined;
    const clear = () => {
      rendering?.cancel();
      void loading?.destroy().catch(() => undefined);
      worker?.destroy();
      native?.terminate();
      pdfPage?.cleanup();
      if (canvas.current) { canvas.current.width = 0; canvas.current.height = 0; }
    };
    const fail = (message: string) => {
      if (!live) return;
      live = false;
      abort.abort();
      clear();
      setSaid({ error: message });
    };
    const timeout = window.setTimeout(
      () => fail(`Drawing the page took longer than ${RENDER_TIMEOUT / 1000} seconds, so its worker was stopped.`), RENDER_TIMEOUT);
    void (async () => {
      try {
        const data = await evidence.pdf({ vault_id, project_id }, { file_id, version_id, sha256, byte_size }, abort.signal);
        if (!live) return;
        const api = await loadPdfJs();
        if (!live) return;
        native = new Worker(pdfAsset('build/pdf.worker.min.js'), { type: 'module', name: `resmon-pdf-${PDF_VERSION}` });
        native.onerror = () => fail('The PDF.js worker failed, and nothing draws the page in its place.');
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
        if (doc.numPages > 200 || page > doc.numPages) throw new Error('the PDF has more than 200 pages, or no such page');
        pdfPage = await doc.getPage(page);
        if (!live) return;
        const original = pdfPage.getViewport({ scale: 1 });
        // On screen at the chosen size; drawn at the display's pixel density,
        // so text is sharp on a high-density screen, inside the canvas budget.
        const shown = zoom === 'fit' ? Math.max(0.25, (frame.current?.clientWidth ?? original.width) / original.width) : zoom;
        const size = canvasScale(original.width, original.height, shown * (window.devicePixelRatio || 1));
        const node = canvas.current;
        const context = node?.getContext('2d');
        if (!node || !context) throw new Error('no canvas to draw on');
        node.width = size.width;
        node.height = size.height;
        node.style.width = `${Math.floor(original.width * shown)}px`;
        node.style.height = `${Math.floor(original.height * shown)}px`;
        rendering = pdfPage.render({
          canvas: node, canvasContext: context, viewport: pdfPage.getViewport({ scale: size.scale }),
          annotationMode: api.AnnotationMode.DISABLE,
        });
        await rendering.promise;
        if (!live) return;
        window.clearTimeout(timeout);
        setSaid({
          status: `Page ${page} of ${doc.numPages} rendered · PDF.js ${PDF_VERSION} · ${size.width} × ${size.height} pixels`
            + `${size.reduced ? ' · drawn at reduced resolution to stay inside the canvas budget' : ''}.`,
        });
      } catch (reason) {
        window.clearTimeout(timeout);
        fail(`The page image could not be drawn: ${reason instanceof Error ? reason.message : 'the PDF is not supported'}.`);
      }
    })();
    return () => { live = false; window.clearTimeout(timeout); abort.abort(); clear(); };
  }, [vault_id, project_id, file_id, version_id, sha256, byte_size, page, zoom]);

  return (
    <>
      {said === null && <p className="record-cap" role="status">Drawing page {page}.</p>}
      {said && 'status' in said && <p className="record-cap ev-pdf-said" role="status">{said.status}</p>}
      {said && 'error' in said && <p className="field-error" role="alert">{said.error}</p>}
      <div className="ev-pdf-frame" ref={frame} hidden={!!said && 'error' in said}>
        <canvas ref={canvas} aria-label={`Page ${page} of the PDF, drawn`} data-pdf-version={PDF_VERSION} />
      </div>
    </>
  );
}
