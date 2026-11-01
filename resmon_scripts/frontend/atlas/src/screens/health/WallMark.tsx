import { markOf, pointRadius } from './model';

/**
 * The mark for one state, drawn rather than typed: a point (its area grows
 * with the count), a ring, a ring half filled, a struck circle, a dotted ring,
 * a dash, or nothing. `data-mark` names it, so a reader of the markup reads
 * the mark and not a color.
 */
export function WallMark({ state, count, largest = 0 }: { state: string; count?: number | null; largest?: number }) {
  const mark = markOf(state);
  return (
    <svg className="wall-mark" data-mark={mark} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {mark === 'point' && <circle cx="8" cy="8" r={pointRadius(count, largest)} fill="currentColor" />}
      {mark === 'ring' && <circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />}
      {mark === 'half' && (
        // The right half filled: the newer part of the window was read, newest first, and the older part was not.
        <>
          <circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />
        </>
      )}
      {mark === 'struck' && (
        <>
          <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4.5 11.5 11.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
      {mark === 'dotted' && <circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="1.7 1.8" strokeLinecap="round" />}
      {mark === 'dash' && <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
      {mark === 'unknown' && <rect x="4.5" y="4.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.3" />}
    </svg>
  );
}
