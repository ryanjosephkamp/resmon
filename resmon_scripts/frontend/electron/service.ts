/**
 * The background service, made sure of when a person opens resmon on a Mac.
 *
 * An installed service is a launchd job that runs this app with `--service`.
 * Three things used to leave it off with nothing said, and a window running its
 * own engine with the scheduler off, so no watch fired:
 *
 *   - the job was not loaded, after the app was replaced, and only
 *     `launchctl bootstrap` in Terminal brought it back;
 *   - the job ran another build of the same version, which kept the single-
 *     instance lock, so the new build handed over to the old one;
 *   - a window opened while the job was between restarts held that lock, and
 *     launchd started the service every ten seconds only for it to find resmon
 *     running and quit.
 *
 * At each launch, once, this reads the unit, asks launchd, and asks the engine
 * the service runs; then it starts, restarts, or replaces the service so that
 * this build's service runs, asking first when runs are in progress, and the
 * app hands over to it, which opens the window. It never takes over a service
 * that runs another copy of resmon still on the disk, and never points the
 * service at a copy running from a disk image or a download.
 *
 * The decision is a function of facts (`decide`), and the steps take a `World`
 * that `main.ts` makes from launchctl, the unit file, and the engine, so every
 * state is tested without launchd (`tests/serviceAtLaunch.test.ts`).
 */

/** What launchd says about the service's label. */
export interface Job {
  loaded: boolean;
  /** The job's process, or null while launchd waits to start it again. */
  pid: number | null;
  /** macOS's Allow in the Background has turned it off; launchd will not start it. */
  disabled: boolean;
}

/** The installed unit: what it starts, read from its ProgramArguments. */
export interface Unit {
  /** The program the unit starts: this app's executable, another copy's, or Python. */
  program: string | null;
  /** True when the unit starts the app (`--service`), false for a bare engine. */
  runsApp: boolean;
  /** `--port=N` in the unit, kept when the unit is written again. */
  port: number | null;
}

/** The engine the service runs, as its lock and health describe it. */
export interface Running {
  build: string | null;
  version: string | null;
  /** Runs in progress on it, or null when it did not say. */
  active: number | null;
}

/** This launch. */
export interface Me {
  /** This app's executable. */
  exe: string;
  build: string;
  /** True when this copy runs from a disk image or a download, which will not be there next time. */
  temporary: boolean;
}

export interface Facts {
  unit: Unit | null;
  job: Job;
  running: Running | null;
  /** Whether the program the unit names is still on the disk. */
  programExists: boolean;
}

export type Decision =
  | { act: 'none'; why: 'no-unit' | 'ours' | 'another-copy' | 'temporary' }
  | { act: 'blocked' }
  | { act: 'start'; rewrite: boolean }
  | { act: 'kick' }
  | { act: 'wait' }
  | { act: 'replace'; rewrite: boolean; active: number | null };

/** What to do about the service, from what is known now. */
export function decide(facts: Facts, me: Me): Decision {
  const { unit, job, running } = facts;
  if (!unit) return { act: 'none', why: 'no-unit' };
  if (job.disabled) return { act: 'blocked' };
  const mine = unit.program === me.exe;
  if (!mine && facts.programExists && unit.runsApp) return { act: 'none', why: 'another-copy' };
  // The unit must start this copy: it names a copy that is gone, or the bare
  // engine, whose notifications come from Script Editor rather than resmon.
  const rewrite = !mine || !unit.runsApp;
  if (rewrite && me.temporary) return { act: 'none', why: 'temporary' };
  if (!job.loaded) return { act: 'start', rewrite };
  if (running) {
    if (!rewrite && running.build === me.build) return { act: 'none', why: 'ours' };
    return { act: 'replace', rewrite, active: running.active };
  }
  // Loaded and not answering. With no process, launchd is waiting out its ten
  // seconds after the service quit (it found resmon running); with one, the
  // service may be starting, a migration included, so it is given time.
  if (job.pid === null) return rewrite ? { act: 'replace', rewrite, active: null } : { act: 'kick' };
  return { act: 'wait' };
}

/** The effects the steps need; `main.ts` makes one from launchctl, the unit file, and the engine. */
export interface World {
  facts(): Promise<Facts>;
  /** Stop the job and wait until launchd lets it go; false when it did not. */
  bootout(): Promise<boolean>;
  bootstrap(): Promise<{ ok: boolean; said: string }>;
  kickstart(): Promise<boolean>;
  /** Write the unit again, to start this copy, keeping its port. */
  rewrite(port: number | null): Promise<boolean>;
  /** Ask the person whether to stop `active` runs to restart the service on this build. */
  askToRestart(active: number): Promise<boolean>;
  /** Let go of the single-instance lock, so the service can take it. */
  releaseLock(): void;
  /** Whether this launch holds the single-instance lock; when it does not, the resmon that does opens the window. */
  holdsLock(): boolean;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /**
   * A wait for the service to answer begins, which can last minutes: a service
   * that was already starting (`starting`), or one this launch just started or
   * restarted (`started`). `main.ts` shows a small window saying so, if the
   * wait lasts, until resmon opens.
   */
  waiting?(why: 'starting' | 'started'): void;
}

