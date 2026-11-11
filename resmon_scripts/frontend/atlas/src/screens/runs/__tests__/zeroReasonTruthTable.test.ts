/**
 * Atlas's half of the two-sided guard on the zero-reason rule.
 *
 * `zero_reason.answered` and `source_coverage.outcome` decide whether a
 * source replied; the run page applies the same rule itself while a run is
 * live, where a `repo_done` event carries a reason slug and no
 * classification (`outcomeOf` in `../model`). The backend writes every input
 * the rule can be handed, with its verdict, to
 * `verification_scripts/fixtures/zero_reason_truth_table.json`, and
 * `test_zero_reason_truth_table.py` fails if the live Python disagrees with
 * the file. This fails if Atlas does: every row a source reported `ok` must
 * come out of `outcomeOf` in the category the backend gave it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { outcomeOf } from '../model';

const TABLE = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'verification_scripts', 'fixtures', 'zero_reason_truth_table.json');

interface Table { columns: string[]; rows: unknown[][] }

test('every ok row of the backend\'s truth table is classified as the backend classifies it', () => {
  const table = JSON.parse(fs.readFileSync(TABLE, 'utf8')) as Table;
  expect(table.columns).toEqual(['status', 'result_count', 'zero_reason', 'answered', 'category']);
  const ok = table.rows.filter((row) => row[0] === 'ok');
  expect(ok.length).toBeGreaterThan(20);
  const disagreements = ok
    .map(([, count, reason, , category]) => ({ count, reason, backend: category, atlas: outcomeOf(count as number, reason as string | null) }))
    .filter((row) => row.atlas !== row.backend);
  expect(disagreements).toEqual([]);
});
