/**
 * The name a person reads for a run's type. The database stores the engine's
 * identifier ("deep_dive", "automated_sweep"), and the run tables printed it as
 * is, beside page titles that say "Deep Dive" and "Routines". A type this list
 * does not know is shown as stored rather than guessed at.
 */
export function runTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case 'deep_dive':
    case 'dive':
      return 'Deep Dive';
    case 'deep_sweep':
    case 'sweep':
      return 'Deep Sweep';
    case 'automated_sweep':
    case 'automated_dive':
    case 'routine':
      return 'Routine';
    default:
      return type || '—';
  }
}

/**
 * Which of the three kinds a run belongs to, for filters and badge colors.
 *
 * Routine runs are stored as "automated_sweep", while the Results page's
 * Routine filter compared the stored type with "routine", so choosing it
 * showed no runs at all, however many routines had fired.
 */
export type RunTypeGroup = 'deep_dive' | 'deep_sweep' | 'routine' | 'other';

export function runTypeGroup(type: string | null | undefined): RunTypeGroup {
  switch (type) {
    case 'deep_dive':
    case 'dive':
      return 'deep_dive';
    case 'deep_sweep':
    case 'sweep':
      return 'deep_sweep';
    case 'automated_sweep':
    case 'automated_dive':
    case 'routine':
      return 'routine';
    default:
      return 'other';
  }
}

/** A run passes a type filter whose value is one of the groups above, or empty. */
export function matchesRunTypeFilter(type: string | null | undefined, filter: string): boolean {
  return !filter || runTypeGroup(type) === filter;
}
