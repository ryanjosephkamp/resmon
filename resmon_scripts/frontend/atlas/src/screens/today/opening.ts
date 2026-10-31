import { useEffect, useMemo, useState } from 'react';

/** The pause before the first paper lights, while the plate settles. */
const SETTLE_MS = 420;

/** How long the lighting takes, first paper to last, however many papers there are. */
export const OPENING_MS = 1_600;

/** The longest pause between two papers lighting: a few papers light one at a time. */
const SLOWEST_MS = 90;

/** How long a number takes to brighten once its turn comes. */
export const FADE_MS = 300;

/**
 * Today's opening: once the plate and the papers are both in, the new papers
 * light in the order they arrived, their numbers in the index lighting with
 * them, within `OPENING_MS` whatever the count. A dozen light one at a time
 * with a pause between them; past that the pause shrinks to fit.
 *
 * The opening is a start time and a schedule, not a count that changes as it
 * goes: the plate draws each frame's lit papers from the clock, and each
 * number in the index brightens by an animation of its own, delayed to its
 * turn. Nothing on the page is changed again until a read or a person changes
 * it, so a thousand papers do not mean a thousand renders of the index.
 *
 * It runs once per visit, and always to the end. Today and the map are read
 * again while it runs (Today's cached answer is drawn and asked for again at
 * once), and a new answer neither stops nor restarts it: it only moves the
 * schedule of the papers still to light.
 */
export type Opening =
  | { state: 'waiting' }
  | { state: 'running'; start: number }
  | { state: 'none' };

/** No opening: every paper lit from the start, as without motion. */
export const NO_OPENING: Opening = { state: 'none' };
const WAITING: Opening = { state: 'waiting' };

/** The pause between one paper lighting and the next, for `total` papers. */
function spacing(total: number): number {
  return Math.min(SLOWEST_MS, OPENING_MS / Math.max(1, total));
}

/** When paper `n` (1 is the first to arrive) lights, in ms after the opening starts. */
export function lightsAt(n: number, total: number): number {
  return SETTLE_MS + (n - 1) * spacing(total);
}

/** How many of `total` papers are lit at `now` (a `performance.now()` time). */
export function litAt(opening: Opening, total: number, now: number): number {
  if (opening.state === 'none') return total;
  if (opening.state === 'waiting') return 0;
  const elapsed = now - opening.start;
  if (elapsed < SETTLE_MS) return 0;
  return Math.min(total, Math.floor((elapsed - SETTLE_MS) / spacing(total)) + 1);
}

/** When the next paper lights after `now`, or null once all are lit. */
export function nextLightAt(opening: Opening, total: number, now: number): number | null {
  if (opening.state !== 'running') return null;
  const lit = litAt(opening, total, now);
  return lit >= total ? null : opening.start + lightsAt(lit + 1, total);
}

/**
 * The opening for this visit: waiting until the plate and the papers are both
 * in, then running from that moment. Without motion there is none.
 */
export function useOpening(ready: boolean, still: boolean): Opening {
  const [start, setStart] = useState<number | null>(null);
  useEffect(() => {
    if (still || !ready || start !== null) return undefined;
    // Started from a timer rather than in the effect's own pass, so the render
    // that made the plate ready is painted first.
    const timer = window.setTimeout(() => setStart(performance.now()), 0);
    return () => window.clearTimeout(timer);
  }, [still, ready, start]);
  return useMemo(() => {
    if (still) return NO_OPENING;
    return start === null ? WAITING : { state: 'running', start };
  }, [still, start]);
}
