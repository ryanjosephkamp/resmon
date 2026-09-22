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
import { execFileSync } from 'child_process';
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

/**
 * How long one backend request may take before the suite says so.
 *
 * Generous — a runner is slower than a laptop and a restore is real work — but
 * finite, and short enough that the failure arrives inside the per-case budget
 * with the method and route in the message rather than after it with nothing.
 */
const API_DEADLINE_MS = 60_000;

/** How long to ask Electron to quit before insisting. See `put()`. */
const CLOSE_DEADLINE_MS = 45_000;

/**
 * How long a close may go on running after the Electron process itself has
 * exited before this calls it what it is.
 *
 * Playwright resolves `close()` on the child's `'close'` event, which Node
 * emits only once the process has exited **and** every one of its stdio pipes
 * has been closed. A descendant that inherited those pipes and outlived the
 * quit therefore holds `close()` open indefinitely — with the Electron process
 * already dead. Three seconds is far longer than the gap between `'exit'` and
 * `'close'` on a healthy quit and far shorter than waiting out the deadline for
 * something that is never going to arrive.
 */
const ORPHAN_GRACE_MS = 3_000;

/**
 * The process group this pid leads, or null if it does not lead one.
 *
 * **Asked while the process is alive.** Asking afterwards is what made the
 * first version of the group kill a no-op on the runner: by the time the close
 * had gone wrong the Electron process had already exited and been reaped, so
 * `ps -p <pid>` found nothing, the guard said "not a leader", and the log read
 * `killed pid 4933 was already gone` — neither the group nor the pid. The
 * answer has to be taken at launch and kept.
 */
function groupLedBy(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    return pgid === pid ? pgid : null;
  } catch {
    // No answer is not a yes.
    return null;
  }
}

/** A timer that cannot itself be the reason this process stays alive. */
function after(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });
}

/**
 * SIGKILL an Electron process **and everything it started**.
 *
 * Playwright spawns the app `detached` on every platform but Windows, which
 * makes it the leader of its own process group — and `kill(-pid)` then reaches
 * the whole group: the renderer, the GPU and zygote processes, the crash
 * handler, and the backend the app spawned. That is the difference that
 * matters. Killing the pid alone leaves those children alive holding the
 * inherited stdout and stderr pipes, so Node never emits `'close'`, the
 * `readline` interfaces Playwright wrapped around those pipes stay ref'd, and
 * the worker cannot exit. Returns what it managed to do, for the log.
 */
