#!/usr/bin/env node
/**
 * Stage the Python backend for packaging.
 *
 * An installed resmon must not depend on what Python the machine happens to
 * have, or on the user ever having run pip.
 *
 * A venv cannot deliver that: `python -m venv --copies` copies the launcher
 * binary, but that binary still dynamically links the base installation's
 * framework or libpython at an absolute path, and the standard library stays
 * behind in the base install. The result runs on every machine that has the
 * build machine's Python and crashes at load on a clean one.
 *
 * So the build ships a relocatable CPython from python-build-standalone (the
 * Astral-maintained builds made for embedding: @executable_path linkage,
 * standard library included, runs from any directory) and installs the
 * requirements straight into it. Nothing in the shipped bundle references a
 * path outside the bundle.
 *
 * On top of the runtime the stage holds:
 *
 *   resmon_scripts/   the engine's sources, compiled to bytecode
 *   resmon.pyz        the `resmon` command line, built with the standard
 *                     library's zipapp and stamped with the app's version
 *
 * The bundle is never edited after it is built (a signed app cannot be), so
 * bytecode is compiled here with `unchecked-hash` pycs, which Python loads
 * without looking at the source again, and the packaged engine is started with
 * PYTHONDONTWRITEBYTECODE so it writes none.
 *
 * electron-builder's beforePack hook expects the module to EXPORT a function,
 * so the work lives in prepareBackend() and the module exports it. Running the
 * file directly does the same thing.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.resolve(__dirname, '..');
const REPO = path.resolve(FRONTEND, '..', '..');
const STAGE = path.join(FRONTEND, 'build-resources', 'backend');

const WIN = process.platform === 'win32';

/** The app's version, which the command line inside the app reports. */
const APP_VERSION = require(path.join(FRONTEND, 'package.json')).version;

// The pinned standalone runtime. Bump deliberately, never implicitly:
// the release tag and version travel together, and a marker file inside the
// extracted runtime forces a rebuild whenever the pin changes.
const RUNTIME = {
  release: '20260814',
  version: '3.11.16',
};

function runtimeTriple() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
  if (process.platform === 'linux') return 'x86_64-unknown-linux-gnu';
  throw new Error(`Unsupported platform for the bundled runtime: ${process.platform}`);
}

