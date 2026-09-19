/**
 * The local API lock-down (2.2), observed in the real Electron app.
 *
 * The backend-side properties — every route, Host, Origin, preflight — are
 * proven against a real backend process in `test_local_api_auth.py`. What only
 * the app can show is here:
 *
 *   - the renderer's own requests carry the token in a header and never a URL,
 *     and the backend Electron spawned is really guarded;
 *   - the token is in no process's argv — the backend's, Electron's, or any of
 *     Chromium's helpers — read from `ps`, which is what another user would see;
 *   - the attach path refuses a daemon that published no token file, and uses
 *     the token and registers the renderer origin when one did.
 *
 * The "daemon" in the attach cases is a small Node HTTP server on an ephemeral
 * port, pointed at by a lock file in the spec's own state directory. Port 8742
 * and the real daemon are never touched.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { test, expect, _electron as electron } from '@playwright/test';
import { FRONTEND_ROOT, launchEnv, launchResmon, e2eAuth } from './fixtures/resmon-app';

test.describe.configure({ mode: 'serial' });

const APP_VERSION = (JSON.parse(fs.readFileSync(path.join(FRONTEND_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

test('the spawned backend is guarded, and the renderer sends the token in a header only', async () => {
  const { app, stateDir } = await launchResmon(true);
  try {
    const win = await app.firstWindow({ timeout: 180_000 });
    const backendRequests: { url: string; authorization: string | undefined }[] = [];
    win.on('request', (request) => {
      if (/^http:\/\/127\.0\.0\.1:\d+\/api\//.test(request.url())) {
        backendRequests.push({ url: request.url(), authorization: request.headers().authorization });
      }
    });
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 60_000 });
    const port = await win.evaluate(() => window.resmonAPI!.getBackendPort());
    expect(port).not.toBe('8742');
    const base = `http://127.0.0.1:${port}`;
    const token = await win.evaluate(() => (window.resmonAPI as unknown as { getApiToken(): string }).getApiToken());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The renderer's own traffic, from navigating to a data-heavy page.
    await win.evaluate(() => { window.location.hash = '#/results'; });
    await expect.poll(() => backendRequests.length).toBeGreaterThan(0);
    await win.waitForTimeout(500);
    expect(backendRequests.every((r) => r.authorization === `Bearer ${token}`)).toBe(true);
    expect(backendRequests.some((r) => r.url.includes(token))).toBe(false);

    // The same backend refuses a caller without the token, and a foreign page with it.
    const bare = await fetch(`${base}/api/health`);
    expect(bare.status).toBe(401);
    expect((await bare.json()).detail.reason).toBe('token_missing');
    const foreign = await fetch(`${base}/api/routines`, { headers: { ...e2eAuth(base + '/'), Origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    const health = await (await e2eFetch(`${base}/api/health`)).json() as { pid: number };

    // argv, as `ps` shows it to anyone: the backend, and every process on the machine.
    if (process.platform !== 'win32') {
      const backendArgv = execFileSync('ps', ['-o', 'command=', '-p', String(health.pid)], { encoding: 'utf8' });
      expect(backendArgv).toContain(`resmon.py ${port}`);
      expect(backendArgv).not.toContain(token);
      const everything = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const electronPid = app.process().pid!;
      expect(everything).toContain(String(electronPid));
      expect(everything.includes(token)).toBe(false);
      expect(everything.includes('--backend-port=')).toBe(false);
      console.log('LOCKDOWN_ARGV', JSON.stringify({ backendPid: health.pid, electronPid,
        processesScanned: everything.trim().split('\n').length, tokenFound: false }));
    }

    // The token file the backend published for other clients is owner-only.
    const file = path.join(stateDir, `api-token-${port}`);
    expect(fs.readFileSync(file, 'ascii').trim()).toBe(token);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  } finally {
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

interface FakeDaemon {
  port: number;
  requests: { method: string; url: string; authorization?: string; body: string }[];
  close: () => Promise<void>;
}

async function fakeDaemon(expectedToken: string | null): Promise<FakeDaemon> {
  const requests: FakeDaemon['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
      if (expectedToken === null || req.headers.authorization !== `Bearer ${expectedToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"detail":{"reason":"token_missing","message":"fake daemon"}}');
        return;
      }
      if (req.url === '/api/auth/renderer-origin' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ registered: JSON.parse(body).origin }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: APP_VERSION, pid: process.pid }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string' || address.port === 8742) throw new Error('bad fake daemon port');
  return { port: address.port, requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function launchAgainst(stateDir: string) {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT, env: launchEnv(stateDir, true), timeout: 180_000 });
  const win = await app.firstWindow({ timeout: 180_000 });
  await win.waitForLoadState('domcontentloaded');
  const port = await win.evaluate(() => window.resmonAPI!.getBackendPort());
  return { app, win, port };
}

test('a daemon that published no token file is never probed or attached to', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-attach-'));
  const daemon = await fakeDaemon(null);
  fs.writeFileSync(path.join(stateDir, 'daemon.lock'), JSON.stringify({ pid: process.pid, port: daemon.port, version: APP_VERSION }));
  try {
    const { app, port } = await launchAgainst(stateDir);
    try {
      expect(Number(port)).not.toBe(daemon.port);
      expect(port).not.toBe('8742');
      // Declined without a single request: not probed with or without a token.
      expect(daemon.requests).toEqual([]);
      expect(fs.existsSync(path.join(stateDir, `api-token-${port}`))).toBe(true);
    } finally { await app.close().catch(() => { /* gone */ }); }
  } finally {
    await daemon.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a daemon with a token file is attached with the token and told the renderer origin', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-attach-'));
  const token = 'A'.repeat(20) + 'b'.repeat(23);
  const daemon = await fakeDaemon(token);
  fs.writeFileSync(path.join(stateDir, 'daemon.lock'), JSON.stringify({ pid: process.pid, port: daemon.port, version: APP_VERSION }));
  fs.writeFileSync(path.join(stateDir, `api-token-${daemon.port}`), token, { mode: 0o600 });
  try {
    const { app, win, port } = await launchAgainst(stateDir);
    try {
      expect(Number(port)).toBe(daemon.port);
      const origin = new URL(win.url()).origin;
      const registration = daemon.requests.find((r) => r.url === '/api/auth/renderer-origin');
      expect(registration?.method).toBe('POST');
      expect(JSON.parse(registration!.body)).toEqual({ origin });
      const mainProcessRequests = daemon.requests.slice(0, daemon.requests.indexOf(registration!) + 1);
      expect(mainProcessRequests.map((r) => r.url)).toEqual(['/api/health', '/api/auth/renderer-origin']);
      expect(mainProcessRequests.every((r) => r.authorization === `Bearer ${token}`)).toBe(true);
      expect(await win.evaluate(() => (window.resmonAPI as unknown as { getApiToken(): string }).getApiToken())).toBe(token);
    } finally { await app.close().catch(() => { /* gone */ }); }
  } finally {
    await daemon.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
