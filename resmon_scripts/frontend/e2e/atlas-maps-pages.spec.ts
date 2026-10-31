/**
 * Every map in Atlas can be explored, in the real app, over the maps specs'
 * collection: on Search › Your collection a match opens in the results' place
 * and Back returns to the results with the search box's words kept; on
 * Watches a paper opens in the list's place, and on a watch's page and a run's
 * page beside the map, in the column there; a paper's page opens a
 * neighbor's own page. Hover names a paper, and a click opens it. A map in a
 * page that scrolls leaves the wheel to the page. Search's fields take the
 * caret on arrival but not on Back. The pages are pictured at 1024 by 684 and
 * 768, and at 1728 wide.
 *
 * Papers are chosen from the keyboard (the plate focused, Enter for the lit
 * paper nearest its middle) and checked by what they open; the one click is
 * aimed at the middle of a map that "Show it on the map" has just centered on
 * a paper, never at a position computed from a plate's view.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { launchEnv, registerStateDir, FRONTEND_ROOT, SCREENSHOT_DIR } from './fixtures/resmon-app';
import {
  SEED, chooseByKeyboard, clickCenter, engine, mapsEnv, resize, stillView, throttle, type MapBody, type Seeded,
} from './fixtures/maps';

/** A plate drawn, and holding still. */
async function drawn(win: Page, canvas: string): Promise<void> {
  await expect(win.locator(canvas)).toBeVisible({ timeout: 60_000 });
  await stillView(win, canvas);
}

/** The paper open beside a map, once one is: its id. */
async function opened(win: Page, scope = ''): Promise<number> {
  const panel = win.locator(`${scope} section[data-map-paper]`.trim());
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return Number(await panel.getAttribute('data-map-paper'));
}

