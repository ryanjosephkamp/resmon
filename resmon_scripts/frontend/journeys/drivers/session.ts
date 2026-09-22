/**
 * One launched resmon, of whichever build is under test.
 *
 * A driver is the part that knows what a screen looks like. This is the part
 * underneath it that knows nothing about screens: which build to start, where
 * its state lives, how to ask its backend a question, how to kill it and how to
 * start it again over the same state. Both drivers share it, which is what
 * makes "the only difference between the two runs is two environment variables"
 * true rather than aspirational.
 *
 * **`RESMON_JOURNEY_APP`** is the `frontend/` directory of the build under
 * test, already built (`npm run build` there). This file builds nothing: a
 * suite that built its target would be measuring its own build script, and the
 * point of the classic leg is to run against an artifact somebody else
 * produced.
 *
 * **The interpreter is this checkout's, on purpose.** The app spawns
 * `<python> <target>/resmon_scripts/resmon.py`, and the interpreter only has to
 * have `requirements.txt` installed — it is not part of the build under test.
 * Resolving it from the target would mean every target needed its own `.venv`,
 * which the classic CI leg does not have.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  appRootAt, launchEnv, registerStateDir, THIS_CHECKOUT,
} from '../../e2e/fixtures/resmon-app';
import type { AppRoot } from '../../e2e/fixtures/resmon-app';
import {
  blockedConnections, startSourceEndpoint, writeStartupHook,
} from '../fixtures/source-endpoint';
import type { SourceEndpoint, SourceReply } from '../fixtures/source-endpoint';

/** The build under test: `RESMON_JOURNEY_APP`, or the checkout this suite lives in. */
export function targetAppRoot(): AppRoot {
  const configured = (process.env.RESMON_JOURNEY_APP || '').trim();
  if (!configured) return THIS_CHECKOUT;
  const root = appRootAt(configured);
  if (!fs.existsSync(path.join(root.frontend, 'package.json'))) {
    throw new Error(
      `RESMON_JOURNEY_APP is "${configured}", which has no package.json. It must be the ` +
      'frontend/ directory of an already-built resmon checkout.',
    );
  }
  if (!fs.existsSync(path.join(root.frontend, 'dist', 'electron', 'main.js'))) {
    throw new Error(
      `RESMON_JOURNEY_APP is "${configured}", which has no dist/electron/main.js. ` +
      'Run `npm run build` there first — this suite launches a build, it does not make one.',
    );
  }
  return root;
}

export interface Session {
  readonly app: ElectronApplication;
  readonly win: Page;
  readonly stateDir: string;
  readonly root: AppRoot;
  /** The port this app's own backend answers on. Never 8742. */
  readonly port: string;
  /** The authored source this journey was given. */
  readonly source: SourceEndpoint;
  /** The interpreter the backend of the build under test is running under. */
  readonly python: string;
  /** `fetch` against this app's backend, with this app's token, from the renderer. */
  api<T = any>(method: string, route: string, body?: unknown): Promise<T>;
  /** Kill the backend process the app spawned, as a force-quit of the machine would. */
  killBackend(): Promise<number>;
  /** Close the window and open it again over the same state directory. */
  relaunch(): Promise<void>;
  /** Move to a brand-new, empty state directory and launch over that. */
  relaunchOverFreshState(): Promise<void>;
  /** Everything this run's guard refused. */
  refused(): { host: string; port: number }[];
  close(): Promise<void>;
}

function envFor(stateDir: string, root: AppRoot, sourceUrl: string): Record<string, string> {
  const env = launchEnv(stateDir, true);
  const hookDir = writeStartupHook({ stateDir, repoRoot: root.repo, sourceUrl });
  env.PYTHONPATH = [hookDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  env.PYTHONDONTWRITEBYTECODE = '1';
  // No OS keyring: a journey must never read or write the person's real
  // credentials, and on a runner every keyring call is a timeout anyway.
  env.PYTHON_KEYRING_BACKEND = 'keyring.backends.null.Keyring';
  env.RESMON_KEYRING_TIMEOUT = '2.0';
  // A proxy would make the guard's "loopback only" untrue by routing loopback
  // requests off the machine.
  env.NO_PROXY = '127.0.0.1,localhost';
  env.no_proxy = env.NO_PROXY;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[key];
  }
  return env;
}

