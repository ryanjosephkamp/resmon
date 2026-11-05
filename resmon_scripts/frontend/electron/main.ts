import { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, nativeTheme, screen, shell, systemPreferences } from 'electron';
import { installDownloads } from './downloads';
import { libraryRemovedFile } from './libraryTrash';
import {
  installCommandLine, refreshInstalledArchive, systemContext, uninstallCommandLine, type Outcome,
} from './commandLineInstall';
import {
  appExecutable, engineFlags, isServiceLaunch, opensWindowFor, routeForNotice, servicePort, startNoticeListener,
  type Notice, type NoticeListener,
} from './host';
import {
  START_WAIT_MS, disabledIn, ensureService, pidFromPrint, temporaryPlace, unitFromPlist,
  type Facts, type Running, type Unit, type World,
} from './service';
import {
  RunOwners, TabsMode, WindowSet, cascade, cleanRoute, noticeWindow, routeOf, tabStripHeight, type CollectionId,
} from './windows';
import { autoUpdater } from 'electron-updater';
import { ChildProcess, execFile, execFileSync, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/**
 * True when this run must put its windows up without taking the foreground.
 *
 * The automated suites launch the real app dozens of times in a sitting, and
 * every launch pulled the keyboard away from whatever the person at the machine
 * was doing — they had to click back, or wait for the window to close. That is
 * the only thing this flag is for.
 *
 * It is a *launch* flag, not a behaviour flag. The same windows open, at the
 * same size, with the same contents, in the same order; only the activation
 * changes. With the variable unset every branch it gates takes the path it took
 * before the flag existed, which is the same contract `isE2E()` carries.
 *
 * Declared here rather than beside `isE2E()` because the activation policy
 * below has to be applied at module scope — see `setActivationPolicy`.
 */
function isBackgroundWindow(): boolean {
  return process.env.RESMON_BACKGROUND_WINDOW === '1';
}

/**
 * True when this run must put no window on the screen at all.
 *
 * `RESMON_BACKGROUND_WINDOW` stops the *foreground grab*, and that is all it
 * stops: `showInactive()` still shows the window. Measured on this Mac with
 * `CGWindowListCopyWindowInfo` (the on-screen list, desktop elements excluded),
 * attributing each window to the launched process's own subtree by pid:
 *
 *   showInactive()   1 on-screen window, bounds 144,109 1440x900
 *   never shown      0 on-screen windows
 *
 * So a flagged run still covered whatever the person at the machine was
 * looking at. This flag is the other half of the complaint: the window is
 * created and loaded exactly as before and the renderer runs, but `show()` is
 * never called, so the window never reaches the screen.
 *
 * **Positioning the window off the displays was measured and does not work.**
 * macOS constrains a window to keep part of it reachable: `setPosition(30000,
 * 30000)` on a 1728x1117 display left the window at 1688,1085 — a 40x32 pixel
 * corner still in the on-screen list. That is why this flag hides rather than
 * moves.
 *
 * The risk this carries is Chromium's background throttling, and it was
 * measured rather than assumed. A never-shown window on this Electron ran 366
 * `requestAnimationFrame` callbacks and 187 16 ms timer ticks in three
 * seconds, against 364 and 188 for a shown one, and reported
 * `document.visibilityState === 'visible'`. `backgroundThrottling: false`
 * changed nothing (363 frames), so this flag does not touch `webPreferences`.
 * That is one machine and one Electron; see the pull request.
 *
 * Unlike `isBackgroundWindow()`, this *is* a behaviour flag and it is named as
 * one: a suite running under it cannot see anything that needs a window on a
 * screen. The one CI job whose subject is the window is held off it by
 * `e2e/background-window.ts`, which throws rather than letting that job quietly
 * stop asserting.
 */
function isHiddenWindow(): boolean {
  return process.env.RESMON_HIDDEN_WINDOW === '1';
}

// Keep the app out of the Dock, on macOS, when launched in background mode.
//
// **This is not the line that stops the foreground grab — `showInactive()` is.**
// That is worth stating plainly, because the obvious guess is the other way
// round and acting on it would drop the half that works. Four launches from a
// frontmost shell, reading the frontmost application's ASN from inside the
// process before and after the window went up, measured each half alone:
//
//   show() + no policy      foreground TAKEN   window focused   Dock icon
//   showInactive() only     foreground kept    not focused      Dock icon
//   show() + accessory      foreground TAKEN   window focused   no Dock icon
//   both (what ships)       foreground kept    not focused      no Dock icon
//
// So `accessory` on its own changes nothing about focus. It earns its place for
// the second half of the problem rather than the first: a suite run does not
// put an icon in the Dock or take over the menu bar, which is what made a run
// feel like another app had opened even when it had not stolen the keyboard.
//
// Applied at module scope rather than inside `app.whenReady()`, and that is a
// measured choice rather than a cautious one: from inside `whenReady()` the
// Dock icon appears and is then removed, so a run flickers an icon into the
// Dock on the way past. At module scope the policy is in effect before any
// window exists and the icon never appears at all. Guarded because the policy
// is macOS-only and the method does not exist elsewhere.
if (isBackgroundWindow() && process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
}

/**
 * True when this launch is the background service (`host.ts` says what that
 * is). Read once: the service and a window launch differ from the first line
 * of `whenReady` on.
 */
const SERVICE = isServiceLaunch(process.argv, process.env);

/**
 * Which build this is. Every build of a version gives the same version, so a
 * build is named by what the packager recorded of the app's code: on a Mac the
 * hash of app.asar that electron-builder writes into Info.plist
 * (`ElectronAsarIntegrity`), elsewhere app.asar's size and time. The engines
 * this app starts carry it in their lock and health (`setAppExecutable`), which
 * is how a launch tells this build's service from another's (`service.ts`).
 */
function buildId(): string {
  const version = app.getVersion();
  if (!app.isPackaged) return `${version}+checkout`;
  try {
    if (process.platform === 'darwin') {
      const plist = fs.readFileSync(path.join(process.resourcesPath, '..', 'Info.plist'), 'utf8');
      const found = /<key>ElectronAsarIntegrity<\/key>[\s\S]*?<key>hash<\/key>\s*<string>([0-9a-f]{16,})<\/string>/.exec(plist);
      if (found?.[1]) return `${version}+${found[1].slice(0, 20)}`;
    }
    const asar = fs.statSync(path.join(process.resourcesPath, 'app.asar'));
    return `${version}+${asar.size.toString(36)}.${Math.round(asar.mtimeMs).toString(36)}`;
  } catch {
    return `${version}+unknown`;
  }
}
const BUILD_ID = buildId();

// The service has no window until one is asked for, so no Dock icon and no
// menu bar either; opening a window gives it both (`showWindow`). Module
// scope for the reason given above for background windows: from `whenReady`
// the icon flickers into the Dock first.
if (SERVICE && process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
}

// One resmon per profile. A second launch while one runs hands over and quits:
// to a service, it is a request for a window on the engine that is already
// running (`second-instance` below), which is what makes the window and the
// service one process. A service that starts while a window launched on its own
// holds the profile has nothing to add and exits 0. launchd's KeepAlive starts
// it again every ten seconds, so once that window quits the service takes over
// within ten seconds; systemd and Task Scheduler restart it only on failure, so
// there it starts at the next login.
//
// An instance under test names its own state directory; its Chromium profile
// goes inside it unless the launch names one, so a test instance can never
// share a lock, or anything else in the profile, with the resmon a person runs.
if (process.env.RESMON_STATE_DIR && !process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  app.setPath('userData', path.join(process.env.RESMON_STATE_DIR, 'electron-user-data'));
}
const SOLE_INSTANCE = app.requestSingleInstanceLock();

/**
 * Whether this launch makes sure of the background service before it opens
 * (`service.ts`): a window launch of the packaged app on a Mac, once. A launch
 * the check started again to hand over (`RESMON_SERVICE_CHECKED`) does not
 * check again. `RESMON_SERVICE_AT_LAUNCH=1` turns it on for a checkout, which
 * a test does with a label and a launchctl of its own.
 */
const CHECKS_SERVICE = !SERVICE && process.platform === 'darwin'
  && (app.isPackaged || process.env.RESMON_SERVICE_AT_LAUNCH === '1')
  && process.env.RESMON_SERVICE_CHECKED !== '1';

if (!SOLE_INSTANCE && !CHECKS_SERVICE) {
  // `quit`, the pattern Electron documents for a launch that did not get the
  // lock: the app's normal quit path, which exits 0.
  app.quit();
}


/**
 * The app's own windows (`windows.ts`): every one shows the renderer, on the
 * same engine. Link windows and the window that says resmon is starting are
 * not among them.
 */
const appWindows = new WindowSet<BrowserWindow>();
/** Which window started each run, so the run's notification shows it there. */
const runOwners = new RunOwners();
/** Whether the windows are in macOS's tabs, and so leave room for the tab bar. */
const tabsMode = new TabsMode();
let backendProcess: ChildProcess | null = null;
// Null until attach-or-spawn has settled which backend this app is using. It
// was initialised to the daemon's port, which meant any read before that point
// — the backend-connection IPC is the one that matters — handed the renderer a
// port nothing had chosen. The window is only created after this is set, so the
// null is unreachable in a normal start; it is here so that a start which goes
// wrong cannot answer with a guess.
let backendPort: number | null = null;
let rendererServer: http.Server | null = null;
let rendererPort: number | null = null;
/** True when we attached to an already-running daemon and must not kill it on quit. */
let attachedToDaemon: boolean = false;
/**
 * The backend's local API token. Minted here for a backend this
 * process spawns; read from the daemon's owner-only token file when attaching.
 * It reaches the backend through the child's environment and the renderer
 * through the preload's synchronous IPC — never argv (world-readable in `ps`),
 * never a URL, never a log line.
 */
let backendToken: string | null = null;
/** The renderer's origin, once its server is bound; a service opens windows later. */
let rendererOriginValue: string | null = null;
/** Where the engine sends notifications, when this app started the engine. */
let noticeListener: NoticeListener | null = null;
/**
 * Notifications on screen. Held so they are not collected before they are
 * clicked: a collected `Notification` drops its click handler.
 */
const liveNotices = new Set<Notification>();
/** True once quitting has begun, so the engine exiting is expected, not a failure. */
let quitting = false;

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

/** 32 bytes from the OS CSPRNG, URL-safe base64: the shape `api_auth.valid_token` accepts. */
function mintToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * The token a backend on `port` published beside the daemon lock, or null.
 * Mirrors `api_auth.token_file`/`read_token_file`: `<state dir>/api-token-<port>`.
 */
function readTokenFile(port: number): string | null {
  try {
    const text = fs.readFileSync(path.join(stateDir(), `api-token-${port}`), 'ascii').trim();
    return /^[A-Za-z0-9_-]{43,128}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

interface LockPayload {
  pid: number;
  port: number;
  version: string;
  build?: string | null;
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
  build?: string | null;
  pid?: number;
}

/** GET /api/health with a hard timeout. Resolves the parsed payload on 200, null otherwise. */
function fetchHealth(port: number, token: string, timeoutMs: number = 3000): Promise<HealthPayload | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs, headers: bearer(token) },
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
 * Tell an attached daemon the exact origin of this window's renderer.
 *
 * The daemon starts under launchd before any window exists, so unlike a backend
 * this process spawns it cannot be told the origin in its environment — and
 * "any loopback origin" is not trusted by the Library guard. Sent from here,
 * with the token and without an Origin header, which is the only way the
 * backend accepts it.
 */
function registerRendererOrigin(port: number, token: string, origin: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ origin });
    const req = http.request(
      {
        host: '127.0.0.1', port, method: 'POST', path: '/api/auth/renderer-origin', timeout: timeoutMs,
        headers: { ...bearer(token), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end(body);
  });
}


/**
 * Attempt to attach to a running resmon-daemon by
 * reading the lock file and probing its health endpoint, retrying a
 * bounded number of times before giving up. Returns the daemon's port
 * on success or ``null`` if no live daemon was found.
 *
 * Why this exists: when launchd is mid-bootstrap (e.g., right after a
 * Danger-Zone reset followed by re-enabling background execution), the
 * lock file is rewritten before the FastAPI app finishes binding its
 * port, so a single 500 ms probe would time out and the app would
 * silently spawn a competing backend. That second backend would
 * register its own APScheduler against the same SQLite jobstore,
 * causing every fire to be logged as "missed" by the daemon's grace
 * window. Retrying with a longer per-attempt timeout closes that race.
 *
 * The daemon must also be the SAME VERSION as this app. Attaching across
 * versions would leave an app talking to a daemon that does not know its
 * routes: health answers 200, the attach succeeds, and every page the
 * older backend has never heard of renders a 404 while the status bar
 * says "Online". A version-mismatched daemon
 * is treated exactly like no daemon at all — the app spawns its own
 * bundled backend on a free port and leaves the daemon alone.
 */
async function tryAttachToDaemon(
  rendererOrigin: string,
  attempts: number = 3,
  perAttemptTimeoutMs: number = 1500,
  backoffMs: number = 250,
): Promise<{ port: number; token: string } | null> {
  for (let i = 0; i < attempts; i++) {
    const lock = readLockFile();
    if (lock) {
      // A daemon with no token file is treated exactly like a
      // version-mismatched one — never probed, never attached to. It is either
      // a daemon that publishes no token or one whose file this user cannot
      // read, and in both cases the app spawns its own backend and leaves the
      // daemon alone. It is retried like an unanswered probe, because a daemon
      // mid-start writes its lock a moment before its token file.
      const token = readTokenFile(lock.port);
      if (!token) {
        console.warn(`[main] Daemon on port ${lock.port} has published no API token (attempt ${i + 1}/${attempts}).`);
      }
      const health = token ? await fetchHealth(lock.port, token, perAttemptTimeoutMs) : null;
      if (token && health) {
        // Trust the live process over the lock file for the version.
        const daemonVersion = health.version ?? lock.version ?? 'unknown';
        if (daemonVersion !== app.getVersion()) {
          console.warn(
            `[main] Daemon on port ${lock.port} is v${daemonVersion}, this app ` +
            `is v${app.getVersion()} — not attaching. Spawning the bundled backend instead.`,
          );
          return null;
        }
        if (!(await registerRendererOrigin(lock.port, token, rendererOrigin))) {
          console.warn(`[main] Daemon on port ${lock.port} did not accept this window's origin — not attaching.`);
          return null;
        }
        console.log(
          `[main] Attached to existing resmon-daemon on port ${lock.port} ` +
          `(pid=${lock.pid}, v${daemonVersion}, attempt=${i + 1}/${attempts})`,
        );
        return { port: lock.port, token };
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

/**
 * The command, argv and environment a spawned backend gets.
 *
 * Separate from `startBackend` so the one property that matters most here —
 * the token is in `env` and not in `args` — is a fact about a value that can be
 * inspected, rather than about a call that already happened.
 */
function backendSpawnSpec(
  pythonPath: string, resmonScript: string, port: number, token: string, rendererOrigin: string,
  baseEnv: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: pythonPath,
    args: [resmonScript, String(port)],
    env: { ...baseEnv, RESMON_API_TOKEN: token, RESMON_RENDERER_ORIGIN: rendererOrigin },
  };
}

/**
 * Stop the engine this window started and wait for it to exit (20 s, then it
 * is killed), so the next start finds the database, the port, and the lock
 * free. An engine this window only attached to is the service's, and is left.
 */
function stopOwnBackend(): Promise<void> {
  const engine = backendProcess;
  if (!engine || attachedToDaemon || engine.exitCode !== null || engine.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const deadline = setTimeout(() => engine.kill('SIGKILL'), 20_000);
    engine.once('exit', () => {
      clearTimeout(deadline);
      if (backendProcess === engine) backendProcess = null;
      resolve();
    });
    engine.kill('SIGTERM');
  });
}

/**
 * Tell an engine this app starts which executable runs this app, or that none
 * does, and which build this is, which the engine puts in its lock and health
 * so a launch can tell this build's service from another's.
 */
function setAppExecutable(env: NodeJS.ProcessEnv): void {
  const executable = appExecutable(process.platform, process.execPath, app.isPackaged);
  if (executable) env.RESMON_APP_EXECUTABLE = executable;
  else delete env.RESMON_APP_EXECUTABLE;
  env.RESMON_BUILD_ID = BUILD_ID;
}

/** Spawn the Python backend and return the child process. */
function startBackend(port: number, token: string, rendererOrigin: string): ChildProcess {
  const { scriptDir, pythonPath } = backendLocation();
  const resmonScript = path.join(scriptDir, 'resmon.py');
  // A renderer-spawned fallback backend must NOT own
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
    // The bundle's bytecode was compiled when it was built. Writing more into
    // it would edit the app, which breaks its signature once it is signed.
    backendEnv.PYTHONDONTWRITEBYTECODE = '1';
  }
  // A service unit that this engine installs runs the app, so the engine is
  // told which executable that is. Never inherited from the shell that started
  // this app: only this app knows its own path.
  setAppExecutable(backendEnv);

  // The app posts this backend's notifications as resmon, as it does the
  // service's (`postNotice`), rather than the backend posting them through a
  // tool macOS credits to Script Editor.
  if (noticeListener) {
    backendEnv.RESMON_HOST_NOTIFY_URL = noticeListener.url;
    backendEnv.RESMON_HOST_NOTIFY_TOKEN = noticeListener.token;
  }
  const spec = backendSpawnSpec(pythonPath, resmonScript, port, token, rendererOrigin, backendEnv);
  const child = spawn(spec.command, spec.args, {
    cwd: scriptDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: spec.env,
    // The engine is a console program; without this Windows opens a console
    // window for it.
    windowsHide: true,
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

/** Where the Python backend and the interpreter to run it with live. */
function backendLocation(): { scriptDir: string; pythonPath: string } {
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
  // The standalone runtime keeps the interpreter at python/python.exe on
  // Windows and python/bin/python3 elsewhere.
  const bundledPython = process.platform === 'win32'
    ? path.join(process.resourcesPath, 'backend', 'python', 'python.exe')
    : path.join(process.resourcesPath, 'backend', 'python', 'bin', 'python3');
  const systemPython = process.platform === 'win32' ? 'python' : 'python3';
  const pythonPath =
    process.env.RESMON_PYTHON ||
    (app.isPackaged && fs.existsSync(bundledPython) ? bundledPython : systemPython);
  return { scriptDir, pythonPath };
}

/**
 * Start the engine as the background service's own.
 *
 * The service's own entry point, `implementation_scripts.daemon`,
 * so everything that makes it the service holds: it owns the
 * scheduler, takes the daemon lock, writes the token file the MCP server and
 * the CLI read, and shuts down cooperatively on SIGTERM. It is
 * this app's child, given this app's token and the address of its notice
 * listener, so its notifications are posted by the app.
 *
 * Its output is this process's output: under a unit that is the unit's log
 * files, which the engine rotates by reading the path behind the descriptor
 * (`service_log`), so the logs stay where they were and stay bounded.
 */
function startServiceEngine(port: number, token: string, rendererOrigin: string): ChildProcess {
  const { scriptDir, pythonPath } = backendLocation();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The unit set PYTHONPATH to the backend's directory; that comes first, and
    // a path the environment already carries is kept after it.
    PYTHONPATH: [scriptDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    RESMON_API_TOKEN: token,
    RESMON_RENDERER_ORIGIN: rendererOrigin,
  };
  // The service is the one scheduler; a variable inherited from a shell that
  // turned it off would leave every routine unfired with nothing to say so.
  delete env.RESMON_DISABLE_SCHEDULER;
  if (app.isPackaged) {
    const state = stateDir();
    fs.mkdirSync(state, { recursive: true });
    env.RESMON_DB_PATH = env.RESMON_DB_PATH || path.join(state, 'resmon.db');
    env.RESMON_REPORTS_DIR = env.RESMON_REPORTS_DIR || path.join(state, 'resmon_reports');
    // See `startBackend`: the packaged bundle is never written to.
    env.PYTHONDONTWRITEBYTECODE = '1';
  }
  setAppExecutable(env);
  if (noticeListener) {
    env.RESMON_HOST_NOTIFY_URL = noticeListener.url;
    env.RESMON_HOST_NOTIFY_TOKEN = noticeListener.token;
  }
  const daemonArgs = ['-m', 'implementation_scripts.daemon', String(port), ...engineFlags(process.argv)];
  const child = spawn(pythonPath, daemonArgs, {
    cwd: scriptDir,
    stdio: ['ignore', 'inherit', 'inherit'],
    env,
    windowsHide: true,
  });
  child.on('exit', (code, signal) => {
    backendProcess = null;
    if (quitting) return;
    // The engine is the service. Without it this process is a listener with
    // nothing to listen to, so it goes too, and fails, so that a unit that
    // restarts on failure starts both again.
    console.error(`[main] The engine exited (code ${code}, signal ${signal}); the service is stopping.`);
    app.exit(1);
  });
  return child;
}

/**
 * Post a notification the engine sent, as resmon. Clicking it opens the run,
 * in the window that started it while that window is open, else in the window
 * in front (`noticeWindow`); a window is made only when none is open.
 *
 * Under the e2e suites, and under the performance harness
 * (`RESMON_NOTICES_TO_LOG`), nothing is put on the screen of the person at the
 * Mac: the notice is written to the log, as a line a spec can read, with the
 * window a click would show it in and the window focused then, and the answer
 * to the engine is the same as for a posted one.
 */
function postNotice(notice: Notice): boolean {
  // The OS shows the app's name on every notification it posts; a title that
  // starts with it says it twice.
  const title = notice.title.replace(/^resmon:\s*/i, '') || 'resmon';
  if (isE2E() || process.env.RESMON_NOTICES_TO_LOG === '1') {
    void settleNotice(notice.executionId).then(() => {
      const shownIn = noticeWindow(appWindows, runOwners, notice.executionId, BrowserWindow.getFocusedWindow());
      const focused = BrowserWindow.getFocusedWindow()?.id ?? null;
      console.log(`[main] notice ${JSON.stringify({ title, body: notice.body, executionId: notice.executionId, window: shownIn?.id ?? null, focused })}`);
    });
    return true;
  }
  // Settled now, while the notice is fresh, so a click needs no read of its own.
  void settleNotice(notice.executionId);
  if (!Notification.isSupported()) return false;
  const shown = new Notification({ title, body: notice.body });
  // A long-lived service must not keep every notification it ever posted.
  if (liveNotices.size >= 50) liveNotices.delete(liveNotices.values().next().value as Notification);
  liveNotices.add(shown);
  shown.on('click', () => {
    liveNotices.delete(shown);
    void showWindow(routeForNotice(notice), notice.executionId);
  });
  shown.on('close', () => liveNotices.delete(shown));
  // The OS took it: the one fact about the screen this process can know.
  shown.on('show', () => console.log(`[main] Notification shown (run ${notice.executionId ?? 'none'})`));
  shown.on('failed', (_event, error) => {
    liveNotices.delete(shown);
    console.error(`[main] A notification could not be shown: ${error}`);
  });
  shown.show();
  return true;
}

/**
 * Bring a window up at `route`, creating one only when none is open.
 *
 * A window launch has one from the start; the service makes one when it is
 * asked to (a second launch of resmon, the Dock icon, a notification clicked)
 * and takes the Dock icon and menu bar back while it is open. With windows
 * open, the one brought up is the one that started the run a notification is
 * about, else the one in front, else the one focused last: a second launch or a
 * notification never opens another window beside them.
 */
async function showWindow(route: string | null, executionId: number | null = null): Promise<void> {
  await settleNotice(executionId);
  const window = noticeWindow(appWindows, runOwners, executionId, BrowserWindow.getFocusedWindow());
  if (window) {
    if (route) {
      await window.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(`#${route}`)};`);
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  await openAppWindow(route);
}

/**
 * A run no window claimed, while a window waits for a run it queued: read the
 * run's row, whose `request_id` is the queued run's ticket (`RunOwners`).
 * Never throws; a row that cannot be read leaves the run to the window in front.
 */
async function settleNotice(executionId: number | null): Promise<void> {
  if (!runOwners.unsettled(executionId) || backendPort === null || backendToken === null) return;
  const row = await readRun(backendPort, backendToken, executionId);
  if (row) runOwners.settle(executionId, row);
}

/** One run's row, `GET /api/executions/{id}`, or null when it does not answer. */
function readRun(port: number, token: string, id: number): Promise<{ request_id?: unknown; routine_id?: unknown } | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: `/api/executions/${id}`, timeout: 3_000, headers: bearer(token) },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(body) as { request_id?: unknown; routine_id?: unknown } : null);
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

/** How a new window opens: beside the window it was asked from, or as a tab of it, and on which collection. */
interface Opening {
  /** The window it was asked from, which it opens one step down and to the right of. */
  from?: BrowserWindow | null;
  /** On macOS, the window whose tabs it joins. */
  tabOf?: BrowserWindow | null;
  collection?: CollectionId;
}

/**
 * Open another window on the engine, at `route` or the start page. Nothing
 * opens while the engine is still starting: there is nothing to show yet.
 */
async function openAppWindow(route: string | null, how: Opening = {}): Promise<BrowserWindow | null> {
  if (backendPort === null || backendToken === null || rendererOriginValue === null) return null;
  // Window tabs are macOS's; elsewhere a tab asked for is a window beside the one it was asked from.
  if (how.tabOf && process.platform !== 'darwin') how = { from: how.tabOf, collection: how.collection };
  if (SERVICE && process.platform === 'darwin') app.setActivationPolicy('regular');
  return createWindow(await atlasGround(backendPort, backendToken), route, how);
}

/** The app window a menu item, a key, or the tab bar acted on: the one in front, or the one focused last. */
function actedOn(window: unknown): BrowserWindow | null {
  return appWindows.target(window ?? BrowserWindow.getFocusedWindow());
}

/**
 * New Tab (⌘T), and the tab bar's new-tab button: a window at the start page,
 * in `host`'s tabs. Off macOS, where there are no window tabs, a new window.
 */
async function openTab(host: BrowserWindow | null): Promise<void> {
  if (process.platform !== 'darwin' || !host) {
    await openAppWindow(null, { from: host });
    return;
  }
  await openAppWindow(null, { tabOf: host });
}

/**
 * Merge All Windows: every window into the tabs of the one in front. Done a
 * window at a time rather than through macOS's own merge, which acts only on
 * the key window, and an app that is not active has none.
 */
function mergeAllWindows(host: BrowserWindow | null): void {
  if (!host || process.platform !== 'darwin') return;
  tabsMode.use();
  for (const window of appWindows.all()) if (window !== host) host.addTabbedWindow(window);
  windowsChanged();
}

/** What a window's renderer is told about itself: its collection, and the room to leave for the tab bar. */
function windowState(window: BrowserWindow): { collection: CollectionId; tabStrip: number } {
  return {
    collection: appWindows.collectionOf(window),
    tabStrip: tabStripHeight(process.platform, process.getSystemVersion(), tabsMode.active),
  };
}

/**
 * The windows or their tabs changed: tell every window, set each title again
 * so macOS lays out its tab bar in the title bar's row (`tabStripHeight`), and
 * write the Window menu's Show Tab Bar or Hide Tab Bar.
 */
function windowsChanged(): void {
  for (const window of appWindows.all()) {
    if (!window.webContents.isDestroyed()) window.webContents.send('resmon:window-state', windowState(window));
  }
  if (process.platform !== 'darwin') return;
  if (tabsMode.active) for (const window of appWindows.all()) relayTitle(window);
  installApplicationMenu();
}

/**
 * Set a window's title again, changed by a trailing space, which no tab or
 * menu shows. macOS lays out a window's tab bar in the title bar's own row
 * only once its title changes after it joined the tabs; until then the bar
 * sits in a second row, over the top of the page (measured on macOS 26).
 */
function relayTitle(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  const title = window.getTitle();
  window.setTitle(title.endsWith(' ') ? title.trimEnd() : `${title} `);
}

/**
 * How long an engine this app started is given to answer, while it runs. A
 * first start after an update migrates the database before it answers; the
 * 15 seconds once allowed ran out in the middle of that, and the engine was
 * stopped there.
 */
const ENGINE_START_LIMIT_MS = START_WAIT_MS;

/** Wait for an engine this app started to answer health, for as long as it runs, up to `limitMs`. */
async function waitForEngine(child: ChildProcess, port: number, token: string, limitMs = ENGINE_START_LIMIT_MS): Promise<void> {
  const started = Date.now();
  let said = false;
  for (;;) {
    if (await fetchHealth(port, token, 2_000)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The engine stopped (${child.exitCode ?? child.signalCode}) before it answered`);
    }
    const waited = Date.now() - started;
    if (waited > limitMs) throw new Error(`The engine did not answer within ${Math.round(limitMs / 1000)} s`);
    if (!said && waited > 15_000) {
      said = true;
      console.log('[main] The engine is still starting; a first start after an update brings the database up to date first.');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
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
    case '.woff2': return 'font/woff2';
    case '.woff': return 'font/woff';
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

/**
 * True when the app is being driven by the end-to-end suite.
 *
 * Everything this flag gates is *test determinism only* — never behaviour a
 * user could want, and never anything that changes what the app shows. With the
 * variable unset every branch below takes the path a person's launch takes;
 * `e2e/default-behaviour.spec.ts` is the check that says so by
 * launching the app without it and asserting the default behaviour.
 */
function isE2E(): boolean {
  return process.env.RESMON_E2E === '1';
}

/**
 * The ground the Atlas window opens on, from the theme the engine has stored,
 * with "system" resolved here. Read before the window exists, so its first
 * frame is already the right color; the renderer reads the same value before
 * its own first paint. An engine that does not answer within a second leaves
 * the system's theme, which is what the renderer falls back to as well. The
 * two grounds are `--ground` in `atlas/src/theme/tokens.css`.
 */
function atlasGround(port: number, token: string): Promise<string> {
  const ground = (dark: boolean) => (dark ? '#0a0a0b' : '#ffffff');
  return new Promise((resolve) => {
    const fallback = () => resolve(ground(nativeTheme.shouldUseDarkColors));
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/appearance', headers: bearer(token), timeout: 1000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          try {
            const theme = res.statusCode === 200 ? (JSON.parse(body) as { theme?: unknown }).theme : null;
            if (theme === 'dark' || theme === 'light') resolve(ground(theme === 'dark'));
            else fallback();
          } catch {
            fallback();
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', fallback);
  });
}

function createWindow(ground: string, route: string | null = null, how: Opening = {}): BrowserWindow {
  if (rendererPort === null) {
    throw new Error('Renderer server has not been started');
  }
  // A fixed window size under the e2e suite. A maximized window is a different
  // size on every machine and on CI it is whatever xvfb was told to be, so a
  // screenshot is only evidence if the viewport it was taken at is known. The
  // suite supplies the numbers rather than this file guessing them.
  const e2eSize = isE2E()
    ? {
      width: Number(process.env.RESMON_E2E_WIDTH) || 1440,
      height: Number(process.env.RESMON_E2E_HEIGHT) || 900,
    }
    : null;
  // A window opened from another takes its size, one step down and to the
  // right of it, and opens maximized if that one is; the first opens maximized.
  const from = how.tabOf ?? (appWindows.has(how.from) ? how.from : appWindows.target(BrowserWindow.getFocusedWindow()));
  const place = from && !from.isDestroyed()
    ? cascade(from.getNormalBounds(), screen.getDisplayMatching(from.getBounds()).workArea)
    : null;
  const maximize = !isE2E() && (!from || from.isDestroyed() || from.isMaximized() || from.isFullScreen());
  // Into tabs before the window's page first asks how much room to leave for the tab bar.
  if (how.tabOf) tabsMode.use();
  const mainWindow = new BrowserWindow({
    width: e2eSize ? e2eSize.width : place?.width ?? 1280,
    height: e2eSize ? e2eSize.height : place?.height ?? 820,
    ...(place ? { x: place.x, y: place.y } : {}),
    minWidth: 960,
    minHeight: 600,
    title: 'resmon',
    show: false,
    // Paint the window in the app's own background from the moment it exists.
    //
    // Without this, Chromium composites an unpainted window as white, so the
    // app flashed white on open and again on close against its dark interface.
    // `show: false` alone does not prevent it: it delays the first paint but
    // the surface Chromium hands over is still white, and on close the
    // renderer tears down before the frame does.
    //
    // Kept in sync with `--color-bg` in styles/global.css by hand — there is no
    // build step shared between the CSS and the main process, so a theme change
    // has to touch both. That is worth one comment and no machinery. The Atlas
    // renderer's ground follows the stored theme, so it is passed in.
    backgroundColor: ground,
    // Atlas draws its own top bar on macOS, with the window controls inset in
    // it, so the bar is the only chrome. Elsewhere the system frame stays.
    // Every window on macOS can join the others' tabs (New Tab, Merge All
    // Windows, the Window menu), which the shared identifier allows.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, tabbingIdentifier: 'resmon' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // webSecurity stays ON. The renderer is served by a local HTTP
      // server (startRendererServer below), so it has an ordinary
      // http://127.0.0.1:<port> origin, and the backend answers CORS
      // for exactly that origin and no other. Disabling the same-origin policy
      // for the whole window would buy nothing and cost real protection.
      // No <webview>: Atlas embeds nothing from another origin.
      webviewTag: false,
      // No additionalArguments: they land in the renderer process's argv, which
      // `ps` shows to every user. The preload asks for the port and token over
      // the synchronous `resmon:backend-connection` IPC instead.
    },
  });
  // In the set before its page loads: its preload's first question is answered only to the set's windows.
  appWindows.add(mainWindow, how.collection ?? null);

  // Every external link opens the same way: an in-app window, not the system
  // browser.
  //
  // Before this, it depended on where you clicked. The attribution links fell
  // through to Electron's default window handling and opened in-app, while the
  // repository detail links called shell.openExternal and threw you out to
  // Safari. Same kind of link, same page, two behaviors.
  //
  // In-app is the one to keep: it stays inside the thing you were reading, and
  // it is where a license or a rate-limit page is usually only glanced at. The
  // window carries the URL in its title bar so it is never hidden, and a
  // right-click offers copying it or handing it to the real browser.
  //
  // A link to one of resmon's own pages asked for in a new window (⌘-click,
  // Ctrl-click, a middle click) opens another window of the app there.
  const rendererOrigin = `http://127.0.0.1:${rendererPort}`;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const own = routeOf(url, rendererOrigin);
    if (own) void openAppWindow(own.route, { from: mainWindow, collection: appWindows.collectionOf(mainWindow) });
    else openLinkWindow(url, mainWindow);
    return { action: 'deny' };
  });

  // A right-click on a link to one of resmon's own pages offers it in a new
  // window, and on macOS in a new tab. Nothing else in the page has a menu.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const own = routeOf(params.linkURL, rendererOrigin);
    if (!own) return;
    const collection = appWindows.collectionOf(mainWindow);
    Menu.buildFromTemplate([
      { label: 'Open in New Window', click: () => void openAppWindow(own.route, { from: mainWindow, collection }) },
      ...(process.platform === 'darwin'
        ? [{ label: 'Open in New Tab', click: () => void openAppWindow(own.route, { tabOf: mainWindow, collection }) }]
        : []),
    ]).popup({ window: mainWindow });
  });

  // The main window only ever shows the renderer. A navigation anywhere else —
  // a plain link without a target, a script setting `location` — opens in a
  // link window instead, the way `window.open` does. This is
  // also what keeps the backend's token in resmon's own document: the preload
  // hands it to the main window's top frame, so that frame must never hold
  // somebody else's page.
  const keepToRenderer = (event: Electron.Event, url: string) => {
    let origin = '';
    try { origin = new URL(url).origin; } catch { /* unparseable: refuse */ }
    if (origin !== rendererOrigin) {
      event.preventDefault();
      if (origin) openLinkWindow(url, mainWindow);
    }
  };
  mainWindow.webContents.on('will-navigate', keepToRenderer);
  mainWindow.webContents.on('will-redirect', keepToRenderer);

  mainWindow.loadURL(`http://127.0.0.1:${rendererPort}/index.html${route ? `#${route}` : ''}`);

  // Open maximized by default (not full-screen) for a more spacious default
  // layout. Users can still un-maximize, resize, or close normally.
  //
  // Under the e2e suite the window keeps the fixed size above: maximizing
  // would immediately discard the size the constructor was given.
  mainWindow.once('ready-to-show', () => {
    // Under `RESMON_HIDDEN_WINDOW` this handler does nothing at all, and the
    // order matters: **`maximize()` shows a window that was never shown.**
    // Measured — a window created `show: false`, maximized, `show()` never
    // called, is on screen at 0,33 1728x1084 and reports `isVisible() ===
    // true`. So a gate placed below the maximize would have left the flag
    // working only because `launchEnv` happens to set `RESMON_E2E` for every
    // journey, which is a different variable in a different file with nothing
    // tying the two together. `launchEnv(stateDir, false)` already exists one
    // opt-in away.
    // Into its tabs before it is shown, so it never appears as a window of its own first.
    const host = how.tabOf && !how.tabOf.isDestroyed() ? how.tabOf : null;
    if (host) host.addTabbedWindow(mainWindow);
    // The window that said resmon is starting goes once this one is ready.
    closeStartingWindow();
    if (isHiddenWindow()) return;
    if (maximize && !host) mainWindow.maximize();
    // `showInactive()` puts the window up without making it the key window, so
    // an automated run does not take the keyboard from the person at the Mac.
    // **This is the line that fixes the complaint** — measured, against each
    // half alone; see the table above `setActivationPolicy`. Unset, this is
    // `show()` exactly as before.
    if (isBackgroundWindow()) mainWindow.showInactive();
    else mainWindow.show();
    if (host) windowsChanged();
  });

  // Browser-style history navigation.
  //
  // The renderer is a HashRouter, so every page change is a real Chromium
  // navigation entry — the history was always there, nothing was ever wired to
  // it. Three ways in, because people reach for different ones: the trackpad,
  // the keyboard, and the menu.
  //
  // macOS only delivers `swipe` when the user has "Swipe between pages" set to
  // a gesture of three fingers (or two or three) in System Settings, which is
  // why the menu items exist rather than relying on it. The default two-finger
  // swipe reaches the page as wheel events instead, and the Atlas renderer
  // follows those itself (`shell/SwipeNavigation.tsx`) through
  // `resmon:swipe-history`; a `swipe` that lands just after one of its moves
  // is the same gesture, and is not taken as a second.
  mainWindow.on('swipe', (_event, direction) => {
    if (Date.now() - (lastScrollSwipe.get(mainWindow) ?? 0) < SWIPE_SETTLE_MS) return;
    if (direction === 'left') navigateHistory('back', mainWindow);
    if (direction === 'right') navigateHistory('forward', mainWindow);
  });

  // Each window keeps its own downloads, and is the one a notice goes to once focused.
  installDownloads(mainWindow);
  mainWindow.on('focus', () => appWindows.focus(mainWindow));
  // The tab bar's new-tab button, on macOS.
  mainWindow.on('new-window-for-tab', () => void openTab(mainWindow));
  // A tab dragged into another window's tab bar moves its window to that
  // group's frame, and its bar is laid out again once its title changes.
  let settle: NodeJS.Timeout | null = null;
  const moved = () => {
    if (!tabsMode.active || process.platform !== 'darwin') return;
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => { settle = null; relayTitle(mainWindow); }, 250);
  };
  mainWindow.on('moved', moved);
  mainWindow.on('resized', moved);
  mainWindow.on('closed', () => {
    if (settle) clearTimeout(settle);
    appWindows.remove(mainWindow);
    tabsMode.windowsNow(appWindows.size);
    windowsChanged();
  });
  return mainWindow;
}

/**
 * Open an external URL in a small in-app window.
 *
 * Only http(s). Anything else — a file: path, a custom scheme — is handed to
 * the operating system, which is what the user means by clicking it and is not
 * something to render inside the app.
 *
 * The window is deliberately plain: no preload, no node integration, and no
 * access to resmon's IPC bridge. It shows somebody else's page, so it gets the
 * privileges a stranger's page should have.
 */
function openLinkWindow(url: string, opener: BrowserWindow | null = null): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    void shell.openExternal(url);
    return;
  }

  const parentWindow = opener && !opener.isDestroyed() ? opener : actedOn(null);
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: url,
    // The ground of the window it was opened from, so the link window opens on
    // the theme the app is showing rather than flashing another color before
    // its page paints.
    backgroundColor: parentWindow?.getBackgroundColor() ?? (nativeTheme.shouldUseDarkColors ? '#0a0a0b' : '#ffffff'),
    show: false,
    parent: parentWindow ?? undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Keep the title bar showing where you actually are. A page that sets its own
  // title would otherwise hide the address, which matters most for exactly the
  // pages this window is used for: licenses and terms.
  const showUrl = () => {
    if (!win.isDestroyed()) win.setTitle(win.webContents.getURL() || url);
  };
  win.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    showUrl();
  });
  win.webContents.on('did-navigate', showUrl);
  win.webContents.on('did-navigate-in-page', showUrl);

  win.webContents.on('context-menu', () => {
    const current = win.webContents.getURL() || url;
    Menu.buildFromTemplate([
      { label: 'Copy Link', click: () => clipboard.writeText(current) },
      { label: 'Open in Browser', click: () => void shell.openExternal(current) },
      { type: 'separator' },
      {
        label: 'Back',
        enabled: win.webContents.navigationHistory.canGoBack(),
        click: () => win.webContents.navigationHistory.goBack(),
      },
      {
        label: 'Forward',
        enabled: win.webContents.navigationHistory.canGoForward(),
        click: () => win.webContents.navigationHistory.goForward(),
      },
      { label: 'Reload', click: () => win.webContents.reload() },
    ]).popup({ window: win });
  });

  // A link inside this window opens another one just like it, rather than
  // silently doing nothing.
  win.webContents.setWindowOpenHandler(({ url: next }) => {
    openLinkWindow(next);
    return { action: 'deny' };
  });

  // Same rule as the main window: a link window opened during an automated run
  // must not steal the foreground either — and under `RESMON_HIDDEN_WINDOW` it
  // must not reach the screen at all. A spec that drives a link window still
  // gets one: the window exists and loads, it is only never shown.
  win.once('ready-to-show', () => {
    if (isHiddenWindow()) return;
    if (isBackgroundWindow()) win.showInactive();
    else win.show();
  });
  void win.loadURL(url);
}

