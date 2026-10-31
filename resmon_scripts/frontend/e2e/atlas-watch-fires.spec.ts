/**
 * Atlas: a scheduled run that did not happen is said where the person looks.
 *
 * A fire refused because the watch's previous run was still going used to
 * reach only the engine log. The engine now records it as a skipped missed
 * fire, and this spec seeds two such fires (as the engine writes them) on a
 * watching watch, then reads them where a person would: the watch's page,
 * which says so and opens its Schedule tab; the Schedule tab, which words each
 * fire; the list of watches; and the Watchdog, which calls the watch broken.
 * The fire times are fixed instants this week, never "N hours ago".
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const SEED = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import init_db, get_connection, insert_routine, record_missed_fire
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
routine = insert_routine(conn, {"name": "Hourly agents", "schedule_cron": "0 * * * *", "is_active": 1,
    "parameters": json.dumps({"repositories": ["arxiv"], "keywords": ["agents"], "query": "agents"})})
# Two fires this week, at whole local hours two and three days back: fixed times, not "N hours ago".
local = datetime.now().astimezone().replace(minute=0, second=0, microsecond=0, hour=8)
for days in (3, 2):
    due = (local - timedelta(days=days)).astimezone(timezone.utc).isoformat()
    record_missed_fire(conn, routine, due, disposition="skipped")
conn.commit()
print(json.dumps({"routine": routine}))
`;

test('a skipped scheduled run is said on the watch, its schedule, the list, and the Watchdog', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-watch-fires-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { routine } = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { routine: number };

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 60_000 });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    await win.evaluate(() => { window.location.hash = '#/watches'; });
    const row = win.locator(`.watch[data-routine="${routine}"]`);
    await expect(row.locator('[data-watch="skipped-fires"]')).toHaveText('2 fires skipped: the run before was still going',
      { timeout: 30_000 });

    await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, routine);
    const note = win.locator('[data-watch="skipped-fires"]');
    await expect(note).toHaveAttribute('data-skipped', '2', { timeout: 30_000 });
    await expect(note).toContainText('2 scheduled runs did not happen because the run before was still going; the last was due ');
    await expect(note).toContainText('resmon does not run a skipped fire later, so this watch runs less often than its schedule says.');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-skipped-fires.png') });

    await note.getByRole('button', { name: 'See its schedule' }).click();
    await expect(win.getByRole('tab', { name: 'Schedule' })).toHaveAttribute('aria-selected', 'true');
    await expect(win.getByRole('tab', { name: 'Schedule' })).toBeFocused();
    const fires = win.locator('.missed-list li');
    await expect(fires).toHaveCount(2);
    await expect(fires.locator('[data-disposition="skipped"]').first()).toHaveText('did not run: the run before it was still going');

    await win.evaluate(() => { window.location.hash = '#/health/watchdog'; });
    const finding = win.locator(`.finding[data-key="routine_fires_skipped:${routine}"]`);
    await expect(finding).toHaveAttribute('data-severity', 'broken', { timeout: 30_000 });
    await expect(finding.locator('.finding-title')).toHaveText("'Hourly agents' did not run 2 times it was due in the last 7 days");
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watchdog-skipped-fires.png') });

    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});
