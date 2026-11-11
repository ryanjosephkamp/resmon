/**
 * Windows only: watch every window that appears while a spec drives the app,
 * and say whether any of them is a console.
 *
 * A console window is the black box a console program gets when it is started
 * by a process that has none. The engine, the map fit, and the PDF worker are
 * all console programs started by a program without one, so each needs
 * `windowsHide` or `CREATE_NO_WINDOW`; this is how the release workflow notices
 * when one does not. `watch-windows.ps1` does the watching, with a window-event
 * hook and, independently, a 50 ms poll of the visible windows; this file starts
 * it, reads its log, and applies the rule.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { removeStateDir } from './cleanup';

/** The window classes of a console: the classic one, Windows Terminal, and ConEmu. */
export const CONSOLE_CLASSES = ['ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS', 'VirtualConsoleClass'];

export interface SeenWindow {
  t: string;
  source: 'hook' | 'poll';
  event: 'create' | 'show' | 'visible';
  class: string;
  title: string;
  visible: boolean;
  pid: number;
  /** The owning process and its ancestors, nearest first: `path(pid) < path(pid) ...`. */
  owner: string;
}

export interface WindowWatch {
  /** Stop watching and return everything seen, in the order it was seen. */
  stop(): Promise<SeenWindow[]>;
}

const PARSE = (text: string): SeenWindow[] => text.split(/\r?\n/).flatMap((line) => {
  if (!line.trim()) return [];
  try {
    const record = JSON.parse(line) as Partial<SeenWindow> & { error?: string };
    return record.class === undefined ? [] : [record as SeenWindow];
  } catch {
    return [];
  }
});

/** Start the watcher and resolve once it has taken its baseline of the windows already open. */
export async function startWindowWatch(): Promise<WindowWatch> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-windows-'));
  const log = path.join(folder, 'windows.jsonl');
  const stopFlag = path.join(folder, 'stop');
  const helper = path.join(__dirname, 'watch-windows.ps1');
  const child: ChildProcess = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Log', log, '-Stop', stopFlag,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));

  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes('"ready"')) {
    if (child.exitCode !== null) throw new Error(`the window watcher exited early:\n${output}`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`the window watcher did not start:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    async stop() {
      fs.writeFileSync(stopFlag, '');
      const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 30_000))]);
      if (code === null) child.kill();
      const text = fs.readFileSync(log, 'utf8');
      removeStateDir(folder);
      if (!text.includes('"done"')) throw new Error(`the window watcher did not finish cleanly:\n${output}\n${text.slice(-2000)}`);
      return PARSE(text);
    },
  };
}

/** One line per window seen, for the log of a run. */
export function describeWindows(seen: SeenWindow[]): string {
  if (seen.length === 0) return '(no window appeared)';
  return seen.map((w) => `${w.t} ${w.source}/${w.event} class=${w.class} title=${JSON.stringify(w.title)} `
    + `visible=${w.visible} owner=${w.owner}`).join('\n');
}

/**
 * The console windows a program of resmon's showed. A window counts when it is
 * a console class, was shown (or was visible when polled), and belongs to a
 * process under `appFolder` or to one whose ancestry could not be read. A
 * console that was created and never shown is not something a person sees.
 */
export function consoleWindowsShown(seen: SeenWindow[], appFolder: string): SeenWindow[] {
  const ours = appFolder.toLowerCase();
  return seen.filter((w) => {
    if (!CONSOLE_CLASSES.includes(w.class)) return false;
    if (w.event === 'create' && !w.visible) return false;
    const owner = w.owner.toLowerCase();
    return owner.includes(ours) || owner.includes('?(') || owner.includes('...');
  });
}
