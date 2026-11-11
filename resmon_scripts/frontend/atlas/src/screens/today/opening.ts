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
 * It plays once for each answer from the engine this window has not opened
 * before, keyed by the answer's newest arrival (`answerKey`), and always to
 * the end. The first visit after launch plays it; coming back to Today with
 * the same answer draws it at rest at once; an answer with a newer arrival
 * plays it again, on the visit that draws it. A new answer while it runs
 * neither stops nor restarts it: it only moves the schedule of the papers
 * still to light. The answers opened are held in this window's memory, so a
 * relaunch plays it again.
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

/** The answers this window has opened, by `answerKey`. */
const opened = new Set<string>();

/**
 * What makes Today's answer new: its newest arrival, by id and the moment it
 * was first seen. Two reads of the same papers are the same answer however
 * they were asked for; an answer with nothing new has nothing to light.
 */
export function answerKey(newest: { id: number; first_seen_at?: string | null } | undefined): string {
  return newest ? `${newest.id}@${newest.first_seen_at ?? ''}` : 'none';
}

/**
 * The opening for this visit. `answer` is the answer's key once the plate and
 * the papers are both in, and null until then: an answer this window has not
 * opened waits for them and then runs from that moment; one it has opened is
 * drawn at rest. Without motion there is none.
 */
export function useOpening(answer: string | null, still: boolean): Opening {
  const [start, setStart] = useState<number | null>(null);
  useEffect(() => {
    if (still || answer === null) return undefined;
    // A new answer while the opening runs joins it rather than starting it again.
    if (start !== null || opened.has(answer)) {
      opened.add(answer);
      return undefined;
    }
    // Started from a timer rather than in the effect's own pass, so the render
    // that made the plate ready is painted first.
    const timer = window.setTimeout(() => {
      opened.add(answer);
      setStart(performance.now());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [still, answer, start]);
  const atRest = answer !== null && start === null && opened.has(answer);
  return useMemo(() => {
    if (still || atRest) return NO_OPENING;
    return start === null ? WAITING : { state: 'running', start };
  }, [still, atRest, start]);
}

/** For tests: forget the answers opened. */
export function forgetOpenings(): void {
  opened.clear();
}
