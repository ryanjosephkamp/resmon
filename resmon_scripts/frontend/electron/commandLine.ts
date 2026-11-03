/**
 * The `resmon` command in a terminal, from the app's own menu.
 *
 * The app carries its command line as `backend/resmon.pyz`, which the bundled
 * interpreter runs with `-I`, so the person's own Python settings and packages
 * never apply. The menu items write a small launcher that runs it, the way
 * VS Code's "Install 'code' command in PATH" does:
 *
 *   macOS    a shell script at /usr/local/bin/resmon that runs the interpreter
 *            inside the app bundle (a symlink would not carry the `-I`).
 *   Windows  resmon.cmd in %LOCALAPPDATA%\resmon\bin, and that folder on the
 *            user's PATH.
 *   Linux    the AppImage mounts at a new path on every run, so a launcher
 *            cannot point inside it. The archive is copied to
 *            ~/.local/share/resmon/ and the launcher runs it with the system's
 *            `python3`; the command line uses the standard library only.
 *
 * This file is the part that is plain strings: the launcher text, the rule for
 * which files are resmon's to remove, and the editing of a PATH value.
 * `commandLineInstall.ts` does the file, registry and prompt work.
 */

/** Every launcher carries this on a line of its own; removal checks for it. */
export const LAUNCHER_MARKER = 'resmon command line launcher';

/** What `resmon` is called on each platform. */
export const MAC_LAUNCHER = '/usr/local/bin/resmon';

/** Quote a string for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The interpreter and archive inside a macOS app bundle. */
export function macBundlePaths(appPath: string): { python: string; archive: string } {
  const backend = `${appPath.replace(/\/+$/, '')}/Contents/Resources/backend`;
  return { python: `${backend}/python/bin/python3`, archive: `${backend}/resmon.pyz` };
}

/**
 * The macOS launcher. If the app has moved or been deleted it says where it
 * looked and how to put the command back, in one sentence, instead of failing
 * with "no such file".
 */
export function macLauncher(appPath: string): string {
  const { python, archive } = macBundlePaths(appPath);
  const gone = `resmon is not at ${appPath}. Reinstall the command from resmon's menu: `
    + `resmon, then Install "resmon" Command in PATH.`;
  return [
    '#!/bin/sh',
    `# ${LAUNCHER_MARKER}: written by resmon's Install "resmon" Command in PATH menu item.`,
    `PYTHON=${shellQuote(python)}`,
    `ARCHIVE=${shellQuote(archive)}`,
    'if [ ! -x "$PYTHON" ] || [ ! -f "$ARCHIVE" ]; then',
    `  echo ${shellQuote(gone)} >&2`,
    '  exit 127',
    'fi',
    'exec "$PYTHON" -I "$ARCHIVE" "$@"',
    '',
  ].join('\n');
}

/** The Linux launcher, for the archive copied to `archive`. */
export function linuxLauncher(archive: string): string {
  const noPython = 'resmon\'s command line needs Python 3, and python3 is not on your PATH. '
    + 'Install Python 3, then run resmon again.';
  const gone = `resmon's command line is not at ${archive}. Open resmon, then choose Help, `
    + 'then Install "resmon" Command in PATH.';
  return [
    '#!/bin/sh',
    `# ${LAUNCHER_MARKER}: written by resmon's Install "resmon" Command in PATH menu item.`,
    `ARCHIVE=${shellQuote(archive)}`,
    'if ! command -v python3 >/dev/null 2>&1; then',
    `  echo ${shellQuote(noPython)} >&2`,
    '  exit 127',
    'fi',
    'if [ ! -f "$ARCHIVE" ]; then',
    `  echo ${shellQuote(gone)} >&2`,
    '  exit 127',
    'fi',
    'exec python3 -I "$ARCHIVE" "$@"',
    '',
  ].join('\n');
}

/** Escape a value for a batch file line: `%` is the one character that expands inside quotes. */
function batchValue(value: string): string {
  return value.replace(/%/g, '%%');
}

