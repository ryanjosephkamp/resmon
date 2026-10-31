import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { answer, engine } from '../../api/client';
import { useAppearance } from '../../theme/appearance';
import { MAP_KEY, Tip } from '../Today';
import { epochDay, gridCell, watchShape, type Sky } from '../today/model';
import { Plate, type PlateHandle, type PlateHover, type PlateLook } from '../today/Plate';
import { collectionSky } from './collectionSky';
import { useReadAfter } from './readAfter';

/** Up to this many marked papers are ringed; more are lit in the accent without rings. */
const RING_LIMIT = 80;
/** The fewest marked papers an outline goes around. */
const OUTLINE_MIN = 5;

/** What the sky could establish about the papers it was asked to mark. */
export interface SkyFacts {
  /** How many of the marked papers the map has placed; `null` until the map is read. */
  placed: number | null;
  total: number;
  /** The map is fitted and has points. */
  ready: boolean;
  /** How the map placed papers: by their embeddings or by shared wording. */
  basis: 'embeddings' | 'words' | null;
}

/** A paper chosen on the map, and where it sits there: its grid cell and its region's name. */
export interface SkyChoice { id: number; cell: string | null; region: string | null }

export interface PaperSkyHandle {
  /** Fly to a paper on the map, as "show it on the map" does. */
  show: (id: number) => void;
  /** Give the map the keyboard, as a way back from beside it lands. */
  focus: () => void;
}

interface Props {
  /** The papers to mark among the whole collection. */
  marked: readonly number[];
  /** One paper at the center of attention, crossed in the accent (a paper's own page). */
  focus?: number | null;
  /** The accessible name of the figure. */
  label: string;
  caption: (facts: SkyFacts) => string;
  /** Square by default; `tall` fills the height it is given. */
  shape?: 'square' | 'tall';
  /**
   * Of the marked papers, the ones to ring however many there are (a watch's
   * latest night); the rest of the marked are lit in the accent.
   */
  bright?: readonly number[];
  /**
   * Draw the marked papers' outline, as Today draws a watch's: where their
   * density falls to a fifth of its peak, named with `outline`.
   */
  outline?: string | null;
  /**
   * An engine timestamp the map must have been read after, such as a run's end:
   * a map read earlier was read without the papers that arrived since, so it
   * is read again, and until then counts as not ready rather than as a map
   * that could not place them.
   */
  readAfter?: string | null;
  /** The paper open beside the map, crossed on it, or none. */
  chosen?: number | null;
  /**
   * Open a paper beside the map (or close the one open, with null). Without
   * it, a click opens the paper's own page, and from the keyboard Enter does.
   */
  onChoose?: (choice: SkyChoice | null) => void;
  /** `zoom` where the map is the page's own height; `page` where the page around it scrolls. */
  wheel?: 'zoom' | 'page';
  /** What a source's slug is called, for the hover. */
  sourceName?: (slug: string) => string;
}

/** Light the marked papers in the accent, dim the rest, and ring the few or the bright ones. */
export function markLook(sky: Sky, marked: readonly number[], bright?: readonly number[]): { look: PlateLook | null; placed: number } {
  const at = new Set<number>();
  for (const id of marked) {
    const i = sky.indexOf.get(id);
    if (i !== undefined) at.add(i);
  }
  if (marked.length === 0) return { look: null, placed: 0 };
  const lit = new Uint8Array(sky.count);
  for (const i of at) lit[i] = 1;
  const ringed: number[] = [];
  if (bright) {
    for (const id of bright) {
      const i = sky.indexOf.get(id);
      if (i !== undefined) ringed.push(i);
    }
  } else if (at.size <= RING_LIMIT) ringed.push(...at);
  return {
    look: { lit, group: new Uint8Array(sky.count), colors: ['var(--accent-mark)'], found: Int32Array.from(ringed) },
    placed: at.size,
  };
}

/**
 * Where some papers sit in the whole collection, on the same plate as Today's:
 * the marked papers lit in the accent, the rest dimmed rather than removed, so
 * the collection keeps its shape. Hover names a paper; a click opens it beside
 * the map where the page has room (`onChoose`), or its own page where it has
 * not; it zooms and pans as Today's does.
 *
 * One map rather than a picture beside a plate: every page that shows where
 * papers sit can then be explored the same way, and the whole collection is
 * built into a sky once for all of them (`collectionSky`).
 *
 * A paper the map has not placed (too little text to place, or not yet read
 * by the embedding model the map was drawn with) is not drawn, so the caption
 * is told how many of the marked papers were placed and can say so rather
 * than imply the whole set.
 */
