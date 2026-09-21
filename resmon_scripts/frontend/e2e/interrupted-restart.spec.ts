/**
 * The Interrupted badge, its reason, and Restart — in a real window.
 *
 * Schema 19 gave `executions` an `interrupted` status and an
 * `interrupted_reason`, and the renderer renders both. Every check on that
 * until now has been either a backend test over a database or a jsdom test
 * over a prop: nothing had opened the real Results page on a real interrupted
 * row and clicked the button.
 *
 * **Why the row is seeded through Python rather than produced.** No API route
 * writes `interrupted`. The status is set in exactly two places, both in
 * `resmon.py`: the graceful-shutdown hook (`daemon_restart`) and
 * `_reconcile_executions_on_startup` (`owner_dead`, for a `running` row whose
 * owner is gone). Producing one would mean launching the app, starting a run,
 * and closing the app *before the run finishes* — a race with nothing in the
 * app to make it reliably slow, and a timing tolerance is exactly what a spec
 * like this is meant to remove. So the row is written with the shipped
 * helpers — `database.init_db` then `insert_execution` /
 * `update_execution_status` through the checkout's own interpreter — into the
 * spec's own isolated state directory, *before* the app is launched. The seed
 * is real: same schema, same columns, same file the backend then opens. What
 * it deliberately does not establish is how a row comes to be interrupted;
 * `test_daemon.py` and the reconciliation tests own that half.
 *
 * **The restart runs for real.** The seeded row's parameters name no
 * repositories, so the new execution is a genuine sweep that asks nothing and
 * finishes — the spec needs the restart to happen, not a search to succeed,
 * and a spec that reached arXiv would be a spec about arXiv's weather.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchEnv, FRONTEND_ROOT, REPO_ROOT, registerStateDir } from './fixtures/resmon-app';
import { EXPECTED_SCHEMA_VERSION } from './schema';

test.describe.configure({ mode: 'serial' });

/** What the seeded row records, asserted on in the window afterwards. */
const INTERRUPTED_REASON = 'owner_dead';
const LAST_SEEN = '2026-09-20T08:15:00Z';

/**
 * Write one `interrupted` execution into `<stateDir>/resmon.db`.
 *
 * Runs the checkout's interpreter with `implementation_scripts` on the path —
 * the same import the backend does — so the row goes in through
 * `insert_execution` and `update_execution_status` rather than through SQL
 * this file would have to keep in step with the schema. `init_db` first, so
 * the database the app then opens is already current and the app's own
 * `init_db` is a no-op rather than a migration of a half-built file.
 */
function seedInterruptedExecution(stateDir: string, python: string): number {
  const dbPath = path.join(stateDir, 'resmon.db');
  const script = `
import json, os, sqlite3, sys
sys.path.insert(0, os.path.join(${JSON.stringify(REPO_ROOT)}, 'resmon_scripts'))
from implementation_scripts import database

conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.row_factory = sqlite3.Row
try:
    database.init_db(conn=conn)
    exec_id = database.insert_execution(conn, {
        "execution_type": "deep_dive",
        "parameters": json.dumps({"query": "perovskite stability", "repositories": []}),
        "start_time": database.utc_now_iso(),
        # A pid that is not this process and not the backend's: the row is a
        # leftover from an owner that is gone, which is what 'owner_dead' means.
        "owner_pid": 0,
        "last_seen_at_utc": ${JSON.stringify(LAST_SEEN)},
    })
    database.update_execution_status(
        conn, exec_id, "interrupted",
        interrupted_reason=${JSON.stringify(INTERRUPTED_REASON)},
        end_time=database.utc_now_iso(),
    )
    conn.commit()
    print(exec_id)
finally:
    conn.close()
`;
  const out = execFileSync(python, ['-c', script], { encoding: 'utf8', cwd: REPO_ROOT });
  const id = Number(out.trim().split('\n').pop());
  expect(Number.isInteger(id) && id > 0, `seed did not return an execution id: ${out}`).toBe(true);
  return id;
}

interface Launched { app: ElectronApplication; win: Page; stateDir: string; seeded: number; close: () => Promise<void>; }

async function launchOverSeededState(): Promise<Launched> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-interrupted-'));
  const env = launchEnv(stateDir, true);
  if (env.RESMON_PYTHON && !path.isAbsolute(env.RESMON_PYTHON)) {
    try {
      env.RESMON_PYTHON = execFileSync(
        process.platform === 'win32' ? 'where' : 'which',
        [env.RESMON_PYTHON], { encoding: 'utf8' },
      ).split('\n')[0].trim();
    } catch { /* the launch failure below will say so */ }
  }
  const seeded = seedInterruptedExecution(stateDir, env.RESMON_PYTHON);
  registerStateDir(stateDir);
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, timeout: 180_000,
  });
  const win = await app.firstWindow({ timeout: 180_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
  return {
    app, win, stateDir, seeded,
    close: async () => {
      await app.close().catch(() => { /* already gone */ });
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test('an interrupted run shows its reason on Results, and Restart starts a new one', async () => {
  const { win, seeded, close } = await launchOverSeededState();
  try {
    const port = await win.evaluate(
      () => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort(),
    );
    expect(port, 'the e2e app must never attach to the live daemon').not.toBe('8742');
    const base = `http://127.0.0.1:${port}`;

    // The backend opened the seeded database rather than creating its own, and
    // it is the schema this branch's `database.py` describes.
    const health = await e2eFetch(`${base}/api/health`).then((r) => r.json());
    expect(health.identity.schema_version).toBe(EXPECTED_SCHEMA_VERSION);

    await win.evaluate(() => { window.location.hash = '#/results'; });
    await win.locator('.results-list').waitFor({ state: 'visible', timeout: 30_000 });

    // The badge is the stored word, and the note underneath says *why* and
    // when the run was last seen working — the two facts that separate "this
    // stopped" from "this failed".
    const row = win.locator('tr', { hasText: `Execution #${seeded}` });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.locator('.badge', { hasText: 'interrupted' })).toBeVisible();
    const note = win.getByTestId(`interrupted-note-${seeded}`);
    await expect(note).toBeVisible();
    // 'owner_dead' renders as a sentence, not as the stored token.
    await expect(note).toContainText('the process running it stopped');
    await expect(note).toContainText('2026-09-20 08:15');

    // And the filter reaches it: Interrupted is one of the options.
    const statusFilter = win.locator('.results-filters select').nth(1);
    await statusFilter.selectOption('interrupted');
    await expect(row).toBeVisible();

    await win.getByTestId(`restart-${seeded}`).click();

    // The new run is a different execution that records where it came from,
    // read back through the API rather than off the screen.
    await expect.poll(async () => {
      const list = await e2eFetch(`${base}/api/executions?limit=50`).then((r) => r.json());
      return (list as { restarted_from?: number | null }[])
        .filter((e) => e.restarted_from === seeded).length;
    }, { timeout: 30_000 }).toBe(1);

    // Monitor is where the click leaves the user.
    await expect.poll(async () => win.evaluate(() => window.location.hash), { timeout: 15_000 })
      .toContain('/monitor');
    await win.locator('.app-main').waitFor({ state: 'visible' });
  } finally {
    await close();
  }
});
