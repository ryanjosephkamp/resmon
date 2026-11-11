import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import type { Sky } from '../today/model';
import type { PlateLook } from '../today/Plate';
import { regionColors } from './regionColors';
import { DEFAULT_VIEW, FIND_MIN, filterCount, joinFacts, lookOf, needsFacts, type MapView } from './look';
import { facetsKey } from '../today/freshness';
import { collectionParam, useCollection } from '../../collections/current';

/** How long typing rests before the engine is asked. */
const FIND_SETTLE_MS = 220;
// Region ids belong to the current fit; this choice lasts only in this window.
const EMPTY_REGIONS: number[] = [];
const rememberedRegions = new Map<string, number[]>();

/**
 * Everything a map's look is made of, for Today's map and a run's: the view
 * the engine remembers for that map, the facets read when the view needs them,
 * and the find typed over it.
 *
 * The shown view is held here, in React state, from the moment the engine's
 * stored one arrives; a change is drawn at once and stored behind it, so a
 * choice never flickers back while the store is on its way.
 */
export function useMapLook(name: 'today' | 'run', sky: Sky | null, names: (slug: string) => string, fixedSourceColors = false, live = false) {
  const client = useQueryClient();
  const stored = useQuery({
    queryKey: ['map-view', name],
    staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/map/views/{name}', { params: { path: { name } } })),
  });
  const [chosen, setChosen] = useState<MapView | null>(null);
  const remembered: MapView = chosen ?? (stored.data ? pick(stored.data) : DEFAULT_VIEW);
  const view = useMemo<MapView>(() => fixedSourceColors ? { ...remembered, color: 'source', sources: [] } : remembered, [fixedSourceColors, remembered]);
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
  const { id: collection } = useCollection();
  const regionScope = useMemo(() => JSON.stringify([name, collection,
    sky?.regions?.map((r) => [r.id, r.label, r.x, r.y]) ?? []]), [name, collection, sky]);
  const [regionChoice, setRegionChoice] = useState<{ scope: string; ids: number[] } | null>(null);
  const selectedRegions = regionChoice?.scope === regionScope ? regionChoice.ids : rememberedRegions.get(regionScope) ?? EMPTY_REGIONS;
  const facets = useQuery({
    queryKey: facetsKey(collection),
    enabled: wanted || (fixedSourceColors ? filterCount(view) > 0 : needsFacts(view)),
    staleTime: 30_000,
    refetchInterval: live ? 2_000 : false,
    queryFn: () => answer(engine().GET('/api/map/facets', { params: { query: collectionParam(collection) } })),
  });
  const facts = useMemo(() => (sky && facets.data ? joinFacts(sky, facets.data) : null), [sky, facets.data]);

  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    // Nothing to settle when the words have not changed: on arrival the timer
    // set the same empty term, and the map's bar was drawn again 220 ms in.
    const next = typed.trim();
    if (next === term) return undefined;
    const settle = window.setTimeout(() => setTerm(next), FIND_SETTLE_MS);
    return () => window.clearTimeout(settle);
  }, [typed, term]);
  const finding = term.length >= FIND_MIN;
  const find = useQuery({
    queryKey: ['map-find', collection, term],
    enabled: finding,
    staleTime: 30_000,
    queryFn: () => answer(engine().GET('/api/map/find', { params: { query: { q: term, ...collectionParam(collection) } } })),
  });
  // While the engine is asked, the last answer stays lit rather than flashing the whole map.
  const matches = finding ? find.data?.ids ?? null : null;

  const look = useMemo(() => {
    if (!sky) return null;
    const base = lookOf(sky, facts, fixedSourceColors ? { ...view, color: 'region' } : view, matches, names);
    const chosen = new Set(selectedRegions);
    if (!chosen.size) return base;
    const lit = Uint8Array.from(sky.region, (id, i) => Number(chosen.has(id) && (!base.lit || !!base.lit[i])));
    const found = base.found.filter((i) => !!lit[i]);
    const regionCounts = new Map<number, number>();
    const colorCounts = new Map<number, number>();
    for (let i = 0; i < sky.count; i++) if (lit[i]) {
      regionCounts.set(sky.region[i]!, (regionCounts.get(sky.region[i]!) ?? 0) + 1);
      const color = base.group?.[i] ?? -1;
      colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
    }
    const legend = base.legend.map((entry) => ({ ...entry, count: entry.key.startsWith('region:')
      ? regionCounts.get(Number(entry.key.slice(7))) ?? 0 : colorCounts.get(base.colors.indexOf(entry.color)) ?? 0 }));
    return { ...base, lit, shown: lit.reduce((sum, on) => sum + on, 0), found, legend,
      foundDimmed: base.foundDimmed + base.found.length - found.length };
  }, [sky, facts, view, matches, names, selectedRegions, fixedSourceColors]);
  const plateLook = useMemo<PlateLook | null>(
    () => (look ? { lit: look.lit, group: look.group, colors: look.colors, found: look.found } : null),
    [look],
  );

  return {
    regions: { choices: sky ? regionColors(sky).choices : [], selected: selectedRegions,
      onSelect: (ids: number[]) => { rememberedRegions.set(regionScope, ids); setRegionChoice({ scope: regionScope, ids }); } },
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