function runtimeUrl() {
  const name = `cpython-${RUNTIME.version}+${RUNTIME.release}-${runtimeTriple()}-install_only.tar.gz`;
  return {
    name,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${RUNTIME.release}/${name}`,
  };
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/** Never ship these inside the app. */
const EXCLUDE = new Set([
  '__pycache__', '.pytest_cache', 'verification_scripts', 'notebooks',
  'given_scripts', 'node_modules', 'frontend', 'cloud_deploy', '.DS_Store', 'perf', 'cli',
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

/** Download and extract the runtime, and install the requirements. */
async function installRuntime(pythonBin, pydir, marker, pin) {
  fs.rmSync(pydir, { recursive: true, force: true });
  const { name, url } = runtimeUrl();
  const cacheDir = path.join(FRONTEND, 'build-resources', 'runtime-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tarball = path.join(cacheDir, name);
  if (!fs.existsSync(tarball)) {
    console.log('[prepare-backend] downloading', name);
    await download(url, tarball);
  } else {
    console.log('[prepare-backend] using cached', name);
  }

  // The install_only archives extract to a top-level python/ directory.
  // tar handles .tar.gz on all three platforms (Windows ships bsdtar).
  console.log('[prepare-backend] extracting the runtime');
  execFileSync('tar', ['-xzf', tarball, '-C', STAGE], { stdio: 'inherit' });

  console.log('[prepare-backend] installing dependencies (a few minutes)...');
  execFileSync(pythonBin, ['-m', 'pip', 'install', '--quiet', '--no-warn-script-location',
               '-r', path.join(STAGE, 'requirements.txt')], { stdio: 'inherit' });

  fs.writeFileSync(marker, pin + '\n');
}

/**
 * Build backend/resmon.pyz, the command line the app ships, with the bundled
 * interpreter. `-B` keeps it from writing bytecode into the stage on the way.
 */
function buildCommandLine(pythonBin) {
  const output = path.join(STAGE, 'resmon.pyz');
  fs.rmSync(output, { force: true });
  execFileSync(pythonBin, ['-I', '-B', path.join(REPO, 'resmon_scripts', 'cli', 'build_pyz.py'),
                           output, APP_VERSION], { stdio: 'inherit' });
  console.log(`[prepare-backend] built resmon.pyz for resmon ${APP_VERSION}`);
}

const COMPILE = ['-B', '-m', 'compileall', '-q', '-j', '0', '--invalidation-mode', 'unchecked-hash'];

/**
 * Compile the stage to bytecode with the bundled interpreter.
 *
 * resmon's own sources must compile: an error fails the build. The runtime's
 * standard library and site-packages are compiled leniently, because some
 * third-party files never compile (templates, Python 2 leftovers, test data);
 * those are listed and the build goes on, since Python runs them from source.
 */
function precompile(pythonBin, pydir) {
  console.log('[prepare-backend] compiling resmon_scripts');
  execFileSync(pythonBin, [...COMPILE, path.join(STAGE, 'resmon_scripts')], { stdio: 'inherit' });

  const lib = path.join(pydir, WIN ? 'Lib' : 'lib');
  // -f: bytecode pip wrote at install time checks the source's timestamp, which a
  // copy into the app changes, so every file is compiled again as unchecked-hash.
  console.log('[prepare-backend] compiling the runtime');
  const result = spawnSync(pythonBin, [...COMPILE, '-f', lib], { encoding: 'utf-8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const skipped = `${result.stdout}${result.stderr}`.split(/\r?\n/).filter((line) => /^\*\*\* Error compiling/.test(line));
    console.warn(`[prepare-backend] ${skipped.length} runtime file(s) did not compile and will run from source:`);
    for (const line of skipped.slice(0, 40)) console.warn(`  ${line.replace(/^\*\*\* Error compiling /, '')}`);
    if (skipped.length === 0) console.warn(`${result.stdout}${result.stderr}`.slice(0, 2000));
  }
}

async function prepareBackend() {
  console.log('[prepare-backend] staging into', STAGE);

  // Sources and the command line are rebuilt on every run, and so is the
  // bytecode. Only the runtime download and the pip install are skipped when an
  // existing runtime is reused.
  fs.rmSync(path.join(STAGE, 'resmon_scripts'), { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  copyTree(path.join(REPO, 'resmon_scripts'), path.join(STAGE, 'resmon_scripts'));
  fs.copyFileSync(path.join(REPO, 'requirements.txt'), path.join(STAGE, 'requirements.txt'));

  const pydir = path.join(STAGE, 'python');
  const pythonBin = WIN
    ? path.join(pydir, 'python.exe')
    : path.join(pydir, 'bin', 'python3');
  const marker = path.join(pydir, '.resmon-runtime');
  const pin = `${RUNTIME.version}+${RUNTIME.release}-${runtimeTriple()}`;

  const reusable = Boolean(process.env.RESMON_REUSE_VENV)
    && fs.existsSync(pythonBin)
    && fs.existsSync(marker)
    && fs.readFileSync(marker, 'utf-8').trim() === pin;
  if (reusable) {
    console.log('[prepare-backend] reusing the existing runtime', pin);
  } else {
    await installRuntime(pythonBin, pydir, marker, pin);
  }

  buildCommandLine(pythonBin);
  precompile(pythonBin, pydir);
  console.log('[prepare-backend] done —', pin);
}

module.exports = prepareBackend;
module.exports.default = prepareBackend;

if (require.main === module) {
  prepareBackend().catch((err) => { console.error(err); process.exit(1); });
}
