/** The words Today uses for times, counts and people. US English throughout. */
import { timeTogether } from '../../lib/timeTogether';
import { againAt, RATE_LIMITED } from '../runs/model';

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' });
const FULL_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const NUMBER = new Intl.NumberFormat('en-US');

/** "8:05 AM", never broken between the time and its AM or PM. */
const time = (at: Date): string => timeTogether(TIME.format(at));

/**
 * An engine timestamp as an instant. The engine stores UTC, and SQLite writes
 * it with no zone (`2026-10-28 22:04:26`); `Date` would read that as local
 * time, which puts a UTC clock on the screen, so a date and time with no zone
 * is read as UTC. Anything else is read as written.
 */
export function instant(iso: string): Date {
  const bare = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(iso) && !/(?:Z|[+-]\d\d:?\d\d)$/i.test(iso);
  return new Date(bare ? `${iso.replace(' ', 'T')}Z` : iso);
}

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

/** "today", "yesterday", "Monday" (within the week), else "October 20". */
export function dayWord(at: Date, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days === -1) return 'tomorrow';
  if (days > 1 && days < 7) return WEEKDAY.format(at);
  return MONTH_DAY.format(at);
}

/** "today at 8:05 AM", "Monday at 8:05 AM", "October 20 at 8:05 AM". */
export function when(iso: string | null | undefined, now: Date): string {
  if (!iso) return 'at a time not recorded';
  const at = instant(iso);
  if (Number.isNaN(at.getTime())) return 'at a time not recorded';
  return `${dayWord(at, now)} at ${time(at)}`;
}

const PUBLISHED_DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const PUBLISHED_MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * A paper's stored publication date in words, as precise as the stored text
 * and no more: "2026", "April 2026", "April 13, 2026". A date is a calendar
 * day, not an instant, so it is read in UTC and never moves a day with the
 * computer's zone. Text that is not one of the three shapes is shown as it is.
 */
export function publishedWords(stored: string | null | undefined): string {
  const text = (stored ?? '').trim();
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text);
  if (!match) return text;
  const [, year, month, day] = match;
  if (!month) return year!;
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, day ? Number(day) : 1));
  if (Number.isNaN(at.getTime()) || at.getUTCMonth() !== Number(month) - 1
    || (day && at.getUTCDate() !== Number(day))) return text;
  return (day ? PUBLISHED_DAY : PUBLISHED_MONTH).format(at);
}

export function clock(iso: string): string {
  return time(instant(iso));
}

export function fullDate(at: Date): string {
  return `${FULL_DATE.format(at)} · ${time(at)}`;
}

export function number(n: number): string {
  return NUMBER.format(n);
}

/** "1 new paper", "29 new papers". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${NUMBER.format(n)} ${n === 1 ? singular : plural}`;
}

/** "41 s", "3 min 5 s", "1 h 2 min". Null when either end is missing. */
export function duration(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  if (!startIso || !endIso) return null;
  const seconds = Math.round((instant(endIso).getTime() - instant(startIso).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The first three authors, then "et al." Authors arrive comma-joined. */
export function authors(list: string | null | undefined): string {
  const names = (list ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return 'Authors not recorded';
  return names.length > 3 ? `${names.slice(0, 3).join(', ')}, et al.` : names.join(', ');
}

/** Days between two moments, in whole days, never negative. */
export function daysAgo(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const days = Math.floor((now.getTime() - instant(iso).getTime()) / 86_400_000);
  return Number.isFinite(days) ? Math.max(0, days) : null;
}

/** "arXiv", "arXiv and DOAJ", "arXiv, DOAJ, and PLOS". */
export function listSeparator(index: number, length: number): string {
  if (index === 0) return '';
  if (index < length - 1) return ', ';
  return length === 2 ? ' and ' : ', and ';
}

export function listWords(names: readonly string[]): string {
  return names.map((name, index) => listSeparator(index, names.length) + name).join('');
}

/**
 * The next times watches will run, soonest first, each said once: "tomorrow at
 * 12:00 AM (2 watches) and tomorrow at 8:00 AM". Times are told apart as they
 * read, so two watches due within the same minute are one time with a count,
 * never the same words twice. At most `shown` times are named.
 */
export function nextRunsWords(times: readonly string[], now: Date, shown = 2): string {
  const groups: { words: string; n: number }[] = [];
  for (const at of [...times].sort()) {
    const words = when(at, now);
    const same = groups.find((g) => g.words === words);
    if (same) same.n += 1;
    else groups.push({ words, n: 1 });
  }
  return listWords(groups.slice(0, shown).map((g) => (g.n > 1 ? `${g.words} (${count(g.n, 'watch', 'watches')})` : g.words)));
}

/** A source that did not answer on a run, or whose answer is unknown, as Today is given it. */
export interface SourceTrouble {
  name: string;
  category: 'non_answer' | 'unknown';
  label: string;
  /** When a rate-limited source said it may be asked again, where it said. */
  cooldown_until_utc?: string | null;
}

/** One part of a run's line of trouble: the sources with one outcome, named once. */
export interface TroublePart {
  category: 'non_answer' | 'unknown';
  label: string;
  text: string;
  count: number;
}

/**
 * A run's sources that did not answer, as one line: grouped by what happened
 * to them, in the engine's words for it ("did not answer", "could not answer
 * this window", "withdrawn"), each group named once. Those that did not
 * answer come before those whose answer is unknown, and each part keeps its
 * category, so a failure and an unknown are never drawn alike.
 */
export function troubleParts(sources: readonly SourceTrouble[], now: Date = new Date()): TroublePart[] {
  const groups = new Map<string, { category: SourceTrouble['category']; label: string; names: string[]; until: string[] }>();
  for (const source of sources) {
    const key = `${source.category}|${source.label}`;
    const group = groups.get(key) ?? { category: source.category, label: source.label, names: [], until: [] };
    group.names.push(source.name);
    if (source.cooldown_until_utc) group.until.push(source.cooldown_until_utc);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => Number(a.category === 'unknown') - Number(b.category === 'unknown'))
    .map(({ category, label, names, until }) => {
      const who = listWords(names);
      const was = names.length === 1 ? 'was' : 'were';
      // A rate-limited source is up and asked resmon to wait: said as that,
      // with the latest time any of them gave while it is still ahead.
      const at = label === RATE_LIMITED ? againAt(until.sort().pop() ?? null, now) : null;
      const text = label === 'withdrawn' ? `${who} ${was} withdrawn`
        : label === RATE_LIMITED ? `${who} ${was} rate-limited${at ? `; try again after about ${at}` : ''}`
          : label === 'did not answer' || label === 'could not answer this window' ? `${who} ${label}`
            : `${who}: ${label}`;
      return { category, label, text, count: names.length };
    });
}
