# `perf/` — how fast resmon is, measured the same way every time

A harness that measures launch, navigation, the engine, resources, size and
stability against an **isolated copy** of resmon over a **seeded corpus**, with
every scholarly source answered from **recorded replies**, and reports the
median and 95th percentile of several runs. It exists so a change to the
interface, the process model or the engine can be held to a number rather than
to an impression.

Everything runs from `resmon_scripts/`:

```bash
# Once: record the benchmark sweep's replies from the live sources (keyless, ~25 s).
.venv/bin/python -m perf record --replies ~/resmon-perf-replies

# Every measurement, against this checkout's build (npm run build first).
.venv/bin/python -m perf run --replies ~/resmon-perf-replies --out /tmp/perf-now

# Against a packaged app, including its size.
.venv/bin/python -m perf run --replies ~/resmon-perf-replies --out /tmp/perf-now \
  --executable "frontend/release/mac-arm64/resmon perf.app/Contents/MacOS/resmon perf" \
  --app-bundle "frontend/release/mac-arm64/resmon perf.app" \
  --installer frontend/release/resmon-perf-2.3.0-arm64.dmg

# Hold a candidate to a baseline: exit status 1 if any measurement fails the gate.
.venv/bin/python -m perf compare /path/to/baseline/results.json /tmp/perf-now/results.json

# The soak: the background service running a routine every three minutes for hours.
.venv/bin/python -m perf soak --hours 4 --replies ~/resmon-perf-replies --out /tmp/soak.json
# The same soak by work: 240 runs (twelve hours at that cadence), each started as the last ends.
.venv/bin/python -m perf soak --runs 240 --replies ~/resmon-perf-replies --out /tmp/soak-runs.json
# The background service as the bare engine and as the app (--service), alternated.
.venv/bin/python -m perf host --rounds 5 --replies ~/resmon-perf-replies --out /tmp/host.json
# A shared-wording scan, full and of 200 new papers, at 16,061 and 100,000 papers.
.venv/bin/python -m perf wording --out /tmp/wording.json
```

`run` writes `results.json` (every sample, the machine, the commit) and
`summary.md`. **The numbers are specific to the machine they were taken on**;
compare a run only with a baseline from the same machine.

## The gate

No measurement more than **10% worse than the baseline at the median**, or
**20% worse at the 95th percentile**. "Worse" follows each measurement's
direction: longer is worse for a duration, smaller is worse for a throughput.
A measurement present in one run and not the other is reported as *not
compared*, never as a pass.

## What isolates a run

Every process the harness starts gets its own `RESMON_STATE_DIR`,
`RESMON_DB_PATH`, `RESMON_REPORTS_DIR`, `RESMON_PORT_FILE` and Chromium profile,
and `PYTHON_KEYRING_BACKEND=keyring.backends.null.Keyring`. Port 8742, where an
installed resmon's background service listens, is never bound and never
accepted. `RESMON_STATE_DIR` alone does not isolate a run: the database, the
reports folder, and the port file each have a variable of their own, which is
why every path is pinned.

## What each part measures, and how

**Recorded replies (`replay.py`).** httpx's transports are replaced in the
backend process, beneath every source client, so a sweep builds its real
requests, goes through `safe_request` and the real rate limiters, and parses
real replies — the ones the upstream gave when recorded, served after the
latency the upstream took then. A request with no recording is refused and
written to `misses.jsonl`, and `run` stops rather than report a faster sweep
that skipped work. Recordings hold the sources' titles and abstracts, so they
are **not** kept in this repository; record your own with `perf record`, and
re-record only deliberately, because a new recording is a new baseline.

