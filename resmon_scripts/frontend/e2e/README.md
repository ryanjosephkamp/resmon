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
npm run typecheck:e2e  # this directory is not covered by `npm run typecheck`
```

`npm run dist` first if you also want the packaged-app spec; without a build
under `release/` it skips, and says so.

## What is here

| File | What it answers |
|---|---|
| `fixtures/resmon-app.ts` | The launch fixture. Read its header first — it carries the isolation story and two things that were found the hard way. |
| `routes.ts` | The routes, **imported** from `src/routes.ts` — the same table `App.tsx` renders from. 24 of them: 14 top-level plus the 10 Settings and About tabs those pages declare. |
| `smoke.spec.ts` | One test per route: it loads, resmon logged no error of its own, a screenshot lands in `screenshots/`. |
| `search-record.spec.ts` | Q4 — the Results report viewer's *Search record* tab, which a previous attempt reported as unclickable under automation. |
| `observability.spec.ts` | Q3 — that the console-error and failed-request collectors actually catch something. |
| `ipc-stubs.spec.ts` | Q5 — replacing the three IPC handlers from the main process, with counters proving nothing reached the OS. |
| `default-behaviour.spec.ts` | P6 — the app behaves as it always did with `RESMON_E2E` unset. |
| `zero-reason.spec.ts` | Phase 1.8.6 — a source that came back empty says why, on all three surfaces. |
| `packaged.spec.ts` | Q6 — the built `.app` launches under Playwright too. Skips when there is no build. |

## Four things to know before adding a spec

**A page cannot exist without a smoke test.** `src/routes.ts` is the one route
table; `App.tsx` renders from it and `routes.ts` here imports it, so adding a
page adds its spec. `src/__tests__/routes.test.tsx` fails when the two
disagree — including when a `<Route>` is hand-written in `App.tsx` to go around
the table, and when a Settings or About tab is declared in its own page and not
in the table's `children`. Until phase 1.8.7 this file was a hand copy and a new
route was unswept with nothing going red.

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

**Assertions are scoped to resmon's own origins.** The app embeds six YouTube
iframes and a GitHub Pages `<webview>`, and both produce console errors and
aborted requests that no change to this repository can fix. `isOwnOrigin()` is
the boundary; third-party events are printed, not asserted. The cost — a broken
embed is invisible — is recorded in the report.

## `RESMON_E2E`

Three branches in `electron/main.ts`, all test determinism, none of them
behaviour a user could want: a fixed window size (hunks 1 and 2, so a screenshot
is taken at a size that is written down) and skipping the auto-updater (hunk 3,
so the packaged run neither calls GitHub nor pops a dialog over a screenshot).
`default-behaviour.spec.ts` launches the app twice — with and without — and
asserts the unset path still maximizes.

## Environment variables the suite itself reads

| Variable | Effect |
|---|---|
| `RESMON_E2E_WIDTH` / `RESMON_E2E_HEIGHT` | The fixed window size. Defaults 1440x900. |
| `RESMON_E2E_BREAK_ROUTE` | Appends a route `App.tsx` does not declare, so the suite goes red on purpose. `ui-smoke.yml` exposes it as a `workflow_dispatch` input. |
| `RESMON_PYTHON` | Which interpreter runs the backend. Defaults to the checkout's `.venv`, falling back to `python3`. |
| `RESMON_E2E_SCREENSHOT_DIR` | Where screenshots land. Defaults to `e2e/screenshots/`, which is gitignored. |
