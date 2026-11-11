/**
 * The schema version the e2e suite expects a running backend to report.
 *
 * Four specs assert `/api/health`'s `identity.schema_version`, and each of them
 * used to carry the number as a literal. That is four places to edit when
 * `SCHEMA_VERSION` moves, and the failure when one is missed is a red spec on
 * an unrelated branch rather than a statement about the schema.
 *
 * The constant is read out of `implementation_scripts/database.py` at
 * collection time — the same idiom the renderer's vocabulary test uses to read
 * the `executions.status` CHECK, and for the same reason: the suite has no
 * Python interpreter of its own, and shelling out to one would make a module
 * import depend on the backend virtualenv. What this file establishes is that
 * the source of truth is *read*, not transcribed; what the specs establish by
 * comparing it to `/api/health` is that a real backend over a real database
 * agrees with it.
 */
import * as fs from 'fs';
import * as path from 'path';

import { REPO_ROOT } from './fixtures/resmon-app';

const DATABASE_PY = path.join(
  REPO_ROOT, 'resmon_scripts', 'implementation_scripts', 'database.py',
);

function readSchemaVersion(): number {
  const source = fs.readFileSync(DATABASE_PY, 'utf8');
  const match = /^SCHEMA_VERSION\s*=\s*(\d+)\s*$/m.exec(source);
  if (!match) {
    // Loudly, rather than falling back to a number that would silently pass.
    throw new Error(
      `No "SCHEMA_VERSION = <n>" line in ${DATABASE_PY}. If the constant was ` +
      'renamed or moved, this parse has to move with it.',
    );
  }
  return Number(match[1]);
}

/** `database.SCHEMA_VERSION`, read from the file rather than transcribed. */
export const EXPECTED_SCHEMA_VERSION = readSchemaVersion();
