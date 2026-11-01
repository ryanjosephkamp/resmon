/**
 * The engine behind an Atlas window changes, and the window says so.
 *
 * Two real engines, A (the one this window's Electron spawned) and B (started
 * here on a port of its own), each over its own seeded database. The window's
 * own health requests are delivered to B while it keeps A's address, which is
 * what a window sees when the engine at its address is a different process:
 * the one line under the bar says "The engine behind this window changed.",
 * and nothing reloads until Reload is pressed, from the keyboard. Reloaded,
 * the window has opened on B and says nothing. An engine from before identity
 * was reported, and one that does not answer, are said as "cannot be read"
 * rather than taken for either engine. Neither database changes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { FRONTEND_ROOT, REPO_ROOT, SCREENSHOT_DIR, ATLAS_LANDMARK, atlasEnv, launchEnv, e2eAuth, registerStateDir } from './fixtures/resmon-app';

test('a changed engine is said in one line, Reload is the person\'s, and an unreadable identity is said as that', async () => {
  test.setTimeout(240_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-atlas-engine-changed-'));
  const a = path.join(root, 'A'); const b = path.join(root, 'B');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const envA: Record<string, string> = { ...atlasEnv(launchEnv(a, true)), RESMON_DISABLE_SCHEDULER: '1' };
  const envB: Record<string, string> = { ...launchEnv(b, true), RESMON_DISABLE_SCHEDULER: '1' };
  const helper = path.join(REPO_ROOT, 'resmon_scripts/verification_scripts/test_connected_identity_boundary.py');
  for (const env of [envA, envB]) execFileSync(env.RESMON_PYTHON, [helper, 'seed', env.RESMON_DB_PATH], { env });
  const snapshot = (env: Record<string, string>) =>
    execFileSync(env.RESMON_PYTHON, [helper, 'snapshot', env.RESMON_DB_PATH], { env, encoding: 'utf8' });
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const portB = (reservation.address() as net.AddressInfo).port;
  expect(portB).not.toBe(8742);
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  // B is started here rather than by Electron, so its token file is registered by hand.
  registerStateDir(b);
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
    await win.locator(ATLAS_LANDMARK).waitFor({ state: 'visible', timeout: 60_000 });
    const portA = fs.readFileSync(envA.RESMON_PORT_FILE, 'utf8').trim();
    expect(portA).not.toBe('8742');
    const baseA = `http://127.0.0.1:${portA}`; const baseB = `http://127.0.0.1:${portB}`;
    const healthA = await (await win.request.get(baseA + '/api/health', { headers: e2eAuth(baseA + '/api/health') })).json();
    backendPidA = Number(healthA.pid);
    if (process.platform !== 'win32') expect(Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(backendPidA)], { encoding: 'utf8' }).trim())).toBe(appProcess.pid);
    await expect.poll(async () => (await win.request.get(baseB + '/api/health', { headers: e2eAuth(baseB + '/api/health') })).status()).toBe(200);
    const healthB = await (await win.request.get(baseB + '/api/health', { headers: e2eAuth(baseB + '/api/health') })).json();
    expect(healthB.pid).toBe(backend.pid);
    expect(healthA.identity.runtime_id).not.toBe(healthB.identity.runtime_id);
    // 2.2: B is a different instance, with its own token, and it answers only
    // origins it has been told about. It is told about this renderer the way an
    // attached daemon is (main process, B's token, no Origin), and the forwarded
    // requests below carry B's token — what the app would hold had it attached
    // to B. What is under test is the identity display, not the credential.
    const rendererOrigin = new URL(win.url()).origin;
    const registered = await e2eFetch(baseB + '/api/auth/renderer-origin', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: rendererOrigin }) });
    expect(registered.status).toBe(200);
    const authB = e2eAuth(baseB + '/');
    expect(authB.Authorization).toMatch(/^Bearer /);
    const beforeA = snapshot(envA); const beforeB = snapshot(envB);
    const notice = win.locator('.engine-notice');
    const engineScreen = async () => {
      // Health › This engine shares the shell's reading, so opening it asks the engine again.
      await win.evaluate(() => { window.location.hash = '#/today'; });
      await win.evaluate(() => { window.location.hash = '#/health/engine'; });
      await expect(win.locator('[data-health="identity"]')).toBeVisible({ timeout: 30_000 });
    };
    await engineScreen();
    await expect(win.locator('[data-health="details"]')).toContainText(healthA.identity.runtime_id, { timeout: 30_000 });
    await expect(notice).toHaveCount(0);

    // — the engine at the window's address is now B ---------------------------------------
    const pattern = `${baseA}/api/health*`;
    await win.route(pattern, (route) => {
      const incoming = new URL(route.request().url());
      return route.continue({ url: baseB + incoming.pathname + incoming.search,
        headers: { ...route.request().headers(), authorization: authB.Authorization } });
    });
    await engineScreen();
    await expect(notice).toHaveAttribute('data-engine', 'changed', { timeout: 30_000 });
    await expect(notice).toContainText('The engine behind this window changed.');
    await expect(win.locator('[data-health="details"]')).toContainText(healthB.identity.runtime_id);
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-engine-changed.png') });
    // Nothing reloads by itself: the line stays until Reload is pressed.
    let reloaded = false;
    win.once('load', () => { reloaded = true; });
    await win.waitForTimeout(1500); // an observation window: no reload happens on its own
    expect(reloaded, 'the window reloaded without being asked').toBe(false);

    // — Reload, from the keyboard: the window opens on B and has nothing to say ----------------
    const reload = notice.getByRole('button', { name: 'Reload', exact: true });
    await reload.focus();
    await expect(reload).toBeFocused();
    const loaded = win.waitForEvent('load');
    await win.keyboard.press('Enter');
    await loaded;
    await win.locator(ATLAS_LANDMARK).waitFor({ state: 'visible', timeout: 60_000 });
    await engineScreen();
    await expect(win.locator('[data-health="details"]')).toContainText(healthB.identity.runtime_id, { timeout: 30_000 });
    await expect(notice).toHaveCount(0);
    await win.unroute(pattern);

    // — an engine that reports no identity, and then one that does not answer -----------------
    let legacyMode: 'legacy' | 'failure' = 'legacy';
    legacy = http.createServer((request, reply) => {
      reply.setHeader('Access-Control-Allow-Origin', '*');
      // The health check carries Authorization, so the browser preflights it;
      // a backend from before identity answered that preflight, and so does this.
      if (request.method === 'OPTIONS') {
        reply.writeHead(204, { 'Access-Control-Allow-Headers': 'authorization', 'Access-Control-Allow-Methods': 'GET' });
        reply.end(); return;
      }
      if (legacyMode === 'failure') { reply.writeHead(503); reply.end('{}'); return; }
      http.get(baseB + '/api/health', { headers: authB }, (response) => {
        let text = ''; response.on('data', (chunk) => { text += String(chunk); });
        response.on('end', () => {
          const body = JSON.parse(text) as Record<string, unknown>; delete body.identity;
          reply.writeHead(200, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify(body));
        });
      }).on('error', () => { reply.writeHead(503); reply.end('{}'); });
    });
    await new Promise<void>((resolve) => legacy!.listen(0, '127.0.0.1', resolve));
    const legacyPort = (legacy.address() as net.AddressInfo).port;
    expect(legacyPort).not.toBe(8742);
    await win.route(pattern, (route) => route.continue({ url: `http://127.0.0.1:${legacyPort}/api/health${new URL(route.request().url()).search}` }));
    // Away from Health › This engine, which reads the identity itself: the
    // shell's own reading, every thirty seconds, is what says it.
    await win.evaluate(() => { window.location.hash = '#/today'; });
    await expect(notice).toHaveAttribute('data-engine', 'unreadable', { timeout: 45_000 });
    await expect(notice).toHaveText('Which engine is behind this window cannot be read right now.');
    await expect(notice.getByRole('button')).toHaveCount(0);
    legacyMode = 'failure';
    await win.waitForResponse((r) => r.url().startsWith(`http://127.0.0.1:${legacyPort}/api/health`) && r.status() === 503, { timeout: 45_000 });
    await expect(notice).toHaveAttribute('data-engine', 'unreadable');
    await expect(notice).toHaveText('Which engine is behind this window cannot be read right now.');
    await win.screenshot({ path: path.join(SCREENSHOT_DIR, 'atlas-engine-unreadable.png') });
    await win.unroute(pattern);

    expect(snapshot(envA)).toBe(beforeA); expect(snapshot(envB)).toBe(beforeB);
    console.log('ATLAS_ENGINE_CHANGED', JSON.stringify({ root, portA, portB, runtimeA: healthA.identity.runtime_id,
      runtimeB: healthB.identity.runtime_id, tableCount: Object.keys(JSON.parse(beforeA)).length, rowsUnchanged: true }));
  } catch (error) {
    console.error('ATLAS_ENGINE_CHANGED_FAILURE', error);
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
    console.log('ATLAS_ENGINE_CHANGED_SHUTDOWN', JSON.stringify({ appPid: appProcess?.pid, appExit: appProcess?.exitCode,
      backendPidA, backendAExited: backendPidA ? !alive(backendPidA) : 'not observed',
      backendPid: backend.pid, backendExit: backend.exitCode, backendSignal: backend.signalCode }));
  }
});
