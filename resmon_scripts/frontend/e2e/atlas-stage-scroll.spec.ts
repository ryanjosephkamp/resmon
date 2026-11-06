/**
 * The stage's place, in the real app: scrolled far down a long run history,
 * Health and then Analytics open at their tops; Back puts the history where it
 * was left, the same run at the same height though the list draws its rows
 * again, and Forward puts Health back at its top. Then the same for the
 * Library's gallery, which draws only the rows near the view: Back puts the
 * same cover at the same height.
 *
 * Then two lists that scroll in boxes of their own rather than the stage:
 * Search › Your collection's results, which a virtualizer draws a window of,
 * and a run's Papers tab. Each is scrolled far down, a paper on it is opened,
 * and Back puts the same paper at the same height in the list's box. A new
 * search opens the results at their top, and stays there, also when its
 * papers were read before and are drawn at once.
 *
 * All four lists are walked in the window's default size and in 960 by 640,
 * the smallest the app allows, where the rows are drawn at other heights and
 * the history's first page ends nearer the place it was left at. CI's macOS
 * runner holds the default window to its screen (1024 by 684). Each Back logs,
 * at every frame from the key to the check, the row's distance from where it
 * was left and the scroll of the box it is in, so a miss says why.
 * `RESMON_E2E_CPU_SLOWDOWN` runs the page that many times slower, through the
 * DevTools protocol.
 *
 * Nothing leaves this machine: the runs and the papers are written into the
 * spec's own database before the app starts, and no search of a source is run.
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
const SAVED = 180;
/** Papers that are in the collection and not saved, all of them found by one run: Search lists every paper. */
const FOUND = 420;

