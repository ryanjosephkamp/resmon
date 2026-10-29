/**
 * A watch made or changed: its schedule as a choice in words and the cron
 * expression that choice stores, and its form read from, and written back
 * to, the routine the engine keeps.
 *
 * Every schedule offered is one whose words are exact. Hours step only by a
 * number that divides the day, so each run is the same span after the last,
 * and a monthly watch runs on day 1 to 28, which every month has. A stored
 * schedule the choices cannot state (every few minutes, a structured interval,
 * any other expression) is kept as it is unless another is chosen, and a save
 * sends back exactly what was stored for it.
 */
import { scheduleText, type Routine } from './model';

export type Cadence = 'hours' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'kept';

export interface ScheduleChoice {
  cadence: Cadence;
  /** Every how many hours, from `HOUR_STEPS`. */
  everyHours: number;
  hour: number;
  minute: number;
  /** Standard cron's day of the week: 0 is Sunday, 6 Saturday. */
  weekday: number;
  /** 1 to 28: a later day is missing from some months, and those months would not run. */
  monthDay: number;
}

export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export const CADENCES: readonly { cadence: Exclude<Cadence, 'kept'>; label: string }[] = [
  { cadence: 'daily', label: 'Every day' },
  { cadence: 'weekdays', label: 'Weekdays' },
  { cadence: 'weekly', label: 'Once a week' },
  { cadence: 'monthly', label: 'Once a month' },
  { cadence: 'hours', label: 'Every few hours' },
];

const DEFAULT_SCHEDULE: ScheduleChoice = {
  cadence: 'daily', everyHours: 6, hour: 8, minute: 0, weekday: 1, monthDay: 1,
};

/** The cron expression a choice stores, or null for a schedule kept as it is. */
export function cronFor(choice: ScheduleChoice): string | null {
  const { minute: m, hour: h } = choice;
  switch (choice.cadence) {
    case 'hours': return `${m} ${choice.everyHours === 1 ? '*' : `*/${choice.everyHours}`} * * *`;
    case 'daily': return `${m} ${h} * * *`;
    case 'weekdays': return `${m} ${h} * * 1-5`;
    case 'weekly': return `${m} ${h} * * ${choice.weekday}`;
    case 'monthly': return `${m} ${h} ${choice.monthDay} * *`;
    default: return null;
  }
}

function whole(field: string, lo: number, hi: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number(field);
  return n >= lo && n <= hi ? n : null;
}

function hasStructured(parameters: Record<string, unknown>): boolean {
  const s = parameters._schedule;
  return !!s && typeof s === 'object' && (s as Record<string, unknown>).type === 'interval';
}

/**
 * The choice a stored schedule is, or `kept` with the defaults beside it when
 * the choices cannot state it. A structured `_schedule` is the one that runs
 * (`scheduler._build_trigger` prefers it), so it is kept whatever the cron
 * string beside it says.
 */
export function choiceFrom(cron: string | null | undefined, parameters: Record<string, unknown>): ScheduleChoice {
  const kept = { ...DEFAULT_SCHEDULE, cadence: 'kept' as const };
  if (hasStructured(parameters) || !cron) return kept;
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return kept;
  const [min = '', hour = '', dom = '', mon = '', dow = ''] = f;
  const minute = whole(min, 0, 59);
  if (minute === null || mon !== '*') return kept;
  if (dom === '*' && dow === '*') {
    if (hour === '*') return { ...DEFAULT_SCHEDULE, cadence: 'hours', everyHours: 1, minute };
    const step = /^\*\/(\d+)$/.exec(hour);
    if (step) {
      const n = Number(step[1]);
      return (HOUR_STEPS as readonly number[]).includes(n) ? { ...DEFAULT_SCHEDULE, cadence: 'hours', everyHours: n, minute } : kept;
    }
  }
  const h = whole(hour, 0, 23);
  if (h === null) return kept;
  const at = { ...DEFAULT_SCHEDULE, hour: h, minute };
  if (dom === '*' && dow === '*') return { ...at, cadence: 'daily' };
  if (dom === '*' && dow === '1-5') return { ...at, cadence: 'weekdays' };
  if (dom === '*') {
    const d = whole(dow, 0, 7);
    return d === null ? kept : { ...at, cadence: 'weekly', weekday: d % 7 };
  }
  if (dow === '*') {
    const d = whole(dom, 1, 28);
    return d === null ? kept : { ...at, cadence: 'monthly', monthDay: d };
  }
  return kept;
}

