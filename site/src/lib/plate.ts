/**
 * The home page's plate: the app's Today, drawn at build time from a real
 * collection.
 *
 * `../data/plate.json` holds the engine's own `GET /api/map` and
 * `GET /api/today`, exported unedited by `resmon_scripts/frontend/demos/
 * export_site.py`. Everything here that decides where a paper sits, how bright
 * it is, which grid cell it is in, and the outline of each watch comes from
 * the app's own map model, imported from Atlas rather than copied, so the site
 * draws the plate the app draws. What is left to this file is what the app
 * does with a canvas: turning plate space into the SVG's pixels, and choosing
 * which names have room.
 *
 * Text widths are estimated from character counts (there is no canvas to
 * measure with at build time), a little generously, so a name that would
 * crowd another is left out rather than overlapping it.
 */
import data from '../data/plate.json';
import {
  GRID,
  GRID_LETTERS,
  RAMP_DAYS,
  buildSky,
  density,
  epochDay,
  gridCell,
  placeName,
  watchShape,
  type Box,
  type Corner,
  type MapRegion,
} from '../../../resmon_scripts/frontend/atlas/src/screens/today/model';
import {
  authors,
  count,
  duration,
  listWords,
  number,
  troubleParts,
} from '../../../resmon_scripts/frontend/atlas/src/screens/today/format';
import { pngDataUrl } from './png';

/** The plate's drawn size, in the SVG's own pixels; the page scales it to its column. */
export const SIZE = 720;
/** The margin the grid's letters and numbers sit in, as the app draws it. */
const MARGIN = 26;
/** The app's star sizes and strengths by age, newest first (`Plate.tsx`). */
const RAMP_RADIUS = [2.3, 1.8, 1.4, 1.1, 0.85];
const RAMP_ALPHA = [1, 0.86, 0.7, 0.58, 0.5];
/** The share of a watch name's box that may sit over papers before the name is dropped. */
const NAME_COVER = 0.35;
/** The title block's share of the plate, as the app reserves it. */
const CARTOUCHE = { w: 0.36, h: 0.4 };
/** Where the page sets it: this far in from the plate's edges, as shares of the whole plate (`TodayPlate.astro`). */
const CARTOUCHE_INSET = 0.05;
/** Times are said in the zone the collection was built in, with the zone named. */
const ZONE = 'America/New_York';

const map = data.map;
const today = data.today;
export const provenance = data.provenance;

const recorded = new Date(today.now);
const sky = buildSky(map.points, map.regions as MapRegion[], epochDay(recorded));
const field = density(sky, 160, 2);
const regions = map.regions as MapRegion[];

// ---- Plate space to the SVG's pixels: the app's home view ---------------

const inner = { x: MARGIN, y: MARGIN, w: SIZE - MARGIN * 2, h: SIZE - MARGIN * 2 };
const { minX, minY, size: span } = sky.bounds;
const scale = inner.w / span;
const cx = minX + span / 2;
const cy = minY + span / 2;
const toScreen = (x: number, y: number): [number, number] => [
  (x - cx) * scale + SIZE / 2,
  SIZE / 2 - (y - cy) * scale,
];
const px = (n: number) => Math.round(n * 10) / 10;

// How much screen each paper has: the regions' discs over the paper count.
const occupied = Math.max(0.05, regions.reduce((sum, r) => sum + Math.PI * r.r * r.r, 0));
const spacing = Math.sqrt((occupied * scale * scale) / Math.max(1, sky.count));
const cap = Math.max(0.55, spacing * 0.42);
const crowding = Math.min(1, 0.35 + spacing / 6);

// ---- The stars: one path per age, oldest first so the newest sit on top --

export interface StarClass {
  d: string;
  width: number;
  opacity: number;
}

const screen = Array.from({ length: sky.count }, (_, i) => toScreen(sky.x[i] ?? 0, sky.y[i] ?? 0));

