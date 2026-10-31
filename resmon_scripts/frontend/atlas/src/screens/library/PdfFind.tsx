import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Icon } from '../../shell/Icon';
import { RENDER_TIMEOUT } from './pdfjs';
import type { FindPage, PdfSession } from './pdfDocument';
import { findHits, findPattern, findText, firstFrom, ordinal, readingOrder, step, type Hit, type Run } from './findModel';

/** Where the current match is: its page (1-based) and its place among that page's matches. */
export interface Spot { page: number; index: number }

/** The names the matches are marked by (`::highlight(…)` in atlas.css). */
const ALL = 'ev-find';
const CURRENT = 'ev-find-current';

/**
 * One page's text for find, read from the worker once a document and kept:
 * its runs as the text layer draws them, folded for matching, and where each
 * run starts on the page, to scroll a match into view before its page is drawn.
 */
async function readPage(session: PdfSession, page: number): Promise<FindPage> {
  const kept = session.finds.get(page);
  if (kept) return kept;
  const timeout = window.setTimeout(
    () => session.fail(`Reading page ${page}’s text took longer than ${RENDER_TIMEOUT / 1000} seconds, so its worker was stopped.`), RENDER_TIMEOUT);
  try {
    const proxy = await session.doc.getPage(page);
    // The same options the text layer is drawn with, so the runs are the layer's, one for one.
    const content = await proxy.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    const runs: Run[] = [];
    const boxes: number[] = [];
    for (const item of content.items as { str?: unknown; hasEOL?: unknown; transform?: unknown; height?: unknown }[]) {
      if (typeof item.str !== 'string') continue;
      runs.push({ str: item.str, hasEOL: item.hasEOL === true });
      const t = Array.isArray(item.transform) ? item.transform as number[] : [];
      boxes.push(t[4] ?? 0, (t[5] ?? 0) + (typeof item.height === 'number' ? item.height : 0));
    }
    const found = { ...findText(runs), boxes: Float32Array.from(boxes) };
    session.finds.set(page, found);
    return found;
  } finally {
    window.clearTimeout(timeout);
  }
}

/** A match as a range over the text layer's runs, or null when the layer does not hold it. */
function rangeOf(runs: HTMLElement[], hit: Hit): Range | null {
  const start = runs[hit.from[0]]?.firstChild;
  const end = runs[hit.to[0]]?.firstChild;
  if (!(start instanceof Text) || !(end instanceof Text)) return null;
  const range = document.createRange();
  range.setStart(start, Math.min(hit.from[1], start.length));
  range.setEnd(end, Math.min(hit.to[1], end.length));
  return range;
}

/** Hand the event loop back, so a search through every page never holds a frame. */
const breathe = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/**
 * Find in the whole document. Each page's text is read from the worker once,
 * one page at a time so drawing is never kept waiting, starting from the page
 * on screen; the first matches show while later pages are still being read.
 * A new query runs over what has been read in slices of a few milliseconds,
 * so typing never holds up scrolling.
 *
 * Matches are marked in the text layers drawn so far with the CSS Custom
 * Highlight API, which marks ranges without changing the layer, so selection
 * and links work as before; the current match is marked apart and scrolled to.
 * Enter and Shift+Enter step, wrapping at either end; Escape closes.
 */
