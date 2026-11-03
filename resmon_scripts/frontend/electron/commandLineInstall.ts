/**
 * Installing and removing the `resmon` command: the file, registry, and
 * password work behind the menu items. `commandLine.ts` holds the launcher text
 * and the rules; this applies them to the machine and says what happened in a
 * sentence or two.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  BROADCAST_ENVIRONMENT_CHANGE, MAC_LAUNCHER, addToWindowsPath, administratorScript,
  installAsAdministrator, linuxLauncher, macBundlePaths, macLauncher, parseRegQuery, pathHasDir,
  regWritePathArgs, removalDecision, removeAsAdministrator, removeFromWindowsPath, windowsLauncher,
} from './commandLine';

/** What a menu item reports back: shown as a dialog, or logged under the e2e suite. */
export interface Outcome {
  ok: boolean;
  /** One short sentence. */
  message: string;
  /** Anything the person has to do next, or the reason behind a failure. */
  detail?: string;
}

/** Where things are. Built from the running app; a test builds its own. */
export interface CommandLineContext {
  platform: NodeJS.Platform;
  /** `process.resourcesPath`: the app's `Resources` folder (macOS) or `resources` folder. */
  resourcesPath: string;
  /** The app's executable, which sits in the install folder on Windows. */
  execPath: string;
  /** The home folder: `~/.local` on Linux. */
  home: string;
  /** macOS: the folder the launcher goes in. */
  macBinDir: string;
  /** Windows: `%LOCALAPPDATA%`. */
  localAppData: string;
  /** The PATH of this process, to say whether the launcher's folder is on it. */
  pathEnv: string;
}

/** `resourcesPath` is Electron's `process.resourcesPath`, which Node's types do not declare. */
export function systemContext(env: NodeJS.ProcessEnv, resourcesPath: string): CommandLineContext {
  // `RESMON_COMMAND_LINE_ROOT` puts every file under one folder, so a test can
  // run the menu items without touching the machine's own /usr/local/bin or home.
  const root = env.RESMON_COMMAND_LINE_ROOT;
  return {
    platform: process.platform,
    resourcesPath,
    execPath: process.execPath,
    home: root || os.homedir(),
    macBinDir: root ? path.join(root, 'bin') : path.dirname(MAC_LAUNCHER),
    localAppData: root || env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    pathEnv: env.PATH ?? '',
  };
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function run(file: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    // windowsHide: reg.exe and powershell.exe are console programs.
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderr: String(stderr) }));
      } else {
        resolve({ stdout: String(stdout) });
      }
    });
  });
}

function isDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function failure(message: string, err?: unknown): Outcome {
  const detail = err === undefined ? undefined : String((err as Error).message ?? err).split('\n')[0];
  return { ok: false, message, detail };
}

