/**
 * The launch fixture: one real resmon — Electron main process, its own spawned
 * Python backend, its own empty database — per worker.
 *
 * Four things about this are load-bearing and none is obvious.
 *
 * **It never touches the user's data, and never the daemon.** `RESMON_STATE_DIR`
 * points at a fresh temp directory, so `tryAttachToDaemon()` reads no lock file,
 * finds no daemon, and spawns its own backend on a free port of the app's own
 * choosing. `RESMON_DB_PATH`, `RESMON_REPORTS_DIR` and `RESMON_PORT_FILE` are
 * pinned into the same temp directory: in a checkout (as opposed to a packaged
 * app) `main.ts` sets none of those, so without pinning them the backend would
 * write `resmon.db` into the repository root. Port 8742 — a live launchd daemon
 * over a different database — is never bound and never probed. Every spec
 * asserts the discovered backend port is not 8742.
 *
 * **The backend port is discovered, not fixed.** `main.ts` picks a free port and
 * passes it to the renderer through the preload's `--backend-port=` argument, so
 * `backendPort()` reads it back out of the renderer rather than pinning a port
 * the app would have to be told about. Nothing here needs a fixed port, which is
 * one fewer `RESMON_E2E` branch in `main.ts`.
 *
 * **`RESMON_STATE_DIR` does not isolate Electron itself, and that was found the
 * hard way.** It isolates the *backend's* state — database, reports, daemon lock
 * — but Chromium keeps its own profile in `app.getPath('userData')`, which in a
 * checkout is the real `~/Library/Application Support/resmon` the installed app
 * uses. The first run of this fixture returned a 1440x900 window whose renderer
 * reported a 1200x723 viewport, because that profile carried a persisted
 * per-origin zoom factor of 1.2 from somebody's real session. A screenshot taken
 * that way is not evidence of anything, and the suite was also writing into the
 * user's own profile. `--user-data-dir` — a Chromium switch, handled before any
 * app code runs, so it costs no `RESMON_E2E` branch — points the profile at the
 * same temp directory. Zoom is then 1 and the profile is the suite's own.
 *
 * **The app is worker-scoped, not test-scoped.** Launching once and navigating
 * between routes is what makes a 14-route pass ~20 s instead of ~110 s, and it
 * is the shape a per-PR CI job can afford. The cost is that the routes are not
 * isolated from each other: a timer or a pending request started on one route
 * can log after the next route has been entered, and it will be tagged with the
 * route that was current when it fired. The two collectors record the tag, so a
 * misattribution is visible as a surprising route rather than invisible — but it
 * is a real limitation, and it is stated in the report under P2.
 */
import { test as base, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page, ConsoleMessage, Request } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');
export const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..', '..');
export const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

/** Fixed so a screenshot means the same thing on every machine — see RESMON_E2E in main.ts. */
export const WINDOW_WIDTH = 1440;
export const WINDOW_HEIGHT = 900;

/** A console message Chromium classified as an error, tagged with the route that was current. */
export interface ConsoleError {
  route: string;
  text: string;
  location: string;
}

/** A network request that never completed, tagged with the route that was current. */
export interface FailedRequest {
  route: string;
  url: string;
  failure: string;
}

export interface WorkerFixtures {
  app: ElectronApplication;
  win: Page;
  consoleErrors: ConsoleError[];
  failedRequests: FailedRequest[];
  currentRoute: { value: string };
}

export interface TestFixtures {
  /** Navigate to a hash route and wait for the routed content to mount. */
  goto: (hashPath: string) => Promise<void>;
  /** The backend port `main.ts` chose, read back out of the preload bridge. */
  backendPort: () => Promise<string>;
  /** Auto-use: empties the two collectors so a test only sees its own events. */
  freshCollectors: void;
}

