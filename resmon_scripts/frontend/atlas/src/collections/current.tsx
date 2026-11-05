import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { answer, engine } from '../api/client';
import type { components } from '../api/schema';
import { bridge } from '../bridge';

export type CollectionSummary = components['schemas']['CollectionSummary'];
export type CollectionList = components['schemas']['CollectionList'];

/** Every collection and the one the engine remembers, from `/api/collections`. */
export const COLLECTIONS_KEY = ['collections'] as const;

export function readCollections(): Promise<CollectionList> {
  return answer(engine().GET('/api/collections'));
}

/**
 * The collection this window was opened on, where the main process gave it
 * one (`windowState().collection`: an id or a name; null when the window
 * shows the remembered one). The one place a window's own collection is read.
 */
export function windowCollection(): string | null {
  const state = (bridge() as { windowState?: () => { collection?: string | null } } | null)?.windowState?.();
  const named = state?.collection;
  return typeof named === 'string' && named.trim() ? named.trim() : null;
}

/** The collection a window shows: its own, where it has one that exists, else the one the engine remembers. */
export function shownCollection(list: CollectionList, own: string | null): CollectionSummary | null {
  const named = own === null ? undefined : list.collections.find(
    (c) => String(c.id) === own || c.name.toLowerCase() === own.toLowerCase());
  return named ?? list.collections.find((c) => c.id === list.current_id)
    ?? list.collections.find((c) => c.id === list.default_id) ?? list.collections[0] ?? null;
}

export interface CurrentCollection {
  /** The collection's id, or null before the engine has said which (reads then name none: the default one). */
  id: number | null;
  /** Its name, or null before the engine has said. */
  name: string | null;
  isDefault: boolean;
  /** Every collection, the default first. */
  list: readonly CollectionSummary[];
  defaultId: number | null;
  /** Whether there is more than one collection to choose from. */
  several: boolean;
  error: Error | null;
  /** Show another collection, and remember it as the one the app shows. */
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
 * collection" (Search › Your collection, Today, the map, Analytics, a watch's
 * papers, a person's matches, the reading queue) names it, and its query key
 * holds its id, so a switch reads each screen's data again for the collection
 * now shown and keeps the other's for a switch back.
 */
export function CollectionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const listed = useQuery({ queryKey: COLLECTIONS_KEY, queryFn: readCollections });
  const own = windowCollection();
  const shown = listed.data ? shownCollection(listed.data, own) : null;
  const choose = useMutation({
    mutationFn: (id: number) => answer(engine().PUT('/api/collections/current', { body: { collection: id } })),
    onSuccess: (done) => {
      client.setQueryData<CollectionList>(COLLECTIONS_KEY, (now) => (now ? { ...now, current_id: done.current_id } : now));
      void invalidateCollections(client);
    },
  });
  const { mutateAsync } = choose;
  const switchTo = useCallback(async (id: number) => { await mutateAsync(id); }, [mutateAsync]);
  const value = useMemo<CurrentCollection>(() => ({
    id: shown?.id ?? null,
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
