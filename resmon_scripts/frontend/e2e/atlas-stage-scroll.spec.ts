/**
 * The stage's place, in the real app: scrolled far down a long run history,
 * Health and then Analytics open at their tops; Back puts the history where it
 * was left, the same run at the same height though the list draws its rows
 * again, and Forward puts Health back at its top. Then the same for the
 * Library's gallery, which draws only the rows near the view: Back puts the
 * same cover at the same height.
 *
 * Both lists are walked in the window's default size and in 960 by 640, the
 * smallest the app allows, where the rows are drawn at other heights and the
 * history's first page ends nearer the place it was left at. CI's macOS runner
 * holds the default window to its screen (1024 by 684). Each Back logs, at
 * every frame from the key to the check, the row's distance from where it was
 * left and the stage's scroll, so a miss says why. `RESMON_E2E_CPU_SLOWDOWN`
 * runs the page that many times slower, through the DevTools protocol.
 *
 * Nothing leaves this machine: the runs and the saved papers are written into
 * the spec's own database before the app starts, and no search is run.
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

async function launch(stateDir: string, size: readonly [number, number] | null): Promise<{ app: ElectronApplication; win: Page; problems: string[] }> {
  const base = launchEnv(stateDir, true);
  const env = atlasEnv(size ? { ...base, RESMON_E2E_WIDTH: String(size[0]), RESMON_E2E_HEIGHT: String(size[1]) } : base);
  // Finished runs, enough for a history several screens long, and saved papers for a gallery as long.
  execFileSync(env.RESMON_PYTHON!, ['-c', `
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
conn.commit()
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

/** Far down the page, past `beyond` pixels, as a person scrolls with a wheel, and then where it comes to rest. */
async function scrollFar(win: Page, beyond: number): Promise<void> {
  await win.locator('main.stage').hover();
  await expect.poll(async () => {
    await win.mouse.wheel(0, 600);
    return stageTop(win);
  }, { message: 'the page did not scroll far enough' }).toBeGreaterThan(beyond);
  // A wheel's scroll eases out, and a list may still be reading its next page.
  let left = -1;
  await expect.poll(async () => {
    const was = left;
    await win.waitForTimeout(400);
    left = await stageTop(win);
    return left === was;
  }, { timeout: 15_000 }).toBe(true);
}

/**
 * The lowest of the rows (by `rows`, each known by `known`) whose top is in
 * view, with as much of it in view as there is: its selector, and how far
 * below the stage's top edge it sits.
 */
async function lastSeen(win: Page, rows: string, known: string): Promise<{ selector: string; at: number }> {
  return win.evaluate(([all, attribute]) => {
    const box = document.querySelector('main.stage')!.getBoundingClientRect();
    const seen = [...document.querySelectorAll(all)].filter((row) => {
      const r = row.getBoundingClientRect();
      return r.top >= box.top && r.top <= box.bottom - 40;
    });
    const whole = seen.filter((row) => row.getBoundingClientRect().bottom <= box.bottom);
    const row = (whole.length ? whole : seen).slice(-1)[0];
    if (!row) return { selector: '', at: Number.NaN };
    return { selector: `[${attribute}="${row.getAttribute(attribute)}"]`, at: Math.round(row.getBoundingClientRect().top - box.top) };
  }, [rows, known] as const);
}

/** How far a row sits below the stage's top edge now, in pixels; NaN while it is not in the page. */
const rowTop = (win: Page, selector: string) => win.evaluate((which) => {
  const row = document.querySelector(which);
  return row ? Math.round(row.getBoundingClientRect().top - document.querySelector('main.stage')!.getBoundingClientRect().top) : Number.NaN;
}, selector);

/**
 * From now, at every frame: the time, the address, the stage's scroll and
 * height, where the row sits below its top edge, and whether the place is held.
 */
async function watchFrames(win: Page, selector: string): Promise<void> {
  await win.evaluate((which) => {
    const kept: string[] = [];
    const started = performance.now();
    const record = () => {
      const stage = document.querySelector<HTMLElement>('main.stage');
      if (!stage) return;
      const row = document.querySelector(which);
      const at = row ? String(Math.round(row.getBoundingClientRect().top - stage.getBoundingClientRect().top)) : 'not in the page';
      kept.push(`+${Math.round(performance.now() - started)} ms\t${window.location.hash}\ttop ${Math.round(stage.scrollTop)} of ${stage.scrollHeight}\trow ${at}\t${stage.hasAttribute('data-place-held') ? 'held' : 'let go'}`);
      if (kept.length < 2_000) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
    (window as unknown as { stageFrames: string[] }).stageFrames = kept;
  }, selector);
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
async function backTo(win: Page, to: string, selector: string, left: number, what: string): Promise<void> {
  await watchFrames(win, selector);
  await win.keyboard.press(`${MOD}+BracketLeft`);
  try {
    await expect.poll(() => hash(win)).toBe(to);
    await expect.poll(async () => Math.abs((await rowTop(win, selector)) - left), { timeout: 5_000, message: `${what} is not where it was left` })
      .toBeLessThanOrEqual(2);
    await win.waitForTimeout(1_000);
    expect(Math.abs((await rowTop(win, selector)) - left), `${what} moved after it was put back`).toBeLessThanOrEqual(2);
  } finally {
    console.log(`STAGE BACK ${what}, ${selector}:\n${await framesSaid(win, left)}`);
  }
}

const SIZES: readonly (readonly [number, number] | null)[] = [null, [960, 640]];

for (const size of SIZES) {
  const where = size ? `, in a ${size[0]} by ${size[1]} window` : '';
  const shot = size ? `-${size[0]}x${size[1]}` : '';
  test(`a new screen opens at its top, and Back and Forward put the run history and the Library where each was left${where}`, async () => {
    test.setTimeout(300_000);
    const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-stage-')));
    const { app, win, problems } = await launch(stateDir, size);
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
      expect(problems).toEqual([]);
    } finally {
      await app.close().catch(() => { /* gone */ });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
}
