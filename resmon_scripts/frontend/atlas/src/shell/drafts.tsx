import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Forms not yet sent, kept in memory above the routes, one per form and
 * history entry.
 *
 * A form's state lives in its screen, so following a link out of it (Settings
 * › AI from Search's summaries) unmounts it, and Back used to mount an empty
 * one. Here a form writes what it holds under its history entry's key as it
 * changes, and reads it back when it mounts on that entry again: Back and
 * Forward find the form as it was left, as a browser restores a page's form,
 * while a new visit to the same address, which is a new entry, starts fresh.
 *
 * Nothing goes to browser storage, which Atlas does not use: the drafts last
 * as long as the window's page does.
 */
export class DraftStore {
  private readonly entries = new Map<string, unknown>();

  constructor(private readonly limit = DRAFT_LIMIT) {}

  read<T>(key: string): T | null {
    return this.entries.has(key) ? (this.entries.get(key) as T) : null;
  }

  /** The newest written is kept last, so past the limit the longest-untouched draft goes first. */
  write<T>(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  drop(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Enough for any walk back through history a person makes; a draft past it is one nobody returns to. */
export const DRAFT_LIMIT = 40;

/** The key React Router gives a history entry it did not create. */
const UNKEYED = 'default';

const DraftsContext = createContext<DraftStore | null>(null);

export function DraftsProvider({ children, store }: { children: ReactNode; store?: DraftStore }) {
  const [own] = useState(() => store ?? new DraftStore());
  return <DraftsContext.Provider value={own}>{children}</DraftsContext.Provider>;
}

/**
 * The draft of form `form` on this history entry. `restored` is what was kept
 * here when the form mounted (null on a new entry), read once so the form's
 * own initial state can take it; `keep` records the form as it is now, and
 * `drop` forgets it once it has been sent, so going Back to a form already
 * sent does not offer to send it twice.
 */
export function useDraft<T>(form: string): { restored: T | null; keep: (value: T) => void; drop: () => void } {
  const store = useContext(DraftsContext);
  if (!store) throw new Error('useDraft needs a DraftsProvider above it');
  const { key } = useLocation();
  // An entry the router did not make (the first page, or an address the main process set, as a notice's
  // click does) has the key "default", shared by all of them, so a draft kept there would turn up on
  // another visit. A form on one keeps nothing.
  const entry = key === UNKEYED ? null : `${form}@${key}`;
  const [restored] = useState<T | null>(() => (entry ? store.read<T>(entry) : null));
  // Stable for an entry, so a form can keep its draft from an effect without running it every render.
  const keep = useCallback((value: T) => { if (entry) store.write(entry, value); }, [store, entry]);
  const drop = useCallback(() => { if (entry) store.drop(entry); }, [store, entry]);
  return useMemo(() => ({ restored, keep, drop }), [restored, keep, drop]);
}
