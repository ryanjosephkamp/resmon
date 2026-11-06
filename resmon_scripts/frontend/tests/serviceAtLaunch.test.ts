/**
 * The background service at launch (`electron/service.ts`), in every state it
 * can be found in, against a launchd and an engine held in memory. No
 * launchctl is run and no label is addressed: `World` is the only way out.
 */
import {
  decide, decideWithoutLock, disabledIn, ensureService, pidFromPrint, replaceHolder, temporaryPlace, unitFromPlist,
  type Facts, type HolderWorld, type Job, type Me, type Running, type Unit, type World,
} from '../electron/service';

const EXE = '/Applications/resmon.app/Contents/MacOS/resmon';
const ME: Me = { exe: EXE, build: 'b-new', temporary: false };
const APP_UNIT: Unit = { program: EXE, runsApp: true, port: 8742 };

function facts(over: Partial<Facts> = {}): Facts {
  return {
    unit: APP_UNIT,
    job: { loaded: true, pid: 100, disabled: false },
    running: { build: 'b-new', version: '1.0.0', active: 0 },
    programExists: true,
    ...over,
  };
}

describe('what to do, from what is found', () => {
  test('no unit: nothing, as before', () => {
    expect(decide(facts({ unit: null }), ME)).toEqual({ act: 'none', why: 'no-unit' });
  });

  test('this build\'s service answering: nothing to do', () => {
    expect(decide(facts(), ME)).toEqual({ act: 'none', why: 'ours' });
  });

  test('turned off by macOS: said, never retried', () => {
    expect(decide(facts({ job: { loaded: false, pid: null, disabled: true } }), ME)).toEqual({ act: 'blocked' });
  });

  test('not loaded (the app was replaced): started', () => {
    expect(decide(facts({ job: { loaded: false, pid: null, disabled: false }, running: null }), ME))
      .toEqual({ act: 'start', rewrite: false });
  });

  test('another build of the same version running: replaced, with its runs counted', () => {
    expect(decide(facts({ running: { build: 'b-old', version: '1.0.0', active: 2 } }), ME))
      .toEqual({ act: 'replace', rewrite: false, active: 2 });
    // A build from before builds were named says none.
    expect(decide(facts({ running: { build: null, version: '1.0.0', active: 0 } }), ME))
      .toEqual({ act: 'replace', rewrite: false, active: 0 });
  });

  test('loaded with no process (launchd waiting out its ten seconds): started now', () => {
    expect(decide(facts({ job: { loaded: true, pid: null, disabled: false }, running: null }), ME)).toEqual({ act: 'kick' });
  });

  test('loaded with a process that does not answer yet: waited for', () => {
    expect(decide(facts({ running: null }), ME)).toEqual({ act: 'wait' });
  });

  test('a unit running the bare engine: written again to run the app, and replaced', () => {
    const engine: Unit = { program: '/usr/bin/python3', runsApp: false, port: 8742 };
    expect(decide(facts({ unit: engine, running: { build: null, version: '1.0.0', active: 0 } }), ME))
      .toEqual({ act: 'replace', rewrite: true, active: 0 });
  });

  test('a unit naming a copy that is gone: written again for this copy', () => {
    const moved: Unit = { program: '/Users/x/Downloads/resmon.app/Contents/MacOS/resmon', runsApp: true, port: 8742 };
    expect(decide(facts({ unit: moved, programExists: false, job: { loaded: false, pid: null, disabled: false }, running: null }), ME))
      .toEqual({ act: 'start', rewrite: true });
  });

  test('a unit naming another copy still on the disk: left to it', () => {
    const other: Unit = { program: '/Applications/Other/resmon.app/Contents/MacOS/resmon', runsApp: true, port: 8742 };
    expect(decide(facts({ unit: other, running: { build: 'b-old', version: '1.0.0', active: 0 } }), ME))
      .toEqual({ act: 'none', why: 'another-copy' });
  });

  test('this copy running from a disk image never becomes the service', () => {
    const moved: Unit = { program: '/gone/resmon.app/Contents/MacOS/resmon', runsApp: true, port: 8742 };
    const dmg: Me = { exe: '/Volumes/resmon/resmon.app/Contents/MacOS/resmon', build: 'b-new', temporary: true };
    expect(decide(facts({ unit: moved, programExists: false, running: null }), dmg)).toEqual({ act: 'none', why: 'temporary' });
  });
});

