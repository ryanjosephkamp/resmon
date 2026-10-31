/**
 * Every map in Atlas can be explored, in the real app, over the maps specs'
 * collection: on Search › Your collection the ringed matches open in the
 * results' place and Back returns to the results with the search box's words
 * kept; on Watches a paper opens in the list's place, and on a watch's page and
 * a run's page beside the map, in the column there; a paper's page opens a
 * neighbor's own page. Hover names a paper. A map in a page that scrolls
 * leaves the wheel to the page. Search's fields take the caret on arrival but
 * not on Back. The pages are pictured at 1024 by 768 and at 1728 wide.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { launchEnv, registerStateDir, FRONTEND_ROOT, SCREENSHOT_DIR } from './fixtures/resmon-app';
import { SEED, clickPaper, engine, reachable, resize, stillView, type MapBody, type Seeded } from './fixtures/maps';

/** A plate drawn, and holding still, so a dot is where its view says. */
async function drawn(win: Page, canvas: string): Promise<void> {
  await expect(win.locator(canvas)).toBeVisible({ timeout: 60_000 });
  await stillView(win, canvas);
}

/** Click among *ids* until one opens beside the map, and return the one that opened. */
async function openOn(win: Page, canvas: string, ids: readonly number[], map: MapBody): Promise<number> {
  const panel = win.locator('section[data-map-paper]');
  for (const id of ids) {
    await stillView(win, canvas);
    const reached = await reachable(win, canvas, [id], map).catch(() => null);
    if (reached === null) continue;
    await clickPaper(win, canvas, reached, map);
    if (await panel.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
      return Number(await panel.getAttribute('data-map-paper'));
    }
  }
  throw new Error(`none of papers ${ids.join(', ')} opened from ${canvas}`);
}

