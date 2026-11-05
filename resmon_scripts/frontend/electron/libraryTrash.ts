import * as path from 'path';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Whether a path names a file directly inside a Library folder's held removed
 * files: `…/resmon-library-<uuid>/removed/<uuid>/<name>`, absolute, with no
 * `.` or `..` part. The only paths `resmon:trash-path` sends to the Trash.
 */
export function libraryRemovedFile(target: unknown, sep: string = path.sep): boolean {
  if (typeof target !== 'string' || !(sep === '/' ? target.startsWith('/') : path.win32.isAbsolute(target)) || target.includes('\0')) return false;
  const parts = target.split(sep);
  if (parts.some((p) => p === '.' || p === '..')) return false;
  const name = parts[parts.length - 1] ?? '';
  const held = parts[parts.length - 2] ?? '';
  const removed = parts[parts.length - 3] ?? '';
  const library = parts[parts.length - 4] ?? '';
  return name.length > 0 && removed === 'removed' && new RegExp(`^${UUID}$`).test(held)
    && new RegExp(`^resmon-library-${UUID}$`).test(library);
}