/** A launchd and an engine in memory, with every effect recorded. */
class FakeWorld implements World {
  calls: string[] = [];
  lines: string[] = [];
  answers = true;
  unit: Unit | null = APP_UNIT;
  job: Job = { loaded: true, pid: 100, disabled: false };
  running: Running | null = { build: 'b-old', version: '1.0.0', active: 0 };
  /** The build a start brings up; null for a service that never answers. */
  startsBuild: string | null = 'b-new';
  bootoutStops = true;
  bootstrapOk = true;
  /** Polls before a starting service answers. */
  slowStart = 0;
  private pendingStart = 0;
  /** Whether this launch holds the single-instance lock. */
  holding = true;
  /** The build a service already starting answers as, before anything restarts it. */
  private answersAs: string | null = null;

  async facts(): Promise<Facts> {
    if (this.pendingStart > 0) {
      this.pendingStart -= 1;
      if (this.pendingStart === 0) {
        const build = this.answersAs ?? this.startsBuild;
        this.answersAs = null;
        if (build) this.running = { build, version: '1.0.0', active: 0 };
      }
    }
    return { unit: this.unit, job: { ...this.job }, running: this.running && { ...this.running }, programExists: true };
  }

  private start(): void {
    this.job = { ...this.job, loaded: true, pid: 200 };
    this.running = null;
    this.pendingStart = this.slowStart + 1;
  }

  async bootout(): Promise<boolean> {
    this.calls.push('bootout');
    if (!this.bootoutStops) return false;
    this.job = { ...this.job, loaded: false, pid: null };
    this.running = null;
    return true;
  }

  async bootstrap(): Promise<{ ok: boolean; said: string }> {
    this.calls.push('bootstrap');
    if (!this.bootstrapOk || this.job.disabled) return { ok: false, said: 'Bootstrap failed: 5: Input/output error' };
    this.start();
    return { ok: true, said: '' };
  }

  async kickstart(): Promise<boolean> {
    this.calls.push('kickstart');
    this.start();
    return true;
  }

  async rewrite(port: number | null): Promise<boolean> {
    this.calls.push(`rewrite:${port}`);
    this.unit = { program: EXE, runsApp: true, port };
    return true;
  }

  async askToRestart(active: number): Promise<boolean> {
    this.calls.push(`ask:${active}`);
    return this.answers;
  }

  releaseLock(): void { this.calls.push('release'); this.holding = false; }
  holdsLock(): boolean { return this.holding; }
  /** A service already starting, whose process answers as `build` after `polls` polls; never, with null. */
  startingAs(build: string | null, polls: number): void {
    this.job = { loaded: true, pid: 300, disabled: false };
    this.running = null;
    this.answersAs = build;
    this.pendingStart = build === null ? 0 : polls;
  }
  async sleep(): Promise<void> { /* no time passes */ }
  log(line: string): void { this.lines.push(line); }
  /** Each wait said, for the window that says resmon is starting. */
  waits: string[] = [];
  waiting(why: 'starting' | 'started'): void { this.waits.push(why); }
}

