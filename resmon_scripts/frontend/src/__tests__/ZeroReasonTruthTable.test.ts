/**
 * The renderer half of the two-sided guard on the zero-reason rule.
 *
 * `zeroReasonVocabulary.ts` is generated from `zero_reason.py` and
 * byte-compared, so the renderer can no longer hold a *word* the backend does
 * not. It could still hold a *rule* the backend does not, and it did:
 * `api/zeroReason.ts` opens its `answered` with the word "transcribed", and
 * the gap was measured exactly — change `zero_reason.answered` so
 * `not_recorded` comes back `True` and every renderer test stayed green. That
 * is the defect that put a tick on seven sources for months, one level up
 * from the vocabulary that was already fixed.
 *
 * So the rule is enumerated instead. `verification_scripts/
 * zero_reason_truth_table.py` runs the live `zero_reason.answered` and
 * `source_coverage.outcome` over every status / count / reason the renderer
 * can be handed and commits the verdicts; this file replays that table
 * through `api/zeroReason.ts` and fails on the first input the two disagree
 * about.
 *
 * **Two guards, and it has to be two.** A fixture only the renderer reads
 * goes stale the instant the Python changes, which is the generated-
 * vocabulary blind spot moved up a level rather than closed.
 * `test_zero_reason_truth_table.py` regenerates this same file from the live
 * functions and fails if it drifted, so a backend change reddens the backend
 * job and a renderer change reddens this one. Neither goes green alone, and
 * the fixture cannot be edited into agreement with either side.
 *
 * **Nothing here writes a verdict down.** Not one `expect(...).toBe('answered')`
 * naming an input. A third transcription of the rule, in the file whose
 * subject is that there are too many transcriptions of the rule, would be the
 * defect wearing the costume of the fix. Everything asserted is "the table
 * says X; this module says X".
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  DID_NOT_ANSWER, RECORDED_STATUSES, ZERO_REASONS, answered, outcomeCategory,
} from '../api/zeroReason';

/** The committed table. The Python guard owns its contents; this reads them. */
const FIXTURE_PATH = path.resolve(
  __dirname, '..', '..', '..', 'verification_scripts', 'fixtures',
  'zero_reason_truth_table.json',
);

type Cell = string | number | boolean | null;

interface TruthTable {
  columns: string[];
  axes: {
    recorded_statuses: string[];
    statuses: string[];
    result_counts: number[];
    zero_reasons: string[];
    reasons: (string | null)[];
  };
  counts: { grid_rows: number; invalid_input_rows: number };
  rows: Cell[][];
  invalid_input_rows: Cell[][];
}

const table: TruthTable = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

/**
 * The table holds inputs the signatures refuse on purpose — a boolean status,
 * a string count, a numeric reason. Those are exactly the rows worth having:
 * the compiler is not what is between a malformed database row and the grid.
 * `as unknown as` rather than `any`, so the widening is per-call and visible.
 */
const asStatus = (value: Cell): string | null => value as unknown as string | null;
const asCount = (value: Cell): number | null => value as unknown as number | null;
const asReason = (value: Cell): string | null => value as unknown as string | null;

/** One row, printed the way the fixture prints it, for a failure message. */
const show = (row: Cell[]): string => JSON.stringify(row);

/**
 * Every row of both blocks, replayed. One assertion over the whole list
 * rather than 221 cases, so a failure names every divergence at once instead
 * of stopping at the first and hiding the shape of the drift.
 */
function disagreements(rows: Cell[][]): string[] {
  const found: string[] = [];
  for (const row of rows) {
    const [status, count, reason, wantAnswered, wantCategory] = row;
    const gotAnswered = answered(asStatus(status), asCount(count), asReason(reason));
    const gotCategory = outcomeCategory(asStatus(status), asCount(count), asReason(reason));
    if (gotAnswered !== wantAnswered) {
      found.push(`${show(row)}: answered is ${gotAnswered}, the backend says ${wantAnswered}`);
    }
    if (gotCategory !== wantCategory) {
      found.push(`${show(row)}: category is "${gotCategory}", the backend says "${wantCategory}"`);
    }
  }
  return found;
}

describe('the renderer reproduces the backend classification, input for input', () => {
  test('the table is the shape this file reads, and all of it is here', () => {
    // A reordered column would silently re-point every assertion below at the
    // wrong value, and a truncated file would make the suite pass by having
    // nothing to disagree with. Both are cheap to rule out and neither is
    // visible in a green run otherwise.
    expect(table.columns).toEqual(
      ['status', 'result_count', 'zero_reason', 'answered', 'category']);
    expect(table.rows).toHaveLength(table.counts.grid_rows);
    expect(table.invalid_input_rows).toHaveLength(table.counts.invalid_input_rows);
    expect(table.counts.grid_rows).toBe(
      table.axes.statuses.length * table.axes.result_counts.length
      * table.axes.reasons.length);
  });

  test('the grid: every recognized status, count and reason', () => {
    expect(disagreements(table.rows)).toEqual([]);
  });

  test('the invalid inputs: wrong kind on one axis at a time', () => {
    // The gate this classification was missing is exactly what a
    // valid-rows-only table walks straight past, and that gate was itself a
    // review finding. An unrecognized slug reaches `answered` as *yes*; only
    // the categorizer refusing the row keeps it off the screen as a tick.
    expect(disagreements(table.invalid_input_rows)).toEqual([]);
  });

  test('the axes the renderer still names itself are the backend’s axes', () => {
    // `RECORDED_STATUSES` is the one set in `zeroReason.ts` that is still
    // written out by hand rather than generated. The table's rows would catch
    // a status *added* to the backend — it would arrive classified and this
    // module would call it unknown — but not one *removed*, because the rows
    // for it simply disappear. This closes that direction.
    expect([...RECORDED_STATUSES].sort()).toEqual([...table.axes.recorded_statuses].sort());
    expect([...ZERO_REASONS]).toEqual(table.axes.zero_reasons);
    // The generated vocabulary and the enumerated rule have to be describing
    // the same taxonomy, or one of the two guards is measuring a stale set.
    for (const reason of DID_NOT_ANSWER) {
      expect(table.axes.zero_reasons).toContain(reason);
    }
  });

  test('an absent reason and an absent count behave the same as a null one', () => {
    // Python has no `undefined`, so the table cannot carry a row for it and
    // this is the one property asserted against the module rather than
    // against the backend. The three arguments all accept `undefined` in
    // their signatures, every caller in the renderer can supply it, and a
    // `repo_done` event with no `zero_reason` key is the ordinary way it
    // arrives.
    const nulls = table.rows
      .filter((row) => row[2] === null)
      .map((row) => [row[0], row[1], row[4]] as [Cell, Cell, Cell]);
    expect(nulls.length).toBeGreaterThan(0);
    for (const [status, count, category] of nulls) {
      expect(outcomeCategory(asStatus(status), asCount(count), undefined)).toBe(category);
      expect(answered(asStatus(status), asCount(count), undefined))
        .toBe(answered(asStatus(status), asCount(count), null));
    }
    expect(outcomeCategory('ok', undefined, 'answered_empty'))
      .toBe(outcomeCategory('ok', null, 'answered_empty'));
  });
});
