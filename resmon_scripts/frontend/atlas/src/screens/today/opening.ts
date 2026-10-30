import { useEffect, useRef, useState } from 'react';

/** The pause before the first paper lights, while the plate settles. */
const SETTLE_MS = 420;

/**
 * Today's opening: once the plate and the papers are both in, the new papers
 * light one by one in the order they arrived, their numbers in the index
 * lighting with them. Returns how many are lit: all of them without motion,
 * and all of them once the opening is over, including papers a later read
 * adds.
 *
 * It runs once per visit, and always to the end. Today and the map are read
 * again while it runs: on arriving, Today's cached answer is drawn and asked
 * for again at once, and a first look's seven-day window moves with the
 * clock, so the answer that comes back is a new object. The opening used to
 * stop its timer on every new answer and, marked as started, never start
 * it again, which left every number in the index and every ring on the plate at
 * the dim the opening starts from.
 */
export function useOpening(total: number, ready: boolean, still: boolean): number {
  const [lit, setLit] = useState(0);
  const [done, setDone] = useState(false);
  // The newest total, for a tick that runs after a later read changed it.
  const count = useRef(total);
  useEffect(() => { count.current = total; });
  const finished = useRef(false);

  // Runs again only when the plate stops or starts being ready (or under
  // StrictMode's rehearsal of an unmount), and then starts over; never
  // because Today or the map was read again, which is not in its dependencies.
  useEffect(() => {
    if (still || !ready || finished.current) return undefined;
    const step = Math.max(16, Math.min(90, 1_600 / Math.max(1, count.current)));
    let shown = 0;
    let timer = 0;
    const tick = () => {
      const all = count.current;
      shown = Math.min(all, shown + Math.max(1, Math.round(16 / step)));
      setLit(shown);
      if (shown < all) {
        timer = window.setTimeout(tick, step);
      } else {
        finished.current = true;
        setDone(true);
      }
    };
    timer = window.setTimeout(tick, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [still, ready]);

  return still || done ? total : lit;
}
