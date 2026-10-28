/**
 * The app as the background service (`--service`), observed in the real app.
 *
 * One launch, followed through the life a service has:
 *
 *   - it puts up no window, and runs the engine with the scheduler, which the
 *     window's own backend never has;
 *   - a finished run's notification reaches the app, carrying the run, rather
 *     than going out through `osascript` (the engine's half of that hand-over
 *     is `test_desktop_notifications.py`);
 *   - a second launch of resmon exits and the service opens the window, on the
 *     service's own engine;
 *   - closing that window leaves the service running;
 *   - quitting stops the engine before the app exits, so its port and lock are
 *     free for the next start.
 *
 * What it cannot see is the notification on the screen: under the suite the
 * app writes each notice to its log instead of showing it (`postNotice`), so
 * nothing appears on the screen of the person at the Mac. How macOS credits a
 * notification the app posts is checked by hand in a packaged build; the pull
 * request says what was seen.
 *
 * The run's one source is arXiv, answered by a loopback server in this spec;
 * every other connection the engine tries, and port 8742, is refused by the
 * startup hook, and the spec fails if anything was.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, launchEnv } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

const FEED = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>https://arxiv.org/abs/2609.00002v1</id><title>Authored service-host fixture</title>
  <author><name>Ada Fixture</name></author><published>${new Date().toISOString().slice(0, 10)}T00:00:00Z</published>
  <summary>Authored local fixture, not fetched scholarly content.</summary>
</entry></feed>`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('the app as the service: no window, the scheduler, notices through the app, one process', async () => {
  test.setTimeout(240_000);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-service-'));
  const source = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(FEED);
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const sourcePort = (source.address() as net.AddressInfo).port;
  const port = await freePort();
  expect(port).not.toBe(8742);

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
            raise OSError('service-host test guard refuses external/8742 connection')
    return original_connect(self, address)
socket.socket.connect = connect
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'resmon_scripts'))})
from implementation_scripts import api_arxiv
api_arxiv._ARXIV_API_URL = ${JSON.stringify(`http://127.0.0.1:${sourcePort}/api/query`)}
`);
  const env = launchEnv(stateDir, true);
  env.RESMON_DAEMON_PORT = String(port);
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost';
  // The service owns the scheduler; the suite's shell must not be what turns it off.
  delete env.RESMON_DISABLE_SCHEDULER;
  const profile = `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`;

  const app = await electron.launch({ args: ['.', '--service', profile], cwd: FRONTEND_ROOT, env, timeout: 180_000 });
  const output: string[] = [];
  app.process().stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  let enginePid: number | null = null;
  try {
    // Up: the engine wrote its token beside the lock and answers with it.
    const tokenFile = path.join(stateDir, `api-token-${port}`);
    await expect.poll(() => fs.existsSync(tokenFile), { timeout: 120_000 }).toBe(true);
    await expect.poll(async () => (await e2eFetch(`${base}/api/health`).catch(() => null))?.status ?? 0,
      { timeout: 60_000 }).toBe(200);
    const lock = JSON.parse(fs.readFileSync(path.join(stateDir, 'daemon.lock'), 'utf8')) as { pid: number; port: number };
    expect(lock.port).toBe(port);
    enginePid = lock.pid;
    expect(enginePid).not.toBe(app.process().pid);

    // No window, and the engine is this app's child.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    expect(app.windows()).toHaveLength(0);

    // The scheduler is live: an active routine is a job in it. The window's own
    // backend runs none, and answers this with [].
    const created = await e2eFetch(`${base}/api/routines`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'service-host', schedule_cron: '0 0 1 1 *', is_active: true,
        notify_on_complete: false, parameters: { repositories: ['arxiv'], query: 'fixture' } }),
    });
    expect(created.status).toBe(201);
    const routine = await created.json() as { id: number };
    const jobs = await (await e2eFetch(`${base}/api/scheduler/jobs`)).json() as { id: string }[];
    expect(jobs.map((job) => job.id)).toContain(String(routine.id));

    // A run's notification reaches the app, carrying the run.
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const dive = await e2eFetch(`${base}/api/search/dive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository: 'arxiv', query: 'fixture', keywords: ['fixture'],
        date_from: from.toISOString().slice(0, 10), date_to: to.toISOString().slice(0, 10), max_results: 5 }),
    });
    expect(dive.status).toBeLessThan(300);
    const { execution_id: executionId } = await dive.json() as { execution_id: number };
    await expect.poll(async () => String((await (await e2eFetch(`${base}/api/executions/${executionId}`)).json()).status),
      { timeout: 120_000 }).toBe('completed');
    await expect.poll(() => output.join('').includes('[main] notice '), { timeout: 30_000 }).toBe(true);
    const notices = output.join('').split('\n').filter((line) => line.startsWith('[main] notice '))
      .map((line) => JSON.parse(line.slice('[main] notice '.length)) as { title: string; body: string; executionId: number });
    expect(notices).toHaveLength(1);
    expect(notices[0].executionId).toBe(executionId);
    // The OS shows the app's name beside every notification the app posts.
    expect(notices[0].title).toBe('Execution Completed');

    // A second launch of resmon hands over and exits; the service opens the window.
    const second = spawn(app.process().spawnfile, ['.', profile], { cwd: FRONTEND_ROOT, env, stdio: 'ignore' });
    const secondExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => second.once('exit', (code, signal) => resolve({ code, signal })));
    expect(secondExit).toEqual({ code: 0, signal: null });
    const win = await app.firstWindow({ timeout: 60_000 });
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    // On the service's engine, not one of its own.
    const windowPort = await win.evaluate(() => window.resmonAPI!.getBackendPort());
    expect(windowPort).toBe(String(port));

    // Closing the window leaves the service running.
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    expect((await e2eFetch(`${base}/api/health`)).status).toBe(200);
    expect(isAlive(app.process().pid!)).toBe(true);
    console.log('SERVICE_HOST', JSON.stringify({ port, appPid: app.process().pid, enginePid, jobs: jobs.length,
      executionId, notice: notices[0], secondExit, windowPort }));
  } finally {
    const appPid = app.process().pid!;
    await app.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    // Quitting stopped the engine first: its process is gone and its token file removed.
    if (enginePid !== null) {
      await expect.poll(() => isAlive(enginePid as number), { timeout: 30_000 }).toBe(false);
      expect(fs.existsSync(path.join(stateDir, `api-token-${port}`))).toBe(false);
    }
    expect(isAlive(appPid)).toBe(false);
    const blocked = fs.existsSync(path.join(stateDir, 'blocked.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'blocked.jsonl'), 'utf8') : '';
    expect(blocked).toBe('');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