/**
 * Go back or forward one page in a window, if there is one; whether it moved.
 * Never throws. Each window has its own history: the History menu moves the
 * window in front, or the one focused last.
 */
function navigateHistory(direction: 'back' | 'forward', window: unknown = null): boolean {
  const history = actedOn(window)?.webContents.navigationHistory;
  if (!history) return false;
  try {
    if (direction === 'back' && history.canGoBack()) { history.goBack(); return true; }
    if (direction === 'forward' && history.canGoForward()) { history.goForward(); return true; }
  } catch {
    // A window torn down mid-gesture is not worth a crash report.
  }
  return false;
}

/** When each window's renderer last moved for a two-finger swipe, and how long a `swipe` after it is the same gesture. */
const lastScrollSwipe = new WeakMap<BrowserWindow, number>();
const SWIPE_SETTLE_MS = 1000;

/**
 * Whether a two-finger swipe moves between pages here, as it does in Safari:
 * on macOS, "Swipe between pages" in System Settings › Trackpad › More
 * Gestures, which the system keeps as `AppleEnableSwipeNavigateWithScrolls`
 * and which is on until someone turns it off (unset is on). Read as a string,
 * because a missing boolean reads as false. Elsewhere there is no such
 * setting, and a touchpad's two-finger swipe moves as in a browser.
 */
