import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { answer, engine } from '../api/client';
import type { components } from '../api/schema';
import { bridge } from '../bridge';
import { useActiveRuns } from '../screens/runs/active';
import { COLLECTIONS_KEY, invalidateCollectionCounts, invalidatePaperViews } from './invalidation';
import { collectionWords, type CollectionWords } from './words';

export type CollectionSummary = components['schemas']['CollectionSummary'];
export type CollectionList = components['schemas']['CollectionList'];

export { COLLECTIONS_KEY } from './invalidation';

export function readCollections(): Promise<CollectionList> {
  return answer(engine().GET('/api/collections'));
}

/**
 * This window's own collection, as the main process keeps it
 * (`windowState().collection`, an id; null until the window has one). The one
 * place a window's own collection is read.
 */
export function windowCollection(): string | null {
  return cleanCollection(bridge()?.windowState?.().collection);
}

function cleanCollection(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The collection a window shows: its own, where it has one that exists, else
 * the one the engine remembers, which is the one last chosen in any window
 * and so what a new window opens on.
 */
export function shownCollection(list: CollectionList, own: string | null): CollectionSummary | null {
  const named = own === null ? undefined : list.collections.find(
    (c) => String(c.id) === own || c.name.toLowerCase() === own.toLowerCase());
  return named ?? list.collections.find((c) => c.id === list.current_id)
    ?? list.collections.find((c) => c.id === list.default_id) ?? list.collections[0] ?? null;
}

export interface CurrentCollection {
  /** The collection's id, or null before the engine has said which (reads then name none: the default one). */
  id: number | null;
  /** The collection list has not been read yet. */
  pending?: boolean;
  /** Its name, or null before the engine has said. */
  name: string | null;
  isDefault: boolean;
  /** Every collection, the default first. */
  list: readonly CollectionSummary[];
  defaultId: number | null;
  /** Whether there is more than one collection to choose from. */
  several: boolean;
  error: Error | null;
  /**
   * Show another collection in this window, and no other: through the main
   * process where there is one, and remembered by the engine as what a new
   * window opens on.
   */
  switchTo: (id: number) => Promise<void>;
  switching: boolean;
}

const Context = createContext<CurrentCollection | null>(null);

/** Read every collection again: after one is made, renamed, deleted, or its papers moved. */
export function invalidateCollections(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: COLLECTIONS_KEY });
}

/**
 * The collection every screen reads, from one place. Each read of "the
 * collection" (Search › Collection, Today, the map, Analytics, a watch's
 * papers, a person's matches, the reading queue) names it, and its query key
 * holds its id, so a switch reads each screen's data again for the collection
 * now shown and keeps the other's for a switch back.
 *
 * In the app each window shows its own collection. A window with none yet
 * (the first at launch, or one opened with ⌘N) shows the one the engine
 * remembers and takes it as its own, so a switch in another window, which
 * changes what the engine remembers, does not move it.
 */
export function CollectionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const listed = useQuery({
    queryKey: COLLECTIONS_KEY, queryFn: readCollections,
    refetchInterval: 60_000, refetchOnWindowFocus: true,
  });
  useEffect(() => {
    // An Electron window can regain focus without changing visibility, so
    // the query library's visibility listener alone does not see the return.
    const refresh = () => { void invalidateCollectionCounts(client); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [client]);
  // This provider stays mounted when the run's page is gone, and even when
  // the run monitor is hidden. The active query is shared with that monitor.
  const active = useActiveRuns();
  const watched = useRef<{ ended: string | null; running: readonly number[] } | null>(null);
  useEffect(() => {
    if (!active.data) return;
    const now = { ended: active.data.last_ended_at, running: active.data.running.map((run) => run.id) };
    const before = watched.current;
    watched.current = now;
    // last_ended_at also catches a short run that started and ended between
    // polls; a run leaving the active set catches one without an end time.
    if (before && (before.ended !== now.ended || before.running.some((id) => !now.running.includes(id)))) {
      void invalidateCollectionCounts(client);
    }
  }, [active.data, client]);
  const membership = listed.data?.collections.map((c) => `${c.id}:${c.papers}`).join('|') ?? null;
  const lastMembership = useRef<string | null>(null);
  useEffect(() => {
    if (membership === null) return;
    const before = lastMembership.current;
    lastMembership.current = membership;
    // Polling or refocusing sees moves and copies in another window. They
    // change memberships without starting or ending a run.
    if (before !== null && before !== membership) void invalidatePaperViews(client);
  }, [membership, client]);
  const [own, setOwn] = useState(windowCollection);
  useEffect(() => bridge()?.onWindowState?.((state) => setOwn(cleanCollection(state.collection))), []);
  const shown = listed.data ? shownCollection(listed.data, own) : null;
  const shownId = shown?.id ?? null;
  // A window without a collection of its own, or with one since deleted, takes the one it shows.
  useEffect(() => {
    const set = bridge()?.setWindowCollection;
    if (set && shownId !== null && own !== String(shownId)) set(String(shownId));
  }, [own, shownId]);
  const choose = useMutation({
    mutationFn: (id: number) => answer(engine().PUT('/api/collections/current', { body: { collection: id } })),
    onSuccess: (done) => {
      client.setQueryData<CollectionList>(COLLECTIONS_KEY, (now) => (now ? { ...now, current_id: done.current_id } : now));
      void invalidateCollections(client);
    },
  });
  const { mutateAsync } = choose;
  const switchTo = useCallback(async (id: number) => {
    const set = bridge()?.setWindowCollection;
    if (set) {
      set(String(id));
      setOwn(String(id));
    }
    await mutateAsync(id);
  }, [mutateAsync]);
  const value = useMemo<CurrentCollection>(() => ({
    id: shown?.id ?? null,
    pending: listed.data === undefined,
    name: shown?.name ?? null,
    isDefault: shown?.is_default ?? true,
    list: listed.data?.collections ?? [],
    defaultId: listed.data?.default_id ?? null,
    several: (listed.data?.collections.length ?? 0) > 1,
    error: listed.error ?? choose.error ?? null,
    switchTo,
    switching: choose.isPending,
  }), [shown, listed.data, listed.error, choose.error, choose.isPending, switchTo]);
  return <Context value={value}>{children}</Context>;
}

/** The collection this window shows. Outside a provider (a screen's own test), the default one. */
export function useCollection(): CurrentCollection {
  return useContext(Context) ?? OUTSIDE;
}

const OUTSIDE: CurrentCollection = {
  id: null, name: null, isDefault: true, list: [], defaultId: null, several: false, error: null,
  switchTo: async () => undefined, switching: false,
};

/** The `collection` a read sends: the shown one's id, or nothing (the default one) before it is known. */
export function collectionParam(id: number | null): { collection?: string } {
  return id === null ? {} : { collection: String(id) };
}

/** The words that name the collection this window shows (see `words.ts`). */
export function useCollectionWords(): CollectionWords {
  const { name, several } = useCollection();
  return useMemo(() => collectionWords(name, several), [name, several]);
}
