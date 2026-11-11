/** The default twelve-run wall stays whole at the window's minimum size. */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv } from './fixtures/resmon-app';
import { resize } from './fixtures/maps';
import { removeStateDir } from './fixtures/cleanup';

const SEED = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_execution,
    record_execution_source, update_execution_status)
init_db(os.environ["RESMON_DB_PATH"])
conn = get_connection(os.environ["RESMON_DB_PATH"])
sources = ["arxiv", "crossref", "semantic_scholar", "ndl", "pubmed", "inspire_hep", "core"]
start = datetime(2026, 10, 29, 8, 17, tzinfo=timezone.utc)
iso = lambda at: at.strftime("%Y-%m-%dT%H:%M:%SZ")
for k in range(12):
    at = start + timedelta(minutes=63 * k)
    run = insert_execution(conn, {"execution_type": "deep_sweep", "status": "completed",
        "parameters": json.dumps({"repositories": sources, "keywords": ["perovskite"]}), "start_time": iso(at)})
    for source in sources:
        record_execution_source(conn, run, source, "ok", result_count=2)
    update_execution_status(conn, run, "completed", end_time=iso(at + timedelta(seconds=10)),
        result_count=14, new_result_count=0)
conn.close()
`;

for (const [width, height] of [[960, 640], [1440, 900]] as const) {
  test(`Source Wall: all twelve history times fit at ${width} by ${height}`, async () => {
    test.setTimeout(180_000);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-wall-minimum-'));
    const env = launchEnv(stateDir, true);
    let app: ElectronApplication | undefined;
    try {
      const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
      expect(seeded.status, seeded.stderr).toBe(0);
      app = await electron.launch({
        args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
        cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 120_000,
      });
      const win = await app.firstWindow({ timeout: 120_000 });
      const problems: string[] = [];
      win.on('pageerror', (error) => problems.push(error.message));
      await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 60_000 });
      const port = await win.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort());
      expect(port).not.toBe('8742');
      await resize(app, width, height);
      if (width === 960) await expect.poll(() => win.evaluate(() => window.innerWidth)).toBe(960);
      else await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeGreaterThan(1000);
      const viewport = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      test.info().annotations.push({ type: 'viewport', description: `${viewport.width} by ${viewport.height}` });
      await win.evaluate(() => { window.location.hash = '#/health'; });
      await expect(win.locator('.wall-run')).toHaveCount(12);
      await win.evaluate(() => document.fonts.ready);
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-source-wall-${width}x${height}.png`) });

      const layout = await win.evaluate(() => {
        const frame = document.querySelector<HTMLElement>('.wall-scroll')!;
        const source = document.querySelector<HTMLElement>('.wall-corner')!.getBoundingClientRect();
        const last = document.querySelector<HTMLElement>('.wall-grid thead .wall-last')!.getBoundingClientRect();
        return {
          pageOverflow: document.querySelector<HTMLElement>('.stage')!.scrollWidth - document.querySelector<HTMLElement>('.stage')!.clientWidth,
          wallOverflow: frame.scrollWidth - frame.clientWidth,
          sourceRight: source.right, lastLeft: last.left,
          times: [...document.querySelectorAll<HTMLAnchorElement>('.wall-run a')].map((link) => {
            const box = link.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return { text: link.textContent, left: box.left, right: box.right, lines: link.getClientRects().length,
              uncovered: hit !== null && link.contains(hit) };
          }),
        };
      });
      await test.info().attach('Source Wall layout', { body: JSON.stringify({ viewport, ...layout }), contentType: 'application/json' });
      expect(layout.pageOverflow, 'the page needs sideways scrolling').toBeLessThanOrEqual(1);
      expect(layout.wallOverflow, 'the default twelve runs need sideways scrolling').toBeLessThanOrEqual(1);
      expect(layout.times[0]!.left, 'the Source column clips the oldest history time').toBeGreaterThanOrEqual(layout.sourceRight);
      expect(layout.times[11]!.right, 'When last asked clips the newest history time').toBeLessThanOrEqual(layout.lastLeft);
      for (const [index, time] of layout.times.entries()) {
        expect(time.lines, `${time.text} breaks across lines`).toBe(1);
        expect(time.uncovered, `${time.text} is covered by another column`).toBe(true);
        if (index > 0) expect(time.left, `${time.text} overlaps the previous time`).toBeGreaterThan(layout.times[index - 1]!.right + 2);
      }
      await win.locator('[data-health="cell"]').first().click();
      await expect(win.locator('[data-health="reading"]')).toContainText('Deep Sweep');
      expect(problems).toEqual([]);
    } finally {
      await app?.close();
      await removeStateDir(stateDir);
    }
  });
}