function twoFingerSwipeNavigates(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.getUserDefault('AppleEnableSwipeNavigateWithScrolls', 'string') !== '0';
  } catch {
    return true;
  }
}

/**
 * Hand an app menu command to the Atlas renderer, which does it as its own
 * shortcut does (`atlas/src/shell/shortcuts.ts`), bringing the window forward
 * first: the menu is also there while a link window is in front.
 */
function sendCommand(command: string, window: unknown = null): void {
  const target = actedOn(window);
  if (!target) return;
  if (target.isMinimized()) target.restore();
  target.focus();
  target.webContents.send('resmon:command', command);
}

/**
 * Install or remove the `resmon` command (a terminal command that reaches the
 * running resmon; `commandLine.ts` says what each platform writes) and tell the
 * person what happened. Under the e2e suites the answer goes to the log, as a
 * line a spec can read, rather than into a dialog that waits for a click.
 */
async function runCommandLineItem(action: 'install' | 'uninstall'): Promise<void> {
  let outcome: Outcome;
  if (!app.isPackaged && !process.env.RESMON_COMMAND_LINE_ROOT) {
    outcome = {
      ok: false,
      message: 'This copy of resmon runs from its source folder, which has no command line to install.',
      detail: 'The installed app does. From a checkout, run: pipx install ./resmon_scripts/cli',
    };
  } else {
    const context = systemContext(process.env, process.resourcesPath);
    outcome = await (action === 'install' ? installCommandLine(context) : uninstallCommandLine(context));
  }
  if (isE2E()) {
    console.log(`[main] command line ${JSON.stringify({ action, ...outcome })}`);
    return;
  }
  const options: Electron.MessageBoxOptions = {
    type: outcome.ok ? 'info' : 'warning',
    message: outcome.message,
    detail: outcome.detail,
    buttons: ['OK'],
  };
  const window = actedOn(null);
  if (window) await dialog.showMessageBox(window, options);
  else await dialog.showMessageBox(options);
}

