/**
 * Atlas: many papers saved to the reading queue at once, in the real app, from
 * the four places that offer it: Search › Your collection, a run's Papers,
 * Today's list, and the map.
 *
 * The collection is written before launch: 260 papers on lattice gauge
 * theory, three of them saved already and one of those read; a Deep Sweep
 * that stored 60 papers on spectral graphs, 45 of them new to the collection;
 * 30 papers on protein folding collected two hours ago, which Today lists as
 * new; and seven quasicrystal papers for the map's find. In each place rows
 * are picked by click, Shift-click, and the keyboard, and saved; Select all
 * saves every match, every paper, or every new paper, not the rows drawn; and
 * after each save the reading queue is read from the engine and held to what
 * the notice said. The search's list is virtual, so its size is read from
 * `aria-setsize`, never from the rows drawn. Saving more than 200 asks first;
 * Undo takes back what a save added.
 *
 * The walk is taken twice: in the suite's window, which saves screenshots,
 * and in the smallest window the app allows, 960 by 640. No network.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { shelfHolds } from './fixtures/gallery';
import { engine } from './fixtures/maps';
import { removeStateDir } from './fixtures/cleanup';

const SEED = String.raw`
import json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, sys.argv[1])
from implementation_scripts.database import (init_db, get_connection, insert_document, insert_routine, insert_execution,
    link_execution_document, record_execution_source, update_execution_status, set_setting)
from implementation_scripts import reading_queue
path = os.environ["RESMON_DB_PATH"]
init_db(path)
conn = get_connection(path)
now = datetime.now(timezone.utc)
fmt = lambda t: t.strftime("%Y-%m-%d %H:%M:%S")
day0 = datetime(2024, 1, 1)
def paper(topic, n, words, source, seen, title=None):
    w = words.split()
    doc = insert_document(conn, {
        "source_repository": source, "external_id": f"{topic}-{n}",
        "title": title or f"{w[0].title()} {w[n % len(w)]} {w[(n + 3) % len(w)]} study {n}",
        "authors": "Ada Fixture, Ben Fixture" if n % 2 else "Cleo Fixture",
        "abstract": " ".join(w[(n + k) % len(w)] for k in range(30)) + ". An authored abstract for the suite.",
        "publication_date": (day0 + timedelta(days=n)).strftime("%Y-%m-%d"),
        "url": f"https://example.org/{topic}/{n}", "metadata_hash": f"{topic}-{n}",
    })
    conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (fmt(seen), doc))
    return doc
old = now - timedelta(days=20)
lattice = [paper("lattice", n, "lattice gauge quark gluon confinement chiral fermion hadron", "arxiv", old) for n in range(260)]
crystals = [paper("crystal", n, "quasicrystal aperiodic tiling penrose diffraction order", "arxiv", old,
                  title=f"Quasicrystal tiling order {n}") for n in range(7)]
spectral = [paper("spectral", n, "spectral graph laplacian eigenvalue clustering partition cut", "crossref", old) for n in range(60)]
protein = [paper("protein", n, "protein folding residue amino chain conformation binding", "pubmed", now - timedelta(hours=2))
           for n in range(30)]
conn.commit()
sweep = insert_execution(conn, {"execution_type": "deep_sweep", "parameters": json.dumps({"query": "spectral graphs",
    "repositories": ["crossref"]}), "start_time": fmt(now - timedelta(days=3))})
for doc in spectral:
    link_execution_document(conn, sweep, doc)
# The 15 oldest it stored were in the collection before it: not new to it.
conn.executemany("UPDATE execution_documents SET is_new = 0 WHERE execution_id = ? AND document_id = ?",
                 [(sweep, d) for d in spectral[:15]])
record_execution_source(conn, sweep, "crossref", "ok", result_count=60, zero_reason=None)
update_execution_status(conn, sweep, "completed", end_time=fmt(now - timedelta(days=3) + timedelta(seconds=40)),
                        result_count=60, new_result_count=45)
watch = insert_routine(conn, {"name": "Protein structure", "schedule_cron": "0 2 * * *",
    "parameters": json.dumps({"repositories": ["pubmed"], "query": "protein"}), "is_active": 0})
run = insert_execution(conn, {"execution_type": "automated_sweep", "routine_id": watch, "parameters": "{}",
    "start_time": fmt(now - timedelta(hours=2))})
for doc in protein:
    link_execution_document(conn, run, doc)
record_execution_source(conn, run, "pubmed", "ok", result_count=30, zero_reason=None)
update_execution_status(conn, run, "completed", end_time=fmt(now - timedelta(hours=2) + timedelta(seconds=30)),
                        result_count=30, new_result_count=30)
set_setting(conn, "today_looked_at", fmt(now - timedelta(days=1)))
# The three newest lattice papers are saved already, and the second of them is read.
for doc in lattice[-3:]:
    reading_queue.save(conn, doc)
reading_queue.set_status(conn, lattice[-2], "read")
conn.commit()
print(json.dumps({"lattice": lattice, "crystals": crystals, "spectral": spectral, "protein": protein, "sweep": sweep}))
`;

interface Seeded { lattice: number[]; crystals: number[]; spectral: number[]; protein: number[]; sweep: number }
interface Counts { to_read: number; read: number; all: number }
interface QueuePage { counts: Counts; entries: { document_id: number; status: string }[]; total: number }

async function counts(win: Page): Promise<Counts> {
  return (await engine<QueuePage>(win, '/api/reading-queue?limit=1')).counts;
}

/** Every saved paper's id, read from the engine 200 at a time. */
async function queued(win: Page): Promise<Set<number>> {
  const out = new Set<number>();
  for (let offset = 0; ; offset += 200) {
    const page = await engine<QueuePage>(win, `/api/reading-queue?limit=200&offset=${offset}`);
    for (const entry of page.entries) out.add(entry.document_id);
    if (offset + 200 >= page.total) return out;
  }
}

