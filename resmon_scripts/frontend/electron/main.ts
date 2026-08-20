import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
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

interface HealthPayload {
  status?: string;
  version?: string;
  pid?: number;
}

/** GET /api/health with a hard timeout. Resolves the parsed payload on 200, null otherwise. */
function fetchHealth(port: number, timeoutMs: number = 3000): Promise<HealthPayload | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as HealthPayload);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}


/**
 * Update 4 / Fix C — Attempt to attach to a running resmon-daemon by
 * reading the lock file and probing its health endpoint, retrying a
 * bounded number of times before giving up. Returns the daemon's port
 * on success or ``null`` if no live daemon was found.
 *
 * Why this exists: when launchd is mid-bootstrap (e.g., right after a
 * Danger-Zone reset followed by re-enabling background execution), the
 * lock file is rewritten before the FastAPI app finishes binding its
 * port, so a single 500 ms probe times out and the previous code
 * silently spawned a competing backend. That second backend would
 * register its own APScheduler against the same SQLite jobstore,
 * causing every fire to be logged as "missed" by the daemon's grace
 * window. Retrying with a longer per-attempt timeout closes that race.
 *
 * The daemon must also be the SAME VERSION as this app. Attaching across
 * versions is how the first installed 1.5.0 app ended up talking to a
 * 1.2.1 daemon: health answered 200, the attach succeeded, and every
 * page the old backend had never heard of (Analytics, Explorer) rendered
 * a 404 while the status bar said "Online". A version-mismatched daemon
 * is treated exactly like no daemon at all — the app spawns its own
 * bundled backend on a free port and leaves the daemon alone.
 */
