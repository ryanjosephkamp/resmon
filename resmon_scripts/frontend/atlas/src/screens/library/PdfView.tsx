import {
  useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref,
} from 'react';
import { PdfGallery } from './PdfGallery';
import { PdfPage, type PageSaid, type Place } from './PdfPage';
import { useSizes, type PdfSession } from './pdfDocument';
import { CANVAS_BUDGET, MAX_CANVAS_PIXELS } from './pdfjs';
import {
  PAGE_GAP, PAGE_PAD, allot, anchorAt, currentPage, keptPages, layout, pagesBetween, topOf, zoomScale, type Anchor, type Zoom,
} from './readerModel';

/** What the reader can ask of the pages: go to one, and put the keyboard in the scroll. */
export interface PdfViewHandle {
  go(page: number, top?: number | null): void;
  focus(): void;
}

/** Text selected on one drawn page, and where on screen to offer to use it. */
interface Selected { page: number; text: string; top: number; left: number }

/**
 * Every page of one PDF, stacked in one scroll. Each page keeps its place and
 * size whether or not it is drawn, so the scrollbar is the whole document; a
 * page is drawn as it nears the view and let go once it is well away from it,
 * so a long document costs the few pages around the view, not all of them.
 * The page on screen is the one most in view, and the reader's page number
 * follows it.
 */
