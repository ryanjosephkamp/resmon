/**
 * The stage's place, in the real app: scrolled far down a long run history,
 * Health and then Analytics open at their tops; Back puts the history where it
 * was left, the same run at the same height though the list draws its rows
 * again, and Forward puts Health back at its top.
 *
 * Nothing leaves this machine: the runs are written into the spec's own
 * database before the app starts, and no search is run.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { ATLAS_LANDMARK, FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';

const mac = process.platform === 'darwin';
const MOD = mac ? 'Meta' : 'Control';
const RUNS = 240;

async function launch(stateDir: string, seed = false): Promise<{ app: ElectronApplication; win: Page; problems: string[] }> {
  const env = atlasEnv(launchEnv(stateDir, true));
  if (seed) {
    // Finished runs, enough for a history several screens long.
    execFileSync(env.RESMON_PYTHON!, ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import database
conn = database.get_connection(sys.argv[1])
database.init_db(conn=conn)
for i in range(${RUNS}):
    words = ["tidal dissipation", f"run {i:04d}"]
    day, minute = divmod(i, 24)
    run = database.insert_execution(conn, {
        "execution_type": "deep_dive", "routine_id": None, "status": "running",
        "parameters": json.dumps({"query": " ".join(words), "keywords": words, "repositories": ["arxiv"]}),
        "start_time": f"2026-10-{1 + day:02d}T{minute:02d}:00:00Z",
    })
    database.record_execution_source(conn, run, "arxiv", "ok", result_count=i % 9)
    database.update_execution_status(conn, run, "completed", end_time=f"2026-10-{1 + day:02d}T{minute:02d}:05:00Z",
                                     result_count=i % 9, new_result_count=1)
conn.commit()
`, env.RESMON_DB_PATH!], { env, encoding: 'utf8' });
  }
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  const win = await app.firstWindow({ timeout: 180_000 });
  const problems: string[] = [];
  win.on('pageerror', (error) => problems.push(error.message));
  await win.locator(ATLAS_LANDMARK).waitFor({ timeout: 120_000 });
  return { app, win, problems };
}

const hash = (page: Page) => page.evaluate(() => window.location.hash);
const stageTop = (page: Page) => page.locator('main.stage').evaluate((node) => Math.round(node.scrollTop));
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name, exact: true });

async function shoot(page: Page, name: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

test('a new screen opens at its top, and Back and Forward put each screen where it was left', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-stage-')));
  const { app, win, problems } = await launch(stateDir, true);
  try {
    await tab(win, 'Runs').click();
    await expect.poll(() => hash(win)).toBe('#/runs');
    const rows = win.locator('[data-runs="history"] .run-row');
    await expect(rows.first()).toBeVisible({ timeout: 60_000 });
    // Far down the history, past its first page, as a person scrolls.
    const stage = win.locator('main.stage');
    await stage.hover();
    await expect.poll(async () => {
      await win.mouse.wheel(0, 600);
      return stageTop(win);
    }, { message: 'the history did not scroll far enough' }).toBeGreaterThan(2_400);
    // Where it comes to rest: a wheel's scroll eases out, and the list may still be reading its next page.
    let left = -1;
    await expect.poll(async () => {
      const was = left;
      await win.waitForTimeout(400);
      left = await stageTop(win);
      return left === was;
    }, { timeout: 15_000 }).toBe(true);
    const lastSeen = await rows.evaluateAll((all) => {
      const box = document.querySelector('main.stage')!.getBoundingClientRect();
      return all.filter((row) => { const r = row.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; })
        .map((row) => row.textContent?.match(/run \d{4}/)?.[0] ?? '').filter(Boolean).slice(-1)[0] ?? '';
    });
    expect(lastSeen).toMatch(/run \d{4}/);
    /** How far a run's row is from where it sat when the history was left, in pixels. */
    const rowAt = async (name: string) => Math.abs((await rowTop(name)) - leftAt);
    const rowTop = (name: string) => win.evaluate((which) => {
      const stage = document.querySelector('main.stage')!;
      const row = [...document.querySelectorAll('[data-runs="history"] .run-row')].find((r) => r.textContent?.includes(which));
      return row ? Math.round(row.getBoundingClientRect().top - stage.getBoundingClientRect().top) : Number.NaN;
    }, name);
    const leftAt = await rowTop(lastSeen);
    expect(leftAt).toBeGreaterThan(0);

    // Another screen, by its tab: at its top.
    await tab(win, 'Health').click();
    await expect.poll(() => hash(win)).toBe('#/health');
    // The address changes before the screen is drawn; the stage moves when it is.
    await expect(win.getByRole('navigation', { name: 'Health' })).toBeVisible();
    await expect.poll(() => stageTop(win), { timeout: 2_000 }).toBe(0);
    await win.getByRole('navigation', { name: 'Health' }).getByRole('link', { name: 'Analytics' }).click();
    await expect.poll(() => hash(win)).toBe('#/health/analytics');
    await expect.poll(() => stageTop(win), { timeout: 2_000 }).toBe(0);
    await shoot(win, 'stage-analytics-at-top.png');

    // Back twice: Health at its top, then the history where it was left, the same rows in view.
    await win.keyboard.press(`${MOD}+BracketLeft`);
    await expect.poll(() => hash(win)).toBe('#/health');
    await win.keyboard.press(`${MOD}+BracketLeft`);
    await expect.poll(() => hash(win)).toBe('#/runs');
    // The run at the bottom of the screen when it was left is there again, as near as a pixel or two.
    await expect.poll(() => rowAt(lastSeen), { timeout: 5_000 }).toBeLessThanOrEqual(2);
    await shoot(win, 'stage-runs-restored.png');

    // Forward: Health where it was, at its top.
    await win.keyboard.press(`${MOD}+BracketRight`);
    await expect.poll(() => hash(win)).toBe('#/health');
    await expect.poll(() => stageTop(win), { timeout: 2_000 }).toBe(0);
    expect(problems).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