function foreignLauncher(file: string): Outcome {
  return {
    ok: false,
    message: `${file} is already there and resmon did not write it, so resmon left it alone.`,
    detail: 'It may be a resmon installed with pipx. Remove it yourself first if you want the app\'s.',
  };
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/** Run a shell command with the administrator prompt. Resolves false when the person cancels it. */
async function asAdministrator(shell: string): Promise<boolean> {
  try {
    await run('/usr/bin/osascript', ['-e', administratorScript(shell)]);
    return true;
  } catch (err) {
    // osascript reports a canceled password prompt as error -128.
    if (/-128|User canceled/i.test(String((err as { stderr?: string }).stderr ?? err))) return false;
    throw err;
  }
}

async function installOnMac(ctx: CommandLineContext): Promise<Outcome> {
  const appPath = path.resolve(ctx.resourcesPath, '..', '..');
  const bundle = macBundlePaths(appPath);
  if (!fs.existsSync(bundle.python) || !fs.existsSync(bundle.archive)) {
    return failure('This copy of resmon has no command line inside it to install.',
      `Expected ${bundle.archive}. The installed app has it.`);
  }
  const target = path.join(ctx.macBinDir, 'resmon');
  if (removalDecision(readIfPresent(target)) === 'foreign') return foreignLauncher(target);
  const text = macLauncher(appPath);
  try {
    fs.mkdirSync(ctx.macBinDir, { recursive: true });
    fs.writeFileSync(target, text, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
  } catch (err) {
    if (!isDenied(err)) return failure(`resmon could not write ${target}.`, err);
    // /usr/local/bin belongs to root on a Mac without Intel Homebrew: ask for
    // the administrator password through the system's own prompt.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-command-'));
    const prepared = path.join(scratch, 'resmon');
    try {
      fs.writeFileSync(prepared, text, { mode: 0o755 });
      if (!(await asAdministrator(installAsAdministrator(prepared, target)))) {
        return failure('Nothing was installed: the administrator prompt was canceled.');
      }
    } catch (adminErr) {
      return failure(`resmon could not write ${target}.`, adminErr);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  const onPath = pathHasDir(ctx.pathEnv, ctx.macBinDir);
  return {
    ok: true,
    message: `Installed ${target}. Open a new terminal and run "resmon --version".`,
    detail: onPath ? undefined : `${ctx.macBinDir} is not on this app's PATH; your terminal's may differ.`,
  };
}

async function uninstallOnMac(ctx: CommandLineContext): Promise<Outcome> {
  const target = path.join(ctx.macBinDir, 'resmon');
  const decision = removalDecision(readIfPresent(target));
  if (decision === 'absent') return { ok: true, message: `There is no resmon command at ${target}.` };
  if (decision === 'foreign') return foreignLauncher(target);
  try {
    fs.unlinkSync(target);
  } catch (err) {
    if (!isDenied(err)) return failure(`resmon could not remove ${target}.`, err);
    try {
      if (!(await asAdministrator(removeAsAdministrator(target)))) {
        return failure('Nothing was removed: the administrator prompt was canceled.');
      }
    } catch (adminErr) {
      return failure(`resmon could not remove ${target}.`, adminErr);
    }
  }
  return { ok: true, message: `Removed ${target}.` };
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

function linuxPaths(ctx: CommandLineContext): { launcher: string; archive: string; source: string } {
  return {
    launcher: path.join(ctx.home, '.local', 'bin', 'resmon'),
    archive: path.join(ctx.home, '.local', 'share', 'resmon', 'resmon.pyz'),
    source: path.join(ctx.resourcesPath, 'backend', 'resmon.pyz'),
  };
}

function onPathAsExecutable(name: string, pathEnv: string): boolean {
  return pathEnv.split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function installOnLinux(ctx: CommandLineContext): Outcome {
  const { launcher, archive, source } = linuxPaths(ctx);
  if (!fs.existsSync(source)) {
    return failure('This copy of resmon has no command line inside it to install.', `Expected ${source}.`);
  }
  if (removalDecision(readIfPresent(launcher)) === 'foreign') return foreignLauncher(launcher);
  try {
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.copyFileSync(source, archive);
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, linuxLauncher(archive), { mode: 0o755 });
    fs.chmodSync(launcher, 0o755);
  } catch (err) {
    return failure(`resmon could not write ${launcher}.`, err);
  }
  const notes: string[] = [];
  if (!pathHasDir(ctx.pathEnv, path.dirname(launcher))) {
    notes.push(`${path.dirname(launcher)} is not on your PATH. Add it in your shell profile, then open a new terminal.`);
  }
  if (!onPathAsExecutable('python3', ctx.pathEnv)) {
    notes.push('python3 was not found on your PATH. The command line needs Python 3 (it uses only the '
      + 'standard library), so install it before running resmon.');
  }
  return {
    ok: true,
    message: `Installed ${launcher}. Open a new terminal and run "resmon --version".`,
    detail: notes.length ? notes.join(' ') : undefined,
  };
}

function uninstallOnLinux(ctx: CommandLineContext): Outcome {
  const { launcher, archive } = linuxPaths(ctx);
  const decision = removalDecision(readIfPresent(launcher));
  if (decision === 'absent') return { ok: true, message: `There is no resmon command at ${launcher}.` };
  if (decision === 'foreign') return foreignLauncher(launcher);
  try {
    fs.unlinkSync(launcher);
    fs.rmSync(archive, { force: true });
    try { fs.rmdirSync(path.dirname(archive)); } catch { /* not empty, or already gone */ }
  } catch (err) {
    return failure(`resmon could not remove ${launcher}.`, err);
  }
  return { ok: true, message: `Removed ${launcher}.` };
}

/**
 * The AppImage mounts at a new path on every run, so the copy of `resmon.pyz`
 * the launcher runs is refreshed at launch when it carries resmon's marker:
 * the command then matches the app that is running. Never throws.
 */
export function refreshInstalledArchive(ctx: CommandLineContext): string | null {
  if (ctx.platform !== 'linux') return null;
  try {
    const { launcher, archive, source } = linuxPaths(ctx);
    if (removalDecision(readIfPresent(launcher)) !== 'ours' || !fs.existsSync(source)) return null;
    const wanted = fs.readFileSync(source);
    let current: Buffer | null = null;
    try { current = fs.readFileSync(archive); } catch { /* missing: written below */ }
    if (current !== null && current.equals(wanted)) return null;
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const partial = `${archive}.${process.pid}.tmp`;
    fs.writeFileSync(partial, wanted);
    fs.renameSync(partial, archive);
    return archive;
  } catch (err) {
    console.error(`[main] The installed resmon command could not be refreshed: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function windowsPaths(ctx: CommandLineContext): { dir: string; launcher: string; appDir: string } {
  const dir = path.join(ctx.localAppData, 'resmon', 'bin');
  return { dir, launcher: path.join(dir, 'resmon.cmd'), appDir: path.dirname(ctx.execPath) };
}

/** The user PATH exactly as stored: its type, and its text with `%VAR%` left alone. */
async function readUserPath(): Promise<{ type: string; data: string }> {
  try {
    const { stdout } = await run('reg', ['query', 'HKCU\\Environment', '/v', 'Path']);
    return parseRegQuery(stdout) ?? { type: 'REG_EXPAND_SZ', data: '' };
  } catch (err) {
    // `reg query` exits 1 when the value does not exist yet.
    if ((err as { code?: number }).code === 1) return { type: 'REG_EXPAND_SZ', data: '' };
    throw err;
  }
}

async function writeUserPath(data: string, type: string): Promise<void> {
  await run('reg', regWritePathArgs(data, type));
  // Running programs only re-read the environment when told it changed. A
  // failure here leaves the PATH written; new programs started later see it.
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', BROADCAST_ENVIRONMENT_CHANGE]).catch(() => undefined);
}

async function installOnWindows(ctx: CommandLineContext): Promise<Outcome> {
  const { dir, launcher, appDir } = windowsPaths(ctx);
  const archive = path.join(ctx.resourcesPath, 'backend', 'resmon.pyz');
  if (!fs.existsSync(archive)) {
    return failure('This copy of resmon has no command line inside it to install.', `Expected ${archive}.`);
  }
  if (removalDecision(readIfPresent(launcher)) === 'foreign') return foreignLauncher(launcher);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(launcher, windowsLauncher(appDir));
    const current = await readUserPath();
    const next = addToWindowsPath(current.data, dir);
    if (next !== current.data) await writeUserPath(next, current.type);
  } catch (err) {
    return failure('resmon could not add the command to your PATH.', err);
  }
  return {
    ok: true,
    message: `Installed ${launcher} and added ${dir} to your PATH.`,
    detail: 'Open a new terminal and run "resmon --version". Terminals that are already open keep the old PATH.',
  };
}

async function uninstallOnWindows(ctx: CommandLineContext): Promise<Outcome> {
  const { dir, launcher } = windowsPaths(ctx);
  const decision = removalDecision(readIfPresent(launcher));
  if (decision === 'foreign') return foreignLauncher(launcher);
  try {
    if (decision === 'ours') fs.unlinkSync(launcher);
    const current = await readUserPath();
    const next = removeFromWindowsPath(current.data, dir);
    if (next !== current.data) await writeUserPath(next, current.type);
    try { fs.rmdirSync(dir); } catch { /* not empty, or already gone */ }
  } catch (err) {
    return failure('resmon could not remove the command.', err);
  }
  return decision === 'absent'
    ? { ok: true, message: `There is no resmon command at ${launcher}.` }
    : { ok: true, message: `Removed ${launcher} and took ${dir} off your PATH.` };
}

// ---------------------------------------------------------------------------

export async function installCommandLine(ctx: CommandLineContext): Promise<Outcome> {
  if (ctx.platform === 'darwin') return installOnMac(ctx);
  if (ctx.platform === 'win32') return installOnWindows(ctx);
  return installOnLinux(ctx);
}

export async function uninstallCommandLine(ctx: CommandLineContext): Promise<Outcome> {
  if (ctx.platform === 'darwin') return uninstallOnMac(ctx);
  if (ctx.platform === 'win32') return uninstallOnWindows(ctx);
  return uninstallOnLinux(ctx);
}
