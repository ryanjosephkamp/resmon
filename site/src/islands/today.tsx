/**
 * The home page's plate, live: the app's own map component (`Plate.tsx`, from
 * Atlas, imported as it is) drawn over the plate the page was built with, so
 * it can be zoomed, panned, pointed at, and chosen from as Today is.
 *
 * What the app's Today screen does around its plate is done here with this
 * page's own markup: the map's own bar (`MapControls.tsx`) finds a title or an
 * author, filters what is lit, and colors the papers by watch, source, or age;
 * the title block rides on the plate and fades while the view is away from
 * home; a tip names the paper under the pointer; pointing at an entry in the
 * index rings its paper, and choosing either chooses both; a paper the index
 * does not hold opens in the index's place, as the app opens it beside its
 * map; Escape clears the choice. The opening, the new papers lighting in turn,
 * carries on from where the built plate's had got to, on the same schedule.
 *
 * The data is the page's own: `plate/sky.json`; `plate/papers.json`, fetched
 * the first time a reader points at the map or types a find; `plate/facets.json`,
 * fetched when the bar's menus are opened or a view needs it. The find is the
 * engine's (`map_facets.find`), run here over the same records: a title or an
 * author that contains the words, ignoring the case of ASCII letters, newest
 * first. A view is held for the visit only; the app keeps it in the engine.
 * Where anything here cannot run, the plate the page was built with stays,
 * and so does everything it says.
 */
import { render } from 'preact';
import { createPortal } from 'preact/compat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Plate, type PlateHandle, type PlateHover } from '../../../resmon_scripts/frontend/atlas/src/screens/today/Plate';
import {
  buildSky,
  density,
  epochDay,
  gridCell,
  watchShape,
  type MapRegion,
} from '../../../resmon_scripts/frontend/atlas/src/screens/today/model';
import { authors, daysAgo, number, publishedWords } from '../../../resmon_scripts/frontend/atlas/src/screens/today/format';
import { NO_OPENING, type Opening } from '../../../resmon_scripts/frontend/atlas/src/screens/today/opening';
import { ColorKey, DimKey, MapBar } from '../../../resmon_scripts/frontend/atlas/src/screens/sky/MapControls';
import {
  DEFAULT_VIEW,
  FIND_MIN,
  filterCount,
  joinFacts,
  lookOf,
  needsFacts,
  type Facets,
  type MapView,
} from '../../../resmon_scripts/frontend/atlas/src/screens/sky/look';

interface SkyData {
  recorded: string;
  points: Parameters<typeof buildSky>[0];
  regions: MapRegion[];
  watches: { id: number; name: string; members: number[] }[];
  /** The new papers' ids, ring 1 first. */
  arrivals: number[];
  names: Record<string, string>;
  corner: 'tl' | 'tr' | 'bl' | 'br' | 'below';
  label: string;
}

/** One paper: id, title, authors, source, published, first collected, link (`export_site.py`). */
type PaperRow = [number, string, string | null, string, string | null, string | null, string | null];

/** The most room a tip takes, as the app's Today reserves it. */
const TIP_WIDTH = 300;
const TIP_HEIGHT = 96;

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Where the built plate's opening had got to: its rings' animations started
 * when the page first drew, on the app's schedule, so that moment is the
 * opening's start here too. With motion reduced there is none.
 */
function openingOf(today: HTMLElement): Opening {
  if (reduced()) return NO_OPENING;
  const started = today.querySelector('.ring')?.getAnimations?.()[0]?.startTime;
  return typeof started === 'number' ? { state: 'running', start: started } : NO_OPENING;
}

/** Papers' lines, read once, the first time the map is pointed at. */
function usePapers(url: string) {
  const [rows, setRows] = useState<Map<number, PaperRow> | null>(null);
  const asked = useRef(false);
  const want = useCallback(() => {
    if (asked.current) return;
    asked.current = true;
    fetch(url)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((data: { papers: PaperRow[] }) => setRows(new Map(data.papers.map((row) => [row[0], row]))))
      .catch(() => {
        // The tip says the grid cell, as the app's does while a paper's line is read.
        asked.current = false;
      });
  }, [url]);
  return { rows, want };
}

/** How long typing rests before the find runs, as the app waits before asking the engine. */
const FIND_SETTLE_MS = 220;

/** ASCII letters in lower case and nothing else, as SQLite's `LIKE` compares them. */
const ascii = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The engine's find (`map_facets.find`), over the same records: papers whose
 * title or authors contain the words, the words' spaces collapsed, newest
 * collected first.
 */
