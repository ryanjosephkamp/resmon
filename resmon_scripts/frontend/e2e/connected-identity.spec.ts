/** Actual Electron header, two owned serving processes and a legacy HTTP adapter. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, launchEnv, ensureScreenshotDir } from './fixtures/resmon-app';

test('connected header observes real runtime change, explicit keyboard reaccept and legacy/error status', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-connected-identity-'));
  const a = path.join(root, 'A'); const b = path.join(root, 'B');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const envA: Record<string, string> = { ...launchEnv(a, true), RESMON_DISABLE_SCHEDULER: '1', PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring' };
  const envB: Record<string, string> = { ...launchEnv(b, true), RESMON_DISABLE_SCHEDULER: '1', PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring' };
  const helper = path.join(REPO_ROOT, 'resmon_scripts/verification_scripts/test_connected_identity_boundary.py');
  for (const env of [envA, envB]) execFileSync(env.RESMON_PYTHON, [helper, 'seed', env.RESMON_DB_PATH], { env });
  const snapshot = (env: Record<string, string>) =>
    execFileSync(env.RESMON_PYTHON, [helper, 'snapshot', env.RESMON_DB_PATH], { env, encoding: 'utf8' });
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const portB = (reservation.address() as net.AddressInfo).port;
  expect(portB).not.toBe(8742);
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const backendLog = fs.openSync(path.join(b, 'backend.log'), 'w');
  const backend = spawn(envB.RESMON_PYTHON, [path.join(REPO_ROOT, 'resmon_scripts/resmon.py'), String(portB)],
    { cwd: b, env: envB, stdio: ['ignore', backendLog, backendLog] });
  let app: ElectronApplication | undefined;
  let appProcess: ChildProcess | undefined;
  let backendPidA: number | undefined;
  let legacy: http.Server | undefined;
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(a, 'electron-user-data')}`], cwd: FRONTEND_ROOT, env: envA, timeout: 180_000 });
    appProcess = app.process();
    const win = await app.firstWindow({ timeout: 180_000 });
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    const portA = fs.readFileSync(envA.RESMON_PORT_FILE, 'utf8').trim();
    expect(portA).not.toBe('8742');
    const baseA = `http://127.0.0.1:${portA}`; const baseB = `http://127.0.0.1:${portB}`;
    const healthA = await (await win.request.get(baseA + '/api/health')).json();
    backendPidA = Number(healthA.pid);
    if (process.platform !== 'win32') expect(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(backendPidA)], { encoding: 'utf8' }).trim())).toBe(appProcess.pid);
    await expect.poll(async () => (await win.request.get(baseB + '/api/health')).status()).toBe(200);
    const healthB = await (await win.request.get(baseB + '/api/health')).json();
    expect(healthB.pid).toBe(backend.pid);
    expect(healthA.identity.runtime_id).not.toBe(healthB.identity.runtime_id);
    const beforeA = snapshot(envA); const beforeB = snapshot(envB);
    const summary = win.getByLabel('Connected app details');
    await summary.focus(); await win.keyboard.press('Enter');
    const details = win.locator('.connection-details');
    await expect(details).toContainText(healthA.identity.runtime_id);
    await expect(win.locator('.connection-identity [role="status"]')).toContainText('Connected ·');
    await win.screenshot({ path: path.join(ensureScreenshotDir(), 'identity-A.png') });
    // Keep the renderer's named address, but deliver its real request to B.
    const pattern = `${baseA}/api/health*`;
    const forwarded: string[] = [];
    await win.route(pattern, route => {
      const incoming = new URL(route.request().url()); forwarded.push(incoming.search);
      return route.continue({ url: baseB + incoming.pathname + incoming.search });
    });
    await details.getByRole('button', { name: 'Refresh status' }).click();
    await expect(win.locator('.connection-identity [role="status"]')).toHaveText('Running app changed');
    await expect(details).toContainText(healthA.identity.runtime_id);
    await expect(details).toContainText('Last observation is stale');
    expect(forwarded).toContain(`?expected_runtime_id=${healthA.identity.runtime_id}`);
    await win.screenshot({ path: path.join(ensureScreenshotDir(), 'identity-changed-stale.png') });
    await details.getByRole('button', { name: 'Use this running app' }).focus(); await win.keyboard.press('Enter');
    await expect(details).toContainText(healthB.identity.runtime_id);
    await expect(win.locator('.connection-identity [role="status"]')).toContainText('Connected ·');
    await expect(details).not.toContainText('Last observation is stale');
    await win.screenshot({ path: path.join(ensureScreenshotDir(), 'identity-B-accepted.png') });
    await win.unroute(pattern);
    // An authored legacy local dependency really forwards health over HTTP,
    // removes unsupported metadata and ignores the query as older servers do.
    let legacyMode: 'legacy' | 'failure' = 'legacy';
    legacy = http.createServer((_request, reply) => {
      if (legacyMode === 'failure') { reply.writeHead(503); reply.end('{}'); return; }
      http.get(baseB + '/api/health', response => {
        let text = ''; response.on('data', chunk => { text += String(chunk); });
        response.on('end', () => {
          const body = JSON.parse(text) as Record<string, unknown>; delete body.identity;
          reply.writeHead(200, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify(body));
        });
      }).on('error', () => { reply.writeHead(503); reply.end('{}'); });
    });
    await new Promise<void>(resolve => legacy!.listen(0, '127.0.0.1', resolve));
    const legacyPort = (legacy.address() as net.AddressInfo).port; expect(legacyPort).not.toBe(8742);
    await win.route(pattern, route => route.continue({ url: `http://127.0.0.1:${legacyPort}/api/health${new URL(route.request().url()).search}` }));
    await details.getByRole('button', { name: 'Refresh status' }).click();
    await expect(win.locator('.connection-identity [role="status"]')).toHaveText('Identity unavailable');
    await expect(details).toContainText('Last observation is stale');
    await win.screenshot({ path: path.join(ensureScreenshotDir(), 'identity-legacy.png') });
    legacyMode = 'failure';
    await details.getByRole('button', { name: 'Use this running app' }).click();
    await expect(win.locator('.connection-identity [role="status"]')).toHaveText('Running app unavailable');
    await expect(details).toContainText(healthB.identity.runtime_id);
    expect(snapshot(envA)).toBe(beforeA); expect(snapshot(envB)).toBe(beforeB);
    console.log('IDENTITY_ELECTRON', JSON.stringify({ root, portA, portB, healthA, healthB, forwarded,
      tableCount: Object.keys(JSON.parse(beforeA)).length, rowsUnchanged: true, keyboard: true, profile: path.join(a, 'electron-user-data') }));
  } catch (error) {
    console.error('IDENTITY_ELECTRON_FAILURE', error);
    throw error;
  } finally {
    // Cleanup covers failed launch as well as failures after the window appears.
    try { if (app) await app.close(); }
    finally {
      if (legacy) { legacy.closeAllConnections(); await new Promise<void>(resolve => legacy!.close(() => resolve())); }
      if (backend.exitCode === null && backend.signalCode === null) {
        backend.kill('SIGTERM');
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => backend.kill('SIGKILL'), 10000);
          backend.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      fs.closeSync(backendLog);
    }
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    if (backendPidA) {
      try { await expect.poll(() => alive(backendPidA!), { timeout: 15000 }).toBe(false); }
      finally { if (alive(backendPidA)) process.kill(backendPidA, 'SIGKILL'); }
    }
    console.log('IDENTITY_ELECTRON_SHUTDOWN', JSON.stringify({ appPid: appProcess?.pid, appExit: appProcess?.exitCode,
      backendPidA, backendAExited: backendPidA ? !alive(backendPidA) : 'not observed',
      backendPid: backend.pid, backendExit: backend.exitCode, backendSignal: backend.signalCode }));
  }
});
