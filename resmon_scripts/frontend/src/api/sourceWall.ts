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
 * So what lives here is presentation, which the backend has no opinion about:
 * the mark each state is drawn with and the word it is called by. Those are
 * the renderer's to own, and the test beside this file asserts the marks are
 * distinct, because the whole screen rests on five states a person can tell
 * apart.
 */
import { apiClient } from './client';

/** The five states a cell can hold — `source_wall.WALL_STATES`, in its order. */
export const WALL_STATE_ORDER = [
  'answered',
  'answered_empty',
  'could_not_be_asked',
  'failed',
  'not_recorded',
] as const;

export type WallState = typeof WALL_STATE_ORDER[number];

/**
 * How each state is drawn, in three channels at once.
 *
 * Color is one of them and is never the only one. A screen whose five states
 * differ only in hue is unreadable to roughly one man in twelve, and this one
 * is a status instrument — if the marks are ambiguous the screen is worse
 * than nothing, because it reads as reassurance.
 *
 * * **mark** — a distinct glyph per state, asserted distinct by the test.
 * * **fill** — solid, ring, hatched or empty, set in CSS from `data-state`.
 * * **color** — a custom property, saturated only for the four states that
 *   say something; `not_recorded` is the one state with no saturation at all,
 *   because it is the one state that is not a verdict.
 */
export const STATE_MARKS: Record<WallState, { mark: string; name: string; meaning: string }> = {
  answered: {
    mark: '●',
    name: 'answered',
    meaning: 'The source replied and returned records.',
  },
  answered_empty: {
    mark: '○',
    name: 'answered, nothing new',
    meaning: 'The source replied and genuinely had nothing. A quiet field, not a fault.',
  },
  could_not_be_asked: {
    mark: '⊘',
    name: 'could not be asked',
    meaning: 'No key, retired, no author query, or a window the source cannot answer.',
  },
  failed: {
    mark: '✕',
    name: 'failed',
    meaning: 'The source was asked and the exchange broke.',
  },
  not_recorded: {
    mark: '·',
    name: 'not recorded',
    meaning: 'resmon did not observe an outcome. This is not a success and not a failure.',
  },
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
  totals: Record<WallState, number>;
  verdict: WallVerdict;
  window: { requested: number; returned: number; max: number; runs_available: number };
  notes: string[];
}

/** The last `limit` runs. The backend clamps; this does not second-guess it. */
export function fetchSourceWall(limit: number): Promise<SourceWallGrid> {
  return apiClient.get<SourceWallGrid>(`/api/coverage/source-wall?limit=${limit}`);
}
