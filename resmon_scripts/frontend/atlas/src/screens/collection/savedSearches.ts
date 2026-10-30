/**
 * Saved searches: the engine's saved configurations, in Atlas's words.
 *
 * Three kinds share one table. `manual_dive` and `manual_sweep` are searches
 * saved from Ask the sources, with flat parameters. `routine` is the copy the
 * engine keeps of every watch, so a watch can travel in an export; its
 * parameters wrap the watch's own (`{linked_routine_id, schedule_cron,
 * parameters: {...}, is_active, ...}`).
 */
import type { components } from '../../api/schema';

export type SavedConfiguration = components['schemas']['SavedConfiguration'];

export const SAVED_KEY = ['configurations'] as const;

export function savedKind(type: string): string {
  switch (type) {
    case 'manual_dive': return 'Deep Dive';
    case 'manual_sweep': return 'Deep Sweep';
    case 'routine': return 'Watch';
    default: return type;
  }
}

export interface SavedAsks {
  sources: string[];
  keywords: string[];
  dateFrom: string;
  dateTo: string;
  /** "October 1 to October 28, 2026", or null when neither end is set. */
  window: string | null;
  cap: number | null;
  cron: string | null;
  watchId: number | null;
  /** Whether the run summarizes each paper with the lane in Settings → AI. */
  summarize: boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

const DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** A calendar date as stored (`2026-10-01`), in words, read as the date it names rather than an instant. */
function dayWords(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? day : DAY.format(at);
}

export function savedAsks(config: Pick<SavedConfiguration, 'config_type' | 'parameters'>): SavedAsks {
  const outer = record(config.parameters);
  const p = config.config_type === 'routine' ? record(outer.parameters) : outer;
  const sources = strings(p.repositories);
  if (!sources.length && typeof p.repository === 'string' && p.repository) sources.push(p.repository);
  const keywords = strings(p.keywords);
  if (!keywords.length && typeof p.query === 'string' && p.query) keywords.push(p.query);
  const dateFrom = typeof p.date_from === 'string' ? p.date_from : '';
  const dateTo = typeof p.date_to === 'string' ? p.date_to : '';
  // A watch's window that moves (`date_window`) has no dates stored; its runs compute them.
  const moving = record(p.date_window);
  const window = typeof moving.last_days === 'number' ? `the last ${moving.last_days} days before each run`
    : moving.since === 'previous_run' ? 'published since the previous run'
      : dateFrom && dateTo ? `${dayWords(dateFrom)} to ${dayWords(dateTo)}`
        : dateFrom ? `from ${dayWords(dateFrom)}` : dateTo ? `until ${dayWords(dateTo)}` : null;
  return {
    sources,
    keywords,
    dateFrom,
    dateTo,
    window,
    cap: typeof p.max_results === 'number' ? p.max_results : null,
    cron: typeof outer.schedule_cron === 'string' ? outer.schedule_cron : null,
    watchId: typeof outer.linked_routine_id === 'number' ? outer.linked_routine_id : null,
    summarize: p.ai_enabled === true,
  };
}

/**
 * What Save this search stores: the same flat parameters the classic Deep
 * Dive and Deep Sweep pages store, so a search saved in either interface
 * opens in the other.
 */
export function savedParameters(form: {
  mode: 'dive' | 'sweep';
  sources: string[];
  keywords: string[];
  dateFrom: string;
  dateTo: string;
  cap: number;
  summarize?: boolean;
}): { config_type: 'manual_dive' | 'manual_sweep'; parameters: Record<string, unknown> } {
  const common = {
    date_from: form.dateFrom,
    date_to: form.dateTo,
    keywords: form.keywords,
    max_results: form.cap,
    ai_enabled: form.summarize ?? false,
  };
  return form.mode === 'dive'
    ? { config_type: 'manual_dive', parameters: { repository: form.sources[0] ?? '', ...common } }
    : { config_type: 'manual_sweep', parameters: { repositories: form.sources, ...common } };
}
