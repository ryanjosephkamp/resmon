/**
 * Atlas: a running run's page moves, in the real app. A Deep Sweep asks arXiv,
 * which is a loopback server here that answers the first request with a 503
 * and holds the second open until the spec lets it go, and Springer Nature,
 * which has no key in the suite's keyring and finishes at once as not asked.
 *
 * While arXiv is being asked, the page says the stage, a bar of the sources
 * that have finished, the run's clock, and arXiv's own line from the engine's
 * heartbeat: how long, the requests and the retry, and the wait before it
 * asks again. The spec samples the clock and arXiv's time for several seconds
 * and holds both to changing at least every two seconds. Every other
 * connection the engine tries, and port 8742, is refused by the startup hook,
 * and the spec fails if anything was.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const FEED = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://arxiv.org/abs/2611.00001v1</id><title>Authored Atlas live-run fixture</title>
  <author><name>Ada Fixture</name></author><published>${new Date().toISOString().slice(0, 10)}T00:00:00Z</published>
  <summary>Authored local fixture, not fetched scholarly content.</summary>
</entry></feed>`;

/** A window this many CSS pixels wide: the window itself where the display allows, zoomed out where it does not. */
async function widen(app: ElectronApplication, win: Page, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow, screen }, x) => {
    const area = screen.getPrimaryDisplay().workAreaSize;
    const w = BrowserWindow.getAllWindows()[0]!;
    const fits = x <= area.width;
    const zoom = fits ? 1 : area.width / x;
    w.setSize(fits ? x : area.width, Math.min(area.height, Math.round(900 * zoom)));
    w.webContents.setZoomFactor(zoom);
  }, width);
  await expect.poll(() => win.evaluate(() => window.innerWidth), { timeout: 10_000 }).toBeGreaterThanOrEqual(width - 2);
}

/** When each text a locator showed first appeared, sampled every 250 ms for `ms`. */
async function changes(win: Page, selector: string, ms: number): Promise<{ at: number; text: string }[]> {
  return win.evaluate(async ([sel, span]) => {
    const seen: { at: number; text: string }[] = [];
    const start = performance.now();
    while (performance.now() - start < span) {
      const text = document.querySelector(sel)?.textContent ?? '';
      if (!seen.length || seen[seen.length - 1]!.text !== text) seen.push({ at: performance.now() - start, text });
      await new Promise((r) => setTimeout(r, 250));
    }
    return seen;
  }, [selector, ms] as const);
}

function longestGap(seen: { at: number }[], span: number): number {
  const times = [...seen.map((s) => s.at), span];
  return Math.max(...times.slice(1).map((t, i) => t - times[i]!));
}

