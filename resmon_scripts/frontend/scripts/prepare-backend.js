#!/usr/bin/env node
/**
 * Stage the Python backend for packaging.
 *
 * An installed resmon must not depend on what Python the machine happens to
 * have, or on the user ever having run pip.
 *
 * A venv CANNOT deliver that, and shipping one was the 1.6.0 distribution
 * bug: `python -m venv --copies` copies the launcher binary, but that binary
 * still dynamically links the base installation's framework/libpython at an
 * absolute path, and the stdlib stays behind in the base install. The result
 * ran on every machine that had the build machine's Python — including every
 * machine it was ever tested on — and dyld-crashed on any clean one.
 *
 * So the build now ships a genuinely relocatable CPython from
 * python-build-standalone (the Astral-maintained builds made for embedding:
 * @executable_path linkage, stdlib included, runs from any directory) and
 * installs the requirements straight into it. Nothing in the shipped bundle
 * references a path outside the bundle.
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

const WIN = process.platform === 'win32';

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

async function prepareBackend() {
  console.log('[prepare-backend] staging into', STAGE);

  // Sources are always refreshed; the runtime below is rebuilt only when
  // missing, stale against the pin, or a rebuild is forced.
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

  if (
    process.env.RESMON_REUSE_VENV &&
    fs.existsSync(pythonBin) &&
    fs.existsSync(marker) &&
    fs.readFileSync(marker, 'utf-8').trim() === pin
  ) {
    console.log('[prepare-backend] reusing the existing runtime', pin);
    return;
  }

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

  // NLTK's sentence data is not a pip package. It lives at sys.prefix/nltk_data,
  // which for the standalone runtime is the python/ directory itself — on NLTK's
  // default search path, so no env var is needed at run time. The app degrades
  // gracefully if this fetch ever fails, so it is not fatal.
  try {
    execFileSync(pythonBin,
                 ['-m', 'nltk.downloader', '-d', path.join(pydir, 'nltk_data'), 'punkt_tab'],
                 { stdio: 'inherit' });
  } catch {
    console.warn('[prepare-backend] punkt_tab download failed; the app will fall back');
  }

  fs.writeFileSync(marker, pin + '\n');
  console.log('[prepare-backend] done —', pin);
}

module.exports = prepareBackend;
module.exports.default = prepareBackend;

if (require.main === module) {
  prepareBackend().catch((err) => { console.error(err); process.exit(1); });
}
