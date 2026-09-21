/**
 * The interpreter choice itself, under test.
 *
 * These cases spawn real interpreters and touch the real filesystem — the
 * failure being guarded against is exactly "a name that does not run", and a
 * double that always resolves cannot fail that way.
 */
import { test, expect } from '@playwright/test';
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
