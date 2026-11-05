/**
 * Removing the folders a test made, once the test is over.
 *
 * A launch's state folder holds the engine's database and logs and Chromium's
 * profile, and the processes writing them do not all stop the moment the app's
 * close resolves: the engine, Electron, and Chromium's helper processes can
 * still be writing into the folder for a moment after. A recursive removal that
 * meets one of those writes fails with ENOTEMPTY (EBUSY or EPERM on Windows),
 * and a failure there would turn a test whose assertions all passed red in its
 * teardown. So the removal is retried, and if it still cannot finish, the folder
 * is named on one line and left: every folder passed here is one the suite made
 * under the system's temporary folder, so one left behind costs disk space, not
 * the result of the test.
 *
 * Only for teardown, and only after the app's close has resolved. A removal that
 * is part of what a test does, or whose failure should fail the test, calls
 * `fs.rmSync` itself.
 */
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type { ElectronApplication } from '@playwright/test';

export function removeStateDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    console.warn(`[e2e] could not remove ${dir}: ${code}; left for the system to clear`);
  }
}

interface Proc { pid: number; ppid: number; command: string }

function processes(): Proc[] {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 10_000 }).split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((found): found is RegExpExecArray => !!found)
    .map((found) => ({ pid: Number(found[1]), ppid: Number(found[2]), command: found[3]! }));
}

/** A process and everything under it, by pid, with each one's command line. */
function treeOf(pid: number): Map<number, string> {
  const all = processes();
  const found = new Map<number, string>();
  const queue = all.filter((proc) => proc.pid === pid);
  while (queue.length > 0) {
    const proc = queue.shift()!;
    if (found.has(proc.pid)) continue;
    found.set(proc.pid, proc.command);
    queue.push(...all.filter(({ ppid }) => ppid === proc.pid));
  }
  return found;
}

/** Those of `procs` still running, as the same command (a pid is not taken for another's). */
function stillRunning(procs: Map<number, string>): Map<number, string> {
  const now = new Map(processes().map(({ pid, command }) => [pid, command]));
  return new Map([...procs].filter(([pid, command]) => now.get(pid) === command));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Close a launched app in bounded time, whatever state it is in: quit as a
 * person quits it, which stops the engine it started, and given `closeMs` for
 * that. Whatever it started that is still running some seconds later (the
 * engine, a map fit under it, Chromium's helpers) is killed and named on a line
 * led by `prefix`. The app's processes are listed before it is asked to quit,
 * because an engine whose app was killed is no longer under it. Off Windows;
 * there the close alone is bounded.
 */
export async function closeWithin(app: ElectronApplication, prefix: string, closeMs = 30_000): Promise<void> {
  const pid = app.process().pid;
  let started = new Map<number, string>();
  if (pid !== undefined && process.platform !== 'win32') {
    try { started = treeOf(pid); } catch { /* ps did not answer; the close is still bounded */ }
  }
  const closed = await Promise.race([
    app.close().then(() => true, () => true),
    sleep(closeMs).then(() => false),
  ]);
  if (!closed) console.log(`${prefix} THE APP DID NOT CLOSE within ${Math.round(closeMs / 1000)} s; stopping what it started.`);
  if (started.size === 0) return;
  // The engine is told to stop as the app quits, and may take a moment more than the app to go.
  let left = stillRunning(started);
  for (let tries = 0; tries < 50 && left.size > 0; tries++) {
    await sleep(200);
    left = stillRunning(left);
  }
  for (const [leftPid, command] of left) {
    console.log(`${prefix} LEFT A PROCESS ${leftPid} (${command.length > 300 ? `${command.slice(0, 300)}…` : command}); stopped.`);
    try { process.kill(leftPid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (let tries = 0; tries < 25 && left.size > 0; tries++) {
    await sleep(200);
    left = stillRunning(left);
  }
  for (const [leftPid, command] of left) console.log(`${prefix} COULD NOT STOP ${leftPid} (${command.slice(0, 300)}).`);
}
