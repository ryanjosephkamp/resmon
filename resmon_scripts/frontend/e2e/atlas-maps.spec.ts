/**
 * Atlas's maps, in the real app, over a collection written for them: a paper
 * chosen on Today's map that is not among the new ones opens beside it, with
 * its record, the runs that found it, its links and the reading queue, and
 * Back and Escape return to the list; the keyboard chooses papers too; the
 * filters dim what they leave out and say how many are lit, the colors are
 * named in the key, the find lights its matches and Enter steps through them,
 * and the view is remembered by the engine. A Deep Sweep's own map draws only
 * its papers, says how many are placed and why the rest are not, and opens a
 * paper beside it the same way. Both themes and three window widths are
 * pictured.
 *
 * The collection is written through the engine's own database functions
 * before launch, so the counts asserted here are the ones it was given.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { launchEnv, registerStateDir, FRONTEND_ROOT, SCREENSHOT_DIR } from './fixtures/resmon-app';

const SEED = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_routine,
    insert_execution, link_execution_document, record_execution_source, update_execution_status, set_setting)

TOPICS = {
    "protein": ("arxiv", "protein folding residue amino chain conformation binding structure"),
    "traffic": ("crossref", "traffic congestion road sensor commute intersection vehicle flow"),
    "quantum": ("dblp", "quantum qubit circuit entanglement gate decoherence photon error"),
}
now = datetime.now(timezone.utc)
fmt = lambda t: t.strftime("%Y-%m-%d %H:%M:%S")
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
ids = {t: {"new": [], "old": []} for t in TOPICS}
for topic, (source, words) in TOPICS.items():
    w = words.split()
    for n in range(20):
        fresh = n < 2 and topic != "quantum"
        doc = insert_document(conn, {
            "source_repository": source, "external_id": f"{topic}-{n}",
            "title": f"{w[0].title()} {w[n % len(w)]} {w[(n + 3) % len(w)]} study {n}",
            "authors": "Ada Lovelace, Alan Turing" if n % 2 else "Grace Hopper",
            "abstract": " ".join(w[(n + k) % len(w)] for k in range(30)) + ". A second sentence follows.",
            "publication_date": ["2024-03-15", "2023", "2025-01"][n % 3] if n % 5 else None,
            "doi": f"10.5555/{topic}.{n}",
            "url": f"https://arxiv.org/abs/2401.{1000 + n:05d}" if source == "arxiv" else f"https://example.org/{topic}/{n}",
            "metadata_hash": f"{topic}-{n}",
        })
        seen = now - (timedelta(hours=2 + n) if fresh else timedelta(days=10 + 3 * n))
        conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (fmt(seen), doc))
        ids[topic]["new" if fresh else "old"].append(doc)
# Three papers with too little text to place: no abstract, and titles of only common words.
bare = []
for n, title in enumerate(["On the", "Of it", "A study"]):
    bare.append(insert_document(conn, {"source_repository": "dblp", "external_id": f"bare-{n}", "title": title,
        "authors": "Grace Hopper", "metadata_hash": f"bare-{n}"}))
    conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (fmt(now - timedelta(days=5)), bare[-1]))
conn.commit()

def run(routine_id, docs, started, kind="automated_sweep"):
    e = insert_execution(conn, {"execution_type": kind, "routine_id": routine_id,
        "parameters": json.dumps({"repositories": ["arxiv"], "query": "x"}), "start_time": fmt(started)})
    for d in docs:
        link_execution_document(conn, e, d)
    record_execution_source(conn, e, "arxiv", "ok", result_count=len(docs), zero_reason=None)
    update_execution_status(conn, e, "completed", end_time=fmt(started + timedelta(seconds=41)),
        result_count=len(docs), new_result_count=len(docs))
    return e
protein = insert_routine(conn, {"name": "Protein structure", "schedule_cron": "0 2 * * *",
    "parameters": json.dumps({"repositories": ["arxiv"], "query": "protein"}), "is_active": 1})
traffic = insert_routine(conn, {"name": "Traffic flow", "schedule_cron": "0 3 * * *",
    "parameters": json.dumps({"repositories": ["crossref"], "query": "traffic"}), "is_active": 1})
run(protein, ids["protein"]["old"] + ids["protein"]["new"], now - timedelta(days=1))
run(traffic, ids["traffic"]["old"] + ids["traffic"]["new"], now - timedelta(days=1))
sweep = run(None, ids["quantum"]["old"][:15] + bare, now - timedelta(days=2), kind="deep_sweep")
local = datetime.now().astimezone()
looked = local.replace(hour=12, minute=0, second=0, microsecond=0) - timedelta(days=1)
set_setting(conn, "today_looked_at", fmt(looked.astimezone(timezone.utc)))
conn.commit()
print(json.dumps({"old_protein": ids["protein"]["old"], "sweep": sweep, "quantum": ids["quantum"]["old"]}))
`;

interface Seeded { old_protein: number[]; sweep: number; quantum: number[] }
interface MapBody { state: string; points: { id: number[]; x: number[]; y: number[] } }

async function engine<T>(win: Page, route: string, method = 'GET', body?: unknown): Promise<T> {
  return win.evaluate(async ([r, m, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m as string,
      headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    return response.json();
  }, [route, method, body] as const) as Promise<T>;
}

/**
 * Wait for the plate to hold still. It eases into its view as it opens, and on a
 * slow machine a position read mid-ease puts the click where a dot used to be.
 */
