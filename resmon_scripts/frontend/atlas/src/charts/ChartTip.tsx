import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore,
  type FocusEvent, type PointerEvent, type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../shell/Icon';
import { placeTip, type Box, type Point } from './place';
import './charts.css';

/** One part of a mark, keyed by the color it is drawn in on the chart. */
export interface TipLine {
  /** The part's number, set first and strongest. */
  value: string;
  /** What the number is. */
  label: string;
  /** The chart's color for this part, as a short stroke; none where the part is not drawn in a color of its own. */
  key?: 'accent' | 'context' | 'fault' | 'ink';
}

/**
 * What a mark's tooltip says, in the app's words: the mark's name, the number
 * it draws, its parts, what it counts, and where a click on it goes. `opens`
 * is left out where a click goes nowhere, so the tip never offers what the
 * mark cannot do.
 */
export interface TipContent {
  /** The mark's name: a source, a month, a run. */
  name?: string;
  /** The number the mark draws, or a paper's title on a map. */
  value: string;
  lines?: readonly TipLine[];
  /** What the mark counts, and anything that qualifies its number, in quieter type. */
  notes?: readonly string[];
  /** Where a click goes, as a sentence: "Opens Search › Your collection narrowed to arXiv". */
  opens?: string | null;
}

/** A tip's content as one sentence, for a mark's accessible name: the same words the tip shows. */
export function tipWords(content: TipContent): string {
  const head = content.name ? `${content.name}: ${content.value}` : content.value;
  const lines = (content.lines ?? []).map((line) => `${line.value} ${line.label}`);
  const body = [head, ...lines].join(', ');
  const tail = [...(content.notes ?? []), content.opens ?? ''].filter(Boolean).map((s) => s.replace(/\.$/, ''));
  return [body, ...tail].join('. ') + '.';
}

/**
 * What a tip is beside: an element (a bar, a cell, a point drawn for it), and
 * the pointer where the pointer brought it there, so it follows the pointer
 * along the mark.
 */
export interface TipAnchor {
  /** The mark; several elements are one mark together (a column's figure and its bar), and the tip keeps clear of all of them. */
  element: Element | readonly Element[];
  pointer?: Point | null;
  /** The element that took the pointer, where it is larger than `element` (a row around its bar). */
  target?: Element | null;
}

/** Whether the pointer, held still, is still over the mark it brought a tip for, after the page moved under it. */
function stillUnder(anchor: TipAnchor): boolean {
  if (!anchor.pointer) return true;
  const under = document.elementFromPoint(anchor.pointer.x, anchor.pointer.y);
  const over = anchor.target ? [anchor.target] : ([] as Element[]).concat(anchor.element);
  return !!under && over.some((element) => element.contains(under));
}

/** The box around every element of a mark. */
function boxOf(element: Element | readonly Element[]): Box {
  const boxes = ([] as Element[]).concat(element).map((e) => e.getBoundingClientRect());
  return {
    left: Math.min(...boxes.map((r) => r.left)), top: Math.min(...boxes.map((r) => r.top)),
    right: Math.max(...boxes.map((r) => r.right)), bottom: Math.max(...boxes.map((r) => r.bottom)),
  };
}

/**
 * The tooltip itself, drawn over the page rather than inside the chart, so a
 * chart's own edges never clip it and it is held inside the window instead.
 * It is placed after it is drawn, before the frame is painted, from its own
 * size (`place.ts`). Escape puts it away; a scroll moves it with its mark,
 * or puts away one the pointer brought where the scroll has moved the mark
 * out from under the pointer.
 */
