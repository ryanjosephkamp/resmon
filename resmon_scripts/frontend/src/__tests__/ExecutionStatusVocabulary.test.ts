/**
 * The renderer's execution-status vocabulary against the database's.
 *
 * `TERMINAL_STATUSES` decides when the monitor stops treating a run as live.
 * It was a hand-written copy of the `executions.status` CHECK, so a status
 * added to the schema and not to the array would have left the renderer
 * showing a finished execution as still running — the exact overclaim the
 * status column exists to end — with every test still green.
 *
 * This test reads `database.py` as **text** and parses the CHECK values out of
 * the DDL string. It deliberately does not import or execute Python: the
 * renderer suite is jsdom under Jest with no interpreter available, and a
 * subprocess would make a renderer unit test depend on the backend virtualenv.
 * The cost is stated plainly — this checks the DDL *string literal*, not the
 * schema of a database that has actually been migrated. `test_cumulative_upgrade.py`
 * on the backend side is what proves the string and a real upgraded database
 * agree.
 */

import fs from 'fs';
import path from 'path';

import {
  CLIENT_ONLY_EXECUTION_STATUSES,
  EXECUTION_DB_STATUSES,
  RUNNING_STATUS,
  TERMINAL_STATUSES,
} from '../context/executionStatus';

/** frontend/src/__tests__ → resmon_scripts/implementation_scripts/database.py */
const DATABASE_PY = path.resolve(
  __dirname, '../../../implementation_scripts/database.py',
);

/** The DDL string the v19 executions table is created from. */
const DDL_CONSTANT = '_EXECUTIONS_V19_DDL';

function statusCheckValues(): string[] {
  const source = fs.readFileSync(DATABASE_PY, 'utf8');
  const start = source.indexOf(`${DDL_CONSTANT} = (`);
  expect(start).toBeGreaterThan(-1);
  // The DDL is a parenthesised run of adjacent string literals; the closing
  // "\n)" at column zero ends it.
  const end = source.indexOf('\n)', start);
  expect(end).toBeGreaterThan(start);
  const ddl = source.slice(start, end);

  const check = /status TEXT NOT NULL DEFAULT '[a-z_]+' CHECK\(status IN \(([^)]*)\)\)/
    .exec(ddl);
  expect(check).not.toBeNull();
  return (check as RegExpExecArray)[1]
    .split(',')
    .map((value) => value.trim().replace(/^'|'$/g, ''))
    .filter((value) => value.length > 0);
}

describe('execution status vocabulary', () => {
  it('finds the CHECK values in the DDL it claims to mirror', () => {
    // Guards the parse itself: a rename or a reformat of the DDL must fail
    // loudly here rather than silently yield an empty list that matches
    // nothing and asserts nothing.
    const values = statusCheckValues();
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(values).toContain(RUNNING_STATUS);
  });

  it('declares exactly the statuses the executions CHECK allows', () => {
    expect([...EXECUTION_DB_STATUSES].sort())
      .toEqual([...statusCheckValues()].sort());
  });

  it('treats every stored status but running as terminal', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      statusCheckValues().filter((value) => value !== RUNNING_STATUS).sort(),
    );
    expect(TERMINAL_STATUSES).not.toContain(RUNNING_STATUS);
  });

  it('keeps the renderer-only word out of the database vocabulary', () => {
    // `cancelling` is set locally between the cancel request and the backend's
    // answer. If it ever reached the CHECK list this test would be comparing
    // two things that are no longer the same thing.
    const stored = statusCheckValues();
    CLIENT_ONLY_EXECUTION_STATUSES.forEach((status) => {
      expect(stored).not.toContain(status);
      expect(EXECUTION_DB_STATUSES as readonly string[]).not.toContain(status);
    });
  });
});
