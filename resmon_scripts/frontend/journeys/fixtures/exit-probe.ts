/**
 * What is still holding this worker open after its last case.
 *
 * A Playwright worker exits when its event loop has nothing left in it. When
 * something is left, the runner waits five minutes and then prints
 * `worker-0 process did not exit within 300000ms after stop, force-killed it`
 * — one line, after the last case, naming nothing. This suite has now spent two
 * CI rounds reading that line, so instead of guessing at the cause a third
 * time, this asks the runtime what it is holding and writes the answer down.
 *
 * The mechanism is the same trick the answer usually is: an **unref'd** timer.
 * An unref'd timer does not itself keep the loop alive, so if the worker is
 * healthy the process exits before this ever fires and the probe costs nothing
 * and prints nothing. If the worker is stuck, the loop is alive for some other
 * reason, the timer fires, and every fire lists what `process._getActiveHandles`
 * and `process._getActiveRequests` hold: constructor name, and whichever of
 * `fd`, `pid`, `spawnargs`, `address` and the ref'd flag that kind of handle
 * has. A child process shows its argv; a socket shows its fd and peer.
 *
 * It writes to the screenshot directory as well as to stdout, because stdout
 * from a worker the runner has already told to stop may not reach the report,
 * and the screenshot directory is the one thing CI uploads on every run.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Where a run's evidence goes — the same directory the row screenshots use. */
function evidenceDir(): string {
  return process.env.RESMON_JOURNEY_SCREENSHOT_DIR
    ? path.resolve(process.env.RESMON_JOURNEY_SCREENSHOT_DIR)
    : path.join(__dirname, '..', 'screenshots');
}

interface Described {
  kind: string;
  detail: string;
}

/** One handle, in as much detail as its kind carries. */
function describe(handle: unknown): Described {
  const any = handle as Record<string, any>;
  const kind = (any?.constructor?.name as string) || typeof handle;
  const parts: string[] = [];
  const add = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return;
    parts.push(`${label}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  };
  try {
    add('fd', any.fd ?? any._handle?.fd);
    add('pid', any.pid);
    if (Array.isArray(any.spawnargs)) add('spawnargs', any.spawnargs.join(' ').slice(0, 300));
    add('exitCode', any.exitCode);
    add('signalCode', any.signalCode);
    add('killed', any.killed);
    if (typeof any.address === 'function') {
      const address = any.address();
      if (address) add('address', address);
    }
    add('remote', any.remoteAddress ? `${any.remoteAddress}:${any.remotePort}` : undefined);
    add('local', any.localAddress ? `${any.localAddress}:${any.localPort}` : undefined);
    add('destroyed', any.destroyed);
    if (typeof any.hasRef === 'function') add('refd', any.hasRef());
    else if (any._handle && typeof any._handle.hasRef === 'function') add('refd', any._handle.hasRef());
  } catch (error) {
    parts.push(`(could not be described: ${(error as Error).message})`);
  }
  return { kind, detail: parts.join(' ') };
}

function snapshot(label: string): string {
  const internals = process as unknown as {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  const handles = internals._getActiveHandles ? internals._getActiveHandles() : [];
  const requests = internals._getActiveRequests ? internals._getActiveRequests() : [];
  const lines = [
    `[journeys] EXIT PROBE ${label}: ${handles.length} active handle(s), ${requests.length} active request(s)`,
  ];
  for (const handle of handles) {
    const { kind, detail } = describe(handle);
    lines.push(`[journeys] EXIT PROBE   handle ${kind} ${detail}`.trimEnd());
  }
  for (const request of requests) {
    const { kind, detail } = describe(request);
    lines.push(`[journeys] EXIT PROBE   request ${kind} ${detail}`.trimEnd());
  }
  return lines.join('\n');
}

/**
 * Arm the probe. Call once, when the worker has no more work to do.
 *
 * Nothing here holds the loop open: the timer is unref'd, and the file is
 * written synchronously so a half-written report cannot be the thing that
 * outlives the process.
 */
export function armExitProbe(): void {
  // `RESMON_JOURNEY_EXIT_PROBE=off` turns it off. It is on by default because a
  // healthy worker never reaches the first fire — the timer is unref'd, so the
  // process exits first and the log gains nothing — and the one run where it
  // does fire is the run somebody needs it in.
  if ((process.env.RESMON_JOURNEY_EXIT_PROBE || '').trim().toLowerCase() === 'off') return;
  const began = Date.now();
  let fires = 0;
  const report = path.join(evidenceDir(), 'exit-probe.txt');
  const timer = setInterval(() => {
    fires += 1;
    const text = snapshot(`+${Math.round((Date.now() - began) / 1000)}s after the last case`);
    console.log(text);
    try {
      fs.mkdirSync(path.dirname(report), { recursive: true });
      fs.appendFileSync(report, `${text}\n`);
    } catch { /* evidence is best-effort; never the reason a run fails */ }
    // Six fires is half a minute, which is long enough to show whether the set
    // is shrinking on its own or is simply stuck.
    if (fires >= 6) clearInterval(timer);
  }, 5_000);
  timer.unref();
}
