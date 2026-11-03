/**
 * Installing and removing the `resmon` command on macOS and Linux, into a
 * folder of this test's own, and running the launchers it writes with a shell.
 * Windows is the registry, which a test cannot reach; its string work is in
 * `commandLine.test.ts`. The administrator prompt is never asked for here: the
 * folders are writable.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { macBundlePaths, macLauncher } from '../electron/commandLine';
import {
  installCommandLine, refreshInstalledArchive, uninstallCommandLine, type CommandLineContext,
} from '../electron/commandLineInstall';

let root: string;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-install-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A stand-in for the bundled interpreter that prints its arguments. */
const FAKE_PYTHON = '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n';

function context(platform: NodeJS.Platform, overrides: Partial<CommandLineContext> = {}): CommandLineContext {
  return {
    platform,
    resourcesPath: path.join(root, 'resmon.app', 'Contents', 'Resources'),
    execPath: path.join(root, 'resmon.app', 'Contents', 'MacOS', 'resmon'),
    home: path.join(root, 'home'),
    macBinDir: path.join(root, 'bin'),
    localAppData: path.join(root, 'local'),
    pathEnv: `${path.join(root, 'bin')}:/usr/bin`,
    ...overrides,
  };
}

function bundle(ctx: CommandLineContext): void {
  const { python, archive } = macBundlePaths(path.resolve(ctx.resourcesPath, '..', '..'));
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, FAKE_PYTHON, { mode: 0o755 });
  fs.writeFileSync(archive, 'archive v1');
}

describe('on macOS', () => {
  it('writes an executable launcher that runs the bundle, and removes it', async () => {
    const ctx = context('darwin');
    bundle(ctx);
    const installed = await installCommandLine(ctx);
    expect(installed).toMatchObject({ ok: true });
    expect(installed.message).toContain(path.join(ctx.macBinDir, 'resmon'));

    const launcher = path.join(ctx.macBinDir, 'resmon');
    expect(fs.statSync(launcher).mode & 0o777).toBe(0o755);
    expect(fs.lstatSync(launcher).isSymbolicLink()).toBe(false);
    const out = execFileSync(launcher, ['wall', '--json'], { encoding: 'utf-8' });
    const { archive } = macBundlePaths(path.resolve(ctx.resourcesPath, '..', '..'));
    expect(out.split('\n').filter(Boolean)).toEqual(['[-I]', `[${archive}]`, '[wall]', '[--json]']);

    const removed = await uninstallCommandLine(ctx);
    expect(removed).toMatchObject({ ok: true });
    expect(fs.existsSync(launcher)).toBe(false);
  });

  it('creates the folder when it is missing', async () => {
    const ctx = context('darwin', { macBinDir: path.join(root, 'new', 'bin') });
    bundle(ctx);
    expect((await installCommandLine(ctx)).ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'new', 'bin', 'resmon'))).toBe(true);
  });

  it('never replaces or deletes a resmon it did not write', async () => {
    const ctx = context('darwin');
    bundle(ctx);
    fs.mkdirSync(ctx.macBinDir, { recursive: true });
    const theirs = path.join(ctx.macBinDir, 'resmon');
    fs.writeFileSync(theirs, '#!/usr/bin/python3\nprint("pipx")\n', { mode: 0o755 });
    expect((await installCommandLine(ctx)).ok).toBe(false);
    expect((await uninstallCommandLine(ctx)).ok).toBe(false);
    expect(fs.readFileSync(theirs, 'utf-8')).toContain('pipx');
  });

  it('says there is nothing to remove when nothing is there', async () => {
    const result = await uninstallCommandLine(context('darwin'));
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toContain('There is no resmon command');
  });

  it('refuses plainly when the app has no command line inside it', async () => {
    const result = await installCommandLine(context('darwin'));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no command line inside it');
  });

  it('says where it looked when the app has moved', () => {
    const ctx = context('darwin');
    const app = path.resolve(ctx.resourcesPath, '..', '..');
    fs.mkdirSync(ctx.macBinDir, { recursive: true });
    const launcher = path.join(ctx.macBinDir, 'resmon');
    fs.writeFileSync(launcher, macLauncher(app), { mode: 0o755 });
    let stderr = '';
    let status = 0;
    try {
      execFileSync(launcher, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      stderr = String((err as { stderr: string }).stderr);
      status = (err as { status: number }).status;
    }
    expect(status).toBe(127);
    expect(stderr.trim().split('\n')).toHaveLength(1);
    expect(stderr).toContain(`resmon is not at ${app}.`);
    expect(stderr).toContain('Reinstall the command from resmon\'s menu');
  });

  it('hands arguments to the interpreter untouched, in a folder with a space and an apostrophe', async () => {
    const resourcesPath = path.join(root, "My 'Apps", 'resmon.app', 'Contents', 'Resources');
    const ctx = context('darwin', { resourcesPath });
    bundle(ctx);
    await installCommandLine(ctx);
    const out = execFileSync(path.join(ctx.macBinDir, 'resmon'), ['search', 'two words'], { encoding: 'utf-8' });
    expect(out).toContain('[search]\n[two words]');
  });
});

