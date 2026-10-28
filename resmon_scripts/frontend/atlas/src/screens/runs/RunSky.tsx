import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { answer, engine } from '../../api/client';
import { useAppearance } from '../../theme/appearance';
import { MAP_KEY } from '../Today';
import { count } from '../today/format';

/** Up to this many of a run's papers are ringed; more are drawn as accent points. */
const RING_LIMIT = 80;

/**
 * Where a run's papers sit in the whole collection: every placed paper as a
 * faint point, this run's ringed. The same positions as Today's plate, read
 * from `/api/map`, at a size that fits beside the run's sources. Not
 * interactive: a paper opens from the Papers tab, and the full plate is Today.
 *
 * It says how many of the run's papers are on the map, because a paper the
 * map has not placed yet (it arrived after the last fit, or has too little
 * text) is not drawn, and a ring count that silently fell short would read as
 * the run's whole result.
 */
export function RunSky({ paperIds }: { paperIds: readonly number[] }) {
  const { shown, theme } = useAppearance();
  const map = useQuery({ queryKey: MAP_KEY, queryFn: () => answer(engine().GET('/api/map')) });
  const canvas = useRef<HTMLCanvasElement>(null);
  const wanted = useMemo(() => new Set(paperIds), [paperIds]);

  const placed = useMemo(() => {
    const points = map.data?.points;
    if (!points) return null;
    let ringed = 0;
    for (const id of points.id) if (wanted.has(id)) ringed += 1;
    return ringed;
  }, [map.data, wanted]);

  useEffect(() => {
    const el = canvas.current;
    const points = map.data?.points;
    if (!el || !points || !points.id.length) return undefined;
    const draw = () => {
      const box = el.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      el.width = Math.round(box.width * ratio);
      el.height = Math.round(box.height * ratio);
      const ctx = el.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const css = getComputedStyle(el);
      const ink = css.getPropertyValue('--ink-3').trim() || '#8f8b82';
      const mark = css.getPropertyValue('--accent-mark').trim() || '#ff8a3d';
      const grid = css.getPropertyValue('--grid').trim() || '#1a1a1b';
      ctx.clearRect(0, 0, box.width, box.height);

      // The collection's own bounds, padded, kept square so distances read true.
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      for (let i = 0; i < points.x.length; i += 1) {
        const x = points.x[i] ?? 0; const y = points.y[i] ?? 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const span = Math.max(maxX - minX, maxY - minY) || 1;
      const pad = 18;
      const size = Math.min(box.width, box.height) - pad * 2;
      const ox = (box.width - size) / 2; const oy = (box.height - size) / 2;
      const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2;
      const px = (x: number) => ox + ((x - cx) / span + 0.5) * size;
      const py = (y: number) => oy + ((y - cy) / span + 0.5) * size;

      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      for (let k = 0; k <= 4; k += 1) {
        const at = Math.round(ox + (k / 4) * size) + 0.5;
        ctx.beginPath(); ctx.moveTo(at, oy); ctx.lineTo(at, oy + size); ctx.stroke();
        const yAt = Math.round(oy + (k / 4) * size) + 0.5;
        ctx.beginPath(); ctx.moveTo(ox, yAt); ctx.lineTo(ox + size, yAt); ctx.stroke();
      }

      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.45;
      const rings: [number, number][] = [];
      for (let i = 0; i < points.id.length; i += 1) {
        const x = px(points.x[i] ?? 0); const y = py(points.y[i] ?? 0);
        if (wanted.has(points.id[i] ?? -1)) { rings.push([x, y]); continue; }
        ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
      }
      ctx.globalAlpha = 1;
      // A ring per paper reads while a run is a handful of points; past that
      // the rings overlap into a texture, so a large run is drawn as accent
      // points instead, which still separates it from the rest of the sky.
      if (rings.length <= RING_LIMIT) {
        ctx.strokeStyle = mark;
        ctx.fillStyle = css.getPropertyValue('--ink').trim() || '#f1eee6';
        ctx.lineWidth = 1.25;
        for (const [x, y] of rings) {
          ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.arc(x, y, 1.3, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        ctx.fillStyle = mark;
        for (const [x, y] of rings) {
          ctx.beginPath(); ctx.arc(x, y, 1.7, 0, Math.PI * 2); ctx.fill();
        }
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    return () => observer.disconnect();
  }, [map.data, wanted, shown, theme]);

  const total = paperIds.length;
  return (
    <figure className="run-sky" aria-label="Where this run's papers sit in the collection">
      {map.data && map.data.points.id.length > 0
        ? <canvas ref={canvas} className="run-sky-canvas" role="img" aria-label={`${placed ?? 0} of this run's papers ringed among ${map.data.points.id.length} placed papers`} />
        : <div className="run-sky-empty">{map.isPending ? 'Reading the map.' : 'The collection map has no papers placed yet.'}</div>}
      <figcaption>
        {total === 0
          ? 'This run stored no papers.'
          : placed === null || map.data?.state !== 'ready'
            ? `The collection map is not ready yet; this run's ${count(total, 'paper')} ${total === 1 ? 'is' : 'are'} drawn once it is.`
            : placed === total ? `All ${count(total, 'paper')} from this run, marked where they sit in the collection.`
              : `${placed.toLocaleString('en-US')} of ${count(total, 'paper')} from this run are on the map. `
                + 'The rest are not placed yet: they arrived after its last fit, or have too little text to place.'}
      </figcaption>
    </figure>
  );
}
