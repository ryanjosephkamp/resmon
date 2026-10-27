/**
 * Launch, navigation, memory and idle CPU of the real app.
 *
 * Written to measure any build of resmon -- today's interface and the one that
 * replaces it -- with the same yardstick, so it knows nothing about either
 * one's markup. It knows three things: how to start the app in isolation, the
 * hash of each route, and when a page has *settled*.
 *
 * **Settled** is: every request the page started since the clock began has
 * finished, and the DOM has not changed for `QUIET_MS`. The time reported is
 * the moment of the last DOM change, not the end of the quiet window, so the
 * wait itself is not counted. Requests are watched by wrapping `fetch` and
 * `XMLHttpRequest` in an init script; one still open after `LONG_LIVED_MS` is a
 * stream or a long poll and stops gating. A request that changed nothing on
 * screen gates the wait but does not move the time.
 *
 * Every number is specific to the machine it was taken on. `python -m perf`
 * records which machine.
 */
import { test, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { allRouteHashes } from '../src/routes';

const QUIET_MS = 600;

/** Three entries in the shape of the site's Atom feed, so the Blog tab draws a list without the network. */
const FIXED_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>resmon</title>
  <updated>2026-10-27T00:00:00Z</updated>
  <id>https://ryanjosephkamp.github.io/resmon/</id>
  ${[1, 2, 3].map((n) => `<entry>
    <title>Update ${n}</title>
    <link href="https://ryanjosephkamp.github.io/resmon/updates/${n}/"/>
    <id>https://ryanjosephkamp.github.io/resmon/updates/${n}/</id>
    <updated>2026-10-2${n}T00:00:00Z</updated>
    <summary>A fixed entry served by the performance harness.</summary>
  </entry>`).join('\n')}
</feed>`;
const LONG_LIVED_MS = 10_000;
const SETTLE_TIMEOUT_MS = 90_000;
const SERVICE_PORT = '8742';

interface Settle {
  settledAt: number;
  lastMutation: number;
  requests: number;
  timedOut: boolean;
  instrumented: boolean;
}

interface RunSample {
  launchCold: number;
  launchWarm: number;
  firstWindowCold: number;
  navigation: Record<string, number>;
  memoryMb: Record<string, number>;
  idleCpuPercent: Record<string, number>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run this through python -m perf`);
  return value;
}

/**
 * The instrumentation, installed in every document before the app's own code.
 *
 * A string, because it runs in the renderer, not here. It is idempotent so a
 * second install in the same document is a no-op.
 */
const INSTRUMENT = `(() => {
  if (window.__resmonPerf) return;
  const s = { inflight: new Map(), next: 0, lastMutation: 0, requests: 0 };
  window.__resmonPerf = s;
  const begin = () => { const id = ++s.next; s.inflight.set(id, Date.now()); s.requests++; return id; };
  const end = (id) => { s.inflight.delete(id); };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const id = begin();
    return realFetch(input, init).then((response) => {
      // The body is what the page waits for, so the request ends when a copy
      // of it has been read, not when the headers arrive.
      response.clone().arrayBuffer().then(() => end(id), () => end(id));
      return response;
    }, (error) => { end(id); throw error; });
  };
  const RealXHR = window.XMLHttpRequest;
  const send = RealXHR.prototype.send;
  RealXHR.prototype.send = function (...args) {
    const id = begin();
    this.addEventListener('loadend', () => end(id));
    return send.apply(this, args);
  };
  new MutationObserver(() => { s.lastMutation = Date.now(); })
    .observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
})();`;

