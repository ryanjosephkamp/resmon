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
import { overrideOf, type SummaryChoice } from '../settings/summaryChoice';
import type { AiSettings } from '../settings/summaryLanes';
import { scheduleText, type Routine } from './model';
import {
  DEFAULT_LAST_DAYS, MAX_DAYS, dayCount, listed, startWhy, windowOf, type StartNeeded, type WindowChoice,
} from './window';

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
  /** Which dates each run asks for; `dateFrom` and `dateTo` are read only for `between`. */
  window: WindowChoice;
  lastDays: number;
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
    schedule: { ...DEFAULT_SCHEDULE }, window: 'previous_run', lastDays: DEFAULT_LAST_DAYS, dateFrom: '', dateTo: '',
    cap: 100, intent: '',
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
    // Dates handed over are fixed dates; without any, the watch asks since its previous run.
    window: seed.dateFrom || seed.dateTo ? 'between' : form.window,
    dateFrom: seed.dateFrom ?? '',
    dateTo: seed.dateTo ?? '',
    ...(seed.profileId ? { follows: 'new_papers' as const, profileId: seed.profileId } : {}),
  };
}

/**
 * A stored watch's terms: its keywords, or, for a watch that stored only the
 * query a run sends (one made through the MCP tools), that query as one term,
 * not split on spaces, so "machine learning" stays one term.
 */
function termsOf(p: Record<string, unknown>): string[] {
  const keywords = list(p.keywords).filter((k) => k.trim());
  if (keywords.length) return keywords;
  return typeof p.query === 'string' && p.query.trim() ? [p.query.trim()] : [];
}