describe('the steps taken, once per launch', () => {
  test('another build running with no runs: stopped, started on this build, handed over', async () => {
    const world = new FakeWorld();
    expect(await ensureService(world, ME)).toEqual({ done: 'started' });
    expect(world.calls).toEqual(['release', 'bootout', 'bootstrap']);
  });

  test('another build running runs: asked first, and kept when the person says so', async () => {
    const world = new FakeWorld();
    world.running = { build: 'b-old', version: '1.0.0', active: 3 };
    world.answers = false;
    expect(await ensureService(world, ME)).toEqual({ done: 'kept' });
    expect(world.calls).toEqual(['ask:3']);
  });

  test('asked and agreed: restarted on this build', async () => {
    const world = new FakeWorld();
    world.running = { build: 'b-old', version: '1.0.0', active: 1 };
    expect(await ensureService(world, ME)).toEqual({ done: 'started' });
    expect(world.calls).toEqual(['ask:1', 'release', 'bootout', 'bootstrap']);
  });

  test('not loaded: started without a terminal, and waited for through a slow first start', async () => {
    const world = new FakeWorld();
    world.job = { loaded: false, pid: null, disabled: false };
    world.running = null;
    world.slowStart = 50; // a migration after an update
    expect(await ensureService(world, ME)).toEqual({ done: 'started' });
    expect(world.calls).toEqual(['release', 'bootstrap']);
  });

  test('loaded with no process: started at once rather than in ten seconds', async () => {
    const world = new FakeWorld();
    world.job = { loaded: true, pid: null, disabled: false };
    world.running = null;
    expect(await ensureService(world, ME)).toEqual({ done: 'started' });
    expect(world.calls).toEqual(['release', 'kickstart']);
  });

  test('a service with a process that never answers is never stopped, however long it is waited for', async () => {
    const world = new FakeWorld();
    world.startingAs(null, 0);
    expect(await ensureService(world, ME, 5_000)).toEqual({ done: 'nothing', why: 'starting' });
    // The lock let go so the service could take it, and nothing more: no bootout, no kickstart.
    expect(world.calls).toEqual(['release']);
  });

  test('a service still starting while another resmon holds the lock: left to it, which opens the window', async () => {
    const world = new FakeWorld();
    world.startingAs(null, 0);
    world.holding = false;
    expect(await ensureService(world, ME)).toEqual({ done: 'nothing', why: 'starting' });
    expect(world.calls).toEqual([]);
  });

  test('a slow first start (a migration) that answers as this build: handed over, nothing stopped', async () => {
    const world = new FakeWorld();
    world.startingAs('b-new', 400); // over three minutes at half a second a poll
    expect(await ensureService(world, ME)).toEqual({ done: 'started' });
    expect(world.calls).toEqual(['release']);
  });

  test('a start that answers as another build: then asked about, as any other build is', async () => {
    const world = new FakeWorld();
    world.startingAs('b-old', 3);
    expect(await ensureService(world, ME)).toEqual({ done: 'started' });
    expect(world.calls).toEqual(['release', 'bootout', 'bootstrap']);
  });

  test('a stop launchd does not carry out: said, and nothing more is tried', async () => {
    const world = new FakeWorld();
    world.bootoutStops = false;
    expect(await ensureService(world, ME)).toEqual({ done: 'failed', why: 'launchd did not stop the service' });
    expect(world.calls).toEqual(['release', 'bootout']);
  });

  test('turned off by macOS: said, nothing started', async () => {
    const world = new FakeWorld();
    world.job = { loaded: false, pid: null, disabled: true };
    expect(await ensureService(world, ME)).toEqual({ done: 'blocked' });
    expect(world.calls).toEqual([]);
  });

  test('a service that never answers: failed after the wait, so the window opens on its own engine', async () => {
    const world = new FakeWorld();
    world.job = { loaded: false, pid: null, disabled: false };
    world.running = null;
    world.startsBuild = null;
    expect(await ensureService(world, ME, 5_000)).toEqual({ done: 'failed', why: 'the service did not answer in time' });
  });

  test('the bare engine\'s unit: written again with its port, then replaced', async () => {
    const world = new FakeWorld();
    world.unit = { program: '/usr/bin/python3', runsApp: false, port: 9001 };
    world.running = { build: null, version: '1.0.0', active: 0 };
    expect(await ensureService(world, ME)).toEqual({ done: 'started' });
    expect(world.calls).toEqual(['release', 'bootout', 'rewrite:9001', 'bootstrap']);
  });

  test('this build already running: nothing touched', async () => {
    const world = new FakeWorld();
    world.running = { build: 'b-new', version: '1.0.0', active: 4 };
    expect(await ensureService(world, ME)).toEqual({ done: 'nothing', why: 'ours' });
    expect(world.calls).toEqual([]);
  });
});

