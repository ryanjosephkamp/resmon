/**
 * Several windows on one engine, in the real app: ⌘N, each window's own page
 * and history, a run started in the second window whose notice and download
 * stay there, a notice no window asked for, Open in New Window from a ⌘-click
 * and from the command palette, Ask's one turn per conversation seen from the
 * other window, and, on macOS, the windows merged into tabs, a new tab, a tab
 * moved out, and a window closed.
 *
 * The run's one source is arXiv, answered by a loopback server in this spec;
 * every other connection the engine tries, and port 8742, is refused by the
 * startup hook, and the spec fails if anything was. The assistant is
 * `fake_claude.py`. Notices are written to the log under the suite
 * (`postNotice`), each with the window a click would show it in; a click on a
 * real notification is not driven here.
 *
 * macOS draws its tab bar outside the page, so `capturePage` cannot see it:
 * the tab screenshots are the window server's own (`screencapture -l`), taken
 * where it is allowed, and they are evidence for a person, not assertions.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { ATLAS_LANDMARK, FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, launchEnv, registerStateDir } from './fixtures/resmon-app';

const TITLE = 'Authored windows fixture on tidal dissipation';
const FEED = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://arxiv.org/abs/2609.00007v1</id><title>${TITLE}</title>
  <author><name>Ada Fixture</name></author><published>${new Date().toISOString().slice(0, 10)}T00:00:00Z</published>
  <summary>Authored local fixture, not fetched scholarly content.</summary>
</entry></feed>`;

const mac = process.platform === 'darwin';
const MOD = mac ? 'Meta' : 'Control';

interface Notice { title: string; executionId: number | null; window: number | null }

/** The app's own windows, as the main process has them. */
function windowsOf(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    // A window part way through closing is not counted.
    .filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.getURL().startsWith('http://127.0.0.1:'))
    .map((w) => ({ id: w.id, url: w.webContents.getURL(), title: w.getTitle(), bounds: w.getBounds() })));
}

/** The BrowserWindow id behind a page. */
async function idOf(app: ElectronApplication, page: Page): Promise<number> {
  return (await app.browserWindow(page)).evaluate((w) => w.id);
}

/** Click an application-menu item by id, as it is clicked with `window` in front. */
function clickMenu(app: ElectronApplication, item: string, window: number | null = null) {
  return app.evaluate(({ BrowserWindow, Menu }, [which, id]) => {
    const found = Menu.getApplicationMenu()?.getMenuItemById(which as string);
    if (!found) throw new Error(`no menu item ${which}`);
    const front = id === null ? undefined : BrowserWindow.fromId(id as number) ?? undefined;
    found.click(undefined, front);
  }, [item, window] as const);
}

function menuLabel(app: ElectronApplication, item: string) {
  return app.evaluate(({ Menu }, which) => Menu.getApplicationMenu()?.getMenuItemById(which)?.label ?? null, item);
}

/** The window server's own picture of a window, tab bar included; macOS only, and only where it is allowed. */
async function capture(app: ElectronApplication, id: number, file: string): Promise<boolean> {
  if (!mac) return false;
  const source = await app.evaluate(({ BrowserWindow }, which) => BrowserWindow.fromId(which)?.getMediaSourceId() ?? '', id);
  const cg = source.split(':')[1];
  if (!cg) return false;
  try {
    execFileSync('screencapture', ['-x', '-o', `-l${cg}`, file], { timeout: 15_000 });
    return fs.existsSync(file) && fs.statSync(file).size > 0;
  } catch {
    console.log(`WINDOWS NOT CAPTURED — screencapture could not take window ${id}; the tab bar is not pictured by this run.`);
    return false;
  }
}

