/**
 * A source that answers HTTP 429, in the real app: "rate-limited", never "did
 * not answer", with "try again after about" the time it gave, wherever a run's
 * outcome is shown. The run's page (its source row, mark, and coverage line),
 * the Runs tab, the latest runs beside Search, the run monitor's panel, Today,
 * the Source Wall's cell and headline, the Watchdog, the finished-run
 * notification, and the run's report.
 *
 * arXiv is a loopback server here that answers every query with 429 and a
 * Retry-After of an hour, so the first search records the source's own time
 * and every later one is held back by resmon's shared wait for it. Every other
 * connection the engine tries, and port 8742, is refused by the startup hook,
 * and the spec fails if anything was.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';
import { showTheme } from './fixtures/theme';

async function engine<T>(win: Page, route: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  return win.evaluate(async ([r, m, b]) => {
    const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
    const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
      method: m as string,
      headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(b === undefined ? {} : { body: JSON.stringify(b) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* a report is text */ }
    return { status: response.status, body: parsed };
  }, [route, method, body] as const) as Promise<{ status: number; body: T }>;
}

/** "try again after about 3:40 PM", as the screens say it: a clock time, with a no-break space before AM or PM. */
const AGAIN = /try again after about \d{1,2}:\d{2}[\u00a0 ][AP]M/i;