describe('a launch that did not get the profile\'s lock (Electron gives it no ready)', () => {
  test('an older build of this copy\'s service that runs no runs: replaced', () => {
    expect(decideWithoutLock(facts({ running: { build: 'b-old', version: '1.0.0', active: 0 } }), ME)).toEqual({ act: 'replace' });
    // A build from before builds were named says none.
    expect(decideWithoutLock(facts({ running: { build: null, version: '1.0.0', active: 0 } }), ME)).toEqual({ act: 'replace' });
  });

  test('this build\'s service: left, and it has the window', () => {
    expect(decideWithoutLock(facts(), ME)).toEqual({ act: 'leave', why: 'ours' });
  });

  test('a service running runs, or one that does not say: left, since asking needs a window', () => {
    expect(decideWithoutLock(facts({ running: { build: 'b-old', version: '1.0.0', active: 1 } }), ME))
      .toEqual({ act: 'leave', why: 'busy' });
    expect(decideWithoutLock(facts({ running: { build: 'b-old', version: '1.0.0', active: null } }), ME))
      .toEqual({ act: 'leave', why: 'unknown' });
    expect(decideWithoutLock(facts({ running: null }), ME)).toEqual({ act: 'leave', why: 'unknown' });
  });

  test('a unit naming another copy, the bare engine, or none: left alone', () => {
    const other: Unit = { program: '/Applications/Other/resmon.app/Contents/MacOS/resmon', runsApp: true, port: 8742 };
    expect(decideWithoutLock(facts({ unit: other, running: { build: 'b-old', version: '1.0.0', active: 0 } }), ME))
      .toEqual({ act: 'leave', why: 'another-copy' });
    const engine: Unit = { program: EXE, runsApp: false, port: 8742 };
    expect(decideWithoutLock(facts({ unit: engine, running: { build: 'b-old', version: '1.0.0', active: 0 } }), ME))
      .toEqual({ act: 'leave', why: 'not-app' });
    expect(decideWithoutLock(facts({ unit: null }), ME)).toEqual({ act: 'leave', why: 'no-unit' });
  });

  test('turned off by macOS, or not loaded: left', () => {
    expect(decideWithoutLock(facts({ job: { loaded: true, pid: 100, disabled: true } }), ME)).toEqual({ act: 'leave', why: 'blocked' });
    expect(decideWithoutLock(facts({ job: { loaded: false, pid: null, disabled: false } }), ME)).toEqual({ act: 'leave', why: 'not-loaded' });
  });
});

/** The in-memory world, plus whether the replaced service's process has exited. */
class HolderFake extends FakeWorld implements HolderWorld {
  /** Polls the replaced process takes to exit after the bootout. */
  exitPolls = 2;
  aliveAsked = 0;
  alive(pid: number): boolean {
    this.aliveAsked += 1;
    return pid === 100 && this.calls.includes('bootout') && this.aliveAsked <= this.exitPolls;
  }
}

