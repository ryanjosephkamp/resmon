/**
 * A click with the mouse on a paper's dot opens it, on each map the window's
 * height: Today's, Search › Your collection's, and Watches'. The click is the
 * one a person makes, a press and a release at one point through Chromium's
 * own input, aimed at where the map draws that paper as it first opens (not
 * at the middle of a map a find has flown to). A click a few pixels off a dot
 * opens that paper too; one farther from every paper opens nothing and
 * closes the paper that was open. On Today a numbered paper is in the list,
 * so a click on its ring chooses its entry there.
 *
 * A press whose release the map never sees (the window lost the pointer
 * between them) leaves nothing behind: the pointer moving over the map with
 * no button held does not drag it, and the next click opens a paper.
 *
 * Where a dot is drawn is worked out from the plate's own view
 * (`data-view`), once it has held still, for a paper with no other paper near
 * it on the screen and nothing laid over it there, so the paper a click is
 * aimed at is the only one it can reach.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { launchEnv, registerStateDir, FRONTEND_ROOT, SCREENSHOT_DIR } from './fixtures/resmon-app';
import { SEED, engine, mapsEnv, resize, stillView, throttle, type MapBody, type Seeded } from './fixtures/maps';

/** The plate's frame, inside which papers are drawn; the plate's `MARGIN`, and a little more. */
const FRAME = 34;
/** No other paper is nearer a chosen one than this on the screen. The plate reaches 9 pixels for a click. */
const ALONE = 26;
/** How far off its dot the "just off" click lands: inside the plate's reach, and nearer it than any other paper. */
const NEAR = 6;
/** Dots nearer than this are one spot: papers with the same words. */
const SAME = 1.5;
/** A click this far from every paper reaches none. */
const CLEAR = 24;

interface Spot { id: number; x: number; y: number }
/** One dot on the screen: the papers drawn there, and where. */
interface Dot { ids: number[]; x: number; y: number }

/** Every placed paper's position in the window, as the plate draws it now. */
async function spots(win: Page, canvas: string, map: MapBody): Promise<Spot[]> {
  const plate = win.locator(canvas);
  const box = await plate.boundingBox();
  const view = await plate.getAttribute('data-view');
  if (!box || !view) throw new Error(`${canvas} is not drawn`);
  const [cx, cy, scale] = view.split(' ').map(Number) as [number, number, number];
  return map.points.id.map((id, i) => ({
    id,
    x: box.x + ((map.points.x[i] ?? 0) - cx) * scale + box.width / 2,
    y: box.y + box.height / 2 - ((map.points.y[i] ?? 0) - cy) * scale,
  }));
}

/** Inside the plate's frame, and the plate itself is what is under that point (no title block or tool over it). */
async function onPlate(win: Page, canvas: string, x: number, y: number): Promise<boolean> {
  const box = await win.locator(canvas).boundingBox();
  if (!box) return false;
  if (x < box.x + FRAME || x > box.x + box.width - FRAME || y < box.y + FRAME || y > box.y + box.height - FRAME) return false;
  return win.evaluate(([px, py, selector]) => document.elementFromPoint(px as number, py as number)
    === document.querySelector(selector as string), [x, y, canvas] as const);
}

/**
 * A dot among *ids*' drawn apart from every other dot, with nothing over it;
 * zoomed in toward the middle of the map, a step at a time, until one is.
 * Papers with the same words are drawn on the same spot, so a dot can be
 * several papers: all of them are returned, and a click there opens one.
 * With *shared*, the spot may hold other papers too, and only *ids*' are
 * returned: a new paper wins its spot on Today's map.
 */
