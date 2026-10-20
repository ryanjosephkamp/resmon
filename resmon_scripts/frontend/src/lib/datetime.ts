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
 * This matters because several surfaces still render dates by slicing the
 * stored string — ``AnalyticsPage`` and ``ReadingQueuePage`` take
 * ``.slice(0, 10)`` — and the obvious way to clean them up is to reach for
 * the function you are reading. Doing that would introduce the exact
 * off-by-a-day that converting them is meant to remove. They need a
 * date-rendering companion, not this.
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