test('a running run: its stage, a bar of the sources finished, its clock, and each source from its heartbeat', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-run-live-'));
  const held: http.ServerResponse[] = [];
  let asked = 0;
  let holding = true;
  const source = http.createServer((_req, res) => {
    asked += 1;
    if (asked === 1) {
      // Busy: arXiv's own ladder waits at least five seconds before it asks again.
      res.writeHead(503, { 'Retry-After': '1' });
      res.end();
      return;
    }
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
            raise OSError('atlas-run-live test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv, config
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
# The held query is let go by the spec, never by a timeout.
config.DEFAULT_REQUEST_TIMEOUT = 240
`);
  const env: Record<string, string> = { ...launchEnv(stateDir, true) };
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    await expect(win.getByRole('heading', { name: 'Ask the sources', level: 1 })).toBeVisible({ timeout: 60_000 });
    await win.getByRole('button', { name: 'Deep Sweep', exact: true }).click();
    await win.locator('.source[data-source="arxiv"] input').check();
    await win.locator('.source[data-source="springer"] input').check();
    const terms = win.getByLabel('Search terms');
    await terms.fill('slow light');
    await terms.press('Enter');
    await win.getByRole('button', { name: 'Any time', exact: true }).click();
    const started = win.waitForResponse((r) => r.url().endsWith('/api/search/sweep') && r.request().method() === 'POST');
    // What runs now is read again as soon as the search starts, not at the run monitor's next idle read
    // (15 s): a run that ended sooner would never be seen to run.
    const activeReads: number[] = [];
    win.on('request', (r) => { if (r.url().endsWith('/api/executions/active')) activeReads.push(Date.now()); });
    await win.getByRole('button', { name: 'Ask 2 sources' }).click();
    const startedAt = Date.now();
    const { execution_id: runId } = await (await started).json() as { execution_id: number };
    await expect.poll(() => activeReads.some((t) => t >= startedAt), { timeout: 3_000 }).toBe(true);
    const run = win.locator(`.run[data-run="${runId}"]`);
    await expect(run).toHaveAttribute('data-status', 'running', { timeout: 30_000 });

    // — The stage, and a bar of the sources finished: Springer at once, arXiv still asked ---------
    await expect(run.locator('[data-run="stage"]')).toHaveText('Asking the sources');
    const bar = run.getByRole('progressbar', { name: 'Sources finished' });
    await expect(bar).toHaveAttribute('aria-valuemax', '2');
    await expect(bar).toHaveAttribute('aria-valuenow', '1', { timeout: 30_000 });
    await expect(run.locator('[data-run="finished"]')).toHaveText('1 of 2 sources finished');
    const arxiv = run.locator('.run-sources .live-row[data-source="arxiv"]');
    await expect(arxiv).toHaveAttribute('data-state', 'asking');
    await expect(arxiv.locator('.wall-mark')).toHaveAttribute('data-mark', 'asking');
    await expect(run.locator('.run-sources .live-row[data-source="springer"] .wall-mark')).toHaveAttribute('data-mark', 'dotted');

    // — arXiv's first answer was a 503: the line says the retry and the wait before it asks again --
    const detail = arxiv.locator('[data-live="detail"]');
    await expect(detail).toHaveText(/^1 request, 1 retry · waiting \d s before asking again$/, { timeout: 30_000 });
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-run-live-waiting.png') });
    // Then it asked again, and that request is still out.
    await expect(detail).toHaveText('2 requests, 1 retry', { timeout: 30_000 });
    await expect.poll(() => held.length, { timeout: 30_000 }).toBe(1);

    // — The clock and arXiv's time change at least every two seconds -------------------------
    // Two seconds by design: the clock ticks each second, and a source's time moves on for
    // one heartbeat interval past the last heartbeat, then waits for the next. The limit
    // allows half a second more for a busy machine scheduling the heartbeat or the tick late.
    const span = 8_000;
    const LATE = 2_500;
    const [clock, elapsed] = await Promise.all([
      changes(win, `.run[data-run="${runId}"] [data-run="clock"]`, span),
      changes(win, `.run[data-run="${runId}"] .live-row[data-source="arxiv"] [data-live="elapsed"]`, span),
    ]);
    expect(clock.length, `the clock read ${JSON.stringify(clock)}`).toBeGreaterThanOrEqual(6);
    expect(longestGap(clock, span), `the clock read ${JSON.stringify(clock)}`).toBeLessThanOrEqual(LATE);
    expect(elapsed.length, `arXiv's time read ${JSON.stringify(elapsed)}`).toBeGreaterThanOrEqual(4);
    expect(longestGap(elapsed, span), `arXiv's time read ${JSON.stringify(elapsed)}`).toBeLessThanOrEqual(LATE);
    expect(clock.every((s) => /^for (\d+ s|\d+ min \d\d s)$/.test(s.text)), JSON.stringify(clock)).toBe(true);

    // — At the window's sizes: 960, 1280, and 1920 pixels -------------------------------------
    for (const width of [960, 1280, 1920]) {
      await widen(app, win, width);
      await win.waitForTimeout(300);
      const wide = await win.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(wide, `the running run's page scrolls sideways at ${width}`).toBeLessThanOrEqual(0);
      await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-run-live-${width}.png`) });
    }
    await widen(app, win, 1440);

    // — Let it go: the page settles into the run's record ------------------------------------
    release();
    await expect(run).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });
    await expect(run.locator('[data-run="progress"]')).toHaveCount(0);
    await expect(run.locator('[data-run="clock"]')).toHaveCount(0);
    await expect(run.locator('.recorded-row[data-source="arxiv"]')).toHaveAttribute('data-category', 'answered');
    expect(problems).toEqual([]);
  } finally {
    release();
    await app.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    expect(blocked).toBe('');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
