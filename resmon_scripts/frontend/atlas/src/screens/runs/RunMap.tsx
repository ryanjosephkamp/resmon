import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { runMapIds, runSourceLook, sourceChoices, sourcesFor } from './sourceMap';
import { answer, engine, EngineError } from '../../api/client';
import type { components } from '../../api/schema';
import { useAppearance } from '../../theme/appearance';
import { Tip, findPosition, paperTip } from '../Today';
import { tipWords } from '../../charts/ChartTip';
import { opensWords } from '../sky/PaperSky';
import { mapKey, readMap } from '../today/freshness';
import { collectionParam, useCollection, useCollectionWords } from '../../collections/current';
import { YOUR_COLLECTION, type CollectionWords } from '../../collections/words';
import { useReadAfter } from '../sky/readAfter';
import { DimKey, MapBar } from '../sky/MapControls';
import { MapPaper } from '../sky/MapPaper';
import { SaveLit } from '../sky/SaveLit';
import { filterCount } from '../sky/look';
import { useMapLook } from '../sky/useMapLook';
import { count, number } from '../today/format';
import { density, epochDay, gridCell, subSky } from '../today/model';
import { Plate, PlateKey, type PlateHandle, type PlateHover } from '../today/Plate';

type CollectionMap = components['schemas']['CollectionMap'];

