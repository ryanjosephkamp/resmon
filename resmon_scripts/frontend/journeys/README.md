# `journeys/` — one test per user journey, runnable against any build

`e2e/` asks whether *this* checkout's app works. This directory asks a different
question: **are the journeys a user has today still there tomorrow?**

The renderer is being rebuilt for 3.0. A suite of tests written against the
current markup would have to be rewritten alongside it, which is the same as
having no suite at all during the only period when one matters. So nothing here
touches the renderer. Every spec is written in the words of the journey it
covers — *run a dive*, *read the coverage sentence*, *back up now* — and a
**driver** behind it maps those onto one renderer's markup. When the 3.0
renderer exists it supplies `drivers/candidate.ts` and every spec here runs
against it unedited.

That is a property, not a promise: `register.spec.ts` greps every spec file for
a renderer call or an import of anything but the driver, and fails on a hit.

## Running it

```bash
cd resmon_scripts/frontend
npm run build              # the suite launches a build; it never makes one
npm run journeys           # this build, through the candidate driver
npm run journeys:classic   # this build, through the classic driver
npm run typecheck:journeys # nothing else typechecks this directory
```

### Against some other build

Two variables, and nothing else changes:

```bash
# 1. Build the app you want to measure, wherever it lives.
cd /path/to/other/resmon/resmon_scripts/frontend
npm install --no-audit --no-fund
npm run build

# 2. Run this suite against it.
cd /path/to/this/checkout/resmon_scripts/frontend
RESMON_JOURNEY_APP=/path/to/other/resmon/resmon_scripts/frontend \
RESMON_JOURNEY_DRIVER=classic \
  npm run journeys
```

The run prints which build it launched, which driver drove it and which
interpreter its backend ran under, before the first spec. If those three lines
are not what you meant, stop there.

## The variables

| Variable | Effect |
|---|---|
| `RESMON_JOURNEY_APP` | The `frontend/` directory of the build under test. Defaults to this checkout. It must already be built; the suite refuses a directory with no `dist/electron/main.js` rather than quietly building one. |
| `RESMON_JOURNEY_DRIVER` | `classic` or `candidate`. Defaults to `candidate`. Anything else stops the run — a typo that quietly fell back would report green against the wrong renderer. |
| `RESMON_JOURNEY_BREAK_ROW` | Fails one named register row on purpose, e.g. `J20`. This is how the CI job is shown to be able to go red. |
| `RESMON_JOURNEY_SCREENSHOT_DIR` | Where pictures land. Defaults to `journeys/screenshots/`, which is gitignored. |
| `RESMON_PYTHON` | The interpreter the backend runs under. It is *not* part of the build under test; it only has to have `requirements.txt` installed. |

## What is here

| File | What it is |
|---|---|
| `register.ts` | The denominator: all 44 rows of the parity register, their slice and their status. Nothing else in the suite is allowed to disagree with it. |
| `register.spec.ts` | The guards. Every built row has exactly one spec and every spec has a row; a pending row names its slice and a dropped row names its decision; no spec reaches the renderer. |
| `driver.ts` | The seam — the `JourneyDriver` interface, in the user's words, plus the `journey` test object. |
| `drivers/classic.ts` | The one file that knows a class name, a hash route or the text on a button. |
| `drivers/candidate.ts` | Re-exports the classic driver until the 3.0 build replaces its body. |
| `drivers/session.ts` | One launched resmon of whichever build is under test: launch, ask, kill, relaunch. |
| `fixtures/source-endpoint.ts` | An authored scholarly source on loopback, and the startup hook that refuses every non-loopback connection and port 8742. |
| `fixtures/gates.ts` | Runs one of the build's own pytest gates, for the rows whose journey has no screen. |
| `J<nn>-<slug>.spec.ts` | One register row each. |

## Five things to know before adding a row

**A row and a spec exist together, or the run fails.** Add a row to
`register.ts` with `slice: '1'` and no spec, and the guard says which file it
wanted. Add a spec no row claims, and it says that too. Neither direction is
optional: one alone gives you either a register nothing tests, or a suite that
has quietly stopped covering the register.

**Nothing here touches the renderer.** If a spec needs something the driver
cannot do, the answer is a new driver method named for what the *person* does,
not a selector in the spec. The guard will not let you do otherwise, and the
guard covers itself — the forbidden patterns live in `register.ts` precisely so
that no file in this directory is exempt from them.

**Every launch is offline and isolated.** A temporary `RESMON_STATE_DIR`, a
temporary Chromium profile, a null keyring, and a startup hook that refuses any
connection that is not loopback — and port 8742 in particular, which carries a
live daemon over a real corpus. Each spec ends by asserting the guard refused
nothing, so "this suite did not reach the internet" is measured rather than
assumed.

**Backend facts come from the backend, over HTTP.** `resmon.backend` reads them
through the app's own local API with the app's own token. Reading the SQLite
file would be easier and would make the suite unable to run against an installed
app, which it one day has to.

**A journey observes; it does not fix.** Where the app and the register
disagree, the spec asserts what is true, prints a `NOT VERIFIED` line naming
what it could not establish, and the disagreement goes to the register. J19 is
the worked example: the register says a cancelled run keeps a partial report,
and at this base a sweep cancelled during the query stage keeps a read-time
coverage account and no report document.

## Rows whose journey is a gate, not a screen

J16 (the weekly live-network job) and J43 (upgrade in place) are user journeys
whose evidence is a CI job and a migration. The pattern is a journey test that
runs the *existing* gate as a subprocess and asserts its exit status and the
denominators it prints. The row's evidence stays the real gate; re-implementing
it here would be a second thing to keep in step with `database.py`, and the
second one is always the one that goes stale.

`fixtures/gates.ts` is that runner and `driver.ts` re-exports it, so a spec can
use it while still importing nothing but the driver. It launches no app and
takes no driver: there is no screen, and a candidate build runs the same gate
out of its own checkout. `J43-upgrade-in-place.spec.ts` is the worked example —
it asserts the exit status, the pass/skip counts and, because exit zero says the
gate passed and not what it did, the schema range in the gate's own node id.