**The seeded corpus (`seed.py`).** 10,000 papers (and 100,000 for the
Explorer's large case) across the ten benchmark sources, 150 runs over six
months with a realistic mix of answers, empties and non-answers, three
routines, six saved configurations and a reading queue, built from a fixed
seed through the sweep's own storage function. Dates are relative to the day
of the build, so "the last seven days" shows the same thing on any day.

**The engine (`engine.py`)**, over HTTP against a separate backend process:

| Measurement | What it is |
|---|---|
| `backend.start_to_health` | Process spawn until `/api/health` answers |
| `sweep.10_sources.*` | A Deep Sweep of ten sources at their recorded latency: wall time, and the querying, storing and report-writing stages, seen from the run's own stage events |
| `explorer.search.*@10k`, `@100k`, `explorer.facets@*` | The Explorer's own calls: free text, browsing, and a filtered search |
| `semantic.search@10k` | The Explorer ranked by meaning, with 768-dimension vectors; the model is a loopback fake, so only resmon's side is timed |
| `memory.service.idle`, `cpu.service.idle` | The background service alone, with its scheduler |

**The interface (`frontend/perf/ui.perf.ts`)**, through Playwright:

| Measurement | What it is |
|---|---|
| `launch.cold` | Process start to the first screen *settled*, with a fresh profile and a database the app has not opened. The operating system's file cache is warm; a truly cold disk is not measured. |
| `launch.warm` | The same, relaunched |
| `navigation.<route>` | Every screen in `frontend/atlas/src/screenPaths.ts`, hash change to settled |
| `memory.app.idle.*`, `cpu.app.idle.*` | Each process role (main, renderer, GPU, backend…) after the app has idled on its first screen |

*Settled* means every request the page started has finished and the DOM has
not changed for 600 ms; the time reported is the last DOM change, so the wait
is not counted. The definition knows nothing about either interface's markup,
which is what lets the same yardstick measure the old interface and the new
one. Every request to the internet is refused, as if the machine were
offline.

**Size (`size.py`):** the renderer bundle, the installed app and its parts
(Electron, the bundled Python runtime and its libraries, the backend source),
and each installer.

**The soak (`soak.py`):** the background service, started as launchd starts it
with its scheduler on, fires a routine every three minutes for the hours asked;
memory and open files are sampled every 30 seconds, and the slope of each after
an hour of warm-up is reported. With `--runs N` it runs the routine N times
instead, each run started the moment the last one finishes and the recordings
answered without their latency (`--latency recorded` keeps it), sampling every
2 seconds. A sawtooth's peaks say when the allocator last let go, so this mode
reports blocks of 20 runs: the lowest and highest memory in each, and the slope
of each per 100 runs after the first block. A leak raises the floor. On macOS it
reads the physical footprint, which counts compressed memory; resident size is
recorded too but hides a leak once the compressor takes idle pages. It does
not measure anything that grows with time alone; `--hours` does.

**Shared wording (`wording.py`):** a full scan of the seeded corpus, then a scan of 200 papers added
to it as a run would add them (20 of them carrying a passage of a paper already held), each in a
child interpreter of its own so its peak resident size is the scan's; the child reports what the
interpreter and its modules held before the scan as well. The corpus is copied first, because the
second scan adds papers. Seeded text means nothing, so these numbers are cost, not findings; the
module's docstring has what the method finds on real abstracts.

**The service's two forms (`host.py`):** the background service as the bare
engine (`implementation_scripts.daemon`, as launchd starts it today) and as the
app launched with `--service`, which runs that same engine as its child. Each
round measures both over the same seeded corpus and recordings, alternating so
a drift in the machine lands on both: memory by role (the app's main process,
Chromium's GPU and utility processes, the engine) and in total, as resident
size and as physical footprint, 5 seconds after start and after one run, and
CPU over 30 seconds of idling. The app's notifications are written to its log,
not shown. `--executable` and `--python` measure a packaged app against the
runtime it ships. `hook/sitecustomize.py` installs the recorded-reply transport
in the engine the app starts, which `backend.py` cannot wrap.

## Known limits

- One machine, and a laptop: thermal state and background work move numbers.
  Run on power, with nothing else running, and keep the run count.
- With seven samples the 95th percentile is close to the largest one.
- The latency of a recording is the latency of one moment. It is fixed on
  purpose, so a change in resmon is not confused with a change in the internet.
- The sweep measures one query over ten sources; sources with a very different
  shape (bioRxiv's whole-window scan) are not in it.