test('every map: hover names a paper, a click opens it beside the map or on its page', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-maps-pages-'));
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
  const shot = (win: Page, name: string) => win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-maps-pages-${name}.png`) });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    win.on('pageerror', (e) => problems.push(e.message));
    await resize(app, 1440, 900);
    await drawn(win, '.today .plate-canvas');
    const map = await engine<MapBody>(win, '/api/map');
    expect(map.state).toBe('ready');
    const sections = win.getByRole('navigation', { name: 'Sections' });

    // Search › Your collection: the caret is in the search box on arrival.
    await sections.getByRole('link', { name: 'Search' }).click();
    const query = win.locator('#collection-query');
    await expect(query).toBeFocused();
    await win.keyboard.type('Quantum');
    const collection = '.collection .plate-canvas';
    await drawn(win, collection);
    await expect(win.locator('.collection .sky figcaption')).toContainText('Marked: 20 matches');
    // Hover names the paper under the pointer.
    await stillView(win, collection);
    const hovered = await reachable(win, collection, seed.quantum, map);
    const view = ((await win.locator(collection).getAttribute('data-view')) ?? '').split(' ').map(Number);
    const box = await win.locator(collection).boundingBox();
    const at = map.points.id.indexOf(hovered);
    if (!box || view.length < 3) throw new Error('the plate has no view');
    await win.mouse.move(box.x + ((map.points.x[at] ?? 0) - (view[0] ?? 0)) * (view[2] ?? 1) + box.width / 2,
      box.y + box.height / 2 - ((map.points.y[at] ?? 0) - (view[1] ?? 0)) * (view[2] ?? 1));
    await expect(win.locator('.collection .tip b')).toContainText('Quantum');
    // A ringed match opens in the results' place, and Back returns with the words kept.
    const fromSearch = await openOn(win, collection, seed.quantum, map);
    const searchPanel = win.locator(`section[data-map-paper="${fromSearch}"]`);
    await expect(searchPanel.locator('.map-paper-title')).toContainText('Quantum');
    await expect(win.getByRole('region', { name: 'Your collection' })).toBeHidden();
    await expect(win.locator(collection)).toHaveAttribute('data-selected', String(fromSearch));
    await shot(win, 'collection-paper');
    await searchPanel.getByRole('button', { name: 'Back to the results' }).click();
    await expect(win.getByRole('region', { name: 'Your collection' })).toBeVisible();
    await expect(query).toHaveValue('Quantum');
    await expect(win.locator(collection)).toBeFocused();

    // Ask the sources takes the caret in its terms on arrival; Back to Your collection does not.
    await win.locator('.search-tabs').getByRole('link', { name: 'Ask the sources' }).click();
    await expect(win.locator('#ask-terms')).toBeFocused();
    await win.evaluate(() => window.history.back());
    await expect(win.locator('#collection-query')).toBeVisible();
    await expect(win.locator('#collection-query')).not.toBeFocused();

    // Watches: the lit watch's papers outlined; a paper opens in the list's place, Escape returns.
    await sections.getByRole('link', { name: 'Watches' }).click();
    const watches = '.watches .plate-canvas';
    await drawn(win, watches);
    const fromWatches = await openOn(win, watches, seed.old_protein, map);
    const watchesPanel = win.locator(`section[data-map-paper="${fromWatches}"]`);
    await expect(watchesPanel.getByRole('button', { name: 'Back to the watches' })).toBeVisible();
    await expect(win.getByRole('region', { name: 'Watches' })).toBeHidden();
    await shot(win, 'watches-paper');
    await watchesPanel.getByRole('button', { name: 'Back to the watches' }).focus();
    await win.keyboard.press('Escape');
    await expect(watchesPanel).toHaveCount(0);
    await expect(win.getByRole('region', { name: 'Watches' })).toBeVisible();

    // A watch's page: the paper opens in the run history's place, beside the map.
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, seed.protein_watch);
    const watch = '.watch-main .plate-canvas';
    await drawn(win, watch);
    const fromWatch = await openOn(win, watch, seed.old_protein, map);
    const watchPanel = win.locator(`.watch-main section[data-map-paper="${fromWatch}"]`);
    await expect(watchPanel.getByRole('region', { name: 'Found by' })).toContainText('Protein structure');
    await shot(win, 'watch-paper');
    // The page scrolls under the wheel over its map; the map keeps its view.
    const before = await win.locator(watch).getAttribute('data-view');
    const scroller = win.locator('.run');
    const top = await scroller.evaluate((el) => el.scrollTop);
    const watchBox = await win.locator(watch).boundingBox();
    if (!watchBox) throw new Error('the watch map has no box');
    await win.mouse.move(watchBox.x + watchBox.width / 2, watchBox.y + watchBox.height / 2);
    await win.mouse.wheel(0, 240);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(top);
    expect(await win.locator(watch).getAttribute('data-view')).toBe(before);
    await watchPanel.getByRole('button', { name: 'Back to the runs' }).click();
    await expect(watchPanel).toHaveCount(0);

    // A run's small map: the paper opens in the sources' place.
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, seed.sweep);
    const runSky = '.run-main .plate-canvas';
    await drawn(win, runSky);
    const fromRun = await openOn(win, runSky, seed.quantum.slice(0, 15), map);
    const runPanel = win.locator(`.run-main section[data-map-paper="${fromRun}"]`);
    await expect(runPanel.getByRole('region', { name: 'Found by' })).toContainText('Deep Sweep');
    await expect(win.getByRole('region', { name: 'Sources' })).toBeHidden();
    await shot(win, 'run-paper');
    await runPanel.getByRole('button', { name: 'Back to the sources' }).click();
    await expect(win.getByRole('region', { name: 'Sources' })).toBeVisible();

    // A paper's page: a neighbor's dot opens that paper's own page.
    const focus = seed.old_protein[3] ?? 0;
    await win.evaluate((id) => { window.location.hash = `#/papers/${id}`; }, focus);
    const paperSky = '.paper-side .plate-canvas';
    await drawn(win, paperSky);
    await expect(win.locator(paperSky)).toHaveAttribute('data-selected', String(focus));
    await stillView(win, paperSky);
    const neighbor = await reachable(win, paperSky, seed.old_protein.filter((id) => id !== focus), map);
    await clickPaper(win, paperSky, neighbor, map);
    await expect.poll(() => win.evaluate(() => window.location.hash)).toMatch(/^#\/papers\/\d+$/);
    expect(await win.evaluate(() => window.location.hash)).not.toBe(`#/papers/${focus}`);

    // Each page pictured in a 1024 by 768 window, as CI's macOS job runs, and at the owner's 1728.
    // CI's macOS job runs in a 1024 by 684 to 768 window; the owner's is 1728 wide.
    for (const [width, height] of [[1024, 684], [1024, 768], [1728, 1080]] as const) {
      await resize(app, width, height);
      await sections.getByRole('link', { name: 'Search' }).click();
      await drawn(win, collection);
      await win.locator('#collection-query').fill('Quantum');
      await expect(win.locator('.collection .sky figcaption')).toContainText('Marked: 20 matches');
      await openOn(win, collection, seed.quantum, map);
      await shot(win, `collection-${width}x${height}`);
      await sections.getByRole('link', { name: 'Watches' }).click();
      await drawn(win, watches);
      await shot(win, `watches-${width}x${height}`);
      await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, seed.protein_watch);
      await drawn(win, watch);
      await openOn(win, watch, seed.old_protein, map);
      await shot(win, `watch-${width}x${height}`);
      await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, seed.sweep);
      await drawn(win, runSky);
      await shot(win, `run-${width}x${height}`);
      await win.evaluate((id) => { window.location.hash = `#/papers/${id}`; }, focus);
      await drawn(win, paperSky);
      await shot(win, `paper-${width}x${height}`);
    }

    expect(problems, 'the page reported errors').toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
