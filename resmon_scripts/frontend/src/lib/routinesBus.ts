import { useEffect, useState } from 'react';

/**
 * In-renderer invalidation bus for the ``/api/routines`` resource.
 *
 * Mirrors ``configurationsBus`` so any mutation site (the create/edit
 * modal, activate/deactivate toggles, deletes) can broadcast a single
 * ``notifyRoutinesChanged()`` call and every mounted page that lists
 * routines (Routines, Calendar) will refetch — without each page
 * needing to know about the others.
 */

let version = 0;
const listeners = new Set<(v: number) => void>();

export function notifyRoutinesChanged(): void {
  version += 1;
  for (const listener of listeners) {
    listener(version);
  }
}

export function useRoutinesVersion(): number {
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