test('a 429 is rate-limited, with when to try again, on every screen that shows an outcome', async () => {
  test.setTimeout(420_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-rate-limited-'));
  let asked = 0;
  const source = http.createServer((_req, res) => {
    asked += 1;
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '3600' });
    res.end('Rate exceeded.');
  });
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
            raise OSError('atlas-rate-limited test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
`);
  const env: Record<string, string> = { ...launchEnv(stateDir, true) };
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  // Under the suite, the main process writes each notice it would post as a line.
  const output: string[] = [];
  app.process().stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const notices = () => output.join('').split('\n').filter((line) => line.startsWith('[main] notice '))
    .map((line) => JSON.parse(line.slice('[main] notice '.length)) as { title?: string; body?: string });
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const problems: string[] = [];
    win.on('pageerror', (e) => problems.push(e.message));
    await win.getByRole('navigation', { name: 'Sections' }).waitFor({ timeout: 120_000 });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1440, 900); });
    await showTheme(app, win, 'dark');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const shoot = (name: string) => win.screenshot({ path: path.join(SCREENSHOT_DIR, `atlas-rate-limited-${name}.png`) });
    const settled = async (id: number) => {
      await expect.poll(async () => (await engine<{ status: string }>(win, `/api/executions/${id}`)).body.status,
        { timeout: 90_000 }).not.toMatch(/^(running|queued)$/);
    };

    // — Three arXiv searches: a Deep Dive, a watch's run, and another Deep Dive ------------------
    const first = await engine<{ execution_id: number }>(win, '/api/search/dive', 'POST', {
      repository: 'arxiv', query: 'agents', keywords: ['agents'], max_results: 5,
    });
    expect(first.status).toBe(200);
    await settled(first.body.execution_id);
    const watch = await engine<{ id: number }>(win, '/api/routines', 'POST', {
      name: 'Night agents', schedule_cron: '0 3 1 1 *', is_active: true, notify_on_complete: true,
      parameters: { repositories: ['arxiv'], keywords: ['agents'], query: 'agents', max_results: 5 },
    });
    expect(watch.status, JSON.stringify(watch.body)).toBeLessThan(300);
    const fired = await engine<{ execution_id: number | null }>(win, `/api/routines/${watch.body.id}/run`, 'POST');
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    await settled(fired.body.execution_id as number);
    const third = await engine<{ execution_id: number }>(win, '/api/search/dive', 'POST', {
      repository: 'arxiv', query: 'agents', keywords: ['agents'], max_results: 5,
    });
    await settled(third.body.execution_id);
    // The source was asked once: resmon held every later request back for the hour it was given.
    expect(asked).toBe(1);

    // — The run's page: its source row, its mark, and the coverage line ---------------------------
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, first.body.execution_id);
    const row = win.locator('.recorded-row[data-source="arxiv"]');
    await expect(row.locator('.src-label')).toHaveText('rate-limited', { timeout: 60_000 });
    await expect(row.locator('.src-note')).toContainText('arXiv rate-limited resmon: it answered HTTP 429 (too many requests)');
    await expect(row.locator('.src-note')).toContainText(/Try again after about \d{1,2}:\d{2}/);
    await expect(row.locator('.omark.limited svg[data-mark="pause"]')).toHaveCount(1);
    await expect(win.locator('.run-sources')).toContainText('1 recorded non-answer (1 rate-limited)');
    await expect(win.getByRole('link', { name: 'What a Source’s Answer Means' })).toHaveAttribute('href', /guide\/source-answers\/$/);
    await shoot('run');
    await showTheme(app, win, 'light');
    await shoot('run-light');
    await showTheme(app, win, 'dark');

    // — The report: a section of its own ----------------------------------------------------------
    const report = await engine<string>(win, `/api/executions/${first.body.execution_id}/report`);
    expect(JSON.stringify(report.body)).toContain('Sources that rate-limited resmon');

    // — The Runs tab, and the latest runs beside Search -------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/runs'; });
    await expect(win.locator(`[data-run="${first.body.execution_id}"]`).first()).toContainText(AGAIN, { timeout: 30_000 });
    await expect(win.locator(`[data-run="${first.body.execution_id}"]`).first()).toContainText('0 of 1 source answered, 1 rate-limited');
    await shoot('runs');
    await win.evaluate(() => { window.location.hash = '#/search/ask'; });
    await expect(win.locator('.latest-runs')).toContainText(AGAIN, { timeout: 30_000 });
    await shoot('search-latest');

    // — The run monitor's panel: today's runs ------------------------------------------------------
    const mark = win.locator('header.bar .mon');
    await mark.click();
    const panel = win.locator('#run-monitor-panel');
    await expect(panel.locator(`.active-row.is-today[data-run="${first.body.execution_id}"] .active-meta`))
      .toContainText(/Failed · 0 of 1 source answered, 1 rate-limited \(try again after about/, { timeout: 30_000 });
    await shoot('monitor');
    await win.keyboard.press('Escape');
    // Off the mark, so its tip does not sit over the screens below.
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.mouse.move(700, 700);

    // — Today: the watch's last run -----------------------------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/today'; });
    const trouble = win.locator('.trouble-line').first();
    await expect(trouble).toContainText(/arXiv was rate-limited; try again after about/, { timeout: 30_000 });
    await expect(trouble.locator('.trouble-mark.limited svg[data-mark="pause"]')).toHaveCount(1);
    await shoot('today');

    // — The Source Wall: the cell and the headline -------------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/health'; });
    await expect(win.locator('button[data-health="cell"][data-state="rate_limited"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(win.locator('button[data-health="cell"][data-state="rate_limited"] svg[data-mark="pause"]').first()).toBeVisible();
    await expect(win.locator('.page')).toContainText(/arXiv rate-limited resmon's last request\. Try again after about/);
    await expect(win.locator('[data-health="guide"]')).toHaveAttribute('href', /guide\/source-answers\/$/);
    await shoot('wall');
    await showTheme(app, win, 'light');
    await shoot('wall-light');
    await showTheme(app, win, 'dark');

    // — The Watchdog --------------------------------------------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/health/watchdog'; });
    await expect(win.locator('.page')).toContainText('arXiv rate-limited resmon on its last 3 runs', { timeout: 30_000 });
    await expect(win.locator('.page')).toContainText(/Run it again after about/);
    await shoot('watchdog');

    // — The finished-run notification for the watch ------------------------------------------------
    await expect.poll(() => notices().map((n) => `${n.title} | ${n.body}`).join('\n'), { timeout: 30_000 })
      .toMatch(/Night agents[^\n]*\| [^\n]*arXiv was rate-limited; try again after about/);
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'atlas-rate-limited-notices.json'), JSON.stringify(notices(), null, 2));

    // — Narrow: the run's page at the window's minimum ----------------------------------------------
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(960, 800); });
    await win.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, first.body.execution_id);
    await expect(row.locator('.src-label')).toHaveText('rate-limited', { timeout: 30_000 });
    await shoot('run-960');
    expect(problems).toEqual([]);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    expect(blocked).toBe('');
    removeStateDir(stateDir);
  }
});