test('several windows on one engine: ⌘N, each its own page, run, download, and notice, and macOS tabs', async () => {
  test.setTimeout(420_000);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-atlas-windows-')));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  // "slow" is held until the spec lets it go, and "broken" is refused, for the run monitor's states.
  const held: http.ServerResponse[] = [];
  const source = http.createServer((req, res) => {
    const query = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('search_query') ?? '');
    if (query.includes('all:broken')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('refused');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    if (query.includes('all:slow')) held.push(res);
    else res.end(FEED);
  });
  const release = () => { for (const res of held.splice(0)) res.end(FEED); };
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourcePort = (source.address() as net.AddressInfo).port;
  expect(sourcePort).not.toBe(8742);
  const hookDir = path.join(root, 'python-hook');
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
            raise OSError('atlas-windows test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
`);
  const env: Record<string, string> = { ...launchEnv(stateDir, true) };
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  const python = execFileSync(env.RESMON_PYTHON ?? 'python3', ['-c', 'import sys;print(sys.executable)'], { env, encoding: 'utf8' }).trim();
  const cli = path.join(root, 'claude');
  fs.writeFileSync(cli, `#!/bin/sh\nexec "${python}" "${path.join(REPO_ROOT, 'resmon_scripts/verification_scripts/fixtures/fake_claude.py')}" "$@"\n`, { mode: 0o755 });
  const shots = SCREENSHOT_DIR;
  fs.mkdirSync(shots, { recursive: true });

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env, colorScheme: null, timeout: 180_000,
  });
  registerStateDir(stateDir);
  const output: string[] = [];
  app.process().stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const notices = (): Notice[] => output.join('').split('\n').filter((line) => line.startsWith('[main] notice '))
    .map((line) => JSON.parse(line.slice('[main] notice '.length)) as Notice);
  const problems: string[] = [];
  try {
    const first = await app.firstWindow({ timeout: 180_000 });
    first.on('pageerror', (e) => problems.push(`first: ${e.message}`));
    await first.locator(ATLAS_LANDMARK).waitFor({ timeout: 120_000 });
    const firstId = await idOf(app, first);
    const engineAt = (page: Page) => page.evaluate(() => {
      const api = (window as unknown as { resmonAPI: { getBackendPort(): string; getApiToken(): string | null } }).resmonAPI;
      return { port: api.getBackendPort(), token: api.getApiToken() };
    });

    // — ⌘N: a second window, at the start page, on the same engine ---------------------
    const opened = app.waitForEvent('window');
    await first.keyboard.press(`${MOD}+n`);
    const second = await opened;
    second.on('pageerror', (e) => problems.push(`second: ${e.message}`));
    await second.locator(ATLAS_LANDMARK).waitFor({ timeout: 60_000 });
    const secondId = await idOf(app, second);
    expect(secondId).not.toBe(firstId);
    expect(second.url()).toMatch(/#\/today$/);
    expect(await engineAt(second)).toEqual(await engineAt(first));
    expect((await engineAt(first)).port).not.toBe('8742');
    expect((await windowsOf(app)).map((w) => w.id).sort()).toEqual([firstId, secondId].sort());
    // Each window is named by its page, which is what tabs and the Window menu show.
    await expect.poll(() => second.evaluate(() => document.title)).toBe('Today');
    // The file menu says the same keys.
    expect(await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('file-new-window');
      return item ? { label: item.label, accelerator: item.accelerator ?? null } : null;
    })).toEqual({ label: 'New Window', accelerator: 'CmdOrCtrl+N' });

    // — each window its own page and its own Back ---------------------------------------
    const sections = (page: Page) => page.getByRole('navigation', { name: 'Sections' });
    await sections(first).getByRole('link', { name: 'Search' }).click();
    await expect(first).toHaveURL(/#\/search$/);
    await sections(second).getByRole('link', { name: 'Watches' }).click();
    await expect(second).toHaveURL(/#\/watches$/);
    await sections(second).getByRole('link', { name: 'Health' }).click();
    await expect(second).toHaveURL(/#\/health$/);
    await expect.poll(() => second.evaluate(() => document.title)).toBe('Health › Source wall');
    await second.keyboard.press(`${MOD}+BracketLeft`);
    await expect(second).toHaveURL(/#\/watches$/);
    expect(first.url()).toMatch(/#\/search$/);
    // The History menu moves the window in front, and only it.
    await clickMenu(app, 'history-forward', secondId);
    await expect(second).toHaveURL(/#\/health$/);
    await clickMenu(app, 'history-back', firstId);
    await expect(first).toHaveURL(/#\/today$/);
    expect(second.url()).toMatch(/#\/health$/);
    await second.screenshot({ path: path.join(shots, 'windows-second-health.png') });
    await first.screenshot({ path: path.join(shots, 'windows-first-today.png') });

    // — a run started in the second window: its notice and its download stay there ------
    await second.evaluate(() => { window.location.hash = '#/search/ask'; });
    await expect(second.getByRole('heading', { name: 'Ask the sources', level: 1 })).toBeVisible({ timeout: 60_000 });
    await second.getByRole('button', { name: 'Deep Sweep', exact: true }).click();
    await second.locator('.source[data-source="arxiv"] input').check();
    const terms = second.getByLabel('Search terms');
    await terms.fill('tidal dissipation');
    await terms.press('Enter');
    const started = second.waitForResponse((r) => r.url().endsWith('/api/search/sweep') && r.request().method() === 'POST');
    await second.getByRole('button', { name: 'Ask arXiv', exact: true }).click();
    const { execution_id: runId } = await (await started).json() as { execution_id: number };
    const run = second.locator(`.run[data-run="${runId}"]`);
    await expect(run).toHaveAttribute('data-status', 'completed', { timeout: 120_000 });
    await expect.poll(() => notices().find((n) => n.executionId === runId), { timeout: 30_000 }).toBeTruthy();
    expect(notices().find((n) => n.executionId === runId)?.window, 'the run\'s notice is not shown in the window that started it')
      .toBe(secondId);

    const reportFile = path.join(root, 'report-from-second.md');
    await app.evaluate(({ BrowserWindow }, where) => {
      BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_e, item) => item.setSavePath(where));
    }, reportFile);
    await second.getByRole('tab', { name: 'Report' }).click();
    await second.locator('[data-record="save-report"]').click();
    await expect.poll(() => (fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : ''), { timeout: 30_000 }).toContain(TITLE);
    const downloadsOf = (page: Page) => page.evaluate(() =>
      (window as unknown as { resmonAPI: { getDownloads(): Promise<{ filename: string; state: string; path: string }[]> } })
        .resmonAPI.getDownloads());
    await expect.poll(async () => (await downloadsOf(second)).map((d) => [d.filename, d.state])).toEqual([[`resmon-report-${runId}.md`, 'completed']]);
    expect(await downloadsOf(first)).toEqual([]);

    // — a notice no window asked for: shown in the window in front --------------------------
    await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)?.emit('focus'); }, firstId);
    const unasked = await first.evaluate(async () => {
      const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
      const response = await e2eFetch(`http://127.0.0.1:${port}/api/search/dive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository: 'arxiv', query: 'tidal', keywords: ['tidal'], max_results: 5 }),
      });
      return (await response.json() as { execution_id: number }).execution_id;
    });
    await expect.poll(() => notices().find((n) => n.executionId === unasked), { timeout: 120_000 }).toBeTruthy();
    expect(notices().find((n) => n.executionId === unasked)?.window).toBe(firstId);

    // — the run monitor and the Runs tab: one engine's runs, the same in both windows -----------
    const api = <T>(page: Page, route: string, method = 'GET', body?: unknown) => page.evaluate(async ([r, m, b]) => {
      const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
      const response = await e2eFetch(`http://127.0.0.1:${port}${r}`, {
        method: m as string,
        headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      return response.json();
    }, [route, method, body] as const) as Promise<T>;
    const mark = (page: Page) => page.locator('header.bar .mon');
    await first.evaluate(() => { window.location.hash = '#/runs'; });
    await second.evaluate(() => { window.location.hash = '#/runs'; });
    await expect.poll(() => second.evaluate(() => document.title)).toBe('Runs');
    const slow = await api<{ execution_id: number }>(first, '/api/search/dive', 'POST',
      { repository: 'arxiv', query: 'slow', keywords: ['slow'], max_results: 5 });
    for (const page of [first, second]) {
      await expect(mark(page)).toHaveAttribute('data-monitor', 'running', { timeout: 30_000 });
      await expect(page.locator(`[data-runs="running"] .active-row[data-run="${slow.execution_id}"]`)).toHaveCount(1, { timeout: 30_000 });
    }
    // Stop in one window; the other shows it at its next read of the engine.
    await first.locator(`[data-runs="running"] .active-row[data-run="${slow.execution_id}"]`)
      .getByRole('button', { name: /^Stop/ }).first().click();
    release();
    for (const page of [second, first]) {
      await expect(page.locator(`[data-runs="running"] .active-row[data-run="${slow.execution_id}"]`)).toHaveCount(0, { timeout: 30_000 });
      await expect(mark(page)).not.toHaveAttribute('data-monitor', 'running', { timeout: 30_000 });
    }
    expect((await api<{ status: string }>(second, `/api/executions/${slow.execution_id}`)).status).toBe('cancelled');
    // A failure is red in both; the panel opened in one clears it in both, since what was seen is the engine's.
    const broken = await api<{ execution_id: number }>(second, '/api/search/dive', 'POST',
      { repository: 'arxiv', query: 'broken', keywords: ['broken'], max_results: 5 });
    for (const page of [first, second]) await expect(mark(page)).toHaveAttribute('data-monitor', 'failed', { timeout: 60_000 });
    await second.screenshot({ path: path.join(shots, 'windows-monitor-failed-second.png') });
    const seen = first.waitForResponse((r) => r.url().endsWith('/api/executions/seen') && r.request().method() === 'POST');
    await mark(first).click();
    await seen;
    await expect(mark(first)).toHaveAttribute('data-monitor', 'idle');
    await expect(mark(second)).toHaveAttribute('data-monitor', 'idle', { timeout: 15_000 });
    expect((await api<{ failed_unseen: number[] }>(second, '/api/executions/active')).failed_unseen).not.toContain(broken.execution_id);
    await first.keyboard.press('Escape');

    // — Open in New Window: a ⌘-click on a section, and the command palette ----------------
    const fromClick = app.waitForEvent('window');
    await sections(first).getByRole('link', { name: 'Library' }).click({ modifiers: [MOD as 'Meta' | 'Control'] });
    const library = await fromClick;
    await library.locator(ATLAS_LANDMARK).waitFor({ timeout: 60_000 });
    expect(library.url()).toMatch(/#\/library$/);
    // The window clicked in stays where it was.
    expect(first.url()).toMatch(/#\/runs$/);
    await library.close();
    await expect.poll(async () => (await windowsOf(app)).length).toBe(2);

    await second.evaluate((id) => { window.location.hash = `#/runs/${id}`; }, runId);
    await expect(second.locator(`.run[data-run="${runId}"]`)).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => second.evaluate(() => document.title)).toBe(`Run ${runId}`);
    await second.keyboard.press(`${MOD}+k`);
    await second.getByRole('combobox', { name: 'Search commands' }).fill('this page');
    await expect(second.getByRole('option').first()).toHaveText(/^Open this page in a new window/);
    const fromPalette = app.waitForEvent('window');
    await second.keyboard.press('Enter');
    const copy = await fromPalette;
    await copy.locator(ATLAS_LANDMARK).waitFor({ timeout: 60_000 });
    expect(copy.url()).toMatch(new RegExp(`#/runs/${runId}$`));
    await copy.close();
    // ⌘↩ on a screen in the palette opens it in a new window.
    await second.keyboard.press(`${MOD}+k`);
    await second.getByRole('combobox', { name: 'Search commands' }).fill('watches');
    await expect(second.locator('[data-palette="new-window-hint"]')).toBeVisible();
    const fromPaletteRow = app.waitForEvent('window');
    await second.keyboard.press(`${MOD}+Enter`);
    const watches = await fromPaletteRow;
    await watches.locator(ATLAS_LANDMARK).waitFor({ timeout: 60_000 });
    expect(watches.url()).toMatch(/#\/watches$/);
    await watches.close();
    await expect.poll(async () => (await windowsOf(app)).length).toBe(2);

    // — Ask: one turn per conversation, seen from the other window --------------------------
    await first.evaluate(async (path) => {
      const port = (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort();
      const response = await e2eFetch(`http://127.0.0.1:${port}/api/settings/ai`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { ai_cli_path: path } }),
      });
      if (!response.ok) throw new Error(`AI settings answered ${response.status}`);
    }, cli);
    await first.evaluate(() => { window.location.hash = '#/ask'; });
    const pane = (page: Page) => page.getByRole('region', { name: 'Conversation' });
    const composer = pane(first).getByLabel('Message the assistant');
    await expect(composer).toBeEnabled({ timeout: 60_000 });
    await composer.fill('SAY:started in the first window\nSLEEP:8\nSAY:finished in the first window');
    await pane(first).getByRole('button', { name: 'Send', exact: true }).click();
    await expect(pane(first).locator('.conv-working')).toBeVisible({ timeout: 30_000 });
    await second.evaluate(() => { window.location.hash = '#/ask'; });
    const rail = second.getByRole('region', { name: 'Saved chats' });
    await rail.locator('.conv-row').first().click({ timeout: 60_000 });
    const held = pane(second).locator('[data-ask="held-elsewhere"]');
    await expect(held).toBeVisible({ timeout: 30_000 });
    await expect(pane(second).getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await second.screenshot({ path: path.join(shots, 'windows-ask-held-elsewhere.png') });
    // When it ends, the other window shows its answer, and can send again.
    await expect(held).toHaveCount(0, { timeout: 60_000 });
    await expect(pane(second).locator('.conv-msg[data-role="assistant"] .conv-text').last()).toContainText('finished in the first window');
    await expect(pane(second).getByLabel('Message the assistant')).toBeEnabled();

    // — macOS: the windows into tabs, a new tab, a tab out, a window closed ------------------
    if (mac) {
      const strip = (page: Page) => page.evaluate(() => document.documentElement.dataset.tabStrip ?? null);
      expect(await strip(first)).toBeNull();
      expect(await menuLabel(app, 'window-tab-bar')).toBe('Show Tab Bar');
      await first.evaluate(() => { window.location.hash = '#/today'; });
      // Two windows of their own: the second opened a step down and right of the first.
      const apart = await windowsOf(app);
      expect(apart[0]!.bounds).not.toEqual(apart[1]!.bounds);
      await clickMenu(app, 'window-merge', firstId);
      // In one window's tabs, macOS gives every tab the group's frame.
      await expect.poll(async () => new Set((await windowsOf(app)).map((w) => JSON.stringify(w.bounds))).size).toBe(1);
      await expect.poll(() => strip(first)).not.toBeNull();
      await expect.poll(() => strip(second)).not.toBeNull();
      const height = Number(await strip(first));
      expect([28, 56]).toContain(height);
      expect(await menuLabel(app, 'window-tab-bar')).toBe('Hide Tab Bar');
      // The bar starts below the room left for the tab bar, and leaves no room for the window controls.
      const bar = await first.locator('.bar').boundingBox();
      expect(bar?.y).toBe(height);
      expect(await first.locator('.bar').evaluate((n) => getComputedStyle(n).paddingLeft)).toBe('20px');
      await first.waitForTimeout(1_500);
      for (const [id, name] of [[firstId, 'first'], [secondId, 'second']] as const) {
        await capture(app, id, path.join(shots, `windows-tabs-${name}.png`));
      }
      // The theme changed in one window reaches another when it comes to the front.
      const themeOf = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
      const choose = async (page: Page, theme: string) => {
        await page.keyboard.press(`${MOD}+k`);
        await page.getByRole('combobox', { name: 'Search commands' }).fill(theme);
        await page.getByRole('option', { name: theme === 'light' ? /^Light/ : /^Dark/ }).click();
      };
      // Chosen in the first window rather than followed from the system, so only the window's own read can change it.
      const was = await themeOf(first) ?? 'dark';
      const other = was === 'dark' ? 'light' : 'dark';
      await choose(first, was);
      await choose(second, other);
      await expect.poll(() => themeOf(second)).toBe(other);
      expect(await themeOf(first)).toBe(was);
      await first.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => themeOf(first)).toBe(other);
      // macOS lays the tab bar out again in the new theme once its titles are set again (`resmon:theme-source`).
      await first.waitForTimeout(2_500);
      await capture(app, firstId, path.join(shots, `windows-tabs-first-${other}.png`));

      // ⌘T: a new tab of the window in front, with the room for the tab bar from its first paint.
      const tabOpened = app.waitForEvent('window');
      await clickMenu(app, 'file-new-tab', firstId);
      const tab = await tabOpened;
      await tab.locator(ATLAS_LANDMARK).waitFor({ timeout: 60_000 });
      expect(await strip(tab)).toBe(String(height));
      const tabId = await idOf(app, tab);
      await first.waitForTimeout(1_500);
      await capture(app, tabId, path.join(shots, 'windows-tabs-new-tab.png'));

      // Move Tab to New Window, then close windows down to one: tabs end, and the bar is as it was.
      await clickMenu(app, 'window-move-tab', tabId);
      await tab.close();
      await second.close();
      await expect.poll(async () => (await windowsOf(app)).length).toBe(1);
      await expect.poll(() => strip(first)).toBeNull();
      expect(await first.locator('.bar').evaluate((n) => getComputedStyle(n).paddingLeft)).toBe('86px');
      expect(await menuLabel(app, 'window-tab-bar')).toBe('Show Tab Bar');
      await first.waitForTimeout(800);
      await capture(app, firstId, path.join(shots, 'windows-one-left.png'));
    } else {
      // Off macOS a tab asked for is a window beside the one it was asked from.
      await second.close();
      await expect.poll(async () => (await windowsOf(app)).length).toBe(1);
    }

    // The window left still works on the same engine.
    await sections(first).getByRole('link', { name: 'Search' }).click();
    await expect(first).toHaveURL(/#\/search$/);
    expect(problems).toEqual([]);
    console.log('WINDOWS', JSON.stringify({ firstId, secondId, runId, unasked, notices: notices() }));
  } finally {
    await app.close().catch(() => { /* already gone */ });
    await new Promise<void>((resolve) => source.close(() => resolve()));
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl')) ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    fs.rmSync(root, { recursive: true, force: true });
    expect(blocked).toBe('');
  }
});