interface Props {
  compact?: boolean;
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
 * Its compact form is on the run's page; the full form is in the Map tab.
 * Both share their map and membership reads, polled while the run is active.
 * The legend removes other sources from the drawing; shared DOI copies keep
 * all of their source attributions without changing any stored record.
 */
export function RunMap({ runId, running, settledAt, endedAt, names, compact = false }: Props) {
  const { theme, shown } = useAppearance();
  const [now] = useState(() => new Date());
  const { id: collection } = useCollection();
  const shownWords = useCollectionWords();
  const map = useQuery({
    queryKey: mapKey(collection),
    queryFn: () => readMap(collection),
    refetchInterval: (query) => {
      const data = query.state.data as CollectionMap | undefined;
      return running || (data && (data.state === 'fitting' || data.refitting)) ? 2_000 : false;
    },
  });
  // The map is the shown collection's, so the run's papers are those in it.
  const ids = useQuery({
    queryKey: ['run-ids', runId, settledAt, collection],
    refetchInterval: running ? 1_000 : false,
    queryFn: () => answer(engine().GET('/api/executions/{exec_id}/document-ids', {
      params: { path: { exec_id: runId }, query: collectionParam(collection) },
    })),
  });
  // A run that has just finished stored papers the map was read without: the
  // run's page reports it (`useRunEnding`), which reads the map again and places them.

  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const sourceName = useMemo(() => (slug: string) => names.get(slug) ?? slug, [names]);
  // Until the map has been read since the run ended, it lacks the run's papers.
  const current = useReadAfter(map, endedAt);
  const ready = current && map.data?.state === 'ready' ? map.data : null;
  const built = useMemo(
    () => (ready && ids.data ? subSky(ready.points, ready.regions, runMapIds(ids.data, ready.points, selectedSource), epochDay(now)) : null),
    [ready, ids.data, now, selectedSource],
  );
  const sky = built && built.sky.count > 0 ? built.sky : null;
  const field = useMemo(() => (sky ? density(sky, 160, 2) : null), [sky]);
  const regionNames = useMemo(() => new Map((ready?.regions ?? []).map((r) => [r.id, r.label])), [ready]);
  const mapLook = useMapLook('run', sky, sourceName, true, running);
  const colored = useMemo(() => sky && ids.data ? runSourceLook(sky, ids.data, mapLook.plateLook) : null, [sky, ids.data, mapLook.plateLook]);
  const choices = useMemo(() => ids.data ? sourceChoices(ids.data, sourceName) : [], [ids.data, sourceName]);

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

  if (map.isError || ids.isError) {
    const failure = map.error ?? ids.error;
    return (
      <p className="record-cap" role="alert">
        {failure instanceof EngineError && failure.detail
          ? `The map could not be read. ${failure.detail}` : `The map could not be read: ${failure?.message}.`}
      </p>
    );
  }
  const total = ids.data?.ids.length ?? null;
  const marks = ready && ids.data ? runMapIds(ids.data, ready.points, null).length : null;
  const placed = placedPaperCount(ready, ids.data);
  const selectedIndex = selectedId !== null && sky ? sky.indexOf.get(selectedId) ?? null : null;
  const look = mapLook.look;
  const account = placementWords(current ? map.data : undefined, total, placed, shownWords, { running, marks });
  const sourceNames = sourcesFor(ids.data, hovered, sourceName);
  // The shared tip accepts a name function: the run supplies all recorded
  // sources for this mark, without changing any other map's tip.
  const tipSourceName = () => sourceNames;
  const sentence = running && total === 0
    ? `No papers from this run are in ${shownWords.name} yet. Each source’s verified papers are stored in the run’s collection when its search returns; this map places the ones in ${shownWords.name} when it can.`
    : account.sentence;
  const emptySentence = ready && selectedSource
    ? `No placed papers from ${choices.find((choice) => choice.key === selectedSource)?.label ?? sourceName(selectedSource)} are on this map.`
    : sentence;
  const unplaced = running && account.unplaced
    ? account.unplaced.replace(/(?:It is|They are) still in the Papers tab\./, 'The Papers tab lists them when the run ends.')
    : account.unplaced;

  return (
    <div className={`run-map${compact ? ' compact' : ''}`} data-run-map={runId} data-placed={placed ?? ''} data-total={total ?? ''}>
      <div className="run-map-plate">
        {!compact && sky && (
          <MapBar fixedSourceColors regions={mapLook.regions} name="run" view={mapLook.view} onView={mapLook.setView} look={look} facts={mapLook.facts}
            facetsError={mapLook.facetsError} total={sky.count} names={sourceName} find={mapLook.find}
            findAt={findPosition(sky, look?.found, selectedId)} onStep={step} onWant={mapLook.wantFacets} keepError={mapLook.saveError}
            save={<SaveLit sky={sky} look={look} finding={mapLook.find.finding} waiting={mapLook.find.waiting} />} />
        )}
        {sky && field && built ? (
          <Plate
            ref={plate}
            sky={sky}
            regions={built.regions}
            shapes={[]}
            field={field}
            arrivals={[]}
            selected={selectedIndex}
            pointed={null}
            onSelect={(index) => setSelectedId(index === null ? null : sky.ids[index] ?? null)}
            onHover={setHover}
            onKeyed={setHover}
            paletteKey={`${theme}:${shown.accent ?? ''}`}
            label={`Map of this run's papers on ${count(sky.count, 'mark')}, in ${count(built.regions.length, 'region')}, each where the map of ${shownWords.named ? shownWords.name : 'your whole collection'} puts it.`}
            wheel={compact ? 'page' : 'zoom'}
            onAway={() => undefined}
            whole="all of this run's papers" resetLabel="Show All of This Run’s Papers"
            look={colored}
          >
            {hover && (
              <Tip hover={hover} brief={brief.data ?? undefined} now={now} sourceName={tipSourceName}
                cell={gridCell(sky.x[hover.index] ?? 0, sky.y[hover.index] ?? 0, sky.bounds)}
                opens={opensWords(hover.via ?? 'pointer', true, hovered === selectedId)} />
            )}
          </Plate>
        ) : (
          <div className="plate plate-waiting"><p role="status">{account.waiting ?? emptySentence}</p></div>
        )}
        {/* The paper the keyboard chose, said as its tip says it: the map itself is one picture to a screen reader. */}
        <p className="sr-only" aria-live="polite" data-map-said="">
          {hover?.via === 'keyboard' && sky ? tipWords(paperTip({
            brief: brief.data ?? undefined, now, sourceName: tipSourceName, cell: gridCell(sky.x[hover.index] ?? 0, sky.y[hover.index] ?? 0, sky.bounds),
          })) : ''}
        </p>
        {sky && (
          <PlateKey showWatches={false}
            colors={undefined}
            extra={<DimKey look={look} finding={mapLook.find.finding} filtered={filterCount(mapLook.view) > 0} />} />
        )}
      </div>
      <div className="run-source-key" role="group" aria-label="Sources on this run’s map">
        <button type="button" className="btn sm quiet" aria-pressed={selectedSource === null} onClick={() => { setSelectedSource(null); setSelectedId(null); setHover(null); }}>All Sources</button>
        {choices.map((choice) => <button type="button" key={choice.key} className="btn sm quiet"
          aria-pressed={selectedSource === choice.key} onClick={() => { setSelectedSource(selectedSource === choice.key ? null : choice.key); setSelectedId(null); setHover(null); }}>
          <span className="region-choice-swatch" style={{ background: choice.color }} aria-hidden="true" />
          {choice.label} <span className="num">{number(choice.count)}</span>
        </button>)}
        <p>Counts are papers stored from each source; a shared DOI counts for each source that found it and is drawn once. A shared paper wears the first source’s color. Other sources are named together when the palette is full.</p>
      </div>
      {compact && <div className="run-map-caption"><p data-run-map="placement">{sentence}</p>{unplaced && <p>{unplaced}</p>}</div>}
      {selectedId !== null && sky ? (
        <MapPaper
          inline={compact}
          key={selectedId}
          id={selectedId}
          cell={selectedIndex !== null ? gridCell(sky.x[selectedIndex] ?? 0, sky.y[selectedIndex] ?? 0, sky.bounds) : null}
          region={selectedIndex !== null ? regionNames.get(sky.region[selectedIndex] ?? -1) || null : null}
          sourceName={sourceName}
          backLabel="Back to the run's map"
          onBack={() => { setSelectedId(null); plate.current?.focus(); }}
          onShow={() => show(selectedId)}
        />
      ) : !compact ? (
        <aside className="index run-map-side" aria-label="This Run on the Map">
          <header className="index-bar"><h2>This Run on the Map</h2></header>
          <div className="index-scroll">
            <p className="run-map-account" data-run-map="placement">{sentence}</p>
            {unplaced && <p className="run-map-note" data-run-map="unplaced">{unplaced}</p>}
            {sky && (
              <>
                <p className="run-map-note">
                  Each paper sits where the map of {shownWords.named ? shownWords.name : 'your whole collection'} puts it, {basisWords(map.data)}, and the
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
      ) : null}
    </div>
  );
}

function placedPaperCount(map: CollectionMap | null, membership: components['schemas']['RunDocumentIds'] | undefined): number | null {
  if (!map || !membership) return null;
  const placed = new Set(map.points.id);
  return membership.papers.reduce((sum, paper) => sum + (paper.copies.some((id) => placed.has(id)) ? paper.copies.length : 0), 0);
}

function basisWords(map: CollectionMap | undefined): string {
  if (map?.basis === 'embeddings') return 'placed by how close their meaning is, as your embedding model reads it';
  return 'placed by how much wording they share';
}

/**
 * Count stored papers separately from shared-DOI marks. While sources are
 * still arriving, a paper missing from the snapshot waits for the next read;
 * only a settled run's account gives the map's text or embedding limits.
 */
export function placementWords(map: CollectionMap | undefined, total: number | null, placed: number | null,
  shown: CollectionWords = YOUR_COLLECTION, live: { running?: boolean; marks?: number | null } = {}): {
  sentence: string; unplaced: string | null; waiting: string | null;
} {
  // The run's papers counted are those in the collection shown; where it is named, the sentences say so.
  const stored = shown.named ? `this run stored in ${shown.name}` : 'this run stored';
  if (!map || total === null) return { sentence: 'Reading the run’s papers and the map.', unplaced: null, waiting: 'Reading the map.' };
  if (map.state === 'fitting') {
    return {
      sentence: `The map of ${shown.name} is being drawn; this run’s papers are placed on it when it is done.`,
      unplaced: null, waiting: `Drawing the map of ${shown.name}. A large collection takes up to half a minute.`,
    };
  }
  if (map.state === 'failed') {
    return { sentence: `The map could not be drawn: ${map.error ?? 'the engine gave no reason'}.`, unplaced: null, waiting: null };
  }
  if (total === 0) return { sentence: `This run stored no papers that are still in ${shown.name}.`, unplaced: null, waiting: null };
  const on = placed ?? 0;
  const marks = live.marks != null && live.marks !== on ? `, on ${count(live.marks, 'mark')}` : '';
  if (on === total) {
    return { sentence: `All ${count(total, 'paper')} ${stored} are on the map${marks}.`, unplaced: null, waiting: null };
  }
  const off = total - on;
  const why = map.basis === 'embeddings'
    ? 'your embedding model has not read them yet, or they have too little text to place'
    : 'they have too little text in their titles and abstracts to place by wording';
  return {
    sentence: on === 0
      ? `None of the ${count(total, 'paper')} ${stored} is on the map.`
      : `${number(on)} of the ${count(total, 'paper')} ${stored} are on the map${marks}.`,
    unplaced: live.running
      ? `${count(off, 'paper')} ${off === 1 ? 'is' : 'are'} waiting for the next map update. The Papers tab lists ${off === 1 ? 'it' : 'them'} when the run ends.`
      : `${number(off)} ${off === 1 ? 'is' : 'are'} not: ${why}. ${off === 1 ? 'It is' : 'They are'} still in the Papers tab.`,
    waiting: null,
  };
}
