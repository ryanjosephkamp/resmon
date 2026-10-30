/** The words Today uses for times, counts and people. US English throughout. */

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' });
const FULL_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const NUMBER = new Intl.NumberFormat('en-US');

/**
 * An engine timestamp as an instant. The engine stores UTC, and SQLite writes
 * it with no zone (`2026-10-28 22:04:26`); `Date` would read that as local
 * time, which puts a UTC clock on the screen, so a date and time with no zone
 * is read as UTC. Anything else is read as written.
 */
function instant(iso: string): Date {
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
  return `${dayWord(at, now)} at ${TIME.format(at)}`;
}

export function clock(iso: string): string {
  return TIME.format(instant(iso));
}

export function fullDate(at: Date): string {
  return `${FULL_DATE.format(at)} · ${TIME.format(at)}`;
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
export function listWords(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** A source that did not answer on a run, or whose answer is unknown, as Today is given it. */
export interface SourceTrouble {
  name: string;
  category: 'non_answer' | 'unknown';
  label: string;
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
export function troubleParts(sources: readonly SourceTrouble[]): TroublePart[] {
  const groups = new Map<string, { category: SourceTrouble['category']; label: string; names: string[] }>();
  for (const source of sources) {
    const key = `${source.category}|${source.label}`;
    const group = groups.get(key) ?? { category: source.category, label: source.label, names: [] };
    group.names.push(source.name);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => Number(a.category === 'unknown') - Number(b.category === 'unknown'))
    .map(({ category, label, names }) => {
      const who = listWords(names);
      const text = label === 'withdrawn' ? `${who} ${names.length === 1 ? 'was' : 'were'} withdrawn`
        : label === 'did not answer' || label === 'could not answer this window' ? `${who} ${label}`
          : `${who}: ${label}`;
      return { category, label, text, count: names.length };
    });
}
