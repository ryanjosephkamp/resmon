/**
 * Every chart answers the pointer and the keyboard, in the real app: the one
 * tooltip, with the engine's numbers as it served them, set beside its mark
 * and never over it, inside the window; and a click on a mark goes to what it
 * counts. In both themes, on Analytics (a source's bar, a keyword's bar, a
 * source's range, a watch's tick, a month's column), the Source Wall, a
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
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';
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
  await panel.getByRole('button', { name: /^Show It on the Map/ }).click();
  await stillView(win, canvas);
  return (await engine<{ title: string }>(win, `/api/documents/${id}`)).title;
}

const DIMS = 8;

/** One loopback vector for a text, the same each time, of `DIMS` numbers. */
function vectorFor(text: string): number[] {
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
  const raw = Array.from({ length: DIMS }, (_, i) => digest[i % digest.length]! / 255 - 0.5);
  const norm = Math.sqrt(raw.reduce((a, v) => a + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

/** Ollama's `/api/embed` on loopback, answering after `delayMs`, so a backfill is seen running. */
async function startEmbedder(delayMs: number): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let input: string[] = [];
      try {
        const parsed = JSON.parse(body || '{}') as { input?: unknown };
        input = Array.isArray(parsed.input) ? parsed.input.map(String) : [String(parsed.input ?? '')].filter(Boolean);
      } catch { /* no vectors, which the client refuses */ }
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ embeddings: input.map(vectorFor) }));
      }, delayMs);
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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

    // A paper saved to read, so the Library shows its cover: its piece of the map.
    await engine(win, '/api/reading-queue', 'POST', { document_id: seed.old_protein[0] });

    for (const theme of ['light', 'dark'] as const) {
      await engine(win, '/api/appearance', 'PUT', { theme, accent: null });
      await win.reload();
      await expect(win.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 60_000 });

      // — the Library: a paper's cover, its piece of the map --------------------------------
      await go(win, '#/library');
      const cover = win.locator(`[data-cover="atlas"][data-placed="true"]`).first();
      await cover.hover({ timeout: 60_000 });
      await expect(tip.locator('.chart-tip-name')).toHaveText('On the collection map');
      await expect(tip.locator('.chart-tip-value')).toHaveText(/^[A-H][1-8](, .+)?$/);
      // The card opens the paper already: the tip offers no click of its own.
      await expect(tip.locator('.chart-tip-opens')).toHaveCount(0);
      await besideAndInside(win, tip, cover.locator('.cov-chart'));
      await shot(`library-cover-${theme}`);

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
      await expect(tip.locator('.chart-tip-opens')).toHaveText('Opens Search › Collection narrowed to arXiv');
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
      await expect(tip.locator('.chart-tip-opens')).toContainText('Opens Search › Collection narrowed to');
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

      // — the Source Wall -----------------------------------------------------------
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

      // — a finished run: each source's recorded outcome, and the run's Map tab ------------------
      await go(win, `#/runs/${seed.sweep}`);
      const outcome = win.locator('.recorded-row[data-source="arxiv"] .omark-at');
      await outcome.hover({ timeout: 60_000 });
      await expect(tip.locator('.chart-tip-name')).toHaveText('arXiv');
      await expect(tip.locator('.chart-tip-lines li')).toHaveText([/^\d[\d,]* records? returned$/]);
      // The run's own page: the mark opens nothing, and its tip offers nothing.
      await expect(tip.locator('.chart-tip-opens')).toHaveCount(0);
      await besideAndInside(win, tip, outcome);
      await shot(`run-outcome-${theme}`);
      await win.getByRole('tab', { name: 'Map' }).click();
      const runMap = win.locator(`[data-run-map="${seed.sweep}"]`);
      const runCanvas = `[data-run-map="${seed.sweep}"] .plate-canvas`;
      await expect.poll(() => win.locator(runCanvas).getAttribute('data-view'), { timeout: 60_000 }).not.toBeNull();
      const { title: inRun } = await uniqueTitle(win, seed.quantum.slice(4, 15));
      await findAndOpen(win, runMap, runCanvas, inRun);
      await runMap.locator('section[data-map-paper]').getByRole('button', { name: "Back to the run's map" }).click();
      const runBox = await win.locator(runCanvas).boundingBox();
      if (!runBox) throw new Error('the run map has no box');
      await win.mouse.move(runBox.x + runBox.width / 2, runBox.y + runBox.height / 2);
      await expect(tip.locator('.chart-tip-value')).toHaveText(inRun);
      await expect(tip.locator('.chart-tip-opens')).toHaveText('Opens it beside the map');
      await besideAndInside(win, tip, runMap.locator('.plate-tip-at'));
      await shot(`run-map-${theme}`);
      await win.mouse.move(runBox.x + 4, runBox.y + 4);
    }

    // — clicks and keys ---------------------------------------------------------------------
    await go(win, '#/health/analytics');
    const arxiv = served.source_contribution.sources.find((s) => s.source === 'arxiv');
    await win.locator('[data-analytics="sources"] .bar-row[data-source="arxiv"] .chart-bar').click({ timeout: 60_000 });
    await expect(win.getByRole('heading', { name: 'Main Collection', level: 1 })).toBeVisible({ timeout: 30_000 });
    expect(await win.evaluate(() => window.location.hash)).toBe('#/search?source=arxiv');
    await expect(win.locator('.count-sentence')).toHaveText(`${n(arxiv?.total ?? -1)} papers matching your filters`, { timeout: 30_000 });

    // A month from the keyboard: the columns are one stop, the newest month first; the arrow key moves, Enter opens.
    await go(win, '#/health/analytics');
    const series = served.publication_volume.series;
    const columns = win.getByRole('group', { name: 'Papers by Publication Month' });
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

    // Back returns the keyboard to the publication bar that opened these results.
    await win.goBack();
    await expect(columns.locator('[data-month="2024-03"]')).toBeFocused();
    await win.goForward();
    await expect(win).toHaveURL(/#\/search\?from=2024-03-01&to=2024-03-31$/);

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

    // The run's Map tab follows the keyboard too, and says the paper to a screen reader.
    await go(win, `#/runs/${seed.sweep}`);
    await win.getByRole('tab', { name: 'Map' }).click();
    const runCanvas = `[data-run-map="${seed.sweep}"] .plate-canvas`;
    await expect.poll(() => win.locator(runCanvas).getAttribute('data-view'), { timeout: 60_000 }).not.toBeNull();
    await win.mouse.move(4, 4);
    await chooseByKeyboard(win, runCanvas);
    const runKeyed = Number(await win.locator(runCanvas).getAttribute('data-selected'));
    const { title: runKeyedTitle } = await engine<{ title: string }>(win, `/api/documents/${runKeyed}`);
    await expect(tip.locator('.chart-tip-value')).toHaveText(runKeyedTitle, { timeout: 30_000 });
    await expect(win.locator(`[data-run-map="${seed.sweep}"] [data-map-said]`)).toContainText(runKeyedTitle);
    await shot('run-map-keyboard');
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

    // The embedding backfill's bar, while a slow loopback model embeds one paper at a time, in both themes.
    await resize(app, 1440, 900);
    const embedder = await startEmbedder(1_500);
    try {
      await engine(win, '/api/settings/embeddings', 'PUT', { settings: {
        embedding_enabled: 'true', embedding_provider: 'local', embedding_model: 'e2e-embed', embedding_endpoint: embedder.url,
        embedding_batch_size: '1', embedding_dims: String(DIMS),
      } });
      await engine(win, '/api/embeddings/backfill', 'POST');
      for (const theme of ['light', 'dark'] as const) {
        await engine(win, '/api/appearance', 'PUT', { theme, accent: null });
        await win.reload();
        await expect(win.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 60_000 });
        await go(win, '#/settings/ai?focus=embeddings');
        const meter = win.locator('[data-embeddings="backfill"] .meter-at');
        await meter.scrollIntoViewIfNeeded({ timeout: 60_000 });
        await meter.hover();
        await expect(tip.locator('.chart-tip-name')).toHaveText('Embedding with e2e-embed');
        await expect(tip.locator('.chart-tip-value')).toHaveText(/^\d+ of \d+ papers?$/);
        await besideAndInside(win, tip, meter.locator('.emb-meter'));
        await shot(`embedding-meter-${theme}`);
      }
      await engine(win, '/api/embeddings/backfill/cancel', 'POST');
      await expect.poll(async () => (await engine<{ run: { running: boolean } }>(win, '/api/embeddings/status')).run.running,
        { timeout: 30_000 }).toBe(false);
    } finally {
      await embedder.close();
    }

    // A second window draws its own tip over its own page, and the first draws none.
    const opening = app.waitForEvent('window');
    await win.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+n`);
    const second = await opening;
    second.on('pageerror', (e) => problems.push(`second: ${e.message}`));
    await second.locator('nav[aria-label="Sections"]').waitFor({ timeout: 60_000 });
    await second.evaluate(() => { window.location.hash = '#/health/analytics'; });
    const secondBar = second.locator('[data-analytics="sources"] .bar-row[data-source="arxiv"] .chart-bar');
    await secondBar.hover({ timeout: 60_000 });
    const secondTip = second.getByRole('tooltip');
    await expect(secondTip.locator('.chart-tip-name')).toHaveText('arXiv');
    await besideAndInside(second, secondTip, secondBar);
    await expect(tip).toHaveCount(0);
    await second.screenshot({ path: path.join(shots, 'second-window-analytics.png'), animations: 'disabled' });
    await second.close();

    expect(problems, 'the page reported errors').toEqual([]);
  } finally {
    await app.close();
    removeStateDir(stateDir);
  }
});

const FEED = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://arxiv.org/abs/2611.00002v1</id><title>Authored Atlas charts fixture</title>
  <author><name>Ada Fixture</name></author><published>${new Date().toISOString().slice(0, 10)}T00:00:00Z</published>
  <summary>Authored local fixture, not fetched scholarly content.</summary>
</entry></feed>`;

