/**
 * Health: whether the watching is intact, in the engine's own words.
 *
 * The Source wall arrives classified, and every word it draws is served with
 * it: the state of each cell, its label and sentence, the legend, the verdict
 * and the notes. This file adds only what a screen needs on top: a mark for
 * each state, the window in a sentence, and the runs grouped by day. It never
 * re-derives a state from a status, which is the mistake the wall exists to
 * stop being made in more than one place.
 */
import type { components } from '../../api/schema';

export type Wall = components['schemas']['SourceWall'];
export type WallRun = components['schemas']['SourceWallRun'];
export type WallSource = components['schemas']['SourceWallSource'];
export type WallCell = components['schemas']['SourceWallCell'];
export type WatchdogReport = components['schemas']['WatchdogReport'];
export type WatchdogFinding = components['schemas']['WatchdogFinding'];
export type WatchdogUnjudged = components['schemas']['WatchdogUnjudged'];

export const WATCHDOG_KEY = ['watchdog'] as const;

/** The runs a wall can show, as the engine bounds them (`source_wall.MAX_RUNS` is 50). */
export const WALL_SPANS = [12, 24, 48] as const;

/**
 * One mark per state, so no two states can be told apart only by color: an
 * answer is a point, an empty answer a ring, a failure a struck circle, a
 * source that could not be asked a dotted ring, a gap in the record a dash,
 * and a source the run did not ask nothing at all. A state this build does not
 * know is drawn as a square rather than as one of these.
 */
export const MARK: Record<string, string> = {
  answered: 'point',
  answered_empty: 'ring',
  failed: 'struck',
  could_not_be_asked: 'dotted',
  not_recorded: 'dash',
  not_selected: 'blank',
};

export function markOf(state: string): string {
  return MARK[state] ?? 'unknown';
}

/** "Showing 12 of 40 recorded runs." */
export function windowSentence(window: Wall['window']): string {
  return `Showing ${window.returned} of ${window.runs_available} recorded ${window.runs_available === 1 ? 'run' : 'runs'}`;
}

/** A point's radius for an answer: grows with the count, by area, within the cell. */
export function pointRadius(count: number | null | undefined, largest: number): number {
  if (!count || count <= 0 || largest <= 0) return 2.5;
  return 2.5 + 3.5 * Math.sqrt(Math.min(count, largest) / largest);
}