export const stars: StarClass[] = RAMP_RADIUS.map((radius, cls) => {
  let d = '';
  for (let i = 0; i < sky.count; i++) {
    if (sky.ramp[i] !== cls) continue;
    const [sx, sy] = screen[i] ?? [0, 0];
    d += `M${px(sx)} ${px(sy)}h0`;
  }
  return { d, width: px(Math.min(radius, cap) * 2), opacity: px((RAMP_ALPHA[cls] ?? 0.5) * crowding * 100) / 100 };
}).reverse();

/** The days-since-collected classes, for the key: "0", "7", "30", "90", "180". */
export const rampDays = RAMP_DAYS;

// ---- Where papers crowd: the app's shading, as a mask the ink shows through

const shadingLevels = new Uint8Array(field.n * field.n);
for (let i = 0; i < field.values.length; i++) {
  const t = field.max > 0 ? Math.min(1, (field.values[i] ?? 0) / field.max) : 0;
  shadingLevels[i] = Math.round(255 * Math.pow(t, 0.55));
}
export const shading = {
  href: pngDataUrl(field.n, field.n, shadingLevels),
  x: px(toScreen(minX, 0)[0]),
  y: px(toScreen(0, minY + span)[1]),
  size: px(span * scale),
};

// ---- The grid, and its margin labels ------------------------------------

export const grid = Array.from({ length: GRID + 1 }, (_, k) => ({
  x: Math.round(toScreen(minX + (span * k) / GRID, 0)[0]) + 0.5,
  y: Math.round(toScreen(0, minY + (span * k) / GRID)[1]) + 0.5,
}));
export const margins = Array.from({ length: GRID }, (_, k) => ({
  letter: GRID_LETTERS[k] ?? '',
  number: String(k + 1),
  x: px(toScreen(minX + (span * (k + 0.5)) / GRID, 0)[0]),
  y: px(toScreen(0, minY + span - (span * (k + 0.5)) / GRID)[1]),
}));
export const frame = { margin: MARGIN, inner };

// ---- Names: the title block's corner first, then regions, then watches ---

const placed: Box[] = [];
const free = (b: Box) => !placed.some((p) => b.x < p.x + p.w && p.x < b.x + b.w && b.y < p.y + p.h && p.y < b.y + b.h);
const inside = (b: Box) =>
  b.x >= inner.x + 4 && b.y >= inner.y + 4 && b.x + b.w <= inner.x + inner.w - 4 && b.y + b.h <= inner.y + inner.h - 4;
const papersUnder = (b: Box) =>
  screen.reduce((n, [sx, sy]) => n + (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h ? 1 : 0), 0);
/**
 * The plate's type sizes (`--plate-text-*` in `tokens.css`), and how wide a
 * name set in them is: Geist at 560 averages about 0.565 of its size a
 * character, Spectral italic about 0.476, and Geist's figures 0.61.
 */
const TEXT = { region: 12.5, watch: 16, number: 12 };
const sansWidth = (text: string) => text.length * TEXT.region * 0.565 + 8;
const italicWidth = (text: string) => text.length * TEXT.watch * 0.476 + 6;
const numberWidth = (text: string) => text.length * TEXT.number * 0.61 + 2;

// The new papers, numbered in the order they were collected: 1 arrived first.
const arrivals = [...today.papers].reverse().map((paper, k) => {
  const at = sky.indexOf.get(paper.id);
  const [sx, sy] = at === undefined ? [null, null] : (screen[at] ?? [null, null]);
  return {
    paper,
    n: k + 1,
    x: sx === null ? null : px(sx),
    y: sy === null ? null : px(sy),
    cell: at === undefined ? null : gridCell(sky.x[at] ?? 0, sky.y[at] ?? 0, sky.bounds),
  };
});
/** The title block's box in the plate's pixels, in a corner, with a little room around it. */
function cartoucheBox(c: Corner): Box {
  const w = SIZE * CARTOUCHE.w + 12;
  const h = SIZE * CARTOUCHE.h + 12;
  const left = c.endsWith('l') ? SIZE * CARTOUCHE_INSET - 6 : SIZE * (1 - CARTOUCHE_INSET) - w + 6;
  const top = c.startsWith('t') ? SIZE * CARTOUCHE_INSET - 6 : SIZE * (1 - CARTOUCHE_INSET) - h + 6;
  return { x: left, y: top, w, h };
}
const ringsUnder = (b: Box) =>
  arrivals.filter(({ x, y }) => x !== null && y !== null && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h).length;

