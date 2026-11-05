import { useRef, useState, type KeyboardEvent } from 'react';

/**
 * A chart's marks as one stop for the keyboard, the way a grid or a toolbar
 * is: Tab reaches the mark last used (the first, to begin with), the arrow
 * keys move between marks in the chart's order, Home and End go to the first
 * and the last, and Enter opens the mark, as a link or a button does. A chart
 * with dozens of marks is then one Tab, not dozens.
 */
export function useRoving(count: number, first = 0) {
  const [at, setAt] = useState(first);
  const nodes = useRef<(HTMLElement | null)[]>([]);
  const current = Math.max(0, Math.min(at, count - 1));
  const go = (event: KeyboardEvent, to: number) => {
    event.preventDefault();
    const next = Math.max(0, Math.min(count - 1, to));
    setAt(next);
    nodes.current[next]?.focus();
  };
  return {
    /** The props each mark takes, by its place in the chart's order. */
    item: (index: number) => ({
      ref: (node: HTMLElement | null) => { nodes.current[index] = node; },
      tabIndex: index === current ? 0 : -1,
      onFocus: () => setAt(index),
      onKeyDown: (event: KeyboardEvent) => {
        const keys: Record<string, number> = {
          ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: count - 1,
        };
        const to = keys[event.key];
        if (to !== undefined) go(event, to);
      },
    }),
  };
}

/**
 * A grid of marks (the Source wall's sources by runs) as one stop: the arrow
 * keys move a cell left, right, up, or down; Home and End go to the row's
 * first and last cell, and with Control (or Command) to the grid's first and
 * last. `start` is the cell Tab reaches before any has been used.
 */
export function useGridRoving(rows: number, columns: number, start: { row: number; column: number }) {
  const [at, setAt] = useState<{ row: number; column: number } | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const keyOf = (row: number, column: number) => `${row}:${column}`;
  const bound = (cell: { row: number; column: number }) => ({
    row: Math.max(0, Math.min(rows - 1, cell.row)),
    column: Math.max(0, Math.min(columns - 1, cell.column)),
  });
  const current = bound(at ?? start);
  return {
    /** Put the keyboard's place on a cell, as choosing it with the pointer does. */
    moveTo: (row: number, column: number) => setAt({ row, column }),
    cell: (row: number, column: number) => ({
      ref: (node: HTMLElement | null) => {
        if (node) nodes.current.set(keyOf(row, column), node);
        else nodes.current.delete(keyOf(row, column));
      },
      tabIndex: row === current.row && column === current.column ? 0 : -1,
      onFocus: () => setAt({ row, column }),
      onKeyDown: (event: KeyboardEvent) => {
        const far = event.ctrlKey || event.metaKey;
        const moves: Record<string, { row: number; column: number }> = {
          ArrowRight: { row, column: column + 1 },
          ArrowLeft: { row, column: column - 1 },
          ArrowDown: { row: row + 1, column },
          ArrowUp: { row: row - 1, column },
          Home: far ? { row: 0, column: 0 } : { row, column: 0 },
          End: far ? { row: rows - 1, column: columns - 1 } : { row, column: columns - 1 },
        };
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        const next = bound(move);
        setAt(next);
        nodes.current.get(keyOf(next.row, next.column))?.focus();
      },
    }),
  };
}

type Handler = (...args: never[]) => void;

/**
 * A mark's props from two sources, the keyboard's place and the tip's
 * handlers, with each event both want handled by both: spread one after the
 * other, the second `onFocus` would silently replace the first.
 */
export function joined<A extends object, B extends object>(a: A, b: B): A & B {
  const out = { ...a, ...b } as Record<string, unknown>;
  for (const [key, first] of Object.entries(a)) {
    const second = (b as Record<string, unknown>)[key];
    if (key.startsWith('on') && typeof first === 'function' && typeof second === 'function') {
      out[key] = (...args: never[]) => { (first as Handler)(...args); (second as Handler)(...args); };
    }
  }
  return out as A & B;
}