export async function startSession(options: { sourceReply: SourceReply }): Promise<Session> {
  const root = targetAppRoot();
  const source = await startSourceEndpoint(options.sourceReply);
  let stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-journey-'));
  // Every state directory this session has used, so a journey that moves to a
  // fresh one (a restore) does not leave the first behind on the machine.
  const stateDirs = [stateDir];
  let env = envFor(stateDir, root, source.url);
  registerStateDir(stateDir);

  let app!: ElectronApplication;
  let win!: Page;
  let port = '';

  const bring = async (): Promise<void> => {
    app = await electron.launch({
      args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
      cwd: root.frontend,
      env,
      timeout: 180_000,
    });
    win = await app.firstWindow({ timeout: 180_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.locator('.app-main').waitFor({ state: 'visible', timeout: 90_000 });
    port = await win.evaluate(
      () => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort(),
    );
    // B3, asserted on every launch rather than trusted: 8742 is a live daemon
    // over somebody's real corpus, and a suite that only *usually* avoids it is
    // a suite that will one day write to it.
    expect(port, 'a journey must never attach to the live daemon').not.toBe('8742');
    expect(port).toMatch(/^\d+$/);
  };

  await bring();

  const session: Session = {
    get app() { return app; },
    get win() { return win; },
    get stateDir() { return stateDir; },
    get port() { return port; },
    root,
    source,
    get python() { return env.RESMON_PYTHON; },

    api: async <T,>(method: string, route: string, body?: unknown): Promise<T> => win.evaluate(
      async ([m, r, b]) => {
        const backend = (window as unknown as { resmonAPI: { getBackendPort(): string } })
          .resmonAPI.getBackendPort();
        const response = await e2eFetch(`http://127.0.0.1:${backend}${r as string}`, {
          method: m as string,
          headers: { 'Content-Type': 'application/json' },
          body: b === undefined ? undefined : JSON.stringify(b),
        });
        const text = await response.text();
        let parsed: unknown = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        if (!response.ok) {
          throw new Error(`${m} ${r} answered HTTP ${response.status}: ${text.slice(0, 400)}`);
        }
        return parsed;
      },
      [method, route, body] as const,
    ) as Promise<T>,

    killBackend: async () => {
      const health = await session.api<{ pid: number }>('GET', '/api/health');
      process.kill(health.pid, 'SIGKILL');
      // The row must still say `running` until a later start reconciles it, so
      // wait for the process itself rather than for anything on screen.
      await expect.poll(() => {
        try { process.kill(health.pid, 0); return true; } catch { return false; }
      }, { timeout: 30_000 }).toBe(false);
      return health.pid;
    },

    relaunch: async () => {
      await app.close().catch(() => { /* already gone */ });
      await bring();
    },

    relaunchOverFreshState: async () => {
      await app.close().catch(() => { /* already gone */ });
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-journey-restored-'));
      stateDirs.push(stateDir);
      env = envFor(stateDir, root, source.url);
      registerStateDir(stateDir);
      await bring();
    },

    // Every state directory this session has used, not only the current one:
    // a run that reached the internet from the first of them still counts.
    refused: () => stateDirs.flatMap((dir) => blockedConnections(dir)),

    close: async () => {
      await app.close().catch(() => { /* already gone */ });
      await source.close().catch(() => { /* already closed */ });
      for (const dir of stateDirs) fs.rmSync(dir, { recursive: true, force: true });
    },
  };

  return session;
}
