import { useEffect, useLayoutEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link } from 'react-router-dom';
import type { components } from '../../api/schema';
import { authors, count, publishedWords } from '../today/format';
import { BASIS_MEANING, basisWords as matchBasis } from '../watches/people/model';
import { LifecycleMarks } from '../lifecycle/LifecycleMarks';
import { standingInFor } from './fold';
import { PickBox, useRowKeys } from '../selection/SelectBar';
import { holdsPlace } from '../../shell/stageScroll';
import { movesStageAsItMeasures } from '../library/galleryModel';

type ExplorerPaper = components['schemas']['ExplorerPaper'];
export type Marks = {
  links: NonNullable<components['schemas']['PaperLinks']['links']>;
  matches: NonNullable<components['schemas']['WatchProfileMatchesByDocument']['matches']>;
  events: NonNullable<components['schemas']['LifecycleForDocuments']['events']>;
};
type Folded = Record<string, readonly number[]>;

/** A row's height before it is measured: a title, a line of names, and a link or two. */
const ESTIMATE_PX = 78;
/** Rows drawn past each edge of the view, so scrolling and Tab land on rows already there. */
const OVERSCAN = 10;
/** How close to the last row read the view comes before the next page is asked for. */
const READ_AHEAD = 15;

interface Props {
  rows: readonly ExplorerPaper[];
  /** Every match the search counted, when it counted them all; the list's set size for a screen reader. */
  total: number | null;
  marks: Marks;
  folded: Folded | null;
  showFolded: boolean;
  ranking: 'newest' | 'similarity';
  sourceName: (slug: string) => string;
  /** The box the list scrolls in, once it is in the page; the list is the first thing in it. */
  scroller: HTMLElement | null;
  /** More pages, and asking for the next one. */
  more: { has: boolean; reading: boolean; read: () => void };
  /** Select mode: whether a row is picked, and picking by a row's place in `rows`. */
  picking?: Picking | null;
}

export interface Picking {
  has: (id: number) => boolean;
  onPick: (index: number, range: boolean) => void;
  /** Shift and an arrow: the row at `to`, and every row back to the last one picked, or to `from`. */
  onRange: (to: number, from: number) => void;
  onAll: () => void;
}

const NO_PICKING = { onRange: () => undefined, onAll: () => undefined };

/**
 * The collection's results, as many as have been read, drawn as a window: only
 * the rows in view and a few either side are in the page, each measured once
 * drawn, so ten thousand rows read cost what fifty did. Rows stay in the page
 * in list order, so Tab and a screen reader go through them in order, and each
 * row says its place in the whole (`aria-posinset`). The next page is read as
 * the view nears the last row; Show more reads it too, for a keyboard.
 *
 * In select mode each row has its box. The arrows move between the boxes, a
 * row not drawn yet brought into view first, and Shift with an arrow picks as
 * it goes; Space picks, and Shift+Space or Shift-click picks every row back to
 * the last one picked.
 */
export function ResultList({ rows, total, marks, folded, showFolded, ranking, sourceName, scroller, more, picking = null }: Props) {
  const virtual = useVirtualizer({
    count: rows.length,
    // Drawn against its box once the box is known, from where the box is: a virtualizer that meets its box
    // scrolls it to its initial offset, which would put the list at its top just after Back has put it
    // where it was left.
    enabled: scroller !== null,
    getScrollElement: () => scroller,
    initialOffset: () => scroller?.scrollTop ?? 0,
    estimateSize: () => ESTIMATE_PX,
    overscan: OVERSCAN,
    getItemKey: (index) => rows[index]?.id ?? index,
  });
  // A row measured above the view moves the box by what it grew, as the Library's gallery moves the stage, but
  // not while Back's place is held on it: the hold puts the paper it names where it was left.
  useLayoutEffect(() => {
    virtual.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => movesStageAsItMeasures({
      held: scroller !== null && holdsPlace(scroller),
      first: !instance.itemSizeCache.has(item.key),
      start: item.start,
      end: item.end,
      offset: instance.scrollOffset ?? 0,
      backward: instance.scrollDirection === 'backward',
    });
  }, [virtual, scroller]);
  const items = virtual.getVirtualItems();
  // Until it knows its box the list draws no rows, and is the height its rows are estimated at, so a place
  // Back puts the box at is inside it.
  const height = scroller === null ? rows.length * ESTIMATE_PX : virtual.getTotalSize();
  const { attach, onKeyDown: rowKeys } = useRowKeys({
    count: rows.length, ...(picking ?? NO_PICKING),
    scrollTo: (index) => virtual.scrollToIndex(index, { align: 'auto' }),
  });
  const last = items.length ? (items[items.length - 1]?.index ?? -1) : -1;
  const { has, reading, read } = more;
  useEffect(() => {
    if (has && !reading && rows.length > 0 && last >= rows.length - READ_AHEAD) read();
  }, [has, reading, read, last, rows.length]);

  return (
    <>
      <ol className="result-list virtual" style={{ height }}
        ref={attach} onKeyDown={picking ? rowKeys : undefined}>
        {items.map((item) => {
          const paper = rows[item.index];
          if (!paper) return null;
          const also = marks.links[String(paper.id)] ?? [];
          const people = marks.matches[String(paper.id)] ?? [];
          const standing = folded ? standingInFor(folded, paper.id) : 0;
          const picked = picking?.has(paper.id) ?? false;
          return (
            <li key={item.key} ref={virtual.measureElement} data-index={item.index} data-document={paper.id}
              className={picking ? (picked ? 'result picking picked' : 'result picking') : 'result'}
              aria-posinset={item.index + 1} aria-setsize={total ?? -1}
              style={{ transform: `translateY(${item.start}px)` }}>
              {picking && (
                <PickBox picked={picked} label={`Select “${paper.title}”`} index={item.index}
                  onPick={(range) => picking.onPick(item.index, range)} />
              )}
              <Link to={`/papers/${paper.id}`} className="result-title">{paper.title}</Link>
              <LifecycleMarks events={marks.events[String(paper.id)]} />
              <div className="meta">
                <span className="who">{authors(paper.authors)}</span>
                <span className="sep" />
                <span>{sourceName(paper.source_repository)}</span>
                {paper.publication_date && (<><span className="sep" /><span>{publishedWords(paper.publication_date)}</span></>)}
                {ranking === 'similarity' && (
                  <span className="result-distance num" title="Distance from the phrase; smaller is closer">
                    {paper.distance === null || paper.distance === undefined ? 'not ranked' : paper.distance.toFixed(3)}
                  </span>
                )}
              </div>
              {also.length > 0 && (
                <ul className="result-links">{also.map((link) => <li key={link.id}>{link.label}</li>)}</ul>
              )}
              {people.length > 0 && (
                <ul className="result-people">
                  {people.map((match) => (
                    <li key={`${match.profile_id}:${match.basis}`} data-basis={match.basis}>
                      <span className="basis-chip" title={BASIS_MEANING[match.basis]}>{matchBasis(match.basis)}</span>
                      <Link to={`/watches/people/${match.profile_id}`}>{match.display_name}</Link>
                      <span className="match-author">as {match.matched_author}</span>
                    </li>
                  ))}
                </ul>
              )}
              {showFolded && standing > 0 && (
                <p className="result-folded">Standing in for {count(standing, 'other record')} of the same work.</p>
              )}
            </li>
          );
        })}
      </ol>
      {has && (
        <button type="button" className="btn more" disabled={reading} onClick={read}>
          {reading ? 'Reading more' : 'Show more'}
        </button>
      )}
    </>
  );
}
