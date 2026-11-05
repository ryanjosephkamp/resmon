import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { answer, engine } from '../api/client';
import { DEFAULT_TOP_BAR, arrange, type Arranged, type TopBar } from './topBar';

export const TOP_BAR_KEY = ['top-bar'] as const;
const SCOPE = 'top-bar';

/** The changes to the arrangement on their way or waiting their turn, this one included. */
const pending = (client: QueryClient) => client.isMutating({ predicate: (m) => m.options.scope?.id === SCOPE });

export function readTopBar(): Promise<TopBar> {
  return answer(engine().GET('/api/top-bar'));
}

export interface TopBarState {
  /** What the engine holds, or the default before it has answered. */
  stored: TopBar;
  arranged: Arranged;
  loadError: Error | null;
  saveError: Error | null;
  /** Stores the whole arrangement. The bar draws it at once; a refusal puts back what the engine holds. */
  save: (next: TopBar) => void;
}

/**
 * The top bar's arrangement, from the engine. Read once before the first
 * paint (`main.tsx`), so a window opens on its start page with its own bar
 * rather than the default one first.
 */
export function useTopBar(): TopBarState {
  const client = useQueryClient();
  const query = useQuery({ queryKey: TOP_BAR_KEY, queryFn: readTopBar, staleTime: Infinity });
  const stored = query.data ?? DEFAULT_TOP_BAR;

  const { mutate, error: saveError } = useMutation({
    // One PUT at a time, in the order they were made, so the engine ends on the last.
    scope: { id: SCOPE },
    mutationFn: (next: TopBar) => answer(engine().PUT('/api/top-bar', { body: next })),
    // Only the last change's answer is drawn: an earlier one's would put back
    // what a newer change, already drawn and on its way, replaced. A refusal
    // with none after it reads the engine's own value back.
    onSuccess: (saved) => { if (pending(client) === 1) client.setQueryData(TOP_BAR_KEY, saved); },
    onError: () => { if (pending(client) === 1) void client.invalidateQueries({ queryKey: TOP_BAR_KEY }); },
  });

  const save = useCallback((next: TopBar) => {
    client.setQueryData(TOP_BAR_KEY, next);
    mutate(next);
  }, [client, mutate]);

  const arranged = useMemo(() => arrange(stored), [stored]);
  return { stored, arranged, loadError: query.error, saveError, save };
}
