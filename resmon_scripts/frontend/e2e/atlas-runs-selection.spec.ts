/**
 * Atlas: the Runs tab's selection, in the real app. Select all ticks every
 * run listed; Save as searches keeps each search's own sources, terms,
 * dates, and cap as a saved search linked back to its run, and says why a
 * watch's run is not saved; Run again asks first, saying what it starts and
 * how many wait, and then repeats each run with its own search, the first at
 * once and the rest in the queue, each linked back to the run it repeats.
 *
 * arXiv is a loopback server here, answering each query with one authored
 * paper, and holding every query while the spec says so, so the runs Run
 * again starts are seen running and waiting. Every other connection the
 * engine tries, and port 8742, is refused by the startup hook, and the spec
 * fails if anything was.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const feed = (term: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://arxiv.org/abs/2611.${term.length}${term.charCodeAt(0)}v1</id><title>Authored selection fixture on ${term}</title>
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

interface RunRead { id: number; status: string; restarted_from: number | null; saved_configuration_id: number | null; execution_type: string }
interface Saved { id: number; name: string; config_type: string; parameters: string | Record<string, unknown> }

test('the Runs tab’s selection: select all, save as searches, and run again', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-runs-selection-'));
  const held: { res: http.ServerResponse; term: string }[] = [];
  let holding = false;
  const source = http.createServer((req, res) => {
    const query = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('search_query') ?? '');
    const term = /all:(\w+)/.exec(query)?.[1] ?? 'nothing';
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    if (holding) held.push({ res, term });
    else res.end(feed(term));
  });
  const release = () => {
    holding = false;
    for (const { res, term } of held.splice(0)) res.end(feed(term));
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
            raise OSError('atlas-runs-selection test guard refuses external/8742 connection')
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

    // — The runs a person already has: three searches and a watch's run, one at a time -------
    expect((await engine(win, '/api/settings/execution', 'PUT', { max_concurrent_executions: 1, routine_fire_queue_limit: 8 })).status).toBe(200);
    const settled = (id: number) => expect.poll(async () => (await engine<RunRead>(win, `/api/executions/${id}`)).body.status,
      { timeout: 60_000 }).toBe('completed');
    const asked: number[] = [];
    for (const [kind, term] of [['dive', 'alpha'], ['dive', 'beta'], ['sweep', 'gamma']] as const) {
      const started = await engine<{ execution_id: number }>(win, `/api/search/${kind}`, 'POST', {
        ...(kind === 'dive' ? { repository: 'arxiv' } : { repositories: ['arxiv'] }),
        query: term, keywords: [term], max_results: 5, date_from: '2026-01-01', date_to: '2026-11-30',
      });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      asked.push(started.body.execution_id);
      await settled(started.body.execution_id);
    }
    const watch = await engine<{ id: number }>(win, '/api/routines', 'POST', {
      name: 'Selection watch', schedule_cron: '0 9 * * *', is_active: false,
      parameters: { repositories: ['arxiv'], keywords: ['delta'], query: 'delta', max_results: 5 },
    });
    expect(watch.status).toBeLessThan(300);
    const fired = await engine<{ execution_id: number }>(win, `/api/routines/${watch.body.id}/run`, 'POST');
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    const watchRun = fired.body.execution_id;
    await settled(watchRun);
    const [alpha, beta, gamma] = asked as [number, number, number];

    // — Select all: every run listed ---------------------------------------------------------
    await win.evaluate(() => { window.location.hash = '#/runs'; });
    const history = win.locator('[data-runs="history"]');
    await expect(history.locator('.run-row')).toHaveCount(4, { timeout: 60_000 });
    const all = history.locator('[data-runs="select-all"]');
    await expect(all).toHaveText('Select all 4');
    await all.getByRole('checkbox').check();
    await expect(all).toHaveText('All 4 selected');
    await expect(history.locator('.run-row input[type="checkbox"]:checked')).toHaveCount(4);
    const bar = win.getByRole('group', { name: 'The selected runs' });
    await expect(bar.locator('[data-runs="chosen"]')).toHaveText('4 runs: export their papers as');

    // — Save as searches: one for each search, linked back; the watch's run is not -------------
    await bar.locator('[data-runs="save-searches"]').click();
    await expect(bar.locator('[data-runs="saved"]')).toContainText(
      `Saved 3 searches: “gamma”, “beta”, and “alpha”. Run ${watchRun} is a watch’s run, not saved: its search is its `
      + 'watch’s, and Saved keeps a copy of every watch.', { timeout: 30_000 });
    await expect(bar.locator('[data-runs="saved"]').getByRole('link', { name: 'Open Saved' })).toHaveAttribute('href', '#/search/saved');
    const saved = (await engine<Saved[]>(win, '/api/configurations')).body.filter((c) => c.config_type !== 'routine');
    expect(saved.map((c) => c.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
    const params = (c: Saved) => (typeof c.parameters === 'string' ? JSON.parse(c.parameters) : c.parameters) as Record<string, unknown>;
    const gammaSaved = saved.find((c) => c.name === 'gamma')!;
    expect(gammaSaved.config_type).toBe('manual_sweep');
    expect(params(gammaSaved)).toMatchObject({ repositories: ['arxiv'], keywords: ['gamma'], date_from: '2026-01-01', date_to: '2026-11-30', max_results: 5 });
    expect(saved.find((c) => c.name === 'alpha')!.config_type).toBe('manual_dive');
    for (const id of asked) expect((await engine<RunRead>(win, `/api/executions/${id}`)).body.saved_configuration_id).not.toBeNull();
    await widen(app, win, 960);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-runs-selection-saved-960.png') });
    await widen(app, win, 1440);

    // — Run again: asked first, then each run's own search, one at once and the rest in turn ----
    holding = true;
    await bar.locator('[data-runs="run-again"]').click();
    const question = bar.locator('[data-confirm="run-again"]');
    await expect(question).toBeFocused();
    await expect(question.locator('.confirm-question')).toHaveText(
      'Run 4 runs again, each with its own terms, dates, limit, and sources, as new runs linked back to them? Each '
      + 'summarizes only if its run tried to, with what Settings › AI holds now. '
      + `Run ${watchRun} is a watch’s run: it is emailed and delivered as its watch is set when it finishes. `
      + 'resmon runs 1 at once, so 3 wait for a free slot, under Waiting above, and start on their own.');
    await widen(app, win, 1280);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-runs-selection-run-again-1280.png') });
    await widen(app, win, 1920);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-runs-selection-run-again-1920.png') });
    await widen(app, win, 1440);
    // Not now leaves everything as it was.
    await question.getByRole('button', { name: 'Not now' }).click();
    await expect(question).toHaveCount(0);
    expect((await engine<RunRead[]>(win, '/api/executions')).body).toHaveLength(4);

    await bar.locator('[data-runs="run-again"]').click();
    await question.getByRole('button', { name: 'Run 4 again' }).click();
    await expect(bar.locator('[data-runs="ran-again"]'))
      .toHaveText(/^Started run \d+\. 3 wait for a free slot, under Waiting, and start on their own\.$/, { timeout: 30_000 });
    await expect(win.locator('[data-runs="waiting"] .active-row')).toHaveCount(3, { timeout: 30_000 });
    await expect(win.locator('[data-runs="running"] .active-row')).toHaveCount(1);
    await expect(win.locator('[data-runs="waiting"] .active-row').first().locator('.active-meta')).toContainText('repeats run');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-runs-selection-ran-again.png') });

    // Let them go: all four run, in turn, each linked back to the run it repeats.
    release();
    const repeats = async () => (await engine<RunRead[]>(win, '/api/executions')).body.filter((r) => r.restarted_from !== null);
    await expect.poll(async () => (await repeats()).filter((r) => r.status === 'completed').length, { timeout: 120_000, intervals: [500] })
      .toBe(4);
    expect((await repeats()).map((r) => r.restarted_from).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([alpha, beta, gamma, watchRun]);
    const again = await repeats();
    expect(again.find((r) => r.restarted_from === watchRun)?.execution_type).toBe('automated_sweep');
    await expect(win.locator('[data-runs="waiting"]')).toHaveCount(0, { timeout: 30_000 });
    await expect(history.locator('.run-row')).toHaveCount(8, { timeout: 30_000 });
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
