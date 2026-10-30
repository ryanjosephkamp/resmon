import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { RENDER_TIMEOUT, canvasScale } from './pdfjs';
import { keepThumb, type PdfSession } from './pdfDocument';
import type { Size } from './readerModel';

/** A thumbnail's width on screen, in CSS pixels. */
const THUMB = 120;

/**
 * Every page of the document as a small picture, to go to one. A thumbnail
 * is drawn only once it scrolls near the grid's view, after every page the
 * reader is drawing, and kept as a small JPEG so scrolling back costs nothing.
 *
 * The grid is one tab stop: the arrow keys move between pages, Home and End
 * go to the first and last, Enter goes to the page, and Escape closes the
 * gallery without moving.
 */
export function PdfGallery({ session, sizes, current, label, onPick, onClose }: {
  session: PdfSession; sizes: Size[]; current: number; label: string;
  onPick: (page: number) => void; onClose: () => void;
}) {
  const grid = useRef<HTMLOListElement>(null);
  const [focused, setFocused] = useState(current);
  const [observer, setObserver] = useState<IntersectionObserver | null>(null);
  const seen = useRef(new Map<Element, (near: boolean) => void>());
  /** The page on screen when the gallery opened: where it opens, with the keyboard on it. */
  const opened = useRef(current);

  useLayoutEffect(() => {
    const root = grid.current?.parentElement ?? null;
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) seen.current.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin: '400px 0px' });
    setObserver(watch);
    const button = grid.current?.querySelector<HTMLButtonElement>(`button[data-page="${opened.current}"]`);
    button?.scrollIntoView({ block: 'center' });
    button?.focus({ preventScroll: true });
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const move = (event: KeyboardEvent<HTMLOListElement>) => {
    const buttons = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>('button[data-page]') ?? []);
    if (!buttons.length) return;
    const top = buttons[0]!.offsetTop;
    const columns = Math.max(1, buttons.findIndex((b) => b.offsetTop !== top) === -1 ? buttons.length : buttons.findIndex((b) => b.offsetTop !== top));
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    const to = event.key in step ? focused + step[event.key]! : event.key === 'Home' ? 1 : event.key === 'End' ? buttons.length : null;
    if (to === null) return;
    event.preventDefault();
    const next = Math.min(Math.max(to, 1), buttons.length);
    setFocused(next);
    buttons[next - 1]?.focus();
  };

  return (
    <section className="ev-gallery" aria-label={`All pages of ${label}`}>
      <div className="ev-gallery-head">
        <h3 className="record-sub">{session.pages === 1 ? '1 page' : `${session.pages.toLocaleString('en-US')} pages`}</h3>
        <button type="button" className="btn sm quiet" onClick={onClose}>Close the pages</button>
      </div>
      <div className="ev-gallery-scroll">
        <ol className="ev-thumbs" ref={grid} onKeyDown={move}>
          {sizes.map((size, i) => (
            <li key={i}>
              <Thumb session={session} page={i + 1} size={size} observer={observer} seen={seen}
                current={i + 1 === current} tabbable={i + 1 === focused}
                onFocus={() => setFocused(i + 1)} onPick={onPick} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const Thumb = memo(function Thumb({ session, page, size, observer, seen, current, tabbable, onFocus, onPick }: {
  session: PdfSession; page: number; size: Size; observer: IntersectionObserver | null;
  seen: RefObject<Map<Element, (near: boolean) => void>>; current: boolean; tabbable: boolean;
  onFocus: () => void; onPick: (page: number) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(() => session.thumbs.get(page) ?? null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = button.current;
    const map = seen.current;
    if (!node || !observer) return undefined;
    map.set(node, setNear);
    observer.observe(node);
    return () => { observer.unobserve(node); map.delete(node); };
  }, [observer, seen]);

  useEffect(() => {
    if (!near || url) return undefined;
    return session.drawer.schedule(async (signal) => {
      const timeout = window.setTimeout(
        () => session.fail(`Drawing page ${page} took longer than ${RENDER_TIMEOUT / 1000} seconds, so its worker was stopped.`), RENDER_TIMEOUT);
      try {
        const proxy = await session.doc.getPage(page);
        if (signal.aborted) return;
        const original = proxy.getViewport({ scale: 1 });
        const fit = canvasScale(original.width, original.height, (THUMB / original.width) * (window.devicePixelRatio || 1));
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) return;
        canvas.width = fit.width;
        canvas.height = fit.height;
        const task = proxy.render({
          canvas, canvasContext: context, viewport: proxy.getViewport({ scale: fit.scale }), annotationMode: session.api.AnnotationMode.DISABLE,
        });
        signal.addEventListener('abort', () => task.cancel(), { once: true });
        await task.promise;
        if (signal.aborted) return;
        const made = canvas.toDataURL('image/jpeg', 0.86);
        canvas.width = 0;
        canvas.height = 0;
        keepThumb(session, page, made);
        setUrl(made);
      } finally {
        window.clearTimeout(timeout);
      }
    }, () => 10_000 + page);
  }, [near, url, session, page]);

  return (
    <button ref={button} type="button" className="ev-thumb" data-page={page} aria-current={current ? 'page' : undefined}
      aria-label={`Page ${page}${current ? ', the page on screen' : ''}`} tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus} onClick={() => onPick(page)}>
      <span className="ev-thumb-paper" style={{ aspectRatio: `${size.width} / ${size.height}` }}>
        {url && <img src={url} alt="" draggable={false} />}
      </span>
      <span className="ev-thumb-number num">{page}</span>
    </button>
  );
});
