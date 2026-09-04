/**
 * Reading Electron's fuse wire out of a built application.
 *
 * Two fuses decide whether the **packaged** app can be verified at all.
 * Playwright drives the main process over the Node inspector, so
 * `EnableNodeCliInspectArguments` must be on, and `RunAsNode` with it. Neither
 * is on by design: electron-builder simply does not flip fuses, and resmon's
 * `build` block asks for none. Both are also exactly what a hardening pass
 * would want turned *off* — and the day that lands, packaged verification stops
 * working, silently, with nothing connecting the two changes.
 *
 * So this reads them, rather than trusting that nobody has changed anything.
 *
 * **The format**, from `@electron/fuses`: a sentinel string is compiled into
 * the binary, followed by one version byte, one wire-length byte, and then one
 * ASCII byte per fuse — `'0'` disabled, `'1'` enabled, `'r'` removed. The
 * indices below are the v1 order.
 *
 * **This parse was checked against an independent tool**, not written from the
 * documentation and hoped for: `npx @electron/fuses read --app resmon.app`
 * reported RunAsNode/EnableNodeOptionsEnvironmentVariable/
 * EnableNodeCliInspectArguments/GrantFileProtocolExtraPrivileges/
 * WasmTrapHandlers enabled and the rest disabled, and the nine bytes found here
 * are `1 0 1 1 0 0 0 1 1`, which is the same statement. The tool is not a
 * dependency; nine bytes and a sentinel are not worth one.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Compiled into every Electron binary by the fuse tooling. */
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'utf8');

/** v1 wire order. Index into the bytes after the length byte. */
export const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
] as const;

/** The two Playwright needs to drive a packaged app's main process. */
export const FUSES_VERIFICATION_DEPENDS_ON = [
  'RunAsNode',
  'EnableNodeCliInspectArguments',
] as const;

export type FuseState = 'enabled' | 'disabled' | 'removed' | 'unknown';

/**
 * Where the fuse wire lives, given the executable electron-builder produced.
 *
 * On macOS it is in the Electron framework rather than the tiny launcher stub
 * in `Contents/MacOS` — 34 KB there, 180 MB in the framework, and the sentinel
 * is in the second. On Windows and Linux the main executable *is* Electron.
 */
export function fuseBinaryFor(executable: string): string {
  if (process.platform !== 'darwin') return executable;
  const contents = path.resolve(executable, '..', '..');
  return path.join(
    contents, 'Frameworks', 'Electron Framework.framework',
    'Versions', 'A', 'Electron Framework',
  );
}

/** Find the sentinel without loading a 180 MB binary into one buffer. */
function findSentinel(file: string): { fd: number; index: number } | null {
  const fd = fs.openSync(file, 'r');
  const size = fs.statSync(file).size;
  const chunk = 8 * 1024 * 1024;
  const overlap = SENTINEL.length + 16;
  const buf = Buffer.alloc(chunk);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fd, buf, 0, Math.min(chunk, size - offset), offset);
    if (read <= 0) break;
    const at = buf.subarray(0, read).indexOf(SENTINEL);
    if (at !== -1) return { fd, index: offset + at };
    offset += Math.max(1, read - overlap);
  }
  fs.closeSync(fd);
  return null;
}

/** Every fuse in a built app, by name. Returns null when there is no wire. */
export function readFuses(executable: string): Record<string, FuseState> | null {
  const binary = fuseBinaryFor(executable);
  if (!fs.existsSync(binary)) return null;
  const found = findSentinel(binary);
  if (!found) return null;
  try {
    // version, length, then one byte per fuse.
    const header = Buffer.alloc(2 + FUSE_NAMES.length + 8);
    fs.readSync(found.fd, header, 0, header.length, found.index + SENTINEL.length);
    const wireLength = header[1];
    const out: Record<string, FuseState> = {};
    for (let i = 0; i < wireLength && i < FUSE_NAMES.length; i += 1) {
      const byte = header[2 + i];
      out[FUSE_NAMES[i]] = byte === 0x31 ? 'enabled'
        : byte === 0x30 ? 'disabled'
          : byte === 0x72 ? 'removed' : 'unknown';
    }
    return out;
  } finally {
    fs.closeSync(found.fd);
  }
}
