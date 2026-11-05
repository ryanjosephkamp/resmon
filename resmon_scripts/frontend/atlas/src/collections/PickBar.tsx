import { useEffect, useState, type ReactNode } from 'react';
import { number } from '../screens/today/format';

/** The papers picked in a list: by id, or every paper the search matches. */
export interface Picking {
  on: boolean;
  /** Every match the search counted, not only the rows read so far. */
  all: boolean;
  picked: ReadonlySet<number>;
}

const NONE: ReadonlySet<number> = new Set();

/**
 * A list's picking: on or off, the ids picked, and "every match" for a pick of
 * the whole search, which is what a move of a field's papers usually is. It
 * starts again empty when the list's search changes, because the rows picked
 * were rows of another search.
 */
export function usePicking(search: string) {
  const [on, setOn] = useState(false);
  const [state, setState] = useState<{ search: string; all: boolean; picked: ReadonlySet<number> }>(
    { search, all: false, picked: NONE });
  const current = state.search === search ? state : { search, all: false, picked: NONE };
  // A row ticked while every match is picked starts a pick of rows again, from that row.
  const toggle = (id: number) => setState((was) => {
    const next = new Set(was.search === search && !was.all ? was.picked : NONE);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { search, all: false, picked: next };
  });
  return {
    picking: { on, all: current.all, picked: current.picked } satisfies Picking,
    start: () => setOn(true),
    done: () => { setOn(false); setState({ search, all: false, picked: NONE }); },
    toggle,
    pickAll: () => setState({ search, all: true, picked: NONE }),
    clear: () => setState({ search, all: false, picked: NONE }),
  };
}

/** How many are picked, in words. */
export function pickedWords(picking: Picking, total: number | null): string {
  if (picking.all) return total === null ? 'Every match picked' : `All ${number(total)} picked`;
  const n = picking.picked.size;
  return n === 0 ? 'None picked' : `${number(n)} picked`;
}

/**
 * The bar over a list while papers are picked: how many, Select all, what can
 * be done with them, and Done. Escape is Done, unless a dialog is open.
 */
export function PickBar({ picking, total, onAll, onDone, children }: {
  picking: Picking; total: number | null; onAll: () => void; onDone: () => void; children: ReactNode;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open], [popover]:popover-open')) onDone();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onDone]);
  const some = picking.all || picking.picked.size > 0;
  return (
    <div className="selbar" role="group" aria-label="The picked papers" data-collection="picking">
      <span className="n">
        <span className={`tick${some ? (picking.all ? ' on' : ' part') : ''}`} aria-hidden="true" />
        {pickedWords(picking, total)}
      </span>
      {!picking.all && total !== null && total > 0 && (
        <button type="button" className="btn quiet sm" onClick={onAll}>Select all {number(total)}</button>
      )}
      {children}
      <span className="grow" />
      <button type="button" className="btn quiet sm" onClick={onDone}>Done</button>
    </div>
  );
}