export type Outcome =
  /** Nothing was done: open as before. */
  | { done: 'nothing'; why: string }
  /** This build's service runs now: hand over to it, which opens the window. */
  | { done: 'started' }
  /** The person kept the running service. */
  | { done: 'kept' }
  | { done: 'blocked' }
  | { done: 'failed'; why: string };

/**
 * How long a service that is starting is given to answer, the same as an
 * engine this app starts itself (`main.ts`): a migration after an update can
 * take minutes. A service still starting after it is left alone, never stopped.
 */
export const START_WAIT_MS = 10 * 60_000;
/** How long a service with no process is left to launchd before it is started at once. */
const POLL_MS = 500;

/**
 * Make sure this build's service runs, if one is installed. Never more than
 * one start, restart, or replacement per call; `main.ts` calls it once per
 * launch.
 */
export async function ensureService(world: World, me: Me, startWait = START_WAIT_MS): Promise<Outcome> {
  let facts = await world.facts();
  let decision = decide(facts, me);
  if (decision.act === 'wait') {
    // A service with a process that does not answer yet is starting (a
    // migration after an update can take minutes) or busy, and is never
    // stopped for it. The resmon holding the lock opens the window once it
    // answers; a launch holding it lets it go, so the service can take it, and
    // waits.
    if (!world.holdsLock()) return { done: 'nothing', why: 'starting' };
    world.log('The background service is starting; waiting for it to answer.');
    letGo(world);
    world.waiting?.('starting');
    facts = await settle(world, startWait, (f) => decide(f, me).act !== 'wait');
    decision = decide(facts, me);
    if (decision.act === 'wait') return { done: 'nothing', why: 'starting' };
    // It answered, as this build: hand over to it.
    if (decision.act === 'none' && decision.why === 'ours') return { done: 'started' };
  }
  switch (decision.act) {
    case 'none':
      return { done: 'nothing', why: decision.why };
    case 'blocked':
      world.log('macOS has turned resmon off in the background; the service cannot start.');
      return { done: 'blocked' };
    case 'kick': {
      letGo(world);
      if (!(await world.kickstart())) return { done: 'failed', why: 'launchctl kickstart failed' };
      return answered(world, me, startWait);
    }
    case 'start': {
      letGo(world);
      if (decision.rewrite && !(await world.rewrite(facts.unit?.port ?? null))) {
        return { done: 'failed', why: 'the unit could not be written again' };
      }
      return started(world, me, startWait);
    }
    case 'replace': {
      if (decision.active && !(await world.askToRestart(decision.active))) return { done: 'kept' };
      letGo(world);
      if (!(await world.bootout())) return { done: 'failed', why: 'launchd did not stop the service' };
      if (decision.rewrite && !(await world.rewrite(facts.unit?.port ?? null))) {
        return { done: 'failed', why: 'the unit could not be written again' };
      }
      return started(world, me, startWait);
    }
    default:
      return { done: 'nothing', why: 'unknown' };
  }
}

/** Let go of the lock, if this launch holds it, so the service can take it. */
function letGo(world: World): void {
  if (world.holdsLock()) world.releaseLock();
}

async function started(world: World, me: Me, startWait: number): Promise<Outcome> {
  const begun = await world.bootstrap();
  if (!begun.ok) {
    const facts = await world.facts();
    if (facts.job.disabled) return { done: 'blocked' };
    return { done: 'failed', why: `launchctl bootstrap failed: ${begun.said}` };
  }
  return answered(world, me, startWait);
}

/** Wait for this build's service to answer. */
async function answered(world: World, me: Me, startWait: number): Promise<Outcome> {
  world.waiting?.('started');
  const facts = await settle(world, startWait, (f) => f.running?.build === me.build);
  if (facts.running?.build === me.build) {
    world.log('The background service runs this build.');
    return { done: 'started' };
  }
  return { done: 'failed', why: 'the service did not answer in time' };
}

async function settle(world: World, within: number, until: (facts: Facts) => boolean): Promise<Facts> {
  let facts = await world.facts();
  for (let waited = 0; !until(facts) && waited < within; waited += POLL_MS) {
    await world.sleep(POLL_MS);
    facts = await world.facts();
  }
  return facts;
}

// ---------------------------------------------------------------------------
// A launch that did not get the profile's lock
// ---------------------------------------------------------------------------

/**
 * How long a launch without the lock waits for this build's service to answer
 * after replacing an older one. A start that takes longer (a migration) is left
 * starting, never stopped: the launch relaunches, and the relaunch waits for it
 * with the starting window.
 */
export const HOLDER_WAIT_MS = 30_000;
/** How long the replaced service's process is given to exit, so that this build's can take the profile. */
export const HOLDER_EXIT_MS = 45_000;

