import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Where `build_collection.py` put the collection; required. */
export function collectionDir(): string {
  const dir = process.env.RESMON_DEMO_COLLECTION;
  if (!dir || !fs.existsSync(path.join(dir, 'state', 'resmon.db'))) {
    throw new Error('RESMON_DEMO_COLLECTION must name a folder made by demos/build_collection.py; see demos/README.md.');
  }
  return path.resolve(dir);
}

/** Where the takes, masters and segments are written; outside the repository by default. */
export function outputDir(): string {
  const dir = path.resolve(process.env.RESMON_DEMO_OUT || path.join(os.tmpdir(), 'resmon-demos'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
