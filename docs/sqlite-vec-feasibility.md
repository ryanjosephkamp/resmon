# sqlite-vec packaging feasibility

## Verdict and scope

**Interim: viable with caveats on macOS ARM64; the other three release targets
await native CI evidence.** This is a packaging spike, not a decision about phase
1.9. No application code, schema, runtime requirements, or existing workflow changes.

The freshly fetched `upstream/main` was
**`3c7298adbef92c7282ca29bd0d397a740676753d`**, the v1.8.3 release, matching the
brief's `3c7298a` baseline. The branch starts at that commit.

### Corrections to the brief

1. **Four release targets, not seven.** The baseline
   [release matrix](https://github.com/ryanjosephkamp/resmon/blob/3c7298adbef92c7282ca29bd0d397a740676753d/.github/workflows/release.yml#L36-L84)
   names macOS ARM64, macOS x64, Windows x64, and Linux x64. The brief gives no
   identities for three additional targets. Their support is **unknown and
   untested**; this spike does not invent platforms or expand the release matrix.
2. **The shipped Python is not setup-python's interpreter or a venv.** The
   [staging script](https://github.com/ryanjosephkamp/resmon/blob/3c7298adbef92c7282ca29bd0d397a740676753d/resmon_scripts/frontend/scripts/prepare-backend.js)
   pins Astral python-build-standalone **CPython 3.11.16, release 20260814**.
   Several older comments still describe a venv. The new workflow uses the
   staged/published interpreter paths, not setup-python, for every probe.
3. **Configure output alone is insufficient evidence.** On the measured ARM64
   runtime, `CONFIG_ARGS` lacks `--enable-loadable-sqlite-extensions` and
   `pyconfig.h` says `/* #undef PY_SQLITE_ENABLE_LOAD_EXTENSION */`, yet loading
   succeeds. The pinned builder supplies `PY_SQLITE_ENABLE_LOAD_EXTENSION=1`
   separately in its
   [_sqlite3 module definition](https://github.com/astral-sh/python-build-standalone/blob/20260814/cpython-unix/extension-modules.yml#L525-L555).
   `_sqlite3` is built into this interpreter and has no `__file__`. The probe
   checks the callable behavior and records built-in versus file-backed modules.
4. The brief's `danger-full-access` / approval-policy description does not match
   this session's workspace sandbox. Fetching, branch creation, network downloads,
   and packaging checks used the available approval mechanism; no other checkout
   was inspected or changed.

## The three independent questions

“Packaged” below means direct invocation of Python in electron-builder's output
or the stated installer container. It does not mean an Electron/Finder launch.
An available wheel is not proof of ABI compatibility; the successful load and
query supply that narrower evidence for the tested runtime and host.

| Release target | Bundled interpreter permits extension loading | Matching binary / ABI evidence | Loads inside packaged app |
| --- | --- | --- | --- |
| macOS ARM64 (`macos-14`) | Yes locally: enable/disable returned normally | 0.1.9 ARM64 wheel; actual load and vector query passed locally | Unsigned `.app` and read-only DMG passed locally; native CI pending |
| macOS x64 (`macos-15-intel`) | Not established: native CI pending | 0.1.9 x64 wheel exists; ABI not yet tested | Not established: native CI pending |
| Windows x64 (`windows-latest`) | Not established: native CI pending | 0.1.9 `win_amd64` wheel exists; ABI not yet tested | Not established: native CI pending |
| Linux x64 (`ubuntu-latest`) | Not established: native CI pending | 0.1.9 manylinux x64 wheel exists; ABI not yet tested | Not established: native CI pending |

### Local evidence

Host: macOS 26.3.1 ARM64. Pinned runtime: CPython 3.11.16, SQLite 3.53.1,
`.resmon-runtime = 3.11.16+20260814-aarch64-apple-darwin`.

From the repository root (the installation touches only the ignored build runtime):

```sh
cd resmon_scripts/frontend
npm run prepare:backend
cd ../..
mkdir -p build/sqlite-vec-probe
printf '%s\n' 'sqlite-vec==0.1.9 --hash=sha256:1d52e30513bae4cc9778ddbf6145610434081be4c3afe57cd877893bad9f6b6c' > build/sqlite-vec-probe/probe-requirement.txt
resmon_scripts/frontend/build-resources/backend/python/bin/python3 -I -m pip install --only-binary=:all: --no-deps --require-hashes -r build/sqlite-vec-probe/probe-requirement.txt
cd resmon_scripts/frontend
RESMON_REUSE_VENV=1 CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
cd ../..
resmon_scripts/frontend/release/mac-arm64/resmon.app/Contents/Resources/backend/python/bin/python3 -I resmon_scripts/verification_scripts/probe_sqlite_vec.py --resources-dir resmon_scripts/frontend/release/mac-arm64/resmon.app/Contents/Resources --expected-version 0.1.9 --expected-runtime-pin 3.11.16+20260814-aarch64-apple-darwin
```

Observed packaged output: `extension_loading.status=pass`,
`binary.load_status=pass`, `packaged_app.status=pass`,
`vector_query.status=pass`, `vec_version()=v0.1.9`, exit **0**.
The `vec0` nearest-neighbor query returned
`[[1, 0.0], [2, 2.8284270763397217]]`, the expected IDs and L2 distances.
The workflow's `hdiutil attach -readonly -nobrowse` procedure was also executed
locally against `resmon-1.8.3-arm64.dmg`: the same four statuses passed and the
same rows were returned from the mounted image, which was then detached.
The packaged ARM64 binary was 161,896 bytes, SHA-256
`193e480c50b59a55977d166f4aaf0e1bc8832d6963516e5950f39e4d2ce0b793`, identical
to the wheel's binary. Local JSON and build logs are generated under
`build/sqlite-vec-probe/`; they are not source files or shipped dependencies.

### CI method and evidence

[sqlite-vec-probe.yml](../.github/workflows/sqlite-vec-probe.yml) uses the exact
four baseline release runner labels. Each native job:

1. Runs the existing `prepare:backend` script and installs only its hash-pinned
   sqlite-vec wheel into that standalone runtime, with no dependencies or source
   build fallback. The wheel and runtime versions are explicit pins.
2. Runs the staged probe, then `npm run dist` with the existing packaging
   configuration. `RESMON_REUSE_VENV=1` retains the probe-only installation;
   the existing hook still checks its runtime marker and refreshes app sources.
3. Invokes Python from the packaged resources with `-I`, requires `app.asar`,
   and checks that the interpreter, file-backed SQLite module (if any), wrapper,
   and native binary all resolve inside that runtime. A staging directory alone
   cannot pass the packaging check.
4. Loads the extension, checks its version, creates an in-memory `vec0` table,
   inserts three vectors, and verifies a two-neighbor query's IDs and distances.
5. Gives that packaged interpreter a deliberately invalid native binary and
   requires both exit **1** and the specific `binary.load_status=fail` result.
6. Repeats the positive probe from a read-only mounted DMG on macOS, extracted
   AppImage on Linux, or a silent NSIS installation on Windows.

The shell uses GitHub's explicit bash `-e -o pipefail` behavior; no positive step
has `continue-on-error`. Evidence is uploaded even on failure. Installers are
neither published nor attached to a release. The workflow runs in the public
upstream repository, avoiding duplicate packaging on the working mirror.

**Hosted results: pending first branch run.** Run/job URLs and actual results will
replace this statement after execution; the presence of a workflow is not evidence
that it passed.

### Failure-path and regression checks

- The standalone probe under `.venv/bin/python -I` with sqlite-vec absent returned
  **1**, `binary.status=not_found`, and `packaged_app.status=not_tested`.
- A present text file named `invalid-vec0.dylib` reached `load_extension`, returned
  **1**, and recorded `binary.load_status=fail`. The interpreter-support check
  still passed, distinguishing binary failure from missing support.
- Passing the staging directory as `--resources-dir` returned **1** because
  `app.asar` was absent. It did not claim a packaged-app success.
- `build/sqlite-vec-probe/actionlint -shellcheck= .github/workflows/sqlite-vec-probe.yml`
  passed (actionlint 1.7.12; its downloaded archive checksum was verified).
  YAML parsing and comparison confirmed the four runner labels match release.yml.
- `.venv/bin/python -m pytest -q`: **882 passed, 41 deselected**.
- In `resmon_scripts/frontend`, `npm run typecheck && npm test -- --runInBand && npm run build`:
  **typecheck passed; 139 tests in 20 suites passed; build passed**.
- The existing test files and `requirements.txt` are unchanged. The 41 live-network
  tests were not run: this spike changes no source client and the brief requests
  the hermetic suite. sqlite-vec remains absent from the development venv.

## Version, licence, and size

Pinned **sqlite-vec 0.1.9**, the
[latest non-prerelease GitHub release checked](https://github.com/asg017/sqlite-vec/releases/tag/v0.1.9).
Its tagged sources provide
[MIT](https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE-MIT) and
[Apache-2.0](https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE-APACHE)
licences. The [0.1.9 PyPI metadata](https://pypi.org/pypi/sqlite-vec/0.1.9/json)
lists both. All four downloaded wheels were hash-checked against that metadata
and inspected as ZIP archives; none contained a licence text file. A future
distribution would need to include the applicable notices deliberately.

Exact byte counts, not estimates of compressed installer growth:

| Platform wheel suffix (`sqlite_vec-0.1.9-py3-none-…whl`) | Wheel download bytes | Uncompressed wheel members | Native binary bytes |
| --- | ---: | ---: | ---: |
| `macosx_11_0_arm64` | 165,434 | 164,590 | 161,896 (`vec0.dylib`) |
| `macosx_10_6_x86_64` | 131,171 | 130,327 | 127,632 (`vec0.dylib`) |
| `win_amd64` | 292,804 | 291,964 | 289,280 (`vec0.dll`) |
| `manylinux_2_17_x86_64.manylinux2014_x86_64.manylinux1_x86_64` | 163,388 | 162,550 | 159,816 (`vec0.so`) |

Thus the native addition is under 0.3 MiB per tested platform. This excludes pip's
generated metadata/bytecode, filesystem allocation, signing changes, and installer
compression effects. No before/after installer-size experiment was performed.
The four wheel SHA-256 pins are in the workflow; `pip-install.json` records the
selected URL and hash, and each probe records the actual native binary size/hash.

## What remains unestablished

- Finder's handling of a downloaded, quarantined/translocated macOS app. Direct
  Python execution from a read-only DMG is narrower evidence and does not activate
  that path. No Gatekeeper attributes were stripped or system policy disabled.
- Developer ID signing, hardened-runtime signing behavior, and notarization.
  These probes intentionally use unsigned builds and no signing secrets. Existing
  [entitlements](https://github.com/ryanjosephkamp/resmon/blob/3c7298adbef92c7282ca29bd0d397a740676753d/resmon_scripts/frontend/build-resources/entitlements.mac.plist)
  do not by themselves establish that a signed deployment works.
- Minimum-supported-OS coverage or clean consumer machines without runner tooling.
  A native hosted runner establishes its own OS/runtime combination only.
- Electron launching a backend that uses sqlite-vec: application code never imports
  it in this spike. No existing release artifact includes the new dependency.
- The identities and behavior of the brief's three additional, unnamed targets.

## Fallback cost if a target cannot load the extension

A standard-library exact scan is an available implementation shape, not an
implemented or timed fallback. Assuming **one vector per paper**, a 15,000-paper
corpus with dimension `d` requires `15,000 × d` component visits per query;
maintaining a size-`k` heap adds `O(15,000 log k)` selection work. Compact float32
storage costs `15,000 × d × 4` bytes: about **22.0 / 43.9 / 87.9 MiB** for
dimensions **384 / 768 / 1536**. Dimension and vectors per paper were not specified
by the brief, so these are illustrations, not a chosen embedding format.

Using SQLite BLOBs plus `array('f')`/`struct` can avoid materializing the entire
corpus as Python float objects. A Python loop still performs every distance
calculation in the interpreter, holds the GIL in this CPython build, and needs
explicit UI/background scheduling and cancellation design. Latency, acceptable
query rate, and implementation effort have not been measured or estimated in
days. No fallback or phase-1.9 architecture is selected here.

## Source interpretation

CPython documents
[`enable_load_extension` and its configure option](https://docs.python.org/3.11/library/sqlite3.html#sqlite3.Connection.enable_load_extension).
sqlite-vec documents the
[Python loading sequence](https://alexgarcia.xyz/sqlite-vec/python.html).
Those explain the checks; measured JSON output, exact release pins, and native CI
results establish this report's platform findings. Wheel tags and comments alone
do not establish a successful packaged load.
