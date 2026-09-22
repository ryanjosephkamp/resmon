/**
 * Say what this run is about to measure, and refuse to start if it cannot.
 *
 * Three facts decide what a journey run means, and all three are chosen from
 * the environment: which build is under test, which driver is driving it, and
 * which interpreter its backend will run under. A run that prints none of them
 * is a green tick nobody can trace back to a target, which is the failure this
 * whole suite exists to make impossible elsewhere.
 *
 * Throwing here fails the run with a non-zero exit status and no spec results —
 * deliberately. The shape being avoided is the one `e2e/global-setup.ts` was
 * written for: a suite whose backend never started, where most cases report
 * "did not run" and the process still exits 0.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import { resolveInterpreter } from '../e2e/fixtures/python-interpreter';
import { driverName } from './drivers';
import { targetAppRoot } from './drivers/session';
import { JOURNEY_REGISTER, builtRows, pendingRows } from './register';

export default function globalSetup(): void {
  const root = targetAppRoot();
  const driver = driverName();
  const { python, source } = resolveInterpreter();

  // Not `import resmon`: `resmon.py` builds the FastAPI app at import time and
  // is not importable as a top-level module. This imports the third-party stack
  // the backend fails without plus one of the *target's* own packages, which is
  // the failure a wrong interpreter actually produces.
  const probe = spawnSync(
    python,
    ['-c', 'import fastapi, uvicorn, httpx, pydantic, implementation_scripts.config as c; print(c.__file__)'],
    { cwd: path.join(root.repo, 'resmon_scripts'), timeout: 20_000, encoding: 'utf8' },
  );
  if (probe.status !== 0) {
    const detail = (probe.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${probe.status}`;
    throw new Error(
      `${python} cannot import the backend of the build under test (${detail}). ` +
      `The build is ${root.repo}; install its requirements.txt into that interpreter, ` +
      'or point RESMON_PYTHON at one that has them.',
    );
  }

  const pending = pendingRows();
  const bySlice = ['2a', '2b']
    .map((s) => `${pending.filter((r) => r.slice === s).length} in slice ${s}`)
    .join(', ');
  console.log(`[journeys] build under test: ${root.frontend}`);
  console.log(`[journeys] driver: ${driver}`);
  console.log(`[journeys] backend interpreter: ${python} (from ${source}); imports ${(probe.stdout || '').trim()}`);
  console.log(
    `[journeys] ${builtRows().length} of ${JOURNEY_REGISTER.length} rows have a journey test; ` +
    `${pending.length} pending (${bySlice}).`,
  );
}