function findIn(rows: Map<number, PaperRow>, term: string): number[] {
  const needle = ascii(term);
  return [...rows.values()]
    .filter((row) => ascii(row[1]).includes(needle) || ascii(row[2] ?? '').includes(needle))
    .sort((a, b) => (b[5] ?? '').localeCompare(a[5] ?? '') || b[0] - a[0])
    .map((row) => row[0]);
}

/** The map's look, as the app's `useMapLook` works it out, with the facets and the find read from this page. */
function useLook(sky: ReturnType<typeof buildSky>, rows: Map<number, PaperRow> | null, wantRows: () => void,
  facetsUrl: string, names: (slug: string) => string) {
  const [view, setView] = useState<MapView>(DEFAULT_VIEW);
  const [wanted, setWanted] = useState(false);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [facetsError, setFacetsError] = useState<Error | null>(null);
  const needed = wanted || needsFacts(view);
  useEffect(() => {
    if (facets || !needed) return undefined;
    let current = true;
    fetch(facetsUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the page's facets answered ${r.status}`))))
      .then((data: Facets) => { if (current) { setFacets(data); setFacetsError(null); } })
      .catch((error: Error) => { if (current) setFacetsError(error); });
    return () => { current = false; };
  }, [facets, needed, facetsUrl]);
  const facts = useMemo(() => (facets ? joinFacts(sky, facets) : null), [sky, facets]);

  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState('');
  const words = typed.split(/\s+/).filter(Boolean).join(' ');
  useEffect(() => {
    if (words) wantRows();
    if (words === term) return undefined;
    const settle = window.setTimeout(() => setTerm(words), FIND_SETTLE_MS);
    return () => window.clearTimeout(settle);
  }, [words, term, wantRows]);
  const finding = term.length >= FIND_MIN;
  const matches = useMemo(() => (finding && rows ? findIn(rows, term) : null), [finding, rows, term]);
  const look = useMemo(() => lookOf(sky, facts, view, matches, names), [sky, facts, view, matches, names]);
  const plateLook = useMemo(() => ({ lit: look.lit, group: look.group, colors: look.colors, found: look.found }), [look]);
  return {
    view, setView, look, plateLook, facts, facetsError, wantFacets: () => setWanted(true),
    find: {
      typed, setTyped, finding,
      waiting: (words !== term && words.length >= FIND_MIN) || (finding && !rows),
      error: null,
    },
  };
}

/** "collected today", "collected yesterday", "collected 12 days ago": said from the plate's own moment. */
function collectedWords(iso: string | null, recorded: Date): string | null {
  const ago = daysAgo(iso, recorded);
  if (ago === null) return null;
  return `collected ${ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${number(ago)} days ago`}`;
}

function Tip({ hover, row, n, cell, names, recorded }: {
  hover: PlateHover; row?: PaperRow; n?: number; cell: string; names: Record<string, string>; recorded: Date;
}) {
  // Beside the paper, below and to the right, unless that runs off the plate's edge.
  const flipX = hover.width !== undefined && hover.screenX + 14 + TIP_WIDTH > hover.width;
  const flipY = hover.height !== undefined && hover.screenY + 14 + TIP_HEIGHT > hover.height;
  const place = {
    ...(flipX ? { right: (hover.width ?? 0) - hover.screenX + 14 } : { left: hover.screenX + 14 }),
    ...(flipY ? { bottom: (hover.height ?? 0) - hover.screenY + 14 } : { top: hover.screenY + 14 }),
  };
  const collected = row ? collectedWords(row[5], recorded) : null;
  return (
    <div class="tip" style={place} role="tooltip">
      {row ? (
        <>
          <b>{n ? `${n}. ` : ''}{row[1]}</b>
          <span>{authors(row[2])}</span>
          <span>{names[row[3]] ?? row[3]} · {cell}{collected && ` · ${collected}`}</span>
        </>
      ) : <span>{cell}</span>}
    </div>
  );
}

/** A paper chosen on the map that the index does not hold: what resmon holds of it, in the index's place. */
function PaperPanel({ row, cell, region, names, recorded, onBack, onShow }: {
  row: PaperRow | undefined; cell: string | null; region: string | null; names: Record<string, string>;
  recorded: Date; onBack: () => void; onShow: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, [row?.[0]]);
  const source = row ? names[row[3]] ?? row[3] : '';
  return (
    <article class="paper" aria-label="The paper chosen on the map">
      <button ref={back} type="button" class="paper-back" onClick={onBack}>
        <svg class="icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H3M7 4 3 8l4 4" /></svg>
        Back to the list
      </button>
      {row ? (
        <>
          <h3 class="paper-title">{row[1]}</h3>
          <p class="paper-authors">{authors(row[2])}</p>
          <dl class="paper-facts">
            <div><dt>Source</dt><dd>{source}</dd></div>
            {row[4] && <div><dt>Published</dt><dd>{publishedWords(row[4])}</dd></div>}
            {row[5] && <div><dt>In the collection</dt><dd>{collectedWords(row[5], recorded)?.replace(/^collected/, 'Collected')}</dd></div>}
            {cell && <div><dt>On the plate</dt><dd>{cell}{region ? `, in ${region}` : ''}</dd></div>}
          </dl>
          <p class="paper-actions">
            <button type="button" class="paper-show" onClick={onShow}>Show it on the map</button>
            {row[6] && <a href={row[6]} rel="noopener">Read it at {source}</a>}
          </p>
        </>
      ) : <p class="paper-wait" role="status">Reading what the collection holds of this paper.</p>}
    </article>
  );
}

function Live({ data, today, papersUrl, facetsUrl, cartouche }: {
  data: SkyData; today: HTMLElement; papersUrl: string; facetsUrl: string; cartouche: string | null;
}) {
  const recorded = useMemo(() => new Date(data.recorded), [data]);
  const sky = useMemo(() => buildSky(data.points, data.regions, epochDay(recorded)), [data, recorded]);
  const field = useMemo(() => density(sky, 160, 2), [sky]);
  const shapes = useMemo(() => data.watches.map((w) => watchShape(sky, data.regions, w)), [sky, data]);
  const arrivals = useMemo(
    () => data.arrivals.map((id) => sky.indexOf.get(id)).filter((at): at is number => at !== undefined),
    [sky, data],
  );
  const numbered = useMemo(() => new Map(data.arrivals.map((id, k) => [id, k + 1])), [data]);
  const regionNames = useMemo(() => new Map(data.regions.map((r) => [r.id, r.label])), [data]);
  const opening = useMemo(() => openingOf(today), [today]);
  const plate = useRef<PlateHandle>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pointedId, setPointedId] = useState<number | null>(null);
  const [hover, setHover] = useState<PlateHover | null>(null);
  const [away, setAway] = useState(false);
  const [palette, setPalette] = useState(0);
  const { rows, want } = usePapers(papersUrl);
  const names = useCallback((slug: string) => data.names[slug] ?? slug, [data]);
  const mapLook = useLook(sky, rows, want, facetsUrl, names);
  const chosen = useRef<number | null>(null);
  chosen.current = selectedId;

  // The canvas reads its colors once; a theme or a hue chosen, or the system's scheme changing, has it read them again.
  useEffect(() => {
    const again = () => setPalette((n) => n + 1);
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    document.addEventListener('resmon:appearance', again);
    scheme.addEventListener('change', again);
    return () => {
      document.removeEventListener('resmon:appearance', again);
      scheme.removeEventListener('change', again);
    };
  }, []);

  const flyToPaper = useCallback((id: number) => {
    const at = sky.indexOf.get(id);
    // Close enough to see its neighbors, far enough to keep its surroundings.
    if (at !== undefined) plate.current?.flyTo({ x: sky.x[at] ?? 0, y: sky.y[at] ?? 0, r: sky.bounds.size * 0.22 });
  }, [sky]);

  const flyToWatch = useCallback((watchId: number) => {
    const shape = shapes.find((s) => s.id === watchId);
    if (!shape || !shape.outline.length) return;
    const xs = shape.outline.flatMap(([a, , c]) => [a, c]);
    const ys = shape.outline.flatMap(([, b, , d]) => [b, d]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    plate.current?.flyTo({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: Math.max(x1 - x0, y1 - y0) / 2 });
  }, [shapes]);

  // The index: an entry pointed at rings its paper, and an entry chosen chooses it on the map and flies there.
  useEffect(() => {
    const off: (() => void)[] = [];
    const on = (el: Element, type: string, fn: (event: Event) => void) => {
      el.addEventListener(type, fn);
      off.push(() => el.removeEventListener(type, fn));
    };
    for (const entry of today.querySelectorAll<HTMLElement>('[data-paper]')) {
      const id = Number(entry.dataset.paper);
      const choose = () => {
        if (chosen.current === id) { setSelectedId(null); return; }
        setSelectedId(id);
        flyToPaper(id);
      };
      on(entry, 'pointerenter', () => setPointedId(id));
      on(entry, 'pointerleave', () => setPointedId((p) => (p === id ? null : p)));
      on(entry, 'click', (event) => {
        if ((event.target as Element).closest('a, summary, button')) return;
        choose();
      });
      const badge = entry.querySelector<HTMLElement>('.badge');
      if (badge) {
        badge.setAttribute('role', 'button');
        badge.tabIndex = 0;
        badge.setAttribute('aria-label', `Number ${numbered.get(id) ?? ''}: show it on the map`);
        on(badge, 'keydown', (event) => {
          const key = (event as KeyboardEvent).key;
          if (key !== 'Enter' && key !== ' ') return;
          event.preventDefault();
          choose();
        });
      }
    }
    for (const group of today.querySelectorAll<HTMLElement>('[data-watch]')) {
      const heading = group.querySelector<HTMLElement>('.ghead h3');
      if (!heading) continue;
      const id = Number(group.dataset.watch);
      heading.setAttribute('role', 'button');
      heading.tabIndex = 0;
      heading.title = 'Show this watch’s papers on the map';
      on(heading, 'click', () => flyToWatch(id));
      on(heading, 'keydown', (event) => {
        const key = (event as KeyboardEvent).key;
        if (key !== 'Enter' && key !== ' ') return;
        event.preventDefault();
        flyToWatch(id);
      });
    }
    // Escape clears a chosen paper wherever the keyboard is, as the map's own Escape does, and not from a text
    // field or while something else holds the key. From the index, the keyboard goes back to that entry's number.
    on(today, 'keydown', (event) => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Escape' || key.defaultPrevented || chosen.current === null) return;
      const from = key.target instanceof Element ? key.target : null;
      if (from?.closest('input, textarea, select, [contenteditable]')) return;
      const was = chosen.current;
      key.preventDefault();
      setSelectedId(null);
      if (from?.closest('.index')) today.querySelector<HTMLElement>(`[data-paper="${was}"] .badge`)?.focus();
      else if (from?.closest('.paper')) plate.current?.focus();
    });
    return () => { for (const undo of off) undo(); };
  }, [today, numbered, flyToPaper, flyToWatch]);

  // The chosen entry is marked, and kept in view inside the index without moving the page.
  useEffect(() => {
    const scroller = today.querySelector<HTMLElement>('.index-scroll');
    for (const entry of today.querySelectorAll<HTMLElement>('[data-paper]')) {
      const isChosen = Number(entry.dataset.paper) === selectedId;
      entry.toggleAttribute('data-chosen', isChosen);
      if (!isChosen || !scroller) continue;
      const box = scroller.getBoundingClientRect();
      const at = entry.getBoundingClientRect();
      if (at.top < box.top || at.bottom > box.bottom) {
        scroller.scrollTo({ top: scroller.scrollTop + at.top - box.top - 8, behavior: reduced() ? 'auto' : 'smooth' });
      }
    }
  }, [today, selectedId]);

  // A paper the index does not hold opens in the index's place.
  const opened = selectedId !== null && !numbered.has(selectedId) ? selectedId : null;
  const panelHost = useMemo(() => today.querySelector<HTMLElement>('[data-paper-panel]'), [today]);
  useEffect(() => {
    if (opened !== null) want();
    if (panelHost) panelHost.hidden = opened === null;
    today.querySelector('.index')?.classList.toggle('showing-paper', opened !== null);
  }, [opened, panelHost, today, want]);

  // Enter in the find steps through its matches, each chosen and flown to as a click on it would be.
  const step = (direction: 1 | -1) => {
    const found = mapLook.look.found;
    if (found.length === 0) return;
    const at = selectedId !== null ? found.indexOf(sky.indexOf.get(selectedId) ?? -1) : -1;
    const next = at < 0 ? (direction === 1 ? 0 : found.length - 1) : (at + direction + found.length) % found.length;
    const id = sky.ids[found[next] ?? 0];
    if (id !== undefined) { setSelectedId(id); flyToPaper(id); }
  };
  const barHost = useMemo(() => today.querySelector<HTMLElement>('[data-map-bar]'), [today]);
  const keyHost = useMemo(() => today.querySelector<HTMLElement>('[data-key-live]'), [today]);
  const colored = mapLook.look.legend.length > 0;
  useEffect(() => { today.classList.toggle('map-colored', colored); }, [today, colored]);

  const selectedIndex = selectedId !== null ? sky.indexOf.get(selectedId) ?? null : null;
  const pointedIndex = pointedId !== null ? sky.indexOf.get(pointedId) ?? null : null;
  const hoveredId = hover ? sky.ids[hover.index] ?? null : null;
  const openedAt = opened !== null ? sky.indexOf.get(opened) : undefined;
  const cellOf = (at: number) => gridCell(sky.x[at] ?? 0, sky.y[at] ?? 0, sky.bounds);

  return (
    <>
      <Plate
        ref={plate}
        sky={sky}
        regions={data.regions}
        shapes={shapes}
        field={field}
        arrivals={arrivals}
        opening={opening}
        selected={selectedIndex}
        pointed={pointedIndex}
        onSelect={(index) => setSelectedId(index === null ? null : sky.ids[index] ?? null)}
        onHover={(next) => { if (next) want(); setHover(next); }}
        paletteKey={String(palette)}
        label={data.label}
        onAway={setAway}
        toolsAt={data.corner === 'bl' ? 'right' : 'left'}
        look={mapLook.plateLook}
        wheel="page"
      >
        {cartouche !== null && (
          <aside
            class={`cartouche${away ? ' away' : ''}`}
            aria-label="Today in brief"
            // The built title block's own words, carried onto the plate the app draws.
            dangerouslySetInnerHTML={{ __html: cartouche }}
          />
        )}
        {hover && (
          <Tip hover={hover} row={hoveredId !== null ? rows?.get(hoveredId) : undefined}
            n={hoveredId !== null ? numbered.get(hoveredId) : undefined} cell={cellOf(hover.index)}
            names={data.names} recorded={recorded} />
        )}
      </Plate>
      {barHost && createPortal(
        <MapBar name="today" view={mapLook.view} onView={mapLook.setView} look={mapLook.look} facts={mapLook.facts}
          facetsError={mapLook.facetsError} total={sky.count} names={names} find={mapLook.find}
          findAt={selectedIndex !== null ? mapLook.look.found.indexOf(selectedIndex) + 1 : 0} onStep={step}
          onWant={mapLook.wantFacets} />,
        barHost,
      )}
      {keyHost && createPortal(
        <>
          {colored && <ColorKey look={mapLook.look} />}
          <DimKey look={mapLook.look} finding={mapLook.find.finding} filtered={filterCount(mapLook.view) > 0} />
        </>,
        keyHost,
      )}
      {panelHost && opened !== null && createPortal(
        <PaperPanel
          row={rows?.get(opened)}
          cell={openedAt !== undefined ? cellOf(openedAt) : null}
          region={openedAt !== undefined ? regionNames.get(sky.region[openedAt] ?? -1) || null : null}
          names={data.names}
          recorded={recorded}
          onBack={() => { setSelectedId(null); plate.current?.focus(); }}
          onShow={() => flyToPaper(opened)}
        />,
        panelHost,
      )}
    </>
  );
}

const today = document.querySelector<HTMLElement>('[data-today]');
const host = today?.querySelector<HTMLElement>('[data-plate-live]');
const chart = today?.querySelector<HTMLElement>('.chart');
if (today && host && chart && host.dataset.sky && host.dataset.papers && 'ResizeObserver' in window) {
  // The plate's names are drawn on the canvas in the app's faces, so they are loaded before it draws.
  const faces = document.fonts
    ? Promise.all([
        document.fonts.load('560 1rem "Geist Variable"'),
        document.fonts.load('italic 400 1rem Spectral'),
      ]).catch(() => undefined)
    : Promise.resolve();
  Promise.all([fetch(host.dataset.sky).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))), faces])
    .then(([data]: [SkyData, unknown]) => {
      const built = chart.querySelector<HTMLElement>(':scope > .cartouche');
      const cartouche = data.corner === 'below' ? null : built?.innerHTML ?? null;
      render(
        <Live data={data} today={today} papersUrl={host.dataset.papers ?? ''} facetsUrl={host.dataset.facets ?? ''}
          cartouche={cartouche} />,
        host,
      );
      chart.classList.add('is-live');
      chart.querySelector('svg.sky')?.setAttribute('aria-hidden', 'true');
    })
    .catch(() => {
      // The plate the page was built with stays as it is.
    });
}
