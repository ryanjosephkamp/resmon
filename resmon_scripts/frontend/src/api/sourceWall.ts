/**
 * The source wall's HTTP surface and its vocabulary.
 *
 * `GET /api/coverage/source-wall` serves cells that are **already
 * classified**: each one carries a state from `source_wall.WALL_STATES` and
 * the backend's own sentence for it. Nothing in this module looks at a status
 * and a zero reason and decides again what they mean. That rule is the
 * feature: every place that has re-derived this classification has eventually
 * derived it differently, and the last copy put a tick on sources that had
 * never been asked.
 *
 * So what lives here is the one thing the backend has no opinion about: the
 * glyph each state is drawn with. **The words are not here.** The legend
 * arrives on the payload as `state_legend`, because a renderer holding its
 * own name for a backend state is the copy that put a tick on sources that
 * had never been asked, and a legend is that copy wearing a different hat.
 * The test beside this file asserts the glyphs are distinct, because the
 * whole screen rests on six states a person can tell apart.
 */
import { apiClient } from './client';

/**
 * The six states a cell can hold — `source_wall.WALL_STATES`, in its order.
 *
 * Five were the approved concept. `not_selected` is the sixth, and it is here
 * because the stored data distinguished something the concept did not: a
 * run's saved selection records which sources the user asked, so "I did not
 * ask this one" and "I asked and do not know what happened" are both on disk.
 * One is a choice, the other is a hole in the record, and they get different
 * marks.
 */
export const WALL_STATE_ORDER = [
  'answered',
  'answered_empty',
  'could_not_be_asked',
  'failed',
  'not_recorded',
  'not_selected',
] as const;

export type WallState = typeof WALL_STATE_ORDER[number];

/**
 * The glyph each state is drawn with — the renderer's one contribution to
 * this vocabulary, and the reason the screen works in three channels at once.
 *
 * Color is one of them and is never the only one. A screen whose states
 * differ only in hue is unreadable to roughly one man in twelve, and this one
 * is a status instrument — if the marks are ambiguous the screen is worse
 * than nothing, because it reads as reassurance.
 *
 * * **glyph** — here, asserted distinct across all six by the test.
 * * **fill** — solid, ring, hatched or empty, set in CSS from `data-state`.
 * * **color** — a custom property, saturated only for the four states that
 *   say something; the two silent states have no saturation at all, because
 *   neither of them is a verdict.
 *
 * The *word* for each state is not here. It comes from `state_legend` on the
 * payload.
 */
export const STATE_MARKS: Record<WallState, string> = {
  answered: '\u25CF',            // filled disc
  answered_empty: '\u25CB',      // ring
  could_not_be_asked: '\u2298',  // slashed circle, on a hatched cell
  failed: '\u2715',              // cross
  not_recorded: '\u00B7',        // faint dot, on a dotted cell
  not_selected: '\u2013',        // en dash, on an unmarked cell
};

/**
 * A state the backend served that this build has no mark for.
 *
 * It resolves to `not_recorded` rather than to anything with a verdict in it.
 * An older renderer meeting a newer backend must fail towards "resmon does
 * not know", which is the same direction `source_coverage.outcome` fails in.
 */
export function knownState(state: string): WallState {
  return (WALL_STATE_ORDER as readonly string[]).includes(state)
    ? (state as WallState)
    : 'not_recorded';
}

/** One source's recorded answer to one run. */
export interface WallCell {
  execution_id: number;
  state: WallState;
  /** `source_coverage.outcome`'s short label, unedited. */
  label: string;
  /** The backend's full sentence for this outcome, unedited. */
  note: string;
  result_count: number | null;
  status: string | null;
  zero_reason: string | null;
  partial: boolean;
  outcome_recorded: boolean;
  /** Whether the run's saved selection named this source; null when unknown. */
  in_selection: boolean | null;
}

/** One column: a run. */
export interface WallRun {
  execution_id: number;
  execution_type: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  label: string;
}

/** One row: a source, with one cell per run in the same order as `runs`. */
export interface WallSource {
  slug: string;
  name: string;
  in_catalog: boolean;
  cells: WallCell[];
  counts: Record<WallState, number>;
  latest_known_state: WallState | null;
}

/** One row of the key, composed by the backend — `source_wall.STATE_LEGEND`. */
export interface WallLegendEntry {
  state: string;
  label: string;
  meaning: string;
}

/** What the verdict line at the top says, composed by the backend. */
export interface WallVerdict {
  level: 'ok' | 'attention' | 'unknown' | 'empty';
  headline: string;
  detail: string[];
}

export interface SourceWallGrid {
  runs: WallRun[];
  sources: WallSource[];
  states: string[];
  state_legend: WallLegendEntry[];
  totals: Record<WallState, number>;
  verdict: WallVerdict;
  window: { requested: number; returned: number; max: number; runs_available: number };
  notes: string[];
}

/** The last `limit` runs. The backend clamps; this does not second-guess it. */
export function fetchSourceWall(limit: number): Promise<SourceWallGrid> {
  return apiClient.get<SourceWallGrid>(`/api/coverage/source-wall?limit=${limit}`);
}