describe('on Linux', () => {
  function linuxContext(overrides: Partial<CommandLineContext> = {}): CommandLineContext {
    const ctx = context('linux', {
      resourcesPath: path.join(root, 'mount-1', 'resources'),
      pathEnv: `${path.join(root, 'home', '.local', 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ...overrides,
    });
    fs.mkdirSync(path.join(ctx.resourcesPath, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(ctx.resourcesPath, 'backend', 'resmon.pyz'), 'archive v1');
    return ctx;
  }
  const launcherOf = (ctx: CommandLineContext) => path.join(ctx.home, '.local', 'bin', 'resmon');
  const archiveOf = (ctx: CommandLineContext) => path.join(ctx.home, '.local', 'share', 'resmon', 'resmon.pyz');

  it('copies the archive out of the mount, writes the launcher, and removes both', async () => {
    const ctx = linuxContext();
    const result = await installCommandLine(ctx);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(archiveOf(ctx), 'utf-8')).toBe('archive v1');
    expect(fs.readFileSync(launcherOf(ctx), 'utf-8')).toContain(`ARCHIVE='${archiveOf(ctx)}'`);
    expect(fs.statSync(launcherOf(ctx)).mode & 0o777).toBe(0o755);

    expect((await uninstallCommandLine(ctx)).ok).toBe(true);
    expect(fs.existsSync(launcherOf(ctx))).toBe(false);
    expect(fs.existsSync(archiveOf(ctx))).toBe(false);
  });

  it('says so when ~/.local/bin is not on the PATH', async () => {
    const result = await installCommandLine(linuxContext({ pathEnv: '/usr/bin:/bin' }));
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('is not on your PATH');
    expect(result.detail).toContain('.local/bin');
  });

  it('says so when python3 is not on the PATH', async () => {
    const ctx = linuxContext({ pathEnv: path.join(root, 'home', '.local', 'bin') });
    const result = await installCommandLine(ctx);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('python3 was not found');
  });

  it('refreshes the copied archive when the running app carries a newer one', async () => {
    const ctx = linuxContext();
    await installCommandLine(ctx);
    expect(refreshInstalledArchive(ctx)).toBeNull();

    // The next run of the AppImage mounts somewhere else, with a newer archive.
    const next = linuxContext({ resourcesPath: path.join(root, 'mount-2', 'resources') });
    fs.writeFileSync(path.join(next.resourcesPath, 'backend', 'resmon.pyz'), 'archive v2');
    expect(refreshInstalledArchive(next)).toBe(archiveOf(next));
    expect(fs.readFileSync(archiveOf(next), 'utf-8')).toBe('archive v2');
    expect(fs.readdirSync(path.dirname(archiveOf(next)))).toEqual(['resmon.pyz']);
  });

  it('refreshes nothing for a launcher it did not write, or when none is installed', () => {
    const ctx = linuxContext();
    expect(refreshInstalledArchive(ctx)).toBeNull();
    fs.mkdirSync(path.dirname(launcherOf(ctx)), { recursive: true });
    fs.writeFileSync(launcherOf(ctx), '#!/bin/sh\necho theirs\n');
    expect(refreshInstalledArchive(ctx)).toBeNull();
    expect(fs.existsSync(archiveOf(ctx))).toBe(false);
  });

  it('leaves a resmon it did not write alone', async () => {
    const ctx = linuxContext();
    fs.mkdirSync(path.dirname(launcherOf(ctx)), { recursive: true });
    fs.writeFileSync(launcherOf(ctx), '#!/bin/sh\necho theirs\n');
    expect((await installCommandLine(ctx)).ok).toBe(false);
    expect((await uninstallCommandLine(ctx)).ok).toBe(false);
    expect(fs.readFileSync(launcherOf(ctx), 'utf-8')).toContain('theirs');
  });

  it('does nothing on other systems', () => {
    expect(refreshInstalledArchive(context('darwin'))).toBeNull();
  });
});
