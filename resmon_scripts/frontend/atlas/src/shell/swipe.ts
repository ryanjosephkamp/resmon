/**
 * Two-finger swipe, back and forward: the decision, fed one wheel sample at a
 * time, with nothing of the page in it, so it can be tested sample by sample.
 *
 * A trackpad's horizontal swipe reaches a page as wheel events: a run of them
 * while the fingers move, then a momentum tail that decays after they lift.
 * Chromium turns that into history navigation in a browser and not in
 * Electron, so the shell does it here, as Safari and Chrome do it: the swipe
 * is the page's only when it is mostly sideways and nothing under the pointer
 * would scroll that way itself, an arrow at the window's edge grows as it
 * travels, and past the threshold it goes back (fingers moving right, so the
 * page scrolls toward its start) or forward. One swipe moves one page: after
 * it goes, the rest of the gesture, its tail included, is spent, and only a
 * pause starts another.
 */

export type Direction = 'back' | 'forward';

export const SWIPE = {
  /** Sideways travel, in CSS pixels, at which a swipe goes. */
  threshold: 150,
  /** A pause this long between samples ends a gesture, and with it any momentum tail. */
  quietMs: 220,
  /** Travel before the swipe is judged sideways or not. */
  judgeAfter: 12,
  /** How much more sideways than up or down a swipe must be to be one. */
  sideways: 1.6,
} as const;

/** One wheel event, as the shell reads it. */
export interface Sample {
  dx: number;
  dy: number;
  /** Milliseconds, from the event's own clock. */
  t: number;
  /** Ctrl is held: a pinch to zoom, or a zoom on the wheel. */
  ctrl?: boolean;
  /** The deltas are lines or pages, not pixels: a mouse's wheel, not a trackpad. */
  coarse?: boolean;
}

/** What the page says about one direction when a swipe is being judged. */
export interface Page {
  /** There is history to go to that way. */
  canGo: (direction: Direction) => boolean;
  /** Something under the pointer takes the swipe itself: it scrolls that way, pans, or is a text field. */
  claimed: (direction: Direction) => boolean;
}

export interface Gesture {
  /**
   * `judging`: too little travel yet to say. `tracking`: a sideways swipe the
   * shell follows. `ignored`: not the shell's (mostly up or down, zooming, a
   * mouse, or claimed by what is under the pointer). `spent`: it has gone, and
   * the rest of it is the tail.
   */
  phase: 'judging' | 'tracking' | 'ignored' | 'spent';
  dx: number;
  dy: number;
  last: number;
}

export interface Step {
  gesture: Gesture;
  /** Navigate now, this way. */
  go: Direction | null;
  /** Which edge the arrow is at, and how far toward going it is, 0 to 1. */
  toward: Direction | null;
  progress: number;
}

const settle = (gesture: Gesture, go: Direction | null = null, toward: Direction | null = null, progress = 0): Step =>
  ({ gesture, go, toward, progress });

/** The next state after one sample. `gesture` is the last step's, or null before the first. */
export function feed(previous: Gesture | null, sample: Sample, page: Page): Step {
  const fresh = !previous || sample.t - previous.last > SWIPE.quietMs;
  const gesture: Gesture = fresh
    ? { phase: 'judging', dx: 0, dy: 0, last: sample.t }
    : { ...previous, last: sample.t };
  if (gesture.phase === 'ignored' || gesture.phase === 'spent') return settle(gesture);
  if (sample.ctrl || sample.coarse) return settle({ ...gesture, phase: 'ignored' });

  gesture.dx += sample.dx;
  gesture.dy += sample.dy;
  if (gesture.phase === 'judging') {
    if (Math.abs(gesture.dx) + Math.abs(gesture.dy) < SWIPE.judgeAfter) return settle(gesture);
    const direction: Direction = gesture.dx < 0 ? 'back' : 'forward';
    if (Math.abs(gesture.dx) < Math.abs(gesture.dy) * SWIPE.sideways || page.claimed(direction)) {
      return settle({ ...gesture, phase: 'ignored' });
    }
    gesture.phase = 'tracking';
  }

  const toward: Direction = gesture.dx < 0 ? 'back' : 'forward';
  if (!page.canGo(toward)) return settle(gesture);
  const travel = Math.abs(gesture.dx);
  if (travel >= SWIPE.threshold) return settle({ ...gesture, phase: 'spent' }, toward, toward, 1);
  return settle(gesture, null, toward, travel / SWIPE.threshold);
}