/**
 * Which corner the title block sits in. The app sets it in the corner with the
 * fewest papers and steps it aside when it covers what you point at; a page
 * cannot step it aside, so here it sits where it covers no new paper, and of
 * those corners the one with the fewest papers. Where every corner would cover
 * one, it sits under the plate instead (`'below'`), so every ring the index
 * numbers can be seen.
 */
export const corner: Corner | 'below' = (() => {
  const clear = (['tr', 'tl', 'br', 'bl'] as Corner[])
    .filter((c) => ringsUnder(cartoucheBox(c)) === 0)
    .sort((a, b) => papersUnder(cartoucheBox(a)) - papersUnder(cartoucheBox(b)));
  return clear[0] ?? 'below';
})();
if (corner !== 'below') placed.push(cartoucheBox(corner));

const clearOfRings = (b: Box) =>
  !arrivals.some(({ x, y }) => x !== null && y !== null && x + 8 > b.x && x - 8 < b.x + b.w && y + 8 > b.y && y - 8 < b.y + b.h);

export const regionLabels = [...regions]
  .sort((a, b) => b.size - a.size)
  .flatMap((region) => {
    const screenR = region.r * scale;
    if (screenR < 30 || !region.label) return [];
    const [rx, ry] = toScreen(region.x, region.y);
    const ly = ry - screenR * 0.82;
    const width = sansWidth(region.label);
    const box = { x: rx - width / 2, y: ly - 9, w: width, h: 18 };
    if (!free(box)) return [];
    placed.push(box);
    return [{ label: region.label, x: px(rx), y: px(ly) }];
  });

const shapes = today.watches
  .filter((watch) => watch.members.length > 0)
  .map((watch) => watchShape(sky, regions, { id: watch.id, name: watch.name, members: watch.members }));

export const outlines = shapes
  .map((shape) =>
    shape.outline
      .map(([x1, y1, x2, y2]) => {
        const [a, b] = toScreen(x1, y1);
        const [c, d] = toScreen(x2, y2);
        return `M${px(a)} ${px(b)}L${px(c)} ${px(d)}`;
      })
      .join(''),
  )
  .join('');

export const constellations = shapes
  .flatMap((shape) =>
    shape.lines.map(([i, j]) => {
      const [a, b] = toScreen(...(shape.stars[i] ?? [0, 0]));
      const [c, d] = toScreen(...(shape.stars[j] ?? [0, 0]));
      return `M${px(a)} ${px(b)}L${px(c)} ${px(d)}`;
    }),
  )
  .join('');

const crowd = 1 / Math.max(1, spacing * spacing);
export const watchNames = shapes.flatMap((shape) => {
  if (!shape.spots.length) return [];
  const width = italicWidth(shape.name);
  const height = 19;
  const line = shape.outline.map(([x1, y1, x2, y2]) => toScreen((x1 + x2) / 2, (y1 + y2) / 2));
  const offLine = (b: Box) => !line.some(([lx, ly]) => lx > b.x && lx < b.x + b.w && ly > b.y && ly < b.y + b.h);
  const spots = shape.spots.map((spot) => {
    const [sx, sy] = toScreen(spot.x, spot.y);
    return { x: sx, y: sy, nx: spot.nx, ny: -spot.ny };
  });
  const box = placeName(
    spots,
    width,
    height,
    (b) => inside(b) && free(b) && clearOfRings(b) && offLine(b),
    papersUnder,
    Math.max(2, NAME_COVER * crowd * width * height),
  );
  if (!box) return [];
  placed.push(box);
  return [{ name: shape.name, x: px(box.x + box.w / 2), y: px(box.y + box.h / 2 + 0.5) }];
});

// ---- The new papers: ringed, and numbered where the number has room -----

export const ringRadius = px(Math.min(5.5, Math.max(3, spacing * 1.4)));
export const rings = arrivals.flatMap(({ n, x, y }) => {
  if (x === null || y === null) return [];
  const label = { x: x + 6, y: y - 16, w: numberWidth(String(n)), h: 14 };
  const numbered = free(label);
  if (numbered) placed.push(label);
  return [{ n, x, y, numbered }];
});

