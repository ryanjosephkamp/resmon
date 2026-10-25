/**
 * Turning a stored timestamp into text a person reads.
 *
 * resmon stores one kind of timestamp: a UTC instant, written by
 * ``implementation_scripts/utils.now_iso()`` as ``%Y-%m-%dT%H:%M:%SZ``. By the
 * time one reaches the renderer it may have been re-spelled several times
 * without changing meaning — APScheduler serializes an upcoming routine fire
 * with a numeric offset, and FullCalendar re-serializes whatever it was handed
 * into the browser's own offset — so ``2026-10-20T00:47:00Z`` and
 * ``2026-10-19T20:47:00-04:00`` are the same moment written two ways.
 *
 * Which is why the renderer must not read a timestamp as characters. The
 * calendar popover did: ``start.replace('T', ' ').slice(0, 16)`` cut the
 * trailing ``Z`` off along with the seconds and showed a reader
 * ``2026-10-20 00:47`` for a run that the grid, four inches above it, had
 * placed on October 19 at 8:47 PM. Both were drawn from the same instant and
 * they disagreed by four hours and a calendar day, with nothing on screen to
 * say which was which.
 *
 * So the rule this module exists to hold is: **a timestamp becomes text in one
 * place, from the instant rather than from its spelling, and it always carries
 * a zone.** A time with no zone marker is a number whose meaning depends on an
 * assumption the reader cannot see, and this app does not render those.
 *
 * A *date* is the second thing this module renders, and it comes in two kinds
 * that look identical on the wire. The day an instant fell on — when a paper
 * was saved, when a routine last found something — depends on where the
 * reader is: ``2026-10-20T00:47:00Z`` is October 19 in New York. A calendar
 * date — a publication date, the bounds of a search window — is the same day
 * everywhere and must never move. Which one a value is comes from where the
 * backend writes it, not from its shape: ``reading_queue.saved_at`` is an
 * instant even when a surface only shows its day. ``formatInstantDate``
 * renders the first kind; ``calendarDateOf`` makes the second from a moment.
 */

/**
 * Read a stored timestamp as the instant it denotes, or ``null``.
 *
 * The bare-string case is the one that matters. ECMA-262 reads a date-time
 * with no offset — ``2026-10-20T00:47:00`` — as *local*, which for resmon's
 * data is wrong by exactly the viewer's own offset and wrong silently. Every
 * timestamp this app stores is UTC, so a string with no zone is completed with
 * ``Z`` rather than handed to the default parser.
 *
 * A date-only string (``2026-10-20``) is already parsed as UTC midnight by the
 * same specification, so it needs no help.
 */
