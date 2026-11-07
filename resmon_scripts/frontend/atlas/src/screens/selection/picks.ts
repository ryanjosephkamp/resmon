/**
 * What a list's selection holds, apart from drawing it. Shared by the lists
 * that save many papers at once (Search › Your collection, a run's Papers,
 * Today's list) and built so another action can act on the same selection.
 *
 * A selection is either the rows picked one by one, or every row of the list
 * the engine can describe whole, read or not: every match of a search, every
 * paper of a run, every new paper on Today. Select all is the second kind, so
 * "Select all 12,000 matches" means every match, not the rows drawn or read so
 * far; a row unticked after it is left out by its key (`except`).
 *
 * A Shift-pick picks every row from the last one picked to this one, in the
 * list's order, and leaves the others as they were, as the Library's select
 * mode does with its covers.
 */
import { useCallback, useMemo, useState } from 'react';

export type Picks<K> =
  | { readonly all: false; readonly keys: ReadonlySet<K> }
  | { readonly all: true; readonly except: ReadonlySet<K> };

export function none<K>(): Picks<K> {
  return { all: false, keys: new Set<K>() };
}

export function every<K>(): Picks<K> {
  return { all: true, except: new Set<K>() };
}

/** Whether a row is picked. */
export function has<K>(picks: Picks<K>, key: K): boolean {
  return picks.all ? !picks.except.has(key) : picks.keys.has(key);
}

/** How many are picked: of every row when the list's whole size is known, else null for every row. */
export function sizeOf<K>(picks: Picks<K>, total: number | null): number | null {
  if (!picks.all) return picks.keys.size;
  return total === null ? null : Math.max(0, total - picks.except.size);
}

/** Whether nothing is picked. */
export function isEmpty<K>(picks: Picks<K>, total: number | null): boolean {
  return sizeOf(picks, total) === 0;
}

/** One row picked or let go. */
export function flip<K>(picks: Picks<K>, key: K): Picks<K> {
  if (picks.all) {
    const except = new Set(picks.except);
    if (except.has(key)) except.delete(key); else except.add(key);
    return { all: true, except };
  }
  const keys = new Set(picks.keys);
  if (keys.has(key)) keys.delete(key); else keys.add(key);
  return { all: false, keys };
}

/**
 * Every row from `anchor` to `key`, in `order`, picked; the rest as they were.
 * With no anchor in the list (nothing picked yet, or the anchor's row gone),
 * the row is picked or let go alone.
 */
export function spread<K>(picks: Picks<K>, order: readonly K[], anchor: K | null, key: K): Picks<K> {
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(key);
  if (from < 0 || to < 0) return flip(picks, key);
  const [a, b] = from < to ? [from, to] : [to, from];
  const span = order.slice(a, b + 1);
  if (picks.all) {
    const except = new Set(picks.except);
    for (const k of span) except.delete(k);
    return { all: true, except };
  }
  const keys = new Set(picks.keys);
  for (const k of span) keys.add(k);
  return { all: false, keys };
}

/** The picked keys among `order`, in its order: what a selection of rows read names. */
export function pickedIn<K>(picks: Picks<K>, order: readonly K[]): K[] {
  return order.filter((key) => has(picks, key));
}

/** "3 of 1,204 selected", "All 1,204 selected", or "3 selected" where the whole is not known. */
export function selectedWords(picked: number | null, total: number | null): string {
  const n = new Intl.NumberFormat('en-US');
  if (picked === null) return 'All selected';
  if (total !== null && picked === total && total > 0) return `All ${n.format(total)} selected`;
  return total === null ? `${n.format(picked)} selected` : `${n.format(picked)} of ${n.format(total)} selected`;
}

/**
 * A list's selection: what is picked, the row a Shift-pick spreads from, and
 * the changes. `scope` names what the list holds (its search, its run): when it
 * changes, the selection lets go of everything, since "every match" of one
 * search is not every match of the next.
 */
export function usePicks<K>(order: readonly K[], scope: string) {
  const [state, setState] = useState<{ scope: string; picks: Picks<K>; anchor: K | null }>(
    () => ({ scope, picks: none<K>(), anchor: null }));
  // A new scope lets go; set while rendering, not after, so no frame shows the old picks over the new list.
  if (state.scope !== scope) setState({ scope, picks: none<K>(), anchor: null });
  const picks = state.scope === scope ? state.picks : none<K>();
  const anchor = state.scope === scope ? state.anchor : null;

  /**
   * Pick or let go of one row; with `range`, every row from the last one
   * picked to this one. `from` is where a range starts when nothing has been
   * picked yet: the row the keyboard was on, for Shift and an arrow.
   */
  const pick = useCallback((key: K, range: boolean, from?: K) => {
    setState((now) => {
      if (!range) return { ...now, picks: flip(now.picks, key), anchor: key };
      return { ...now, picks: spread(now.picks, order, now.anchor ?? from ?? null, key), anchor: key };
    });
  }, [order]);
  const selectAll = useCallback(() => setState((now) => ({ ...now, picks: every<K>(), anchor: null })), []);
  const clear = useCallback(() => setState((now) => ({ ...now, picks: none<K>(), anchor: null })), []);
  /** Let go of the keys given, as a save that took them does, or of everything when every row was picked. */
  const release = useCallback((keys: readonly K[] | 'all') => setState((now) => {
    if (keys === 'all' || now.picks.all) return { ...now, picks: none<K>(), anchor: null };
    const left = new Set(now.picks.keys);
    for (const k of keys) left.delete(k);
    return { ...now, picks: { all: false, keys: left } };
  }), []);
  return useMemo(() => ({ picks, anchor, pick, selectAll, clear, release }), [picks, anchor, pick, selectAll, clear, release]);
}
