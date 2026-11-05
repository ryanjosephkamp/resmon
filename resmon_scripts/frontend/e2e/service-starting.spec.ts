/**
 * A launch that waits for a background service still starting says so: a
 * small window, "resmon is starting", with why it can take minutes, shown once
 * the wait has lasted a moment, and gone when the service opens its window.
 *
 * launchd is the suite's stand-in (`fake_launchctl.py`) holding a test label,
 * and the unit is written into the spec's own unit folder, so nothing here asks
 * about, starts, or stops the service of the person running it. The service
 * itself is this checkout's app with `--service`, started by the spec as
 * launchd would start it, on a free port and the spec's own state folder.
 * macOS only: the check at launch is the Mac's (`CHECKS_SERVICE` in `main.ts`).
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { ATLAS_LANDMARK, FRONTEND_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';

test.describe.configure({ mode: 'serial' });
test.skip(process.platform !== 'darwin', 'The check of the service at launch is the Mac\'s.');

const LABEL = 'com.resmon.e2e';

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

/** A launchd job held by the stand-in, loaded with a process, and a unit that starts this checkout's app as the service. */
function startingService(stateDir: string, env: Record<string, string>, port: number): { calls: () => string[][] } {
  const unitDir = env.RESMON_SERVICE_UNIT_DIR!;
  fs.mkdirSync(unitDir, { recursive: true });
  const exe = path.join(FRONTEND_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  fs.writeFileSync(path.join(unitDir, `${LABEL}.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${exe}</string><string>--service</string><string>--port=${port}</string></array>
</dict></plist>
`);
  const state = path.join(stateDir, 'fake-launchctl.json');
  fs.writeFileSync(state, JSON.stringify({ loaded: { [LABEL]: 4242 } }));
  env.FAKE_LAUNCHCTL_STATE = state;
  return { calls: () => (JSON.parse(fs.readFileSync(state, 'utf8')) as { calls?: string[][] }).calls ?? [] };
}

/** The window that says resmon is starting: the launch's one page that is not the renderer's. */
async function startingWindow(app: ElectronApplication): Promise<Page> {
  const found = app.windows().find((page) => page.url().startsWith('data:'));
  return found ?? app.waitForEvent('window', { predicate: (page) => page.url().startsWith('data:'), timeout: 60_000 });
}

function exited(app: ElectronApplication): Promise<number | null> {
  const child = app.process();
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/**
 * resmon processes still running on this spec's own profile, which only this
 * spec started: the app's own processes, not the Chromium helpers under them.
 */
function leftOn(profile: string): { pid: number; command: string }[] {
  const folder = profile.slice(profile.indexOf('=') + 1);
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((found): found is RegExpExecArray => !!found && found[2]!.includes(folder) && !found[2]!.includes('--type='))
    .map((found) => ({ pid: Number(found[1]), command: found[2]! }));
}

test('a launch waiting for a starting service says resmon is starting, and goes once the service opens its window', async () => {
  test.setTimeout(300_000);
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-service-starting-')));
  const port = await freePort();
  expect(port).not.toBe(8742);
  const env = atlasEnv(launchEnv(stateDir, true));
  env.RESMON_SERVICE_AT_LAUNCH = '1';
  env.RESMON_DAEMON_PORT = String(port);
  delete env.RESMON_DISABLE_SCHEDULER;
  const launchd = startingService(stateDir, env, port);
  const profile = `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`;

  const waiting = await electron.launch({ args: ['.', profile], cwd: FRONTEND_ROOT, env, timeout: 180_000 });
  const said: string[] = [];
  waiting.process().stdout?.on('data', (chunk: Buffer) => said.push(chunk.toString()));
  let service: ElectronApplication | null = null;
  try {
    const page = await startingWindow(waiting);
    await expect(page.getByRole('heading', { name: 'resmon is starting' })).toBeVisible();
    await expect(page.locator('body')).toContainText('Waiting for its background service to finish starting.');
    await expect(page.locator('body')).toContainText('updates the database that holds your collection, which can take a few minutes');
    // All of it in the window, none cut off at the bottom.
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
    await expect(page.locator('body')).toContainText('This window closes when resmon opens.');
    expect(said.join('')).toContain('[service] Showing that resmon is starting (starting)');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'service-starting-window.png') });
    const cg = (await waiting.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMediaSourceId() ?? '')).split(':')[1];
    try {
      if (cg) execFileSync('screencapture', ['-x', '-o', `-l${cg}`, path.join(SCREENSHOT_DIR, 'service-starting-window-framed.png')]);
    } catch {
      console.log('SERVICE STARTING NOT CAPTURED — screencapture could not take the window; its frame is not pictured by this run.');
    }
    // A wait, never a stop: nothing but questions has gone to launchd.
    expect(launchd.calls().every(([command]) => command === 'print' || command === 'print-disabled')).toBe(true);

    // The service answers, as launchd would have started it: the launch hands over and goes, and the service opens the window.
    const serviceEnv = { ...env };
    delete serviceEnv.RESMON_SERVICE_AT_LAUNCH;
    service = await electron.launch({ args: ['.', '--service', `--port=${port}`, profile], cwd: FRONTEND_ROOT, env: serviceEnv, timeout: 180_000 });
    expect(await exited(waiting)).toBe(0);
    expect(said.join('')).toContain('[service] At launch: {"done":"started"}');
    const opened = await service.firstWindow({ timeout: 120_000 });
    await opened.locator(ATLAS_LANDMARK).waitFor({ timeout: 120_000 });
    expect(await opened.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort()))
      .toBe(String(port));
    expect(launchd.calls().every(([command]) => command === 'print' || command === 'print-disabled')).toBe(true);
    // The launch the hand-over started again has handed its window request on and gone too.
    await expect.poll(() => leftOn(profile).filter(({ pid }) => pid !== service?.process().pid), { timeout: 30_000 }).toEqual([]);
  } finally {
    await waiting.close().catch(() => { /* gone */ });
    await service?.close().catch(() => { /* gone */ });
    for (const { pid, command } of leftOn(profile)) {
      console.log(`SERVICE STARTING LEFT A PROCESS ${pid} (${command.slice(0, 200)}); stopped.`);
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    removeStateDir(stateDir);
  }
});

test('closing the starting window stops waiting, and leaves the service starting', async () => {
  test.setTimeout(180_000);
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-service-starting-')));
  const port = await freePort();
  const env = atlasEnv(launchEnv(stateDir, true));
  env.RESMON_SERVICE_AT_LAUNCH = '1';
  env.RESMON_DAEMON_PORT = String(port);
  const launchd = startingService(stateDir, env, port);
  const profile = `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`;
  const waiting = await electron.launch({ args: ['.', profile], cwd: FRONTEND_ROOT, env, timeout: 180_000 });
  try {
    const page = await startingWindow(waiting);
    await expect(page.getByRole('heading', { name: 'resmon is starting' })).toBeVisible();
    await waiting.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
    expect(await exited(waiting)).toBe(0);
    expect(launchd.calls().every(([command]) => command === 'print' || command === 'print-disabled')).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'daemon.lock'))).toBe(false);
  } finally {
    await waiting.close().catch(() => { /* gone */ });
    for (const { pid, command } of leftOn(profile)) {
      console.log(`SERVICE STARTING LEFT A PROCESS ${pid} (${command.slice(0, 200)}); stopped.`);
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    removeStateDir(stateDir);
  }
});