/**
 * Install the application menu.
 *
 * resmon shipped with Electron's default menu, which has no history items at
 * all — so there was no Back, no Forward, and no keyboard shortcut for either.
 * This adds a History menu carrying the shortcuts macOS users expect
 * (Cmd+[ / Cmd+]) alongside the Cmd+Left / Cmd+Right pair, and keeps the rest
 * of the standard menu so Copy, Paste, Minimise and the window list behave as
 * they always have.
 *
 * With the Atlas renderer, File also starts a new conversation, Deep Dive, or
 * Deep Sweep, the app menu (Settings off macOS, in File) opens Settings, and
 * Help lists the keyboard shortcuts. The renderer answers those keys itself
 * and takes them, so a menu item's accelerator runs it only when the
 * renderer left the key alone; a click is sent to the renderer, which does
 * what the key does. ⌘W stays Close Window.
 *
 * File opens another window (⌘N, Ctrl+N elsewhere) at the start page, and on
 * macOS another tab of the window in front (⌘T); the Window menu there holds
 * macOS's tab commands. Each item acts on the window in front, or on the one
 * focused last when a link window is in front.
 */
function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  const send = (command: string) => (_item: Electron.MenuItem, window: unknown) => sendCommand(command, window);
  const settings: Electron.MenuItemConstructorOptions = {
    id: 'app-settings', label: isMac ? 'Settings…' : 'Settings', accelerator: 'CmdOrCtrl+,', click: send('settings'),
  };
  const atlasFile: Electron.MenuItemConstructorOptions = {
    label: 'File',
    id: 'file-menu',
    submenu: [
      { id: 'file-new-window', label: 'New Window', accelerator: 'CmdOrCtrl+N', click: (_item, window) => void openAppWindow(null, { from: actedOn(window) }) },
      ...(isMac ? [{ id: 'file-new-tab', label: 'New Tab', accelerator: 'Cmd+T', click: (_item: Electron.MenuItem, window: unknown) => void openTab(actedOn(window)) }] : []),
      { type: 'separator' },
      { id: 'file-new-conversation', label: 'New Conversation', accelerator: 'Shift+CmdOrCtrl+N', click: send('new-conversation') },
      { id: 'file-new-dive', label: 'New Deep Dive', accelerator: 'CmdOrCtrl+D', click: send('new-dive') },
      { id: 'file-new-sweep', label: 'New Deep Sweep', accelerator: 'Shift+CmdOrCtrl+D', click: send('new-sweep') },
      { type: 'separator' },
      ...(isMac ? [{ role: 'close' as const }] : [settings, { type: 'separator' as const }, { role: 'quit' as const }]),
    ],
  };
  // As VS Code offers `code`: on macOS in the app menu, elsewhere in Help.
  const commandItems: Electron.MenuItemConstructorOptions[] = [
    { id: 'install-command', label: 'Install "resmon" Command in PATH', click: () => { void runCommandLineItem('install'); } },
    { id: 'uninstall-command', label: 'Uninstall "resmon" Command', click: () => { void runCommandLineItem('uninstall'); } },
  ];
  const atlasApp: Electron.MenuItemConstructorOptions = {
    role: 'appMenu',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settings,
      { type: 'separator' },
      ...commandItems,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [atlasApp] : []),
    atlasFile,
    { role: 'editMenu' },
    {
      label: 'History',
      // The ids are how `e2e/main-window.spec.ts` reaches these items: it looks
      // them up with `Menu.getApplicationMenu().getMenuItemById()` and calls
      // `click()`, which runs the same handler a user's click runs. Matching on
      // the label would work today and break the day one is reworded, and a
      // test that stops finding what it drives usually stops testing quietly.
      id: 'history-menu',
      submenu: [
        {
          id: 'history-back',
          label: 'Back',
          accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
          click: (_item, window) => navigateHistory('back', window),
        },
        {
          id: 'history-forward',
          label: 'Forward',
          accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
          click: (_item, window) => navigateHistory('forward', window),
        },
        { type: 'separator' },
        // The other pair macOS users reach for. Electron allows one accelerator
        // per item, so the alternates are their own hidden entries.
        {
          id: 'history-back-alt',
          label: 'Back',
          accelerator: isMac ? 'Cmd+Left' : 'Backspace',
          visible: false,
          click: (_item, window) => navigateHistory('back', window),
        },
        {
          id: 'history-forward-alt',
          label: 'Forward',
          accelerator: isMac ? 'Cmd+Right' : 'Shift+Backspace',
          visible: false,
          click: (_item, window) => navigateHistory('forward', window),
        },
      ],
    },
    { role: 'viewMenu' },
    isMac ? macWindowMenu() : { role: 'windowMenu' },
    {
      role: 'help' as const,
      submenu: [
        { id: 'help-shortcuts', label: 'Keyboard Shortcuts', click: send('shortcuts') },
        ...(isMac ? [] : [{ type: 'separator' as const }, ...commandItems]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * The Window menu on macOS: the system's own items, macOS's tab commands with
 * their usual keys, and the list of open windows, which macOS adds to the menu
 * given the `window` role. Show Tab Bar, Merge All Windows, and Move Tab to New
 * Window are resmon's own items rather than the system's, so the windows know
 * to leave room for the tab bar (`TabsMode`).
 */
function macWindowMenu(): Electron.MenuItemConstructorOptions {
  const acting = (act: (window: BrowserWindow | null) => void) =>
    (_item: Electron.MenuItem, window: unknown) => act(actedOn(window));
  return {
    role: 'window',
    id: 'window-menu',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { id: 'window-previous-tab', role: 'selectPreviousTab', accelerator: 'Ctrl+Shift+Tab' },
      { id: 'window-next-tab', role: 'selectNextTab', accelerator: 'Ctrl+Tab' },
      { id: 'window-move-tab', label: 'Move Tab to New Window', click: acting(moveTabToNewWindow) },
      { id: 'window-merge', label: 'Merge All Windows', click: acting(mergeAllWindows) },
      { type: 'separator' },
      { id: 'window-tab-bar', label: tabsMode.active ? 'Hide Tab Bar' : 'Show Tab Bar', click: acting(toggleTabBar) },
      { id: 'window-all-tabs', role: 'showAllTabs' },
      { type: 'separator' },
      { role: 'front' },
    ],
  };
}

/** Move Tab to New Window: the tab in front becomes a window of its own. */
function moveTabToNewWindow(window: BrowserWindow | null): void {
  if (!window || process.platform !== 'darwin') return;
  window.moveTabToNewWindow();
  windowsChanged();
}

/** Show Tab Bar or Hide Tab Bar, for the window in front and its tabs. */
function toggleTabBar(window: BrowserWindow | null): void {
  if (!window || process.platform !== 'darwin') return;
  window.toggleTabBar();
  tabsMode.toggleBar(appWindows.size);
  windowsChanged();
}

// ---------------------------------------------------------------------------
// Auto-update (Windows and Linux only).
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

// ---------------------------------------------------------------------------
// The background service at launch (`service.ts`)
// ---------------------------------------------------------------------------

function launchctl(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.env.RESMON_LAUNCHCTL || 'launchctl', args, { timeout: 30_000 }, (error, stdout, stderr) => {
      const status = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
      resolve({ code: error ? status : 0, out: String(stdout), err: String(stderr) });
    });
  });
}