/** "08:30", for a time field, from an hour and a minute. */
export function clockValue(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** An hour and a minute from a time field's "HH:MM", or null while it is incomplete. */
export function fromClock(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** What a watch follows: words, or a person, in one of the two ways the engine accepts. */
export type Follows = 'words' | 'new_papers' | 'retractions';

export interface WatchForm {
  name: string;
  follows: Follows;
  profileId: number | null;
  keywords: string[];
  sources: string[];
  schedule: ScheduleChoice;
  dateFrom: string;
  dateTo: string;
  cap: number;
  intent: string;
  notify: boolean;
  email: boolean;
  /** `email_ai_summary_enabled`: the email carries the run's results as an attachment. */
  attach: boolean;
  /** A new watch only: whether it starts watching when saved, or is saved paused. */
  start: boolean;
}

export function parametersOf(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function blankForm(): WatchForm {
  return {
    name: '', follows: 'words', profileId: null, keywords: [], sources: [],
    schedule: { ...DEFAULT_SCHEDULE }, dateFrom: '', dateTo: '', cap: 100, intent: '',
    notify: false, email: false, attach: false, start: true,
  };
}

/** A new watch begun from a search: what it asks, with everything else as a new watch has it. */
export interface WatchSeed {
  name?: string;
  sources?: readonly string[];
  keywords?: readonly string[];
  cap?: number | null;
  dateFrom?: string;
  dateTo?: string;
  /** A person to watch, from their page. */
  profileId?: number;
}

export function seededForm(seed: WatchSeed | null | undefined): WatchForm {
  const form = blankForm();
  if (!seed) return form;
  return {
    ...form,
    name: seed.name ?? '',
    sources: [...(seed.sources ?? [])],
    keywords: [...(seed.keywords ?? [])],
    cap: seed.cap ?? form.cap,
    dateFrom: seed.dateFrom ?? '',
    dateTo: seed.dateTo ?? '',
    ...(seed.profileId ? { follows: 'new_papers' as const, profileId: seed.profileId } : {}),
  };
}

/** A stored watch as the form shows it. */
export function formFrom(routine: Routine): WatchForm {
  const p = parametersOf(routine.parameters);
  const entity = p.entity && typeof p.entity === 'object' ? p.entity as Record<string, unknown> : null;
  const mode = entity?.mode;
  const sources = list(p.repositories);
  if (!sources.length && typeof p.repository === 'string') sources.push(p.repository);
  const cap = Number(p.max_results);
  return {
    name: routine.name,
    follows: mode === 'new_papers' || mode === 'retractions' ? mode : 'words',
    profileId: typeof entity?.profile_id === 'number' ? entity.profile_id : null,
    keywords: list(p.keywords),
    sources,
    schedule: choiceFrom(routine.schedule_cron, p),
    dateFrom: typeof p.date_from === 'string' ? p.date_from : '',
    dateTo: typeof p.date_to === 'string' ? p.date_to : '',
    cap: Number.isFinite(cap) && cap > 0 ? cap : 100,
    intent: routine.intent ?? '',
    notify: !!routine.notify_on_complete,
    email: !!routine.email_enabled,
    attach: !!routine.email_ai_summary_enabled,
    start: !!routine.is_active,
  };
}

export interface WatchBody {
  name: string;
  schedule_cron: string;
  parameters: Record<string, unknown>;
  intent: string;
  notify_on_complete: boolean;
  email_enabled: boolean;
  email_ai_summary_enabled: boolean;
  is_active?: boolean;
}

/**
 * The request body a form saves as.
 *
 * Starts from the parameters already stored, so a field this editor does not
 * show (a structured schedule kept as it is, or anything a newer build
 * writes) survives a save. The classic editor's shape, so a watch saved in
 * either interface opens in the other. `is_active` is sent only for a new
 * watch: pausing and resuming are the watch page's, and an edit that sent it
 * would resume a paused watch without a word. AI settings are not sent at
 * all, so a save here leaves them as they were.
 */
export function watchBody(form: WatchForm, existing: Routine | null): WatchBody {
  const parameters = existing ? parametersOf(existing.parameters) : {};
  const person = form.follows !== 'words';
  parameters.repositories = [...form.sources];
  // A watch on a person follows the person, and narrowing that by topic would
  // silently hide the rest of their work, so its keywords are cleared rather
  // than sent and ignored: what is stored is what runs.
  parameters.keywords = person ? [] : [...form.keywords];
  parameters.query = person ? '' : form.keywords.join(' ');
  parameters.date_from = form.dateFrom;
  parameters.date_to = form.dateTo;
  parameters.max_results = form.cap;
  if (person) parameters.entity = { profile_id: form.profileId, mode: form.follows };
  else delete parameters.entity;
  delete parameters.repository;

  let cron = cronFor(form.schedule);
  if (cron === null) cron = existing?.schedule_cron ?? '';
  else delete parameters._schedule;

  const body: WatchBody = {
    name: form.name.trim(),
    schedule_cron: cron,
    parameters,
    // Sent blank too: a cleared box is a clear, and the engine stores it as NULL.
    intent: form.intent.trim(),
    notify_on_complete: form.notify,
    email_enabled: form.email,
    // The attachment goes with the email; without one there is nothing to attach it to.
    email_ai_summary_enabled: form.email && form.attach,
  };
  if (!existing) body.is_active = form.start;
  return body;
}

/** What stops a form saving, in the order the form asks it. Empty when it can be saved. */
export function whatIsMissing(form: WatchForm, knownSources: number): string[] {
  const missing: string[] = [];
  if (!form.name.trim()) missing.push('Give it a name.');
  if (form.follows !== 'words' && form.profileId === null) missing.push('Choose the person it watches for.');
  if (form.follows === 'words' && !form.keywords.length) missing.push('Add at least one term.');
  if (form.follows !== 'retractions' && knownSources === 0) missing.push('Choose at least one source.');
  return missing;
}

/** The schedule a form will store, in words where the words are exact. */
export function scheduleWords(form: WatchForm, existing: Routine | null): { words: string | null; cron: string } {
  const cron = cronFor(form.schedule);
  if (cron !== null) return { words: scheduleText(cron), cron };
  const stored = existing?.schedule_cron ?? '';
  return { words: scheduleText(stored, existing?.parameters), cron: stored };
}
