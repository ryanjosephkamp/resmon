import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { holdsPlace } from '../../shell/stageScroll';
import { columnsFor, movesStageAsItMeasures, NARROW, readsMore, rowEstimate } from './galleryModel';

/** Rows drawn past each edge of the view, so a scroll and Tab land on covers already there. */
const OVERSCAN = 2;
/** How close to the last row read the view comes before the next page is asked for. */
const READ_AHEAD = 3;

/** Whether the gallery moves the stage as it measures a row (`movesStageAsItMeasures`), for the stage it is drawn in. */
export function movesStageAsGalleryMeasures(stage: HTMLElement | null): (item: { key: string | number | bigint; start: number; end: number },
  delta: number, instance: Virtualizer<HTMLElement, Element>) => boolean {
  return (item, _delta, instance) => movesStageAsItMeasures({
    held: stage !== null && holdsPlace(stage),
    apart: stage !== null && Math.abs((instance.scrollOffset ?? 0) - stage.scrollTop) > 1,
    first: !instance.itemSizeCache.has(item.key),
    start: item.start,
    end: item.end,
    offset: instance.scrollOffset ?? 0,
    backward: instance.scrollDirection === 'backward',
  });
}

/**
 * A shelf's covers as a grid that draws only the rows near the view. The
 * page scrolls in the frame's stage, so the rows are placed against it and the
 * grid's own top is measured where the stage's content puts it; a few hundred
 * covers cost what a dozen rows do. Each row is measured once drawn, so a
 * title that wraps or a label that does not is the height it is.
 *
 * Covers stay in the page in shelf order, so Tab and a screen reader go
 * through them in order, and each says its place in the whole.
 */
export function Gallery<T>({ items, keyOf, label, total, more, onSelectAll, children }: {
  items: readonly T[];
  keyOf: (item: T) => string;
  label: string;
  /** Every card on the shelf, when the engine counted them; the set size for a screen reader. */
  total: number | null;
  /** The next page: whether there is one, whether it is being read, whether the last ask failed, and the ask. */
  more: { has: boolean; reading: boolean; failed: boolean; read: () => void };
  onSelectAll?: () => void;
  children: (item: T, index: number, narrow: boolean) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [stage, setStage] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return undefined;
    setStage(node.closest<HTMLElement>('.stage') ?? document.scrollingElement as HTMLElement | null);
    setWidth(node.clientWidth);
    const watch = new ResizeObserver(() => setWidth(node.clientWidth));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  // The grid's top within the stage's content: measured now, and again whenever the page around it changes
  // size, since a notice or a wrapped toolbar above the grid moves it down.
  useLayoutEffect(() => {
    const node = box.current;
    const page = node?.parentElement;
    if (!node || !page || !stage) return undefined;
    const measure = () => {
      const top = node.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop;
      setMargin((was) => (Math.abs(top - was) > 1 ? top : was));
    };
    measure();
    const watch = new ResizeObserver(measure);
    for (const child of Array.from(page.children)) if (child !== node) watch.observe(child);
    watch.observe(page);
    return () => watch.disconnect();
  }, [stage, items.length]);

  const columns = columnsFor(width);
  const narrow = width > 0 && width < NARROW;
  const rows = Math.ceil(items.length / columns);
  const virtual = useVirtualizer({
    count: rows,
    // Drawn against the stage once it is known, from where the stage is: a virtualizer that meets its
    // scroller scrolls it to its initial offset, which would put the gallery at its top just after Back
    // has put it where it was left.
    enabled: stage !== null,
    initialOffset: () => stage?.scrollTop ?? 0,
    getScrollElement: () => stage,
    estimateSize: () => rowEstimate(width, columns),
    overscan: OVERSCAN,
    scrollMargin: margin,
    getItemKey: (index) => {
      const first = items[index * columns];
      return first === undefined ? index : `${keyOf(first)}/${columns}`;
    },
  });
  useEffect(() => { virtual.measure(); }, [columns, virtual]);
  // A row measured above the view moves the stage by what it grew, but not while Back's place is held on it,
  // nor while the gallery reads the stage as further down than it is (a new shelf, drawn shorter).
  useLayoutEffect(() => {
    virtual.shouldAdjustScrollPositionOnItemSizeChange = movesStageAsGalleryMeasures(stage);
  }, [virtual, stage]);
  const drawn = virtual.getVirtualItems();
  const last = drawn.length ? drawn[drawn.length - 1]!.index : -1;
  const { has, reading, failed, read } = more;
  useEffect(() => {
    if (readsMore({ has, reading, failed, last, rows, ahead: READ_AHEAD })) read();
  }, [has, reading, failed, read, last, rows]);

  // A row may not exist yet when an arrow reaches it. Scroll it into the
  // virtual window, then focus its cover once that row has been drawn.
  const focusCard = (key: string): boolean => {
    const cell = Array.from(box.current?.querySelectorAll<HTMLElement>('[data-gallery-key]') ?? [])
      .find((node) => node.dataset.galleryKey === key);
    const thumb = cell?.querySelector<HTMLElement>('.thumb');
    if (!thumb) return false;
    thumb.focus({ preventScroll: true });
    return true;
  };
  useLayoutEffect(() => {
    if (pendingKey !== null && focusCard(pendingKey)) setPendingKey(null);
  });
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || !(event.target instanceof Element)) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a' && onSelectAll) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const key = event.target.closest<HTMLElement>('[data-gallery-key]')?.dataset.galleryKey;
      if (key) setPendingKey(key);
      onSelectAll();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !event.target.closest('.thumb')) return;
    const cell = event.target.closest<HTMLElement>('[data-gallery-key]');
    const at = items.findIndex((item) => keyOf(item) === (cell?.dataset.galleryKey ?? pendingKey));
    const row = cell?.closest<HTMLElement>('.gal-row');
    const tracks = row ? getComputedStyle(row).gridTemplateColumns.trim() : '';
    const drawnColumns = /^repeat\((\d+),/.exec(tracks)?.[1];
    const stride = drawnColumns ? Number(drawnColumns) : tracks && tracks !== 'none' ? tracks.split(/\s+/).length : columns;
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1
      : event.key === 'ArrowUp' ? -stride : event.key === 'ArrowDown' ? stride : 0;
    if (at < 0 || step === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const to = Math.max(0, Math.min(items.length - 1, at + step));
    const item = items[to];
    if (item === undefined) return;
    const key = keyOf(item);
    virtual.scrollToIndex(Math.floor(to / stride), { align: 'auto' });
    setPendingKey(focusCard(key) ? null : key);
  };

  return (
    <>
      <div ref={box} className={narrow ? 'gal narrow' : 'gal'} role="list" aria-label={label}
        data-columns={columns} onKeyDown={onKey} style={{ height: virtual.getTotalSize() }}>
        {drawn.map((row) => {
          const start = row.index * columns;
          return (
            <div key={row.key} ref={virtual.measureElement} data-index={row.index} className="gal-row"
              style={{ transform: `translateY(${row.start - margin}px)`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {items.slice(start, start + columns).map((item, j) => (
                <div key={keyOf(item)} role="listitem" aria-posinset={start + j + 1} aria-setsize={total ?? -1} className="gal-cell" data-gallery-key={keyOf(item)}>
                  {children(item, start + j, narrow)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {has && (
        <p className="gal-more">
          {failed && !reading && <span className="field-error" role="alert">The next covers could not be read. </span>}
          <button type="button" className="btn sm" disabled={reading} onClick={read}>{reading ? 'Reading More' : failed ? 'Try Again' : 'Show More'}</button>
        </p>
      )}
    </>
  );
}
