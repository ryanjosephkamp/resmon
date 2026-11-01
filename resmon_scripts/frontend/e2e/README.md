# `e2e/` — the app, launched

Everything here drives the **real** resmon: the Electron main process, its own
spawned Python backend, a real Chromium. Before this directory existed nothing
in the repository had ever started the app — 154 renderer tests, all jsdom, and
`electron/main.ts` with no test of any kind.

It began as the deliverable of a **feasibility spike** (Delegation 06), which
answered "can an agent see the app, and what does that cost" —
[`docs/ui-verification-feasibility.md`](../../../docs/ui-verification-feasibility.md).
Phase 1.8.7 turned it into the verification layer: the route list became a
denominator rather than a copy, and screenshots stopped being committed.

## Running it

```bash
cd resmon_scripts/frontend
npm run build          # the specs launch the built app, not a dev server
npm run e2e            # everything
npm run e2e:smoke      # the route specs only
npm run e2e:window     # the window-manager specs only
npm run e2e:review     # everything, into one folder outside the repo
npm run typecheck:e2e  # this directory is not covered by `npm run typecheck`
```

`npm run dist` first if you also want the packaged-app spec; without a build
under `release/` it skips, and says so.

## What is here

| File | What it answers |
|---|---|
| `fixtures/resmon-app.ts` | The launch fixture. Read its header first — it carries the isolation story and two things that were found the hard way. |
| `fixtures/electron-fuses.ts` | Reads the fuse wire out of a built app. Two fuses are what make a packaged app driveable at all. |
| `fixtures/ipc-guards.ts` | Counting replacements for every native call `main.ts` can make, so "nothing reached the OS" is a measurement. |
| `screens.ts` | Atlas's screens, **imported** from `atlas/src/screenPaths.ts`, which its own test holds to the router: every screen at a fixed address, Settings' groups included. |
| `main-window.spec.ts` | P3–P4 — `electron/main.ts` itself, in Atlas: the in-app link window and the History menu. The window background is `atlas-appearance.spec.ts`'s. |
| `ai-settings.spec.ts` | Settings › AI in Atlas: where resmon looks for an agent command and what it says it found, the provider list, and the file picker. Discovery searches only a pinned `PATH` (`RESMON_AI_CLI_DISCOVERY=path-only`), and a guard fails the run if it could find any command but the spec's own stubs, so no real `claude` or `codex` is run. |
| `smoke.spec.ts` | One test per Atlas screen: it loads and stays at its own address, resmon logged no error of its own, a screenshot lands in `screenshots/`. |
| `search-record.spec.ts` | Q4 — the Results report viewer's *Search record* tab, which a previous attempt reported as unclickable under automation. |
| `observability.spec.ts` | Q3 — that the console-error and failed-request collectors actually catch something, in Atlas. |
| `ipc-stubs.spec.ts` | Q5 — replacing every IPC handler from the main process, with counters proving nothing reached the OS, over every Atlas screen. |
| `default-behaviour.spec.ts` | P6 — the app behaves as it always did with `RESMON_E2E` unset. |
| `zero-reason.spec.ts` | Phase 1.8.6 — `window_unanswerable` on all three surfaces. |
| `atlas-zero-reasons.spec.ts` | P13 — `upstream_failure` (a source that closes the connection), `answered_empty` (an authored empty feed) and `not_recorded`, really produced and read on Atlas's run page and run log, plus which of the ten reasons a real browser has seen. |
| `window-manager.spec.ts` | The window itself, in Atlas — maximize on open, the link window's parentage and focus, the swipe binding. Says which arms a bare-X display could not verify. |
| `zz-isolation.spec.ts` | P12 and P14 — the launch uses its own Chromium profile, the installed app's is untouched, and a run leaves the tree clean. Named `zz-` so it runs last. |
| `packaged.spec.ts` | Q6 — the built `.app` launches under Playwright too, and serves every Atlas screen. Skips when there is no build. |

## Five things to know before adding a spec

**A screen cannot exist without a smoke test.** `atlas/src/screenPaths.ts` is
the list of every screen at a fixed address, Settings' groups included;
`atlas/src/__tests__/screenPaths.test.ts` holds it to the router, and
`screens.ts` here imports it, so adding a screen adds its smoke case.

**A bare X server has no window manager.** Under `xvfb-run`, `maximize()`,
focus and stacking are silent no-ops, so a green CI tick from the ubuntu job
verifies the renderer thoroughly and the window barely — and `electron/main.ts`
is why this directory exists. Every spec that depends on a window manager
prints a `NOT VERIFIED` line and skips rather than passing quietly, the
`ui-smoke.yml` job summary collects those lines, and a second job on `macos-15`
runs the same specs where a window server exists.

**Screenshots are not committed.** `e2e/screenshots/` is gitignored: 18 PNGs
were tracked, and every stacked branch conflicted on them because both sides
regenerate every file. CI uploads the directory as a workflow artifact;
`RESMON_E2E_SCREENSHOT_DIR` points a local run somewhere outside the repository.
A committed screenshot is a merge conflict, not evidence.

