import { useCallback, useEffect, useRef, type ChangeEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import './selection.css';

/** Whether a dialog or a popover is open, which takes Esc first. */
function overlayOpen(): boolean {
  if (document.querySelector('dialog[open]')) return true;
  try {
    return document.querySelector(':popover-open') !== null;
  } catch {
    return false; // a document that does not know popovers has none open
  }
}

/**
 * A selection's bar, in the place of the toolbar it replaces, so nothing
 * below it moves: how many are picked, Select all, the actions, and Done,
 * then anything said about them on lines of their own.
 * The Library's covers, Search's matches, a run's papers, and Today's list
 * all use it, so picking reads the same everywhere; the actions are the
 * caller's (Save to read, and any that join it). Esc is Done, unless a dialog
 * or something else has taken the key.
 */
export function SelectBar({ label, said, tick, allLabel, onAll, onDone, doneLabel = 'Done', children, below, className }: {
  /** The group's name, for a screen reader and a test: "The picked cards". */
  label: string;
  /** "3 of 1,204 selected". */
  said: string;
  tick: 'none' | 'part' | 'on';
  /** "Select all 1,204 matches", or null once every one is picked. */
  allLabel: string | null;
  onAll: () => void;
  onDone: () => void;
  doneLabel?: string;
  children: ReactNode;
  /** What is said on lines of its own under the bar's row: a question before an action, a refusal, a limit. */
  below?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || overlayOpen()) return;
      onDone();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onDone]);
  return (
    <div className={className ? `selbar ${className}` : 'selbar'} role="group" aria-label={label}>
      <span className="n" data-select="said">
        <span className={`tick${tick === 'on' ? ' on' : tick === 'part' ? ' part' : ''}`} aria-hidden="true" />{said}
      </span>
      {allLabel && <button type="button" className="btn quiet sm" data-select="all" onClick={onAll}>{allLabel}</button>}
      {children}
      <button type="button" className="btn quiet sm done" data-select="done" onClick={onDone}>{doneLabel}</button>
      {below}
    </div>
  );
}

/**
 * A row's box in select mode. A click picks the row, and Shift-click every
 * row from the last one picked; Space and Shift+Space do the same from the
 * keyboard. The arrows move between rows (`useRowKeys`).
 */
export function PickBox({ picked, label, index, onPick }: {
  picked: boolean;
  label: string;
  /** The row's place in the list, from 0, which the arrows move by. */
  index: number;
  onPick: (range: boolean) => void;
}) {
  // A click's Shift is on the click; React reads a checkbox's change from its click.
  const onChange = (event: ChangeEvent<HTMLInputElement>) => onPick((event.nativeEvent as MouseEvent).shiftKey === true);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== ' ') return;
    // Space is handled here rather than left to the browser, so Shift+Space is a range wherever it is pressed.
    event.preventDefault();
    onPick(event.shiftKey);
  };
  return (
    <input type="checkbox" className="pickbox" checked={picked} aria-label={label} data-pick-index={index}
      onChange={onChange} onKeyDown={onKeyDown} />
  );
}

/** How many frames a row brought into view is waited for before the keyboard gives up on it. */
const FRAMES = 6;

/**
 * The arrows over a list's boxes: Up and Down move to the row before or after,
 * Home and End to the first and last read, and with Shift the row moved to is
 * picked with every row back to the last one picked. ⌘A (Ctrl+A) is Select
 * all. A list drawn as a window brings the row into view first (`scrollTo`),
 * and the keyboard goes to its box once it is drawn.
 */
export function useRowKeys({ count, onRange, onAll, scrollTo, within }: {
  count: number;
  /** Shift and an arrow: pick the row at `to`, and every row back to the last one picked, or to `from`. */
  onRange: (to: number, from: number) => void;
  onAll: () => void;
  scrollTo?: (index: number) => void;
  /** The element the rows are in, where the caller holds it already; otherwise give it `attach` as its ref. */
  within?: RefObject<HTMLElement | null>;
}) {
  const own = useRef<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => { own.current = node; }, []);
  const focusAt = useCallback((index: number) => {
    let frames = 0;
    const tryFocus = () => {
      const box = (within?.current ?? own.current)?.querySelector<HTMLInputElement>(`input[data-pick-index="${index}"]`);
      if (box) { box.focus(); return; }
      if (frames++ < FRAMES) requestAnimationFrame(tryFocus);
    };
    scrollTo?.(index);
    tryFocus();
  }, [scrollTo, within]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const at = target.dataset?.pickIndex;
    if (at === undefined || target.tagName !== 'INPUT') return;
    const index = Number(at);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      onAll();
      return;
    }
    const to = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1
      : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
    if (to === null) return;
    event.preventDefault();
    if (to < 0 || to >= count || to === index) return;
    if (event.shiftKey) onRange(to, index);
    focusAt(to);
  }, [count, onRange, onAll, focusAt]);
  return { attach, onKeyDown };
}
