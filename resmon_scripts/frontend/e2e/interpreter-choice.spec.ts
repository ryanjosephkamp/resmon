/**
 * The interpreter choice itself, under test.
 *
 * These cases spawn real interpreters and touch the real filesystem — the
 * failure being guarded against is exactly "a name that does not run", and a
 * double that always resolves cannot fail that way.
 */
import { test, expect } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  InterpreterError, REPO_ROOT, resolveInterpreter, verifyInterpreter,
} from './fixtures/python-interpreter';

const venv = process.platform === 'win32'
  ? path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
  : path.join(REPO_ROOT, '.venv', 'bin', 'python');

test('RESMON_PYTHON wins when it is executable', () => {
  const chosen = resolveInterpreter({ RESMON_PYTHON: process.execPath } as NodeJS.ProcessEnv);
  expect(chosen).toEqual({ python: process.execPath, source: 'RESMON_PYTHON' });
});

test('a RESMON_PYTHON that cannot be run stops the run rather than falling back', () => {
  const missing = path.join(os.tmpdir(), 'resmon-no-such-python');
  let error: Error | undefined;
  try {
    resolveInterpreter({ RESMON_PYTHON: missing } as NodeJS.ProcessEnv);
  } catch (e) { error = e as Error; }
  expect(error).toBeInstanceOf(InterpreterError);
  expect(error?.message).toContain(missing);
  // The fallback exists and was deliberately not taken.
  expect(error?.message).toContain('.venv');
});

test('with RESMON_PYTHON unset the checkout venv is chosen, or its absence is named', () => {
  const bare = {} as NodeJS.ProcessEnv;
  if (fs.existsSync(venv)) {
    expect(resolveInterpreter(bare)).toEqual({ python: venv, source: 'checkout .venv' });
  } else {
    let error: Error | undefined;
    try { resolveInterpreter(bare); } catch (e) { error = e as Error; }
    expect(error?.message).toContain(venv);
  }
});

test('CI without a venv falls back to python3 on PATH', () => {
  test.skip(fs.existsSync(venv), 'the checkout has a .venv, which rule 2 takes first');
  expect(resolveInterpreter({ CI: '1' } as NodeJS.ProcessEnv).source).toBe('CI PATH fallback');
});

test('an interpreter without the backend dependencies is refused by name', () => {
  // `node` runs, and cannot import fastapi. That is the conda-python3 failure
  // this check exists for, reproduced with something every machine has.
  let error: Error | undefined;
  try { verifyInterpreter(process.execPath); } catch (e) { error = e as Error; }
  expect(error).toBeInstanceOf(InterpreterError);
  expect(error?.message).toContain('cannot import');
});

test('the interpreter this run chose does import the backend dependencies', () => {
  expect(verifyInterpreter(resolveInterpreter().python)).toContain('config.py');
});

/**
 * The guard has to reach every entry point, not just `npm run e2e`.
 *
 * `scripts/e2e-review.js` used to spawn Playwright with `--reporter list`,
 * which replaces the config's reporter list wholesale and so dropped the
 * completion guard from exactly the run CONTRIBUTING tells people to do before
 * asking anyone to look at an interface change. This spawns the review script
 * for real, with a deadline short enough that the collected cases cannot all
 * report, and asserts both the non-zero exit and the guard's own sentence in
 * the review log.
 *
 * `RESMON_E2E_GUARD_CHILD` keeps the child from re-entering this case, which
 * would otherwise spawn a review run inside a review run.
 */
test('npm run e2e:review carries the completion guard', () => {
  test.skip(!!process.env.RESMON_E2E_GUARD_CHILD, 'this is the child run of the guard case');
  test.setTimeout(120_000);
  const reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-guard-case-'));
  const run = spawnSync('node', ['scripts/e2e-review.js'], {
    cwd: path.join(REPO_ROOT, 'resmon_scripts', 'frontend'),
    env: {
      ...process.env,
      RESMON_E2E_GUARD_CHILD: '1',
      RESMON_E2E_GLOBAL_TIMEOUT: '3000',
      RESMON_E2E_REVIEW_DIR: reviewDir,
      FORCE_COLOR: '0',
    },
    encoding: 'utf8',
    timeout: 110_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  expect(output).toContain('never ran');
  expect(run.status).not.toBe(0);
  fs.rmSync(reviewDir, { recursive: true, force: true });
});