function killTree(pid: number | undefined, group: number | null): string {
  const attempts: string[] = [];
  // `kill(-g)` means "the process group whose id is g", so this only ever uses
  // a group the operating system confirmed at launch. Guessing one would be
  // aiming a SIGKILL at a group that might be this worker's.
  if (process.platform !== 'win32' && group) {
    try { process.kill(-group, 'SIGKILL'); attempts.push(`group -${group}`); } catch { /* nothing left in it */ }
  }
  if (pid) {
    try { process.kill(pid, 'SIGKILL'); attempts.push(`pid ${pid}`); } catch { /* already reaped */ }
  }
  return attempts.length ? attempts.join(' and ') : 'nothing: the group and the pid were both already gone';
}

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
  /** Every close this session had to force. Empty is the expected answer. */
  forcedCloses(): string[];
  /**
   * Remove this path when the session ends.
   *
   * `/api/backup` and the configuration export write where the app's own
   * `export_directory` setting points, which in a fresh state is the system
   * temp directory — outside the state directory and outside this session's
   * cleanup. Each J41 run was leaving a corpus snapshot on the machine.
   */
  alsoRemoveOnClose(target: string): void;
  /** Close the app, stop the authored source, and remove everything this session made. */
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
  /** The backend child of the app currently running, so a forced close can reach it. */
  let backendPid: number | null = null;
  /** The process group the running app leads, recorded while it is alive to lead one. */
  let appGroup: number | null = null;
  /** Every close that had to be forced. Empty is the expected answer. */
  const forced: string[] = [];
  /** Paths outside the state directory that this session created and must remove. */
  const alsoRemove: string[] = [];

  const bring = async (): Promise<void> => {
    app = await electron.launch({
      args: ['.', `--user-data-dir=${path.join(stateDir, 'electron-user-data')}`],
      cwd: root.frontend,
      env,
      timeout: 180_000,
    });
    // While it is alive: a dead process leads no group, and this is the only
    // moment the question has an answer.
    appGroup = groupLedBy(app.process()?.pid);
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
    // The window being up is not the backend being ready. `init_db` runs at
    // startup and takes a write lock, and a request sent into that window can
    // wait on it for as long as the caller is willing to wait — which for a
    // `fetch` inside `evaluate` is the whole test. Waiting for one successful
    // health call here is what turns that into a bounded, legible failure.
    await expect.poll(async () => win.evaluate(async () => {
      try {
        const backend = (window as unknown as { resmonAPI: { getBackendPort(): string } })
          .resmonAPI.getBackendPort();
        const response = await e2eFetch(`http://127.0.0.1:${backend}/api/health`);
        return response.ok;
      } catch {
        return false;
      }
    }), { timeout: 120_000 }).toBe(true);
    // Recorded here because a forced close needs it and a dead backend cannot
    // be asked for it.
    backendPid = await win.evaluate(async () => {
      const backend = (window as unknown as { resmonAPI: { getBackendPort(): string } })
        .resmonAPI.getBackendPort();
      const health = await (await e2eFetch(`http://127.0.0.1:${backend}/api/health`)).json();
      return Number(health.pid) || null;
    });
  };

  /**
   * Close the app, and be certain it is gone.
   *
   * **`ElectronApplication.close()` has no deadline of its own.** It resolves
   * when Electron has quit, and if Electron does not quit it never resolves at
   * all — which is a test that hits its wall-clock budget with no assertion
   * error and no Playwright call log, followed by
   * `worker-0 process did not exit within 300000ms after stop`. That pair of
   * symptoms cost a CI round to read, because nothing in the stack named the
   * step it was stuck in.
   *
   * So the close is raced against two things rather than one.
   *
   * The first is the deadline. The second is the failure this suite actually
   * had, which the deadline alone could only wait out: **the Electron process
   * exits and `close()` still does not return.** Playwright resolves `close()`
   * on the child's `'close'` event, and Node emits that only when the process
   * has exited *and* every stdio pipe it was given has been closed by everyone
   * holding it. Electron's own children — renderer, GPU, zygote, crash handler
   * — inherit those pipes, so one of them outliving the quit is enough to leave
   * `close()` pending forever over a process that is already dead. That is what
   * ran out this suite's per-case budget on a runner and then held the worker
   * open for the runner's full 300 seconds, twice.
   *
   * Either way the answer is the same and it is `killTree`, not a bigger
   * number: kill the app's whole process group, so nothing is left holding a
   * pipe, `'close'` fires, and the streams Playwright wrapped around it end.
   *
   * A harness force-quitting an app it launched itself is legitimate, so this
   * does not fail the row: the row is about the journey, not about Electron's
   * shutdown. It is *recorded* instead. `forcedCloses()` reports it, the line
   * below prints it, and the handback carries the count. Silence would be the
   * only wrong answer.
   */
  const put = async (): Promise<void> => {
    const owned = app?.process();
    const child = backendPid;
    const group = appGroup;
    const gone = (): boolean => !owned || owned.exitCode !== null || owned.signalCode !== null;

    /**
     * Close **our** end of the app's stdout and stderr.
     *
     * This is the line that actually frees the worker, and it took two rounds
     * to see why. Everything else here tries to make the *other* end let go:
     * kill the app, kill its group, kill the backend. On an Ubuntu runner under
     * `xvfb-run` that is not enough — some Chromium helper keeps the write end
     * whatever this does, and the probe went on listing `Socket fd=23` and
     * `Socket fd=25`, ref'd and undestroyed, thirty seconds after the last
     * case. Those two sockets are this process's read ends of the app's stdout
     * and stderr, and this process can simply destroy them. A destroyed socket
     * leaves the active-handle set no matter who else holds the pipe, so the
     * worker's exit stops depending on the good behaviour of processes it did
     * not start.
     *
     * Only ever after the exit has been observed: these are the streams
     * Playwright reads the app's output from, and closing them early would
     * discard output a live app was still producing.
     */
    const dropOurEndOfItsStdio = (): void => {
      for (const stream of [owned?.stdout, owned?.stderr, owned?.stdin]) {
        try { stream?.destroy(); } catch { /* already destroyed, which is the usual case */ }
      }
    };

    // Start the close and **keep the promise**. Racing it and walking away was
    // the first attempt, and it moved the symptom rather than removing it: the
    // row passed in 57 s and the run still failed, because an abandoned
    // `close()` leaves Playwright holding an Electron application it believes
    // is open, and the worker then waits 300 s for it at teardown — reported as
    // `worker-0 process did not exit within 300000ms after stop`. The close has
    // to be finished, not dropped.
    let settled = false;
    const closing = app.close()
      .catch(() => { /* already gone */ })
      .then(() => { settled = true; });

    /** Wait for whichever comes first: the close, the deadline, or an exited process. */
    const outcome = await (async (): Promise<'closed' | 'deadline' | 'exited-but-open'> => {
      const began = Date.now();
      let exitedAt: number | null = null;
      while (Date.now() - began < CLOSE_DEADLINE_MS) {
        if (settled) return 'closed';
        if (gone()) {
          exitedAt ??= Date.now();
          if (Date.now() - exitedAt >= ORPHAN_GRACE_MS) return 'exited-but-open';
        } else {
          exitedAt = null;
        }
        await after(200);
      }
      return settled ? 'closed' : 'deadline';
    })();

    if (outcome !== 'closed' || !gone()) {
      const why = outcome === 'exited-but-open'
        ? `the app exited but close() stayed pending for ${ORPHAN_GRACE_MS} ms, so something it started still held its pipes`
        : outcome === 'deadline'
          ? `close() did not return within ${CLOSE_DEADLINE_MS} ms`
          : 'close() resolved but the process was still there';
      const killed = killTree(owned?.pid, group);
      forced.push(`${why}; killed ${killed}`);
      console.log(`[journeys] FORCED CLOSE: ${forced[forced.length - 1]}`);
      // Then stop depending on anyone else. Whatever the group kill did or did
      // not reach, the read ends are ours to close, and closing them is also
      // what lets Node emit the `'close'` Playwright has been waiting on.
      // Still bounded: a tidy-up is not worth a second hang.
      dropOurEndOfItsStdio();
      await Promise.race([closing, after(30_000)]);
    }

    // The backend is a grandchild: `main.ts` sends it a SIGTERM on `before-quit`
    // and does not wait, so a backend that will not take a SIGTERM outlives the
    // app that spawned it and goes on holding the state directory this session
    // is about to reuse or delete. Cheap to make certain of, every time.
    if (child) {
      try { process.kill(child, 'SIGKILL'); } catch { /* already gone, which is the usual case */ }
    }

    if (!owned) return;
    await expect
      .poll(gone, { timeout: 60_000, message: 'the app did not exit even after being SIGKILLed' })
      .toBe(true);
    // Every path, forced or not, and only now that the exit is a fact. A clean
    // quit leaves these ended already and this is a no-op; the point is that
    // there is no path off this function that leaves them open.
    dropOurEndOfItsStdio();
    backendPid = null;
    appGroup = null;
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
      async ([m, r, b, ms]) => {
        const backend = (window as unknown as { resmonAPI: { getBackendPort(): string } })
          .resmonAPI.getBackendPort();
        // A deadline of its own. Without one, a backend that never answers —
        // holding a write lock, say — is waited on for as long as the caller
        // will wait, which inside `evaluate` is the whole test. That produces a
        // bare "test timeout exceeded" naming no step, which is the shape this
        // suite spent a CI round failing to read.
        const response = await e2eFetch(`http://127.0.0.1:${backend}${r as string}`, {
          method: m as string,
          headers: { 'Content-Type': 'application/json' },
          body: b === undefined ? undefined : JSON.stringify(b),
          signal: AbortSignal.timeout(ms as number),
        }).catch((error) => {
          throw new Error(
            `${m} ${r} did not answer within ${ms} ms (${(error as Error).name}). `
            + 'The backend was reachable enough to be asked and did not reply.',
          );
        });
        const text = await response.text();
        let parsed: unknown = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        if (!response.ok) {
          throw new Error(`${m} ${r} answered HTTP ${response.status}: ${text.slice(0, 400)}`);
        }
        return parsed;
      },
      [method, route, body, API_DEADLINE_MS] as const,
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
      await put();
      await bring();
    },

    relaunchOverFreshState: async () => {
      await put();
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-journey-restored-'));
      stateDirs.push(stateDir);
      env = envFor(stateDir, root, source.url);
      registerStateDir(stateDir);
      await bring();
    },

    // Every state directory this session has used, not only the current one:
    // a run that reached the internet from the first of them still counts.
    refused: () => stateDirs.flatMap((dir) => blockedConnections(dir)),

    forcedCloses: () => [...forced],

    alsoRemoveOnClose: (target: string) => { alsoRemove.push(target); },

    close: async () => {
      // Printed either side of every step. The suite has twice now had a hang
      // whose only evidence was a 300-second wall; a teardown that stops
      // halfway should say which half.
      console.log('[journeys] teardown: closing the app');
      await put().catch(() => { /* already gone */ });
      console.log('[journeys] teardown: stopping the authored source');
      await source.close().catch(() => { /* already closed */ });
      console.log('[journeys] teardown: removing what this session made');
      for (const dir of stateDirs) fs.rmSync(dir, { recursive: true, force: true });
      for (const target of alsoRemove) fs.rmSync(target, { recursive: true, force: true });
      console.log(`[journeys] teardown: done${forced.length ? `; ${forced.length} forced close(s)` : ''}`);
    },
  };

  return session;
}
