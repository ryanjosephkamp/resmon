import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { PDF_VERSION, RENDER_TIMEOUT, canvasScale, type PdfPageProxy, type PdfRenderTask, type PdfTextLayer } from './pdfjs';
import type { PdfSession } from './pdfDocument';
import { explicitDest, linkBox, linkTarget, type LinkTarget } from './readerModel';

/** What drawing a page came to, for the sentence about the page on screen. */
export type PageSaid = { drawn: string } | { error: string };

/** Where a link inside the document goes: a page, and the height on it in PDF units when the link names one. */
export interface Place { page: number; top: number | null }

interface Spot { box: CSSProperties; target: LinkTarget; place: Place | null }

/** A destination in this document as the page it is on, or null when PDF.js cannot place it. */
async function placeOf(session: PdfSession, dest: string | unknown[]): Promise<Place | null> {
  const explicit = typeof dest === 'string' ? await session.doc.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) return null;
  const parsed = explicitDest(explicit);
  if (!parsed) return null;
  const index = parsed.ref ? await session.doc.getPageIndex(parsed.ref) : parsed.index;
  if (index === null || !Number.isInteger(index) || index < 0 || index >= session.pages) return null;
  return { page: index + 1, top: parsed.top };
}

/**
 * One page of the stacked reader: the drawing, the page's text laid over it
 * by PDF.js's text layer so it can be selected and copied, and its links.
 *
 * The drawing is made in a canvas off the page and swapped in when it is
 * done, so a new zoom shows the old drawing stretched until the sharp one is
 * ready rather than a blank page. The text layer and the links are placed in
 * proportions of the page, so they are built once and follow every zoom.
 * Annotations are not drawn into the canvas, and the only annotation read is
 * a link: a web address (http or https) opens through the window's link
 * handling, and a destination in this document or a page-turning action goes
 * to its page. Forms, scripts, attachments and other links are never made.
 * The drawing is as sharp as the density the view gives it; a page given none
 * keeps its place, its text and its links without one. Unmounting lets the
 * canvas, the text and the page's parsed content go.
 */
