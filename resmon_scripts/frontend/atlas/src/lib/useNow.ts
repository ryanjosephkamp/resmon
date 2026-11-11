import { useEffect, useState } from 'react';

/**
 * The time in milliseconds, read again every `every` milliseconds while
 * `enabled`: a running run's clock ticks with it, and stops when the run does.
 * The timer is cleared when the page goes or `enabled` turns false.
 */
export function useNow(every: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every, enabled]);
  return now;
}
