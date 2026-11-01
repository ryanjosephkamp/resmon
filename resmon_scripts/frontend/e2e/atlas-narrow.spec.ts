/**
 * Atlas in a window about 1,024 points wide, the narrowest a Mac's screen
 * gives it: nothing a person reads is cut off or broken into fragments.
 *
 * Ask the sources: each run's outcome in the run log wraps inside the column
 * rather than running past its edge, and each source's facts (how its terms
 * combine, its rate, and how finely it dates papers: "to the day") are shown
 * whole. The Source wall keeps When last asked in view at its right edge,
 * opened on the newest runs beside it. The Calendar sets a watch's name under
 * its time, where it breaks at its underscores. A run's heading and a watch's
 * heading break a long name at its underscores and spaces, never inside a
 * word.
 *
 * The runs and watches are written through the engine's own database
 * functions before launch. Nothing is asked of a source, and no run starts.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import { launchEnv, registerStateDir, FRONTEND_ROOT, SCREENSHOT_DIR } from './fixtures/resmon-app';
import { resize } from './fixtures/maps';

const LONG = 'a_deliberately_long_watch_name_that_checks_wrapping_in_lists_headers_and_the_calendar';

const SEED = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_execution, insert_routine,
    record_execution_source, update_execution_status)
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
now = datetime.now(timezone.utc)
iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")
long_name = sys.argv[2]
watches = {}
for name, cron in ((long_name, "0 8 * * *"), ("nightly_agents_crossref_ai", "0 0 * * *"),
                   ("nightly_agents_arxiv_ai", "0 0 * * *")):
    watches[name] = insert_routine(conn, {"name": name, "schedule_cron": cron, "is_active": 1,
        "parameters": json.dumps({"repositories": ["crossref"], "keywords": ["semaphore"], "query": "semaphore"})})
runs = []
# Twelve runs over the last two days, the newest last: a sweep of three sources, and each watch's runs.
for k in range(12):
    start = now - timedelta(hours=2 * (12 - k))
    routine = list(watches.values())[k % 3] if k % 2 else None
    selection = ["crossref", "dblp", "hal"] if routine is None else ["crossref"]
    run = insert_execution(conn, {"execution_type": "deep_sweep" if routine is None else "automated_sweep",
        "routine_id": routine, "start_time": iso(start),
        "parameters": json.dumps({"repositories": selection, "keywords": ["agent"], "query": "agent"})})
    record_execution_source(conn, run, "crossref", "ok", result_count=2)
    if routine is None:
        record_execution_source(conn, run, "dblp", "error", result_count=0, zero_reason="unsupported_date_window")
        record_execution_source(conn, run, "hal", "ok", result_count=2)
    update_execution_status(conn, run, "completed", end_time=iso(start + timedelta(seconds=1)),
        result_count=4 if routine is None else 2, new_result_count=4 if routine is None else 0)
    runs.append(run)
conn.commit()
print(json.dumps({"runs": runs, "long_watch": watches[long_name]}))
`;

/** Each element's text is inside its own box: nothing runs past an edge or is cut with an ellipsis. */
async function whole(items: Locator): Promise<string[]> {
  return items.evaluateAll((nodes) => nodes
    .filter((n) => n.scrollWidth > n.clientWidth + 1 || getComputedStyle(n).textOverflow === 'ellipsis')
    .map((n) => (n.textContent ?? '').trim()));
}

/**
 * Where a name broke across lines, by the text on each line: a name broken
 * only at its separators has every line end at an underscore or a space.
 */
async function lines(name: Locator): Promise<string[]> {
  return name.evaluate((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const rows: { top: number; text: string }[] = [];
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      for (let i = 0; i < (text.textContent ?? '').length; i++) {
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        const row = rows.find((r) => Math.abs(r.top - rect.top) < 4);
        if (row) row.text += text.textContent?.[i] ?? '';
        else rows.push({ top: rect.top, text: text.textContent?.[i] ?? '' });
      }
    }
    return rows.sort((a, b) => a.top - b.top).map((r) => r.text);
  });
}

