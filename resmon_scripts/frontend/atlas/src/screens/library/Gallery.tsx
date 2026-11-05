import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { holdsPlace } from '../../shell/stageScroll';
import { columnsFor, movesStageAsItMeasures, NARROW, readsMore, rowEstimate } from './galleryModel';

/** Rows drawn past each edge of the view, so a scroll and Tab land on covers already there. */
const OVERSCAN = 2;
/** How close to the last row read the view comes before the next page is asked for. */
const READ_AHEAD = 3;

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
export function Gallery<T>({ items, keyOf, label, total, more, children }: {
  items: readonly T[];
  keyOf: (item: T) => string;
  label: string;
  /** Every card on the shelf, when the engine counted them; the set size for a screen reader. */
  total: number | null;
  /** The next page: whether there is one, whether it is being read, whether the last ask failed, and the ask. */
  more: { has: boolean; reading: boolean; failed: boolean; read: () => void };
  children: (item: T, index: number, narrow: boolean) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [stage, setStage] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);

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
  // A row measured above the view moves the stage by what it grew, but not while Back's place is held on it.
  useLayoutEffect(() => {
    virtual.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => movesStageAsItMeasures({
      held: stage !== null && holdsPlace(stage),
      first: !instance.itemSizeCache.has(item.key),
      start: item.start,
      end: item.end,
      offset: instance.scrollOffset ?? 0,
      backward: instance.scrollDirection === 'backward',
    });
  }, [virtual, stage]);
  const drawn = virtual.getVirtualItems();
  const last = drawn.length ? drawn[drawn.length - 1]!.index : -1;
  const { has, reading, failed, read } = more;
  useEffect(() => {
    if (readsMore({ has, reading, failed, last, rows, ahead: READ_AHEAD })) read();
  }, [has, reading, failed, read, last, rows]);

  return (
    <>
      <div ref={box} className={narrow ? 'gal narrow' : 'gal'} role="list" aria-label={label}
        data-columns={columns} style={{ height: virtual.getTotalSize() }}>
        {drawn.map((row) => {
          const start = row.index * columns;
          return (
            <div key={row.key} ref={virtual.measureElement} data-index={row.index} className="gal-row"
              style={{ transform: `translateY(${row.start - margin}px)`, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {items.slice(start, start + columns).map((item, j) => (
                <div key={keyOf(item)} role="listitem" aria-posinset={start + j + 1} aria-setsize={total ?? -1} className="gal-cell">
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
          <button type="button" className="btn sm" disabled={reading} onClick={read}>{reading ? 'Reading more' : failed ? 'Try again' : 'Show more'}</button>
        </p>
      )}
    </>
  );
}
