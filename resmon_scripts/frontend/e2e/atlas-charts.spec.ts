/**
 * Every chart answers the pointer and the keyboard, in the real app: the one
 * tooltip, with the engine's numbers as it served them, set beside its mark
 * and never over it, inside the window; and a click on a mark goes to what it
 * counts. In both themes, on Analytics (a source's bar, a keyword's bar, a
 * source's range, a watch's tick, a month's column), the Source wall, a
 * watch's runs, the calendar, and the maps (Today's and the collection's),
 * with a screenshot of each tip under `screenshots/charts/`.
 *
 * Then the clicks and the keys: a source's bar opens the collection narrowed
 * to it; a month reached with the arrow keys and opened with Enter opens the
 * papers published that month, as many as its column counts; a watch's tick
 * opens its run; and on the collection's map a paper under the pointer is
 * named and opens beside the map, and one chosen from the keyboard is named
 * in the same tip. Last, at the window's narrowest, a tip at its right edge
 * stays inside it. No network.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import { FRONTEND_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';
import {
  SEED, chooseByKeyboard, engine, findAndOpen, mapsEnv, resize, stillView, throttle, uniqueTitle, type Seeded,
} from './fixtures/maps';

interface Overview {
  source_contribution: { sources: { source: string; total: number; unique_papers: number; duplicated: number }[] };
  routine_health: { routines: { routine_id: number; series: { execution_id: number; new_results: number; total_results: number }[] }[] };
  publication_volume: { series: { month: string; total: number }[] };
}

const n = (value: number) => new Intl.NumberFormat('en-US').format(value);
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthLong = (month: string) => MONTH.format(new Date(`${month}-01T00:00:00Z`));

/** The tip is beside its mark, never over it, and inside the window. */
async function besideAndInside(win: Page, tip: Locator, mark: Locator): Promise<void> {
  await expect(tip).toBeVisible();
  const [t, m] = [await tip.boundingBox(), await mark.boundingBox()];
  const view = win.viewportSize() ?? await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (!t || !m) throw new Error('the tip or its mark has no box');
  const apart = t.x >= m.x + m.width || m.x >= t.x + t.width || t.y >= m.y + m.height || m.y >= t.y + t.height;
  expect(apart, `the tip ${JSON.stringify(t)} covers its mark ${JSON.stringify(m)}`).toBe(true);
  expect(t.x).toBeGreaterThanOrEqual(0);
  expect(t.y).toBeGreaterThanOrEqual(0);
  expect(t.x + t.width).toBeLessThanOrEqual(view.width);
  expect(t.y + t.height).toBeLessThanOrEqual(view.height);
}

/**
 * Put a paper at the middle of a map, open beside it, and say its title: on
 * Today by its title in the map's find, and on the collection's map, which has
 * no find, chosen from the keyboard and then shown on the map.
 */
async function flownTo(win: Page, where: 'today' | 'collection', scope: string, canvas: string, seed: Seeded): Promise<string> {
  if (where === 'today') {
    const { title } = await uniqueTitle(win, seed.old_protein);
    await findAndOpen(win, win.locator(scope), canvas, title);
    return title;
  }
  await chooseByKeyboard(win, canvas);
  const panel = win.locator('section[data-map-paper]');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const id = Number(await panel.getAttribute('data-map-paper'));
  await panel.getByRole('button', { name: /^Show it on the map/ }).click();
  await stillView(win, canvas);
  return (await engine<{ title: string }>(win, `/api/documents/${id}`)).title;
}

async function go(win: Page, hash: string): Promise<void> {
  await win.evaluate((h) => { window.location.hash = h; }, hash);
}