/** Runs in progress on an engine, or null when it does not say. */
function activeRuns(port: number, token: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/executions/active', timeout: 2_000, headers: bearer(token) },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const ids = (JSON.parse(body) as { active_ids?: unknown }).active_ids;
            resolve(res.statusCode === 200 && Array.isArray(ids) ? ids.length : null);
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

/** The service's engine as its lock and health say, or null when none answers. */
async function runningService(): Promise<Running | null> {
  const lock = readLockFile();
  const token = lock ? readTokenFile(lock.port) : null;
  if (!lock || !token) return null;
  const health = await fetchHealth(lock.port, token, 1_500);
  if (!health) return null;
  return { build: health.build ?? null, version: health.version ?? null, active: await activeRuns(lock.port, token) };
}

/** Write the unit again to start this copy, keeping its port, through the engine's own `service_manager`. */
function rewriteUnit(port: number | null): Promise<boolean> {
  const { scriptDir, pythonPath } = backendLocation();
  const env: NodeJS.ProcessEnv = { ...process.env, RESMON_APP_EXECUTABLE: process.execPath };
  if (port !== null) env.RESMON_DAEMON_PORT = String(port);
  if (app.isPackaged) {
    // The same state the service's engine is given (`startServiceEngine`).
    const state = stateDir();
    env.RESMON_DB_PATH = env.RESMON_DB_PATH || path.join(state, 'resmon.db');
    env.RESMON_REPORTS_DIR = env.RESMON_REPORTS_DIR || path.join(state, 'resmon_reports');
  }
  const write = 'import sys; sys.path.insert(0, sys.argv[1]); '
    + 'from implementation_scripts import service_manager as m; m.install(register=False)';
  return new Promise((resolve) => {
    execFile(pythonPath, ['-I', '-c', write, scriptDir], { env, timeout: 60_000 }, (error, _out, stderr) => {
      if (error) console.error(`[service] The unit could not be written again: ${String(stderr).trim() || error.message}`);
      resolve(!error);
    });
  });
}

function serviceWorld(): World {
  const label = process.env.RESMON_SERVICE_LABEL || 'com.resmon.daemon';
  const domain = `gui/${os.userInfo().uid}`;
  const target = `${domain}/${label}`;
  const unitFile = path.join(
    process.env.RESMON_SERVICE_UNIT_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents'), `${label}.plist`);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return {
    async facts(): Promise<Facts> {
      // No unit, no service: launchd is not asked at all.
      if (!fs.existsSync(unitFile)) {
        return { unit: null, job: { loaded: false, pid: null, disabled: false }, running: null, programExists: false };
      }
      let unit: Unit | null;
      try {
        unit = unitFromPlist(JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', unitFile],
          { encoding: 'utf8', timeout: 10_000 })));
      } catch {
        unit = { program: null, runsApp: false, port: null };
      }
      const shown = await launchctl(['print', target]);
      const listed = await launchctl(['print-disabled', domain]);
      return {
        unit,
        job: {
          loaded: shown.code === 0,
          pid: shown.code === 0 ? pidFromPrint(shown.out) : null,
          disabled: disabledIn(listed.out, label),
        },
        running: await runningService(),
        programExists: !!unit?.program && fs.existsSync(unit.program),
      };
    },
    async bootout(): Promise<boolean> {
      await launchctl(['bootout', target]);
      // The service quits its engine first, which gives a running search 20 s to stop.
      for (let i = 0; i < 120; i++) {
        if ((await launchctl(['print', target])).code !== 0) return true;
        await sleep(250);
      }
      return false;
    },
    async bootstrap() {
      const started = await launchctl(['bootstrap', domain, unitFile]);
      return { ok: started.code === 0, said: (started.err || started.out).trim() };
    },
    async kickstart() {
      return (await launchctl(['kickstart', '-k', target])).code === 0;
    },
    rewrite: rewriteUnit,
    async askToRestart(active: number): Promise<boolean> {
      const runs = active === 1 ? 'a run' : `${active} runs`;
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: 'Restart the background service on this version of resmon?',
        detail: `The background service is running ${runs} on another build of resmon. Restarting it stops `
          + `${active === 1 ? 'that run' : 'those runs'}, and Restart on a run’s page starts one again. `
          + 'Kept, the service goes on running its own build, and this window opens on it.',
        buttons: ['Restart the service', 'Keep it running'],
        defaultId: 0,
        cancelId: 1,
      });
      return response === 0;
    },
    releaseLock: () => app.releaseSingleInstanceLock(),
    holdsLock: () => app.hasSingleInstanceLock(),
    sleep,
    log: (line: string) => console.log(`[service] ${line}`),
    waiting: showStartingWindow,
  };
}