export type HolderDecision =
  | { act: 'leave'; why: 'no-unit' | 'blocked' | 'another-copy' | 'not-app' | 'not-loaded' | 'unknown' | 'ours' | 'busy' }
  | { act: 'replace' };

/**
 * What a launch that did not get the profile's lock does about the resmon that
 * holds it. Electron gives such a launch no `ready`, so it can open no window
 * and ask nothing; the holder opened the window when this launch asked for the
 * lock. It replaces only an older build of this copy's service that says it
 * runs no runs. A service running runs is left: asking first needs a window, so
 * it is replaced at the first launch after its runs have finished.
 */
export function decideWithoutLock(facts: Facts, me: Me): HolderDecision {
  const { unit, job, running } = facts;
  if (!unit) return { act: 'leave', why: 'no-unit' };
  if (job.disabled) return { act: 'leave', why: 'blocked' };
  if (unit.program !== me.exe) return { act: 'leave', why: 'another-copy' };
  if (!unit.runsApp) return { act: 'leave', why: 'not-app' };
  if (!job.loaded || job.pid === null) return { act: 'leave', why: 'not-loaded' };
  if (!running || running.active === null) return { act: 'leave', why: 'unknown' };
  if (running.build === me.build) return { act: 'leave', why: 'ours' };
  if (running.active > 0) return { act: 'leave', why: 'busy' };
  return { act: 'replace' };
}

export type HolderOutcome =
  | { done: 'left'; why: Extract<HolderDecision, { act: 'leave' }>['why'] }
  /** This build's service answers. */
  | { done: 'replaced' }
  /** This build's service was started and has not answered yet; it is left starting. */
  | { done: 'starting' }
  | { done: 'failed'; why: string };

/** What `replaceHolder` needs beyond `World`: whether the replaced service's process has exited. */
export interface HolderWorld extends World {
  alive(pid: number): boolean;
}

/**
 * Replace an older build of this copy's idle service with this build's, for a
 * launch that did not get the profile's lock (`decideWithoutLock`). The job is
 * never left unloaded: a start that fails is tried once more, and a job found
 * unloaded after the wait is loaded again, so the person's watches go on.
 */
export async function replaceHolder(
  world: HolderWorld, me: Me, wait = HOLDER_WAIT_MS, exitWait = HOLDER_EXIT_MS,
): Promise<HolderOutcome> {
  const facts = await world.facts();
  const decision = decideWithoutLock(facts, me);
  if (decision.act === 'leave') return { done: 'left', why: decision.why };
  const old = facts.job.pid as number;
  world.log('Another build of this copy\'s service holds the profile and runs no runs; replacing it with this build.');
  if (!(await world.bootout())) return { done: 'failed', why: 'launchd did not stop the service' };
  let waited = 0;
  while (world.alive(old) && waited < exitWait) {
    await world.sleep(POLL_MS);
    waited += POLL_MS;
  }
  if (world.alive(old)) world.log(`The replaced service (pid ${old}) has not exited; this build's is started anyway.`);
  const begun = await world.bootstrap();
  if (!begun.ok) {
    world.log(`launchctl bootstrap failed (${begun.said}); trying once more.`);
    const again = await world.bootstrap();
    if (!again.ok) return { done: 'failed', why: `launchctl bootstrap failed: ${again.said}` };
  }
  const after = await settle(world, wait, (f) => f.running?.build === me.build);
  if (after.running?.build === me.build) {
    world.log('The background service runs this build.');
    return { done: 'replaced' };
  }
  if (!after.job.loaded) {
    const back = await world.bootstrap();
    if (!back.ok) return { done: 'failed', why: `the service was unloaded and could not be loaded again: ${back.said}` };
    world.log('The service was found unloaded after the replacement; it was loaded again.');
  }
  world.log('This build\'s service has not answered yet; it is left starting.');
  return { done: 'starting' };
}

/** The unit's program and port, from its ProgramArguments as `plutil -convert json` gives them. */
export function unitFromPlist(plist: unknown): Unit | null {
  if (!plist || typeof plist !== 'object') return null;
  const args = (plist as { ProgramArguments?: unknown }).ProgramArguments;
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return { program: null, runsApp: false, port: null };
  const words = args as string[];
  const flag = words.find((a) => a.startsWith('--port='));
  const port = flag ? Number(flag.slice('--port='.length)) : null;
  return {
    program: words[0] ?? null,
    runsApp: words.includes('--service'),
    port: port !== null && Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
  };
}

/** `launchctl print`'s pid line, or null. */
export function pidFromPrint(text: string): number | null {
  const found = /^\s*pid = (\d+)\s*$/m.exec(text);
  return found ? Number(found[1]) : null;
}

/** Whether `launchctl print-disabled` lists `label` as turned off. */
export function disabledIn(text: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${escaped}"\\s*=>\\s*(?:disabled|true)\\b`).test(text);
}

/** True for a copy running from a disk image or a download (`service_manager.runs_from_temporary_place`). */
export function temporaryPlace(exe: string): boolean {
  return exe.includes('/AppTranslocation/') || exe.startsWith('/Volumes/');
}