test('every chart has the one tip with the engine\'s numbers, and a click or Enter goes to what its mark counts', async () => {
  test.setTimeout(480_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-charts-'));
  const env = mapsEnv(launchEnv(stateDir, true));
  const seeded = spawnSync(env.RESMON_PYTHON ?? 'python3', ['-c', SEED, path.join(FRONTEND_ROOT, '..')], { env, encoding: 'utf8' });
  expect(seeded.status, seeded.stderr).toBe(0);
  const seed = JSON.parse(seeded.stdout.trim().split('\n').pop() ?? '{}') as Seeded;

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  const shots = path.join(SCREENSHOT_DIR, 'charts');
  fs.mkdirSync(shots, { recursive: true });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    await throttle(win);
    const problems: string[] = [];
    win.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    win.on('pageerror', (e) => problems.push(e.message));
    await resize(app, 1440, 900);
    await expect(win.locator('.today .plate-canvas')).toBeVisible({ timeout: 120_000 });
    const tip = win.getByRole('tooltip');
    const served = await engine<Overview>(win, '/api/analytics/overview');
    const shot = (name: string) => win.screenshot({ path: path.join(shots, `${name}.png`), animations: 'disabled' });

    for (const theme of ['light', 'dark'] as const) {
      await engine(win, '/api/appearance', 'PUT', { theme, accent: null });
      await win.reload();
      await expect(win.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 60_000 });

      // — Analytics -----------------------------------------------------------------
      await go(win, '#/health/analytics');
      const sources = win.locator('[data-analytics="sources"]');
      const arxiv = served.source_contribution.sources.find((s) => s.source === 'arxiv');
      if (!arxiv) throw new Error('the seed has no arXiv papers');
      const bar = sources.locator('.bar-row[data-source="arxiv"] .chart-bar');
      await bar.hover({ timeout: 60_000 });
      await expect(tip.locator('.chart-tip-name')).toHaveText('arXiv');
      await expect(tip.locator('.chart-tip-value')).toHaveText(`${n(arxiv.total)} papers`);
      await expect(tip.locator('.chart-tip-lines li')).toHaveText([
        `${n(arxiv.unique_papers)} only from this source`, `${n(arxiv.duplicated)} also from another source`,
      ]);
      await expect(tip.locator('.chart-tip-opens')).toHaveText('Opens Search › Your collection narrowed to arXiv');
      await besideAndInside(win, tip, bar);
      await shot(`analytics-sources-${theme}`);

      const keywords = win.locator('[data-analytics="keywords"]');
      await keywords.locator('[data-analytics="measure"]').click();
      const keyword = keywords.locator('[data-analytics="keyword-rows"] li .chart-bar').first();
      await expect(keyword).toBeVisible({ timeout: 60_000 });
      await keyword.hover();
      await expect(tip.locator('.chart-tip-value')).toContainText('matched');
      await besideAndInside(win, tip, keyword);
      await shot(`analytics-keywords-${theme}`);

      const range = win.locator('[data-analytics="lag"] .bar-row .range, [data-analytics="lag"] .bar-row .range-none').first();
      await range.hover();
      await expect(tip.locator('.chart-tip-opens')).toContainText('Opens Search › Your collection narrowed to');
      await besideAndInside(win, tip, range);
      await shot(`analytics-lag-${theme}`);

      const watch = served.routine_health.routines.find((r) => r.routine_id === seed.protein_watch);
      const run = watch?.series[watch.series.length - 1];
      if (!run) throw new Error('the protein watch has no completed run');
      const tick = win.locator(`.watch-health li[data-routine="${seed.protein_watch}"] .run-tick[data-run="${run.execution_id}"]`);
      await tick.hover();
      await expect(tip.locator('.chart-tip-value')).toHaveText(`${n(run.new_results)} new ${run.new_results === 1 ? 'paper' : 'papers'}`);
      await expect(tip.locator('.chart-tip-opens')).toHaveText(`Opens run ${run.execution_id}`);
      await besideAndInside(win, tip, tick);
      await shot(`analytics-watch-health-${theme}`);

      const month = served.publication_volume.series[served.publication_volume.series.length - 1];
      if (!month) throw new Error('the seed has no dated papers');
      const column = win.locator(`[data-analytics="volume"] .column[data-month="${month.month}"]`);
      await column.hover();
      await expect(tip.locator('.chart-tip-name')).toHaveText(monthLong(month.month));
      await expect(tip.locator('.chart-tip-value')).toHaveText(`${n(month.total)} ${month.total === 1 ? 'paper' : 'papers'}`);
      await besideAndInside(win, tip, column.locator('.column-bar'));
      await besideAndInside(win, tip, column.locator('.column-figure'));
      await shot(`analytics-volume-${theme}`);

      // — the Source wall -----------------------------------------------------------
      await go(win, '#/health');
      const cell = win.locator('tr[data-source="arxiv"] button[data-health="cell"]').last();
      await cell.hover({ timeout: 60_000 });
      await expect(tip.locator('.chart-tip-name')).toContainText('arXiv ·');
      await expect(tip.locator('.chart-tip-opens')).toHaveText('Opens its reading below the wall');
      await besideAndInside(win, tip, cell);
      await shot(`source-wall-${theme}`);

      // — a watch's runs --------------------------------------------------------------
      await go(win, `#/watches/${seed.protein_watch}`);
      const night = win.locator('.night-strip .night-bar').last();
      await night.hover({ timeout: 60_000 });
      await expect(tip.locator('.chart-tip-opens')).toHaveText(/^Opens run \d+$/);
      await besideAndInside(win, tip, night);
      await shot(`watch-runs-${theme}`);

      // — the calendar -------------------------------------------------------------------
      await go(win, '#/watches/calendar');
      const fire = win.locator('.ahead-grid .fire-mark').first();
      await fire.hover({ timeout: 60_000 });
      await expect(tip.locator('.chart-tip-opens')).toHaveText('Opens the watch');
      await besideAndInside(win, tip, fire);
      await shot(`calendar-${theme}`);

      // — the maps: a paper flown to, then pointed at ---------------------------------------
      for (const [where, hash, canvas, scope] of [
        ['today', '#/today', '.today .plate-canvas', '.today-plate'],
        ['collection', '#/search', '.collection .plate-canvas', '.collection'],
      ] as const) {
        await go(win, hash);
        await expect(win.locator(canvas)).toBeVisible({ timeout: 60_000 });
        await stillView(win, canvas);
        const title = await flownTo(win, where, scope, canvas, seed);
        const box = await win.locator(canvas).boundingBox();
        if (!box) throw new Error(`${canvas} has no box`);
        await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await expect(tip.locator('.chart-tip-value')).toHaveText(title);
        const at = win.locator(`${scope} .plate-tip-at`);
        await besideAndInside(win, tip, at);
        await shot(`map-${where}-${theme}`);
        await win.mouse.move(box.x + 4, box.y + 4);
        await win.locator('section[data-map-paper]').getByRole('button', { name: /^Back to the/ }).click();
      }
    }

    // — clicks and keys ---------------------------------------------------------------------
    await go(win, '#/health/analytics');
    const arxiv = served.source_contribution.sources.find((s) => s.source === 'arxiv');
    await win.locator('[data-analytics="sources"] .bar-row[data-source="arxiv"] .chart-bar').click({ timeout: 60_000 });
    await expect(win.getByRole('heading', { name: 'Your collection', level: 1 })).toBeVisible({ timeout: 30_000 });
    expect(await win.evaluate(() => window.location.hash)).toBe('#/search?source=arxiv');
    await expect(win.locator('.count-sentence')).toHaveText(`${n(arxiv?.total ?? -1)} papers matching your filters`, { timeout: 30_000 });

    // A month from the keyboard: the columns are one stop, the newest month first; the arrow key moves, Enter opens.
    await go(win, '#/health/analytics');
    const series = served.publication_volume.series;
    const columns = win.getByRole('group', { name: 'Papers by publication month' });
    const newest = columns.getByRole('link').last();
    await expect(newest).toHaveAttribute('tabindex', '0', { timeout: 60_000 });
    // From the control before the chart, Tab reaches the chart once, at its newest month.
    await win.mouse.move(4, 4);
    await win.locator('[data-analytics="volume"]').getByRole('button', { name: 'Category' }).focus();
    await win.keyboard.press('Tab');
    await expect(newest).toBeFocused();
    await expect(tip.locator('.chart-tip-name')).toHaveText(monthLong(series[series.length - 1]?.month ?? ''));
    // March 2024's papers carry whole dates, as every run stores them; the arrow keys step back to it.
    const target = series.findIndex((m) => m.month === '2024-03');
    expect(target).toBeGreaterThanOrEqual(0);
    for (let i = series.length - 1; i > target; i--) await win.keyboard.press('ArrowLeft');
    await expect(tip.locator('.chart-tip-name')).toHaveText('March 2024');
    await win.keyboard.press('Enter');
    expect(await win.evaluate(() => window.location.hash)).toBe('#/search?from=2024-03-01&to=2024-03-31');
    const march = series[target]?.total ?? -1;
    await expect(win.locator('.count-sentence')).toHaveText(`${n(march)} papers matching your filters`, { timeout: 30_000 });

    // A watch's tick opens its run.
    await go(win, '#/health/analytics');
    const watch = served.routine_health.routines.find((r) => r.routine_id === seed.protein_watch);
    const run = watch?.series[0];
    await win.locator(`.run-tick[data-run="${run?.execution_id}"]`).click({ timeout: 60_000 });
    expect(await win.evaluate(() => window.location.hash)).toBe(`#/runs/${run?.execution_id}`);

    // The collection's map: a paper under the pointer opens beside the map; one chosen from the keyboard is named in the tip.
    await go(win, '#/search');
    const canvas = '.collection .plate-canvas';
    await expect(win.locator(canvas)).toBeVisible({ timeout: 60_000 });
    const title = await flownTo(win, 'collection', '.collection', canvas, seed);
    const opened = Number(await win.locator('section[data-map-paper]').getAttribute('data-map-paper'));
    await win.locator(`section[data-map-paper="${opened}"]`).getByRole('button', { name: 'Back to the results' }).click();
    const box = await win.locator(canvas).boundingBox();
    if (!box) throw new Error('the map has no box');
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(tip.locator('.chart-tip-value')).toHaveText(title);
    await expect(tip.locator('.chart-tip-opens')).toHaveText('Opens it beside the map');
    await win.mouse.down();
    await win.mouse.up();
    await expect(win.locator(`section[data-map-paper="${opened}"]`)).toBeVisible();
    await win.locator(`section[data-map-paper="${opened}"]`).getByRole('button', { name: 'Back to the results' }).click();
    await win.mouse.move(box.x + box.width + 40, box.y + 10);
    await expect(tip).toHaveCount(0);
    await chooseByKeyboard(win, canvas);
    const keyed = Number(await win.locator(canvas).getAttribute('data-selected'));
    const { title: keyedTitle } = await engine<{ title: string }>(win, `/api/documents/${keyed}`);
    await expect(tip.locator('.chart-tip-value')).toHaveText(keyedTitle, { timeout: 30_000 });
    await expect(win.locator('.collection [data-map-said]')).toContainText(keyedTitle);
    await shot('map-keyboard');
    await win.keyboard.press('Escape');

    // At the window's narrowest, a tip at the right edge is slid inside the window, still clear of its mark.
    await resize(app, 960, 700);
    await go(win, '#/health/analytics');
    const last = win.locator('[data-analytics="volume"] .column').last();
    await last.scrollIntoViewIfNeeded({ timeout: 60_000 });
    await last.hover();
    await besideAndInside(win, tip, last.locator('.column-bar'));
    await besideAndInside(win, tip, last.locator('.column-figure'));
    await shot('narrow-volume');
    await go(win, '#/health');
    const edge = win.locator('tr[data-source="arxiv"] button[data-health="cell"]').last();
    await edge.hover({ timeout: 60_000 });
    await besideAndInside(win, tip, edge);
    await shot('narrow-source-wall');

    expect(problems, 'the page reported errors').toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
