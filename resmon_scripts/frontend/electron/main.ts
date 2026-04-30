import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendPort: number = 8742;
let rendererServer: http.Server | null = null;
let rendererPort: number | null = null;
/** True when we attached to an already-running daemon and must not kill it on quit. */
let attachedToDaemon: boolean = false;

/** Platform-appropriate state directory for resmon. Mirrors daemon.state_dir(). */
function stateDir(): string {
  if (process.env.RESMON_STATE_DIR) return process.env.RESMON_STATE_DIR;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'resmon');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'resmon');
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'resmon');
}

function lockFilePath(): string {
  return path.join(stateDir(), 'daemon.lock');
}

interface LockPayload {
  pid: number;
  port: number;
  version: string;
  started_at?: string;
}

function readLockFile(): LockPayload | null {
  try {
    const raw = fs.readFileSync(lockFilePath(), 'utf-8').trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return null;
    if (typeof data.pid !== 'number' || typeof data.port !== 'number') return null;
    return data as LockPayload;
  } catch {
    return null;
  }
}

/** GET /api/health with a hard timeout. Resolves true on 200, false otherwise. */
function pingHealth(port: number, timeoutMs: number = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs },
      (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        resolve(ok);
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}


/** Find a free TCP port. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine port')));
      }
    });
    server.on('error', reject);
  });
}

/** Spawn the Python backend and return the child process. */
function startBackend(port: number): ChildProcess {
  const scriptDir = path.resolve(__dirname, '..', '..', '..');
  const resmonScript = path.join(scriptDir, 'resmon.py');
  const pythonPath = process.env.RESMON_PYTHON || 'python3';

  const child = spawn(pythonPath, [resmonScript, String(port)], {
    cwd: scriptDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data: Buffer) => {
    console.log(`[backend] ${data.toString().trim()}`);
  });

  child.stderr?.on('data', (data: Buffer) => {
    console.error(`[backend] ${data.toString().trim()}`);
  });

  child.on('exit', (code) => {
    console.log(`[backend] exited with code ${code}`);
    backendProcess = null;
  });

  return child;
}

/** Poll GET /api/health until the backend responds with 200. */
function waitForBackend(port: number, retries = 30, delay = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else if (attempts < retries) {
          setTimeout(check, delay);
        } else {
          reject(new Error(`Backend health check failed after ${retries} attempts`));
        }
      });
      req.on('error', () => {
        if (attempts < retries) {
          setTimeout(check, delay);
        } else {
          reject(new Error(`Backend not reachable after ${retries} attempts`));
        }
      });
      req.end();
    };
    check();
  });
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.map': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml; charset=utf-8';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function startRendererServer(rendererRoot: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
        const requestedPath = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
        const filePath = path.normalize(path.join(rendererRoot, requestedPath));
        const relative = path.relative(rendererRoot, filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }

        fs.stat(filePath, (statErr, stat) => {
          if (statErr || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
          }
          res.writeHead(200, {
            'Content-Type': contentTypeFor(filePath),
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(filePath).pipe(res);
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad request');
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        server.close();
        reject(new Error('Could not bind renderer server'));
        return;
      }
      rendererServer = server;
      rendererPort = addr.port;
      console.log(`[main] Serving renderer on http://127.0.0.1:${rendererPort}`);
      resolve(addr.port);
    });
  });
}

