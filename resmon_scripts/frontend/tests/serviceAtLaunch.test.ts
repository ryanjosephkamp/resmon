/**
 * The background service at launch (`electron/service.ts`), in every state it
 * can be found in, against a launchd and an engine held in memory. No
 * launchctl is run and no label is addressed: `World` is the only way out.
 */
import {
  decide, disabledIn, ensureService, pidFromPrint, temporaryPlace, unitFromPlist,
  type Facts, type Job, type Me, type Running, type Unit, type World,
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

  async facts(): Promise<Facts> {
    if (this.pendingStart > 0) {
      this.pendingStart -= 1;
      if (this.pendingStart === 0 && this.startsBuild) this.running = { build: this.startsBuild, version: '1.0.0', active: 0 };
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

  releaseLock(): void { this.calls.push('release'); }
  async sleep(): Promise<void> { /* no time passes */ }
  log(line: string): void { this.lines.push(line); }
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
