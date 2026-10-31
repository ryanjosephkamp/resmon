import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import type { components } from '../../api/schema';
import { useAppearance } from '../../theme/appearance';
import { MAP_KEY, Tip, findPosition } from '../Today';
import { useReadAfter } from '../sky/readAfter';
import { ColorKey, DimKey, MapBar } from '../sky/MapControls';
import { MapPaper } from '../sky/MapPaper';
import { filterCount } from '../sky/look';
import { useMapLook } from '../sky/useMapLook';
import { count, number } from '../today/format';
import { density, epochDay, gridCell, subSky } from '../today/model';
import { Plate, PlateKey, type PlateHandle, type PlateHover } from '../today/Plate';

type CollectionMap = components['schemas']['CollectionMap'];

interface Props {
  runId: number;
  running: boolean;
  /** When the run ended, so its papers are read again once it has. */
  settledAt: string | null | undefined;
  /** The run's end time: a map read before it lacks the run's papers. */
  endedAt: string | null;
  names: ReadonlyMap<string, string>;
}

/**
 * A run's papers as a map of their own: Today's drawing and Today's ways of
 * exploring it, over only this run's papers, each where the map of the whole
 * collection puts it, framed so they fill the plate. A paper chosen on it opens
 * beside it, as on Today.
 *
 * Read only when its tab is opened: the whole map is already held for Today
 * and the run's sky, and the run's ids are a few bytes each, so drawing it
 * costs one pass over the collection's points.
 */