async function aloneOnPlate(win: Page, canvas: string, map: MapBody, ids: readonly number[], shared = false): Promise<Dot> {
  const wanted = new Set(ids);
  for (let zoom = 0; zoom < 5; zoom++) {
    await stillView(win, canvas);
    const all = await spots(win, canvas, map);
    for (const spot of all) {
      if (!wanted.has(spot.id)) continue;
      const apart = all.map((o) => ({ id: o.id, d: Math.hypot(o.x - spot.x, o.y - spot.y) }));
      const same = apart.filter((o) => o.d < SAME).map((o) => o.id);
      const nearest = Math.min(...apart.filter((o) => o.d >= SAME).map((o) => o.d));
      if ((shared || same.every((id) => wanted.has(id))) && nearest >= ALONE && await onPlate(win, canvas, spot.x, spot.y)) {
        return { ids: same.filter((id) => wanted.has(id)), x: spot.x, y: spot.y };
      }
    }
    await win.locator(canvas).locator('xpath=..').getByRole('button', { name: 'Zoom in' }).click();
  }
  throw new Error(`no paper of ${ids.length} is drawn apart from the rest on ${canvas}`);
}

/** The paper open beside the map, which must be one of *ids*. */
async function openedOneOf(win: Page, ids: readonly number[]): Promise<number> {
  const panel = win.locator('section[data-map-paper]');
  await expect(panel).toBeVisible();
  const id = Number(await panel.getAttribute('data-map-paper'));
  expect(ids).toContain(id);
  return id;
}

/** A point on the plate farther than `CLEAR` from every paper. */
async function emptyPoint(win: Page, canvas: string, map: MapBody): Promise<{ x: number; y: number }> {
  await stillView(win, canvas);
  const all = await spots(win, canvas, map);
  const box = await win.locator(canvas).boundingBox();
  if (!box) throw new Error(`${canvas} has no box`);
  for (let y = box.y + FRAME + 10; y < box.y + box.height - FRAME; y += 17) {
    for (let x = box.x + FRAME + 10; x < box.x + box.width - FRAME; x += 17) {
      if (all.every((s) => Math.hypot(s.x - x, s.y - y) > CLEAR) && await onPlate(win, canvas, x, y)) return { x, y };
    }
  }
  throw new Error(`no empty point on ${canvas}`);
}

/** A press and a release at one point, as a mouse makes them. */
async function click(win: Page, x: number, y: number): Promise<void> {
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.up();
}

