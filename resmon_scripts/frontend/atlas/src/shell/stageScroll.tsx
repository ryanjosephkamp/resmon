import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';

/**
 * Where the stage, the frame's one scrolling area, was on each history entry,
 * kept in memory as the drafts are (`drafts.tsx`): Back and Forward put a page
 * back where it was left, as a browser does, and a page opened anew starts at
 * its top. Without this the stage kept its place across screens, so Analytics
 * opened from the bottom of a long run history opened halfway down.
 *
 * Nothing goes to browser storage, which Atlas does not use: the places last as
 * long as the window's page does. An entry the router did not make (the first
 * page, or an address set from outside, as a notice's click sets one) has the
 * key "default", shared by all of them, so each place is kept with its address
 * and is put back only on that address.
 */
export class ScrollMemory {
  private readonly entries = new Map<string, { path: string; place: Place }>();

  constructor(private readonly limit = SCROLL_LIMIT) {}

  /** Where the entry was left, if it was left on this address. */
  read(key: string, path: string): Place | null {
    const kept = this.entries.get(key);
    return kept && kept.path === path ? kept.place : null;
  }

  /** The newest written is kept last, so past the limit the longest-untouched place goes first. */
  write(key: string, path: string, place: Place): void {
    this.entries.delete(key);
    this.entries.set(key, { path, place });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Far more entries than a walk back through history reaches; each is a place and an address. */
export const SCROLL_LIMIT = 200;

/**
 * A place on a page: how far down the stage was, and the row at its top, by
 * what the row is (a run, a paper, a file), with how far that row sat below
 * the stage's top edge.
 *
 * The row is what is put back. A long list draws only the rows near the screen
 * (`content-visibility` on the Runs tab, a virtualizer in the Library), and the
 * rows it has not drawn take an estimated height, so a list opened again is
 * not the height it was when it was left: on the Runs tab, measured, the run
 * at the top of the screen came back 409 pixels lower at the same distance
 * down. The distance is kept for a page with no such row, and for one whose
 * row has gone.
 */
export interface Place {
  top: number;
  anchor: { selector: string; offset: number } | null;
}

/**
 * What a row in a list is known by: an element carrying one of these, found
 * once in the stage, is the same row when the page is opened again.
 */
const IDENTITIES = ['data-run', 'data-document', 'data-paper', 'data-file', 'data-routine', 'data-project', 'data-pair', 'data-source'];
const ANY_IDENTITY = IDENTITIES.map((name) => `[${name}]`).join(', ');

/**
 * The first row whose top is in view, by what it is, and how far below the
 * stage's top edge that is; null for none.
 *
 * A row cut by the top edge is passed over for the one below it, whose top was
 * in view; a page known by what it is (a run's, a paper's), taller than the
 * view, is looked past for the rows on it.
 *
 * It is looked for down from the top, past a bar held at the top of the stage
 * as it scrolls (the run history's filters), and at a few points across: in the
 * gallery the point two fifths across can fall in the gap between two covers,
 * at every height. A row in a box that scrolls on its own (Search › Your
 * collection's results) is not the stage's: the stage's place cannot put it back.
 *
 * It costs hit tests and queries over the whole stage, a few milliseconds on a
 * slow machine with a thousand runs listed, so it is read once a scroll has
 * come to rest (`StageScroll`), not on every scroll.
 */
export function anchorAt(stage: HTMLElement): Place['anchor'] {
  // A page with nothing known by what it is costs one query.
  if (!stage.querySelector(ANY_IDENTITY)) return null;
  const box = stage.getBoundingClientRect();
  let y = box.top + 8;
  for (let tries = 0; tries < 12 && y < box.bottom; tries += 1) {
    let next = y + 48;
    for (const x of [0.4, 0.2, 0.6, 0.8].map((across) => box.left + box.width * across)) {
      const row = rowAt(stage, x, y);
      if (!row) continue;
      const edge = row.node.getBoundingClientRect();
      if (edge.top >= box.top - 0.5) return { selector: row.selector, offset: edge.top - box.top };
      // A row cut by the top edge: the next look is just below it. A page taller than the view is looked
      // past, across and then further down.
      if (edge.bottom < box.bottom) {
        next = Math.max(next, edge.bottom + 8);
        break;
      }
    }
    y = next;
  }
  return null;
}

/** The row under a point in the stage, by what it is: the nearest element around the point known by an identity found once. */
function rowAt(stage: HTMLElement, x: number, y: number): { node: Element; selector: string } | null {
  for (let node = stage.ownerDocument.elementFromPoint(x, y); node && node !== stage && stage.contains(node); node = node.parentElement) {
    for (const name of IDENTITIES) {
      const value = node.getAttribute(name);
      if (value === null) continue;
      const selector = `[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;
      // A mark that shows up more than once (a source's mark in each run) is not a row of its own.
      if (stage.querySelectorAll(selector).length === 1 && !scrollsOnItsOwn(node, stage)) return { node, selector };
    }
  }
  return null;
}

/** Whether a box between the row and the stage scrolls the row itself. */
function scrollsOnItsOwn(row: Element, stage: HTMLElement): boolean {
  for (let node = row.parentElement; node && node !== stage; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) return true;
  }
  return false;
}

/**
 * Where the stage goes when the page changes: a place, or `keep` to leave it.
 *
 * - Back or Forward (`POP`) to an entry left at a place: that place.
 * - Any other move to another screen (a link, a tab, a command, Back to an
 *   entry with no place kept): the top.
 * - A change of the address within one screen (a filter, a shelf, a panel
 *   opened over a list, a screen tidying its own address): where it is.
 */
export function landing(type: `${NavigationType}`, from: string, to: string, kept: Place | null): Place | 'keep' {
  if (type === 'POP' && kept !== null) return kept;
  return from === to ? 'keep' : TOP;
}

const TOP: Place = { top: 0, anchor: null };

/**
 * The longest a place put back is held while the page settles: its lists
 * drawing and measuring their rows, their next pages read, its parts above
 * reading, on a slow machine as on a fast one.
 */
export const HOLD_MS = 5_000;

/**
 * Put the stage at a place, and hold it there while the page settles, for up
 * to five seconds (`HOLD_MS`).
 *
 * What is held is the row the place names, at its old distance below the top
 * edge. It is waited for: a list may not have drawn it yet (the Library's
 * gallery draws only the rows near the view, and only once it has measured the
 * page around it), so until it comes the stage goes to the old distance down,
 * and when it comes the stage is put by it. It is put again in the frame any
 * part of the page changes size (a `ResizeObserver` on the screen), so as the
 * rows above it are drawn at their own height, rather than the height a long
 * list estimates for a row it has not drawn, it stays where it was. A row that
 * never comes (deleted since, or filtered out) leaves the old distance down,
 * as for a page with no such row.
 *
 * While the place is held, the stage moving by itself is not the page moving
 * it in three cases: the stage pushed back to its end by a page that for now
 * is shorter than the place (the rows near the view drawn shorter than their
 * estimate, the list's next page not read yet), and put again as the page
 * grows; a list that moved the stage and kept the row where it is held; and a
 * list that moved it as it drew the row, which is then put by the row. The
 * browser's own scroll anchoring is off meanwhile, since it would move the
 * place by whatever a part above it changed as it drew, and the stage says it
 * is held (`holdsPlace`), so the gallery does not move it as it measures its
 * rows.
 *
 * Given up at once when the person moves the page (a wheel up or down, a
 * touch, a key, the pointer pressed on the stage or its scroll bar), or when
 * something on the page moves the stage itself: a screen that opens at its own
 * place (Settings' `?focus=`, a file's `#links`) keeps it. The top of a page
 * needs none of this. Returns the way to stop.
 */
export function placeStage(node: HTMLElement, place: Place): () => void {
  const { anchor } = place;
  const row = () => (anchor ? node.querySelector(anchor.selector) : null);
  // By the row while it is in the page; without it, the old distance down.
  const want = (found: Element | null) => (found && anchor
    ? node.scrollTop + found.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset
    : place.top);
  const first = row();
  node.scrollTop = want(first);
  if (place.top === 0 && !anchor) return () => {};
  let set = node.scrollTop;
  // Whether the stage was last put by the row, rather than by the distance while the row had not come.
  let byRow = first !== null;
  let frame = 0;
  let stopped = false;
  const started = performance.now();
  node.style.overflowAnchor = 'none';
  node.setAttribute(HELD, '');

  const put = (found: Element | null) => {
    const to = want(found);
    if (Math.abs(node.scrollTop - to) > 1) node.scrollTop = to;
    set = node.scrollTop;
    byRow = found !== null;
  };
  /** Puts the stage again; false, having let go, when the page has moved it. */
  const hold = (): boolean => {
    const found = row();
    if (Math.abs(node.scrollTop - set) > 1) {
      // Pushed back to its end: the page grew shorter than where the stage was.
      const clamped = node.scrollTop < set && node.scrollTop >= node.scrollHeight - node.clientHeight - 1;
      const settling = clamped
        // A list kept the row where it is held, or the row has just come.
        || (found !== null && (Math.abs(want(found) - node.scrollTop) <= 1 || !byRow));
      if (!settling) {
        stop();
        return false;
      }
    }
    put(found);
    return true;
  };
  const follow = () => {
    if (performance.now() - started > HOLD_MS) return stop();
    if (hold()) frame = requestAnimationFrame(follow);
  };
  const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!stopped) hold(); }) : null;
  for (const child of Array.from(node.children)) resized?.observe(child);
  const wheel = (event: WheelEvent) => {
    // A wheel sideways is the rest of a swipe that went Back or Forward; it does not move the stage.
    if (Math.abs(event.deltaY) >= Math.abs(event.deltaX)) stop();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    resized?.disconnect();
    node.style.removeProperty('overflow-anchor');
    node.removeAttribute(HELD);
    node.removeEventListener('wheel', wheel);
    for (const type of INPUT) node.removeEventListener(type, stop);
    window.removeEventListener('keydown', stop);
  };
  node.addEventListener('wheel', wheel, { passive: true });
  for (const type of INPUT) node.addEventListener(type, stop, { passive: true });
  window.addEventListener('keydown', stop);
  frame = requestAnimationFrame(follow);
  return stop;
}

/** What else a person does to move the page themselves: a touch, and the pointer pressed on the stage or its scroll bar. */
const INPUT = ['touchstart', 'pointerdown'] as const;

/** Set on the stage while a place put back is held on it. */
const HELD = 'data-place-held';

/**
 * Whether a place put back is being held on the stage (`placeStage`). A list
 * on the stage leaves the stage where it is meanwhile: the hold puts the row
 * it names where it was left as the rows above it are measured, and a list
 * moving the stage too would move it against that.
 */
export function holdsPlace(stage: Element): boolean {
  return stage.hasAttribute(HELD);
}

/**
 * How long the stage is still before the row at its top is read: longer than
 * the gap between two scroll events, a frame, on a slow machine as on a fast one.
 */
export const SETTLE_MS = 150;

/**
 * What a person does just before the page may change under them: the pointer
 * pressed (a link, a tab, a row) and a key (a shortcut, Back). Heard on the
 * window as they go down, before the page acts on them.
 */
const ABOUT_TO_ACT = ['pointerdown', 'keydown'] as const;

/**
 * The stage's place on each history entry. Drawn as the stage's first child,
 * so its layout effect runs before those of the screen after it: a screen that
 * puts the stage somewhere when it opens, or a field that takes the focus and
 * scrolls itself into view, does so after this and is not undone.
 *
 * Each scroll keeps how far down the stage is, which costs nothing. The row at
 * the top (`anchorAt`) is read once the scroll has come to rest (`SETTLE_MS`),
 * or at once if the person presses the pointer or a key first, or the window
 * is about to go to another page (the Navigation API's `navigate`, which comes
 * before the router draws the new one): a click that leaves the page keeps the
 * row it left. Until it is read, the place is the distance down alone.
 */
export function StageScroll({ stage, memory }: { stage: RefObject<HTMLElement | null>; memory?: ScrollMemory }) {
  const [places] = useState(() => memory ?? new ScrollMemory());
  const location = useLocation();
  const type = useNavigationType();
  const address = `${location.pathname}${location.search}`;
  // The entry on screen, which the stage's scrolling is kept under, and the screen the last one showed.
  const here = useRef({ key: location.key, path: address });
  const screen = useRef<string | null>(null);

  useEffect(() => {
    const node = stage.current;
    if (!node) return undefined;
    // The scroll whose row has not been read yet, as its timer; 0 for none.
    let unread = 0;
    const read = () => {
      if (!unread) return;
      window.clearTimeout(unread);
      unread = 0;
      places.write(here.current.key, here.current.path, { top: node.scrollTop, anchor: anchorAt(node) });
    };
    const keep = () => {
      places.write(here.current.key, here.current.path, { top: node.scrollTop, anchor: null });
      window.clearTimeout(unread);
      unread = window.setTimeout(read, SETTLE_MS);
    };
    const navigation = (window as { navigation?: Navigation }).navigation;
    node.addEventListener('scroll', keep, { passive: true });
    for (const event of ABOUT_TO_ACT) window.addEventListener(event, read, { capture: true, passive: true });
    navigation?.addEventListener('navigate', read);
    return () => {
      window.clearTimeout(unread);
      node.removeEventListener('scroll', keep);
      for (const event of ABOUT_TO_ACT) window.removeEventListener(event, read, { capture: true });
      navigation?.removeEventListener('navigate', read);
    };
  }, [stage, places]);

  useLayoutEffect(() => {
    const from = screen.current;
    here.current = { key: location.key, path: address };
    screen.current = location.pathname;
    const node = stage.current;
    // The window's first page opens where it is drawn.
    if (!node || from === null) return undefined;
    const to = landing(type, from, location.pathname, type === 'POP' ? places.read(location.key, address) : null);
    return to === 'keep' ? undefined : placeStage(node, to);
  }, [location.key, location.pathname, address, type, stage, places]);

  return null;
}