/** The notice a save leaves, once it says this. */
async function noticeSays(win: Page, words: string): Promise<Locator> {
  const notice = win.locator('[data-notice="saved-to-read"]');
  await expect(notice).toContainText(words, { timeout: 30_000 });
  return notice;
}

/** Let the notice go, so the next save's is the only one. */
async function dismiss(win: Page): Promise<void> {
  const notice = win.locator('[data-notice="saved-to-read"]');
  if (await notice.count()) await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
}

async function walk(size: [number, number] | null): Promise<void> {
  const tag = size ? `${size[0]}x${size[1]}` : 'default';
  const shot = async (win: Page, name: string) => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, `save-to-read-${tag}-${name}.png`), animations: 'disabled' });
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-save-to-read-'));
  const env = atlasEnv({ ...launchEnv(stateDir, true), ...(size ? { RESMON_E2E_WIDTH: String(size[0]), RESMON_E2E_HEIGHT: String(size[1]) } : {}) });
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const ids = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as Seeded;

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: 'dark', timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    if (size) expect(await win.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(size[0]);
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 120_000 });
    expect(await counts(win)).toEqual({ to_read: 2, read: 1, all: 3 });

    // — Search › Your collection: picked by click, Shift-click, and the keyboard -----------------------------
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Search' }).click();
    await win.locator('#collection-query').fill('lattice');
    await expect(win.locator('.count-sentence')).toHaveText(/^260 papers match/, { timeout: 30_000 });
    const row = (i: number) => win.locator(`.result-list .result[data-index="${i}"]`);
    await expect(row(0)).toHaveAttribute('aria-setsize', '260');
    const drawn = await win.locator('.result-list .result').count();
    expect(drawn, 'the list drew every match rather than the rows near the view').toBeLessThan(120);
    await win.locator('[data-collection="select"]').click();
    const searchBar = win.getByRole('group', { name: 'The selected matches' });
    await expect(searchBar).toContainText('0 of 260 selected');
    await row(0).locator('input.pickbox').click();
    await row(3).locator('input.pickbox').click({ modifiers: ['Shift'] });
    await expect(searchBar).toContainText('4 of 260 selected');
    // The keyboard: Down to the fifth, Space; Shift and Down picks the sixth as it goes.
    await row(3).locator('input.pickbox').focus();
    await win.keyboard.press('ArrowDown');
    await expect(row(4).locator('input.pickbox')).toBeFocused();
    await win.keyboard.press('Space');
    await win.keyboard.press('Shift+ArrowDown');
    await expect(row(5).locator('input.pickbox')).toBeFocused();
    await expect(searchBar).toContainText('6 of 260 selected');
    await expect(row(5)).toHaveClass(/picked/);
    await shot(win, 'search-picked');
    await searchBar.locator('[data-save="picked"]').click();
    // The three newest are the three saved before: one read, two to read; each stays as it was.
    let notice = await noticeSays(win, '3 papers saved to read. 3 were already in your reading queue.');
    await shot(win, 'search-saved');
    expect(await counts(win)).toEqual({ to_read: 5, read: 1, all: 6 });
    await notice.getByRole('button', { name: 'Undo' }).click();
    await expect(notice).toHaveCount(0, { timeout: 30_000 });
    expect(await counts(win)).toEqual({ to_read: 2, read: 1, all: 3 });

    // Select all is every match, past the 50 rows read, and past 200 it asks first.
    await searchBar.locator('[data-select="all"]').click();
    await expect(searchBar).toContainText('All 260 selected');
    await expect(searchBar.locator('[data-save="picked"]')).toHaveText('Save all 260 to read');
    await searchBar.locator('[data-save="picked"]').click();
    const question = win.locator('[data-confirm="save-to-read"]');
    await expect(question).toContainText('Save all 260 matches to read?');
    await shot(win, 'search-question');
    await question.locator('[data-confirm-act="save-to-read"]').click();
    notice = await noticeSays(win, '257 papers saved to read. 3 were already in your reading queue.');
    const afterSearch = await queued(win);
    for (const id of ids.lattice) expect(afterSearch.has(id), `match ${id} was not saved`).toBe(true);
    expect(await counts(win)).toEqual({ to_read: 259, read: 1, all: 260 });
    await expect(searchBar).toContainText('0 of 260 selected');
    // Unpicked rows: one left out of Select all is not saved.
    await dismiss(win);
    await searchBar.locator('[data-select="done"]').click();
    await expect(searchBar).toHaveCount(0);

    // — A run's Papers: picked rows, and every paper it was the first to find --------------------------------
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, ids.sweep);
    await expect(win.locator('.run-papers-head .record-cap')).toHaveText('60 papers this run stored.', { timeout: 60_000 });
    const saveNew = win.locator('[data-run="save-new"]');
    await expect(saveNew).toHaveText('Save this run’s 45 new papers to read');
    await shot(win, 'run-papers');
    await win.locator('[data-run="select"]').click();
    const runBar = win.getByRole('group', { name: 'The selected papers' });
    await expect(runBar).toContainText('0 of 60 selected');
    const paperBox = (i: number) => win.locator('.paper-list .paper-row').nth(i).locator('input.pickbox');
    await paperBox(0).click();
    await paperBox(0).press('ArrowDown');
    await expect(paperBox(1)).toBeFocused();
    await paperBox(1).press('Space');
    await expect(runBar).toContainText('2 of 60 selected');
    await shot(win, 'run-picked');
    await runBar.locator('[data-save="picked"]').click();
    await noticeSays(win, '2 papers saved to read. None was already in your reading queue.');
    await dismiss(win);
    await runBar.locator('[data-select="done"]').click();
    await saveNew.click();
    // The two picked were the run's newest, which it found first.
    await noticeSays(win, '43 papers saved to read. 2 were already in your reading queue.');
    let saved = await queued(win);
    for (const id of ids.spectral.slice(15)) expect(saved.has(id), `new paper ${id} was not saved`).toBe(true);
    for (const id of ids.spectral.slice(0, 15)) expect(saved.has(id), `paper ${id} was not new to the run`).toBe(false);
    await dismiss(win);
    // Select all: every paper the run stored.
    await win.locator('[data-run="select"]').click();
    await runBar.locator('[data-select="all"]').click();
    await expect(runBar).toContainText('All 60 selected');
    await runBar.locator('[data-save="picked"]').click();
    await noticeSays(win, '15 papers saved to read. 45 were already in your reading queue.');
    await expect(win.locator('.paper-row[data-queue="none"]')).toHaveCount(0, { timeout: 30_000 });
    expect(await counts(win)).toEqual({ to_read: 319, read: 1, all: 320 });
    await dismiss(win);
    await runBar.locator('[data-select="done"]').click();

    // — Today's list: picked entries, then every new paper, listed or not ----------------------------------------
    await win.evaluate(() => { window.location.hash = '#/today'; });
    const index = win.locator('section.index[aria-labelledby="index-title"]');
    await expect(index.locator('#index-title')).toContainText('30', { timeout: 60_000 });
    await index.locator('[data-today="select"]').click();
    const todayBar = win.getByRole('group', { name: 'The selected new papers' });
    await expect(todayBar).toContainText('0 of 30 selected');
    const entryBox = (i: number) => index.locator('article.entry').nth(i).locator('input.pickbox');
    await entryBox(0).click();
    await entryBox(2).click({ modifiers: ['Shift'] });
    await expect(todayBar).toContainText('3 of 30 selected');
    await shot(win, 'today-picked');
    await todayBar.locator('[data-save="picked"]').click();
    await noticeSays(win, '3 papers saved to read. None was already in your reading queue.');
    await expect(index.locator('article.entry').first().getByRole('button', { name: /Saved to your reading queue/ }))
      .toBeVisible({ timeout: 30_000 });
    await dismiss(win);
    // Today lists 25 of a group at first; Select all is every new paper.
    await expect(index.locator('article.entry')).toHaveCount(25);
    await todayBar.locator('[data-select="all"]').click();
    await expect(todayBar).toContainText('All 30 selected');
    await expect(todayBar.locator('[data-save="picked"]')).toHaveText('Save all 30 to read');
    await todayBar.locator('[data-save="picked"]').click();
    await noticeSays(win, '27 papers saved to read. 3 were already in your reading queue.');
    saved = await queued(win);
    for (const id of ids.protein) expect(saved.has(id), `new paper ${id} was not saved`).toBe(true);
    await dismiss(win);
    await todayBar.locator('[data-select="done"]').click();
    await expect(todayBar).toHaveCount(0);

    // — The map: what its find lights, then what a filter leaves lit ----------------------------------------------
    const mapBar = win.getByRole('group', { name: 'Find and filter on the map' });
    await expect(mapBar).toBeVisible({ timeout: 90_000 });
    await expect(mapBar.locator('[data-save="picked"]')).toHaveCount(0);
    await mapBar.getByRole('searchbox', { name: /Find on the map/ }).fill('Quasicrystal');
    await expect(mapBar.getByRole('status')).toHaveText('7 papers match', { timeout: 30_000 });
    await expect(mapBar.locator('[data-save="picked"]')).toHaveText('Save 7 to read');
    await shot(win, 'map-find');
    await mapBar.locator('[data-save="picked"]').click();
    await noticeSays(win, '7 papers saved to read. None was already in your reading queue.');
    saved = await queued(win);
    for (const id of ids.crystals) expect(saved.has(id), `found paper ${id} was not saved`).toBe(true);
    await dismiss(win);
    await mapBar.getByRole('searchbox', { name: /Find on the map/ }).fill('');
    await expect(mapBar.getByRole('status')).toHaveText(/ shown$/, { timeout: 30_000 });
    // A filter: only the papers saved, not yet read, are lit; saving them again changes nothing.
    await mapBar.locator('button[data-facet="today-filters"]').click();
    await win.locator('.facet-menu[data-facet="today-filters"]').getByRole('radio', { name: 'Saved, not yet read' }).check();
    await win.keyboard.press('Escape');
    await expect(mapBar.getByRole('status')).toHaveText(/^Showing 356 of 357 papers$/, { timeout: 30_000 });
    await mapBar.locator('[data-save="picked"]').click();
    await expect(win.locator('[data-confirm="save-to-read"]')).toContainText('the 356 papers the filters leave lit');
    await shot(win, 'map-filter-question');
    await win.locator('[data-confirm-act="save-to-read"]').click();
    await noticeSays(win, 'No papers saved to read. 356 were already in your reading queue.');
    expect(await counts(win)).toEqual({ to_read: 356, read: 1, all: 357 });

    // — The Library holds them all, counted as the gallery states it ---------------------------------------------
    await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Library' }).click();
    await shelfHolds(win, 356);
    await shot(win, 'library');

    // — By day: the bar and a picked row in the light theme, pictured for review ------------------------------------
    if (!size) {
      await engine(win, '/api/appearance', 'PUT', { theme: 'light', accent: null });
      await win.reload();
      await expect(win.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
      await win.evaluate(() => { window.location.hash = '#/today'; });
      await index.locator('[data-today="select"]').click();
      await entryBox(1).click();
      await entryBox(3).click({ modifiers: ['Shift'] });
      await expect(todayBar).toContainText('3 of 30 selected');
      await shot(win, 'today-picked-light');
      await todayBar.locator('[data-select="done"]').click();
      await win.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Search' }).click();
      await win.locator('#collection-query').fill('lattice');
      await expect(row(0)).toHaveAttribute('aria-setsize', '260', { timeout: 30_000 });
      await win.locator('[data-collection="select"]').click();
      await row(1).locator('input.pickbox').click();
      await row(2).locator('input.pickbox').click();
      await expect(searchBar).toContainText('2 of 260 selected');
      await shot(win, 'search-picked-light');
    }

    expect(problems).toEqual([]);
  } finally {
    await app.close();
    removeStateDir(stateDir);
  }
}

const TITLE = 'many papers saved to read at once: Search, a run’s Papers, Today, and the map';

test(TITLE, async () => {
  test.setTimeout(420_000);
  await walk(null);
});

test(`${TITLE}, in a 960 by 640 window`, async () => {
  test.setTimeout(420_000);
  await walk([960, 640]);
});