export const PdfPage = memo(function PdfPage({ session, index, scale, density, box, rank, onSaid, onGo }: {
  session: PdfSession; index: number; scale: number;
  /** Canvas pixels per CSS pixel: the display's density in view, less or none farther away (`allot`). */
  density: number;
  box: { top: number; left: number; width: number; height: number };
  /** How far this page is from the one on screen, asked when the drawer picks its next job. */
  rank: (index: number) => number;
  onSaid: (index: number, said: PageSaid | null) => void;
  onGo: (place: Place) => void;
}) {
  const number = index + 1;
  const paint = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const page = useRef<PdfPageProxy | null>(null);
  const built = useRef(false);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [sharp, setSharp] = useState(false);
  const [unit, setUnit] = useState(1);

  useEffect(() => {
    let rendering: PdfRenderTask | undefined;
    let layer: PdfTextLayer | undefined;
    if (density <= 0) {
      // Outside the canvas budget: the drawing goes, the text and links stay.
      const drawing = paint.current;
      for (const canvas of Array.from(drawing?.querySelectorAll('canvas') ?? [])) { canvas.width = 0; canvas.height = 0; }
      drawing?.replaceChildren();
      const release = window.setTimeout(() => { setDrawn(false); setSharp(false); }, 0);
      return () => window.clearTimeout(release);
    }
    const cancel = session.drawer.schedule(async (signal) => {
      const timeout = window.setTimeout(
        () => session.fail(`Drawing page ${number} took longer than ${RENDER_TIMEOUT / 1000} seconds, so its worker was stopped.`), RENDER_TIMEOUT);
      try {
        const proxy = page.current ?? await session.doc.getPage(number);
        page.current = proxy;
        if (signal.aborted) return;
        setUnit(proxy.userUnit || 1);
        const original = proxy.getViewport({ scale: 1 });
        // On screen at the zoom's size; drawn at the density this page is
        // given, the display's own when it is in view, so text is sharp on a
        // high-density screen, inside one canvas's ceiling.
        const size = canvasScale(original.width, original.height, scale * density);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('no canvas to draw on');
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.dataset.pdfVersion = PDF_VERSION;
        canvas.setAttribute('aria-hidden', 'true');
        rendering = proxy.render({
          canvas, canvasContext: context, viewport: proxy.getViewport({ scale: size.scale }), annotationMode: session.api.AnnotationMode.DISABLE,
        });
        signal.addEventListener('abort', () => rendering?.cancel(), { once: true });
        await rendering.promise;
        if (signal.aborted || !paint.current) { canvas.width = 0; canvas.height = 0; return; }
        for (const old of Array.from(paint.current.querySelectorAll('canvas'))) { old.width = 0; old.height = 0; }
        paint.current.replaceChildren(canvas);
        // Below the screen's own resolution, whether for the ceiling or the budget, the sentence says so.
        const full = size.scale >= scale * (window.devicePixelRatio || 1) * 0.999;
        setDrawn(true);
        setSharp(full);
        setFailed(null);
        onSaid(index, {
          drawn: `Page ${number} of ${session.pages} rendered · PDF.js ${PDF_VERSION} · ${size.width} × ${size.height} pixels`
            + `${full ? '' : ' · drawn at reduced resolution to stay inside the canvas budget'}.`,
        });
        if (built.current) return;
        // The text to select, and the links: once a page, in proportions of it.
        const css = proxy.getViewport({ scale: 1 });
        const content = await proxy.getTextContent({ includeMarkedContent: true, disableNormalization: true });
        if (signal.aborted || !text.current) return;
        const holder = document.createElement('div');
        holder.className = 'textLayer';
        layer = new session.api.TextLayer({ textContentSource: content, container: holder, viewport: css });
        await layer.render();
        if (signal.aborted || !text.current) return;
        // As PDF.js's own viewer does: while a selection is dragged, a block at
        // the end of the text covers the page's gaps, so the selection does not
        // jump to the start of the page when the pointer crosses one.
        const end = document.createElement('div');
        end.className = 'endOfContent';
        holder.append(end);
        holder.addEventListener('pointerdown', () => holder.classList.add('selecting'));
        text.current.replaceChildren(holder);
        const found: Spot[] = [];
        for (const annotation of await proxy.getAnnotations({ intent: 'display' })) {
          const target = linkTarget(annotation, session.api.AnnotationType.LINK);
          if (!target) continue;
          const [x1, y1] = css.convertToViewportPoint(annotation.rect[0]!, annotation.rect[1]!);
          const [x2, y2] = css.convertToViewportPoint(annotation.rect[2]!, annotation.rect[3]!);
          const at = linkBox([x1!, y1!, x2!, y2!], css);
          if (at.width <= 0 || at.height <= 0) continue;
          let place: Place | null = null;
          if (target.kind === 'dest') {
            place = await placeOf(session, target.dest).catch(() => null);
            if (!place) continue;
          } else if (target.kind === 'page') {
            const to = { FirstPage: 1, LastPage: session.pages, NextPage: number + 1, PrevPage: number - 1 }[target.action];
            if (to < 1 || to > session.pages) continue;
            place = { page: to, top: null };
          }
          found.push({ target, place, box: { left: `${at.left}%`, top: `${at.top}%`, width: `${at.width}%`, height: `${at.height}%` } });
        }
        if (signal.aborted) return;
        built.current = true;
        setSpots(found);
      } catch (reason) {
        if (signal.aborted) return;
        const message = `Page ${number} could not be drawn: ${reason instanceof Error ? reason.message : 'the page is not supported'}.`;
        setFailed(message);
        onSaid(index, { error: message });
      } finally {
        window.clearTimeout(timeout);
      }
    }, () => rank(index));
    return () => { cancel(); rendering?.cancel(); layer?.cancel(); };
  }, [session, index, number, scale, density, rank, onSaid]);

  // Let the drawing, the text and the parsed page go when the page leaves the kept range.
  useEffect(() => {
    const drawing = paint.current;
    const words = text.current;
    const parsed = page;
    return () => {
      for (const canvas of Array.from(drawing?.querySelectorAll('canvas') ?? [])) { canvas.width = 0; canvas.height = 0; }
      drawing?.replaceChildren();
      words?.replaceChildren();
      parsed.current?.cleanup();
      onSaid(index, null);
    };
  }, [index, onSaid]);

  const style = {
    top: box.top, left: box.left, width: box.width, height: box.height,
    '--total-scale-factor': String(scale * unit),
  } as CSSProperties;
  return (
    <div className="ev-sheet" role="group" aria-label={`Page ${number}`} data-page={number} data-drawn={drawn ? 'true' : 'false'}
      data-sharp={sharp ? 'true' : 'false'} style={style}>
      <div className="ev-sheet-paint" ref={paint} />
      {!drawn && !failed && <span className="ev-sheet-number" aria-hidden="true">{number}</span>}
      <div className="ev-sheet-text" ref={text} />
      {spots.length > 0 && (
        <div className="ev-links">
          {spots.map((spot, i) => (spot.target.kind === 'web'
            ? (
              <a key={i} className="ev-link" href={spot.target.href} target="_blank" rel="noreferrer noopener" style={spot.box}
                title={spot.target.href} aria-label={`Open ${spot.target.href}`} data-link="web" />
            )
            : (
              <button key={i} type="button" className="ev-link" style={spot.box} data-link="page" data-to={spot.place!.page}
                title={`Page ${spot.place!.page}`} aria-label={`Go to page ${spot.place!.page}`} onClick={() => onGo(spot.place!)} />
            )))}
        </div>
      )}
      {failed && <p className="field-error ev-sheet-error" role="alert">{failed}</p>}
    </div>
  );
});