function pythonPath(): string {
  const venv = process.platform === 'win32'
    ? path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(REPO_ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  // CI installs the backend's requirements into the runner's own interpreter
  // rather than into a venv inside the checkout.
  return process.env.RESMON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

/**
 * The environment a launched resmon runs in.
 *
 * Exported because `default-behaviour.spec.ts` launches the app with exactly
 * this minus `RESMON_E2E`, and the two have to differ in nothing else for that
 * comparison to mean anything.
 */
export function launchEnv(stateDir: string, e2e: boolean): Record<string, string> {
  // Playwright's `env` is `{[k: string]: string}`, and `process.env` is not —
  // an unset variable is `undefined` there. Drop those rather than passing an
  // "UNSET=undefined" through to the app.
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') inherited[k] = v;
  }
  const env: Record<string, string> = {
    ...inherited,
    RESMON_STATE_DIR: stateDir,
    RESMON_DB_PATH: path.join(stateDir, 'resmon.db'),
    RESMON_REPORTS_DIR: path.join(stateDir, 'reports'),
    RESMON_PORT_FILE: path.join(stateDir, 'resmon.port'),
    RESMON_PYTHON: pythonPath(),
  };
  if (e2e) {
    env.RESMON_E2E = '1';
    env.RESMON_E2E_WIDTH = String(WINDOW_WIDTH);
    env.RESMON_E2E_HEIGHT = String(WINDOW_HEIGHT);
  } else {
    delete env.RESMON_E2E;
    delete env.RESMON_E2E_WIDTH;
    delete env.RESMON_E2E_HEIGHT;
  }
  return env;
}

export async function launchResmon(e2e = true): Promise<{ app: ElectronApplication; stateDir: string }> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
    cwd: FRONTEND_ROOT,
    env: launchEnv(stateDir, e2e),
    timeout: 180_000,
  });
  return { app, stateDir };
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  currentRoute: [async ({}, use) => { await use({ value: 'launch' }); }, { scope: 'worker' }],
  consoleErrors: [async ({}, use) => { await use([]); }, { scope: 'worker' }],
  failedRequests: [async ({}, use) => { await use([]); }, { scope: 'worker' }],

  app: [async ({}, use) => {
    const { app, stateDir } = await launchResmon(true);
    await use(app);
    await app.close().catch(() => { /* already gone */ });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }, { scope: 'worker' }],

  win: [async ({ app, consoleErrors, failedRequests, currentRoute }, use) => {
    const win = await app.firstWindow({ timeout: 180_000 });

    // Q3's collectors. Attached before the first navigation so nothing on the
    // initial load is missed.
    win.on('console', (msg: ConsoleMessage) => {
      if (msg.type() !== 'error') return;
      const loc = msg.location();
      consoleErrors.push({
        route: currentRoute.value,
        text: msg.text(),
        location: `${loc.url}:${loc.lineNumber}:${loc.columnNumber}`,
      });
    });
    win.on('requestfailed', (req: Request) => {
      failedRequests.push({
        route: currentRoute.value,
        url: req.url(),
        failure: req.failure()?.errorText ?? 'unknown',
      });
    });
    // An uncaught exception in the renderer is not a `console` event; without
    // this a React render crash would leave the collector empty.
    win.on('pageerror', (err) => {
      consoleErrors.push({
        route: currentRoute.value,
        text: `[pageerror] ${err.message}`,
        location: 'uncaught',
      });
    });

    await win.waitForLoadState('domcontentloaded');
    await use(win);
  }, { scope: 'worker' }],

  // The collectors are worker-scoped because the listeners are attached once to
  // a worker-scoped window; without this they would accumulate across the whole
  // run and across spec files. They did, and it failed: `observability.spec.ts`
  // deliberately provokes a console error on `/analytics`, and because it runs
  // before `smoke.spec.ts` alphabetically, the Analytics smoke test inherited
  // the provocation and went red on 5 of 5 full-suite runs while the smoke file
  // alone was green on 5 of 5. Emptying them per test is what makes the two
  // agree. What it still cannot fix is a *late* event from the previous route
  // inside the same test — see the note at the top of this file.
  freshCollectors: [async ({ consoleErrors, failedRequests }, use) => {
    consoleErrors.length = 0;
    failedRequests.length = 0;
    await use();
  }, { auto: true }],

  goto: async ({ win, currentRoute }, use) => {
    await use(async (hashPath: string) => {
      currentRoute.value = hashPath;
      // A HashRouter change is not a document navigation, so `page.goto` against
      // the same document would not drive React Router. Setting `location.hash`
      // is what a sidebar click does.
      await win.evaluate((h) => { window.location.hash = `#${h}`; }, hashPath);
      await win.waitForFunction(
        (h) => window.location.hash.startsWith(`#${h}`),
        hashPath,
        { timeout: 15_000 },
      );
      await win.locator('.app-main').waitFor({ state: 'visible', timeout: 15_000 });
      // The two index routes redirect a tick later, and every page fires its
      // first data fetch on mount. Settle before screenshotting.
      await win.waitForLoadState('networkidle').catch(() => { /* long-poll pages never idle */ });
      await win.waitForTimeout(500);
    });
  },

  backendPort: async ({ win }, use) => {
    await use(async () => win.evaluate(
      () => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort(),
    ));
  },
});

export { expect } from '@playwright/test';

/**
 * True when a console message or a request belongs to resmon rather than to
 * something resmon embeds.
 *
 * resmon deliberately renders two origins it does not own: six
 * `youtube-nocookie.com` iframes on About resmon → Tutorials, and the GitHub
 * Pages blog in a `<webview>` on About resmon → Blog. Both emit their own
 * console output and both leave requests in flight when the user navigates
 * away, and neither is resmon failing:
 *
 *   - "Permissions policy violation: compute-pressure is not allowed in this
 *     document", from inside YouTube's player bundle. Appeared on 1 of 5 runs,
 *     from a `player_embed_es6` build number that changes between runs.
 *   - `net::ERR_ABORTED` on 2–6 `youtube-nocookie.com` URLs per run, when the
 *     next route is entered before the embeds finish loading.
 *
 * Asserting on those makes the suite red for reasons no change to this
 * repository can fix. Asserting only on resmon's own origins makes it a signal.
 * The cost is real and is recorded in the report under P2: **a broken YouTube
 * embed or a broken blog webview is now invisible to the smoke suite.** Third
 * party events are printed rather than dropped, so a person reading the log can
 * still see them.
 *
 * "resmon's own" is: the renderer's static server and the backend, both on
 * `127.0.0.1`, plus messages with no source URL at all — which is what a
 * `page.evaluate` raises and what an uncaught exception with no script origin
 * reports.
 */
export function isOwnOrigin(url: string): boolean {
  if (url === '' || url.startsWith(':')) return true;
  return url.startsWith('http://127.0.0.1:');
}

export function ensureScreenshotDir(): string {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return SCREENSHOT_DIR;
}
