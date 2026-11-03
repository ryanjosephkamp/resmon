/**
 * The rule the Windows launch check applies to the windows it recorded: a
 * console window that was shown, and that belongs to resmon, fails the run.
 * (The recording is `e2e/fixtures/watch-windows.ps1`, which only Windows can run.)
 */
import {
  consoleWindowsShown, describeWindows, type SeenWindow,
} from '../e2e/fixtures/console-windows';
import { changesBetween } from '../e2e/fixtures/app-tree';

const APP = 'C:\\a\\resmon\\resmon_scripts\\frontend\\release\\win-unpacked';

function seen(overrides: Partial<SeenWindow>): SeenWindow {
  return {
    t: '2026-11-03T12:00:00.000Z', source: 'hook', event: 'show', class: 'Chrome_WidgetWin_1', title: 'resmon',
    visible: true, pid: 10, owner: `${APP}\\resmon.exe(10)`, ...overrides,
  };
}

describe('which windows fail the run', () => {
  it('passes the app\'s own window', () => {
    expect(consoleWindowsShown([seen({})], APP)).toEqual([]);
  });

  it.each(['ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS', 'VirtualConsoleClass'])(
    'fails a %s shown for a program under the app', (cls) => {
      const window = seen({ class: cls, owner: `C:\\Windows\\System32\\conhost.exe(40) < ${APP}\\resources\\backend\\python\\python.exe(30) < ${APP}\\resmon.exe(10)` });
      expect(consoleWindowsShown([window], APP)).toEqual([window]);
    });

  it('fails a console found by the poll as well as one the hook saw', () => {
    const window = seen({ class: 'ConsoleWindowClass', source: 'poll', event: 'visible', owner: `${APP}\\resmon.exe(10)` });
    expect(consoleWindowsShown([window], APP)).toEqual([window]);
  });

  it('is case-insensitive about the app\'s folder, as Windows paths are', () => {
    const window = seen({ class: 'ConsoleWindowClass', owner: `${APP.toUpperCase()}\\RESMON.EXE(10)` });
    expect(consoleWindowsShown([window], APP)).toHaveLength(1);
  });

  it('does not fail a console that was created and never shown', () => {
    expect(consoleWindowsShown([seen({ class: 'ConsoleWindowClass', event: 'create', visible: false })], APP)).toEqual([]);
  });

  it('fails a console whose owner cannot be traced, rather than guessing it was someone else\'s', () => {
    expect(consoleWindowsShown([seen({ class: 'ConsoleWindowClass', owner: '?(4242)' })], APP)).toHaveLength(1);
    expect(consoleWindowsShown([seen({ class: 'ConsoleWindowClass', owner: 'C:\\x\\conhost.exe(1) < ...' })], APP)).toHaveLength(1);
  });

  it('does not fail a console that belongs to another program on the machine', () => {
    const other = seen({ class: 'ConsoleWindowClass', owner: 'C:\\Windows\\System32\\conhost.exe(50) < C:\\Windows\\System32\\cmd.exe(49)' });
    expect(consoleWindowsShown([other], APP)).toEqual([]);
  });
});

describe('the log of what was seen', () => {
  it('names every window', () => {
    const text = describeWindows([seen({}), seen({ class: 'ConsoleWindowClass', title: 'python' })]);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('class=ConsoleWindowClass');
    expect(text).toContain('title="python"');
    expect(describeWindows([])).toBe('(no window appeared)');
  });
});

describe('telling whether a run changed the app', () => {
  const before = new Map([['/app/a.py', '10:1'], ['/app/lib/', 'dir']]);

  it('sees nothing in an unchanged tree', () => {
    expect(changesBetween(before, new Map(before))).toEqual([]);
  });

  it('names a bytecode file written, a file changed, and a file removed', () => {
    const after = new Map(before);
    after.set('/app/__pycache__/a.cpython-311.pyc', '90:2');
    after.set('/app/a.py', '11:1');
    after.delete('/app/lib/');
    expect(changesBetween(before, after).sort()).toEqual([
      'added /app/__pycache__/a.cpython-311.pyc', 'changed /app/a.py', 'removed /app/lib/',
    ]);
  });
});
