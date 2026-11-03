import { useEffect, useState } from 'react';

const MINUTE = 60_000;

/**
 * The time, read again at the top of each minute while the page that holds it
 * is shown. A page that says "today at 3:07 AM" or "Backed up yesterday" is
 * saying it against this clock; set once on arrival, it went on saying the
 * time it was opened. The timer is cleared when the page goes.
 */
export function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number | undefined;
    const wait = () => { timer = window.setTimeout(tick, MINUTE - (Date.now() % MINUTE)); };
    const tick = () => { setNow(new Date()); wait(); };
    wait();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}
