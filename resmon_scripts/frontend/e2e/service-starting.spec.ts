/**
 * A launch that waits for a background service still starting says so: a
 * small window, "resmon is starting", with why it can take minutes, shown once
 * the wait has lasted a moment, and gone when the service opens its window.
 *
 * launchd is the suite's stand-in (`fake_launchctl.py`) holding a test label,
 * and the unit is written into the spec's own unit folder, so nothing here asks
 * about, starts, or stops the service of the person running it. The service
 * itself is this checkout's app with `--service`, started by the spec as
 * launchd would start it, on a free port and the spec's own state folder.
 * macOS only: the check at launch is the Mac's (`CHECKS_SERVICE` in `main.ts`).
 *
 * Each step is logged with the time it began (`SERVICE STARTING 14:45:16.204
 * +1.6 s …`) and held to a time of its own, inside the test's, so a run that
 * stalls fails with a sentence naming the step, followed by what both launches
 * wrote and where the hand-over stood. Whatever state a test stops in, its
 * teardown stops both apps, the engine each started, and anything else on the
 * test's profile, in bounded time.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, type ChildProcess } from 'child_process';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { ATLAS_LANDMARK, FRONTEND_ROOT, SCREENSHOT_DIR, atlasEnv, launchEnv } from './fixtures/resmon-app';
import { removeStateDir } from './fixtures/cleanup';

test.describe.configure({ mode: 'serial' });
test.skip(process.platform !== 'darwin', 'The check of the service at launch is the Mac\'s.');

const LABEL = 'com.resmon.e2e';
/** What the waiting launch says once it has asked the service for the window (`handOver` in `main.ts`). */
const ASKED = '[service] Asked the resmon that holds the profile for the window';
/** Kept back from each test's timeout for its teardown: the service's quit alone can take 20 s (`before-quit`). */
const TEARDOWN_MS = 60_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** A launchd job held by the stand-in, loaded with a process, and a unit that starts this checkout's app as the service. */
function startingService(stateDir: string, env: Record<string, string>, port: number): { calls: () => string[][] } {
  const unitDir = env.RESMON_SERVICE_UNIT_DIR!;
  fs.mkdirSync(unitDir, { recursive: true });
  const exe = path.join(FRONTEND_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  fs.writeFileSync(path.join(unitDir, `${LABEL}.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${exe}</string><string>--service</string><string>--port=${port}</string></array>
</dict></plist>
`);
  const state = path.join(stateDir, 'fake-launchctl.json');
  fs.writeFileSync(state, JSON.stringify({ loaded: { [LABEL]: 4242 } }));
  env.FAKE_LAUNCHCTL_STATE = state;
  return { calls: () => (JSON.parse(fs.readFileSync(state, 'utf8')) as { calls?: string[][] }).calls ?? [] };
}

/** Whether every call to launchd was a question: a wait, never a start or a stop. */
function onlyAsked(calls: string[][]): boolean {
  return calls.every(([command]) => command === 'print' || command === 'print-disabled');
}

/** The window that says resmon is starting: the launch's one page that is not the renderer's. */
function startingWindow(app: ElectronApplication, timeout: number): Promise<Page> {
  const found = app.windows().find((page) => page.url().startsWith('data:'));
  return found ? Promise.resolve(found) : app.waitForEvent('window', { predicate: (page) => page.url().startsWith('data:'), timeout });
}

/** The launch's exit code, once it has exited: from its process, which stays readable once the app has closed. */
function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Stop a launch where it is (SIGSTOP), as a launch slow to exit would be; false when it has already exited. */
function hold(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return false;
  try { process.kill(child.pid, 'SIGSTOP'); return true; } catch { return false; }
}

/** Let a held launch go on (SIGCONT); true when it was told to. */
function release(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try { process.kill(child.pid, 'SIGCONT'); return true; } catch { return false; }
}

/**
 * A test's steps, each logged with when it began and held to a time of its
 * own and to the test's, less the time kept for teardown: a stall fails the
 * step it is in, with a sentence that names it, while there is still time to
 * put everything away. `run` is given the step's time, for a Playwright wait
 * to be held to it as well, so a launch that times out is stopped by
 * Playwright itself.
 */
function stepsWithin(testTimeoutMs: number): {
  say: (line: string) => void;
  step: <T>(what: string, limitMs: number, run: (ms: number) => Promise<T>) => Promise<T>;
} {
  const begun = Date.now();
  const deadline = begun + testTimeoutMs - TEARDOWN_MS;
  const since = (): string => `${((Date.now() - begun) / 1000).toFixed(1)} s`;
  const say = (line: string): void => {
    console.log(`SERVICE STARTING ${new Date().toISOString().slice(11, 23)} +${since()} ${line}`);
  };
  const step = async <T>(what: string, limitMs: number, run: (ms: number) => Promise<T>): Promise<T> => {
    const ms = Math.max(1_000, Math.min(limitMs, deadline - Date.now()));
    say(what);
    const work = run(ms);
    // A step given up on may still settle later, with nobody waiting for it.
    work.catch(() => { /* reported below while the step is waited for */ });
    const begunStep = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Stalled at "${what}": not done after `
        + `${Math.round((Date.now() - begunStep) / 1000)} s, ${since()} into the test.`)), ms + 5_000);
    });
    try {
      return await Promise.race([work, stalled]);
    } catch (error) {
      // The step's own error, its message led by the step it failed in.
      if (error instanceof Error && !error.message.startsWith('Stalled at ')) {
        const named = `Failed at "${what}", ${since()} into the test: ${error.message}`;
        if (error.stack?.includes(error.message)) error.stack = error.stack.replace(error.message, named);
        error.message = named;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  return { say, step };
}

/** What a launch writes, from the moment it is up: stdout alone, and stdout and stderr as they came. */
function capture(app: ElectronApplication): { out: () => string; all: () => string } {
  const out: string[] = [];
  const all: string[] = [];
  const child = app.process();
  child.stdout?.on('data', (chunk: Buffer) => { out.push(chunk.toString()); all.push(chunk.toString()); });
  child.stderr?.on('data', (chunk: Buffer) => { all.push(chunk.toString()); });
  return { out: () => out.join(''), all: () => all.join('') };
}

/** Print what a launch wrote, its last part when it wrote a lot. */
function tell(who: string, text: string): void {
  const kept = text.length > 16_000 ? text.slice(-16_000) : text;
  const part = kept.length < text.length ? ` (the last ${kept.length} of ${text.length} characters)` : '';
  console.log(`SERVICE STARTING ${who} WROTE${part}:\n${kept.trimEnd() || '(nothing)'}`);
}

/** A process's command line, with this checkout's and the profile's long paths named, so its own words show. */
function short(command: string, profileDir: string): string {
  const named = command.split(profileDir).join('<profile>').split(FRONTEND_ROOT).join('<frontend>');
  return named.length > 400 ? `${named.slice(0, 400)}…` : named;
}

/** Where the hand-over stood: what launchd was asked, the service's engine lock, and which process holds the profile. */
function tellState(stateDir: string, profileDir: string, port: number, calls: () => string[][]): void {
  const read = (what: () => unknown): unknown => { try { return what(); } catch (error) { return `unreadable: ${String(error)}`; } };
  console.log(`SERVICE STARTING STATE ${JSON.stringify({
    launchdAsked: read(() => calls().length),
    launchdToldTo: read(() => calls().filter((call) => !onlyAsked([call]))),
    engineLock: read(() => (fs.existsSync(path.join(stateDir, 'daemon.lock')) ? fs.readFileSync(path.join(stateDir, 'daemon.lock'), 'utf8').trim() : null)),
    // Chromium's lock is a link to "<host>-<pid>", which names nothing on the disk.
    profileHeldBy: read(() => (fs.lstatSync(path.join(profileDir, 'SingletonLock'), { throwIfNoEntry: false })
      ? fs.readlinkSync(path.join(profileDir, 'SingletonLock')) : null)),
    running: read(() => [...startedBy([], profileDir, port)].map(([pid, command]) => `${pid} ${short(command, profileDir)}`)),
  })}`);
}

interface Proc { pid: number; ppid: number; command: string }

function processes(): Proc[] {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 10_000 }).split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((found): found is RegExpExecArray => !!found)
    .map((found) => ({ pid: Number(found[1]), ppid: Number(found[2]), command: found[3]! }));
}

/**
 * The processes a test started, which only it started: the apps it launched
 * and everything under them (the engine each started, Chromium's helpers),
 * resmon on its own profile (any launch on it, whoever started it), and the
 * service's engine on its own port, which outlives an app that was killed.
 */
function startedBy(apps: number[], profileDir: string, port: number): Map<number, string> {
  const all = processes();
  const under = new Map<number, Proc[]>();
  for (const proc of all) {
    const siblings = under.get(proc.ppid);
    if (siblings) siblings.push(proc);
    else under.set(proc.ppid, [proc]);
  }
  const found = new Map<number, string>();
  const queue = all.filter(({ pid }) => apps.includes(pid));
  while (queue.length > 0) {
    const proc = queue.shift()!;
    if (found.has(proc.pid)) continue;
    found.set(proc.pid, proc.command);
    queue.push(...(under.get(proc.pid) ?? []));
  }
  for (const { pid, command } of all) {
    const words = command.split(/\s+/);
    const engine = words.includes('implementation_scripts.daemon') && words.includes(String(port));
    if (command.includes(profileDir) || engine) found.set(pid, command);
  }
  found.delete(process.pid);
  return found;
}

/** Those of `procs` still running, as the same command (a pid is not taken for another's). */
function stillRunning(procs: Map<number, string>): Map<number, string> {
  const now = new Map(processes().map(({ pid, command }) => [pid, command]));
  return new Map([...procs].filter(([pid, command]) => now.get(pid) === command));
}

/**
 * resmon processes still running on this spec's own profile, which only this
 * spec started: the app's own processes, not the Chromium helpers under them.
 */
function leftOn(profileDir: string): { pid: number; command: string }[] {
  return processes().filter(({ command }) => command.includes(profileDir) && !command.includes('--type='));
}

/** A launched app, and its process, which stays readable once the app has closed. */
interface Launched { app: ElectronApplication; child: ChildProcess }

/**
 * Stop what a test started, within about 45 s, whatever state it stopped in.
 * Each app is quit as a person quits it, which stops the service's engine
 * first (`before-quit`); whatever is still running after that is killed and
 * named.
 */
async function putAway(apps: Launched[], profileDir: string, port: number): Promise<void> {
  const running = (): number[] => apps.map(({ child }) => child)
    .filter((child) => child.exitCode === null && child.signalCode === null && child.pid !== undefined)
    .map((child) => child.pid!);
  const seen = startedBy(running(), profileDir, port);
  await Promise.all(apps.map(({ app }) => Promise.race([app.close().catch(() => { /* gone */ }), sleep(30_000)])));
  for (const [pid, command] of startedBy(running(), profileDir, port)) seen.set(pid, command);
  // A helper can outlive its app's exit by a moment; it is given that moment.
  let left = stillRunning(seen);
  for (let tries = 0; tries < 25 && left.size > 0; tries++) {
    await sleep(200);
    left = stillRunning(left);
  }
  for (const [pid, command] of left) {
    console.log(`SERVICE STARTING LEFT A PROCESS ${pid} (${short(command, profileDir)}); stopped.`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (let tries = 0; tries < 50 && left.size > 0; tries++) {
    await sleep(200);
    left = stillRunning(left);
  }
  for (const [pid, command] of left) console.log(`SERVICE STARTING COULD NOT STOP ${pid} (${short(command, profileDir)}).`);
}

test('a launch waiting for a starting service says resmon is starting, and goes once the service opens its window', async () => {
  test.setTimeout(300_000);
  const { say, step } = stepsWithin(300_000);
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-service-starting-')));
  const port = await freePort();
  expect(port).not.toBe(8742);
  const env = atlasEnv(launchEnv(stateDir, true));
  env.RESMON_SERVICE_AT_LAUNCH = '1';
  env.RESMON_DAEMON_PORT = String(port);
  delete env.RESMON_DISABLE_SCHEDULER;
  const launchd = startingService(stateDir, env, port);
  const profileDir = path.join(stateDir, 'electron-user-data');
  const profile = `--user-data-dir=${profileDir}`;

  const apps: Launched[] = [];
  const wrote: { who: string; all: () => string }[] = [];
  let held = false;
  let passed = false;
  try {
    const waiting = await step(`the waiting launch starts, on port ${port} and ${stateDir}`, 90_000,
      (ms) => electron.launch({ args: ['.', profile], cwd: FRONTEND_ROOT, env, timeout: ms }));
    const waitingProcess = waiting.process();
    apps.push({ app: waiting, child: waitingProcess });
    const fromWaiting = capture(waiting);
    wrote.push({ who: 'THE WAITING LAUNCH', all: fromWaiting.all });
    // Once it has asked the service for the window, the waiting launch is held
    // where it is, as a launch slow to exit would be (one took a minute under
    // load): the window must not wait for it to go.
    waitingProcess.stdout?.on('data', () => {
      if (!held && fromWaiting.out().includes(ASKED)) held = hold(waitingProcess);
    });
    say(`the waiting launch is up, pid ${waitingProcess.pid}`);

    const page = await step('the waiting launch shows the starting window', 60_000, (ms) => startingWindow(waiting, ms));
    say('the starting window is open; checking its words');
    await expect(page.getByRole('heading', { name: 'resmon is starting' })).toBeVisible();
    await expect(page.locator('body')).toContainText('Waiting for its background service to finish starting.');
    await expect(page.locator('body')).toContainText('updates the database that holds your collection, which can take a few minutes');
    await expect(page.locator('body')).toContainText('Before it changes anything, it keeps a copy of the database in the same folder, if the disk has room.');
    // All of it in the window, none cut off at the bottom.
    expect(await step('the starting window is measured', 15_000,
      () => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight))).toBe(true);
    await expect(page.locator('body')).toContainText('This window closes when resmon opens.');
    await expect.poll(() => fromWaiting.out(), { timeout: 15_000 }).toContain('[service] Showing that resmon is starting (starting)');
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await step('the starting window is pictured', 30_000,
      (ms) => page.screenshot({ path: path.join(SCREENSHOT_DIR, 'service-starting-window.png'), timeout: ms }));
    const cg = (await step('the starting window names its window-server window', 15_000,
      () => waiting.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMediaSourceId() ?? ''))).split(':')[1];
    try {
      if (cg) execFileSync('screencapture', ['-x', '-o', `-l${cg}`, path.join(SCREENSHOT_DIR, 'service-starting-window-framed.png')], { timeout: 20_000 });
    } catch {
      console.log('SERVICE STARTING NOT CAPTURED — screencapture could not take the window; its frame is not pictured by this run.');
    }
    // A wait, never a stop: nothing but questions has gone to launchd.
    expect(onlyAsked(launchd.calls())).toBe(true);

    // The service answers, as launchd would have started it: the launch asks it for the window and goes, and the service opens the window.
    const serviceEnv = { ...env };
    delete serviceEnv.RESMON_SERVICE_AT_LAUNCH;
    const service = await step('the service starts', 90_000,
      (ms) => electron.launch({ args: ['.', '--service', `--port=${port}`, profile], cwd: FRONTEND_ROOT, env: serviceEnv, timeout: ms }));
    apps.push({ app: service, child: service.process() });
    const fromService = capture(service);
    wrote.push({ who: 'THE SERVICE', all: fromService.all });
    say(`the service is up, pid ${service.process().pid}`);
    // A step each, so a stall names which side of the hand-over it is on.
    await step('the service\'s engine answers', 120_000,
      (ms) => expect.poll(() => fromService.out(), { timeout: ms }).toContain('[main] The service is running'));
    await step('the waiting launch sees the service answer, and asks it for the window', 60_000,
      (ms) => expect.poll(() => fromWaiting.out(), { timeout: ms }).toContain(ASKED));
    expect(fromWaiting.out()).toContain('[service] At launch: {"done":"started"}');
    say(held ? 'the waiting launch is held where it is' : 'the waiting launch exited before it could be held');
    const opened = await step('the service opens its window', 60_000, (ms) => service.firstWindow({ timeout: ms }));
    if (held) held = !release(waitingProcess);
    await step('the service\'s window draws Atlas', 60_000, (ms) => opened.locator(ATLAS_LANDMARK).waitFor({ timeout: ms }));
    expect(await step('the service\'s window names its engine\'s port', 15_000,
      () => opened.evaluate(() => (window as unknown as { resmonAPI: { getBackendPort(): string } }).resmonAPI.getBackendPort())))
      .toBe(String(port));
    expect(await step('the waiting launch exits', 120_000, () => exited(waitingProcess))).toBe(0);
    expect(onlyAsked(launchd.calls())).toBe(true);
    // Nothing else on the profile: no launch was started again to pass the request on.
    say('the service is the one resmon on the profile');
    await expect.poll(() => leftOn(profileDir).filter(({ pid }) => pid !== service.process().pid), { timeout: 30_000 }).toEqual([]);
    say('done');
    passed = true;
  } finally {
    if (!passed) {
      for (const { who, all } of wrote) tell(who, all());
      tellState(stateDir, profileDir, port, launchd.calls);
    }
    if (held && apps[0]) release(apps[0].child);
    say('putting away what the test started');
    await putAway(apps, profileDir, port);
    removeStateDir(stateDir);
  }
});

test('closing the starting window stops waiting, and leaves the service starting', async () => {
  test.setTimeout(180_000);
  const { say, step } = stepsWithin(180_000);
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-e2e-service-starting-')));
  const port = await freePort();
  expect(port).not.toBe(8742);
  const env = atlasEnv(launchEnv(stateDir, true));
  env.RESMON_SERVICE_AT_LAUNCH = '1';
  env.RESMON_DAEMON_PORT = String(port);
  const launchd = startingService(stateDir, env, port);
  const profileDir = path.join(stateDir, 'electron-user-data');
  const profile = `--user-data-dir=${profileDir}`;

  const apps: Launched[] = [];
  let fromWaiting: { all: () => string } | null = null;
  let passed = false;
  try {
    const waiting = await step(`the waiting launch starts, on port ${port} and ${stateDir}`, 90_000,
      (ms) => electron.launch({ args: ['.', profile], cwd: FRONTEND_ROOT, env, timeout: ms }));
    const waitingProcess = waiting.process();
    apps.push({ app: waiting, child: waitingProcess });
    fromWaiting = capture(waiting);
    say(`the waiting launch is up, pid ${waitingProcess.pid}`);
    const page = await step('the waiting launch shows the starting window', 60_000, (ms) => startingWindow(waiting, ms));
    await expect(page.getByRole('heading', { name: 'resmon is starting' })).toBeVisible();
    await step('the starting window is closed', 15_000,
      () => waiting.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); }));
    expect(await step('the waiting launch stops waiting and exits', 30_000, () => exited(waitingProcess))).toBe(0);
    expect(onlyAsked(launchd.calls())).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'daemon.lock'))).toBe(false);
    say('done');
    passed = true;
  } finally {
    if (!passed) {
      if (fromWaiting) tell('THE WAITING LAUNCH', fromWaiting.all());
      tellState(stateDir, profileDir, port, launchd.calls);
    }
    say('putting away what the test started');
    await putAway(apps, profileDir, port);
    removeStateDir(stateDir);
  }
});
