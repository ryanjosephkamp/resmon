#!/usr/bin/env node
/**
 * Stage the Python backend for packaging.
 *
 * An installed resmon must not depend on what Python the machine happens to
 * have, or on the user ever having run pip. So the build copies the backend
 * sources and builds a virtual environment beside them, and both are shipped
 * inside the .app under Contents/Resources/backend/.
 *
 * electron-builder's beforePack hook expects the module to EXPORT a function,
 * so the work lives in prepareBackend() and the module exports it. Running the
 * file directly does the same thing.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.resolve(__dirname, '..');
const REPO = path.resolve(FRONTEND, '..', '..');
const STAGE = path.join(FRONTEND, 'build-resources', 'backend');

// Windows venvs put executables in Scripts\ with .exe suffixes; POSIX venvs
// in bin/. Resolve once so every call site stays platform-blind.
const WIN = process.platform === 'win32';
const VENV_BIN = (venv, name) => WIN
  ? path.join(venv, 'Scripts', `${name}.exe`)
  : path.join(venv, 'bin', name);

/** The Python to build the venv with: explicit override, else py/python3. */
function basePython() {
  if (process.env.RESMON_PYTHON) return process.env.RESMON_PYTHON;
  return WIN ? 'python' : 'python3';
}

/** Never ship these inside the app. */
const EXCLUDE = new Set([
  '__pycache__', '.pytest_cache', 'verification_scripts', 'notebooks',
  'given_scripts', 'node_modules', 'frontend', 'cloud_deploy', '.DS_Store',
]);

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

function prepareBackend() {
  console.log('[prepare-backend] staging into', STAGE);
  fs.rmSync(STAGE, { recursive: true, force: true });

  copyTree(path.join(REPO, 'resmon_scripts'), path.join(STAGE, 'resmon_scripts'));
  fs.copyFileSync(path.join(REPO, 'requirements.txt'), path.join(STAGE, 'requirements.txt'));

  const venv = path.join(STAGE, 'venv');
  const venvPython = VENV_BIN(venv, WIN ? 'python' : 'python3');
  if (process.env.RESMON_REUSE_VENV && fs.existsSync(venvPython)) {
    console.log('[prepare-backend] reusing the existing environment');
    return;
  }
  console.log('[prepare-backend] building the bundled environment (a few minutes)...');
  // --copies, not symlinks: a symlinked venv points at a Python outside the
  // bundle, which breaks the moment the bundle is moved or the base Python is
  // upgraded. (On Windows, venv copies by default.)
  execFileSync(basePython(), ['-m', 'venv', '--copies', venv], { stdio: 'inherit' });

  // Invoke pip through the venv's interpreter rather than the pip shim:
  // on Windows the pip.exe shim hard-codes its own absolute path and breaks
  // when the environment is later moved into the installed app.
  execFileSync(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'],
               { stdio: 'inherit' });
  execFileSync(venvPython, ['-m', 'pip', 'install', '--quiet', '-r',
               path.join(STAGE, 'requirements.txt')], { stdio: 'inherit' });

  // NLTK's sentence data is not a pip package. Fetching it at build time means
  // AI summarization works on a fresh install without a network round trip on
  // first use. The app degrades gracefully if this ever fails, so it is not
  // fatal.
  try {
    execFileSync(venvPython,
                 ['-m', 'nltk.downloader', '-d', path.join(venv, 'nltk_data'), 'punkt_tab'],
                 { stdio: 'inherit' });
  } catch {
    console.warn('[prepare-backend] punkt_tab download failed; the app will fall back');
  }

  console.log('[prepare-backend] done');
}

module.exports = prepareBackend;
module.exports.default = prepareBackend;

if (require.main === module) prepareBackend();