async function launch(stateDir: string, size: readonly [number, number] | null): Promise<{ app: ElectronApplication; win: Page; problems: string[]; found: number }> {
  const base = launchEnv(stateDir, true);
  const env = atlasEnv(size ? { ...base, RESMON_E2E_WIDTH: String(size[0]), RESMON_E2E_HEIGHT: String(size[1]) } : base);
  // Finished runs, enough for a history several screens long, and saved papers for a gallery as long.
  const seeded = execFileSync(env.RESMON_PYTHON!, ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import database, reading_queue
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
for i in range(${SAVED}):
    title = f"Tidal heating of close binaries, paper {i:04d}" + (", with a title long enough to wrap" if i % 3 == 0 else "")
    doc = database.insert_document(conn, {"source_repository": "arxiv", "external_id": f"stage-{i}", "title": title,
        "authors": "Priya Raman, Wen Liu", "abstract": "We study tides in close binaries. " * 4,
        "publication_date": f"2026-{(i % 9) + 1:02d}-{(i % 27) + 1:02d}", "url": f"https://example.org/paper/{i}",
        "categories": "", "metadata_hash": f"stage-{i}"})
    reading_queue.save(conn, doc)
    at = f"2026-10-01 {i // 60:02d}:{i % 60:02d}:00"
    conn.execute("UPDATE reading_queue SET saved_at=?, updated_at=? WHERE document_id=?", (at, at, doc))
found = database.insert_execution(conn, {
    "execution_type": "deep_sweep", "routine_id": None, "status": "running",
    "parameters": json.dumps({"query": "orbital decay", "keywords": ["orbital decay"], "repositories": ["arxiv"]}),
    "start_time": "2026-10-30T09:00:00Z",
})
for i in range(${FOUND}):
    title = f"Orbital decay of hot Jupiters, paper {i:04d}" + (", with a title long enough to wrap twice in the list" if i % 4 == 0 else "")
    doc = database.insert_document(conn, {"source_repository": "arxiv", "external_id": f"found-{i}", "title": title,
        "authors": "Lena Okafor, Tomas Reyes" + (", Mira Adeyemi, Jonas Berg" if i % 5 == 0 else ""),
        "abstract": "We measure orbital decay from transit timing. " * 4,
        "publication_date": f"2026-{(i % 9) + 1:02d}-{(i % 27) + 1:02d}", "url": f"https://example.org/found/{i}",
        "categories": "", "metadata_hash": f"found-{i}"})
    conn.execute("INSERT INTO execution_documents (execution_id, document_id, is_new) VALUES (?, ?, 1)", (found, doc))
database.record_execution_source(conn, found, "arxiv", "ok", result_count=${FOUND})
database.update_execution_status(conn, found, "completed", end_time="2026-10-30T09:05:00Z",
                                 result_count=${FOUND}, new_result_count=${FOUND})
conn.commit()
print(found)
`, env.RESMON_DB_PATH!], { env, encoding: 'utf8' });
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  const win = await app.firstWindow({ timeout: 180_000 });
  // A slower machine, when asked for: `RESMON_E2E_CPU_SLOWDOWN=4` runs the window's page four times slower.
  const slowdown = Number(process.env.RESMON_E2E_CPU_SLOWDOWN ?? 1);
  if (slowdown > 1) await (await win.context().newCDPSession(win)).send('Emulation.setCPUThrottlingRate', { rate: slowdown });
  const problems: string[] = [];
  win.on('pageerror', (error) => problems.push(error.message));
  await win.locator(ATLAS_LANDMARK).waitFor({ timeout: 120_000 });
  return { app, win, problems, found: Number(seeded.trim().split('\n').pop()) };
}

const hash = (page: Page) => page.evaluate(() => window.location.hash);
/** The frame's one scrolling area; a screen's own box is named where a list scrolls in one. */
const STAGE = 'main.stage';
const stageTop = (page: Page, box = STAGE) => page.locator(box).evaluate((node) => Math.round(node.scrollTop));
const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name, exact: true });

async function shoot(page: Page, name: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
}

/** Far down the page, or the box, past `beyond` pixels, as a person scrolls with a wheel, and then where it comes to rest. */
async function scrollFar(win: Page, beyond: number, box = STAGE): Promise<void> {
  await win.locator(box).hover();
  await expect.poll(async () => {
    await win.mouse.wheel(0, 600);
    return stageTop(win, box);
  }, { message: 'the page did not scroll far enough' }).toBeGreaterThan(beyond);
  // A wheel's scroll eases out, and a list may still be reading its next page.
  let left = -1;
  await expect.poll(async () => {
    const was = left;
    await win.waitForTimeout(400);
    left = await stageTop(win, box);
    return left === was;
  }, { timeout: 15_000 }).toBe(true);
}

/**
 * The lowest of the rows (by `rows`, each known by `known`) whose top is in
 * view, with as much of it in view as there is: its selector, and how far
 * below the top edge of the stage, or the box, it sits.
 */
async function lastSeen(win: Page, rows: string, known: string, within = STAGE): Promise<{ selector: string; at: number }> {
  return win.evaluate(([all, attribute, scroller]) => {
    const box = document.querySelector(scroller)!.getBoundingClientRect();
    const seen = [...document.querySelectorAll(all)].filter((row) => {
      const r = row.getBoundingClientRect();
      return r.top >= box.top && r.top <= box.bottom - 40;
    });
    const whole = seen.filter((row) => row.getBoundingClientRect().bottom <= box.bottom);
    const row = (whole.length ? whole : seen).slice(-1)[0];
    if (!row) return { selector: '', at: Number.NaN };
    return { selector: `[${attribute}="${row.getAttribute(attribute)}"]`, at: Math.round(row.getBoundingClientRect().top - box.top) };
  }, [rows, known, within] as const);
}

/** How far a row sits below the top edge of the stage, or the box, now, in pixels; NaN while either is not in the page. */
const rowTop = (win: Page, selector: string, within = STAGE) => win.evaluate(([which, scroller]) => {
  const row = document.querySelector(which);
  const box = document.querySelector(scroller);
  return row && box ? Math.round(row.getBoundingClientRect().top - box.getBoundingClientRect().top) : Number.NaN;
}, [selector, within] as const);

/**
 * From now, at every frame: the time, the address, the scroll and height of
 * the stage or the box, where the row sits below its top edge, and whether the
 * place is held on it.
 */
async function watchFrames(win: Page, selector: string, within = STAGE): Promise<void> {
  await win.evaluate(([which, scroller]) => {
    const kept: string[] = [];
    const started = performance.now();
    const record = () => {
      const box = document.querySelector<HTMLElement>(scroller);
      const row = document.querySelector(which);
      const at = row && box ? String(Math.round(row.getBoundingClientRect().top - box.getBoundingClientRect().top)) : 'not in the page';
      kept.push(box
        ? `+${Math.round(performance.now() - started)} ms\t${window.location.hash}\ttop ${Math.round(box.scrollTop)} of ${box.scrollHeight}\trow ${at}\t${box.hasAttribute('data-place-held') ? 'held' : 'let go'}`
        : `+${Math.round(performance.now() - started)} ms\t${window.location.hash}\tno ${scroller} yet`);
      if (kept.length < 2_000) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
    (window as unknown as { stageFrames: string[] }).stageFrames = kept;
  }, [selector, within] as const);
}

/** The frames watched, a line each, with a run of frames that changed nothing but the time said once. */
async function framesSaid(win: Page, left: number): Promise<string> {
  const kept = await win.evaluate(() => (window as unknown as { stageFrames?: string[] }).stageFrames ?? []);
  const what = (frame: string) => frame.slice(frame.indexOf('\t'));
  const lines: string[] = [];
  for (let start = 0; start < kept.length;) {
    let end = start;
    while (end + 1 < kept.length && what(kept[end + 1]!) === what(kept[start]!)) end += 1;
    const until = end > start ? `\t(the same for ${end - start} frames more, to ${kept[end]!.slice(0, kept[end]!.indexOf('\t'))})` : '';
    lines.push(`${kept[start]!}${until}`);
    start = end + 1;
  }
  return `left at ${left}\n${lines.join('\n')}`;
}

/**
 * Back to where `selector` was left, `left` pixels below the stage's top edge:
 * it is there again, as near as a pixel or two, and still there a second
 * later. Every frame from the key on is logged, met or missed.
 */
async function backTo(win: Page, to: string, selector: string, left: number, what: string, within = STAGE): Promise<void> {
  await watchFrames(win, selector, within);
  await win.keyboard.press(`${MOD}+BracketLeft`);
  try {
    await expect.poll(() => hash(win)).toBe(to);
    await expect.poll(async () => Math.abs((await rowTop(win, selector, within)) - left), { timeout: 5_000, message: `${what} is not where it was left` })
      .toBeLessThanOrEqual(2);
    await win.waitForTimeout(1_000);
    expect(Math.abs((await rowTop(win, selector, within)) - left), `${what} moved after it was put back`).toBeLessThanOrEqual(2);
  } finally {
    console.log(`STAGE BACK ${what}, ${selector}:\n${await framesSaid(win, left)}`);
  }
}

const SIZES: readonly (readonly [number, number] | null)[] = [null, [960, 640]];

for (const size of SIZES) {
  const where = size ? `, in a ${size[0]} by ${size[1]} window` : '';
  const shot = size ? `-${size[0]}x${size[1]}` : '';
  test(`a new screen opens at its top, and Back and Forward put the run history, the Library, Search's results, and a run's papers where each was left${where}`, async () => {
    test.setTimeout(420_000);
    const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-stage-')));
    const { app, win, problems, found } = await launch(stateDir, size);
    try {
      if (size) await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(size[0]);

      // — The run history ----------------------------------------------------------------
      await tab(win, 'Runs').click();
      await expect.poll(() => hash(win)).toBe('#/runs');
      const rows = '[data-runs="history"] .run-row';
      await expect(win.locator(rows).first()).toBeVisible({ timeout: 60_000 });
      // Far down the history, past its first page.
      await scrollFar(win, 2_400);
      const run = await lastSeen(win, rows, 'data-run');
      expect(run.selector).toMatch(/^\[data-run="\d+"\]$/);
      expect(run.at).toBeGreaterThan(0);

      // Another screen, by its tab: at its top.
      await tab(win, 'Health').click();
      await expect.poll(() => hash(win)).toBe('#/health');
      // The address changes before the screen is drawn; the stage moves when it is.
      await expect(win.getByRole('navigation', { name: 'Health' })).toBeVisible();
      await expect.poll(() => stageTop(win), { timeout: 2_000 }).toBe(0);
      await win.getByRole('navigation', { name: 'Health' }).getByRole('link', { name: 'Analytics' }).click();
      await expect.poll(() => hash(win)).toBe('#/health/analytics');
      await expect.poll(() => stageTop(win), { timeout: 2_000 }).toBe(0);
      await shoot(win, `stage-analytics-at-top${shot}.png`);

      // Back twice: Health at its top, then the history where it was left, the same run where it was.
      await win.keyboard.press(`${MOD}+BracketLeft`);
      await expect.poll(() => hash(win)).toBe('#/health');
      await backTo(win, '#/runs', run.selector, run.at, 'the run at the bottom of the screen');
      await shoot(win, `stage-runs-restored${shot}.png`);

      // Forward: Health where it was, at its top.
      await win.keyboard.press(`${MOD}+BracketRight`);
      await expect.poll(() => hash(win)).toBe('#/health');
      await expect.poll(() => stageTop(win), { timeout: 2_000 }).toBe(0);

      // — The Library's gallery ----------------------------------------------------------
      await tab(win, 'Library').click();
      await expect.poll(() => hash(win)).toBe('#/library');
      const cards = '.gal [data-document]';
      await expect(win.locator(cards).first()).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => stageTop(win), { timeout: 2_000 }).toBe(0);
      await scrollFar(win, 3_000);
      const card = await lastSeen(win, cards, 'data-document');
      expect(card.selector).toMatch(/^\[data-document="\d+"\]$/);

      await tab(win, 'Health').click();
      await expect.poll(() => hash(win)).toBe('#/health');
      await expect(win.getByRole('navigation', { name: 'Health' })).toBeVisible();
      await expect.poll(() => stageTop(win), { timeout: 2_000 }).toBe(0);
      await backTo(win, '#/library', card.selector, card.at, 'the cover at the bottom of the screen');
      await shoot(win, `stage-library-restored${shot}.png`);

      await win.keyboard.press(`${MOD}+BracketRight`);
      await expect.poll(() => hash(win)).toBe('#/health');
      await expect.poll(() => stageTop(win), { timeout: 2_000 }).toBe(0);

      // — Search › Your collection: results that scroll in their own box ------------------
      const results = '.collection .index-scroll';
      const listed = `${results} .result[data-document]`;
      await tab(win, 'Search').click();
      await expect.poll(() => hash(win)).toBe('#/search');
      await expect(win.locator(listed).first()).toBeVisible({ timeout: 60_000 });
      // A search read once at its top, for later: its first page is kept, and its papers further down
      // have never been drawn.
      await win.locator('#collection-query').fill('tidal');
      await expect.poll(() => hash(win)).toBe('#/search?q=tidal');
      await expect(win.locator('.count-sentence')).toContainText('180', { timeout: 30_000 });
      await win.locator('#collection-query').fill('orbital');
      await expect.poll(() => hash(win)).toBe('#/search?q=orbital');
      await expect(win.locator('.count-sentence')).toContainText('420', { timeout: 30_000 });
      await expect.poll(() => stageTop(win, results), { timeout: 2_000 }).toBe(0);
      // Far down, past the first page of fifty: the next pages are read as the list nears its end.
      await scrollFar(win, 5_000, results);
      const result = await lastSeen(win, listed, 'data-document', results);
      expect(result.selector).toMatch(/^\[data-document="\d+"\]$/);
      expect(result.at).toBeGreaterThan(0);
      // The paper at the bottom of the screen opened from the list, as a person opens one.
      await win.locator(`${results} ${result.selector}`).locator('.result-title').click();
      await expect.poll(() => hash(win)).toMatch(/^#\/papers\/\d+$/);
      // The paper's page drawn, and the results gone with Search: Back draws them again.
      await expect(win.locator('.paper-name')).toBeVisible({ timeout: 30_000 });
      await expect(win.locator(results)).toHaveCount(0);
      await backTo(win, '#/search?q=orbital', `${results} ${result.selector}`, result.at, 'the paper at the bottom of the results', results);
      expect(await stageTop(win)).toBe(0);
      await shoot(win, `stage-search-restored${shot}.png`);
      // A new search opens at its top, and so does the last one, typed again.
      await win.locator('#collection-query').fill('orbital decay');
      await expect.poll(() => hash(win)).toBe('#/search?q=orbital+decay');
      await expect.poll(() => stageTop(win, results), { timeout: 5_000 }).toBe(0);
      await win.locator('#collection-query').fill('orbital');
      await expect.poll(() => hash(win)).toBe('#/search?q=orbital');
      await expect.poll(() => stageTop(win, results), { timeout: 5_000 }).toBe(0);
      // Far down again, and the search read at the start: drawn at once from its kept first page, shorter
      // than the place it leaves, and still at its top a second later, as its papers are drawn and read on.
      await scrollFar(win, 5_000, results);
      await win.locator('#collection-query').fill('tidal');
      await expect.poll(() => hash(win)).toBe('#/search?q=tidal');
      await expect.poll(() => stageTop(win, results), { timeout: 5_000 }).toBe(0);
      await win.waitForTimeout(1_000);
      expect(await stageTop(win, results), 'the new search went back to the last one\'s place').toBe(0);

      // — A run's Papers tab: a page that scrolls in its own box ---------------------------
      const page = '.run';
      const papers = `${page} .paper-row[data-document]`;
      await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, found);
      await expect.poll(() => hash(win)).toBe(`#/runs/${found}`);
      await expect(win.locator(papers).nth(199)).toBeAttached({ timeout: 60_000 });
      await expect.poll(() => stageTop(win, page), { timeout: 2_000 }).toBe(0);
      await scrollFar(win, 5_000, page);
      const paper = await lastSeen(win, papers, 'data-document', page);
      expect(paper.selector).toMatch(/^\[data-document="\d+"\]$/);
      await win.locator(`${page} ${paper.selector}`).locator('.paper-title').click();
      await expect.poll(() => hash(win)).toMatch(/^#\/papers\/\d+$/);
      await expect(win.locator('.paper-name')).toBeVisible({ timeout: 30_000 });
      await expect(win.locator(page)).toHaveCount(0);
      await backTo(win, `#/runs/${found}`, `${page} ${paper.selector}`, paper.at, 'the paper at the bottom of the run\'s Papers tab', page);
      expect(await stageTop(win)).toBe(0);
      await shoot(win, `stage-run-papers-restored${shot}.png`);
      expect(problems).toEqual([]);
    } finally {
      await app.close().catch(() => { /* gone */ });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
}
