import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { answer, engine } from '../api/client';
import type { components } from '../api/schema';

/**
 * Where a web link someone follows opens, and what the link window's address
 * field searches with (`/api/web-links`). The engine keeps them, as it keeps
 * the appearance; each window hands them to the main process
 * (`WindowFrame`), which opens the links (`electron/webLinks.ts`).
 */
export type WebLinkSettings = components['schemas']['WebLinkSettings'];
export type WebLinkSearch = WebLinkSettings['search'];

export const WEB_LINKS_KEY = ['web-links'] as const;
export const DEFAULT_WEB_LINKS: WebLinkSettings = { open_in: 'resmon', new: 'window', search: 'duckduckgo' };
const SCOPE = 'web-links';

/** Each search by name, in the order Settings lists them. The main process has the same names. */
export const SEARCH_NAMES: Readonly<Record<WebLinkSearch, string>> = {
  duckduckgo: 'DuckDuckGo',
  google: 'Google',
  bing: 'Bing',
  brave: 'Brave Search',
  startpage: 'Startpage',
  ecosia: 'Ecosia',
  google_scholar: 'Google Scholar',
  semantic_scholar: 'Semantic Scholar',
};

export function readWebLinks(): Promise<WebLinkSettings> {
  return answer(engine().GET('/api/web-links'));
}

const pending = (client: QueryClient) => client.isMutating({ predicate: (m) => m.options.scope?.id === SCOPE });

export interface WebLinksState {
  /** What the engine holds, or the default before it has answered. */
  stored: WebLinkSettings;
  loaded: boolean;
  loadError: Error | null;
  saveError: Error | null;
  /** Stores all three. Settings shows the change at once; a refusal puts back what the engine holds. */
  save: (next: WebLinkSettings) => void;
}

export function useWebLinks(): WebLinksState {
  const client = useQueryClient();
  const query = useQuery({ queryKey: WEB_LINKS_KEY, queryFn: readWebLinks, staleTime: Infinity });
  const { mutate, error: saveError } = useMutation({
    // One PUT at a time, in the order they were made, so the engine ends on the last.
    scope: { id: SCOPE },
    mutationFn: (next: WebLinkSettings) => answer(engine().PUT('/api/web-links', { body: next })),
    onSuccess: (saved) => { if (pending(client) === 1) client.setQueryData(WEB_LINKS_KEY, saved); },
    onError: () => { if (pending(client) === 1) void client.invalidateQueries({ queryKey: WEB_LINKS_KEY }); },
  });
  const save = useCallback((next: WebLinkSettings) => {
    client.setQueryData(WEB_LINKS_KEY, next);
    mutate(next);
  }, [client, mutate]);
  return { stored: query.data ?? DEFAULT_WEB_LINKS, loaded: query.isSuccess, loadError: query.error, saveError, save };
}
