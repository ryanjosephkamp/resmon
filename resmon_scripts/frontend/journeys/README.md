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
| `RESMON_JOURNEY_LAG` | Delays the app's own HTTP calls, e.g. `/api/routines=2500,/api/watchdog=1500`. This is how a read-after-write race is shown to be fixed rather than merely unobserved — widen the gap a read has to survive, and a read that was only passing because the machine was quiet fails. Unset, nothing is intercepted. |
| `RESMON_JOURNEY_SCREENSHOT_DIR` | Where pictures land. Defaults to `journeys/screenshots/`, which is gitignored. |
| `RESMON_PYTHON` | The interpreter the backend runs under. It is *not* part of the build under test; it only has to have `requirements.txt` installed. |
| `RESMON_HIDDEN_WINDOW` | Set to `1` by `playwright.config.ts` for every run of this suite: the app's windows are created and loaded but never shown, so a run puts nothing on the screen. `RESMON_HIDDEN_WINDOW=0 npm run journeys` brings them back when you want to watch one. |

### Why this suite runs with nothing on the screen

A journey run launches the real app dozens of times, and it is the suite most
likely to be running while somebody is working at the same Mac.
`RESMON_BACKGROUND_WINDOW` (set here too) stops the launch taking the keyboard;
it does not stop the window appearing, and `showInactive()` is measurably a
window on the screen — a CoreGraphics census of one flagged launch's own
process subtree returned one on-screen window, 1440x900 at 144,109. With
`RESMON_HIDDEN_WINDOW=1` the same census returns none.

Two consequences worth knowing before you debug a red row here:

- **You cannot watch the run.** Re-run the row with `RESMON_HIDDEN_WINDOW=0`
  and the app behaves exactly as it did before this existed.
- **Screenshots still work** — Playwright captures from the renderer, not from
  the screen — but a screenshot cannot tell you anything about where the window
  was or whether it was in front.

Chromium's background throttling is the risk this carries, and it was measured
rather than assumed: a never-shown window on this Electron ran 366
`requestAnimationFrame` callbacks and 187 16 ms timer ticks in three seconds
against a shown window's 364 and 188, and reported
`document.visibilityState === 'visible'`. The suite's own wall-clock is the
other half of that check and it is in the pull request.

## What is here

| File | What it is |
|---|---|
| `register.ts` | The denominator: all 45 rows of the parity register, their slice and their status, and `ROUTE_ROWS` — which rows carry each page the app routes to. Nothing else in the suite is allowed to disagree with it. |
| `register.spec.ts` | The guards. Every built row has exactly one spec and every spec has a row; every page in `src/routes.ts` names a carried row; a pending row names its slice and a dropped row names its decision; no spec reaches the renderer. |
| `driver.ts` | The seam — the `JourneyDriver` interface, in the user's words, plus the `journey` test object. |
| `drivers/classic.ts` | The one file that knows a class name, a hash route or the text on a button. |
| `drivers/candidate.ts` | Re-exports the classic driver until the 3.0 build replaces its body. |
| `drivers/session.ts` | One launched resmon of whichever build is under test: launch, ask, kill, relaunch. |
| `fixtures/source-endpoint.ts` | An authored scholarly source on loopback, and the startup hook that refuses every non-loopback connection and port 8742. |
| `fixtures/gates.ts` | Runs one of the build's own pytest gates, for the rows whose journey has no screen. |
| `fixtures/authored-pdf.ts` | A PDF built from sentences a spec wrote, so J35–J37 can hold the reader's text against a known page. |
| `fixtures/selected-answer-endpoint.ts` | An authored model on loopback for selected-evidence answers, which can be told to cite text it was not sent. |
| `J<nn>-<slug>.spec.ts` | One register row each. |

## Six things to know before adding a row

**A driver waits for a state, never for a duration.** A `waitForTimeout` under
`drivers/` fails `register.spec.ts` unless the line, or the comment above it,
carries `journeys:duration-ok` and a reason — and so does a driver method that
reads the screen before it has waited for anything. The wait after a write is
`stored(…)`: the app's own record of what the write produced, read back over
its API, and only then an assertion that the screen agrees. That second
assertion has to be one the pre-write state could not satisfy, which is not
automatic — `activateRoutine` waited for a badge matching
`hasText: 'Active'`, Playwright's `hasText` string form is a case-insensitive
substring, and "Inactive" satisfied it for as long as the method existed.

**A row and a spec exist together, or the run fails.** Add a row to
`register.ts` with `slice: '1'` and no spec, and the guard says which file it
wanted. Add a spec no row claims, and it says that too. Neither direction is
optional: one alone gives you either a register nothing tests, or a suite that
has quietly stopped covering the register. The same holds one level out: every
page `src/routes.ts` routes to has an entry in `ROUTE_ROWS` naming the rows that
carry it, so a new page with no journey is a red guard rather than a page
nobody measures — which is what the Source wall was for nine days.

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