/** A stored watch as the form shows it. */
export function formFrom(routine: Routine): WatchForm {
  const p = parametersOf(routine.parameters);
  const entity = p.entity && typeof p.entity === 'object' ? p.entity as Record<string, unknown> : null;
  const mode = entity?.mode;
  const sources = list(p.repositories);
  if (!sources.length && typeof p.repository === 'string') sources.push(p.repository);
  const cap = Number(p.max_results);
  const window = windowOf(p);
  return {
    name: routine.name,
    follows: mode === 'new_papers' || mode === 'retractions' ? mode : 'words',
    profileId: typeof entity?.profile_id === 'number' ? entity.profile_id : null,
    keywords: termsOf(p),
    sources,
    schedule: choiceFrom(routine.schedule_cron, p),
    window: window.window,
    lastDays: window.lastDays,
    dateFrom: window.dateFrom,
    dateTo: window.dateTo,
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
 * would resume a paused watch without a word. Summaries are sent by
 * `summaryBody`, beside this.
 */
export function watchBody(form: WatchForm, existing: Routine | null): WatchBody {
  const parameters = existing ? parametersOf(existing.parameters) : {};
  const person = form.follows !== 'words';
  const retractions = form.follows === 'retractions';
  parameters.repositories = [...form.sources];
  // A watch on a person follows the person, and narrowing that by topic would
  // silently hide the rest of their work, so its keywords are cleared rather
  // than sent and ignored: what is stored is what runs.
  parameters.keywords = person ? [] : [...form.keywords];
  parameters.query = person ? '' : form.keywords.join(' ');
  // The window chosen, and only it: a window that moves goes with blank dates,
  // fixed dates with no window, and a watch on retractions searches no source
  // for papers (it checks the ones already matched), so it has neither. The engine refuses a window and dates together.
  const between = !retractions && form.window === 'between';
  parameters.date_from = between ? form.dateFrom : '';
  parameters.date_to = between ? form.dateTo : '';
  if (!retractions && form.window === 'previous_run') parameters.date_window = { since: 'previous_run' };
  else if (!retractions && form.window === 'last_days') parameters.date_window = { last_days: form.lastDays };
  else delete parameters.date_window;
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

/**
 * Whether a watch's runs summarize, and with what, as the routine stores it:
 * `ai_enabled`, and `ai_settings` over Settings › AI. Where the choice is the
 * one the watch was opened with, `ai_settings` is not sent and stays exactly
 * as stored, whichever interface wrote it. Otherwise it is rebuilt from what
 * is stored, so a key this editor does not show survives; an empty object
 * clears it, which the engine reads as "as Settings › AI has it".
 */
export function summaryBody(
  choice: SummaryChoice, initial: SummaryChoice, stored: AiSettings | undefined, existing: Routine | null,
): { ai_enabled: boolean; ai_settings?: Record<string, unknown> } {
  const body: { ai_enabled: boolean; ai_settings?: Record<string, unknown> } = { ai_enabled: choice.on };
  if (existing && JSON.stringify(choice) === JSON.stringify(initial)) return body;
  if (!stored) return body;
  const override = overrideOf(choice, stored, existing?.ai_settings ?? {});
  if (existing || Object.keys(override).length) body.ai_settings = override;
  return body;
}

/**
 * What a watch on retractions sends, and to whom. It searches no source for
 * papers, but each run puts the person's matched papers through the lifecycle
 * check (`sweep_engine._run_retractions`, `lifecycle.check_documents`), which
 * sends a paper's DOI to Crossref and an arXiv or bioRxiv paper's id to arXiv
 * or bioRxiv.
 */
export function retractionsAsks(who: string): string {
  return `Each run sends the DOIs of the papers already matched to ${who} to Crossref, and the ids of those from arXiv `
    + 'and bioRxiv to arXiv and bioRxiv, for retraction, correction, and newer-version notices. It searches no source '
    + 'for new papers.';
}

/**
 * The sources a form asks that need a start date it does not give: none for a
 * window that moves, which always has one, or for a watch on a person, whose
 * sources are asked about the person and never for a date range, and every
 * one of them for no date limit or fixed dates with no start. `null` when the
 * form gives every source what it needs.
 */
export function startMissing(form: WatchForm, needs: StartNeeded | null): StartNeeded | null {
  if (!needs || form.follows !== 'words') return null;
  return form.window === 'none' || (form.window === 'between' && !form.dateFrom) ? needs : null;
}

/** Why a watch asking a source that needs a start date cannot be saved without one. */
export function startMissingSentence(needs: StartNeeded): string {
  const names = listed(needs.entries.map((entry) => entry.name));
  return `${names} ${needs.entries.length === 1 ? 'needs' : 'need'} a start date, and this window gives none: `
    + `${startWhy(needs)}.`;
}

/** The window the editor offers in its place: the days the engine would start those sources from. */
export function startOffer(needs: StartNeeded): { window: 'last_days'; lastDays: number; label: string } {
  return { window: 'last_days', lastDays: needs.days, label: `Ask for the last ${dayCount(needs.days)}` };
}

/**
 * What stops a form saving, in the order the form asks it. Empty when it can
 * be saved. `needs` is the chosen sources that need a start date
 * (`startNeeded`), which a watch on words must give them.
 */
export function whatIsMissing(form: WatchForm, knownSources: number, needs: StartNeeded | null = null): string[] {
  const missing: string[] = [];
  const startless = startMissing(form, needs);
  if (!form.name.trim()) missing.push('Give it a name.');
  if (form.follows !== 'words' && form.profileId === null) missing.push('Choose the person it watches for.');
  // The engine refuses a watch on words with none, too: every run would send its sources an empty search.
  if (form.follows === 'words' && !form.keywords.some((k) => k.trim())) missing.push('Add at least one term.');
  if (form.follows !== 'retractions' && knownSources === 0) missing.push('Choose at least one source.');
  if (form.follows !== 'retractions' && form.window === 'between') {
    // With a source that needs a start, the sentence below says what this one would.
    if (!form.dateFrom && !form.dateTo) {
      if (!startless) missing.push('Set a start date, an end date, or both.');
    } else if (form.dateFrom && form.dateTo && form.dateFrom > form.dateTo) missing.push('The start date is after the end date.');
  }
  if (startless) missing.push(startMissingSentence(startless));
  if (form.follows !== 'retractions' && form.window === 'last_days'
    && !(Number.isInteger(form.lastDays) && form.lastDays >= 1 && form.lastDays <= MAX_DAYS)) {
    missing.push(`Choose a number of days from 1 to ${MAX_DAYS.toLocaleString('en-US')}.`);
  }
  return missing;
}

/** The schedule a form will store, in words where the words are exact. */
export function scheduleWords(form: WatchForm, existing: Routine | null): { words: string | null; cron: string } {
  const cron = cronFor(form.schedule);
  if (cron !== null) return { words: scheduleText(cron), cron };
  const stored = existing?.schedule_cron ?? '';
  return { words: scheduleText(stored, existing?.parameters), cron: stored };
}
