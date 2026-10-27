/**
 * A routine's schedule in words: "Mondays at 7:00 AM", "Every 6 hours".
 *
 * The tables printed the raw cron string ("0 7 * * 1"), which a reader has to
 * decode field by field. The words have to say what the scheduler will
 * actually do, so this follows `scheduler._build_trigger` exactly: a valid
 * structured `_schedule` block in the routine's parameters wins over the cron
 * string, because that block is what fires. A cron form this file cannot state
 * exactly returns null, and the caller shows the cron string as it is: a
 * paraphrase that is nearly right is worse than the expression itself. One
 * known trap is left untranslated on purpose: `*\/N` in the day-of-month field
 * restarts every month, so "every 5 days" in cron is not every five days.
 *
 * Times are the computer's local time, which is the zone the scheduler fires
 * in; no zone abbreviation is attached, because a cron time of 7:00 stays 7:00
 * across a daylight-saving change while the abbreviation does not.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function clock(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${h12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function plural(n: number, unit: string): string {
  return n === 1 ? unit : `${n} ${unit}s`;
}

function intIn(field: string, lo: number, hi: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number(field);
  return n >= lo && n <= hi ? n : null;
}

/** Standard cron day-of-week: 0 or 7 is Sunday. Returns the phrase or null. */
function daysPhrase(field: string): string | null {
  if (field === '1-5') return 'Weekdays';
  if (field === '0,6' || field === '6,0' || field === '6,7') return 'Weekends';
  const parts = field.split(',');
  const days: number[] = [];
  for (const p of parts) {
    const d = intIn(p, 0, 7);
    if (d === null) return null;
    days.push(d % 7);
  }
  if (days.length === 1) return `${DAY_NAMES[days[0]]}s`;
  return days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ');
}

interface StructuredSchedule {
  unit: string;
  every: number;
  hour: number;
  minute: number;
}

/** The same validation `scheduler._extract_schedule` applies, or null. */
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
  const unit = s.unit.slice(0, -1); // "hours" -> "hour"
  const span = s.every === 1 ? `Every ${unit}` : `Every ${plural(s.every, unit)}`;
  if (s.unit === 'minutes') return span;
  if (s.unit === 'hours') return s.minute === 0 ? span : `${span}, at :${String(s.minute).padStart(2, '0')}`;
  return `${span} at ${clock(s.hour, s.minute)}`;
}

function describeCron(cron: string): string | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  if (mon !== '*') return null;

  // Every N minutes / every minute.
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

  // Every N hours, on the minute given.
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep && dom === '*' && dow === '*') {
    const n = Number(hourStep[1]);
    const span = `Every ${plural(n, 'hour')}`;
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
 * The schedule in words, or null when it cannot be said exactly. Pass the
 * routine's `parameters` so a structured schedule is honored.
 */
export function scheduleText(cron: string | null | undefined, parameters?: unknown): string | null {
  const s = structured(parameters);
  if (s) return describeStructured(s);
  if (!cron) return null;
  return describeCron(cron);
}