export function ChartTip({ anchor, content, onDismiss }: {
  anchor: TipAnchor | null; content: TipContent | null; onDismiss?: () => void;
}) {
  const tip = useRef<HTMLDivElement>(null);
  const place = useCallback(() => {
    const node = tip.current;
    if (!node || !anchor) return;
    node.style.left = '0px';
    node.style.top = '0px';
    const size = node.getBoundingClientRect();
    // macOS's tab bar, over the page's top while the windows are in tabs (`shell/WindowFrame.tsx`): never under it.
    const strip = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tab-strip')) || 0;
    const at = placeTip(boxOf(anchor.element), { width: size.width, height: size.height },
      { width: window.innerWidth, height: window.innerHeight }, anchor.pointer, strip);
    node.style.left = `${Math.round(at.left)}px`;
    node.style.top = `${Math.round(at.top)}px`;
    node.dataset.side = at.side;
  }, [anchor]);
  // Placed again after every render: the mark may have moved (a map's paper under a still pointer) with nothing else changed.
  useLayoutEffect(() => place());

  const shown = !!anchor && !!content;
  const dismiss = useRef(onDismiss);
  useEffect(() => { dismiss.current = onDismiss; });
  useEffect(() => {
    if (!shown || !anchor) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss.current?.(); };
    const onScroll = () => { if (stillUnder(anchor)) place(); else dismiss.current?.(); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [shown, anchor, place]);

  if (!anchor || !content) return null;
  return createPortal(
    <div ref={tip} className="chart-tip" role="tooltip" data-chart-tip="">
      {content.name && <p className="chart-tip-name">{content.name}</p>}
      <p className="chart-tip-value">{content.value}</p>
      {content.lines && content.lines.length > 0 && (
        <ul className="chart-tip-lines">
          {content.lines.map((line) => (
            <li key={`${line.label}|${line.value}`}>
              {line.key && <i className="chart-tip-key" data-key={line.key} aria-hidden="true" />}
              <b className="num">{line.value}</b> {line.label}
            </li>
          ))}
        </ul>
      )}
      {(content.notes ?? []).map((note) => <p key={note} className="chart-tip-note">{note}</p>)}
      {content.opens && (
        <p className="chart-tip-opens"><Icon name="arrow" size={14} />{content.opens}</p>
      )}
    </div>,
    document.body,
  );
}

interface Shown { anchor: TipAnchor; content: TipContent; via: 'pointer' | 'focus' }

/** One chart's tip, held outside React's state so a moving pointer redraws the tip and not the chart. */
function tipStore() {
  let shown: Shown | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => shown,
    set: (next: Shown | null) => {
      shown = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
type TipStore = ReturnType<typeof tipStore>;

function TipLayer({ store }: { store: TipStore }) {
  const shown = useSyncExternalStore(store.subscribe, store.get, store.get);
  return <ChartTip anchor={shown?.anchor ?? null} content={shown?.content ?? null} onDismiss={() => store.set(null)} />;
}

/**
 * Whether focus arrived from the keyboard. A click focuses a button too, and a
 * tip shown for that focus would stay after the pointer left. Where the
 * browser cannot say, focus is taken as the keyboard's.
 */
function byKeyboard(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

export interface MarkTip {
  /**
   * The handlers that show a mark's tip: on the pointer over it, following the
   * pointer, and on keyboard focus. `anchorOf` names the element the tip is
   * set beside when the element that takes the pointer is larger than the mark
   * (a row around its bar).
   */
  mark: (content: TipContent, anchorOf?: (target: HTMLElement) => Element | readonly Element[] | null) => {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
    onFocus: (event: FocusEvent<HTMLElement>) => void;
    onBlur: () => void;
  };
  hide: () => void;
  /** The tip itself; render it once, anywhere in the chart. */
  layer: ReactElement;
}

/**
 * A chart's tip: one per chart, shown for one mark at a time. The pointer's
 * tip follows the pointer; the keyboard's is set beside the focused mark. A
 * pointer leaving puts away only the pointer's tip, and a blur only the
 * keyboard's, so moving the mouse across a chart does not take away the tip
 * of the mark the keyboard is on until the pointer shows another.
 */
export function useChartTip(): MarkTip {
  const store = useMemo(() => tipStore(), []);
  return useMemo<MarkTip>(() => {
    const show = (event: { currentTarget: HTMLElement }, content: TipContent, via: Shown['via'],
      anchorOf?: (target: HTMLElement) => Element | readonly Element[] | null, pointer?: Point) => {
      const found = anchorOf?.(event.currentTarget);
      const element = found && (!Array.isArray(found) || found.length > 0) ? found : event.currentTarget;
      store.set({ anchor: { element, pointer: pointer ?? null, target: event.currentTarget }, content, via });
    };
    // A pointer event with no position (one synthesized without coordinates) is set beside the mark's middle.
    const at = (event: PointerEvent<HTMLElement>): Point | undefined =>
      (Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? { x: event.clientX, y: event.clientY } : undefined);
    return {
      mark: (content, anchorOf) => ({
        onPointerEnter: (event) => show(event, content, 'pointer', anchorOf, at(event)),
        onPointerMove: (event) => show(event, content, 'pointer', anchorOf, at(event)),
        onPointerLeave: () => { if (store.get()?.via === 'pointer') store.set(null); },
        onFocus: (event) => { if (byKeyboard(event.currentTarget)) show(event, content, 'focus', anchorOf); },
        onBlur: () => { if (store.get()?.via === 'focus') store.set(null); },
      }),
      hide: () => store.set(null),
      layer: <TipLayer store={store} />,
    };
  }, [store]);
}