async function tryAttachToDaemon(
  attempts: number = 3,
  perAttemptTimeoutMs: number = 1500,
  backoffMs: number = 250,
): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    const lock = readLockFile();
    if (lock) {
      const health = await fetchHealth(lock.port, perAttemptTimeoutMs);
      if (health) {
        // Trust the live process over the lock file for the version.
        const daemonVersion = health.version ?? lock.version ?? 'unknown';
        if (daemonVersion !== app.getVersion()) {
          console.warn(
            `[main] Daemon on port ${lock.port} is v${daemonVersion}, this app ` +
            `is v${app.getVersion()} — not attaching. Spawning the bundled backend instead.`,
          );
          return null;
        }
        console.log(
          `[main] Attached to existing resmon-daemon on port ${lock.port} ` +
          `(pid=${lock.pid}, v${daemonVersion}, attempt=${i + 1}/${attempts})`,
        );
        return lock.port;
      }
    }
    if (i + 1 < attempts) {
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  return null;
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
  // Where the Python backend lives depends on whether we are running from a
  // checkout or from an installed .app.
  //
  //   development  frontend/dist/electron/  ->  ../../..  ->  resmon_scripts/
  //   packaged     Contents/Resources/backend/resmon_scripts/
  //
  // The packaged copy ships its own virtual environment beside it, so an
  // installed resmon does not depend on what Python the machine happens to
  // have, or on the user ever having run pip.
  const scriptDir = app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'resmon_scripts')
    : path.resolve(__dirname, '..', '..', '..');
  const resmonScript = path.join(scriptDir, 'resmon.py');
  // Windows venvs keep the interpreter in Scripts\python.exe; POSIX in bin/.
  const bundledPython = process.platform === 'win32'
    ? path.join(process.resourcesPath, 'backend', 'venv', 'Scripts', 'python.exe')
    : path.join(process.resourcesPath, 'backend', 'venv', 'bin', 'python3');
  const systemPython = process.platform === 'win32' ? 'python' : 'python3';
  const pythonPath =
    process.env.RESMON_PYTHON ||
    (app.isPackaged && fs.existsSync(bundledPython) ? bundledPython : systemPython);

  // Update 4 / Fix D — A renderer-spawned fallback backend must NOT own
  // a ResmonScheduler. The launchd daemon is the sole scheduler owner;
  // letting both processes register jobs against the same SQLite
  // jobstore causes the dual-scheduler race that drops fires when the
  // app closes (the renderer-owned scheduler dies without a clean
  // shutdown, leaving its in-flight jobs orphaned). The FastAPI startup
  // hook in resmon.py honors this env var by skipping scheduler
  // instantiation entirely; CRUD endpoints already no-op when
  // ``scheduler is None``.
  // A packaged app must not keep state inside its own bundle: the bundle is
  // replaced wholesale on update, and Gatekeeper's app translocation can run
  // a quarantined app from a read-only location. Point the backend at the
  // same per-user state directory the daemon lock file lives in.
  const backendEnv: NodeJS.ProcessEnv = {
    ...process.env,
    RESMON_DISABLE_SCHEDULER: '1',
  };
  if (app.isPackaged) {
    const state = stateDir();
    fs.mkdirSync(state, { recursive: true });
    backendEnv.RESMON_DB_PATH = backendEnv.RESMON_DB_PATH
      || path.join(state, 'resmon.db');
    backendEnv.RESMON_REPORTS_DIR = backendEnv.RESMON_REPORTS_DIR
      || path.join(state, 'resmon_reports');
  }

  const child = spawn(pythonPath, [resmonScript, String(port)], {
    cwd: scriptDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: backendEnv,
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
      // webSecurity stays ON. It used to be disabled, from a time when the
      // renderer was loaded over file:// and could not make cross-origin
      // requests to the backend. The renderer is now served by a local HTTP
      // server (startRendererServer below), so it has an ordinary
      // http://127.0.0.1:<port> origin, and the backend answers with
      // Access-Control-Allow-Origin: * plus Access-Control-Allow-Private-Network
      // on both simple and preflight requests. Disabling the same-origin policy
      // for the whole window bought nothing and cost real protection.
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

// ---------------------------------------------------------------------------
// Auto-update (Windows and Linux only, Master Plan 1.6).
//
// macOS is deliberately excluded: Squirrel.Mac validates the code signature
// before applying an update, and signing is deferred — an unsigned macOS app
// cannot self-update, full stop. The platform gate below is what turns back
// on the day enrolment happens; nothing else needs to change.
//
// Update source is the public GitHub Releases feed baked into app-update.yml
// at build time (build.publish in package.json). Checks run shortly after
// launch and every six hours; the download happens in the background, and
// the user chooses restart-now or on-next-quit. Failed checks are logged and
// never surfaced — a laptop being offline is not an event.
// ---------------------------------------------------------------------------

function initAutoUpdater(): void {
  if (!app.isPackaged) return;
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  // A Linux user running the extracted filesystem instead of the AppImage
  // has nothing the updater can replace; electron-updater errors on the
  // missing APPIMAGE env var, which the error handler below absorbs.

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err instanceof Error ? err.message : String(err));
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = info?.version ? `resmon ${info.version}` : 'A new version of resmon';
    void dialog
      .showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: `${version} has been downloaded.`,
        detail: 'Restart now to apply it, or keep working — it installs on next quit.',
        buttons: ['Restart now', 'On next quit'],
        defaultId: 1,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      console.warn('[updater] check failed:', err instanceof Error ? err.message : String(err));
    });
  };
  // Let startup finish first; the check is never on the critical path.
  setTimeout(check, 15_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

app.whenReady().then(async () => {
  try {
    // Attach-or-spawn: if the lock file points to a live daemon, attach.
    // Update 4 / Fix C — retry with a longer per-attempt timeout so a
    // launchd-respawn-in-progress (lock file rewritten but FastAPI not
    // yet bound) does not cause a single-shot 500 ms probe to time out
    // and trigger a competing-backend spawn.
    const attachedPort = await tryAttachToDaemon();
    if (attachedPort !== null) {
      backendPort = attachedPort;
      attachedToDaemon = true;
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

    const rendererRoot = path.join(__dirname, '..', 'renderer');
    await startRendererServer(rendererRoot);
    createWindow();
    initAutoUpdater();
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
