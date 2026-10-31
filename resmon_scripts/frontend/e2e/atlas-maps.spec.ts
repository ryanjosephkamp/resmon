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
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { launchEnv, registerStateDir, FRONTEND_ROOT, SCREENSHOT_DIR } from './fixtures/resmon-app';
import {
  SEED, clearFind, clickCenter, engine, findAndOpen, mapsEnv, resize, stillView, throttle, uniqueTitle, type MapBody, type Seeded,
} from './fixtures/maps';

test('the maps: any paper beside the map, a run\'s own map, and filters, colors, and find', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-maps-'));
  const env = mapsEnv(launchEnv(stateDir, true));
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
    await throttle(win);
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

    // 1. A paper that is not among the new ones opens beside the map, in the list's place:
    // found by its title, which flies the map to it and opens it.
    const today = win.locator('.today-plate');
    const { id: chosen, title: chosenTitle } = await uniqueTitle(win, seed.old_protein.slice(3));
    expect(await findAndOpen(win, today, canvas, chosenTitle)).toBe(chosen);
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
    // A click on its dot, which the find left in the middle of the map, opens it again.
    await clickCenter(win, canvas);
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Back to the list' }).click();
    await expect(panel).toHaveCount(0);
    await expect(win.locator(canvas)).toBeFocused();
    await clearFind(today);

    // The keyboard chooses too, and the panel follows the map's choice.
    await win.locator(canvas).focus();
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
    await throttle(win);
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
    const { id: inRun, title: inRunTitle } = await uniqueTitle(win, seed.quantum.slice(4, 15));
    expect(await findAndOpen(win, runMap, runCanvas, inRunTitle)).toBe(inRun);
    const runPanel = runMap.locator(`section[data-map-paper="${inRun}"]`);
    await expect(runPanel).toBeVisible();
    await expect(runPanel.getByRole('region', { name: 'Found by' })).toContainText('Deep Sweep');
    await shot(win, 'run-map-paper');
    await runPanel.getByRole('button', { name: "Back to the run's map" }).focus();
    await win.keyboard.press('Escape');
    await expect(runPanel).toHaveCount(0);
    await expect(runMap.getByRole('heading', { name: 'This run on the map' })).toBeVisible();
    await shot(win, 'run-map');

    // The other theme, and the narrow and wide windows, pictured for review.
    const theme = await win.evaluate(() => document.documentElement.dataset.theme);
    const other = theme === 'dark' ? 'light' : 'dark';
    await engine(win, '/api/appearance', 'PUT', { theme: other, accent: null });
    await win.reload();
    await throttle(win);
    await win.locator('nav[aria-label="Sections"]').waitFor({ timeout: 60_000 });
    await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(other);
    await win.getByRole('tab', { name: 'Map' }).click();
    await expect.poll(() => win.locator(runCanvas).getAttribute('data-view')).not.toBeNull();
    expect(await findAndOpen(win, runMap, runCanvas, inRunTitle)).toBe(inRun);
    await shot(win, `run-map-${other}`);
    // CI's macOS job runs in a 1024 by 684 window; the owner's is 1728 wide.
    for (const [width, height] of [[1024, 768], [1280, 800], [1728, 1080], [1920, 1080]] as const) {
      await resize(app, width, height);
      await win.evaluate(() => { window.location.hash = '#/'; });
      await expect(win.locator(canvas)).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => win.locator(canvas).getAttribute('data-view')).not.toBeNull();
      expect(await findAndOpen(win, today, canvas, chosenTitle)).toBe(chosen);
      await shot(win, `today-${other}-${width}`);
      await engine(win, '/api/appearance', 'PUT', { theme: theme ?? 'dark', accent: null });
      await win.reload();
      await throttle(win);
      await win.locator('nav[aria-label="Sections"]').waitFor({ timeout: 60_000 });
      await expect(win.locator(canvas)).toBeVisible({ timeout: 60_000 });
      await stillView(win, canvas);
      expect(await findAndOpen(win, today, canvas, chosenTitle)).toBe(chosen);
      await shot(win, `today-${theme}-${width}`);
      await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, seed.sweep);
      await win.getByRole('tab', { name: 'Map' }).click();
      await expect.poll(() => win.locator(runCanvas).getAttribute('data-view')).not.toBeNull();
      await shot(win, `run-map-${theme}-${width}`);
      await engine(win, '/api/appearance', 'PUT', { theme: other, accent: null });
      await win.reload();
      await throttle(win);
      await win.locator('nav[aria-label="Sections"]').waitFor({ timeout: 60_000 });
    }

    expect(problems, 'the page reported errors').toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
