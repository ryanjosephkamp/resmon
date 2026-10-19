import { RepoCatalogEntry, SourceConstraints } from '../api/repositories';

/**
 * Turning a source's constraint record plus the dates on the form into the
 * sentence a user reads before they submit.
 *
 * Everything here is display arithmetic over the record the backend sends.
 * The record itself — which sources round, and which way — is read from the
 * client modules in `repo_catalog.py` and is not re-derived here. What *is*
 * re-derived is which calendar years a given window works out to, because a
 * sentence that says "year granularity" is a label and a sentence that says
 * "it will search the whole of 2025 and 2026" is an answer, and the second
 * one needs the dates the user actually typed.
 *
 * That arithmetic mirrors `_whole_year_bounds` in `api_dblp.py` and
 * `_search_year_bounds` in `api_eric.py` / `api_openlibrary.py`. It is a
 * mirror and not a shared implementation: the backend and the renderer talk
 * only over HTTP, and no endpoint today previews a reshaped window. The cases
 * are pinned on both sides so the two cannot drift silently — see
 * `sourceConstraints.test.ts` here and `test_source_constraints.py` there.
 */

/** A year range, or `null` when the window contains no whole year to search. */
export interface YearSpan {
  from: number | null;
  to: number | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(value: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * The whole calendar years *contained by* the window — what an `inward`
 * source will search. `null` means there are none, and the source will be
 * asked nothing at all.
 */
export function wholeYearsInside(dateFrom: string, dateTo: string): YearSpan | null {
  const lower = dateFrom ? parts(dateFrom) : null;
  const upper = dateTo ? parts(dateTo) : null;
  if ((dateFrom && !lower) || (dateTo && !upper)) return null;

  const from = lower ? lower.year + (lower.month === 1 && lower.day === 1 ? 0 : 1) : null;
  const to = upper ? upper.year - (upper.month === 12 && upper.day === 31 ? 0 : 1) : null;
  if (from !== null && to !== null && from > to) return null;
  return { from, to };
}

/** The whole calendar years the window *touches* — what an `outward` source will search. */
export function wholeYearsTouched(dateFrom: string, dateTo: string): YearSpan | null {
  const lower = dateFrom ? parts(dateFrom) : null;
  const upper = dateTo ? parts(dateTo) : null;
  if ((dateFrom && !lower) || (dateTo && !upper)) return null;
  const from = lower ? lower.year : null;
  const to = upper ? upper.year : null;
  if (from !== null && to !== null && from > to) return null;
  return { from, to };
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The whole calendar months the window touches, as "March 2025". */
export function wholeMonthsTouched(dateFrom: string, dateTo: string): string | null {
  const lower = dateFrom ? parts(dateFrom) : null;
  const upper = dateTo ? parts(dateTo) : null;
  if ((dateFrom && !lower) || (dateTo && !upper)) return null;
  const label = (p: { year: number; month: number }) => `${MONTHS[p.month - 1]} ${p.year}`;
  if (lower && upper) {
    const a = label(lower);
    const b = label(upper);
    return a === b ? `the whole of ${a}` : `${a} through ${b}`;
  }
  if (lower) return `${label(lower)} onwards`;
  if (upper) return `everything up to the end of ${label(upper)}`;
  return null;
}

function yearSpanPhrase(span: YearSpan): string | null {
  const { from, to } = span;
  if (from === null && to === null) return null;
  if (from !== null && to !== null) {
    if (from === to) return `the whole of ${from}`;
    if (to - from === 1) return `all of ${from} and ${to}`;
    return `all of ${from} through ${to}`;
  }
  if (from !== null) return `${from} onwards`;
  return `everything up to the end of ${to}`;
}

/**
 * The concrete sentence for a source whose window will be reshaped, or
 * `null` when the dates on the form do not change anything about it.
 *
 * `null` is also the answer when no dates are set: with an open window there
 * is nothing specific to promise, and the source's own general notice already
 * says the window is searched by year.
 */
export function windowSentence(
  entry: Pick<RepoCatalogEntry, 'name'> & { constraints: SourceConstraints },
  dateFrom: string,
  dateTo: string,
): string | null {
  const { constraints, name } = entry;
  if (constraints.window_effect === 'as_asked') return null;
  if (!dateFrom && !dateTo) return null;

  if (constraints.window_effect === 'whole_months') {
    const months = wholeMonthsTouched(dateFrom, dateTo);
    if (!months) return null;
    return `${name} will search ${months}, so results can fall outside your exact dates.`;
  }

  if (constraints.window_rounding === 'inward') {
    const span = wholeYearsInside(dateFrom, dateTo);
    if (span === null) {
      return (
        `${name} will not be searched at all: your dates contain no complete ` +
        `calendar year, and ${name} can only be asked for whole years.`
      );
    }
    const phrase = yearSpanPhrase(span);
    if (!phrase) return null;
    return `${name} will search ${phrase} — only the complete calendar years inside your dates.`;
  }

  const span = wholeYearsTouched(dateFrom, dateTo);
  if (span === null) return null;
  const phrase = yearSpanPhrase(span);
  if (!phrase) return null;
  return constraints.window_refiltered_locally
    ? `${name} will search ${phrase}, and resmon will drop anything outside your exact dates once it arrives.`
    : `${name} will search ${phrase}, so results can fall outside your exact dates.`;
}

export interface SourceAdvisory {
  slug: string;
  name: string;
  /** The date sentence for the dates currently on the form, when there is one. */
  window: string | null;
  /** The source's standing notices, rendered as written. */
  notices: { kind: string; effect: string }[];
}

/**
 * Everything worth saying about the selected sources, and nothing else.
 *
 * A source with nothing to say is left out entirely rather than given a row
 * saying it is fine: a panel that lists every source warns about none of
 * them, and the whole value of this is that its presence means something.
 * Nineteen of the twenty-seven catalog rows have nothing to say, so on most
 * selections this produces no panel at all.
 *
 * Whether a key is missing is **not** here. Every form that mounts this also
 * mounts `RepoKeyStatus`, which says so in colour and offers a field to fix
 * it, and saying it twice on one screen is the same noise as saying it about
 * everything.
 */
export function advisoriesFor(
  entries: (RepoCatalogEntry | undefined)[],
  dateFrom: string,
  dateTo: string,
): SourceAdvisory[] {
  const out: SourceAdvisory[] = [];
  for (const entry of entries) {
    if (!entry || !entry.constraints) continue;
    const window = windowSentence(entry, dateFrom, dateTo);
    const notices = entry.constraints.notices.map((n) => ({ kind: n.kind, effect: n.effect }));
    if (!window && notices.length === 0) continue;
    out.push({ slug: entry.slug, name: entry.name, window, notices });
  }
  return out;
}