/** The small window shown while this launch waits for the background service, and the timer that holds it back. */
let startingWindow: BrowserWindow | null = null;
let startingTimer: NodeJS.Timeout | null = null;
/** How long a wait for the service lasts before the window shows: a service that answers at once shows nothing. */
const STARTING_QUIET_MS = 1_500;

/**
 * The starting window's page: what is happening and why it can take minutes.
 * No script and no preload, and nothing loaded from anywhere: the page is the
 * whole of it. The engine is not up, so the stored theme cannot be read; the
 * system's stands in, in the app's own two grounds and inks.
 */
function startingPage(why: 'starting' | 'started', dark: boolean): string {
  const [ground, ink, ink2, ink3, rule] = dark
    ? ['#0a0a0b', '#f1eee6', '#bfbab0', '#8f8b82', '#232322']
    : ['#ffffff', '#141413', '#45433e', '#69665f', '#e3e1dc'];
  const doing = why === 'starting'
    ? 'Waiting for its background service to finish starting.'
    : 'Waiting for its background service to start on this version of resmon.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>resmon</title><style>
html, body { margin: 0; height: 100%; background: ${ground}; color: ${ink}; cursor: default; user-select: none; }
body { box-sizing: border-box; padding: 44px 32px 24px; font: 13px/1.5 -apple-system, "Helvetica Neue", "Segoe UI", sans-serif; -webkit-app-region: drag; }
h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; letter-spacing: -.005em; }
p { margin: 0; color: ${ink2}; }
.track { position: relative; height: 2px; margin: 0 0 16px; overflow: hidden; border-radius: 1px; background: ${rule}; }
.track::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 30%; background: ${ink3}; animation: go 1.6s cubic-bezier(.45, 0, .55, 1) infinite; }
@keyframes go { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
@media (prefers-reduced-motion: reduce) { .track::after { animation: none; width: 100%; opacity: .5; } }
.small { margin-top: 12px; font-size: 12px; color: ${ink3}; }
</style></head><body>
<div class="track" role="progressbar" aria-label="Waiting for the background service"></div>
<h1>resmon is starting</h1>
<p>${doing} After an update, the service’s first start updates the database that holds your collection, which can take a few minutes.</p>
<p class="small">This window closes when resmon opens. Close it to stop waiting; the service goes on starting.</p>
</body></html>`;
}

/**
 * Say that resmon is starting, once a wait for its background service has
 * lasted `STARTING_QUIET_MS`. Without it a launch waiting for a service that
 * migrates its database showed nothing for minutes. Closing the window quits
 * this launch, as closing the last window does; the service is left starting.
 */
function showStartingWindow(why: 'starting' | 'started'): void {
  if (startingWindow || startingTimer) return;
  startingTimer = setTimeout(() => {
    startingTimer = null;
    const dark = nativeTheme.shouldUseDarkColors;
    const window = new BrowserWindow({
      width: 440,
      height: 228,
      useContentSize: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'resmon',
      show: false,
      backgroundColor: dark ? '#0a0a0b' : '#ffffff',
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    startingWindow = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.once('ready-to-show', () => {
      if (isHiddenWindow() || window.isDestroyed()) return;
      if (isBackgroundWindow()) window.showInactive();
      else window.show();
    });
    window.on('closed', () => { if (startingWindow === window) startingWindow = null; });
    console.log(`[service] Showing that resmon is starting (${why})`);
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startingPage(why, dark))}`);
  }, STARTING_QUIET_MS);
}

