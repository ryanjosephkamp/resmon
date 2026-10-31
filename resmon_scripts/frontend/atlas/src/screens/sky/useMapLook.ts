import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import type { Sky } from '../today/model';
import type { PlateLook } from '../today/Plate';
import { DEFAULT_VIEW, FIND_MIN, joinFacts, lookOf, needsFacts, type MapView } from './look';

export const FACETS_KEY = ['map-facets'] as const;
/** How long typing rests before the engine is asked. */
const FIND_SETTLE_MS = 220;

/**
 * Everything a map's look is made of, for Today's map and a run's: the view
 * the engine remembers for that map, the facets read when the view needs them,
 * and the find typed over it.
 *
 * The shown view is held here, in React state, from the moment the engine's
 * stored one arrives; a change is drawn at once and stored behind it, so a
 * choice never flickers back while the store is on its way.
 */
export function useMapLook(name: 'today' | 'run', sky: Sky | null, names: (slug: string) => string) {
  const client = useQueryClient();
  const stored = useQuery({
    queryKey: ['map-view', name],
    staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/map/views/{name}', { params: { path: { name } } })),
  });
  const [chosen, setChosen] = useState<MapView | null>(null);
  const view: MapView = chosen ?? (stored.data ? pick(stored.data) : DEFAULT_VIEW);
  const keep = useMutation({
    mutationFn: (next: MapView) => answer(engine().PUT('/api/map/views/{name}', { params: { path: { name } }, body: next })),
    onSuccess: (saved) => client.setQueryData(['map-view', name], saved),
  });
  const setView = (next: MapView) => {
    setChosen(next);
    keep.mutate(next);
  };

  // The facets are read when the view needs them, or when the filters are opened to choose one.
  const [wanted, setWanted] = useState(false);
  const facets = useQuery({
    queryKey: FACETS_KEY,
    enabled: wanted || needsFacts(view),
    staleTime: 30_000,
    queryFn: () => answer(engine().GET('/api/map/facets')),
  });
  const facts = useMemo(() => (sky && facets.data ? joinFacts(sky, facets.data) : null), [sky, facets.data]);

  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const settle = window.setTimeout(() => setTerm(typed.trim()), FIND_SETTLE_MS);
    return () => window.clearTimeout(settle);
  }, [typed]);
  const finding = term.length >= FIND_MIN;
  const find = useQuery({
    queryKey: ['map-find', term],
    enabled: finding,
    staleTime: 30_000,
    queryFn: () => answer(engine().GET('/api/map/find', { params: { query: { q: term } } })),
  });
  // While the engine is asked, the last answer stays lit rather than flashing the whole map.
  const matches = finding ? find.data?.ids ?? null : null;

  const look = useMemo(() => (sky ? lookOf(sky, facts, view, matches, names) : null), [sky, facts, view, matches, names]);
  const plateLook = useMemo<PlateLook | null>(
    () => (look ? { lit: look.lit, group: look.group, colors: look.colors, found: look.found } : null),
    [look],
  );

  return {
    view, setView, saveError: keep.error, look, plateLook, facts,
    facetsError: facets.error, wantFacets: () => setWanted(true),
    find: {
      typed, setTyped, finding,
      // Typed and not yet answered: no count is said for words the engine has not been asked about.
      waiting: (typed.trim() !== term && typed.trim().length >= FIND_MIN) || (finding && !find.data && !find.error),
      error: find.error,
    },
  };
}

/** The stored view's own fields, without anything else the body carries. */
function pick(view: MapView): MapView {
  return {
    color: view.color, watches: view.watches, sources: view.sources, dates: view.dates,
    date_from: view.date_from, date_to: view.date_to, state: view.state, list_by: view.list_by,
  };
}