**Nothing here touches the user's data.** Each launch gets a temp
`RESMON_STATE_DIR`, its own `RESMON_DB_PATH` / `RESMON_REPORTS_DIR` /
`RESMON_PORT_FILE`, and its own Electron profile via `--user-data-dir`. Port
**8742** is a live launchd daemon over a different database; every spec asserts
the backend port it found is not that one. Keep that assertion in a new spec.

**Assertions are scoped to resmon's own origins.** `isOwnOrigin()` is the
boundary; third-party events are printed, not asserted. Atlas embeds nothing
from another origin (`atlas-edges.spec.ts` asserts no frame, webview, object, or
embed on the stage), so the boundary is a guard rather than a filter now.

## `RESMON_E2E`

Three branches in `electron/main.ts`, all test determinism, none of them
behaviour a user could want: a fixed window size (hunks 1 and 2, so a screenshot
is taken at a size that is written down) and skipping the auto-updater (hunk 3,
so the packaged run neither calls GitHub nor pops a dialog over a screenshot).
`default-behaviour.spec.ts` launches the app twice — with and without — and
asserts the unset path still maximizes.

## `RESMON_BACKGROUND_WINDOW`

The suite launches the real app over and over, and every launch used to come to
the front and take the keyboard from whoever was at the machine. With this set
the windows go up with `showInactive()` and, on macOS, the process runs under
the `accessory` activation policy.

**The two halves do different things, and it is not the division you would
guess.** Four launches from a frontmost shell, reading the frontmost
application before and after the window went up:

| | frontmost app | window focused | Dock icon |
|---|---|---|---|
| `show()`, no policy | **takes the foreground** | yes | yes |
| `showInactive()` only | unchanged | no | yes |
| `show()` + `accessory` | **takes the foreground** | yes | no |
| both — what the flag does | unchanged | no | no |

`showInactive()` is what stops the foreground grab; `accessory` on its own does
not help with focus at all, and only removes the Dock icon and the menu bar. If
you are ever tempted to simplify this to one of the two, that table is the
reason to keep whichever one you were about to drop for the right reason.

`playwright.config.ts` here and `journeys/playwright.config.ts` both set it, by
calling `requestBackgroundWindows()` from [`background-window.ts`](background-window.ts).
A config module runs in the runner and in every worker before any test, and
both suites build the app's environment by copying the ambient one, so the
drivers needed no change. Set `RESMON_BACKGROUND_WINDOW=0` yourself to get the
old behavior back for one run.

**One job must not have it.** `ui-smoke.yml`'s *Window behaviour (Electron on
macOS)* job exists to watch maximize, focus and stacking, and a run with this
flag has none of those to watch — no window ever reports focus, so the job would
keep passing while testing something nobody ships. That job sets
`RESMON_WINDOW_BEHAVIOR_JOB=1`; `background-window.ts` declines to set the flag
when it sees that, and throws if both arrive together, which takes the run down
before the first spec. `src/__tests__/backgroundWindow.test.ts` is the static
half and reads the workflow on every pull request.

**What a local `npm run e2e` on macOS no longer verifies.** That exemption is
not bookkeeping. `window-manager.spec.ts`'s link-window focus arm calls
`test.skip()` when no window reports focus, and under this flag no window ever
does — so on your own Mac that assertion is now skipped rather than run, every
time, and the run still goes green. The macOS window job is what keeps it
honest, which is the whole reason that job is exempted. If you are changing
link-window focus behavior, run it with `RESMON_BACKGROUND_WINDOW=0` or you will
not be testing your change.

Two known costs: under `accessory` the app has no system menu bar and no Dock
icon, so a developer watching a run cannot reach resmon with Cmd+Tab or use its
menus by hand; and the skip above. `Menu.getApplicationMenu()` still returns the
menu, `getMenuItemById()` still finds the item and the item is still enabled —
measured under the policy — so `main-window.spec.ts` P4 is unaffected.

## Environment variables the suite itself reads

| Variable | Effect |
|---|---|
| `RESMON_BACKGROUND_WINDOW` | `1` shows windows inactive and, on macOS, runs under the `accessory` activation policy. Both Playwright configs set it; `0` opts out. |
| `RESMON_WINDOW_BEHAVIOR_JOB` | `1` marks a run whose subject is the window. The configs never set the background flag for it and refuse to run if something else did. |
| `RESMON_E2E_WIDTH` / `RESMON_E2E_HEIGHT` | The fixed window size. Defaults 1440x900. |
| `RESMON_E2E_BREAK_ROUTE` | Appends a route `App.tsx` does not declare, so the suite goes red on purpose. `ui-smoke.yml` exposes it as a `workflow_dispatch` input. |
| `RESMON_PYTHON` | Which interpreter runs the backend. Defaults to the checkout's `.venv`, falling back to `python3`. |
| `RESMON_E2E_SCREENSHOT_DIR` | Where screenshots land. Defaults to `e2e/screenshots/`, which is gitignored. |
| `RESMON_E2E_REVIEW_DIR` | Where `npm run e2e:review` writes. Defaults to a timestamped folder under the OS temp directory. |