describe('replacing the holder, from a launch with no window', () => {
  test('stopped, waited for until its process exits, started on this build', async () => {
    const world = new HolderFake();
    expect(await replaceHolder(world, ME)).toEqual({ done: 'replaced' });
    expect(world.calls).toEqual(['bootout', 'bootstrap']);
    expect(world.aliveAsked).toBeGreaterThan(world.exitPolls);
  });

  test('a unit naming another copy is left alone: nothing is asked of launchd', async () => {
    const world = new HolderFake();
    world.unit = { program: '/Applications/Other/resmon.app/Contents/MacOS/resmon', runsApp: true, port: 8742 };
    expect(await replaceHolder(world, ME)).toEqual({ done: 'left', why: 'another-copy' });
    expect(world.calls).toEqual([]);
  });

  test('a service running runs is left: never stopped without asking', async () => {
    const world = new HolderFake();
    world.running = { build: 'b-old', version: '1.0.0', active: 2 };
    expect(await replaceHolder(world, ME)).toEqual({ done: 'left', why: 'busy' });
    expect(world.calls).toEqual([]);
  });

  test('a stop launchd does not carry out: failed, and nothing is started', async () => {
    const world = new HolderFake();
    world.bootoutStops = false;
    expect(await replaceHolder(world, ME)).toEqual({ done: 'failed', why: 'launchd did not stop the service' });
    expect(world.calls).toEqual(['bootout']);
  });

  test('a start that fails is tried once more, so the job is not left unloaded', async () => {
    const world = new HolderFake();
    let tries = 0;
    const bootstrap = world.bootstrap.bind(world);
    world.bootstrap = async () => { tries += 1; world.bootstrapOk = tries > 1; return bootstrap(); };
    expect(await replaceHolder(world, ME)).toEqual({ done: 'replaced' });
    expect(world.calls).toEqual(['bootout', 'bootstrap', 'bootstrap']);
  });

  test('two failed starts: said as failed', async () => {
    const world = new HolderFake();
    world.bootstrapOk = false;
    const outcome = await replaceHolder(world, ME);
    expect(outcome.done).toBe('failed');
    expect(world.calls).toEqual(['bootout', 'bootstrap', 'bootstrap']);
  });

  test('a start that has not answered by the end of the wait: left starting, never stopped', async () => {
    const world = new HolderFake();
    world.slowStart = 1_000;
    expect(await replaceHolder(world, ME, 2_000)).toEqual({ done: 'starting' });
    expect(world.calls).toEqual(['bootout', 'bootstrap']);
  });

  test('a job found unloaded after the wait is loaded again, so the watches go on', async () => {
    const world = new HolderFake();
    world.startsBuild = null;
    const bootstrap = world.bootstrap.bind(world);
    let first = true;
    world.bootstrap = async () => {
      const said = await bootstrap();
      // The first start loads the job and then crashes out of launchd.
      if (first) { first = false; world.job = { ...world.job, loaded: false, pid: null }; }
      return said;
    };
    expect(await replaceHolder(world, ME, 2_000)).toEqual({ done: 'starting' });
    expect(world.calls).toEqual(['bootout', 'bootstrap', 'bootstrap']);
    expect(world.job.loaded).toBe(true);
    expect(world.lines.some((l) => l.includes('loaded again'))).toBe(true);
  });
});