// ---- The words: the title block and the index ---------------------------

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ZONE });
const ZONED = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: ZONE });
const FULL = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: ZONE });
const DAY = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: ZONE });

/** An engine time: UTC, written with or without its zone. */
const instant = (iso: string) => new Date(/(?:Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);

/** "Tuesday, November 3, 2026 · 11:20 AM EST": the moment the plate shows. */
export const dateLine = `${FULL.format(recorded)} · ${ZONED.format(recorded)}`;

/** "today at 11:05 AM", said from the plate's own moment, as Today says it from now. */
export function when(iso: string | null | undefined): string {
  if (!iso) return 'at a time not recorded';
  const at = instant(iso);
  const day = DAY.format(at) === DAY.format(recorded) ? 'today' : FULL.format(at).replace(/, \d{4}$/, '');
  return `${day} at ${TIME.format(at)}`;
}

export const total = today.total;
export const heading = today.window === 'first_look' ? 'New this week' : `New since ${when(today.since).split(' at ')[0]}`;
export const since =
  today.window === 'first_look'
    ? 'in the last seven days'
    : `since it was marked read ${when(today.since)}`;
export const basis =
  map.basis === 'embeddings'
    ? 'placed by what an embedding model reads in them.'
    : 'placed by how much wording they share, worked out on the computer that holds them.';
export const skyCount = number(sky.count);
export const fromWatches = today.watches.filter((w) => w.new_count > 0).map((w) => ({ name: w.name, n: number(w.new_count) }));

export interface IndexEntry {
  n: number;
  id: number;
  title: string;
  authors: string;
  source: string;
  cell: string | null;
  lede: string | null;
  link: string | null;
}

export interface IndexGroup {
  name: string;
  total: string;
  run: string | null;
  trouble: { category: string; text: string }[];
  notes: { name: string; note: string }[];
  papers: IndexEntry[];
}

const entries = new Map(
  arrivals.map(({ paper, n, cell }) => [
    paper.id,
    {
      n,
      id: paper.id,
      title: paper.title,
      authors: authors(paper.authors),
      source: paper.source,
      cell,
      lede: paper.abstract_lede,
      link: paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : null),
    } satisfies IndexEntry,
  ]),
);

function runLine(watch: (typeof today.watches)[number]) {
  const run = watch.last_run;
  if (!run) return { run: 'Has not run yet.', trouble: [], notes: [] };
  const took = duration(run.started_at, run.ended_at);
  const state = run.status === 'completed' ? 'Ran' : `Run ${run.status},`;
  const tail = run.status === 'completed'
    ? ` · ${number(run.result_count)} found · ${run.sources_answered} of ${run.sources_total} sources answered`
    : '';
  return {
    run: `${state} ${when(run.started_at)}${took ? ` in ${took}` : ''}${tail}`,
    trouble: troubleParts(run.sources_not_answered).map(({ category, text }) => ({ category, text })),
    notes: run.sources_not_answered.map(({ name, note }) => ({ name, note })),
  };
}

/** By watch, as Today lists them: each watch's new papers, newest number last, and the quiet watches after. */
export const groups: IndexGroup[] = today.watches
  .filter((watch) => watch.new_count > 0)
  .map((watch) => ({
    name: watch.name,
    total: `${number(watch.new_count)} new`,
    ...runLine(watch),
    papers: [...entries.values()].filter((entry) =>
      today.papers.find((paper) => paper.id === entry.id)?.watches.includes(watch.id),
    ),
  }));
export const quiet = today.watches.filter((watch) => watch.new_count === 0).map((watch) => ({ name: watch.name, ...runLine(watch) }));

/** "Map of 1,712 papers in 24 regions; 18 new papers ringed and numbered." */
export const plateLabel =
  `Map of ${number(sky.count)} papers in ${count(regions.length, 'region')}` +
  `${arrivals.length ? `; ${count(arrivals.length, 'new paper')} ringed and numbered` : ''}.`;
export { listWords };
