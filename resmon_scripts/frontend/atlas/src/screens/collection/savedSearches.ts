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
  const window = dateFrom && dateTo ? `${dayWords(dateFrom)} to ${dayWords(dateTo)}`
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

/** What the editor on Saved holds for one saved search. */
export interface SavedForm {
  name: string;
  sources: string[];
  keywords: string[];
  dateFrom: string;
  dateTo: string;
  cap: number;
}

/** A saved search as the editor opens it: what the engine stores, with a cap of 100 where none is stored. */
export function savedForm(config: Pick<SavedConfiguration, 'name' | 'config_type' | 'parameters'>): SavedForm {
  const asks = savedAsks(config);
  return {
    name: config.name,
    sources: config.config_type === 'manual_dive' ? asks.sources.slice(0, 1) : asks.sources,
    keywords: asks.keywords,
    dateFrom: asks.dateFrom,
    dateTo: asks.dateTo,
    cap: asks.cap ?? 100,
  };
}

/** Why the editor cannot save, in a sentence, or null when it can. */
export function savedFormProblem(type: string, form: SavedForm): string | null {
  if (!form.name.trim()) return 'Give it a name.';
  if (!form.keywords.length) return 'Add at least one term.';
  if (!form.sources.length) return type === 'manual_dive' ? 'Choose a source.' : 'Choose one or more sources.';
  if (form.dateFrom && form.dateTo && form.dateFrom > form.dateTo) return 'The From date is after the To date.';
  return null;
}

/**
 * What a changed saved search stores. `PUT /api/configurations/{id}` replaces
 * the whole parameters object, so the editor's fields are written over what
 * is stored rather than in place of it: whether it summarizes, and anything
 * the classic interface stored beside it (a lane of its own, a query), is
 * kept as it was. A query kept beside the terms is rewritten from them, so
 * the two cannot disagree.
 */
export function editedParameters(
  config: Pick<SavedConfiguration, 'config_type' | 'parameters'>,
  form: SavedForm,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...record(config.parameters) };
  if (config.config_type === 'manual_dive') {
    next.repository = form.sources[0] ?? '';
    delete next.repositories;
  } else {
    next.repositories = [...form.sources];
    delete next.repository;
  }
  next.keywords = [...form.keywords];
  if ('query' in next) next.query = form.keywords.join(' ');
  next.date_from = form.dateFrom;
  next.date_to = form.dateTo;
  next.max_results = form.cap;
  return next;
}

/**
 * A Deep Dive's or a Deep Sweep's run as a saved search: the sources, terms,
 * dates, and cap its run record holds (`executions.parameters`, stored as
 * text), and whether it summarized. Null for a watch's run, whose search is
 * the watch's own.
 */
export function savedFromRun(
  run: { execution_type: string; parameters?: string | null },
  summarize: boolean,
): { config_type: 'manual_dive' | 'manual_sweep'; parameters: Record<string, unknown> } | null {
  const mode = run.execution_type === 'deep_dive' ? 'dive' : run.execution_type === 'deep_sweep' ? 'sweep' : null;
  if (!mode) return null;
  const p = record(run.parameters);
  const sources = strings(p.repositories);
  if (!sources.length && typeof p.repository === 'string' && p.repository) sources.push(p.repository);
  const keywords = strings(p.keywords);
  if (!keywords.length && typeof p.query === 'string' && p.query.trim()) keywords.push(p.query.trim());
  return savedParameters({
    mode,
    sources,
    keywords,
    dateFrom: typeof p.date_from === 'string' ? p.date_from : '',
    dateTo: typeof p.date_to === 'string' ? p.date_to : '',
    cap: typeof p.max_results === 'number' ? p.max_results : 100,
    summarize,
  });
}
