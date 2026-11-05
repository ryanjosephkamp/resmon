/**
 * Atlas: the run monitor in the top bar, in the real app. Its states: idle
 * (the ring and core, still), running (an orbit, and "1 running"), just
 * finished (one ring that spreads), and failed (the struck mark in red, until
 * the panel is opened). Its panel, by the keyboard and the pointer: Enter
 * opens it with the focus inside, Escape and a click elsewhere close it, and
 * the focus comes back to the mark. Its one read: the Runs tab and the
 * monitor share the active runs' poll. Hiding it in Settings › Appearance,
 * kept by the engine across a reload. With reduced motion, nothing turns or
 * pulses. And at 960, 1280, and 1920 pixels, in the night theme and in light,
 * with its panel open over a running run.
 *
 * arXiv is a loopback server here: it holds a query for "slow" until the spec
 * lets it go, answers "broken" with HTTP 400, and answers anything else with
 * one authored paper. Every other connection the engine tries, and port
 * 8742, is refused by the startup hook, and the spec fails if anything was.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';
import { showTheme } from './fixtures/theme';

const feed = (term: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://arxiv.org/abs/2611.9${term.length}${term.charCodeAt(0)}v1</id><title>Authored monitor fixture on ${term}</title>
  <author><name>Ada Fixture</name></author><published>${new Date().toISOString().slice(0, 10)}T00:00:00Z</published>
  <summary>Authored local fixture, not fetched scholarly content.</summary>
</entry></feed>`;

async function engine<T>(win: Page, route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  return win.evaluate(async ([r, m, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m as string,
      headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, [route, method, body] as const) as Promise<{ status: number; body: T }>;
}

async function widen(app: ElectronApplication, win: Page, width: number, theme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ BrowserWindow, screen }, x) => {
    const area = screen.getPrimaryDisplay().workAreaSize;
    const w = BrowserWindow.getAllWindows()[0]!;
    const fits = x.width <= area.width;
    const zoom = fits ? 1 : area.width / x.width;
    w.setSize(fits ? x.width : area.width, Math.min(area.height, Math.round(900 * zoom)));
    w.webContents.setZoomFactor(zoom);
  }, { width });
  await expect.poll(() => win.evaluate(() => window.innerWidth), { timeout: 10_000 }).toBeGreaterThanOrEqual(width - 2);
  await showTheme(app, win, theme);
}

const isOpen = (win: Page) => win.evaluate(() => document.getElementById('run-monitor-panel')?.matches(':popover-open') ?? false);

test('the run monitor: idle, running, finished, failed, its panel by keyboard and pointer, and hidden in Settings', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-run-monitor-'));
  const held: http.ServerResponse[] = [];
  let holding = true;
  const source = http.createServer((req, res) => {
    const query = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('search_query') ?? '');
    const term = /all:(\w+)/.exec(query)?.[1] ?? 'nothing';
    if (term === 'broken') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('refused');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    if (term === 'slow' && holding) held.push(res);
    else res.end(feed(term));
  });
  const release = () => {
    holding = false;
    for (const res of held.splice(0)) res.end(feed('slow'));
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
            raise OSError('atlas-run-monitor test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv, config
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
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
    const polls: number[] = [];
    win.on('request', (r) => { if (r.url().endsWith('/api/executions/active')) polls.push(Date.now()); });
    const mark = win.locator('header.bar .mon');
    const panel = win.locator('#run-monitor-panel');

    // — Idle: the ring and the core, still, between the sections and New search ---------------
    await expect(mark).toHaveAttribute('data-monitor', 'idle', { timeout: 30_000 });
    await expect(mark).toHaveAccessibleName('Runs: nothing running');
    await expect(mark.locator('.rm-ring')).toHaveCount(1);
    await expect(mark.locator('.mon-words')).toHaveCount(0);
    const order = await win.locator('header.bar').evaluate((bar) => [...bar.querySelectorAll('.tabs, .mon, .newsearch')]
      .map((node) => node.className.split(' ')[0]));
    expect(order).toEqual(['tabs', 'mon', 'newsearch']);

    // — Running: an orbit for the run, turning, and "1 running" ------------------------------
    const slow = await engine<{ execution_id: number }>(win, '/api/search/dive', 'POST', {
      repository: 'arxiv', query: 'slow', keywords: ['slow'], max_results: 5,
    });
    expect(slow.status).toBe(200);
    await expect(mark).toHaveAttribute('data-monitor', 'running', { timeout: 30_000 });
    await expect(mark).toHaveAccessibleName('Runs: 1 running');
    await expect(mark.locator('.mon-full')).toHaveText('1 running');
    await expect(mark.locator('.rm-arc')).toHaveCount(1);
    await expect(mark.locator('.rm-spin.stalled')).toHaveCount(0);

    // One read of the active runs, shared by the monitor and the Runs tab: every two seconds, not twice that.
    await win.evaluate(() => { window.location.hash = '#/runs'; });
    await expect(win.locator('[data-runs="running"] .active-row')).toHaveCount(1, { timeout: 30_000 });
    const from = Date.now();
    await win.waitForTimeout(8_000);
    const seen = polls.filter((t) => t >= from).length;
    expect(seen, `the active runs were read ${seen} times in 8 s`).toBeLessThanOrEqual(5);
    expect(seen).toBeGreaterThanOrEqual(3);

    // — The panel, by the keyboard: in, out with Escape, and the focus back on the mark --------
    await mark.focus();
    await win.keyboard.press('Enter');
    await expect.poll(() => isOpen(win)).toBe(true);
    await expect(mark).toHaveAttribute('aria-expanded', 'true');
    expect(await win.evaluate(() => document.getElementById('run-monitor-panel')?.contains(document.activeElement))).toBe(true);
    const row = panel.locator(`[data-runs="running"] .active-row[data-run="${slow.body.execution_id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Stop slow' })).toBeVisible();
    const elapsed = await row.locator('[data-runs="elapsed"]').innerText();
    await expect(row.locator('[data-runs="elapsed"]')).not.toHaveText(elapsed, { timeout: 3_000 });
    await expect(panel.locator('[data-monitor="summary"]')).toHaveText('1 running · 0 today');
    await win.keyboard.press('Escape');
    await expect.poll(() => isOpen(win)).toBe(false);
    await expect(mark).toBeFocused();

    // — At the window's sizes, in the night theme and in light, open over the running run ------
    for (const [width, theme] of [[960, 'dark'], [960, 'light'], [1280, 'dark'], [1280, 'light'], [1920, 'dark'], [1920, 'light']] as const) {
      await widen(app, win, width, theme);
      await mark.click();
      await expect.poll(() => isOpen(win)).toBe(true);
      await win.waitForTimeout(300);
      // The panel inside the window, and the bar's controls side by side.
      const box = (await panel.boundingBox())!;
      const inner = await win.evaluate(() => window.innerWidth);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(inner);
      const boxes = await win.locator('header.bar').evaluate((bar) => [...bar.querySelectorAll('.lockup, .tabs li, .mon, .newsearch, .cmdk, .iconbtn')]
        .map((node) => node.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
      for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.left).toBeGreaterThanOrEqual(boxes[i - 1]!.right);
      expect(boxes[boxes.length - 1]!.right).toBeLessThanOrEqual(inner);
      // Below 1,200 pixels the count alone; at it and above, the words.
      expect(await mark.locator('.mon-full').isVisible()).toBe(inner >= 1200);
      expect(await mark.locator('.mon-count').isVisible()).toBe(inner < 1200);
      await win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-run-monitor-${width}-${theme}.png`) });
      // A click elsewhere closes it.
      await win.getByRole('heading', { name: 'Runs', level: 1 }).click();
      await expect.poll(() => isOpen(win)).toBe(false);
    }
    // Between the sizes shot, where the command search still has its words, the bar holds the count too.
    for (const width of [1000, 1024, 1100, 1199, 1200, 1240, 1279, 1360]) {
      await widen(app, win, width, 'dark');
      const inner = await win.evaluate(() => window.innerWidth);
      const boxes = await win.locator('header.bar').evaluate((bar) => [...bar.querySelectorAll('.lockup, .tabs li, .mon, .newsearch, .cmdk, .iconbtn')]
        .map((node) => node.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })));
      for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.left, `the bar overlaps at ${inner}`).toBeGreaterThanOrEqual(boxes[i - 1]!.right);
      expect(boxes[boxes.length - 1]!.right, `the bar spills at ${inner}`).toBeLessThanOrEqual(inner);
      expect(await win.evaluate(() => document.documentElement.scrollWidth), `the page scrolls sideways at ${inner}`).toBeLessThanOrEqual(inner);
    }
    await widen(app, win, 1440, 'dark');

    // — Just finished: one ring spreads, and the mark is idle again ----------------------------
    release();
    await expect(mark).toHaveAttribute('data-pulse', '1', { timeout: 60_000 });
    await expect(mark).toHaveAttribute('data-monitor', 'idle');
    await expect(mark.locator('.rm-pulse')).toHaveCount(1);
    await expect(mark.locator('.mon-words')).toHaveCount(0);

    // — Failed: the struck mark in red, until the panel is opened ------------------------------
    const broken = await engine<{ execution_id: number }>(win, '/api/search/dive', 'POST', {
      repository: 'arxiv', query: 'broken', keywords: ['broken'], max_results: 5,
    });
    await expect.poll(async () => (await engine<{ status: string }>(win, `/api/executions/${broken.body.execution_id}`)).body.status,
      { timeout: 60_000 }).toBe('failed');
    await expect(mark).toHaveAttribute('data-monitor', 'failed', { timeout: 30_000 });
    await expect(mark).toHaveAccessibleName('Runs: 1 failed');
    await expect(mark.locator('.rm-fault')).toHaveCount(2);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-run-monitor-failed.png') });
    // A run that started and ended between two reads of the active runs still reaches the history.
    await expect(win.locator('[data-runs="history"] [data-runs="count"]')).toHaveText('2 runs', { timeout: 30_000 });
    const opened = win.waitForResponse((r) => r.url().endsWith('/api/executions/seen') && r.request().method() === 'POST');
    await mark.click();
    expect((await opened).ok()).toBe(true);
    await expect(mark).toHaveAttribute('data-monitor', 'idle');
    const failedRow = panel.locator(`.active-row.is-today[data-run="${broken.body.execution_id}"]`);
    await expect(failedRow).toHaveAttribute('data-outcome', 'fail', { timeout: 30_000 });
    await expect(failedRow.locator('.active-meta')).toHaveText('Deep Dive · Failed · 0 of 1 source answered · Why');
    await expect(panel.locator(`.active-row.is-today[data-run="${slow.body.execution_id}"]`)).toHaveAttribute('data-outcome', 'ok');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-run-monitor-today.png') });
    await failedRow.getByRole('link', { name: 'Why' }).click();
    await expect.poll(() => win.evaluate(() => window.location.hash)).toBe(`#/runs/${broken.body.execution_id}`);
    expect(await isOpen(win)).toBe(false);
    // Seen: closed again, the red does not come back.
    await win.waitForTimeout(2_500);
    await expect(mark).toHaveAttribute('data-monitor', 'idle');
    expect((await engine<{ failed_unseen: number[] }>(win, '/api/executions/active')).body.failed_unseen).toEqual([]);

    // — Hidden in Settings › Appearance, kept by the engine across a reload ---------------------
    await win.evaluate(() => { window.location.hash = '#/settings'; });
    const toggle = win.getByRole('switch', { name: 'Show the run monitor in the top bar' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(mark).toHaveCount(0);
    await expect.poll(async () => (await engine<{ run_monitor: boolean }>(win, '/api/appearance')).body.run_monitor).toBe(false);
    await win.reload();
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 60_000 });
    await expect(win.getByRole('switch', { name: 'Show the run monitor in the top bar' })).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
    await expect(mark).toHaveCount(0);
    await win.getByRole('switch', { name: 'Show the run monitor in the top bar' }).click();
    await expect(mark).toHaveCount(1);
    await expect.poll(async () => (await engine<{ run_monitor: boolean }>(win, '/api/appearance')).body.run_monitor).toBe(true);

    // — With reduced motion, nothing turns or pulses ------------------------------------------
    await win.emulateMedia({ reducedMotion: 'reduce' });
    holding = true;
    await engine(win, '/api/search/dive', 'POST', { repository: 'arxiv', query: 'slow', keywords: ['slow'], max_results: 5 });
    await expect(mark).toHaveAttribute('data-monitor', 'running', { timeout: 30_000 });
    expect(await mark.locator('.rm-spin').evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
    release();
    await expect(mark).toHaveAttribute('data-pulse', '1', { timeout: 60_000 });
    expect(await mark.locator('.rm-pulse').evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
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
