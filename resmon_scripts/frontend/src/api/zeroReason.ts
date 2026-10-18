/**
 * Did this source answer? One rule, for every surface that asks.
 *
 * The backend decides this in `zero_reason.answered` and categorizes it in
 * `source_coverage.outcome`, and it ships the result on anything it has
 * already finished: `coverage.category` on a search record, `source_outcomes`
 * on a results row. The live Monitor is the one place with no served answer —
 * a `repo_done` event carries the reason slug and the rendered sentence, not a
 * classification — so the renderer has to apply the rule itself there.
 *
 * It used to apply it from a hand-written copy of `DID_NOT_ANSWER` that was
 * missing `entity_unsupported`, and from a second, inverted copy of the same
 * test in the activity log, and from a third partial copy of the label map in
 * the search record. The grid therefore put a green tick — *answered and found
 * nothing* — on the seven of twenty-seven sources that have no author query,
 * next to the backend's own sentence saying they could not be asked, which is
 * precisely the overstated coverage `DID_NOT_ANSWER` exists to prevent.
 *
 * So the vocabulary is no longer written here: `zeroReasonVocabulary.ts` is
 * generated from `zero_reason.py` and guarded by a test that regenerates it.
 * This module adds the rule on top of it and is the only thing the renderer
 * imports. A new surface asks this module; it has nothing to copy.
 */
import { DID_NOT_ANSWER, ZERO_REASONS } from './zeroReasonVocabulary';

export { DID_NOT_ANSWER, ZERO_REASONS };
export type { ZeroReason } from './zeroReasonVocabulary';

/**
 * The three things the backend will say about one source's outcome, named as
 * it names them in `source_coverage.outcome` so the computed value and the
 * served `coverage.category` are the same vocabulary.
 */
export type OutcomeCategory = 'answered' | 'non_answer' | 'unknown';

/**
 * `zero_reason.answered`, transcribed.
 *
 * A non-`ok` status never answered. An `ok` row that returned records did. An
 * `ok` zero depends entirely on why — and a zero with no reason on record is
 * **not** an answer, because "resmon did not observe this" must never render
 * as "the source answered".
 */
export function answered(
  status: string | null | undefined,
  resultCount: number | null | undefined,
  reason: string | null | undefined,
): boolean {
  if (status !== 'ok') return false;
  if ((resultCount ?? 0) > 0) return true;
  if (!reason || reason === 'not_recorded') return false;
  return !DID_NOT_ANSWER.has(reason);
}

/** The statuses a recorded source outcome can hold — `source_coverage.outcome`. */
const RECORDED_STATUSES: ReadonlySet<string> = new Set([
  'ok', 'error', 'skipped_missing_key', 'cancelled',
]);

/**
 * `source_coverage.outcome`'s category, transcribed — validity gate included.
 *
 * The gate is the half that is easy to leave out, and leaving it out points
 * the failure the wrong way. The backend decides first whether the row is
 * one it recognizes at all — a known status, a non-negative count, a reason
 * from `ZERO_REASONS` — and sends everything else to `unknown`. Without that,
 * a slug this build has never heard of falls through to *answered* and draws
 * a tick, which is the one verdict resmon must never reach by accident. A
 * classifier for this product fails towards "resmon does not know".
 */
export function outcomeCategory(
  status: string | null | undefined,
  resultCount: number | null | undefined,
  reason: string | null | undefined,
): OutcomeCategory {
  // The count is checked as it arrived, never defaulted first. `?? 0` here
  // turned "no count was recorded" into "zero records were returned", and
  // with an `ok` status and a known reason that read all the way through to
  // *answered* — the last input where this function reached that verdict by
  // default, in the one function whose subject is that it stops doing so.
  // `source_coverage.outcome` requires a real non-negative integer before it
  // classifies anything, and so does this. A missing count is unknown.
  const recognized = (
    typeof status === 'string' && RECORDED_STATUSES.has(status)
    && typeof resultCount === 'number' && Number.isInteger(resultCount) && resultCount >= 0
    && (!reason || (ZERO_REASONS as readonly string[]).includes(reason))
  );
  if (!recognized) return 'unknown';
  if (answered(status, resultCount, reason)) return 'answered';
  if (status === 'ok' && resultCount === 0 && (!reason || reason === 'not_recorded')) {
    return 'unknown';
  }
  return 'non_answer';
}

/**
 * Did this source keep records and still hit a terminal issue?
 *
 * The engine records a zero reason alongside a positive count in exactly one
 * case: a later page failed after earlier pages had yielded usable records,
 * so the row stays `ok`, the records stay available, and every consumer can
 * see that the retained set may be incomplete. `source_coverage` calls it
 * *answered, partial* — an answer, but not a quiet one.
 */
export function isPartialAnswer(
  resultCount: number | null | undefined,
  reason: string | null | undefined,
): boolean {
  return (resultCount ?? 0) > 0 && !!reason;
}

/**
 * The per-source states the repository grid and the floating widget draw.
 *
 * `pending`, `querying` and `error` come from other events; the four below are
 * the end states the Monitor's own help text promises for a source that came
 * back with nothing.
 */
export type RepoStatus =
  | 'pending' | 'querying' | 'done' | 'no_answer' | 'skipped' | 'not_recorded' | 'error';

/**
 * The grid status for one `repo_done` event.
 *
 * The event is emitted only after a query attempt completed, so the recorded
 * status behind it is `ok`, or `skipped_missing_key` for a source whose key
 * was never configured. Both reach the same category — `missing_key` is in
 * `DID_NOT_ANSWER` either way — so the rule is applied as `ok` and the missing
 * key is separated afterwards, because the help text gives it its own mark:
 * ⊘ *not queried*, the one case where resmon never sent the query at all.
 */
export function repoDoneStatus(
  resultCount: number | null | undefined,
  reason: string | null | undefined,
): RepoStatus {
  switch (outcomeCategory('ok', resultCount, reason)) {
    case 'answered':
      return 'done';
    case 'unknown':
      return 'not_recorded';
    default:
      return reason === 'missing_key' ? 'skipped' : 'no_answer';
  }
}