describe('a wait for the service is said, so the launch shows that resmon is starting', () => {
  test('a service already starting: said once, as starting, and never stopped', async () => {
    const world = new FakeWorld();
    world.startingAs('b-new', 40);
    expect(await ensureService(world, ME)).toEqual({ done: 'started' });
    expect(world.waits).toEqual(['starting']);
    expect(world.calls).toEqual(['release']);
  });

  test('a service this launch starts, kicks, or replaces: said once, as started', async () => {
    const started = new FakeWorld();
    started.job = { loaded: false, pid: null, disabled: false };
    started.running = null;
    started.slowStart = 20;
    expect(await ensureService(started, ME)).toEqual({ done: 'started' });
    expect(started.waits).toEqual(['started']);

    const kicked = new FakeWorld();
    kicked.job = { loaded: true, pid: null, disabled: false };
    kicked.running = null;
    expect(await ensureService(kicked, ME)).toEqual({ done: 'started' });
    expect(kicked.waits).toEqual(['started']);

    const replaced = new FakeWorld();
    expect(await ensureService(replaced, ME)).toEqual({ done: 'started' });
    expect(replaced.waits).toEqual(['started']);
  });

  test('a service still starting that never answers: said, and the wait ends with nothing stopped', async () => {
    const world = new FakeWorld();
    world.startingAs(null, 0);
    expect(await ensureService(world, ME, 5_000)).toEqual({ done: 'nothing', why: 'starting' });
    expect(world.waits).toEqual(['starting']);
    expect(world.calls).toEqual(['release']);
  });

  test('nothing waited for: nothing said', async () => {
    const ours = new FakeWorld();
    ours.running = { build: 'b-new', version: '1.0.0', active: 0 };
    expect(await ensureService(ours, ME)).toEqual({ done: 'nothing', why: 'ours' });

    const blocked = new FakeWorld();
    blocked.job = { loaded: false, pid: null, disabled: true };
    expect(await ensureService(blocked, ME)).toEqual({ done: 'blocked' });

    const kept = new FakeWorld();
    kept.running = { build: 'b-old', version: '1.0.0', active: 2 };
    kept.answers = false;
    expect(await ensureService(kept, ME)).toEqual({ done: 'kept' });

    // Another resmon holds the lock, and it, not this launch, opens the window.
    const elsewhere = new FakeWorld();
    elsewhere.startingAs(null, 0);
    elsewhere.holding = false;
    expect(await ensureService(elsewhere, ME)).toEqual({ done: 'nothing', why: 'starting' });

    for (const world of [ours, blocked, kept, elsewhere]) expect(world.waits).toEqual([]);
  });

  test('a world that does not say waits is waited on as before', async () => {
    const world = new FakeWorld();
    world.startingAs('b-new', 3);
    (world as { waiting?: unknown }).waiting = undefined;
    expect(await ensureService(world, ME)).toEqual({ done: 'started' });
    expect(world.waits).toEqual([]);
  });
});

describe('reading launchd and the unit', () => {
  test('the unit\'s program, whether it runs the app, and its port', () => {
    expect(unitFromPlist({ ProgramArguments: [EXE, '--service', '--port=8742', '--db-path=/x/resmon.db'] }))
      .toEqual({ program: EXE, runsApp: true, port: 8742 });
    expect(unitFromPlist({ ProgramArguments: ['/usr/bin/python3', '-m', 'implementation_scripts.daemon', '8742'] }))
      .toEqual({ program: '/usr/bin/python3', runsApp: false, port: null });
    expect(unitFromPlist(null)).toBeNull();
  });

  test('a pid, and a label turned off', () => {
    expect(pidFromPrint('gui/501/com.resmon.daemon = {\n\tstate = running\n\tpid = 7311\n}')).toBe(7311);
    expect(pidFromPrint('gui/501/com.resmon.daemon = {\n\tstate = waiting\n}')).toBeNull();
    expect(disabledIn('disabled services = {\n\t"com.resmon.daemon" => disabled\n}', 'com.resmon.daemon')).toBe(true);
    expect(disabledIn('disabled services = {\n\t"com.resmon.daemon" => enabled\n}', 'com.resmon.daemon')).toBe(false);
    expect(disabledIn('disabled services = {\n\t"com.resmon.daemonx" => disabled\n}', 'com.resmon.daemon')).toBe(false);
  });

  test('a copy on a disk image or translocated from a download is temporary', () => {
    expect(temporaryPlace('/Volumes/resmon 1.0.0/resmon.app/Contents/MacOS/resmon')).toBe(true);
    expect(temporaryPlace('/private/var/folders/x/AppTranslocation/y/d/resmon.app/Contents/MacOS/resmon')).toBe(true);
    expect(temporaryPlace(EXE)).toBe(false);
  });
});