/** The Windows launcher for the app installed at `appDir` (the folder holding resmon.exe). */
export function windowsLauncher(appDir: string): string {
  const dir = appDir.replace(/[\\/]+$/, '');
  const gone = `resmon is not at ${dir}. Reinstall the command from resmon's Help menu: `
    + 'Install "resmon" Command in PATH.';
  return [
    '@echo off',
    `REM ${LAUNCHER_MARKER}: written by resmon's Install "resmon" Command in PATH menu item.`,
    `set "RESMON_APP=${batchValue(dir)}"`,
    'if exist "%RESMON_APP%\\resources\\backend\\python\\python.exe" goto run',
    `echo ${batchValue(gone).replace(/[&|<>^]/g, '^$&')} 1>&2`,
    'exit /b 1',
    ':run',
    '"%RESMON_APP%\\resources\\backend\\python\\python.exe" -I "%RESMON_APP%\\resources\\backend\\resmon.pyz" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/** True when a file's text is a launcher resmon wrote. */
export function isResmonLauncher(text: string | null | undefined): boolean {
  return typeof text === 'string' && new RegExp(`^(?:#|REM) ${LAUNCHER_MARKER}`, 'm').test(text);
}

/** What uninstall may do with the file at the launcher's path. */
export type RemovalDecision = 'absent' | 'ours' | 'foreign';

/**
 * `text` is the file's content, or null when there is no file. Only a launcher
 * carrying the marker is resmon's to remove: a `resmon` that pipx installed is
 * somebody else's, and is never deleted.
 */
export function removalDecision(text: string | null): RemovalDecision {
  if (text === null) return 'absent';
  return isResmonLauncher(text) ? 'ours' : 'foreign';
}

/** True when `dir` is one of the entries of a PATH value. */
export function pathHasDir(pathValue: string, dir: string, separator = ':', caseSensitive = true): boolean {
  const same = (entry: string) => {
    const strip = (s: string) => (s.length > 1 ? s.replace(/[\\/]+$/, '') : s);
    const [a, b] = [strip(entry.trim()), strip(dir)];
    return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
  };
  return pathValue.split(separator).some((entry) => entry.trim() !== '' && same(entry));
}

/**
 * The user PATH with `dir` added at the end. Every other entry stays exactly as
 * written, `%VAR%` references included. Returns the value unchanged when `dir`
 * is already on it.
 */
export function addToWindowsPath(pathValue: string, dir: string): string {
  if (pathHasDir(pathValue, dir, ';', false)) return pathValue;
  if (pathValue.trim() === '') return dir;
  return pathValue.endsWith(';') ? `${pathValue}${dir}` : `${pathValue};${dir}`;
}

/** The user PATH without resmon's own entry, and with every other entry as written. */
export function removeFromWindowsPath(pathValue: string, dir: string): string {
  const kept = pathValue.split(';').filter(
    (entry) => entry.trim() === '' || !pathHasDir(entry, dir, ';', false),
  );
  return kept.join(';');
}

/** The registry value `reg query` printed, as the type and the data, untouched. */
export interface RegistryValue {
  type: string;
  data: string;
}

/**
 * Read `reg query HKCU\Environment /v Path` output. The data is everything
 * after the type, so a `%VAR%` entry stays unexpanded. Returns null when the
 * value is missing.
 */
export function parseRegQuery(output: string): RegistryValue | null {
  const found = /^\s+Path\s+(REG_[A-Z_]+)(?:\s+(.*?))?\s*$/im.exec(output);
  if (!found) return null;
  return { type: found[1], data: found[2] ?? '' };
}

/**
 * The arguments for `reg add` that write the user PATH back, as `REG_EXPAND_SZ`
 * unless the value was another type.
 * .NET's `SetEnvironmentVariable(..., "User")` writes `REG_SZ` and so turns
 * every `%VAR%` in the value into a literal; `reg add` with this type does not.
 */
export function regWritePathArgs(data: string, type = 'REG_EXPAND_SZ'): string[] {
  return ['add', 'HKCU\\Environment', '/v', 'Path', '/t', type, '/d', data, '/f'];
}

/** The PowerShell that tells running programs the environment changed. */
export const BROADCAST_ENVIRONMENT_CHANGE = [
  '$sig = \'[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] '
    + 'public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, '
    + 'string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);\'',
  '$type = Add-Type -MemberDefinition $sig -Name ResmonBroadcast -Namespace Win32 -PassThru',
  '$result = [UIntPtr]::Zero',
  // HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, five seconds.
  '[void]$type::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)',
].join('; ');

/**
 * The AppleScript that runs a shell command with the system's own administrator
 * prompt. The shell text sits inside an AppleScript string, so backslashes and
 * double quotes in it are escaped once more.
 */
export function administratorScript(shellCommand: string): string {
  const escaped = shellCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `do shell script "${escaped}" with administrator privileges`;
}

/** The shell command that puts a prepared launcher in place with root's rights. */
export function installAsAdministrator(prepared: string, target: string): string {
  const dir = target.replace(/\/[^/]*$/, '');
  return `/bin/mkdir -p ${shellQuote(dir)} && /bin/cp ${shellQuote(prepared)} ${shellQuote(target)} `
    + `&& /bin/chmod 755 ${shellQuote(target)}`;
}

/** The shell command that removes a launcher with root's rights. */
export function removeAsAdministrator(target: string): string {
  return `/bin/rm -f ${shellQuote(target)}`;
}