function brokenAtSeparators(rows: string[], name: string): void {
  expect(rows.join(''), 'the lines read back as the whole name').toBe(name);
  for (const row of rows.slice(0, -1)) expect(row, `a line of "${name}" ends inside a word`).toMatch(/[_\s]$/);
}

test('at about 1,024 points wide: the run log, the source table, the Source wall, the Calendar, and long names', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-narrow-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..'), LONG],
    { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const seed = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as { runs: number[]; long_watch: number };

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const shot = (win: Page, name: string) => win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-narrow-${name}.png`) });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });
    await resize(app, 1026, 684);
    await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(1026);

    // Ask the sources: the run log's outcomes, and every source's facts, whole.
    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    await expect(win.locator('.run-row')).toHaveCount(12, { timeout: 60_000 });
    const log = win.getByRole('region', { name: 'Runs' });
    expect(await whole(log.locator('.run-row .meta > span'))).toEqual([]);
    const logBox = await log.boundingBox();
    const outcomes = await log.locator('.run-row .run-status').evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().right));
    for (const right of outcomes) expect(right).toBeLessThanOrEqual((logBox?.x ?? 0) + (logBox?.width ?? 0));
    await win.locator('.source[data-source="arxiv"]').waitFor({ timeout: 60_000 });
    expect(await whole(win.locator('.source .source-fact'))).toEqual([]);
    await expect(win.locator('.source[data-source="arxiv"] .source-fact').last()).toHaveText('to the day');
    await shot(win, 'ask-the-sources');

    // The Source wall: When last asked at its right edge, beside the newest runs.
    await win.evaluate(() => { window.location.hash = '#/health'; });
    const scroller = win.locator('.wall-scroll');
    await expect(scroller).toBeVisible({ timeout: 60_000 });
    const frame = await scroller.boundingBox();
    const last = await win.locator('.wall-grid thead .wall-last').boundingBox();
    expect(last && frame && last.x + last.width <= frame.x + frame.width + 1, 'When last asked is outside the table').toBe(true);
    const newest = await win.locator(`.wall-run[data-run="${seed.runs[seed.runs.length - 1]}"]`).boundingBox();
    expect(newest && last && newest.x + newest.width <= last.x + 1 && newest.x >= (frame?.x ?? 0),
      'the newest run is not in view beside When last asked').toBe(true);
    // Scrolled to the newest runs, each source's name is still what is seen at the left, over the runs behind it.
    const covered = await win.locator('.wall-grid tbody .wall-source').evaluateAll((names) => names.filter((name) => {
      const box = name.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + 24, box.top + box.height / 2);
      return !hit || !name.contains(hit);
    }).map((name) => name.textContent));
    expect(covered, 'a source name is covered by the runs scrolled under it').toEqual([]);
    await shot(win, 'source-wall');

    // The Calendar: a name under its time, broken at its underscores.
    await win.evaluate(() => { window.location.hash = '#/watches/calendar'; });
    const mark = win.locator('.fire-mark', { hasText: 'nightly_agents_crossref_ai' }).first();
    await expect(mark).toBeVisible({ timeout: 60_000 });
    const time = await mark.locator('.fire-time').boundingBox();
    const named = await mark.locator('.fire-name').boundingBox();
    expect(named && time && named.y >= time.y + time.height - 1, 'the name is not under its time').toBe(true);
    brokenAtSeparators(await lines(mark.locator('.fire-name')), 'nightly_agents_crossref_ai');
    await shot(win, 'calendar');

    // A long name as a heading: a watch's page, and its run's page.
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, seed.long_watch);
    const watchHeading = win.getByRole('heading', { level: 1, name: LONG });
    await expect(watchHeading).toBeVisible({ timeout: 60_000 });
    brokenAtSeparators(await lines(watchHeading), LONG);
    const run = win.locator('.night a').first();
    const runId = Number((await run.getAttribute('href'))?.replace('#/runs/', ''));
    await run.click();
    const runHeading = win.locator(`.run[data-run="${runId}"] .run-name`);
    await expect(runHeading).toHaveText(LONG, { timeout: 60_000 });
    brokenAtSeparators(await lines(runHeading), LONG);
    await shot(win, 'run-heading');

    expect(problems, 'the page reported errors').toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