const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/** The engine's timestamps as instants: a zone-less one is UTC, as SQLite writes it. */
export function instantOf(stamp: string | null | undefined): Date | null {
  if (!stamp) return null;
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp.replace(' ', 'T')}Z`;
  const at = new Date(zoned);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The runs as day groups for the header: each day once, spanning its runs. */
export function runDays(runs: readonly WallRun[]): { day: string; span: number }[] {
  const days: { day: string; span: number }[] = [];
  for (const run of runs) {
    const at = instantOf(run.started_at);
    const day = at ? DAY.format(at) : 'Not recorded';
    const last = days[days.length - 1];
    if (last && last.day === day) last.span += 1;
    else days.push({ day, span: 1 });
  }
  return days;
}

export function runTime(run: WallRun): string {
  const at = instantOf(run.started_at);
  return at ? TIME.format(at) : 'time not recorded';
}

export function runWhen(run: WallRun): string {
  const at = instantOf(run.started_at);
  return at ? `${DAY.format(at)}, ${TIME.format(at)}` : 'a time not recorded';
}

/**
 * Where a source's condition can be read from: its newest cell that is not a
 * silence, as the engine's `latest_known_state` is computed, with the run it
 * belongs to. `null` when every cell is a silence.
 */
export function lastAsked(source: WallSource, runs: readonly WallRun[]): { cell: WallCell; run: WallRun } | null {
  for (let i = source.cells.length - 1; i >= 0; i -= 1) {
    const cell = source.cells[i];
    const run = runs[i];
    if (cell && run && cell.state !== 'not_recorded' && cell.state !== 'not_selected') return { cell, run };
  }
  return null;
}

/** The largest count any answer on the wall carries, for scaling its points. */
export function largestCount(wall: Wall): number {
  let largest = 0;
  for (const source of wall.sources) {
    for (const cell of source.cells) {
      if (cell.state === 'answered' && (cell.result_count ?? 0) > largest) largest = cell.result_count ?? 0;
    }
  }
  return largest;
}

// — the watchdog ---------------------------------------------------------------

export const SEVERITY_WORDS: Record<string, string> = {
  broken: 'Broken',
  unusual: 'Looks unusual',
  advice: 'Advice',
};

/**
 * Under each severity, what it rests on: the difference between the two
 * alarms is stated, not left to a color, because only one of them is resmon
 * being certain.
 */
export const SEVERITY_MEANING: Record<string, string> = {
  broken: 'resmon recorded this happening. It is not an inference.',
  unusual: 'A departure from your own history. There may be an innocent reason.',
  advice: 'Nothing is wrong. Worth considering.',
};

/**
 * The names withdrawn sources were shown under, as `api_registry.RETIRED_NAMES`
 * keeps them. The catalog no longer lists a withdrawn source, but runs saved
 * before it went still name it, and the watchdog still reports on them;
 * `health.test.ts` holds this copy to the engine's.
 */
export const RETIRED_NAMES: Readonly<Record<string, string>> = {
  ieee: 'IEEE Xplore',
  oapen: 'OAPEN Library',
  repec: 'RePEc/IDEAS',
  ssrn: 'SSRN',
};

/** A source by the name it is shown under: the catalog's, else the one it was withdrawn under, else its key. */
export function sourceName(slug: string, names: ReadonlyMap<string, string>): string {
  return names.get(slug) ?? RETIRED_NAMES[slug] ?? slug;
}

/** "Source · arXiv", "Watch · Perovskite stability": a finding's scope, as its card names it. */
export function scopeWords(scope: Record<string, unknown>, names: ReadonlyMap<string, string>): string {
  const id = String(scope.id ?? '');
  const name = typeof scope.name === 'string' && scope.name ? scope.name : null;
  if (scope.type === 'source') return `Source · ${name ?? sourceName(id, names)}`;
  if (scope.type === 'routine') return `Watch · ${name ?? id}`;
  return `${String(scope.type ?? 'Scope')} · ${name ?? id}`;
}

/** A finding about a source the engine words by its key, as its card shows it. */
export interface FindingWords {
  title: string;
  detail: string;
  what_to_do: string;
  /** A withdrawn source: resmon declines to ask it, so its runs in a row are not failures. */
  withdrawn: boolean;
}

/**
 * A finding's sentences with its source called by name. The engine writes a
 * source finding's title, detail, and advice around the source's key
 * (`semantic_scholar has failed on its last 4 runs`); the card says
 * "Semantic Scholar". Only the finding's own source is renamed, and only where
 * its key stands as a word of its own: never inside an address or a longer
 * name (`export.arxiv.org`, `arxiv_id`).
 */
export function findingWords(finding: Pick<WatchdogFinding, 'scope' | 'kind' | 'title' | 'detail' | 'what_to_do' | 'evidence'>,
  names: ReadonlyMap<string, string>): FindingWords {
  const scope = finding.scope as Record<string, unknown>;
  const slug = scope.type === 'source' ? String(scope.id ?? '') : '';
  const withdrawn = !!slug && finding.kind === 'source_errors'
    && (slug in RETIRED_NAMES || (finding.evidence as Record<string, unknown>).last_zero_reason === 'retired');
  const name = slug ? sourceName(slug, names) : '';
  if (!slug || name === slug) return { title: finding.title, detail: finding.detail, what_to_do: finding.what_to_do, withdrawn };
  const key = new RegExp(`(?<![\\w./-])${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-]|\\.\\w)`, 'g');
  const named = (text: string) => text.replace(key, name);
  return { title: named(finding.title), detail: named(finding.detail), what_to_do: named(finding.what_to_do), withdrawn };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The sentence at the top of the Watchdog. With no history it says there is
 * nothing to check yet, never that nothing is wrong: the second is a claim a
 * watchdog with nothing to go on has not earned. Muted findings are not
 * alarms, and advice never is.
 */
export function watchdogVerdict(report: WatchdogReport): { level: 'unknown' | 'clear' | 'alarm'; headline: string; detail: string } {
  const over = `${plural(report.watching.sources, 'source', 'sources')} and ${plural(report.watching.routines, 'active watch', 'active watches')}`;
  if (!report.sufficient) {
    return {
      level: 'unknown',
      headline: 'Nothing to check yet.',
      detail: 'The watchdog compares each source and watch with its own history, and there is no history here yet. It starts from the first run.',
    };
  }
  const { broken, unusual } = report.counts;
  if (broken === 0 && unusual === 0) {
    return {
      level: 'clear',
      headline: `None of the watchdog’s checks found anything, over ${over}.`,
      detail: 'No source has failed run after run, no watch is overdue, and nothing has departed from its usual pattern.',
    };
  }
  const parts: string[] = [];
  if (broken) parts.push(`${broken} ${broken === 1 ? 'thing is' : 'things are'} broken`);
  if (unusual) parts.push(`${unusual} ${unusual === 1 ? 'looks' : 'look'} unusual`);
  return { level: 'alarm', headline: `${parts.join(', and ')}.`, detail: `Checked over ${over}.` };
}

/** The thresholds every rule was judged against, in words, so "3 runs" reads as a rule and not a coincidence. */
export function thresholdWords(t: WatchdogReport['thresholds']): string[] {
  return [
    `A source is broken after ${plural(t.consecutive_errors, 'failed run', 'failed runs')} in a row.`,
    `A source that used to return papers looks unusual after ${plural(t.consecutive_zeros, 'empty run', 'empty runs')} in a row, once it has ${plural(t.min_baseline_runs, 'run', 'runs')} of history.`,
    `A watch that used to find papers looks unusual after ${plural(t.flatline_runs, 'run', 'runs')} with nothing new.`,
    `A watch is overdue once it has been quiet for more than ${t.overdue_cadence_multiple} times its usual gap between runs, and for at least ${plural(t.overdue_floor_days, 'day', 'days')}, once it has ${plural(t.min_runs_for_cadence, 'completed run', 'completed runs')} to measure that gap from.`,
    `A watch is broken when a scheduled run did not happen in the last ${plural(t.skipped_fires_window_days, 'day', 'days')} because the run before it was still going.`,
  ];
}
