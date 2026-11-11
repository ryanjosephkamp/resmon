/**
 * Atlas's run statuses against the database's.
 *
 * `executions.status` is constrained by a CHECK in the newest executions DDL
 * in `database.py`, read here as text (no interpreter runs under Jest; the
 * backend's own upgrade tests hold the text to a migrated database). Atlas
 * treats a run as going while its status is `running` and as ended
 * otherwise (`endedRuns`), and offers Restart for some ended ones
 * (`RESTARTABLE`). A status added to the schema and not to that split would
 * keep a finished run looking live, or a live one looking finished.
 */
import * as fs from 'fs';
import * as path from 'path';
import { RESTARTABLE } from '../model';
import { endedRuns } from '../../today/freshness';

const DATABASE = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'implementation_scripts', 'database.py');

function databaseStatuses(): string[] {
  const source = fs.readFileSync(DATABASE, 'utf8');
  const versions = [...source.matchAll(/^_EXECUTIONS_V(\d+)_DDL = \(/gm)].map((m) => Number(m[1]));
  if (versions.length === 0) throw new Error('database.py declares no _EXECUTIONS_V<n>_DDL');
  const name = `_EXECUTIONS_V${Math.max(...versions)}_DDL`;
  const start = source.indexOf(`${name} = (`);
  const ddl = source.slice(start, source.indexOf('\n)', start));
  const check = /status TEXT NOT NULL DEFAULT '[a-z_]+' CHECK\(status IN \(([^)]*)\)\)/.exec(ddl);
  if (!check) throw new Error(`${name} has no status CHECK this test can read`);
  return check[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

test('every status the database allows is either going or ended, and only running is going', () => {
  const statuses = databaseStatuses();
  expect(statuses).toContain('running');
  const runs = statuses.map((status, id) => ({ id, status }));
  const ended = endedRuns(runs).split(',').filter(Boolean).map(Number);
  expect(ended.map((id) => statuses[id]).sort()).toEqual(statuses.filter((s) => s !== 'running').sort());
});

test('Restart is offered only for statuses the database has, and never for a run going or done', () => {
  const statuses = databaseStatuses();
  expect([...RESTARTABLE].filter((status) => !statuses.includes(status))).toEqual([]);
  expect(RESTARTABLE.has('running')).toBe(false);
  expect(RESTARTABLE.has('completed')).toBe(false);
});
