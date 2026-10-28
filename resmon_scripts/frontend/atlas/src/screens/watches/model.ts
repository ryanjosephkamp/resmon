/**
 * Watches: a routine, what it asks, when it fires, and the words for each of
 * its states.
 *
 * A watch is a routine as the engine stores it. Its schedule is said in words
 * only where the words can be exact (`scheduleText`), its next fire is the one
 * the engine's own calendar promises rather than one computed here, and its
 * delivery states are the drain's own, given the words a person uses.
 */
import type { components } from '../../api/schema';

export type RoutineRow = components['schemas']['RoutineRow'];
export type Routine = components['schemas']['Routine'];
export type CalendarEvent = components['schemas']['CalendarEvent'];
export type Delivery = components['schemas']['Delivery'];
export type DeliveryTarget = components['schemas']['DeliveryTarget'];
export type Coverage = components['schemas']['RoutineCoverage'];

/** The query key every list of watches is read under, so a change invalidates them together. */
export const WATCHES_KEY = ['routines'] as const;
/** The engine's calendar: runs that happened and fires that are promised. */
export const CALENDAR_KEY = ['calendar-events'] as const;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function clock(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

function plural(n: number, unit: string): string {
  return n === 1 ? unit : `${n} ${unit}s`;
}

function intIn(field: string, lo: number, hi: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number(field);
  return n >= lo && n <= hi ? n : null;
}

/** Standard cron day-of-week: 0 or 7 is Sunday. */
function daysPhrase(field: string): string | null {
  if (field === '1-5') return 'Weekdays';
  if (field === '0,6' || field === '6,0' || field === '6,7') return 'Weekends';
  const days: number[] = [];
  for (const part of field.split(',')) {
    const d = intIn(part, 0, 7);
    if (d === null) return null;
    days.push(d % 7);
  }
  if (days.length === 1) return `${DAY_NAMES[days[0] ?? 0]}s`;
  return days.map((d) => (DAY_NAMES[d] ?? '').slice(0, 3)).join(', ');
}

interface StructuredSchedule { unit: string; every: number; hour: number; minute: number }

/** The validation `scheduler._extract_schedule` applies, or null. */
function structured(parameters: unknown): StructuredSchedule | null {
  let p = parameters;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch { return null; }
  }
  if (!p || typeof p !== 'object') return null;
  const s = (p as Record<string, unknown>)._schedule;
  if (!s || typeof s !== 'object') return null;
  const sched = s as Record<string, unknown>;
  if (sched.type !== 'interval') return null;
  const unit = String(sched.unit);
  if (!['minutes', 'hours', 'days', 'weeks', 'months', 'years'].includes(unit)) return null;
  const every = Number.parseInt(String(sched.every), 10);
  if (!Number.isFinite(every) || every < 1) return null;
  const hour = Number.parseInt(String(sched.hour ?? 0), 10) || 0;
  const minute = Number.parseInt(String(sched.minute ?? 0), 10) || 0;
  return { unit, every, hour, minute };
}

function describeStructured(s: StructuredSchedule): string {
  const unit = s.unit.slice(0, -1);
  const span = s.every === 1 ? `Every ${unit}` : `Every ${plural(s.every, unit)}`;
  if (s.unit === 'minutes') return span;
  if (s.unit === 'hours') return s.minute === 0 ? span : `${span}, at :${String(s.minute).padStart(2, '0')}`;
  return `${span} at ${clock(s.hour, s.minute)}`;
}

