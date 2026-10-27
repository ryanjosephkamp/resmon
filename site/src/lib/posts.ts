/**
 * Post dates and permalinks.
 *
 * The 27 posts in ``docs/_posts/`` were written for Jekyll, and their published
 * URLs are already in the wild: the in-app Blog tab's "Open in browser" button
 * hands one straight to the user's browser, and the feed's ``<id>`` elements are
 * built from them. So the permalink is not a design decision here. It is a fact
 * to be reproduced, and reproducing it takes two things Jekyll did implicitly.
 *
 * 1. **The date comes from the front matter, not the file name, and it carries
 *    an offset.** ``docs/_posts/2026-09-06-resmon-update-22.md`` declares
 *    ``date: 2026-09-06 21:00:00 -0400`` and is published at
 *    ``/2026/09/07/resmon-update-22/`` — the next day. GitHub Pages builds with
 *    ``TZ=UTC`` and ``_config.yml`` sets no ``timezone``, so Jekyll formatted
 *    ``:year/:month/:day`` from the UTC instant. Two of the 27 posts (updates 17
 *    and 22) land on a different day from their file name because of this, and a
 *    build that used the file name would 404 both.
 * 2. **The slug comes from the file name**, with the leading ``YYYY-MM-DD-``
 *    stripped — not from the title. ``:title`` in a Jekyll permalink means the
 *    post's slug, and absent a front-matter ``slug`` that is the file name.
 *
 * ``scripts/verify-output.mjs`` checks the result of both rules against the
 * URL list captured from the live Jekyll site before any of this was changed.
 */

/** One post's front matter, as loose as the 27 files actually are. */
export interface PostFrontmatter {
  title: string;
  /**
   * YAML may hand this back as a ``Date`` or as a string, depending on whether
   * the parser recognised the timestamp form. ``2026-04-23`` parses as a date;
   * ``2026-09-06 21:00:00 -0400`` has an offset without a colon, which the YAML
   * timestamp pattern does not accept, so it arrives as a string. Both appear
   * in ``docs/_posts/``, so both are handled rather than assumed away.
   */
  date: Date | string;
  categories?: string | string[];
  layout?: string;
}

/**
 * Resolve a front-matter ``date`` to a UTC instant.
 *
 * Accepts, in the forms that appear in ``docs/_posts/``:
 *   - a ``Date`` the YAML parser already built;
 *   - ``YYYY-MM-DD``, which Jekyll reads as midnight in the build timezone (UTC);
 *   - ``YYYY-MM-DD HH:MM:SS ±HHMM`` and ``±HH:MM``, with or without the seconds;
 *   - the same with a ``T`` separator or a trailing ``Z``.
 *
 * Throws on anything else rather than silently producing an ``Invalid Date``
 * that would become a ``NaN`` segment in a URL.
 */
export function parsePostDate(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('front matter date is an Invalid Date');
    return value;
  }
  const raw = String(value).trim();

  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?)?$/,
  );
  if (!match) throw new Error(`unrecognised front matter date: ${JSON.stringify(raw)}`);

  const [, year, month, day, hour = '00', minute = '00', second = '00', zone] = match;

  let offsetMinutes = 0;
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }

  const utcMillis =
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) -
    offsetMinutes * 60_000;
  return new Date(utcMillis);
}

/** ``2026-09-06-resmon-update-22`` -> ``resmon-update-22``. */
export function postSlug(id: string): string {
  return id.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

/**
 * The Jekyll permalink ``/:year/:month/:day/:title/``, formatted in UTC and
 * without the ``/resmon`` base — Astro prepends that from ``astro.config.mjs``.
 */
export function postPath(id: string, date: Date | string): string {
  const when = parsePostDate(date);
  const year = String(when.getUTCFullYear()).padStart(4, '0');
  const month = String(when.getUTCMonth() + 1).padStart(2, '0');
  const day = String(when.getUTCDate()).padStart(2, '0');
  return `/${year}/${month}/${day}/${postSlug(id)}/`;
}

/**
 * ``2026-09-21T13:00:00+00:00`` — the shape ``jekyll-feed`` wrote into
 * ``<published>`` and ``<updated>``. The app parses this with ``Date.parse``,
 * which would also accept a trailing ``Z``, but matching the old bytes keeps the
 * feed comparison in the pull request down to differences that were intended.
 */
export function xmlSchemaUtc(date: Date | string): string {
  return `${parsePostDate(date).toISOString().replace(/\.\d{3}Z$/, '')}+00:00`;
}

/**
 * The day the author wrote in the front matter: ``2026-09-04 22:00:00 -0400``
 * reads ``September 4, 2026``. The post's own title carries that day, so a
 * list that showed the UTC day instead (``displayDate``) said September 5 beside
 * a title saying September 4. The permalink keeps the UTC day; it is a URL
 * already in the wild, not a date for reading.
 */
export function writtenDate(date: Date | string): string {
  const raw = date instanceof Date ? date.toISOString() : String(date).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return displayDate(date);
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12)).toLocaleDateString(
    'en-US',
    { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' },
  );
}

/** A readable date for page chrome: ``September 21, 2026``, always in UTC. */
export function displayDate(date: Date | string): string {
  return parsePostDate(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Newest first, the order the post list and the feed both present. */
export function byDateDescending(
  a: { data: { date: Date | string } },
  b: { data: { date: Date | string } },
): number {
  return parsePostDate(b.data.date).getTime() - parsePostDate(a.data.date).getTime();
}