test('a running run\'s charts: the bar of sources finished, each source\'s mark, the Runs tab\'s marks, and the run monitor', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-charts-running-'));
  // arXiv is a loopback server that holds its answer until the spec lets it go; Springer Nature has no key and finishes at once.
  const held: http.ServerResponse[] = [];
  let holding = true;
  const source = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    if (holding) held.push(res);
    else res.end(FEED);
  });
  const release = () => {
    holding = false;
    for (const res of held.splice(0)) res.end(FEED);
  };
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourcePort = (source.address() as net.AddressInfo).port;
  expect(sourcePort).not.toBe(8742);
  const hookDir = path.join(stateDir, 'python-hook');
  fs.mkdirSync(hookDir);
  fs.writeFileSync(path.join(hookDir, 'sitecustomize.py'), `
import ipaddress, json, socket, sys
from pathlib import Path
state = Path(${JSON.stringify(stateDir)})
original_connect = socket.socket.connect
def connect(self, address):
    if isinstance(address, tuple):
        host, port = address[:2]
        try: local = ipaddress.ip_address(host).is_loopback
        except ValueError: local = host == 'localhost'
        if not local or port == 8742:
            with (state / 'blocked.jsonl').open('a') as stream:
                stream.write(json.dumps({'host': host, 'port': port}) + "\\n")
            raise OSError('atlas-charts test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv, config
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
config.DEFAULT_REQUEST_TIMEOUT = 240
`);
  const env: Record<string, string> = mapsEnv(launchEnv(stateDir, true));
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  const shots = path.join(SCREENSHOT_DIR, 'charts');
  fs.mkdirSync(shots, { recursive: true });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await resize(app, 1440, 900);
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });
    const tip = win.getByRole('tooltip');
    const shot = (name: string) => win.screenshot({ path: path.join(shots, `${name}.png`), animations: 'disabled' });

    await go(win, '#/search/ask');
    await expect(win.getByRole('heading', { name: 'Ask the Sources', level: 1 })).toBeVisible({ timeout: 60_000 });
    await win.getByRole('button', { name: 'Deep Sweep', exact: true }).click();
    await win.locator('.source[data-source="arxiv"] input').check();
    await win.locator('.source[data-source="springer"] input').check();
    const terms = win.getByLabel('Search terms');
    await terms.fill('slow light');
    await terms.press('Enter');
    await win.getByRole('button', { name: 'Any Time', exact: true }).click();
    const started = win.waitForResponse((r) => r.url().endsWith('/api/search/sweep') && r.request().method() === 'POST');
    await win.getByRole('button', { name: 'Ask 2 Sources' }).click();
    const { execution_id: runId } = await (await started).json() as { execution_id: number };
    await expect(win.locator(`.run[data-run="${runId}"]`)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
    await expect.poll(() => held.length, { timeout: 30_000 }).toBe(1);

    for (const theme of ['light', 'dark'] as const) {
      await engine(win, '/api/appearance', 'PUT', { theme, accent: null });
      await win.reload();
      await expect(win.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 60_000 });

      // The run's page: the bar of sources finished, and arXiv's mark while it is asked.
      await go(win, `#/runs/${runId}`);
      const run = win.locator(`.run[data-run="${runId}"]`);
      const bar = run.locator('.meter-at');
      await expect(run.getByRole('progressbar', { name: 'Sources finished' })).toHaveAttribute('aria-valuenow', '1', { timeout: 30_000 });
      await bar.hover();
      await expect(tip.locator('.chart-tip-value')).toHaveText('1 of 2 sources');
      await expect(tip.locator('.chart-tip-lines li')).toHaveText(['1 being asked: arXiv']);
      await expect(tip.locator('.chart-tip-opens')).toHaveCount(0);
      await besideAndInside(win, tip, bar.locator('.run-meter'));
      await shot(`run-progress-${theme}`);
      const live = run.locator('.run-sources .live-row[data-source="arxiv"] .live-mark');
      await live.hover();
      await expect(tip.locator('.chart-tip-name')).toHaveText('arXiv');
      await expect(tip.locator('.chart-tip-value')).toHaveText('asking');
      await expect(tip.locator('.chart-tip-opens')).toHaveCount(0);
      await besideAndInside(win, tip, live);
      await shot(`run-live-mark-${theme}`);

      // The Runs tab: each source's mark in the running run, which opens it.
      await go(win, '#/runs');
      const marks = win.locator(`.active-row[data-run="${runId}"] .src-marks`);
      const springer = marks.locator('li[data-source="springer"] a');
      await springer.hover({ timeout: 60_000 });
      await expect(tip.locator('.chart-tip-name')).toHaveText('Springer Nature');
      await expect(tip.locator('.chart-tip-opens')).toHaveText(`Opens run ${runId}`);
      await besideAndInside(win, tip, springer);
      await shot(`runs-tab-marks-${theme}`);
      const orbit = win.locator(`.active-row[data-run="${runId}"] .active-orbit`);
      await orbit.hover();
      await expect(tip.locator('.chart-tip-value')).toHaveText('1 of 2 sources finished');

      // The run monitor's mark: each running run's sources finished, and the panel it opens.
      const monitor = win.locator('header.bar .mon');
      await monitor.hover();
      await expect(tip.locator('.chart-tip-name')).toHaveText('Runs');
      await expect(tip.locator('.chart-tip-value')).toHaveText('1 running');
      await expect(tip.locator('.chart-tip-lines li')).toHaveText([/^1 of 2 slow light$/]);
      await expect(tip.locator('.chart-tip-opens')).toHaveText('Opens the Runs panel');
      await besideAndInside(win, tip, monitor);
      await shot(`run-monitor-${theme}`);
      await win.mouse.move(700, 600);
    }

    // The Runs tab's marks from the keyboard: one stop, the arrow keys between sources, Enter opens the run.
    await go(win, '#/runs');
    const first = win.locator(`.active-row[data-run="${runId}"] .src-marks a`).first();
    await expect(first).toHaveAttribute('tabindex', '0', { timeout: 30_000 });
    await win.locator(`.active-row[data-run="${runId}"] .active-title`).focus();
    await win.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await win.keyboard.press('ArrowRight');
    await expect(win.locator(`.active-row[data-run="${runId}"] .src-marks a`).nth(1)).toBeFocused();
    await expect(tip.locator('.chart-tip-opens')).toHaveText(`Opens run ${runId}`);
    await win.keyboard.press('Enter');
    await expect.poll(() => win.evaluate(() => window.location.hash)).toBe(`#/runs/${runId}`);

    release();
    await expect(win.locator(`.run[data-run="${runId}"]`)).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });
    expect(problems).toEqual([]);
  } finally {
    release();
    await app.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    expect(blocked).toBe('');
    removeStateDir(stateDir);
  }
});
