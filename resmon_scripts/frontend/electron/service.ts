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
  sleep(ms: number): Promise<void>;
  log(line: string): void;
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

/** How long a service that is starting is given to answer: a migration after an update can take minutes. */
export const START_WAIT_MS = 180_000;
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
    world.log('The background service is starting; waiting for it to answer.');
    facts = await settle(world, startWait, (f) => decide(f, me).act !== 'wait');
    decision = decide(facts, me);
    // Still starting, past the wait: started once more from the top.
    if (decision.act === 'wait') decision = { act: 'replace', rewrite: false, active: null };
  }
  switch (decision.act) {
    case 'none':
      return { done: 'nothing', why: decision.why };
    case 'blocked':
      world.log('macOS has turned resmon off in the background; the service cannot start.');
      return { done: 'blocked' };
    case 'kick': {
      world.releaseLock();
      if (!(await world.kickstart())) return { done: 'failed', why: 'launchctl kickstart failed' };
      return answered(world, me, startWait);
    }
    case 'start': {
      world.releaseLock();
      if (decision.rewrite && !(await world.rewrite(facts.unit?.port ?? null))) {
        return { done: 'failed', why: 'the unit could not be written again' };
      }
      return started(world, me, startWait);
    }
    case 'replace': {
      if (decision.active && !(await world.askToRestart(decision.active))) return { done: 'kept' };
      world.releaseLock();
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