async function stillView(win: Page, canvas: string): Promise<void> {
  let last = '';
  await expect.poll(async () => {
    const view = (await win.locator(canvas).getAttribute('data-view')) ?? '';
    const held = view !== '' && view === last;
    last = view;
    return held;
  }, { intervals: [400], timeout: 20_000 }).toBe(true);
}

/** Click a paper's dot: where the plate's drawing puts it, read from the plate's own view. */
async function clickPaper(win: Page, canvas: string, id: number, map: MapBody): Promise<void> {
  const at = map.points.id.indexOf(id);
  expect(at, `paper ${id} is on the map`).toBeGreaterThanOrEqual(0);
  const node = win.locator(canvas);
  const [cx, cy, scale] = ((await node.getAttribute('data-view')) ?? '').split(' ').map(Number);
  const box = await node.boundingBox();
  if (!box || cx === undefined || cy === undefined || scale === undefined) throw new Error('the plate has no view');
  const x = ((map.points.x[at] ?? 0) - cx) * scale + box.width / 2;
  const y = box.height / 2 - ((map.points.y[at] ?? 0) - cy) * scale;
  await node.click({ position: { x, y } });
}

/**
 * The first of *ids* whose dot a click can reach. Today's title block sits over
 * a corner of the plate, and how much it covers depends on the window's size,
 * which a CI runner's screen decides; any of these papers serves the step.
 */
async function reachable(win: Page, canvas: string, ids: readonly number[], map: MapBody): Promise<number> {
  const node = win.locator(canvas);
  const [cx, cy, scale] = ((await node.getAttribute('data-view')) ?? '').split(' ').map(Number);
  const box = await node.boundingBox();
  if (!box || cx === undefined || cy === undefined || scale === undefined) throw new Error('the plate has no view');
  for (const id of ids) {
    const at = map.points.id.indexOf(id);
    if (at < 0) continue;
    const x = box.x + ((map.points.x[at] ?? 0) - cx) * scale + box.width / 2;
    const y = box.y + box.height / 2 - ((map.points.y[at] ?? 0) - cy) * scale;
    const hit = await node.evaluate((el, [px, py]) => {
      const top = document.elementFromPoint(px, py);
      return top === el;
    }, [x, y] as const);
    if (hit) return id;
  }
  throw new Error(`none of papers ${ids.join(', ')} can be clicked on ${canvas}`);
}

/**
 * Click papers among *ids* until one of them opens beside the map: the dot
 * clicked and the paper it opened. A click opens the nearest paper, and on a
 * small plate that can be another paper's dot drawn over this one, a new one
 * that the list shows instead.
 */