export function PdfFind({ session, page, input, initial, onQuery, onReveal, onClose }: {
  session: PdfSession; page: number; input: RefObject<HTMLInputElement | null>;
  initial: string; onQuery: (query: string) => void;
  onReveal: (page: number, left: number, top: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initial);
  const [settled, setSettled] = useState(initial);
  const [counts, setCounts] = useState<Map<number, number>>(new Map());
  const [read, setRead] = useState(0);
  const [current, setCurrent] = useState<Spot | null>(null);
  /** What is said to a screen reader: the match stepped to, and the count once every page is read. */
  const [said, setSaid] = useState('');
  const hits = useRef(new Map<number, Hit[]>());
  /** The page on screen when the query changed: where the search starts. */
  const from = useRef(page);
  useEffect(() => { from.current = page; }, [page]);

  useEffect(() => {
    const settle = window.setTimeout(() => { setSettled(query); onQuery(query); }, 120);
    return () => window.clearTimeout(settle);
  }, [query, onQuery]);

  /** The reader's scroll to a place, held so a change of zoom does not start the search again. */
  const toPlace = useRef(onReveal);
  useEffect(() => { toPlace.current = onReveal; }, [onReveal]);
  const reveal = useCallback((spot: Spot | null) => {
    if (!spot) return;
    const text = session.finds.get(spot.page);
    const hit = hits.current.get(spot.page)?.[spot.index];
    if (!text || !hit) return;
    toPlace.current(spot.page, text.boxes[hit.from[0] * 2] ?? 0, text.boxes[hit.from[0] * 2 + 1] ?? 0);
  }, [session]);

  // Read and match, page by page, from the page on screen.
  useEffect(() => {
    let live = true;
    void (async () => {
      await Promise.resolve();
      if (!live) return;
      const pattern = findPattern(settled);
      hits.current = new Map();
      setCounts(new Map());
      setCurrent(null);
      setRead(0);
      setSaid('');
      if (!pattern) return;
      const order = readingOrder(session.pages, from.current);
      const found = new Map<number, number>();
      let chosen: Spot | null = null;
      let painted = performance.now();
      let slice = performance.now();
      for (let n = 0; n < order.length; n += 1) {
        const p = order[n]!;
        let text = session.finds.get(p);
        if (!text) {
          try {
            text = await readPage(session, p);
          } catch {
            return;
          }
          if (!live) return;
          slice = performance.now();
        }
        const these = findHits(text, pattern);
        hits.current.set(p, these);
        found.set(p, these.length);
        const last = n === order.length - 1;
        if (!chosen && these.length) {
          chosen = { page: p, index: 0 };
          setCurrent(chosen);
          reveal(chosen);
        }
        if (last || chosen?.page === p || performance.now() - painted > 100) {
          setCounts(new Map(found));
          setRead(n + 1);
          painted = performance.now();
        }
        if (last) {
          const all = Array.from(found.values()).reduce((a, b) => a + b, 0);
          setSaid(all ? `${ordinal(found, chosen!.page, chosen!.index).n} of ${all}` : 'No matches in this document');
        }
        if (performance.now() - slice > 8) {
          await breathe();
          if (!live) return;
          slice = performance.now();
        }
      }
    })();
    return () => { live = false; };
  }, [settled, session, reveal]);

  // Mark the matches in every drawn text layer, now and as pages are drawn and let go.
  useEffect(() => {
    if (typeof Highlight === 'undefined' || !CSS.highlights) return undefined;
    const paint = () => {
      const all = new Highlight();
      const now = new Highlight();
      for (const [p, runs] of session.layers.entries()) {
        (hits.current.get(p) ?? []).forEach((hit, i) => {
          const range = rangeOf(runs, hit);
          if (range) (current?.page === p && current.index === i ? now : all).add(range);
        });
      }
      CSS.highlights.set(ALL, all);
      CSS.highlights.set(CURRENT, now);
    };
    paint();
    const stop = session.layers.subscribe(paint);
    return () => { stop(); CSS.highlights.delete(ALL); CSS.highlights.delete(CURRENT); };
  }, [session, counts, current]);

  const go = (direction: 1 | -1) => {
    const next = current ? step(counts, current, direction)
      : direction > 0 ? firstFrom(counts, from.current) : step(counts, null, -1);
    if (!next) return;
    setCurrent(next);
    reveal(next);
    const done = read === session.pages;
    const { n, of } = ordinal(counts, next.page, next.index);
    setSaid(done ? `${n} of ${of}` : `${n} of ${of} so far`);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); go(event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };

  const pattern = settled.trim();
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  const reading = !!pattern && read < session.pages;
  const position = current ? ordinal(counts, current.page, current.index).n : 0;
  const shown = !pattern ? ''
    : total ? `${position || '–'} of ${total.toLocaleString('en-US')}${reading ? '+' : ''}`
      : reading ? 'Reading…' : 'No matches';
  return (
    <div className="ev-find" role="search" aria-label="Find in this document">
      <label htmlFor="ev-find-query" className="sr-only">Find in the document</label>
      <input id="ev-find-query" ref={input} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
        placeholder="Find in the document" autoComplete="off" spellCheck={false} maxLength={200} />
      <span className="ev-find-count num" aria-hidden="true" data-find="count"
        title={reading ? `Read ${read.toLocaleString('en-US')} of ${session.pages.toLocaleString('en-US')} pages` : undefined}>{shown}</span>
      <span className="sr-only" role="status" data-find="said">{said}</span>
      <button type="button" className="btn sm quiet ev-icon ev-find-prev" aria-label="Previous match" title="Previous match (Shift+Enter)"
        disabled={!total} onClick={() => go(-1)}><Icon name="chevron" /></button>
      <button type="button" className="btn sm quiet ev-icon ev-find-next" aria-label="Next match" title="Next match (Enter)"
        disabled={!total} onClick={() => go(1)}><Icon name="chevron" /></button>
      <button type="button" className="btn sm quiet ev-icon" aria-label="Close find" title="Close (Escape)" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );
}