function createWindow(): void {
  if (rendererPort === null) {
    throw new Error('Renderer server has not been started');
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'resmon',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      // Enable the <webview> tag so the About resmon → Blog tab can embed
      // the public GitHub Pages blog at https://ryanjosephkamp.github.io/resmon/
      // in a sandboxed sub-frame. The rendered <webview> is constrained to
      // that origin in the React component (see ``BlogTab.tsx``); navigations
      // to any other origin open in the user's default browser via
      // ``shell.openExternal`` rather than inside the embed.
      webviewTag: true,
      additionalArguments: [`--backend-port=${backendPort}`],
    },
  });

  // Defense-in-depth: when a <webview> attaches, scrub away node integration
  // and the preload script so the embedded blog page cannot reach the host
  // app's IPC bridge or filesystem. Also force ``contextIsolation`` on. The
  // origin allow-list is enforced one layer up (in BlogTab.tsx) by setting
  // ``webview.src`` only to the GitHub Pages blog URL.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, _params) => {
    delete (webPreferences as { preload?: string }).preload;
    (webPreferences as { nodeIntegration?: boolean }).nodeIntegration = false;
    (webPreferences as { contextIsolation?: boolean }).contextIsolation = true;
  });

  mainWindow.loadURL(`http://127.0.0.1:${rendererPort}/index.html`);

  // Open maximized by default (not full-screen) for a more spacious default
  // layout. Users can still un-maximize, resize, or close normally.
  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    // Attach-or-spawn: if the lock file points to a live daemon, attach.
    const lock = readLockFile();
    if (lock && (await pingHealth(lock.port, 500))) {
      backendPort = lock.port;
      attachedToDaemon = true;
      console.log(`[main] Attached to existing resmon-daemon on port ${backendPort} (pid=${lock.pid})`);
    } else {
      backendPort = await findFreePort();
      console.log(`[main] Starting backend on port ${backendPort}`);
      backendProcess = startBackend(backendPort);
      await waitForBackend(backendPort);
      console.log('[main] Backend is ready');
    }

    // IPC: choose a directory via native folder picker.
    ipcMain.handle('resmon:choose-directory', async (_evt, defaultPath?: string) => {
      const opts: Electron.OpenDialogOptions = {
        title: 'Select folder',
        properties: ['openDirectory', 'createDirectory'],
      };
      if (defaultPath) opts.defaultPath = defaultPath;
      const result = await dialog.showOpenDialog(
        mainWindow ?? (undefined as unknown as BrowserWindow),
        opts,
      );
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    });

    // IPC: open a filesystem path in the OS default handler, or an
    // http(s)/mailto URL in the user's default browser. ``shell.openPath``
    // is path-only; URLs require ``shell.openExternal``.
    ipcMain.handle('resmon:open-path', async (_evt, target: string) => {
      if (/^(https?|mailto):/i.test(target)) {
        await shell.openExternal(target);
        return '';
      }
      return shell.openPath(target);
    });

    // IPC: reveal a file in its parent folder, selecting it.
    ipcMain.handle('resmon:reveal-path', async (_evt, targetPath: string) => {
      shell.showItemInFolder(targetPath);
      return true;
    });

    // ---------------------------------------------------------------------
    // IPC: Cloud account sign-in / sign-out / refresh / status (IMPL-30).
    //
    // Per §§8.2–8.3 of resmon_routines_and_accounts.md, we open a modal
    // BrowserWindow pointing at the IdP's hosted sign-in URL (Clerk primary,
    // Supabase Auth fallback; URL supplied via the CLOUD_IDP_SIGN_IN_URL
    // env var so tests and CI can inject a fixture). A loopback HTTP server
    // listens on 127.0.0.1:<random>/auth/callback; when the IdP redirects
    // there with ``refresh_token``, ``access_token``, ``email``, and
    // ``expires_in`` query params, we POST the refresh token + email to the
    // local daemon (which persists the refresh token to the OS keyring via
    // the Python `keyring` bridge at service=``resmon``,
    // account=``cloud_refresh_token``), then resolve the IPC call with the
    // access token so the renderer can hold it in memory only.
    // ---------------------------------------------------------------------

    function postJson(pathname: string, body: unknown): Promise<any> {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? '' : JSON.stringify(body);
        const req = http.request(
          {
            host: '127.0.0.1',
            port: backendPort,
            path: pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
              if ((res.statusCode ?? 0) >= 400) {
                reject(new Error(`${res.statusCode}: ${data}`));
              } else {
                try { resolve(JSON.parse(data || '{}')); }
                catch (e) { reject(e); }
              }
            });
          },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    }

    function httpMethod(method: 'GET' | 'DELETE', pathname: string): Promise<any> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: backendPort, path: pathname, method },
          (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
              if ((res.statusCode ?? 0) >= 400) {
                reject(new Error(`${res.statusCode}: ${data}`));
              } else {
                try { resolve(JSON.parse(data || '{}')); }
                catch (e) { reject(e); }
              }
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
    }

    interface CallbackQuery {
      refresh_token?: string;
      access_token?: string;
      email?: string;
      expires_in?: string;
      error?: string;
    }

    function startCallbackServer(): Promise<{
      port: number;
      once: Promise<CallbackQuery>;
      close: () => void;
    }> {
      return new Promise((resolve, reject) => {
        let resolveOnce: (q: CallbackQuery) => void = () => {};
        let rejectOnce: (e: Error) => void = () => {};
        const once = new Promise<CallbackQuery>((res, rej) => {
          resolveOnce = res; rejectOnce = rej;
        });
        const server = http.createServer((req, res) => {
          if (!req.url || !req.url.startsWith('/auth/callback')) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const q: CallbackQuery = {
            refresh_token: url.searchParams.get('refresh_token') ?? undefined,
            access_token: url.searchParams.get('access_token') ?? undefined,
            email: url.searchParams.get('email') ?? undefined,
            expires_in: url.searchParams.get('expires_in') ?? undefined,
            error: url.searchParams.get('error') ?? undefined,
          };
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(
            '<!doctype html><html><body style="font-family:system-ui;padding:2rem">' +
            '<h2>Signed in. You may close this window.</h2></body></html>',
          );
          if (q.error) rejectOnce(new Error(`IdP error: ${q.error}`));
          else resolveOnce(q);
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (!addr || typeof addr !== 'object') {
            server.close();
            reject(new Error('Could not bind callback server'));
            return;
          }
          resolve({
            port: addr.port,
            once,
            close: () => { try { server.close(); } catch { /* ignore */ } },
          });
        });
      });
    }

    ipcMain.handle('resmon:cloud-sign-in', async () => {
      const baseSignInUrl = process.env.CLOUD_IDP_SIGN_IN_URL;
      if (!baseSignInUrl) {
        throw new Error('CLOUD_IDP_SIGN_IN_URL is not configured');
      }
      const cb = await startCallbackServer();
      const redirectUri = `http://127.0.0.1:${cb.port}/auth/callback`;
      const url = new URL(baseSignInUrl);
      url.searchParams.set('redirect_uri', redirectUri);

      const modal = new BrowserWindow({
        parent: mainWindow ?? undefined,
        modal: true,
        width: 520,
        height: 720,
        title: 'resmon — Sign in',
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      try {
        await modal.loadURL(url.toString());
        const q = await cb.once;
        if (!q.refresh_token || !q.access_token) {
          throw new Error('IdP callback missing refresh_token or access_token');
        }
        await postJson('/api/cloud-auth/session', {
          refresh_token: q.refresh_token,
          email: q.email ?? '',
        });
        return {
          access_token: q.access_token,
          email: q.email ?? '',
          expires_in: q.expires_in ? Number(q.expires_in) : 900,
        };
      } finally {
        cb.close();
        if (!modal.isDestroyed()) modal.close();
      }
    });

    ipcMain.handle('resmon:cloud-sign-out', async () => {
      await httpMethod('DELETE', '/api/cloud-auth/session');
      return { signed_in: false };
    });

    ipcMain.handle('resmon:cloud-refresh', async () => {
      return postJson('/api/cloud-auth/refresh', {});
    });

    ipcMain.handle('resmon:cloud-status', async () => {
      return httpMethod('GET', '/api/cloud-auth/status');
    });

    ipcMain.handle(
      'resmon:cloud-sync-toggle',
      async (_evt, enabled: boolean) => {
        const res = await new Promise<any>((resolve, reject) => {
          const payload = JSON.stringify({ enabled });
          const req = http.request(
            {
              host: '127.0.0.1',
              port: backendPort,
              path: '/api/cloud-auth/sync',
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              },
            },
            (resp) => {
              let data = '';
              resp.on('data', (c) => { data += c; });
              resp.on('end', () => {
                try { resolve(JSON.parse(data || '{}')); }
                catch (e) { reject(e); }
              });
            },
          );
          req.on('error', reject);
          req.write(payload);
          req.end();
        });
        return res;
      },
    );

    const rendererRoot = path.join(__dirname, '..', 'renderer');
    await startRendererServer(rendererRoot);
    createWindow();
  } catch (err) {
    console.error('[main] Failed to start:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (backendProcess && !attachedToDaemon) {
    backendProcess.kill();
    backendProcess = null;
  }
  app.quit();
});

app.on('before-quit', () => {
  if (backendProcess && !attachedToDaemon) {
    backendProcess.kill();
    backendProcess = null;
  }
});