export const PaperSky = forwardRef<PaperSkyHandle, Props>(function PaperSky(props, ref) {
  const {
    marked, focus = null, label, caption, shape = 'square', bright, outline = null, readAfter = null,
    chosen = null, onChoose, wheel = 'page', sourceName = (slug: string) => slug,
  } = props;
  const navigate = useNavigate();
  const { shown, theme } = useAppearance();
  const map = useQuery({ queryKey: MAP_KEY, queryFn: () => answer(engine().GET('/api/map')) });
  const current = useReadAfter(map, readAfter);
  const [now] = useState(() => new Date());
  const ready = current && map.data?.state === 'ready' && map.data.points.id.length > 0 ? map.data : null;
  const built = useMemo(() => (ready ? collectionSky(ready, epochDay(now)) : null), [ready, now]);
  const sky = built?.sky ?? null;
  const marks = useMemo(() => (sky ? markLook(sky, marked, bright) : null), [sky, marked, bright]);
  const shapes = useMemo(() => {
    if (!sky || !ready || outline === null || (marks?.placed ?? 0) < OUTLINE_MIN) return [];
    return [watchShape(sky, ready.regions, { id: -1, name: outline, members: [...marked] })];
  }, [sky, ready, outline, marks, marked]);
  const regionNames = useMemo(() => new Map((ready?.regions ?? []).map((r) => [r.id, r.label])), [ready]);

  const plate = useRef<PlateHandle>(null);
  // A paper chosen from the keyboard on a page that opens papers on their own page: crossed until Enter opens it.
  const [pick, setPick] = useState<number | null>(null);
  const [hover, setHover] = useState<PlateHover | null>(null);
  const hovered = hover && sky ? sky.ids[hover.index] ?? null : null;
  const brief = useQuery({
    queryKey: ['brief', hovered],
    enabled: hovered !== null,
    staleTime: Infinity,
    queryFn: async () => (await answer(engine().POST('/api/documents/briefs', { body: { ids: [hovered ?? 0] } })))[0] ?? null,
  });

  const choiceAt = (i: number): SkyChoice | null => {
    if (!sky) return null;
    const id = sky.ids[i];
    if (id === undefined) return null;
    return {
      id, cell: gridCell(sky.x[i] ?? 0, sky.y[i] ?? 0, sky.bounds),
      region: regionNames.get(sky.region[i] ?? -1) || null,
    };
  };
  const open = (i: number) => {
    const id = sky?.ids[i];
    if (id !== undefined && id !== focus) navigate(`/papers/${id}`);
  };
  const onSelect = (index: number | null, via: 'pointer' | 'keyboard') => {
    if (onChoose) {
      onChoose(index === null ? null : choiceAt(index));
      return;
    }
    if (index === null) { setPick(null); return; }
    if (via === 'pointer') open(index);
    else setPick(sky?.ids[index] ?? null);
  };

  useImperativeHandle(ref, () => ({
    show: (id) => {
      const i = sky?.indexOf.get(id);
      if (sky && i !== undefined) plate.current?.flyTo({ x: sky.x[i] ?? 0, y: sky.y[i] ?? 0, r: sky.bounds.size * 0.12 });
    },
    focus: () => plate.current?.focus(),
  }), [sky]);

  const crossed = onChoose ? chosen : pick ?? focus;
  const selected = crossed !== null && sky ? sky.indexOf.get(crossed) ?? null : null;
  const facts: SkyFacts = {
    placed: marks?.placed ?? null,
    total: marked.length + (focus !== null && !marked.includes(focus) ? 1 : 0),
    ready: !!ready,
    basis: map.data?.basis ?? null,
  };
  const said = caption(facts);
  return (
    <figure className={shape === 'tall' ? 'sky tall' : 'sky'} aria-label={label}>
      <div className={shape === 'tall' ? 'sky-plate tall' : 'sky-plate'}>
        {sky && built && ready ? (
          <Plate
            ref={plate}
            sky={sky}
            regions={ready.regions}
            shapes={shapes}
            field={built.field}
            arrivals={[]}
            selected={selected}
            pointed={null}
            onSelect={onSelect}
            onOpen={onChoose ? undefined : open}
            onHover={setHover}
            paletteKey={`${theme}:${shown.accent ?? ''}`}
            label={`${said} ${onChoose ? 'Choose a paper to open it beside the map.' : 'Choose a paper to open its page.'}`}
            onAway={() => undefined}
            toolsAt="left"
            look={marks?.look ?? null}
            wheel={wheel}
          >
            {hover && (
              <Tip hover={hover} brief={brief.data ?? undefined} now={now} sourceName={sourceName}
                cell={gridCell(sky.x[hover.index] ?? 0, sky.y[hover.index] ?? 0, sky.bounds)} />
            )}
          </Plate>
        ) : (
          <div className="sky-empty">
            {map.isPending || (map.data?.state === 'ready' && !current) ? 'Reading the map.'
              : map.data?.state === 'fitting' ? 'Drawing the map of your collection.'
                : 'The collection map has no papers placed yet.'}
          </div>
        )}
      </div>
      <figcaption>{said}</figcaption>
    </figure>
  );
});

/** "placed by shared wording" or "placed by meaning", for a caption. */
export function basisWords(basis: SkyFacts['basis']): string {
  if (basis === 'embeddings') return 'placed by meaning';
  if (basis === 'words') return 'placed by shared wording';
  return 'placed on the map';
}