export function parseStoredInstant(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const hasZone = /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(raw);
  const hasTime = raw.includes('T') || raw.includes(' ');
  // Space-separated timestamps reach the renderer from a few older rows;
  // normalize to the ``T`` form the parser requires before completing it.
  const normalized = raw.replace(' ', 'T');
  const candidate = hasTime && !hasZone ? `${normalized}Z` : normalized;

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Format a stored timestamp in the viewer's own timezone, with its zone named.
 *
 * Shape: ``2026-10-19 20:47 EDT`` — the sortable date the rest of the app's
 * tables use, the local wall clock, and the zone. Where the zone has no
 * common abbreviation the platform supplies an offset instead
 * (``2026-10-20 09:47 GMT+9``), which is equally unambiguous.
 *
 * The parts are assembled by hand rather than taken from ``toLocaleString`` so
 * that the output does not change shape with the viewer's locale; only the
 * zone name is the platform's to choose.
 *
 * A string that cannot be read as an instant is returned **unchanged**. The
 * alternative — an empty cell, or a guess — would hide the fact that resmon
 * holds a value it does not understand, and that is the kind of silence this
 * codebase treats as a defect rather than a tidy-up.
 *
 * **Do not call this on a date-only value.** ``formatInstant('2026-10-20')``
 * returns ``'2026-10-19 20:00 EDT'`` — the previous evening. That is correct
 * and it is not a bug: a bare date is UTC midnight, and UTC midnight is the
 * evening before in every zone west of Greenwich. It is the wrong answer to a
 * different question. A stored *date* carries no instant to convert and must
 * be rendered as the date it is.
 *
 * This mattered when ``AnalyticsPage`` and ``ReadingQueuePage`` rendered the
 * day of an instant with ``.slice(0, 10)``: the obvious cleanup was to slice
 * first and hand the date to this function, which would have shipped the
 * exact off-by-a-day the cleanup existed to remove. To show the day an
 * instant fell on, use ``formatInstantDate``.
 *
 * @param value     the stored timestamp — an instant, not a date
 * @param timeZone  an IANA zone to render in; omit for the viewer's own
 */
export function formatInstant(
  value: string | null | undefined,
  timeZone?: string,
): string {
  const instant = parseStoredInstant(value);
  if (!instant) return typeof value === 'string' ? value : '';

  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    // ``h23`` rather than ``hour12: false``: the latter renders midnight as
    // ``24:00`` on some ICU builds, which would put a run on the wrong day
    // again by a different route.
    hourCycle: 'h23',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const stamp = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  const zone = part('timeZoneName');
  return zone ? `${stamp} ${zone}` : stamp;
}

/** A value with a date and nothing else: ``2026-10-20``. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The calendar date a moment falls on in the viewer's zone, as ``YYYY-MM-DD``.
 *
 * This is how a window bound is made. The date-range presets used to take
 * ``toISOString().slice(0, 10)``, which is the date *in UTC*: at 8:47 PM on
 * October 19 in New York that is already October 20, so "Last 7d" ended on a
 * day that had not arrived where the user was sitting. A search window is
 * made of the user's days, and these are the user's days.
 *
 * Read from the formatter rather than from ``getFullYear``/``getMonth``/
 * ``getDate`` so that ``timeZone`` can name a zone other than the viewer's,
 * which is what lets the result be tested without moving the machine.
 *
 * @param moment    the instant to place on a calendar
 * @param timeZone  an IANA zone to place it in; omit for the viewer's own
 */
export function calendarDateOf(moment: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(moment);

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Format a stored timestamp as the calendar date it fell on, for the viewer.
 *
 * Shape: ``2026-10-19`` — the date part of what ``formatInstant`` would show
 * for the same value, and always the same day as it. ``saved_at`` written as
 * ``2026-10-20 00:47:00`` (UTC, by SQLite's ``datetime('now')``) renders as
 * ``2026-10-19`` in New York and ``2026-10-20`` in London, because that is
 * when the reader in each place did it.
 *
 * No zone is appended, unlike ``formatInstant``. A clock time without a zone
 * is ambiguous by hours and this module refuses to print one; a day in the
 * reader's own calendar is what a bare date already means to them, and that
 * is exactly what this returns.
 *
 * **A value that is already a calendar date is returned as it is.**
 * ``2026-10-20`` carries no time of day, so there is no instant to convert,
 * and converting it anyway — reading it as UTC midnight and moving it into
 * the viewer's zone — is the off-by-a-day ``formatInstant`` documents. That
 * is the property that makes this the safe function to reach for when
 * showing a day: whatever kind of date it is handed, it never moves one.
 *
 * Like ``formatInstant``, a string that cannot be read is returned unchanged
 * rather than hidden.
 *
 * @param value     the stored timestamp, or a calendar date
 * @param timeZone  an IANA zone to render in; omit for the viewer's own
 */
export function formatInstantDate(
  value: string | null | undefined,
  timeZone?: string,
): string {
  if (typeof value !== 'string') return '';
  if (CALENDAR_DATE.test(value.trim())) return value.trim();

  const instant = parseStoredInstant(value);
  if (!instant) return value;
  return calendarDateOf(instant, timeZone);
}
