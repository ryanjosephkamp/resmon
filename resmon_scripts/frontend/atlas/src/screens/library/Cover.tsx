import { memo, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import type { MapRegion, Sky } from '../today/model';
import { cropFor, VIEW } from './coverChart';
import { firstLines } from './galleryModel';
import { LIBRARY, type Version } from './libraryApi';
import { firstPage } from './thumbnails';

/** How far a cover is from the middle of the window, for the drawing queue's order: nearest first. */
function distance(node: HTMLElement | null): number {
  if (!node || !node.isConnected) return Number.MAX_SAFE_INTEGER;
  const box = node.getBoundingClientRect();
  return Math.abs(box.top + box.height / 2 - window.innerHeight / 2);
}

/**
 * A PDF's first page, on white as the reader draws it, in both themes. The
 * picture is the one the engine keeps for this exact version, or drawn now and
 * kept for next time; until it arrives the sheet is blank paper.
 */
export const PdfCover = memo(function PdfCover({ version, label }: { version: Version; label: string }) {
  const sheet = useRef<HTMLDivElement>(null);
  const picture = useQuery({
    queryKey: ['library-picture', version.vault_id, version.file_id, version.version_id],
    queryFn: ({ signal }) => firstPage(version, () => distance(sheet.current), signal),
    staleTime: Infinity,
    gcTime: 15 * 60_000,
    retry: false,
  });
  return (
    <div ref={sheet} className="sheet-pdf" data-cover="pdf" data-drawn={picture.data ? 'true' : picture.isError ? 'failed' : 'false'}>
      {picture.data
        ? <img src={picture.data} alt="" draggable={false} decoding="async" />
        : picture.isError
          ? <p className="sheet-failed">The first page of {label} could not be drawn.</p>
          : null}
    </div>
  );
});

/** A text file's first lines, literal, with their numbers, as the reader shows them. */
export const TextCover = memo(function TextCover({ version }: { version: Version }) {
  const text = useQuery({
    queryKey: ['library-text', version.vault_id, version.file_id, version.version_id],
    queryFn: () => answer(engine().GET('/api/library/files/{file_id}/text', {
      ...LIBRARY,
      params: { path: { file_id: version.file_id }, query: { expected_vault_id: version.vault_id, expected_version_id: version.version_id } },
    })),
    staleTime: Infinity,
    retry: false,
  });
  const lines = text.data ? firstLines(text.data.text) : [];
  return (
    <div className="sheet-text" data-cover="text">
      {text.isError
        ? <p className="sheet-failed">The text could not be read.</p>
        : <ol aria-hidden="true">{lines.map((line, i) => <li key={i} className={/^\s*(#|\\(section|chapter|title))/.test(line) ? 'h' : undefined}>{line || ' '}</li>)}</ol>}
    </div>
  );
});

export interface Atlas { sky: Sky; regions: readonly MapRegion[] }

/**
 * A paper with no PDF: its piece of the night chart over a title block. The
 * crop is the collection map's own, the paper crossed in the accent where it
 * sits. A paper the map has not placed says so in place of a star; while the
 * map is still being read the title block stands alone.
 */
export const AtlasCover = memo(function AtlasCover({ atlas, documentId, title, who, venue, year }: {
  atlas: Atlas | null; documentId: number; title: string; who: string; venue: string; year: string | null;
}) {
  const crop = useMemo(() => (atlas ? cropFor(atlas.sky, atlas.regions, documentId) : null), [atlas, documentId]);
  const { left: L, top: T, inner: W, innerHeight: H, width: VW, height: VH } = VIEW;
  const id = `cov-${documentId}`;
  return (
    <div className="cov" data-cover="atlas" data-placed={crop ? 'true' : atlas ? 'false' : 'unknown'}>
      {atlas && (
        <svg className="cov-chart" viewBox={`0 0 ${VW} ${VH}`} aria-hidden="true">
          <defs>
            <clipPath id={`${id}-c`}><rect x={L} y={T} width={W} height={H} /></clipPath>
            <radialGradient id={`${id}-g`}><stop offset="0" className="cov-glow-in" /><stop offset="1" className="cov-glow-out" /></radialGradient>
          </defs>
          <rect className="outer" x={L - 3} y={T - 3} width={W + 6} height={H + 6} />
          {crop ? (
            <>
              <g clipPath={`url(#${id}-c)`}>
                {crop.glows.map((g, i) => <circle key={i} cx={g.x} cy={g.y} r={g.r} fill={`url(#${id}-g)`} />)}
                {crop.grid.x.map((x) => <line key={`x${x}`} className="grid" x1={x} y1={T} x2={x} y2={T + H} />)}
                {crop.grid.y.map((y) => <line key={`y${y}`} className="grid" x1={L} y1={y} x2={L + W} y2={y} />)}
                {crop.stars.map((s, i) => <path key={i} className="st" d={s.d} opacity={s.opacity} />)}
                {crop.label && <text className="rg" x={crop.label.x} y={crop.label.y}>{crop.label.text}</text>}
                <circle className="ring" cx={crop.at.x} cy={crop.at.y} r={5.4} />
                <circle className="core" cx={crop.at.x} cy={crop.at.y} r={1.7} />
                {[[0, -1], [0, 1], [-1, 0], [1, 0]].map(([a, b]) => (
                  <line key={`${a}${b}`} className="cross" x1={crop.at.x + a! * 7.6} y1={crop.at.y + b! * 7.6} x2={crop.at.x + a! * 11} y2={crop.at.y + b! * 11} />
                ))}
              </g>
              <rect className="neat" x={L} y={T} width={W} height={H} />
              {crop.columns.map((c) => <text key={c.text} className={c.here ? 'mg here' : 'mg'} x={c.x} y={T / 2 + 0.5}>{c.text}</text>)}
              {crop.rows.map((r) => <text key={r.text} className={r.here ? 'mg here' : 'mg'} x={L / 2 + 0.5} y={r.y}>{r.text}</text>)}
            </>
          ) : (
            <>
              <rect className="neat" x={L} y={T} width={W} height={H} />
              <text className="none" x={L + W / 2} y={T + H / 2 - 2}>Not on the map yet</text>
              <text className="none2" x={L + W / 2} y={T + H / 2 + 11}>placed when the map is next drawn</text>
            </>
          )}
        </svg>
      )}
      <div className="cov-block">
        <p className={title.length > 70 ? 'cov-title long' : 'cov-title'}>{title}</p>
        <p className="cov-who">{who}</p>
        <p className="cov-where"><span>{venue}</span><span>{crop ? `${crop.cell} · ` : ''}{year ?? ''}</span></p>
      </div>
    </div>
  );
});

/** Where one, two or three leaves lie in the fan: one alone sits in the middle. */
const FAN: Record<number, string[]> = { 1: ['l1'], 2: ['l0', 'l2'], 3: ['l0', 'l1', 'l2'] };

/** An Evidence project: its first PDFs fanned on the plate, over its title block. */
export const ProjectCover = memo(function ProjectCover({ name, counts, changed, leaves }: {
  name: string; counts: string[]; changed: string | null; leaves: Version[];
}) {
  return (
    <div className="cov" data-cover="project">
      <div className="fan" aria-hidden="true">
        {leaves.slice(0, 3).map((leaf, i, shown) => (
          <div key={leaf.version_id} className={`leaf ${FAN[shown.length]![i]}`}><PdfCover version={leaf} label={name} /></div>
        ))}
        {!leaves.length && <div className="leaf l1 leaf-empty" />}
      </div>
      <div className="cov-block proj">
        <p className="cov-title">{name}</p>
        <p className="cov-who">{counts.join(' · ')}</p>
        <p className="cov-where"><span>Evidence project</span><span>{changed ?? ''}</span></p>
      </div>
    </div>
  );
});