function describeCron(cron: string): string | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min = '', hour = '', dom = '', mon = '', dow = ''] = f;
  if (mon !== '*') return null;
  if (hour === '*' && dom === '*' && dow === '*') {
    if (min === '*') return 'Every minute';
    const step = /^\*\/(\d+)$/.exec(min);
    if (step) return `Every ${plural(Number(step[1]), 'minute')}`;
    const m = intIn(min, 0, 59);
    if (m !== null) return m === 0 ? 'Every hour' : `Every hour, at :${String(m).padStart(2, '0')}`;
    return null;
  }
  const m = intIn(min, 0, 59);
  if (m === null) return null;
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep && dom === '*' && dow === '*') {
    const span = `Every ${plural(Number(hourStep[1]), 'hour')}`;
    return m === 0 ? span : `${span}, at :${String(m).padStart(2, '0')}`;
  }
  const h = intIn(hour, 0, 23);
  if (h === null) return null;
  const at = clock(h, m);
  if (dom === '*' && dow === '*') return `Daily at ${at}`;
  if (dom === '*') {
    const days = daysPhrase(dow);
    return days ? `${days} at ${at}` : null;
  }
  if (dow === '*') {
    const d = intIn(dom, 1, 31);
    return d !== null ? `Monthly on day ${d} at ${at}` : null;
  }
  return null;
}

/**
 * A schedule in words ("Mondays at 7:00 AM"), or null where the words cannot
 * be exact, and the cron expression is shown as it is instead: a paraphrase
 * that is nearly right is worse than the expression. Follows
 * `scheduler._build_trigger`, so a structured `_schedule` in the parameters
 * wins over the cron string, as it does when the routine fires. `*\/N` in the
 * day of the month restarts every month and is left untranslated. The same
 * rules as the classic interface's `lib/scheduleText.ts`, which goes when it
 * does.
 */
export function scheduleText(cron: string | null | undefined, parameters?: unknown): string | null {
  const s = structured(parameters);
  if (s) return describeStructured(s);
  if (!cron) return null;
  return describeCron(cron);
}

/** What a watch asks, read out of its stored parameters. */
export interface WatchAsks {
  sources: string[];
  keywords: string[];
  query: string;
  /** A watch on a person rather than on words. */
  person: boolean;
}

function parsed(text: string | null | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text ?? '{}');
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function watchAsks(parameters: string | null | undefined): WatchAsks {
  const p = parsed(parameters);
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const sources = list(p.repositories);
  if (!sources.length && typeof p.repository === 'string') sources.push(p.repository);
  return {
    sources,
    keywords: list(p.keywords),
    query: typeof p.query === 'string' ? p.query : '',
    person: !!p.entity,
  };
}

/**
 * The engine's timestamps, as instants. SQLite's own (`2026-10-28 22:04:26`)
 * are UTC with no zone written, and `Date` would read them as local time, so
 * a zone-less one is read as UTC; ISO strings with a zone are left alone.
 */
export function instant(stamp: string | null | undefined): Date | null {
  if (!stamp) return null;
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp.replace(' ', 'T')}Z`;
  const at = new Date(zoned);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The fires the calendar promises for one watch, soonest first. Only active watches have any. */
export function promisedFires(events: readonly CalendarEvent[], routineId: number, now: Date): CalendarEvent[] {
  return events
    .filter((event) => event.status === 'scheduled' && event.routine_id === routineId)
    .filter((event) => new Date(event.start).getTime() >= now.getTime())
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

/** A delivery's state in the words a person uses for it. The drain's word stays on the row. */
export function deliveryWords(row: Pick<Delivery, 'state' | 'next_attempt_at_utc'>): string {
  switch (row.state) {
    case 'awaiting_review': return 'Waiting for you';
    case 'delivering': return 'Sending';
    case 'delivered': return 'Delivered';
    case 'skipped': return 'Skipped';
    case 'failed': return row.next_attempt_at_utc ? 'Failed, trying again' : 'Failed';
    case 'queued': return 'Queued';
    default: return row.state;
  }
}

/** The three channels' destinations in words; an email with no address goes to the one in Settings. */
export function destinationWords(channel: string, target: string): string {
  if (target) return target;
  if (channel === 'email') return 'the address in Settings';
  return 'no destination recorded';
}

export const CHANNEL_WORDS: Record<string, string> = {
  email: 'Email',
  folder: 'Folder',
  webhook: 'Webhook',
  feed: 'Feed',
};
