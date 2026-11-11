/**
 * The packaged app, and the command line inside it, found and run from a spec.
 *
 * electron-builder leaves the unpacked app under `release/` (`mac-arm64`, `mac`,
 * `win-unpacked`, or `linux-unpacked`). Everything here reads that folder as it
 * is, so a spec exercises the bytes that ship.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { FRONTEND_ROOT } from './resmon-app';

/** The version of this checkout, which a fresh build carries. */
export const CHECKOUT_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(FRONTEND_ROOT, 'package.json'), 'utf8'),
).version;

/** The executable electron-builder left for this platform, or null. */
export function packagedExecutable(): string | null {
  const release = path.join(FRONTEND_ROOT, 'release');
  const candidates = process.platform === 'darwin'
    ? [
      path.join(release, 'mac-arm64', 'resmon.app', 'Contents', 'MacOS', 'resmon'),
      path.join(release, 'mac', 'resmon.app', 'Contents', 'MacOS', 'resmon'),
    ]
    : process.platform === 'win32'
      ? [path.join(release, 'win-unpacked', 'resmon.exe')]
      : [path.join(release, 'linux-unpacked', 'resmon')];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** The folder the app is: the `.app` bundle on macOS, the unpacked folder elsewhere. */
export function appFolder(exe: string): string {
  return process.platform === 'darwin' ? path.resolve(exe, '..', '..', '..') : path.dirname(exe);
}

/** What the app carries for its Python: the interpreter, the command line, and the engine's sources. */
export function bundledBackend(exe: string): { python: string; archive: string; scripts: string; folder: string } {
  const resources = process.platform === 'darwin'
    ? path.resolve(exe, '..', '..', 'Resources')
    : path.join(path.dirname(exe), 'resources');
  const folder = path.join(resources, 'backend');
  return {
    folder,
    python: process.platform === 'win32'
      ? path.join(folder, 'python', 'python.exe')
      : path.join(folder, 'python', 'bin', 'python3'),
    archive: path.join(folder, 'resmon.pyz'),
    scripts: path.join(folder, 'resmon_scripts'),
  };
}

/** Run a program to the end without a console window; never rejects on a non-zero exit. */
export function runToEnd(
  file: string, args: string[], env: Record<string, string>, timeoutMs = 60_000,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && typeof (err as NodeJS.ErrnoException).code !== 'number') {
        reject(err);
        return;
      }
      resolve({ status: err ? Number((err as NodeJS.ErrnoException).code) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * The environment a person's terminal would hold, pointed at one instance:
 * nothing of the suite's own, so the command line finds the instance the way it
 * finds the app's engine anywhere, from the state folder.
 */
export function terminalEnv(stateDir: string): Record<string, string> {
  const keep = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'];
  const env: Record<string, string> = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name] as string;
  env.RESMON_STATE_DIR = stateDir;
  env.RESMON_PORT_FILE = path.join(stateDir, 'resmon.port');
  return env;
}