async function openBeside(win: Page, canvas: string, ids: readonly number[], map: MapBody): Promise<{ clicked: number; opened: number }> {
  const panel = win.locator('section[data-map-paper]');
  // Today's title block covers a corner of the plate until the map is moved from
  // its whole view; in a short window that corner can hold every one of these.
  // One step in sends it away, as it does for a person exploring.
  const zoomIn = win.locator(canvas).locator('xpath=ancestor::*[contains(@class,"plate")][1]').getByRole('button', { name: 'Zoom in' });
  if (await win.locator('.cartouche:not(.away)').count()) {
    await zoomIn.click();
    await expect(win.locator('.cartouche:not(.away)')).toHaveCount(0);
  }
  for (const id of ids) {
    await stillView(win, canvas);
    const clicked = await reachable(win, canvas, [id], map).catch(() => null);
    if (clicked === null) continue;
    await clickPaper(win, canvas, clicked, map);
    if (await panel.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
      const opened = Number(await panel.getAttribute('data-map-paper'));
      if (ids.includes(opened)) return { clicked, opened };
    }
    await win.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  }
  throw new Error(`none of papers ${ids.join(', ')} opened beside ${canvas}`);
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.unmaximize();
    win?.setSize(w, h);
  }, [width, height] as const);
}

test('the maps: any paper beside the map, a run\'s own map, and filters, colors, and find', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-maps-'));
  const env: Record<string, string> = { ...launchEnv(stateDir, true), RESMON_UI: 'atlas' };
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')],
    { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const seed = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as Seeded;

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const shot = (win: Page, name: string) => win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-maps-${name}.png`) });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    win.on('pageerror', (e) => problems.push(e.message));

    const canvas = '.today .plate-canvas';
    await expect(win.locator(canvas)).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => win.locator(canvas).getAttribute('data-view')).not.toBeNull();
    const map = await engine<MapBody>(win, '/api/map');
    expect(map.state).toBe('ready');
    const placed = map.points.id.length;
    expect(placed).toBe(60);

    // 1. A paper that is not among the new ones opens beside the map, in the list's place.
    // These papers share most of their words, so their dots can fall on one
    // another: a click opens the nearest, which is whichever of them it is.
    // Each of them meets the checks below.
    const { clicked: target, opened: chosen } = await openBeside(win, canvas, seed.old_protein.slice(3), map);
    const panel = win.locator(`section[data-map-paper="${chosen}"]`);
    await expect(panel).toBeVisible();
    await expect(win.locator(canvas)).toHaveAttribute('data-selected', String(chosen));
    await expect(panel.locator('.map-paper-title')).toContainText('Protein');
    await expect(panel.getByRole('region', { name: 'Found by' })).toContainText('Protein structure');
    await expect(panel.getByRole('region', { name: 'Abstract' })).toContainText('A second sentence follows.');
    await expect(panel.getByRole('link', { name: /^doi:10\.5555\/protein\.\d+$/ })).toBeVisible();
    await expect(panel.getByRole('link', { name: 'PDF at arXiv' })).toHaveAttribute('href', /^https:\/\/arxiv\.org\/pdf\/2401\./);
    await expect(panel.getByRole('link', { name: 'Open its page' })).toHaveAttribute('href', `#/papers/${chosen}`);
    await expect(win.getByRole('heading', { name: /^New since yesterday/ })).toHaveCount(0);
    await shot(win, 'today-paper');

    // Saved from beside the map, as the engine then records.
    await panel.getByRole('button', { name: 'Save to read' }).click();
    await expect(panel.locator('.queue-state')).toHaveText('In the reading queue · To read');
    const queue = await engine<{ entries: { document_id: number }[] }>(win, '/api/reading-queue');
    expect(queue.entries.map((entry) => entry.document_id)).toContain(chosen);

    // Escape is the way back, and Back is too; the map's choice goes with it.
    await panel.getByRole('button', { name: 'Mark read' }).focus();
    await win.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(win.getByRole('heading', { name: /^New since yesterday/ })).toBeVisible();
    await expect(win.locator(canvas)).not.toHaveAttribute('data-selected', /.+/);
    await clickPaper(win, canvas, target, map);
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Back to the list' }).click();
    await expect(panel).toHaveCount(0);
    await expect(win.locator(canvas)).toBeFocused();

    // The keyboard chooses too, and the panel follows the map's choice.
    await win.keyboard.press('Enter');
    await expect(win.locator(canvas)).toHaveAttribute('data-selected', /^\d+$/);
    const first = Number(await win.locator(canvas).getAttribute('data-selected'));
    await win.keyboard.press('Shift+ArrowRight');
    await expect(win.locator(canvas)).not.toHaveAttribute('data-selected', String(first));
    const second = Number(await win.locator(canvas).getAttribute('data-selected'));
    const listed = await win.locator(`.entry[data-paper="${second}"]`).count();
    if (listed) await expect(win.locator(`.entry.sel[data-paper="${second}"]`)).toBeVisible();
    else await expect(win.locator(`section[data-map-paper="${second}"]`)).toBeVisible();
    await win.locator(canvas).press('Escape');
    await expect(win.locator(canvas)).not.toHaveAttribute('data-selected', /.+/);

    // 3. Filters dim what they leave out, and say how many are lit.
    const bar = win.getByRole('group', { name: 'Find and filter on the map' });
    const shown = bar.getByRole('status');
    await expect(shown).toHaveText(`All ${placed} papers shown`);
    await bar.getByRole('button', { name: /^Filters/ }).click();
    const filters = win.getByRole('dialog', { name: 'Filter what is lit on the map' });
    await filters.getByRole('checkbox', { name: /Traffic flow/ }).check();
    await expect(shown).toHaveText(`Showing 20 of ${placed} papers`);
    await expect(bar.getByRole('button', { name: /^Filters/ })).toContainText('1');
    await shot(win, 'today-filters-open');
    await win.keyboard.press('Escape');
    await expect(filters).toBeHidden();

    // Colored by source, each color named in the key with how many lit papers wear it.
    await bar.getByRole('button', { name: /^Color/ }).click();
    await win.getByRole('dialog', { name: 'Color the papers by' }).getByRole('radio', { name: /^Source/ }).check();
    await win.keyboard.press('Escape');
    const key = win.locator('.today-plate .plate-key');
    await expect(key.locator('[data-key="source:crossref"]')).toContainText('20');
    await expect(key.locator('[data-key="source:arxiv"]')).toContainText('0');
    await expect(key.locator('[data-key="dimmed"]')).toHaveText('left out by the filters');

    // The find lights its matches; those the filters dim are counted, not stepped to.
    const find = bar.getByRole('searchbox', { name: /Find on the map/ });
    await find.fill('Quantum');
    await expect(shown).toHaveText('No paper on this map matches; 20 more are dimmed by the filters');
    await bar.getByRole('button', { name: /^Filters/ }).click();
    await filters.getByRole('button', { name: 'Clear filters' }).click();
    await win.keyboard.press('Escape');
    await expect(shown).toHaveText('20 papers match');
    await find.press('Enter');
    const stepped = win.locator('section[data-map-paper]');
    await expect(stepped).toBeVisible();
    await expect(stepped.locator('.map-paper-title')).toContainText('Quantum');
    await expect(bar.locator('.map-find-at')).toHaveText('1 of 20');
    await find.press('Enter');
    await expect(bar.locator('.map-find-at')).toHaveText('2 of 20');
    await shot(win, 'today-find');

    // Remembered by the engine, and drawn from it after a reload.
    const view = await engine<{ color: string; watches: number[] }>(win, '/api/map/views/today');
    expect(view).toMatchObject({ color: 'source', watches: [] });
    await win.reload();
    await expect(win.locator(canvas)).toBeVisible({ timeout: 60_000 });
    await expect(win.getByRole('group', { name: 'Find and filter on the map' }).getByRole('button', { name: /^Color/ }))
      .toContainText('Source');

    // 2. The Deep Sweep's own map: only its papers, how many are placed, and why the rest are not.
    await win.locator('nav[aria-label="Sections"]').waitFor();
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, seed.sweep);
    await win.getByRole('button', { name: 'Open the run’s own map' }).click();
    await expect(win.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true');
    const runMap = win.locator(`[data-run-map="${seed.sweep}"]`);
    // Opened from the run's sky, the map is scrolled to, and the whole of it fits in the window.
    await expect.poll(async () => {
      const box = await runMap.boundingBox();
      const height = await win.evaluate(() => window.innerHeight);
      return box !== null && box.y > 0 && box.y + box.height <= height;
    }, { timeout: 5_000 }).toBe(true);
    await expect(runMap).toHaveAttribute('data-placed', '15');
    await expect(runMap).toHaveAttribute('data-total', '18');
    await expect(runMap.locator('[data-run-map="placement"]')).toHaveText('15 of the 18 papers this run stored are on the map.');
    await expect(runMap.locator('[data-run-map="unplaced"]'))
      .toHaveText('3 are not: they have too little text in their titles and abstracts to place by wording. They are still in the Papers tab.');
    const runCanvas = `[data-run-map="${seed.sweep}"] .plate-canvas`;
    await expect.poll(() => win.locator(runCanvas).getAttribute('data-view')).not.toBeNull();
    await expect(runMap.getByRole('group', { name: 'Find and filter on the map' }).getByRole('status'))
      .toHaveText('All 15 papers shown');
    await stillView(win, runCanvas);
    const inRun = await reachable(win, runCanvas, seed.quantum.slice(4, 15), map);
    await clickPaper(win, runCanvas, inRun, map);
    const runPanel = runMap.locator(`section[data-map-paper="${inRun}"]`);
    await expect(runPanel).toBeVisible();
    await expect(runPanel.getByRole('region', { name: 'Found by' })).toContainText('Deep Sweep');
    await shot(win, 'run-map-paper');
    await win.keyboard.press('Escape');
    await expect(runPanel).toHaveCount(0);
    await expect(runMap.getByRole('heading', { name: 'This run on the map' })).toBeVisible();
    await shot(win, 'run-map');

    // The other theme, and the narrow and wide windows, pictured for review.
    const theme = await win.evaluate(() => document.documentElement.dataset.theme);
    const other = theme === 'dark' ? 'light' : 'dark';
    await engine(win, '/api/appearance', 'PUT', { theme: other, accent: null });
    await win.reload();
    await win.locator('nav[aria-label="Sections"]').waitFor({ timeout: 60_000 });
    await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(other);
    await win.getByRole('tab', { name: 'Map' }).click();
    await expect.poll(() => win.locator(runCanvas).getAttribute('data-view')).not.toBeNull();
    await clickPaper(win, runCanvas, inRun, map);
    await shot(win, `run-map-${other}`);
    for (const [width, height] of [[1280, 800], [1920, 1080]] as const) {
      await resize(app, width, height);
      await win.evaluate(() => { window.location.hash = '#/'; });
      await expect(win.locator(canvas)).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => win.locator(canvas).getAttribute('data-view')).not.toBeNull();
      const now = await engine<MapBody>(win, '/api/map');
      const { clicked: here } = await openBeside(win, canvas, [chosen, ...seed.old_protein], now);
      await shot(win, `today-${other}-${width}`);
      await engine(win, '/api/appearance', 'PUT', { theme: theme ?? 'dark', accent: null });
      await win.reload();
      await win.locator('nav[aria-label="Sections"]').waitFor({ timeout: 60_000 });
      await expect(win.locator(canvas)).toBeVisible({ timeout: 60_000 });
      await stillView(win, canvas);
      await clickPaper(win, canvas, here, now);
      await shot(win, `today-${theme}-${width}`);
      await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, seed.sweep);
      await win.getByRole('tab', { name: 'Map' }).click();
      await expect.poll(() => win.locator(runCanvas).getAttribute('data-view')).not.toBeNull();
      await shot(win, `run-map-${theme}-${width}`);
      await engine(win, '/api/appearance', 'PUT', { theme: other, accent: null });
      await win.reload();
      await win.locator('nav[aria-label="Sections"]').waitFor({ timeout: 60_000 });
    }

    expect(problems, 'the page reported errors').toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
