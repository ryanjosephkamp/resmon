/**
 * Atlas: the Runs tab over a thousand runs, in the real app. The runs are
 * written before the app starts: searches and watches' runs over 42 days,
 * some failed, each with the sources it asked and a stored event list of the
 * size a short run keeps.
 *
 * It checks what a person meets: the tab in the bar and on ⌘7, the history's
 * first page and the count of all of them, the next pages read as the list
 * nears its end, the filters and the search with their counts, the newest
 * five beside Ask the sources, and that the history is not read again on a
 * timer. And it measures: how long the first page takes to draw, how long
 * reading all thousand takes, and the frames of a scroll from the top of the
 * thousand to the bottom, which it writes to `runs-tab-1000.json` beside the
 * screenshots and holds to a frame budget.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const RUNS = 1_000;

/** A window this many CSS pixels wide: the window itself where the display allows, zoomed out where it does not. */
async function widen(app: ElectronApplication, win: Page, width: number, theme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ BrowserWindow, nativeTheme, screen }, x) => {
    nativeTheme.themeSource = x.theme;
    const area = screen.getPrimaryDisplay().workAreaSize;
    const w = BrowserWindow.getAllWindows()[0]!;
    const fits = x.width <= area.width;
    const zoom = fits ? 1 : area.width / x.width;
    w.setSize(fits ? x.width : area.width, Math.min(area.height, Math.round(900 * zoom)));
    w.webContents.setZoomFactor(zoom);
  }, { width, theme });
  await expect.poll(() => win.evaluate(() => window.innerWidth), { timeout: 10_000 }).toBeGreaterThanOrEqual(width - 2);
  await expect(win.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 10_000 });
}

