import { useEffect, useState } from 'react';

/**
 * Tiny in-renderer invalidation bus for the ``/api/configurations`` resource.
 *
 * ``ConfigLoader`` instances subscribe via ``useConfigurationsVersion()`` so
 * that any mutation site (delete on the Configurations page, save on the
 * Deep Dive / Deep Sweep / Routines pages, import) can broadcast a single
 * ``notifyConfigurationsChanged()`` call and every mounted loader will
 * refetch — without each page needing to know about the others.
 */

let version = 0;
const listeners = new Set<(v: number) => void>();

export function notifyConfigurationsChanged(): void {
  version += 1;
  for (const listener of listeners) {
    listener(version);
  }
}

export function useConfigurationsVersion(): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    const listener = (next: number) => setV(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return v;
}