/** Wait until the page settles after `since` (epoch ms); see the file header. */
async function settle(win: Page, since: number): Promise<Settle> {
  return win.evaluate(async ({ since, quiet, longLived, timeout }) => {
    type PerfState = { inflight: Map<number, number>; lastMutation: number; requests: number };
    const s = (window as unknown as { __resmonPerf?: PerfState }).__resmonPerf;
    const deadline = Date.now() + timeout;
    for (;;) {
      const now = Date.now();
      if (s) {
        let gating = 0;
        for (const started of s.inflight.values()) {
          if (started >= since && now - started < longLived) gating += 1;
        }
        const lastMutation = Math.max(s.lastMutation, since);
        const hasContent = (document.body?.innerText ?? '').trim().length > 40;
        if (gating === 0 && hasContent && document.readyState === 'complete' && now - lastMutation >= quiet) {
          return { settledAt: lastMutation, lastMutation, requests: s.requests, timedOut: false, instrumented: true };
        }
      }
      if (now > deadline) {
        return { settledAt: now, lastMutation: s ? s.lastMutation : 0, requests: s ? s.requests : 0,
                 timedOut: true, instrumented: Boolean(s) };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, { since, quiet: QUIET_MS, longLived: LONG_LIVED_MS, timeout: SETTLE_TIMEOUT_MS });
}

function cloneFile(src: string, dst: string): void {
  if (process.platform === 'darwin') {
    try {
      execFileSync('cp', ['-c', src, dst]);
      return;
    } catch { /* not APFS; copy below */ }
  }
  fs.copyFileSync(src, dst);
}

function isolatedEnv(state: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !key.startsWith('RESMON_') ) env[key] = value;
  }
  // The same isolation as e2e/fixtures/resmon-app.ts: every state path pinned,
  // the null keyring (a local run once erased someone's real keys), and a
  // fixed window size so a run on a large display and a small one draw the
  // same page. RESMON_E2E also keeps a packaged build off the update feed.
  Object.assign(env, {
    RESMON_STATE_DIR: state,
    RESMON_DB_PATH: path.join(state, 'resmon.db'),
    RESMON_REPORTS_DIR: path.join(state, 'reports'),
    RESMON_PORT_FILE: path.join(state, 'resmon.port'),
    PYTHON_KEYRING_BACKEND: 'keyring.backends.null.Keyring',
    RESMON_E2E: '1',
    RESMON_E2E_WIDTH: '1440',
    RESMON_E2E_HEIGHT: '900',
  });
  for (const key of ['RESMON_BACKGROUND_WINDOW', 'RESMON_PYTHON']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

async function launch(state: string): Promise<{ app: ElectronApplication; win: Page; started: number; firstWindow: number }> {
  const executable = process.env.RESMON_PERF_EXECUTABLE;
  const frontend = process.env.RESMON_PERF_FRONTEND || path.resolve(__dirname, '..');
  const userData = `--user-data-dir=${path.join(state, 'electron-user-data')}`;
  const started = Date.now();
  const app = executable
    ? await electron.launch({ executablePath: executable, args: [userData], env: isolatedEnv(state), timeout: 180_000 })
    : await electron.launch({ args: ['.', userData], cwd: frontend, env: isolatedEnv(state), timeout: 180_000 });
  await app.context().addInitScript(INSTRUMENT);
  // Nothing the app's pages ask of the internet is answered by the internet:
  // the Blog tab's feed gets a fixed local one, and anything else is refused
  // as if the machine were offline. Only https is routed -- the backend is
  // plain http on loopback -- so no API call pays for an interception.
  await app.context().route('https://**', (route) => {
    if (route.request().url().endsWith('/feed.xml')) {
      return route.fulfill({ status: 200, contentType: 'application/atom+xml', body: FIXED_FEED });
    }
    return route.abort('internetdisconnected');
  });
  const win = await app.firstWindow({ timeout: 180_000 });
  const firstWindow = Date.now();
  const port = await win.evaluate(async () => {
    type Bridge = { getBackendPort?: () => number | string | null };
    const bridge = (window as unknown as { resmonAPI?: Bridge }).resmonAPI;
    for (let i = 0; i < 600; i += 1) {
      const value = bridge?.getBackendPort?.();
      if (value) return String(value);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return '';
  });
  if (port === SERVICE_PORT) {
    await app.close();
    throw new Error('the app attached to the installed service port; refusing');
  }
  return { app, win, started, firstWindow };
}

function processTree(root: number): { pid: number; rssMb: number; cpuS: number; role: string }[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8' });
  const rows = out.split('\n').map((line) => line.trim().split(/\s+/)).filter((p) => p.length >= 5);
  const children = new Map<number, number[]>();
  const info = new Map<number, { rss: number; cpu: number; command: string }>();
  for (const [pid, ppid, rss, time, ...command] of rows) {
    const p = Number(pid);
    children.set(Number(ppid), [...(children.get(Number(ppid)) ?? []), p]);
    info.set(p, { rss: Number(rss), cpu: cpuSeconds(time), command: command.join(' ') });
  }
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return [...seen].filter((pid) => info.has(pid)).map((pid) => {
    const { rss, cpu, command } = info.get(pid) as { rss: number; cpu: number; command: string };
    return { pid, rssMb: rss / 1024, cpuS: cpu, role: role(command) };
  });
}

function cpuSeconds(value: string): number {
  let days = 0;
  let rest = value;
  if (rest.includes('-')) {
    const [d, r] = rest.split('-');
    days = Number(d);
    rest = r;
  }
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function role(command: string): string {
  const c = command.toLowerCase();
  if (c.includes('resmon.py') || c.includes('implementation_scripts.daemon')) return 'backend';
  if (c.includes('--type=renderer')) return 'renderer';
  if (c.includes('--type=gpu-process')) return 'gpu';
  if (c.includes('--type=utility')) return 'utility';
  if (c.includes('--type=')) return 'helper';
  return 'main';
}

function byRole(rows: { role: string; value: number }[]): Record<string, number> {
  const out: Record<string, number> = { total: 0 };
  for (const { role: r, value } of rows) {
    out[r] = (out[r] ?? 0) + value;
    out.total += value;
  }
  return out;
}

test('launch, navigation and resources', async () => {
  const runs = Number(process.env.RESMON_PERF_RUNS || '5');
  const corpus = required('RESMON_PERF_CORPUS');
  const outFile = required('RESMON_PERF_OUT');
  const work = process.env.RESMON_PERF_WORK || fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-perf-'));
  const idleSeconds = Number(process.env.RESMON_PERF_IDLE_SECONDS || '20');
  const routes = allRouteHashes();
  const samples: RunSample[] = [];
  const problems: string[] = [];

  for (let run = 0; run < runs; run += 1) {
    const state = path.join(work, `ui-${run}`);
    fs.rmSync(state, { recursive: true, force: true });
    fs.mkdirSync(state, { recursive: true });
    cloneFile(corpus, path.join(state, 'resmon.db'));

    // Cold: a fresh Chromium profile and a database this app has never opened.
    let { app, win, started, firstWindow } = await launch(state);
    const coldStarted = started;
    const cold = await settle(win, 0);
    if (!cold.instrumented) problems.push(`run ${run}: the first document was not instrumented`);
    if (cold.timedOut) problems.push(`run ${run}: the first screen did not settle`);
    await app.close();

    // Warm: the same profile and database, launched again.
    ({ app, win, started } = await launch(state));
    const warm = await settle(win, 0);
    if (warm.timedOut) problems.push(`run ${run}: the warm first screen did not settle`);

    const navigation: Record<string, number> = {};
    // Every route, from wherever the previous one left the app, then back to
    // the first, so the first is measured as a navigation too.
    const order = [...routes.slice(1), routes[0]];
    for (const route of order) {
      const since = await win.evaluate((hash) => {
        const t = Date.now();
        window.location.hash = hash;
        return t;
      }, route.hash);
      const result = await settle(win, since);
      if (result.timedOut) problems.push(`run ${run}: ${route.hash} did not settle`);
      navigation[route.hash] = result.settledAt - since;
    }

    // Idle: the app as a person leaves it, on its first screen.
    await win.waitForTimeout(10_000);
    const root = app.process().pid as number;
    const memory = byRole(processTree(root).map((p) => ({ role: p.role, value: p.rssMb })));
    const before = new Map(processTree(root).map((p) => [p.pid, p.cpuS]));
    await win.waitForTimeout(idleSeconds * 1000);
    const cpu = byRole(processTree(root).map((p) => ({
      role: p.role, value: (100 * (p.cpuS - (before.get(p.pid) ?? p.cpuS))) / idleSeconds,
    })));
    await app.close();

    samples.push({
      launchCold: cold.settledAt - coldStarted,
      launchWarm: warm.settledAt - started,
      firstWindowCold: firstWindow - coldStarted,
      navigation,
      memoryMb: memory,
      idleCpuPercent: cpu,
    });
    fs.writeFileSync(outFile, JSON.stringify({ routes, samples, problems }, null, 2));
  }
  fs.writeFileSync(outFile, JSON.stringify({ routes, samples, problems }, null, 2));
});