/** The wait is over before the window showed: it never will. One already shown stays until resmon's window is ready. */
function holdBackStartingWindow(): void {
  if (startingTimer) clearTimeout(startingTimer);
  startingTimer = null;
}

/** resmon's window is ready, or this launch is done: the starting window goes. */
function closeStartingWindow(): void {
  holdBackStartingWindow();
  const window = startingWindow;
  startingWindow = null;
  if (window && !window.isDestroyed()) window.destroy();
}

/**
 * Open again, with the check done, so this launch hands over to whichever
 * resmon holds the profile now: the service just started, which opens the
 * window on its own engine.
 */
function handOver(): void {
  process.env.RESMON_SERVICE_CHECKED = '1';
  app.relaunch();
  app.exit(0);
}

/**
 * Make sure of the background service before this launch opens anything
 * (`service.ts`). True when this process is done: it handed over, or another
 * resmon has the window.
 */
async function checkServiceAtLaunch(): Promise<boolean> {
  let outcome: Awaited<ReturnType<typeof ensureService>>;
  try {
    outcome = await ensureService(serviceWorld(), {
      exe: process.execPath, build: BUILD_ID, temporary: temporaryPlace(process.execPath),
    });
  } catch (err) {
    outcome = { done: 'failed', why: err instanceof Error ? err.message : String(err) };
  }
  console.log(`[service] At launch: ${JSON.stringify(outcome)}`);
  holdBackStartingWindow();
  if (outcome.done === 'started') {
    handOver();
    return true;
  }
  // Another resmon holds the profile, and opened the window when this launch asked for it.
  if (!SOLE_INSTANCE) {
    app.quit();
    return true;
  }
  // The lock was let go for a service that did not come up: taken back, or, if
  // something took it meanwhile, handed over to that.
  if (!app.hasSingleInstanceLock() && !app.requestSingleInstanceLock()) {
    handOver();
    return true;
  }
  return false;
}