test('a mouse click on a paper\'s dot opens it on Today\'s map, the collection\'s, and Watches\'', async () => {
  test.setTimeout(360_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-map-clicks-'));
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
  const shot = (win: Page, name: string) => win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-map-clicks-${name}.png`) });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await throttle(win);
    const problems: string[] = [];
    win.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    win.on('pageerror', (e) => problems.push(e.message));
    await resize(app, 1440, 900);

    // Today: the map as it opens, the opening's numbered rings all lit.
    const today = '.today .plate-canvas';
    await expect(win.locator(today)).toBeVisible({ timeout: 120_000 });
    const map = await engine<MapBody>(win, '/api/map');
    expect(map.state).toBe('ready');
    const listed = win.locator('.today .entry[data-paper]');
    await expect(listed).toHaveCount(4, { timeout: 30_000 });
    const fresh = (await listed.evaluateAll((entries) => entries.map((e) => Number(e.getAttribute('data-paper')))));
    const older = map.points.id.filter((id) => !fresh.includes(id));

    // A paper not in the list opens beside the map, in the list's place.
    const target = await aloneOnPlate(win, today, map, older);
    await click(win, target.x, target.y);
    const chosen = await openedOneOf(win, target.ids);
    const panel = win.locator(`section[data-map-paper="${chosen}"]`);
    await expect(win.locator(today)).toHaveAttribute('data-selected', String(chosen));
    await shot(win, 'today');
    // A click away from every paper closes it, and the list returns.
    const empty = await emptyPoint(win, today, map);
    await click(win, empty.x, empty.y);
    await expect(panel).toHaveCount(0);
    await expect(win.locator(today)).not.toHaveAttribute('data-selected', /.+/);
    await expect(win.locator('.today .entry[data-paper]').first()).toBeVisible();
    // A click just off its dot, inside the plate's reach, opens the same paper.
    const again = await aloneOnPlate(win, today, map, target.ids);
    await click(win, again.x + NEAR, again.y);
    expect(await openedOneOf(win, target.ids)).toBe(chosen);
    await panel.getByRole('button', { name: 'Back to the list' }).click();
    await expect(panel).toHaveCount(0);

    // A new paper's numbered ring chooses its entry in the list.
    const ring = await aloneOnPlate(win, today, map, fresh, true);
    await click(win, ring.x, ring.y);
    await expect(win.locator('.today .entry.sel[data-paper]')).toHaveCount(1);
    expect(ring.ids).toContain(Number(await win.locator('.today .entry.sel[data-paper]').getAttribute('data-paper')));
    await expect(win.locator('section[data-map-paper]')).toHaveCount(0);
    await win.locator(today).press('Escape');
    await expect(win.locator('.today .entry.sel[data-paper]')).toHaveCount(0);

    // A press the map never saw released: the pointer moving on with no button
    // held drags nothing, and the press ends as the click it was. Away from
    // every paper that chooses nothing; on a dot, it opens the paper there.
    const unreleased = async (x: number, y: number) => {
      await win.mouse.move(x, y);
      await win.locator(today).dispatchEvent('pointerdown', {
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y,
      });
      await win.mouse.move(x + 120, y + 90, { steps: 6 });
    };
    const after = await aloneOnPlate(win, today, map, older);
    const held = await win.locator(today).getAttribute('data-view');
    const nowhere = await emptyPoint(win, today, map);
    await unreleased(nowhere.x, nowhere.y);
    await expect(win.locator(today)).toHaveAttribute('data-view', held ?? '');
    await expect(win.locator(today)).not.toHaveAttribute('data-selected', /.+/);
    await unreleased(after.x, after.y);
    const afterId = await openedOneOf(win, after.ids);
    await expect(win.locator(today)).toHaveAttribute('data-view', held ?? '');
    await win.locator(`section[data-map-paper="${afterId}"]`).getByRole('button', { name: 'Back to the list' }).click();

    // Search › Your collection: a paper opens in the results' place.
    const sections = win.getByRole('navigation', { name: 'Sections' });
    const results = win.getByRole('region', { name: 'Your collection' });
    await sections.getByRole('link', { name: 'Search' }).click();
    const collection = '.collection .plate-canvas';
    await expect(win.locator(collection)).toBeVisible({ timeout: 60_000 });
    const inCollection = await aloneOnPlate(win, collection, map, map.points.id);
    await click(win, inCollection.x, inCollection.y);
    await openedOneOf(win, inCollection.ids);
    await expect(results).toBeHidden();
    await shot(win, 'collection');
    const collectionEmpty = await emptyPoint(win, collection, map);
    await click(win, collectionEmpty.x, collectionEmpty.y);
    await expect(win.locator('section[data-map-paper]')).toHaveCount(0);
    await expect(results).toBeVisible();

    // Watches: a paper opens in the list's place, whether the lit watch found it or not.
    const watchList = win.getByRole('region', { name: 'Watches' });
    await sections.getByRole('link', { name: 'Watches' }).click();
    const watches = '.watches .plate-canvas';
    await expect(win.locator(watches)).toBeVisible({ timeout: 60_000 });
    await expect(win.locator('.watches .sky figcaption')).toContainText('Protein structure');
    for (const [name, ids] of [['lit', seed.old_protein], ['dimmed', seed.quantum]] as const) {
      const dot = await aloneOnPlate(win, watches, map, ids);
      await click(win, dot.x, dot.y);
      const id = await openedOneOf(win, dot.ids);
      await expect(watchList).toBeHidden();
      await shot(win, `watches-${name}`);
      await win.locator(`section[data-map-paper="${id}"]`).getByRole('button', { name: 'Back to the watches' }).click();
      await expect(watchList).toBeVisible();
    }

    expect(problems, 'the page reported errors').toEqual([]);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