export function RunMap({ runId, running, settledAt, endedAt, names }: Props) {
  const client = useQueryClient();
  const { theme, shown } = useAppearance();
  const [now] = useState(() => new Date());
  const map = useQuery({
    queryKey: MAP_KEY,
    queryFn: () => answer(engine().GET('/api/map')),
    refetchInterval: (query) => {
      const data = query.state.data as CollectionMap | undefined;
      return data && (data.state === 'fitting' || data.refitting) ? 2_000 : false;
    },
  });
  const ids = useQuery({
    queryKey: ['run-ids', runId, settledAt],
    enabled: !running,
    queryFn: () => answer(engine().GET('/api/executions/{exec_id}/document-ids', { params: { path: { exec_id: runId } } })),
  });
  // A run that has just finished stored papers the map was read without: it is read again, which places them.
  const settled = useRef(settledAt);
  useEffect(() => {
    if (settledAt && settled.current !== settledAt) void client.invalidateQueries({ queryKey: MAP_KEY });
    settled.current = settledAt;
  }, [settledAt, client]);

  const sourceName = useMemo(() => (slug: string) => names.get(slug) ?? slug, [names]);
  // Until the map has been read since the run ended, it lacks the run's papers.
  const current = useReadAfter(map, endedAt);
  const ready = current && map.data?.state === 'ready' ? map.data : null;
  const built = useMemo(
    () => (ready && ids.data ? subSky(ready.points, ready.regions, ids.data.ids, epochDay(now)) : null),
    [ready, ids.data, now],
  );
  const sky = built && built.sky.count > 0 ? built.sky : null;
  const field = useMemo(() => (sky ? density(sky, 160, 2) : null), [sky]);
  const regionNames = useMemo(() => new Map((ready?.regions ?? []).map((r) => [r.id, r.label])), [ready]);
  const mapLook = useMapLook('run', sky, sourceName);

  const plate = useRef<PlateHandle>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hover, setHover] = useState<PlateHover | null>(null);
  const hovered = hover && sky ? sky.ids[hover.index] ?? null : null;
  const brief = useQuery({
    queryKey: ['brief', hovered],
    enabled: hovered !== null,
    staleTime: Infinity,
    queryFn: async () => (await answer(engine().POST('/api/documents/briefs', { body: { ids: [hovered ?? 0] } })))[0] ?? null,
  });

  const show = (id: number) => {
    setSelectedId(id);
    const at = sky?.indexOf.get(id);
    if (sky && at !== undefined) plate.current?.flyTo({ x: sky.x[at] ?? 0, y: sky.y[at] ?? 0, r: sky.bounds.size * 0.18 });
  };
  const step = (direction: 1 | -1) => {
    const found = mapLook.look?.found;
    if (!sky || !found || found.length === 0) return;
    const at = selectedId !== null ? found.indexOf(sky.indexOf.get(selectedId) ?? -1) : -1;
    const next = at < 0 ? (direction === 1 ? 0 : found.length - 1) : (at + direction + found.length) % found.length;
    const id = sky.ids[found[next] ?? 0];
    if (id !== undefined) show(id);
  };

  if (running) {
    return <p className="record-cap">The run&rsquo;s map is drawn when it has finished storing its papers.</p>;
  }
  if (map.isError || ids.isError) {
    return <p className="record-cap" role="alert">The map could not be read: {(map.error ?? ids.error)?.message}.</p>;
  }
  const total = ids.data?.ids.length ?? null;
  const placed = built?.sky.count ?? null;
  const selectedIndex = selectedId !== null && sky ? sky.indexOf.get(selectedId) ?? null : null;
  const look = mapLook.look;
  const account = placementWords(current ? map.data : undefined, total, placed);

  return (
    <div className="run-map" data-run-map={runId} data-placed={placed ?? ''} data-total={total ?? ''}>
      <div className="run-map-plate">
        {sky && (
          <MapBar name="run" view={mapLook.view} onView={mapLook.setView} look={look} facts={mapLook.facts}
            facetsError={mapLook.facetsError} total={sky.count} names={sourceName} find={mapLook.find}
            findAt={findPosition(sky, look?.found, selectedId)} onStep={step} onWant={mapLook.wantFacets} keepError={mapLook.saveError} />
        )}
        {sky && field && built ? (
          <Plate
            ref={plate}
            sky={sky}
            regions={built.regions}
            shapes={[]}
            field={field}
            arrivals={[]}
            lit={0}
            selected={selectedIndex}
            pointed={null}
            onSelect={(index) => setSelectedId(index === null ? null : sky.ids[index] ?? null)}
            onHover={setHover}
            paletteKey={`${theme}:${shown.accent ?? ''}`}
            label={`Map of this run's ${count(sky.count, 'paper')} the map has placed, in ${count(built.regions.length, 'region')}, each where the map of your whole collection puts it.`}
            onAway={() => undefined}
            whole="all of this run's papers"
            look={mapLook.plateLook}
          >
            {hover && (
              <Tip hover={hover} brief={brief.data ?? undefined} now={now} sourceName={sourceName}
                cell={gridCell(sky.x[hover.index] ?? 0, sky.y[hover.index] ?? 0, sky.bounds)} />
            )}
          </Plate>
        ) : (
          <div className="plate plate-waiting"><p role="status">{account.waiting ?? account.sentence}</p></div>
        )}
        {sky && (
          <PlateKey showWatches={false}
            colors={look && look.legend.length > 0 ? <ColorKey look={look} /> : undefined}
            extra={<DimKey look={look} finding={mapLook.find.finding} filtered={filterCount(mapLook.view) > 0} />} />
        )}
      </div>
      {selectedId !== null && sky ? (
        <MapPaper
          key={selectedId}
          id={selectedId}
          cell={selectedIndex !== null ? gridCell(sky.x[selectedIndex] ?? 0, sky.y[selectedIndex] ?? 0, sky.bounds) : null}
          region={selectedIndex !== null ? regionNames.get(sky.region[selectedIndex] ?? -1) || null : null}
          sourceName={sourceName}
          backLabel="Back to the run's map"
          onBack={() => { setSelectedId(null); plate.current?.focus(); }}
          onShow={() => show(selectedId)}
        />
      ) : (
        <aside className="index run-map-side" aria-label="This run on the map">
          <header className="index-bar"><h2>This run on the map</h2></header>
          <div className="index-scroll">
            <p className="run-map-account" data-run-map="placement">{account.sentence}</p>
            {account.unplaced && <p className="run-map-note" data-run-map="unplaced">{account.unplaced}</p>}
            {sky && (
              <>
                <p className="run-map-note">
                  Each paper sits where the map of your whole collection puts it, {basisWords(map.data)}, and the
                  frame is drawn around this run&rsquo;s papers alone, so they fill it. Region names are the whole
                  map&rsquo;s.
                </p>
                <p className="run-map-note">
                  Choose a paper to read about it here. On the map, Enter chooses the paper nearest the middle and
                  Shift with an arrow key moves to the next one that way.
                </p>
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function basisWords(map: CollectionMap | undefined): string {
  if (map?.basis === 'embeddings') return 'placed by how close their meaning is, as your embedding model reads it';
  return 'placed by how much wording they share';
}

/**
 * How many of the run's papers the map has placed, and why the rest are not,
 * in the map's own terms: a paper is off the map when it has too little text
 * to place, or, on a map drawn from an embedding model, when the model has not
 * read it yet. The map does not say which of the two each one is.
 */
export function placementWords(map: CollectionMap | undefined, total: number | null, placed: number | null): {
  sentence: string; unplaced: string | null; waiting: string | null;
} {
  if (!map || total === null) return { sentence: 'Reading the run’s papers and the map.', unplaced: null, waiting: 'Reading the map.' };
  if (map.state === 'fitting') {
    return {
      sentence: 'The map of your collection is being drawn; this run’s papers are placed on it when it is done.',
      unplaced: null, waiting: 'Drawing the map of your collection. A large collection takes up to half a minute.',
    };
  }
  if (map.state === 'failed') {
    return { sentence: `The map could not be drawn: ${map.error ?? 'the engine gave no reason'}.`, unplaced: null, waiting: null };
  }
  if (total === 0) return { sentence: 'This run stored no papers that are still in your collection.', unplaced: null, waiting: null };
  const on = placed ?? 0;
  if (on === total) {
    return { sentence: `All ${count(total, 'paper')} this run stored are on the map.`, unplaced: null, waiting: null };
  }
  const off = total - on;
  const why = map.basis === 'embeddings'
    ? 'your embedding model has not read them yet, or they have too little text to place'
    : 'they have too little text in their titles and abstracts to place by wording';
  return {
    sentence: on === 0
      ? `None of the ${count(total, 'paper')} this run stored is on the map.`
      : `${number(on)} of the ${count(total, 'paper')} this run stored are on the map.`,
    unplaced: `${number(off)} ${off === 1 ? 'is' : 'are'} not: ${why}. ${off === 1 ? 'It is' : 'They are'} still in the Papers tab.`,
    waiting: null,
  };
}