function initAutoUpdater(): void {
  if (!app.isPackaged) return;
  // The packaged-app run under the e2e suite must not reach out to the GitHub
  // releases feed, and must not be able to pop the "Update ready" dialog over
  // a screenshot. Unreachable in a checkout (the line above returns first);
  // it exists for the packaged leg of the suite.
  if (isE2E()) return;
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
  // Before anything else: this launch may hand over to the service it starts.
  if (CHECKS_SERVICE && await checkServiceAtLaunch()) return;
  // A second instance has handed over and is exiting (`SOLE_INSTANCE`).
  if (!SOLE_INSTANCE) return;
  try {
    // The renderer server comes first: the backend has to be told the
    // renderer's exact origin, which is only known once this port is bound.
    const rendererRoot = path.join(__dirname, '..', 'atlas');
    const rendererOrigin = `http://127.0.0.1:${await startRendererServer(rendererRoot)}`;
    rendererOriginValue = rendererOrigin;
    // Before any backend starts: a backend this app starts posts its
    // notifications through the app.
    noticeListener = await startNoticeListener(postNotice);

    if (SERVICE) {
      backendPort = servicePort(process.env, process.argv);
      backendToken = mintToken();
      console.log(`[main] Starting the service's engine on port ${backendPort}`);
      backendProcess = startServiceEngine(backendPort, backendToken, rendererOrigin);
      // The engine takes the daemon lock and imports the whole app before it
      // answers; a cold start of the packaged engine was measured at a few
      // seconds, and one that migrates the database takes longer.
      await waitForEngine(backendProcess, backendPort, backendToken);
      console.log('[main] The service is running');
    }

    // Attach-or-spawn: if the lock file points to a live daemon, attach.
    // Retry with a longer per-attempt timeout so a
    // launchd-respawn-in-progress (lock file rewritten but FastAPI not
    // yet bound) does not cause a single-shot 500 ms probe to time out
    // and trigger a competing-backend spawn.
    const attached = SERVICE ? null : await tryAttachToDaemon(rendererOrigin);
    if (SERVICE) {
      // The engine above is this service's own.
    } else if (attached !== null) {
      backendPort = attached.port;
      backendToken = attached.token;
      attachedToDaemon = true;
    } else {
      backendPort = await findFreePort();
      backendToken = mintToken();
      console.log(`[main] Starting backend on port ${backendPort}`);
      backendProcess = startBackend(backendPort, backendToken, rendererOrigin);
      await waitForEngine(backendProcess, backendPort, backendToken);
      console.log('[main] Backend is ready');
    }

    // IPC: the backend's port and token, for the preload only. Synchronous
    // because the renderer's `getBaseUrl()` is, and it is called during the
    // first render. Answered only to an app window's own top frame. That
    // frame can only ever hold a document from the renderer origin — the
    // `will-navigate` guard in `createWindow` sends every other navigation to a
    // link window, which has no preload — so the frame check is the origin
    // check. The frame's own URL cannot be used for it: while the preload runs
    // it is still "" (observed under Playwright), and a handler that throws
    // never sets `returnValue`, which leaves the renderer blocked in sendSync.
    // Link windows have no preload and are refused anyway.
    // Every app window gets the same answer: one engine, one port, one token.
    // The handlers below answer each window about itself, through
    // `senderWindow`, the window that asked.
    const senderWindow = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null => {
      const frame = event.senderFrame;
      const window = appWindows.forSender(event.sender, frame);
      return window && frame && (frame.url === '' || frame.url.startsWith(`${rendererOrigin}/`)) ? window : null;
    };
    const fromRenderer = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => senderWindow(event) !== null;
    ipcMain.on('resmon:backend-connection', (event) => {
      let answer: { port: string; token: string | null } | null = null;
      try {
        if (fromRenderer(event) && backendPort !== null) answer = { port: String(backendPort), token: backendToken };
      } finally {
        event.returnValue = answer;
      }
    });

    // IPC: quit and open again, for the restore staged in Settings › Backup,
    // which runs as a backend starts. Answered only to the renderer's own top
    // frame, as above, and never in the service, whose engine outlives its
    // windows. This window's own engine is stopped and waited for before the
    // relaunch, so the next start's restore never moves the database while
    // the old engine still has it open.
    ipcMain.handle('resmon:relaunch', async (event) => {
      if (SERVICE || !fromRenderer(event)) return false;
      await stopOwnBackend();
      app.relaunch();
      app.quit();
      return true;
    });

    // IPC: two-finger swipe navigation, for the Atlas renderer's
    // `SwipeNavigation`: whether the system lets two fingers swipe between
    // pages, and the move itself, made here so a `swipe` event that follows it
    // is known for the same gesture. Answered only to the renderer's own frame.
    ipcMain.handle('resmon:swipe-navigation', (event) => fromRenderer(event) && twoFingerSwipeNavigates());
    ipcMain.handle('resmon:swipe-history', (event, direction: unknown) => {
      const window = senderWindow(event);
      if (!window || (direction !== 'back' && direction !== 'forward')) return false;
      lastScrollSwipe.set(window, Date.now());
      return navigateHistory(direction, window);
    });

    // IPC: the windows. `resmon:window-state` is what a window's page reads
    // before it first draws (its collection, and the room to leave for macOS's
    // tab bar), asked synchronously like the connection; later changes are
    // sent on the same channel. `resmon:open-window` opens another window at a
    // page of the app, or the start page, beside the one that asked or, on
    // macOS, in its tabs; it shows the same collection. `resmon:run-started`
    // says which window started a run, so the run's notification shows it there.
    ipcMain.on('resmon:window-state', (event) => {
      let answer: ReturnType<typeof windowState> | null = null;
      try {
        const window = senderWindow(event);
        if (window) answer = windowState(window);
      } finally {
        event.returnValue = answer;
      }
    });
    // `resmon:window-collection` is the switch in a window's top bar: that
    // window shows another collection, by id, and no other window changes.
    ipcMain.on('resmon:window-collection', (event, collection: unknown) => {
      const window = senderWindow(event);
      if (!window) return;
      const id = typeof collection === 'string' && /^\d{1,12}$/.test(collection) ? collection : null;
      if (appWindows.setCollection(window, id) && !window.webContents.isDestroyed()) {
        window.webContents.send('resmon:window-state', windowState(window));
      }
    });
    ipcMain.on('resmon:open-window', (event, route: unknown, tab: unknown) => {
      const window = senderWindow(event);
      if (!window) return;
      const collection = appWindows.collectionOf(window);
      void openAppWindow(cleanRoute(route), tab === true ? { tabOf: window, collection } : { from: window, collection });
    });
    ipcMain.on('resmon:run-started', (event, executionId: unknown) => {
      const window = senderWindow(event);
      if (window) runOwners.claim(executionId, window.id);
    });
    ipcMain.on('resmon:run-queued', (event, what: unknown) => {
      const window = senderWindow(event);
      if (window && what && typeof what === 'object') runOwners.claimQueued(what as { ticket?: unknown; routineId?: unknown }, window.id);
    });
    // The theme the app shows (`/api/appearance`), so the parts of a window the
    // system draws follow it: macOS's tab bar drew its titles for the system's
    // dark theme over a light page, where they could not be read.
    // A tab bar already drawn kept its titles in the old theme's color after a
    // change (measured on macOS 26) until the titles were set again, after the
    // new theme had reached the window, so they are set again then: for every
    // window after a change, and for a window once its own page has followed.
    ipcMain.on('resmon:theme-source', (event, theme: unknown) => {
      const window = senderWindow(event);
      if (!window || (theme !== 'system' && theme !== 'light' && theme !== 'dark')) return;
      const changed = nativeTheme.themeSource !== theme;
      if (changed) {
        nativeTheme.themeSource = theme;
        // Each window's own ground follows too, as `atlasGround` paints a new one.
        const ground = nativeTheme.shouldUseDarkColors ? '#0a0a0b' : '#ffffff';
        for (const each of appWindows.all()) each.setBackgroundColor(ground);
      }
      if (process.platform === 'darwin' && tabsMode.active) {
        setTimeout(() => { for (const each of changed ? appWindows.all() : [window]) relayTitle(each); }, 800);
      }
    });

    // IPC: choose a directory via native folder picker.
    ipcMain.handle('resmon:choose-directory', async (evt, defaultPath?: string) => {
      const opts: Electron.OpenDialogOptions = {
        title: 'Select folder',
        properties: ['openDirectory', 'createDirectory'],
      };
      if (defaultPath) opts.defaultPath = defaultPath;
      // On the window that asked, as a sheet of its own.
      const result = await dialog.showOpenDialog(
        senderWindow(evt) ?? (undefined as unknown as BrowserWindow),
        opts,
      );
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    });

    // IPC: choose a single file via the native file picker.
    //
    // Separate from ``resmon:choose-directory`` rather than a flag on it,
    // because the two dialogs need different properties and the extra ones here
    // are not cosmetic. This picker exists for one field — "where is the
    // ``claude`` / ``codex`` command?" — and both CLIs live somewhere a plain
    // open panel will not show you:
    //
    //   * ``claude`` installs under ``~/.local/...`` and ``~/.claude/...``,
    //     which the Finder hides. Without ``showHiddenFiles`` the user is
    //     looking at an empty home directory.
    //   * ``codex`` ships *inside* ``ChatGPT.app``. macOS treats an app bundle
    //     as a single file, so without ``treatPackageAsDirectory`` there is no
    //     way to descend into ``Contents/Resources`` and pick it at all.
    //
    // Both are the documented install locations resmon already probes in
    // ``ai_cli.known_locations``; a picker that cannot reach them would be a
    // button that fails for exactly the users who need it.
    ipcMain.handle('resmon:choose-file', async (evt, defaultPath?: string) => {
      const opts: Electron.OpenDialogOptions = {
        title: 'Select command',
        properties: ['openFile', 'showHiddenFiles', 'treatPackageAsDirectory'],
      };
      if (defaultPath) opts.defaultPath = defaultPath;
      // On the window that asked, as a sheet of its own.
      const result = await dialog.showOpenDialog(
        senderWindow(evt) ?? (undefined as unknown as BrowserWindow),
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

    // IPC: send a file the Library holds as removed to the system's Trash,
    // where the person can still put it back. Only a file directly inside
    // `resmon-library-<id>/removed/<id>/` is taken: the engine hands this path
    // over after checking it (`library_removal.release_request`), and nothing
    // else on the disk can be sent to the Trash through this channel. Asked only by the
    // renderer's own top frame in one of resmon's windows, as the other window channels are.
    ipcMain.handle('resmon:trash-path', async (evt, targetPath: string) => {
      if (!fromRenderer(evt)) return 'Only resmon\u2019s own window can move a file to the Trash.';
      if (!libraryRemovedFile(targetPath)) return 'Only a file the Library holds as removed can be moved to the Trash.';
      try {
        await shell.trashItem(targetPath);
        return '';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    });

    installApplicationMenu();
    // An AppImage mounts at a new path on every run; the `resmon` command the
    // menu installed runs a copy of the command line, which is kept current.
    if (app.isPackaged) refreshInstalledArchive(systemContext(process.env, process.resourcesPath));
    // The service opens no window of its own; `showWindow` makes one on request.
    // It does not check for updates either: an update replaces the bundle, and
    // offering it is a window's job, with a person looking at it.
    if (!SERVICE) {
      await showWindow(null);
      initAutoUpdater();
    }
  } catch (err) {
    console.error('[main] Failed to start:', err);
    app.quit();
  }
});

// A second launch of resmon, while this one runs: a window, here, when a
// person opened resmon; nothing when it was the service starting (`opensWindowFor`).
app.on('second-instance', (_event, argv) => {
  if (!opensWindowFor(argv)) {
    console.log('[main] The service started while this resmon runs; it takes over once this one quits');
    return;
  }
  void showWindow(null);
});

// The Dock icon clicked, or the app opened again from the Finder, on macOS.
app.on('activate', () => {
  if (SERVICE && appWindows.size === 0) void showWindow(null);
});

// launchd and systemd stop a service with SIGTERM. Node's default is to exit on
// the spot, which would leave the engine running without its parent, holding
// the port and the lock the next start needs; quitting stops it first.
if (SERVICE) {
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
}

app.on('window-all-closed', () => {
  // The service outlives its windows: closing the last one hands the Dock icon
  // and the menu bar back and leaves the engine running.
  if (SERVICE) {
    if (process.platform === 'darwin') app.setActivationPolicy('accessory');
    return;
  }
  if (backendProcess && !attachedToDaemon) {
    backendProcess.kill();
    backendProcess = null;
  }
  app.quit();
});

app.on('before-quit', (event) => {
  quitting = true;
  if (SERVICE && backendProcess && backendProcess.exitCode === null && backendProcess.signalCode === null) {
    // Hold the quit until the engine has shut down cooperatively (it cancels
    // running executions and flushes the scheduler on SIGTERM), so the next
    // start finds the port and the lock free. 20 s, then it is killed.
    event.preventDefault();
    const engine = backendProcess;
    if (!engine.killed) {
      const deadline = setTimeout(() => engine.kill('SIGKILL'), 20_000);
      engine.once('exit', () => {
        clearTimeout(deadline);
        noticeListener?.close();
        app.exit(0);
      });
      engine.kill('SIGTERM');
    }
    return;
  }
  if (backendProcess && !attachedToDaemon) {
    backendProcess.kill();
    backendProcess = null;
  }
});
