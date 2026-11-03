/**
 * Whether a run changed the files of an app: a snapshot of every file under a
 * folder (size and modification time), and what differs between two of them.
 * Bytecode written into a bundle shows up here as an added `__pycache__` file.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Every file under `root` as `path -> size:mtime`, for telling whether a run changed the app. */
export function snapshotTree(root: string): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        seen.set(`${full}${path.sep}`, 'dir');
        walk(full);
      } else {
        const stat = fs.lstatSync(full);
        seen.set(full, `${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(root);
  return seen;
}

/** What differs between two snapshots. */
export function changesBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [file, stamp] of after) {
    if (!before.has(file)) changes.push(`added ${file}`);
    else if (before.get(file) !== stamp) changes.push(`changed ${file}`);
  }
  for (const file of before.keys()) if (!after.has(file)) changes.push(`removed ${file}`);
  return changes;
}
