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
 * (`content-visibility`), and the rows it has not drawn take an estimated
 * height, so a list opened again is not the height it was when it was left:
 * on the Runs tab, measured, the run at the top of the screen came back 409
 * pixels lower at the same distance down. The distance is kept for a page with
 * no such row, and for one whose row has gone.
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

/** The row at the top of the stage, by what it is, and how far below the top edge it sits; null for none. */
export function anchorAt(stage: HTMLElement): Place['anchor'] {
  const box = stage.getBoundingClientRect();
  // A few heights down, past a bar held at the top of the stage as it scrolls (the run history's filters).
  for (const y of [8, 56, 104, 160].map((down) => box.top + down)) {
    let node = stage.ownerDocument.elementFromPoint(box.left + box.width * 0.4, y);
    while (node && node !== stage && stage.contains(node)) {
      for (const name of IDENTITIES) {
        const value = node.getAttribute(name);
        if (value === null) continue;
        const selector = `[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;
        // A mark that shows up more than once (a source's mark in each run) is not a row of its own.
        if (stage.querySelectorAll(selector).length === 1) {
          return { selector, offset: node.getBoundingClientRect().top - box.top };
        }
      }
      node = node.parentElement;
    }
  }
  return null;
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

/** How long a place put back is held while the page settles: its lists drawing, its parts above reading. */
const FOLLOW_MS = 2_000;

/**
 * Put the stage at a place, and hold it there while the page settles, frame by
 * frame for up to two seconds: the row the place names is kept at its old
 * distance from the top as the rows around it draw, and a page still drawing
 * (a list's next page) is followed until it is tall enough. The browser's own
 * scroll anchoring is off meanwhile, since it would move the place by whatever
 * a part above it changed as it drew. Given up at once when the person scrolls
 * or presses a key, or when something on the page moves the stage itself: a
 * screen that opens at its own place (Settings' `?focus=`, a file's `#links`)
 * keeps it. The top of a page needs none of this. Returns the way to stop.
 */
export function placeStage(node: HTMLElement, place: Place): () => void {
  const want = () => {
    const row = place.anchor ? node.querySelector(place.anchor.selector) : null;
    if (!row || !place.anchor) return place.top;
    return node.scrollTop + row.getBoundingClientRect().top - node.getBoundingClientRect().top - place.anchor.offset;
  };
  node.scrollTop = want();
  if (place.top === 0 && !place.anchor) return () => {};
  let set = node.scrollTop;
  let frame = 0;
  const started = performance.now();
  node.style.overflowAnchor = 'none';
  const stop = () => {
    cancelAnimationFrame(frame);
    node.style.removeProperty('overflow-anchor');
    for (const type of INPUT) node.removeEventListener(type, stop);
    window.removeEventListener('keydown', stop);
  };
  const follow = () => {
    if (Math.abs(node.scrollTop - set) > 1 || performance.now() - started > FOLLOW_MS) return stop();
    const to = want();
    if (Math.abs(node.scrollTop - to) > 1) {
      node.scrollTop = to;
      set = node.scrollTop;
    }
    frame = requestAnimationFrame(follow);
  };
  for (const type of INPUT) node.addEventListener(type, stop, { passive: true });
  window.addEventListener('keydown', stop);
  frame = requestAnimationFrame(follow);
  return stop;
}

/** What a person does to move the page themselves. */
const INPUT = ['wheel', 'touchstart', 'pointerdown'] as const;

/**
 * The stage's place on each history entry. Drawn as the stage's first child,
 * so its layout effect runs before those of the screen after it: a screen that
 * puts the stage somewhere when it opens, or a field that takes the focus and
 * scrolls itself into view, does so after this and is not undone.
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
    // A scroll event comes once a frame at most, with the page laid out: the row at the top is read then.
    const keep = () => places.write(here.current.key, here.current.path, { top: node.scrollTop, anchor: anchorAt(node) });
    node.addEventListener('scroll', keep, { passive: true });
    return () => node.removeEventListener('scroll', keep);
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