test('the Runs tab over a thousand runs: pages, counts, filters, search, and a smooth scroll', async () => {
  test.setTimeout(400_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-runs-tab-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true) };
  // A thousand finished runs a person might have after a year: every seventh a watch's run, every
  // eleventh failed, three sources each, and a few dozen stored events each.
  execFileSync(env.RESMON_PYTHON, ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import database
conn = database.get_connection(sys.argv[1])
database.init_db(conn=conn)
watch = database.insert_routine(conn, {"name": "Nightly agents", "schedule_cron": "0 0 * * *", "parameters": "{}", "is_active": 0})
topics = ["graph learning", "protein folding", "muon g-2", "perovskite cells", "retrieval agents", "surface codes"]
events = [{"type": "query_progress", "repository": "arxiv", "phase": "searching", "elapsed": 2.0 * n, "requests": n,
           "retries": 0, "message": "still querying arxiv", "timestamp": "2026-10-01T00:00:00Z"} for n in range(40)]
for i in range(${RUNS}):
    kind = "automated_sweep" if i % 7 == 0 else ("deep_sweep" if i % 2 else "deep_dive")
    words = [topics[i % len(topics)], f"run {i:04d}"]
    day, minute = divmod(i, 24)
    run = database.insert_execution(conn, {
        "execution_type": kind, "routine_id": watch if kind == "automated_sweep" else None, "status": "running",
        "parameters": json.dumps({"query": " ".join(words), "keywords": words, "repositories": ["arxiv", "crossref", "dblp"]}),
        "start_time": f"2026-{9 + day // 30:02d}-{1 + day % 30:02d}T{minute:02d}:00:00Z",
    })
    for slug in ("arxiv", "crossref", "dblp"):
        database.record_execution_source(conn, run, slug, "ok", result_count=(i * 7 + len(slug)) % 40)
    failed = i % 11 == 0
    database.update_execution_status(conn, run, "failed" if failed else "completed",
                                     end_time=f"2026-{9 + day // 30:02d}-{1 + day % 30:02d}T{minute:02d}:05:00Z",
                                     result_count=12, new_result_count=3)
    database.save_progress_events(conn, run, events)
conn.commit()
`, env.RESMON_DB_PATH], { env, encoding: 'utf8' });
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const pages: string[] = [];
    win.on('request', (r) => { if (/\/api\/executions\?/.test(r.url()) && /offset=/.test(r.url())) pages.push(new URL(r.url()).search); });

    // — The tab, after Search in the bar, and on ⌘7 -----------------------------------------
    const tabs = win.getByRole('navigation', { name: 'Sections' }).getByRole('link');
    expect(await tabs.allInnerTexts()).toEqual(['Today', 'Watches', 'Search', 'Runs', 'Library', 'Ask', 'Health']);
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await expect(tabs.filter({ hasText: 'Runs' })).toHaveAttribute('aria-keyshortcuts', `${mod}+7`);
    await expect(tabs.filter({ hasText: 'Library' })).toHaveAttribute('aria-keyshortcuts', `${mod}+4`);
    const asked = Date.now();
    await win.keyboard.press(`${mod}+7`);
    await expect.poll(() => win.evaluate(() => window.location.hash)).toBe('#/runs');

    // — The first page, and the count of all of them ----------------------------------------
    const history = win.locator('[data-runs="history"]');
    const rows = history.locator('.run-row');
    await expect(rows).toHaveCount(50, { timeout: 60_000 });
    const firstPageMs = Date.now() - asked;
    await expect(history.locator('[data-runs="count"]')).toHaveText('1,000 runs');
    expect(pages[0]).toBe('?limit=50&offset=0&omit_events=true');
    await expect(rows.first()).toContainText('run 0999');
    await expect(win.locator('[data-runs="none-running"]')).toContainText('Nothing is running.');
    // Select all ticks the runs listed, and says how many more there are.
    const all = history.locator('[data-runs="select-all"]');
    await expect(all).toContainText('Select all 50');
    await expect(all.locator('.num')).toHaveText('listed; 950 older are listed as you scroll');

    // — Read on as the list nears its end, a page at a time, to the last ----------------------
    const readAll = Date.now();
    const stage = win.locator('main.stage');
    await expect.poll(async () => {
      await stage.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      return rows.count();
    }, { timeout: 120_000, intervals: [100] }).toBe(RUNS);
    const allMs = Date.now() - readAll;
    // The oldest: the first run written, a watch's.
    await expect(rows.last()).toHaveAttribute('data-run', '1');
    await expect(history.getByRole('button', { name: /^Older runs/ })).toHaveCount(0);
    expect(pages.length).toBe(RUNS / 50);

    // — A scroll from the top of the thousand to the bottom, frame by frame -------------------
    await stage.evaluate((el) => { el.scrollTop = 0; });
    await win.waitForTimeout(500);
    const frames = await stage.evaluate(async (el) => {
      const gaps: number[] = [];
      const height = el.scrollHeight - el.clientHeight;
      // About 600 frames from top to bottom: ten seconds at sixty a second.
      const step = Math.max(1, Math.ceil(height / 600));
      let last = performance.now();
      let still = 0;
      await new Promise<void>((done) => {
        const tick = (now: number) => {
          gaps.push(now - last);
          last = now;
          const before = el.scrollTop;
          el.scrollTop = before + step;
          // The end, however tall the list measures as its rows are drawn: the scroll stops moving.
          still = el.scrollTop <= before + 0.5 ? still + 1 : 0;
          if (still >= 5 || gaps.length > 2_000) done();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      gaps.shift();
      const sorted = [...gaps].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      return {
        frames: gaps.length, scrolled: height, median: at(0.5), p95: at(0.95), worst: sorted[sorted.length - 1] ?? 0,
        over50: gaps.filter((g) => g > 50).length,
      };
    });
    const measured = { runs: RUNS, firstPageMs, readAllMs: allMs, scroll: frames, at: new Date().toISOString() };
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'runs-tab-1000.json'), `${JSON.stringify(measured, null, 2)}\n`);
    console.log(`[runs-tab] ${JSON.stringify(measured)}`);
    // Smooth: at 60 frames a second a frame is 16.7 ms; the 95th percentile within two frames, and at most
    // three frames in the whole scroll held past 50 ms. Measured on an M-series Mac at 120 Hz, November 4,
    // 2026: the first page in 83 to 94 ms, all thousand read in 2.5 s, and the scroll's 586 frames at a
    // median of 8.3 ms, 95th percentile 10 to 10.3 ms, worst 16 ms (once, a single 92 ms frame).
    // A shared CI runner (60 Hz, other jobs beside it) cannot hold a frame budget meant for a person's
    // machine: there the numbers are recorded above and held only to a looser bar that still fails a list
    // that janks outright.
    const ci = Boolean(process.env.CI);
    expect(frames.p95, JSON.stringify(frames)).toBeLessThanOrEqual(ci ? 50 : 34);
    expect(frames.over50, JSON.stringify(frames)).toBeLessThanOrEqual(ci ? 10 : 3);

    // — Filters and search, each with its count -----------------------------------------------
    await stage.evaluate((el) => { el.scrollTop = 0; });
    const show = win.getByRole('group', { name: 'Show' });
    await show.getByRole('button', { name: 'Failed' }).click();
    await expect(history.locator('[data-runs="count"]')).toHaveText('91 runs');
    await expect(rows.first().locator('.run-status')).toHaveAttribute('data-status', 'failed');
    await show.getByRole('button', { name: 'Watches' }).click();
    await expect(history.locator('[data-runs="count"]')).toHaveText('143 runs');
    await expect(rows.first().locator('.run-title')).toHaveText('Nightly agents');
    await show.getByRole('button', { name: 'Searches' }).click();
    await expect(history.locator('[data-runs="count"]')).toHaveText('857 runs');
    await show.getByRole('button', { name: 'All' }).click();
    await win.getByLabel('Find a run').fill('perovskite');
    await expect(history.locator('[data-runs="count"]')).toHaveText('167 runs');
    await expect(rows.first()).toContainText('perovskite cells');
    await win.getByLabel('Find a run').fill('run 0421');
    await expect(rows).toHaveCount(1);
    await win.getByLabel('Find a run').fill('nothing like this');
    await expect(history.locator('.index-empty')).toHaveText('No run matches “nothing like this”.');
    await win.getByLabel('Find a run').fill('');
    await expect(history.locator('[data-runs="count"]')).toHaveText('1,000 runs');

    // — Not read again on a timer: nothing runs, so ten seconds pass without a read -----------
    const before = pages.length;
    await win.waitForTimeout(10_000);
    expect(pages.length, 'the history was read again with nothing running').toBe(before);

    // — At the window's sizes, in the night theme and in light --------------------------------
    for (const [width, theme] of [[960, 'dark'], [1280, 'light'], [1920, 'dark']] as const) {
      await widen(app, win, width, theme);
      await win.waitForTimeout(300);
      const wide = await win.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(wide, `the Runs tab scrolls sideways at ${width}`).toBeLessThanOrEqual(0);
      await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-runs-tab-${width}-${theme}.png`) });
    }
    await widen(app, win, 1440, 'dark');

    // — The newest five beside Ask the sources, and the way to the rest ------------------------
    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    const latest = win.locator('.latest-runs');
    await expect(latest.locator('.run-row')).toHaveCount(5, { timeout: 30_000 });
    await expect(latest.locator('[data-runs="count"]')).toHaveText('the latest five');
    await expect(latest.locator('.latest-more')).toHaveText('995 more on the Runs tab');
    await latest.getByRole('link', { name: 'All runs' }).click();
    await expect.poll(() => win.evaluate(() => window.location.hash)).toBe('#/runs');
    expect(problems).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
