/**
 * Atlas: a watch's long name stays whole where space is narrow.
 *
 * Two watches named as people name them, `midnight_agents_arxiv_ai` and
 * `midnight_agents_crossref_ai`: one word each to the browser, and the same
 * for their first fifteen characters. The Calendar cut both to
 * "midnight_age…", so they looked identical. Each place that names a watch
 * in a narrow space is checked here for the whole name, unclipped: the
 * Calendar's cells and its Next due list at 1280 and 1728 pixels wide, in
 * both themes, Today's index group headers, and the run log.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const NAMES = ['midnight_agents_arxiv_ai', 'midnight_agents_crossref_ai'];

const SEED = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_routine,
    insert_execution, link_execution_document, record_execution_source, update_execution_status, set_setting)
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
now = datetime.now(timezone.utc)
fmt = lambda t: t.strftime("%Y-%m-%d %H:%M:%S")
ids = []
for n, (name, source) in enumerate(json.loads(sys.argv[2])):
    routine = insert_routine(conn, {"name": name, "schedule_cron": "0 0 * * *", "is_active": 1,
        "parameters": json.dumps({"repositories": [source], "keywords": ["agents"], "query": "agents"})})
    started = now - timedelta(hours=2 + n)
    run = insert_execution(conn, {"execution_type": "automated_sweep", "routine_id": routine,
        "parameters": json.dumps({"repositories": [source], "query": "agents"}), "start_time": fmt(started)})
    for k in range(2):
        doc = insert_document(conn, {"source_repository": source, "external_id": f"{name}-{k}",
            "title": f"Agents paper {k} for {name}", "authors": "Ada Fixture", "publication_date": "2026-10-01",
            "abstract": "agents planning tools language models evaluation " * 6, "metadata_hash": f"{name}-{k}"})
        conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (fmt(started), doc))
        link_execution_document(conn, run, doc)
    record_execution_source(conn, run, source, "ok", result_count=2, zero_reason=None)
    update_execution_status(conn, run, "completed", end_time=fmt(started + timedelta(seconds=30)),
                            result_count=2, new_result_count=2)
    ids.append(routine)
# The last look is yesterday at noon on this machine's clock, so both runs are new on Today.
local = datetime.now().astimezone()
looked = local.replace(hour=12, minute=0, second=0, microsecond=0) - timedelta(days=1)
set_setting(conn, "today_looked_at", fmt(looked.astimezone(timezone.utc)))
conn.commit()
print(json.dumps(ids))
`;

/**
 * Whether the element shows all of its text: nothing cut by a clamp or an
 * ellipsis (content taller or wider than a box that hides its overflow), and
 * nothing running out past its box sideways.
 */
async function whole(locator: Locator): Promise<{ text: string; clipped: boolean }> {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const hidesY = style.overflowY !== 'visible';
    return {
      text: (el as HTMLElement).innerText.replace(/\s+/g, ''),
      clipped: el.scrollWidth > el.clientWidth + 1 || (hidesY && el.scrollHeight > el.clientHeight + 1),
    };
  });
}

async function size(app: ElectronApplication, width: number, height: number, theme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ BrowserWindow, nativeTheme }, x) => {
    nativeTheme.themeSource = x.theme;
    BrowserWindow.getAllWindows()[0]?.setContentSize(x.width, x.height);
  }, { width, height, theme });
}

async function go(win: Page, hash: string): Promise<void> {
  await win.evaluate((h) => { window.location.hash = h; }, hash);
}

test('a long watch name stays whole in the Calendar, on Today, and in the run log', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-watch-names-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3',
    ['-c', SEED, path.join(FRONTEND_ROOT, '..'), JSON.stringify([[NAMES[0], 'arxiv'], [NAMES[1], 'crossref']])],
    { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const ids = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '[]') as number[];

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

    await go(win, '#/watches/calendar');
    const month = win.locator('section.month-ahead');
    await expect(month).toHaveAttribute('data-state', 'read', { timeout: 30_000 });
    for (const [width, height] of [[1280, 800], [1728, 1050]] as const) {
      for (const theme of ['light', 'dark'] as const) {
        await size(app, width, height, theme);
        await win.waitForTimeout(300);
        for (const [i, id] of ids.entries()) {
          const name = month.locator('.fire-mark').filter({ has: win.locator(`.fire[data-routine="${id}"]`) }).first()
            .locator('.fire-name');
          const shown = await whole(name);
          expect(shown, `${NAMES[i]} in a Calendar cell at ${width} wide`).toEqual({ text: NAMES[i], clipped: false });
          // The whole name for a pointer and a screen reader as well.
          const mark = month.locator('.fire-mark').filter({ has: win.locator(`.fire[data-routine="${id}"]`) }).first();
          await expect(mark).toHaveAttribute('title', new RegExp(`^${NAMES[i]} at `));
          await expect(mark).toHaveAttribute('aria-label', new RegExp(`^${NAMES[i]} at `));
          const next = month.locator('.next-fires a').filter({ hasText: NAMES[i] }).first();
          expect(await whole(next), `${NAMES[i]} in Next due at ${width} wide`).toEqual({ text: NAMES[i], clipped: false });
        }
        await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-watch-names-calendar-${width}-${theme}.png`) });
      }
    }

    await size(app, 1280, 800, 'light');
    await go(win, '#/');
    const index = win.locator('.index');
    for (const name of NAMES) {
      const head = index.locator('.ghead h3').filter({ hasText: name });
      await expect(head).toBeVisible({ timeout: 30_000 });
      expect(await whole(head), `${name} as Today's group header`).toEqual({ text: name, clipped: false });
    }
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-names-today.png') });

    await go(win, '#/search/ask');
    for (const name of NAMES) {
      const title = win.locator('.runlog .run-title').filter({ hasText: name }).first();
      await expect(title).toBeVisible({ timeout: 30_000 });
      expect(await whole(title), `${name} in the run log`).toEqual({ text: name, clipped: false });
    }
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-watch-names-runlog.png') });

    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});