test('every map: hover names a paper, a click opens it beside the map or on its page', async () => {
  test.setTimeout(420_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-maps-pages-'));
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
  const shot = (win: Page, name: string) => win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-maps-pages-${name}.png`) });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await throttle(win);
    const problems: string[] = [];
    win.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    win.on('pageerror', (e) => problems.push(e.message));
    await resize(app, 1440, 900);
    await drawn(win, '.today .plate-canvas');
    const map = await engine<MapBody>(win, '/api/map');
    expect(map.state).toBe('ready');
    const sections = win.getByRole('navigation', { name: 'Sections' });
    const results = win.getByRole('region', { name: 'Your collection' });

    // Search › Your collection: the caret is in the search box on arrival.
    await sections.getByRole('link', { name: 'Search' }).click();
    const query = win.locator('#collection-query');
    await expect(query).toBeFocused();
    await win.keyboard.type('Quantum');
    const collection = '.collection .plate-canvas';
    await drawn(win, collection);
    await expect(win.locator('.collection .sky figcaption')).toContainText('Marked: 20 matches');
    // A match chosen from the keyboard opens in the results' place.
    await chooseByKeyboard(win, collection);
    const fromSearch = await opened(win);
    expect(seed.quantum).toContain(fromSearch);
    await expect(win.locator(collection)).toHaveAttribute('data-selected', String(fromSearch));
    await expect(results).toBeHidden();
    const searchPanel = win.locator(`section[data-map-paper="${fromSearch}"]`);
    await expect(searchPanel.locator('.map-paper-title')).toContainText('Quantum');
    // "Show it on the map" centers it; the pointer there names it.
    await searchPanel.getByRole('button', { name: /^Show it on the map/ }).click();
    await stillView(win, collection);
    const box = await win.locator(collection).boundingBox();
    if (!box) throw new Error('the map has no box');
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(win.locator('.collection .tip b')).toContainText('Quantum');
    await shot(win, 'collection-paper');
    // Back returns to the results with the words kept, and the map's choice goes with the paper.
    await searchPanel.getByRole('button', { name: 'Back to the results' }).click();
    await expect(results).toBeVisible();
    await expect(query).toHaveValue('Quantum');
    await expect(win.locator(collection)).toBeFocused();
    await expect(win.locator(collection)).not.toHaveAttribute('data-selected', /.+/);
    // A click on the paper's dot, where Show it on the map left it, opens it again
    // (or a match drawn on the very same spot: papers with the same words can share one).
    await clickCenter(win, collection);
    const again = await opened(win);
    const spot = (id: number) => { const i = map.points.id.indexOf(id); return [map.points.x[i], map.points.y[i]]; };
    expect(spot(again)).toEqual(spot(fromSearch));
    await win.locator(`section[data-map-paper="${again}"]`).getByRole('button', { name: 'Back to the results' }).click();
    await expect(results).toBeVisible();

    // Ask the sources takes the caret in its terms on arrival; Back to Your collection does not.
    await win.locator('.search-tabs').getByRole('link', { name: 'Ask the sources' }).click();
    await expect(win.locator('#ask-terms')).toBeFocused();
    await win.evaluate(() => window.history.back());
    await expect(win.locator('#collection-query')).toBeVisible();
    await expect(win.locator('#collection-query')).not.toBeFocused();

    // Watches: the lit watch's papers outlined; a paper opens in the list's place, Escape returns.
    const watchList = win.getByRole('region', { name: 'Watches' });
    await sections.getByRole('link', { name: 'Watches' }).click();
    const watches = '.watches .plate-canvas';
    await drawn(win, watches);
    await chooseByKeyboard(win, watches);
    const fromWatches = await opened(win);
    const watchesPanel = win.locator(`section[data-map-paper="${fromWatches}"]`);
    await expect(watchesPanel.locator('.map-paper-title')).toContainText('Protein');
    await expect(watchList).toBeHidden();
    await shot(win, 'watches-paper');
    await watchesPanel.getByRole('button', { name: 'Back to the watches' }).focus();
    await win.keyboard.press('Escape');
    await expect(watchesPanel).toHaveCount(0);
    await expect(watchList).toBeVisible();

    // A watch's page: the paper opens in the run history's place, beside the map.
    await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, seed.protein_watch);
    const watch = '.watch-main .plate-canvas';
    await drawn(win, watch);
    await chooseByKeyboard(win, watch);
    const fromWatch = await opened(win, '.watch-main');
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
    await chooseByKeyboard(win, runSky);
    const fromRun = await opened(win, '.run-main');
    expect(seed.quantum.slice(0, 15)).toContain(fromRun);
    const runPanel = win.locator(`.run-main section[data-map-paper="${fromRun}"]`);
    await expect(runPanel.getByRole('region', { name: 'Found by' })).toContainText('Deep Sweep');
    await expect(win.getByRole('region', { name: 'Sources' })).toBeHidden();
    await shot(win, 'run-paper');
    await runPanel.getByRole('button', { name: 'Back to the sources' }).click();
    await expect(win.getByRole('region', { name: 'Sources' })).toBeVisible();

    // A paper's page: a neighbor chosen from the keyboard, and Enter opens that paper's own page.
    const focus = seed.old_protein[3] ?? 0;
    await win.evaluate((id) => { window.location.hash = `#/papers/${id}`; }, focus);
    const paperSky = '.paper-side .plate-canvas';
    await drawn(win, paperSky);
    await expect(win.locator(paperSky)).toHaveAttribute('data-selected', String(focus));
    await win.locator(paperSky).focus();
    let neighbor = focus;
    for (const way of ['Shift+ArrowRight', 'Shift+ArrowLeft', 'Shift+ArrowUp', 'Shift+ArrowDown']) {
      await win.keyboard.press(way);
      neighbor = Number(await win.locator(paperSky).getAttribute('data-selected'));
      if (neighbor !== focus) break;
    }
    expect(neighbor).not.toBe(focus);
    await win.keyboard.press('Enter');
    await expect.poll(() => win.evaluate(() => window.location.hash)).toBe(`#/papers/${neighbor}`);

    // Each page pictured in CI's macOS window, 1024 by 684, and in 1024 by 768 and at the owner's 1728.
    for (const [width, height] of [[1024, 684], [1024, 768], [1728, 1080]] as const) {
      await resize(app, width, height);
      await sections.getByRole('link', { name: 'Search' }).click();
      await drawn(win, collection);
      await win.locator('#collection-query').fill('Quantum');
      await expect(win.locator('.collection .sky figcaption')).toContainText('Marked: 20 matches');
      await chooseByKeyboard(win, collection);
      await opened(win);
      await shot(win, `collection-${width}x${height}`);
      await sections.getByRole('link', { name: 'Watches' }).click();
      await drawn(win, watches);
      await shot(win, `watches-${width}x${height}`);
      await win.evaluate((id) => { window.location.hash = `#/watches/${id}`; }, seed.protein_watch);
      await drawn(win, watch);
      await chooseByKeyboard(win, watch);
      await opened(win, '.watch-main');
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