export function PdfView({ session, zoom, start, label, gallery, onGallery, onPage, onScale, onSelect, ref }: {
  session: PdfSession; zoom: Zoom; start: number; label: string;
  gallery: boolean; onGallery: (open: boolean) => void;
  onPage: (page: number) => void;
  onScale: (scale: number) => void;
  /** Text selected within one page; absent where nothing can be kept. */
  onSelect?: (page: number, text: string) => void;
  ref?: Ref<PdfViewHandle>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const sizes = useSizes(session);
  const scale = useMemo(
    () => (frame && sizes[0] ? zoomScale(zoom, frame, sizes[0]) : 1),
    [zoom, frame, sizes]);
  const view = useMemo(() => layout(sizes, scale), [sizes, scale]);
  const [kept, setKept] = useState<[number, number]>([0, -1]);
  const [visible, setVisible] = useState<[number, number]>([0, -1]);
  /** The display's pixels per CSS pixel, followed when the window moves to another display. */
  const [density, setDensity] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${density}dppx)`);
    const moved = () => setDensity(window.devicePixelRatio || 1);
    query.addEventListener('change', moved);
    return () => query.removeEventListener('change', moved);
  }, [density]);
  const [current, setCurrent] = useState(start);
  const [said, setSaid] = useState<Record<number, PageSaid>>({});
  const [selected, setSelected] = useState<Selected | null>(null);
  /** The part of the page at the top of the view, kept across a change of zoom, size or window. */
  const anchor = useRef<Anchor | null>(null);
  /** The page to open on: read once, when the first layout is made. */
  const first = useRef(start);
  const shown = useRef(start);
  /**
   * A page gone to by number, a link or the gallery stays the page on screen
   * while any of it is in view, until the person scrolls: near the end of a
   * document the page asked for may not reach the top, and the number should
   * not then name the page below it.
   */
  const pinned = useRef<number | null>(null);
  const started = useRef(false);
  const frameId = useRef(0);
  const viewRef = useRef(view);
  const onPageRef = useRef(onPage);
  useEffect(() => { onPageRef.current = onPage; }, [onPage]);
  useEffect(() => { onScale(scale); }, [scale, onScale]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return undefined;
    const measure = () => setFrame((was) => (was && was.width === node.clientWidth && was.height === node.clientHeight
      ? was : { width: node.clientWidth, height: node.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /** Read the scroll: which pages to keep, which is on screen, and the anchor for the next layout. */
  const settle = useCallback(() => {
    const node = scroller.current;
    const now = viewRef.current;
    if (!node || !now.tops.length) return;
    const top = node.scrollTop;
    const height = node.clientHeight;
    anchor.current = anchorAt(now, top);
    setKept((was) => {
      const next = keptPages(now, top, height, was[1] >= was[0] ? was : null);
      return next[0] === was[0] && next[1] === was[1] ? was : next;
    });
    setVisible((was) => {
      const next = pagesBetween(now, top, top + height);
      return next[0] === was[0] && next[1] === was[1] ? was : next;
    });
    let page = currentPage(now, top, height);
    if (pinned.current !== null) {
      const i = pinned.current - 1;
      if (i < now.tops.length && now.tops[i]! < top + height && now.tops[i]! + now.heights[i]! > top) page = pinned.current;
      else pinned.current = null;
    }
    if (page !== shown.current) {
      shown.current = page;
      setCurrent(page);
      onPageRef.current(page);
    }
  }, []);

  // A new layout (zoom, window, a page's true size) keeps the same place in view.
  useLayoutEffect(() => {
    viewRef.current = view;
    const node = scroller.current;
    if (!node || !frame || !view.tops.length) return;
    if (!started.current) {
      started.current = true;
      const index = Math.min(Math.max(first.current, 1), view.tops.length) - 1;
      node.scrollTop = index === 0 ? 0 : view.tops[index]! - PAGE_GAP;
    } else if (anchor.current) {
      node.scrollTop = topOf(view, anchor.current);
    }
    settle();
  }, [view, frame, settle]);

  // Scrolling by hand, by the keyboard or by the scrollbar lets a page gone to by number go.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return undefined;
    const release = () => { pinned.current = null; };
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    for (const name of events) node.addEventListener(name, release, { passive: true });
    return () => { for (const name of events) node.removeEventListener(name, release); };
  }, []);

  const onScroll = useCallback(() => {
    if (frameId.current) return;
    frameId.current = requestAnimationFrame(() => { frameId.current = 0; settle(); });
  }, [settle]);
  useEffect(() => () => cancelAnimationFrame(frameId.current), []);

  const go = useCallback((page: number, top: number | null = null) => {
    const node = scroller.current;
    const now = viewRef.current;
    if (!node || !now.tops.length) return;
    const index = Math.min(Math.max(Math.round(page), 1), now.tops.length) - 1;
    const pageTop = index === 0 ? 0 : now.tops[index]! - PAGE_GAP;
    pinned.current = index + 1;
    node.scrollTo({ top: pageTop });
    settle();
    if (top === null) return;
    // A destination's height is in the page's own units; where that falls depends on the page's box and rotation.
    void session.doc.getPage(index + 1).then((proxy) => {
      const [, y] = proxy.getViewport({ scale }).convertToViewportPoint(0, top);
      if (typeof y === 'number' && Number.isFinite(y) && scroller.current) {
        scroller.current.scrollTo({ top: Math.max(0, now.tops[index]! + Math.max(0, y) - PAGE_PAD) });
        settle();
      }
    }).catch(() => undefined);
  }, [session, scale, settle]);

  useImperativeHandle(ref, () => ({ go, focus: () => scroller.current?.focus() }), [go]);

  const onSaid = useCallback((index: number, next: PageSaid | null) => {
    setSaid((was) => {
      if (next === null) {
        if (!(index in was)) return was;
        const rest = { ...was };
        delete rest[index];
        return rest;
      }
      return { ...was, [index]: next };
    });
  }, []);
  const rank = useCallback((index: number) => Math.abs(index + 1 - shown.current), []);
  const onGo = useCallback((place: Place) => go(place.page, place.top), [go]);

  // A selection inside one page's text, offered as a passage; anything else offers nothing.
  useEffect(() => {
    if (!onSelect) return undefined;
    let timer = 0;
    const read = () => {
      const node = scroller.current;
      const selection = window.getSelection();
      if (!node || !selection || selection.isCollapsed || !selection.rangeCount) { setSelected(null); return; }
      const sheetOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest('.ev-sheet');
      const from = sheetOf(selection.anchorNode);
      const to = sheetOf(selection.focusNode);
      const text = selection.toString();
      if (!from || from !== to || !node.contains(from) || !text.trim()) { setSelected(null); return; }
      const rects = selection.getRangeAt(0).getClientRects();
      const last = rects[rects.length - 1];
      if (!last) { setSelected(null); return; }
      const box = node.getBoundingClientRect();
      setSelected({
        page: Number((from as HTMLElement).dataset.page),
        text,
        top: last.bottom - box.top + node.scrollTop + 6,
        left: Math.max(8, Math.min(last.right - box.left + node.scrollLeft - 40, node.scrollWidth - 180)),
      });
    };
    const onChange = () => { window.clearTimeout(timer); timer = window.setTimeout(read, 160); };
    document.addEventListener('selectionchange', onChange);
    return () => { window.clearTimeout(timer); document.removeEventListener('selectionchange', onChange); };
  }, [onSelect]);

  // While a selection is being dragged, a page's text layer covers its gaps (see `.textLayer.selecting`).
  useEffect(() => {
    const done = () => {
      for (const layer of Array.from(scroller.current?.querySelectorAll('.textLayer.selecting') ?? [])) layer.classList.remove('selecting');
    };
    document.addEventListener('pointerup', done);
    return () => document.removeEventListener('pointerup', done);
  }, []);

  // Every page in view at the display's density; the rest inside the canvas budget, the farthest let go first.
  const densities = useMemo(
    () => allot(view, kept, visible, density, MAX_CANVAS_PIXELS, CANVAS_BUDGET),
    [view, kept, visible, density]);

  const status = said[current - 1];
  const pages = [];
  if (frame) {
    for (let i = Math.max(0, kept[0]); i <= Math.min(kept[1], view.tops.length - 1); i += 1) {
      const width = view.widths[i]!;
      const box = {
        top: view.tops[i]!, width, height: view.heights[i]!,
        left: Math.max(PAGE_PAD, Math.floor((Math.max(view.width, frame.width) - width) / 2)),
      };
      pages.push(<PdfPage key={i} session={session} index={i} scale={scale} density={densities.get(i) ?? 0} box={box}
        rank={rank} onSaid={onSaid} onGo={onGo} />);
    }
  }

  return (
    <>
      {!status && <p className="record-cap ev-pdf-said" role="status">Drawing page {current}.</p>}
      {status && 'drawn' in status && <p className="record-cap ev-pdf-said" role="status">{status.drawn}</p>}
      {status && 'error' in status && <p className="record-cap ev-pdf-said" role="status">Page {current} was not drawn.</p>}
      <div className="ev-viewport">
        <div className="ev-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} role="region"
          aria-label={`Pages of ${label}`} data-pages={session.pages} data-page={current}>
          <div className="ev-sheets" style={{ height: view.height, width: frame ? Math.max(view.width, frame.width) : undefined }}>
            {pages}
            {selected && onSelect && (
              <div className="ev-chip" style={{ top: selected.top, left: selected.left }}>
                <button type="button" className="btn sm primary" onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onSelect(selected.page, selected.text); setSelected(null); }}>
                  Use as a passage
                </button>
              </div>
            )}
          </div>
        </div>
        {gallery && (
          <PdfGallery session={session} sizes={sizes} current={current} label={label}
            onPick={(page) => { onGallery(false); go(page); scroller.current?.focus(); }}
            onClose={() => onGallery(false)} />
        )}
      </div>
    </>
  );
}
