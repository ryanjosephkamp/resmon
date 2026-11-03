/**
 * The `resmon` command the app installs: the launcher text, which files are
 * resmon's to remove, and the editing of a Windows PATH value. All strings in,
 * strings out; the file and registry work is `commandLineInstall.test.ts`.
 */
import {
  LAUNCHER_MARKER, addToWindowsPath, administratorScript, installAsAdministrator, isResmonLauncher,
  linuxLauncher, macBundlePaths, macLauncher, parseRegQuery, pathHasDir, regWritePathArgs,
  removalDecision, runsFromTemporaryPlace, removeFromWindowsPath, shellQuote, windowsLauncher,
} from '../electron/commandLine';

describe('the macOS launcher', () => {
  const app = '/Applications/resmon.app';

  it('runs the bundled interpreter, isolated, on the bundled archive', () => {
    const text = macLauncher(app);
    expect(text).toContain(
      `PYTHON='${app}/Contents/Resources/backend/python/bin/python3'`,
    );
    expect(text).toContain(`ARCHIVE='${app}/Contents/Resources/backend/resmon.pyz'`);
    expect(text).toContain('exec "$PYTHON" -I "$ARCHIVE" "$@"');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('carries the marker', () => {
    expect(isResmonLauncher(macLauncher(app))).toBe(true);
    expect(macLauncher(app)).toContain(LAUNCHER_MARKER);
  });

  it('quotes a path with a space and an apostrophe', () => {
    const odd = "/Users/o'brien/My Apps/resmon.app";
    expect(shellQuote(odd)).toBe("'/Users/o'\\''brien/My Apps/resmon.app'");
    expect(macLauncher(odd)).toContain(`PYTHON=${shellQuote(macBundlePaths(odd).python)}`);
  });
});

describe('the Linux launcher', () => {
  const archive = '/home/ada/.local/share/resmon/resmon.pyz';

  it('runs the copied archive with the system python3, isolated', () => {
    const text = linuxLauncher(archive);
    expect(text).toContain(`ARCHIVE='${archive}'`);
    expect(text).toContain('exec python3 -I "$ARCHIVE" "$@"');
    expect(isResmonLauncher(text)).toBe(true);
  });

  it('says plainly when python3 is missing, and when the copy is gone', () => {
    const text = linuxLauncher(archive);
    expect(text).toContain('python3 is not on your PATH');
    expect(text).toContain(`not at ${archive}`);
  });
});

describe('the Windows launcher', () => {
  const dir = 'C:\\Users\\Ada\\AppData\\Local\\Programs\\resmon';

  it('runs the bundled interpreter, isolated, on the bundled archive, with CRLF lines', () => {
    const text = windowsLauncher(dir);
    expect(text).toContain(`set "RESMON_APP=${dir}"`);
    expect(text).toContain(
      '"%RESMON_APP%\\resources\\backend\\python\\python.exe" -I '
      + '"%RESMON_APP%\\resources\\backend\\resmon.pyz" %*',
    );
    expect(text.split('\r\n').length).toBeGreaterThan(5);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(isResmonLauncher(text)).toBe(true);
  });

  it('survives a parenthesis and an ampersand in the install folder', () => {
    const odd = 'C:\\Program Files (x86)\\Ada & Co\\resmon';
    const text = windowsLauncher(odd);
    expect(text).toContain(`set "RESMON_APP=${odd}"`);
    // The sentence it echoes escapes what cmd would read as syntax.
    expect(text).toContain('Ada ^& Co');
    // No parenthesized block, where an unescaped ")" would end the block early.
    expect(text).not.toMatch(/^\)/m);
    expect(text).not.toMatch(/if .*\($/m);
  });

  it('doubles a percent sign so cmd does not expand it', () => {
    expect(windowsLauncher('C:\\100%\\resmon')).toContain('set "RESMON_APP=C:\\100%%\\resmon"');
  });
});

describe('which files uninstall may remove', () => {
  it.each([
    [null, 'absent'],
    ['#!/usr/bin/python3\n# -*- coding: utf-8 -*-\nimport sys\n', 'foreign'],
    ['#!/bin/sh\n# installed by pipx\nexec /x/y "$@"\n', 'foreign'],
    ['', 'foreign'],
    [macLauncher('/Applications/resmon.app'), 'ours'],
    [linuxLauncher('/x/resmon.pyz'), 'ours'],
    [windowsLauncher('C:\\resmon'), 'ours'],
  ] as const)('%#: %s', (text, expected) => {
    expect(removalDecision(text as string | null)).toBe(expected);
  });

  it('is not fooled by a file that only mentions the marker', () => {
    expect(removalDecision(`echo "${LAUNCHER_MARKER}"\n`)).toBe('foreign');
    expect(removalDecision(`#!/bin/sh\n# see the ${LAUNCHER_MARKER} docs\n`)).toBe('foreign');
  });
});

describe('editing the Windows user PATH', () => {
  const dir = 'C:\\Users\\Ada\\AppData\\Local\\resmon\\bin';
  const stored = '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;%JAVA_HOME%\\bin;C:\\Tools';

  it('adds the folder at the end and leaves every other entry as written', () => {
    const next = addToWindowsPath(stored, dir);
    expect(next).toBe(`${stored};${dir}`);
    expect(next).toContain('%USERPROFILE%');
    expect(next).toContain('%JAVA_HOME%');
  });

  it('adds nothing twice, whatever the case or a trailing backslash', () => {
    const once = addToWindowsPath(stored, dir);
    expect(addToWindowsPath(once, dir)).toBe(once);
    expect(addToWindowsPath(`${stored};${dir.toLowerCase()}\\`, dir)).toBe(`${stored};${dir.toLowerCase()}\\`);
  });

  it('copes with an empty value and a trailing semicolon', () => {
    expect(addToWindowsPath('', dir)).toBe(dir);
    expect(addToWindowsPath('C:\\Tools;', dir)).toBe(`C:\\Tools;${dir}`);
  });

  it('removes only its own entry', () => {
    const withOurs = `${stored};${dir};C:\\More`;
    expect(removeFromWindowsPath(withOurs, dir)).toBe(`${stored};C:\\More`);
    expect(removeFromWindowsPath(stored, dir)).toBe(stored);
    expect(removeFromWindowsPath(`C:\\resmon\\bin-other;${dir}`, dir)).toBe('C:\\resmon\\bin-other');
  });

  it('puts the value back round trip, unexpanded', () => {
    expect(removeFromWindowsPath(addToWindowsPath(stored, dir), dir)).toBe(stored);
  });

  it('reads the value reg.exe prints without expanding it, and keeps its type', () => {
    const output = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Program Files\\Git\\cmd\r\n\r\n';
    expect(parseRegQuery(output)).toEqual({ type: 'REG_EXPAND_SZ', data: '%USERPROFILE%\\bin;C:\\Program Files\\Git\\cmd' });
    expect(parseRegQuery('    Path    REG_SZ    C:\\a\r\n')).toEqual({ type: 'REG_SZ', data: 'C:\\a' });
    expect(parseRegQuery('    Path    REG_EXPAND_SZ    \r\n')).toEqual({ type: 'REG_EXPAND_SZ', data: '' });
    expect(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });

  it('writes it back as REG_EXPAND_SZ unless it was another type', () => {
    expect(regWritePathArgs('%A%;C:\\b')).toEqual(
      ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', '%A%;C:\\b', '/f']);
    expect(regWritePathArgs('C:\\b', 'REG_SZ')[5]).toBe('REG_SZ');
  });
});

describe('a PATH on Unix', () => {
  it('knows whether a folder is on it', () => {
    expect(pathHasDir('/usr/bin:/home/ada/.local/bin:/bin', '/home/ada/.local/bin')).toBe(true);
    expect(pathHasDir('/usr/bin:/home/ada/.local/bin/:/bin', '/home/ada/.local/bin')).toBe(true);
    expect(pathHasDir('/usr/bin:/bin', '/home/ada/.local/bin')).toBe(false);
    expect(pathHasDir('', '/usr/local/bin')).toBe(false);
  });
});

describe('the administrator prompt', () => {
  it('wraps a shell command in an AppleScript string, escaping quotes and backslashes', () => {
    expect(administratorScript('echo "a\\b"')).toBe('do shell script "echo \\"a\\\\b\\"" with administrator privileges');
  });

  it('makes the folder, copies the prepared launcher, and marks it executable', () => {
    expect(installAsAdministrator('/var/folders/x/resmon', '/usr/local/bin/resmon')).toBe(
      "/bin/mkdir -p '/usr/local/bin' && /bin/cp '/var/folders/x/resmon' '/usr/local/bin/resmon' "
      + "&& /bin/chmod 755 '/usr/local/bin/resmon'",
    );
  });
});

describe('an app that runs from a place that will not be there next time', () => {
  it.each([
    '/private/var/folders/ab/xyz/AppTranslocation/6F1D/d/resmon.app',
    '/Volumes/resmon 1.0.0/resmon.app',
    '/Volumes/Backup/Apps/resmon.app',
  ])('%s', (appPath) => expect(runsFromTemporaryPlace(appPath)).toBe(true));

  it.each([
    '/Applications/resmon.app',
    '/Users/ada/Applications/resmon.app',
    '/Users/ada/Volumes/resmon.app',
    '/opt/AppTranslocationTools/resmon.app',
  ])('%s is a place to stay', (appPath) => expect(runsFromTemporaryPlace(appPath)).toBe(false));
});
