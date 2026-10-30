import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answer, engine } from '../api/client';
import type { components } from '../api/schema';
import { useAppearance } from '../theme/appearance';
import { FirstRun } from './today/FirstRun';
import { useOpening } from './today/opening';
import { Plate, PlateKey, type PlateHandle, type PlateHover } from './today/Plate';
import { TodayIndex, type IndexPaper, type Region } from './today/TodayIndex';
import { authors, count, daysAgo, fullDate, number, when } from './today/format';
import { buildSky, density, emptiestCorner, epochDay, gridCell, watchShape } from './today/model';

type CollectionMap = components['schemas']['CollectionMap'];
type TodayData = components['schemas']['Today'];
type Brief = components['schemas']['DocumentBrief'];

export const MAP_KEY = ['map'] as const;
export const TODAY_KEY = ['today'] as const;

/**
 * Today, the morning edition: where last night's papers landed in the whole
 * collection, and the papers themselves beside it.
 *
 * Three reads, each saying only what it knows: `/api/map` for where every
 * paper sits (and on what basis), `/api/today` for what is new since the last
 * Mark all read, and `/api/scheduler/status` for whether the next run will
 * actually happen.
 */
export function Today() {
  const client = useQueryClient();
  const { theme, shown } = useAppearance();
  const map = useQuery({
    queryKey: MAP_KEY,
    queryFn: () => answer(engine().GET('/api/map')),
    // A map being fitted, or refitted, is asked for again until it is done;
    // otherwise once a minute and on returning to the window, like Today.
    refetchInterval: (query) => {
      const data = query.state.data as CollectionMap | undefined;
      return data && (data.state === 'fitting' || data.refitting) ? 2_000 : 60_000;
    },
    refetchOnWindowFocus: true,
  });
  // Papers arrive while the app is open (a watch runs overnight), so Today is
  // read again once a minute and on returning to the window. Read once, it
  // went on saying "nothing collected" over a collection that had grown.
  const today = useQuery({
    queryKey: TODAY_KEY,
    queryFn: () => answer(engine().GET('/api/today')),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const status = useQuery({ queryKey: ['scheduler-status'], queryFn: () => answer(engine().GET('/api/scheduler/status')) });
  const catalog = useQuery({
    queryKey: ['catalog'], staleTime: Infinity,
    queryFn: () => answer(engine().GET('/api/repositories/catalog')),
  });
  const backup = useQuery({
    queryKey: ['backup-last'],
    queryFn: () => answer(engine().GET('/api/backup/last')) as Promise<{ last_backup?: { created_at_utc?: string; path?: string } | null }>,
  });

  const [now] = useState(() => new Date());
  // New papers mean new stars: when Today's count moves, the map is asked again.
  const total = today.data?.total;
  useEffect(() => {
    if (total !== undefined) void client.invalidateQueries({ queryKey: MAP_KEY });
  }, [total, client]);
  const plate = useRef<PlateHandle>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pointedId, setPointedId] = useState<number | null>(null);
  const [hover, setHover] = useState<PlateHover | null>(null);
  const [away, setAway] = useState(false);
  const [saved, setSaved] = useState<Map<number, boolean>>(new Map());

  const names = useMemo(() => new Map((catalog.data ?? []).map((entry) => [entry.slug, entry.name])), [catalog.data]);
  const sourceName = useCallback((slug: string) => names.get(slug) ?? slug, [names]);

  const ready = map.data?.state === 'ready' ? map.data : null;
  const sky = useMemo(() => (ready ? buildSky(ready.points, ready.regions, epochDay(now)) : null), [ready, now]);
  const field = useMemo(() => (sky ? density(sky, 160, 2) : null), [sky]);
  const corner = useMemo(() => (sky ? emptiestCorner(sky) : 'tr'), [sky]);
  const shapes = useMemo(() => {
    if (!sky || !ready || !today.data) return [];
    return today.data.watches.filter((w) => w.members.length > 0).map((w) => watchShape(sky, ready.regions, w));
  }, [sky, ready, today.data]);
  const regionsById = useMemo(
    () => new Map<number, Region>((ready?.regions ?? []).map((r) => [r.id, { id: r.id, label: r.label }])),
    [ready],
  );

  // Numbers follow the order papers were collected: 1 is the first to arrive.
  const papers = useMemo<IndexPaper[]>(() => {
    const list = [...(today.data?.papers ?? [])].reverse();
    return list.map((paper, k) => {
      const at = sky?.indexOf.get(paper.id);
      return {
        ...paper,
        n: k + 1,
        cell: sky && at !== undefined ? gridCell(sky.x[at] ?? 0, sky.y[at] ?? 0, sky.bounds) : null,
        regionId: sky && at !== undefined ? (sky.region[at] ?? null) : null,
      };
    });
  }, [today.data, sky]);
  const arrivals = useMemo(() => {
    if (!sky) return [];
    const out: number[] = [];
    for (const paper of papers) {
      const at = sky.indexOf.get(paper.id);
      if (at !== undefined) out.push(at);
    }
    return out;
  }, [papers, sky]);
  const listed = useMemo(() => new Map(papers.map((p) => [p.id, p])), [papers]);

  // The opening: the plate settles, then the new papers light one by one in
  // the order they arrived, their numbers in the index lighting with them.
  // Without motion everything is lit from the start, and papers that arrive
  // after the opening (a later read) are lit at once.
  const [still] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const litNow = useOpening(papers.length, !!sky && !!today.data, still);

  const looked = useMutation({
    mutationFn: () => answer(engine().POST('/api/today/looked')),
    onSuccess: () => client.invalidateQueries({ queryKey: TODAY_KEY }),
  });
  const save = useMutation({
    mutationFn: async ({ id, on }: { id: number; on: boolean }) => {
      if (on) await answer(engine().POST('/api/reading-queue', { body: { document_id: id } }));
      else await answer(engine().DELETE('/api/reading-queue/{document_id}', { params: { path: { document_id: id } } }));
      return { id, on };
    },
    onMutate: ({ id, on }) => setSaved((prev) => new Map(prev).set(id, on)),
    onError: (_e, { id, on }) => setSaved((prev) => new Map(prev).set(id, !on)),
  });

  const hovered = hover ? sky?.ids[hover.index] ?? null : null;
  const brief = useQuery({
    queryKey: ['brief', hovered],
    enabled: hovered !== null && !listed.has(hovered),
    staleTime: Infinity,
    queryFn: async () => (await answer(engine().POST('/api/documents/briefs', { body: { ids: [hovered ?? 0] } })))[0] ?? null,
  });

  const zoomTo = useCallback((target: { watchId?: number; regionId?: number; paperId?: number }) => {
    if (!sky || !ready) return;
    if (target.paperId !== undefined) {
      setSelectedId(target.paperId);
      const at = sky.indexOf.get(target.paperId);
      // Close enough to see its neighbors, far enough to keep its surroundings.
      if (at !== undefined) plate.current?.flyTo({ x: sky.x[at] ?? 0, y: sky.y[at] ?? 0, r: sky.bounds.size * 0.22 });
      return;
    }
    if (target.regionId !== undefined) {
      const region = ready.regions.find((r) => r.id === target.regionId);
      if (region) plate.current?.flyTo({ x: region.x, y: region.y, r: region.r });
      return;
    }
    const shape = shapes.find((s) => s.id === target.watchId);
    if (shape && shape.outline.length) {
      const xs = shape.outline.flatMap(([a, , c]) => [a, c]);
      const ys = shape.outline.flatMap(([, b, , d]) => [b, d]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      plate.current?.flyTo({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: Math.max(x1 - x0, y1 - y0) / 2 });
    }
  }, [sky, ready, shapes]);

  if (map.isError || today.isError) {
    return (
      <section className="page page-narrow" aria-labelledby="page-title">
        <h1 id="page-title" className="page-title">Today</h1>
        <p className="page-lede" role="alert">
          The engine did not answer: {(map.error ?? today.error)?.message}. Nothing here is shown from memory.
        </p>
      </section>
    );
  }

  const data = today.data;
  const sinceWord = data ? when(data.since, now) : '';
  const heading = data?.window === 'first_look' ? 'New this week' : `New since ${sinceWord.split(' at ')[0]}`;
  const selectedIndex = selectedId !== null ? sky?.indexOf.get(selectedId) ?? null : null;
  const pointedIndex = pointedId !== null ? sky?.indexOf.get(pointedId) ?? null : null;
  const basis = basisSentence(ready, map.data);
  const fires = new Map((status.data?.routines ?? []).map((r) => [r.id, r.will_fire]));

  return (
    <section className="today" aria-label="Today">
      <div className="today-plate">
        {sky && field && ready ? (
          <Plate
            ref={plate}
            sky={sky}
            regions={ready.regions}
            shapes={shapes}
            field={field}
            arrivals={arrivals}
            lit={litNow}
            selected={selectedIndex}
            pointed={pointedIndex}
            onSelect={(index) => setSelectedId(index === null ? null : sky.ids[index] ?? null)}
            onHover={setHover}
            paletteKey={`${theme}:${shown.accent ?? ''}`}
            label={`Map of your ${number(sky.count)} papers in ${count(ready.regions.length, 'region')}${papers.length ? `; ${count(papers.length, 'new paper')} ringed and numbered` : ''}. The list beside it has every new paper.`}
            onAway={setAway}
            toolsAt={corner === 'bl' ? 'right' : 'left'}
          >
            {data && (
              <Cartouche data={data} now={now} away={away} corner={corner} basis={basis} skyCount={sky.count}
                unplaced={ready.unplaced} sinceWord={sinceWord} />
            )}
            {hover && (
              <Tip hover={hover} paper={hovered !== null ? listed.get(hovered) : undefined}
                brief={brief.data ?? undefined} now={now} cell={gridCell(sky.x[hover.index] ?? 0, sky.y[hover.index] ?? 0, sky.bounds)}
                sourceName={sourceName} />
            )}
          </Plate>
        ) : (
          <div className="plate plate-waiting">
            <p role="status">{waitingSentence(map.data, map.isPending)}</p>
            <FirstRun />
          </div>
        )}
        <PlateKey newLabel={heading.replace(/^New/, 'new')} showWatches={shapes.length > 0} />
      </div>

      {data ? (
        <TodayIndex
          papers={papers}
          total={data.total}
          fromSearches={data.from_searches}
          collectionSize={map.data?.state === 'empty' ? 0 : sky ? sky.count : null}
          watches={data.watches}
          regions={regionsById}
          sourceName={sourceName}
          heading={heading}
          lit={litNow}
          selected={selectedId}
          now={now}
          saved={saved}
          marking={looked.isPending}
          busy={today.isFetching}
          onSelect={(id) => { setSelectedId(id); zoomTo({ paperId: id }); }}
          onPoint={setPointedId}
          onZoomTo={zoomTo}
          onToggleSave={(paper) => save.mutate({ id: paper.id, on: !(saved.get(paper.id) ?? paper.queue_status !== null) })}
          onMarkRead={() => looked.mutate()}
          footer={<Footer data={data} fires={fires} state={status.data?.state ?? null} now={now}
            backupAt={backup.data?.last_backup?.created_at_utc ?? null} />}
        />
      ) : (
        <section className="index" aria-busy="true"><div className="index-bar"><h2>Today</h2></div></section>
      )}
    </section>
  );
}

function basisSentence(ready: CollectionMap | null, map: CollectionMap | undefined): string {
  if (!ready) return '';
  if (ready.basis === 'embeddings') {
    return `placed by how close their meaning is, as your embedding model ${ready.model ? `(${ready.model}) ` : ''}reads it`;
  }
  const coverage = map?.embedding_coverage;
  const pending = coverage && coverage.total > 0
    ? ` Your embedding model has read ${Math.floor((coverage.embedded / coverage.total) * 100)}% of them; at 90% the map is redrawn by meaning.`
    : '';
  return `placed by how much wording they share, worked out on this computer.${pending}`;
}

function waitingSentence(map: CollectionMap | undefined, pending: boolean): string {
  if (pending || !map) return 'Reading the map of your collection…';
  if (map.state === 'empty') return 'Your collection is empty. Papers your watches and searches find will appear here, placed by how similar their text is.';
  if (map.state === 'failed') return `The map could not be drawn: ${map.error ?? 'the engine gave no reason'}.`;
  return 'Drawing the map of your collection. The first map of a large collection takes up to half a minute; later ones are kept.';
}

function Cartouche({ data, now, away, corner, basis, skyCount, unplaced, sinceWord }: {
  data: TodayData; now: Date; away: boolean; corner: string; basis: string; skyCount: number;
  unplaced: CollectionMap['unplaced']; sinceWord: string;
}) {
  const fromWatches = data.watches.filter((w) => w.new_count > 0);
  const off = unplaced.no_text + unplaced.not_embedded;
  return (
    <aside className={`cartouche ${corner}${away ? ' away' : ''}`} aria-label="Today in brief">
      <p className="date">{fullDate(now)}</p>
      <h1>{data.total === 0 ? 'Nothing new' : count(data.total, 'new paper')}</h1>
      <p className="since">
        {data.window === 'first_look'
          ? 'in the last seven days. Mark all read, and Today starts from then.'
          : `since you marked them read ${sinceWord}`}
      </p>
      <p className="plt">
        The plate: all {number(skyCount)} papers on the map, {basis}
        {off > 0 && ` ${count(off, 'paper')} with too little to place ${off === 1 ? 'is' : 'are'} not on it.`}
      </p>
      {(fromWatches.length > 0 || data.from_searches > 0) && (
        <div className="split">
          {fromWatches.map((w) => (
            <div key={w.id}><b>{number(w.new_count)}</b> from <span className="it">{w.name}</span></div>
          ))}
          {data.from_searches > 0 && <div><b>{number(data.from_searches)}</b> from your own searches</div>}
        </div>
      )}
    </aside>
  );
}

function Tip({ hover, paper, brief, now, cell, sourceName }: {
  hover: PlateHover; paper?: IndexPaper; brief?: Brief; now: Date; cell: string;
  sourceName: (slug: string) => string;
}) {
  const info = paper ?? brief;
  const ago = daysAgo(info?.first_seen_at, now);
  return (
    <div className="tip" style={{ left: hover.screenX + 14, top: hover.screenY + 14 }} role="tooltip">
      {info ? (
        <>
          <b>{paper ? `${paper.n}. ` : ''}{info.title}</b>
          <span>{authors(info.authors)}</span>
          <span>
            {sourceName(info.source)} · {cell}
            {ago !== null && ` · collected ${ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${number(ago)} days ago`}`}
          </span>
        </>
      ) : <span>{cell}</span>}
    </div>
  );
}

const WILL_NOT_RUN: Record<string, string> = {
  no_service: 'Your watches will not run: no background service is set up.',
  service_stopped: 'Your watches will not run while the background service is stopped.',
  service_unreachable: 'Your watches may not run: the background service did not answer.',
  service_other_version: 'Your watches will not run: the background service is another version of resmon.',
  scheduler_off: 'Your watches will not run: scheduling is off in this process.',
};

function Footer({ data, fires, state, now, backupAt }: {
  data: TodayData; fires: Map<number, boolean | null>; state: string | null; now: Date; backupAt: string | null;
}) {
  // A next run is stated only for a watch something will actually fire.
  const next = data.watches
    .filter((w) => w.is_active && w.next_fire_at)
    .map((w) => ({ w, at: w.next_fire_at ?? '', fire: fires.get(w.id) }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const certain = next.filter((n) => n.fire === true);
  const unsure = next.filter((n) => n.fire === null || n.fire === undefined);
  return (
    <>
      <span>{backupAt ? `Backed up ${when(backupAt, now)}.` : 'No backup made yet.'}</span>
      <span className="r">
        {certain.length > 0
          ? `Next: ${certain.slice(0, 2).map((n) => when(n.at, now)).join(' and ')}`
          : unsure.length > 0
            ? `Next run ${when(unsure[0]?.at, now)}, if the background service is running`
            : data.watches.some((w) => w.is_active)
              ? (state && WILL_NOT_RUN[state]) ?? 'Nothing will run your watches as things stand.'
              : 'No watch is active.'}
      </span>
    </>
  );
}
