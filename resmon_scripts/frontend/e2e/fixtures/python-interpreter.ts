/**
 * Which Python the suite starts the backend with — and why that is worth a file.
 *
 * The app spawns `<python> resmon_scripts/resmon.py <port>`. If that interpreter
 * cannot import the backend's dependencies the window still opens, every page
 * reports "Backend: Offline", and the specs that need a backend fail or skip.
 * The shape that made this worth fixing is worse than a red suite: on a Mac
 * where `python3` is a conda interpreter without the requirements, a local run
 * printed "28 passed / 3 skipped / 56 did not run" and exited 0 — a run that
 * looks like evidence and is not.
 *
 * So the choice is made once, deliberately, in this order:
 *
 *   1. `RESMON_PYTHON`, when it is set. If it is set and cannot be executed,
 *      that is a fatal mistake in the caller's environment, not an invitation
 *      to quietly use something else.
 *   2. The checkout's own `.venv` — `.venv/bin/python`, or
 *      `.venv\Scripts\python.exe` on Windows. This is what CONTRIBUTING tells a
 *      contributor to create, and it is the interpreter the backend suite runs
 *      under, so it is the right default for a local run.
 *   3. `python3` (`python` on Windows) *only* under `CI`, where the workflow
 *      installs `requirements.txt` into the runner's own interpreter and there
 *      is no `.venv` in the checkout. ui-smoke.yml sets `RESMON_PYTHON: python3`
 *      today, so it is served by rule 1 and never reaches this; the rule is the
 *      belt to that braces.
 *
 * With none of those available the run stops at global setup with one sentence
 * naming what was looked for and where, rather than starting 32 spec files that
 * cannot pass.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const FRONTEND_ROOT = path.resolve(__dirname, '..', '..');
export const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..', '..');

export type InterpreterSource = 'RESMON_PYTHON' | 'checkout .venv' | 'CI PATH fallback';

export interface InterpreterChoice {
  /** The interpreter to spawn. Absolute unless it came from PATH under CI. */
  python: string;
  source: InterpreterSource;
}

/** The interpreter could not be chosen, or cannot run the backend. */
export class InterpreterError extends Error {}

function venvPath(): string {
  return process.platform === 'win32'
    ? path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(REPO_ROOT, '.venv', 'bin', 'python');
}

/** Can this name be executed — as a path, or as a name found on PATH? */
function isExecutable(candidate: string): boolean {
  if (candidate.includes(path.sep) || path.isAbsolute(candidate)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  // A bare name: PATH decides. `--version` rather than a `which`, because what
  // matters is that spawning it works, which is what the app will do.
  const probe = spawnSync(candidate, ['--version'], { timeout: 10_000 });
  return probe.status === 0;
}

/**
 * Pick the interpreter, or throw with a sentence naming what was looked for.
 *
 * `env` is a parameter so the unit of this that matters — the order, and the
 * refusal — can be exercised without mutating `process.env`.
 */
export function resolveInterpreter(env: NodeJS.ProcessEnv = process.env): InterpreterChoice {
  const configured = (env.RESMON_PYTHON || '').trim();
  if (configured) {
    if (!isExecutable(configured)) {
      throw new InterpreterError(
        `RESMON_PYTHON is set to "${configured}", which is not an executable this machine can run; ` +
        `unset it to use the checkout's ${venvPath()}, or point it at a Python that has ` +
        `${path.join(REPO_ROOT, 'requirements.txt')} installed.`,
      );
    }
    return { python: configured, source: 'RESMON_PYTHON' };
  }

  const venv = venvPath();
  if (fs.existsSync(venv)) return { python: venv, source: 'checkout .venv' };

  if (env.CI) {
    const onPath = process.platform === 'win32' ? 'python' : 'python3';
    if (isExecutable(onPath)) return { python: onPath, source: 'CI PATH fallback' };
  }

  throw new InterpreterError(
    `No Python to start the backend with: RESMON_PYTHON is unset and there is no interpreter at ${venv}. ` +
    `Create the checkout's virtual environment (python3 -m venv .venv && .venv/bin/pip install -r requirements.txt) ` +
    `or set RESMON_PYTHON to an interpreter that has those requirements installed.`,
  );
}

/**
 * Prove the chosen interpreter can actually import the backend's dependencies.
 *
 * Not `import resmon`: `resmon_scripts/resmon.py` builds the FastAPI app at
 * import time and is not importable as a top-level module anyway. This imports
 * the third-party stack the backend fails without plus one of the backend's own
 * packages, from `resmon_scripts/` — which is the exact failure a conda
 * `python3` produces, and it starts no server and writes no state.
 */
export function verifyInterpreter(python: string): string {
  const probe = spawnSync(
    python,
    ['-c', 'import fastapi, uvicorn, httpx, pydantic, implementation_scripts.config as c; print(c.__file__)'],
    { cwd: path.join(REPO_ROOT, 'resmon_scripts'), timeout: 10_000, encoding: 'utf8' },
  );
  if (probe.error && (probe.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    throw new InterpreterError(`${python} did not answer an import of the backend's dependencies within 10 s.`);
  }
  if (probe.status !== 0) {
    const detail = ((probe.stderr || '') as string).trim().split('\n').slice(-1)[0] || `exit ${probe.status}`;
    throw new InterpreterError(
      `${python} cannot import the backend's dependencies (${detail}); ` +
      `install ${path.join(REPO_ROOT, 'requirements.txt')} into it, or point RESMON_PYTHON at an interpreter that has them.`,
    );
  }
  return ((probe.stdout || '') as string).trim();
}

/**
 * The absolute path of the chosen interpreter, as several specs need: they
 * scrub PATH before launching, so a bare `python3` would not survive.
 */
export function absoluteInterpreter(python: string): string {
  if (path.isAbsolute(python)) return python;
  return execFileSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
}
