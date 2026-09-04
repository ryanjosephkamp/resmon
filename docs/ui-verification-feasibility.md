# Can an agent see the app?

**Delegation 06 — a feasibility spike.**

> **Phase 1.8.7 addendum (2026-09-04).** This report is left as written: it is
> the record of what was true when the spike ran, and its three caveats are the
> reason the phase that followed had the shape it did. What has changed since:
>
> 1. **The route list is no longer a copy.** `src/routes.ts` is the one table;
>    `App.tsx` renders from it and `e2e/routes.ts` imports it, and
>    `src/__tests__/routes.test.tsx` fails when they disagree. The sweep also
>    grew from 14 routes to **24** — the six Settings tabs and four About tabs
>    had never been visited, because the suite reached `/settings`, landed on
>    the index redirect, and never saw the other five.
> 2. **The two third-party surfaces are asserted, positively.**
>    `e2e/third-party.spec.ts` scrolls each of the **seventeen** YouTube embeds
>    (this report said six; it counted the ones that load eagerly) into view,
>    evaluates *inside* the cross-origin frame, and requires a mounted player,
>    no `.ytp-error`, and a real video title — because a removed video answers
>    **HTTP 200** and a status check would call it healthy. The blog
>    `<webview>` is watched from the main process through
>    `web-contents-created`. A machine that cannot reach either origin skips,
>    printing what it did not verify.
> 3. **The fuses are read, not trusted.** `e2e/fixtures/electron-fuses.ts`
>    parses the fuse wire out of the built binary and `packaged.spec.ts` fails
>    if `RunAsNode` or `EnableNodeCliInspectArguments` is disabled;
>    `src/__tests__/electronFuses.test.ts` fails in **CI** if the build block
>    ever asks for them off, which is the half that a local-only packaged spec
>    could not cover. The parse was checked against `npx @electron/fuses read`,
>    and flipping the byte by hand was confirmed to make the packaged app fail
>    to launch at all.
>
> Still open, and named in the 1.8.7 handback rather than here: Windows, Intel
> macOS, a signed or quarantined app, the packaged app on CI, and any
> window-manager behaviour under xvfb. Branched from `8fa38ba` (phase 1.8.5's
four PRs, `#51`–`#54`), which is past the `6d38f8d` the brief was written
against; the brief said to say so, and this is that.

resmon is an Electron shell around a Python backend, and **nothing had ever
launched it under automation**. 154 renderer tests across 21 suites, all jsdom,
none of which renders the real app in a real browser engine. `electron/main.ts`
— 708 lines carrying every v1.8.3 interface fix — has no test of any kind. The
release workflow builds four installers and verifies the Python interpreter
inside them without ever opening a window. The maintainer reviews the interface
by hand, from a phone.

**This spike establishes whether the conventional route — Playwright driving the
app's own Electron — works against this app, and what it costs. It does not
design the verification layer; that is phase 1.8.7's job.**

---

## Verdict

**Viable, with three caveats, all of them cheap.**

Everything the brief asked about works, on the first serious attempt, on both a
checkout and the packaged `.app`. The session-5 failure does not reproduce. The
caveats are:

1. **The route list is a copy.** `e2e/routes.ts` is copied by hand from
   `App.tsx`, because making the route table the single source of truth is a
   change to `src/**` that this spike was not permitted to make. Until 1.8.7
   does it, **a route added to `App.tsx` and not to `routes.ts` is unswept and
   nothing fails.**
2. **Assertions are scoped to resmon's own origins.** The app embeds six
   `youtube-nocookie.com` iframes and a GitHub Pages `<webview>`, and both
   produce console errors and aborted requests that no change to this repository
   can fix. Scoping the assertions to `127.0.0.1` is what makes the suite a
   signal rather than a coin-flip — and it means **a broken embed is invisible
   to the smoke suite.**
3. **A CI runner under xvfb has no window manager**, so anything window-level —
   maximize, the `swipe` gesture, focus, stacking — is invisible there even
   though every route renders correctly. And this is one machine and one
   runner: macOS 15 on arm64 plus `ubuntu-24.04`. Windows, Intel macOS, a
   *signed* app and a Gatekeeper-quarantined app are all untested — see *What
   could not be established*.

The costs: **18.1 MiB** of `node_modules`, **zero** bytes in any installer, and
**~11 s** for a 14-route pass locally.

---

## The environment every number below was measured in

| | |
|---|---|
| Host | macOS (Darwin 25.3.0), arm64 |
| Node / npm | v25.2.1 / 11.6.2 |
| Python (backend) | 3.11.5, the checkout's `.venv` |
| Electron | **41.10.6** (`npx electron --version`) |
| Chromium inside it | 146.0.7680.216 |
| Node inside it | 24.18.0 |
| Playwright | **`@playwright/test@1.62.1`**, pinned exact |
| CI | `ubuntu-latest`, Node 20, Python 3.11 |

`@playwright/test@1.62.1` declares `"engines": {"node": ">=20"}`. CI runs Node
20 — exactly at the floor, which is worth knowing before anyone lowers it.

---

## Q1 — does `_electron.launch()` start this app?

**Yes.** First attempt, no workarounds.

```ts
const app = await electron.launch({
  args: ['.', `--user-data-dir=${…}`],
  cwd: 'resmon_scripts/frontend',
  env: { RESMON_STATE_DIR, RESMON_DB_PATH, RESMON_REPORTS_DIR,
         RESMON_PORT_FILE, RESMON_PYTHON, RESMON_E2E: '1', … },
});
const win = await app.firstWindow({ timeout: 180_000 });
```

The very first probe printed:

```
VERSIONS {"electron":"41.10.6","node":"24.18.0","chrome":"146.0.7680.216"}
URL      http://127.0.0.1:58714/index.html
TITLE    resmon
```

Playwright's Electron support is documented as experimental and its
supported-version list predates Electron 41. That turned out not to matter:
`_electron.launch()` runs the Electron binary already in `node_modules`, so
there is no version negotiation to fail.

**It downloads nothing.** `npm install @playwright/test` added no browser to
`~/Library/Caches/ms-playwright` — the newest directory there predates this work
by a month. `_electron.launch()` uses the app's own Electron, and `npx
playwright install` is never run. The one thing CI does install is
`playwright install-deps chromium`, which is the *system libraries* Chromium
links against — needed for the app's own Electron on a bare runner, not a
browser download.

### What the launch environment has to say

`main.ts` reads exactly two environment variables (`RESMON_STATE_DIR`,
`RESMON_PYTHON`) and the backend reads three more. Together they are the whole
isolation story:

| Variable | Why |
|---|---|
| `RESMON_STATE_DIR` | A fresh temp directory, so `tryAttachToDaemon()` finds no lock file and the app spawns its own backend instead of attaching to the launchd daemon on 8742. |
| `RESMON_DB_PATH`, `RESMON_REPORTS_DIR`, `RESMON_PORT_FILE` | **In a checkout `main.ts` sets none of these** — it only sets them when `app.isPackaged`. Without them the spawned backend writes `resmon.db` into the repository root. |
| `RESMON_PYTHON` | The checkout's `.venv`; falls back to `python3` on CI. |
| `--user-data-dir` | Not resmon's — Chromium's. See the finding below. |

**No pinned backend port is needed, and that is worth recording.** `main.ts`
picks a free port and hands it to the renderer through the preload's
`--backend-port=` argument, so the suite reads it back out with
`window.resmonAPI.getBackendPort()`. That is one fewer `RESMON_E2E` branch than
the brief anticipated. Every spec asserts the port it found is **not 8742**.

### Finding: `RESMON_STATE_DIR` does not isolate Electron

The first full run returned a window whose bounds were 1440×900 and whose
renderer reported a viewport of **1200×723**.

```
MAIN     {"bounds":{"width":1440,"height":900},"maximized":false,"zoom":1.2,"scale":2}
RENDERER {"inner":[1200,723],"outer":[1440,900],"dpr":2.4000000953674316}
```

The zoom factor was **1.2**, and it came from outside the test:

```
APP {"userData":"/Users/…/Library/Application Support/resmon","isPackaged":false}
```

`RESMON_STATE_DIR` isolates the *backend's* state — database, reports, daemon
lock. It does nothing about Chromium's own profile, which `app.getPath(
'userData')` puts in the real `~/Library/Application Support/resmon`: the
directory the installed app uses. The suite was reading a per-origin zoom level
somebody had set in a real session, and writing into that profile as it went.

Passing Chromium's `--user-data-dir` switch in `args` fixes it, and costs no app
change at all — the switch is handled before any of `main.ts` runs:

```
MAIN     {"bounds":{"width":1440,"height":900},"maximized":false,"zoom":1}
RENDERER {"inner":[1440,868],"outer":[1440,900],"dpr":2}
APP      {"userData":"/private/var/folders/…/T/resmon-e2e-rO2ynO/electron-user-data"}
```

**For 1.8.7:** a verification layer that isolates only `RESMON_STATE_DIR` reads
the developer's persisted renderer state and writes to their profile. Both halves
matter — a screenshot taken at an inherited zoom is not evidence of anything.

---

## Q2 — all fourteen routes, screenshotted?

**Yes. 14 of 14.** The denominator is `ROUTES` in `e2e/routes.ts`, **copied by
hand** from `App.tsx`'s `<Routes>` block at `8fa38ba`, and the copy is noted in
that file and in caveat 1 above.

```
$ npm run e2e:smoke
Running 14 tests using 1 worker
  ✓  1 route smoke › Dashboard (/) loads with no console errors (1.6s)
  ✓  2 route smoke › Deep Dive (/dive) … (721ms)
  …
  ✓ 14 route smoke › About resmon (/about-resmon) … (629ms)
  14 passed (12.5s)
```

Screenshots land in `e2e/screenshots/`, one per route, at a window of
**1440×900** with a **1440×868** viewport (the 32 px is the title bar) on a
device-pixel-ratio-2 display, so each PNG is 2880×1736. The size is fixed by
`RESMON_E2E` precisely so that caption means something; see Q7.

Each spec asserts three things:

1. `.app-main` is visible — the shell painted.
2. **`main.main-content` is non-empty.** This is the assertion that matters and
   it was not the first one written. The first version asserted that `body` had
   text, which **passes on a route that renders nothing at all**, because the
   sidebar's own labels satisfy it. `Layout/MainContent.tsx` renders
   `<main className="main-content">{children}</main>` and nothing else, so it is
   empty exactly when `<Routes>` matched nothing. Q5's `break_route`
   demonstration below is what proved the difference.
3. No console error and no failed request **from resmon's own origins** — see
   Q3 for what that scoping is and what it costs.

### How the corpus was seeded

Through the backend's own API, from the renderer's own origin: a Deep Dive
`POST /api/search/dive` against arXiv. `prepare_execution()` inserts the
execution row *before* the worker thread touches the network, so this seeds an
execution whether or not the machine can reach arXiv — the spec asserts on the
tab activating, never on papers coming back. Nothing writes to SQLite directly;
the schema is not a spike's to write to.

Twelve of the fourteen routes render fine against an **empty** database, which
is itself worth knowing: empty states are real states and they all paint.

---

## Q3 — console errors and failed requests, per page?

**Yes, both**, and a third channel the brief did not name.

| Channel | Provoked how | Captured |
|---|---|---|
| `page.on('console')` | `console.error('e2e-provoked-console-error')` | `{"route":"/analytics","text":"e2e-provoked-console-error","location":":1:12"}` |
| `page.on('requestfailed')` | `page.route('**/api/analytics/**', r => r.abort('failed'))` | `{"route":"/analytics","url":"http://127.0.0.1:59626/api/analytics/overview","failure":"net::ERR_FAILED"}` |
| `page.on('pageerror')` | `setTimeout(() => { throw new Error(…) })` | `{"route":"/watchdog","text":"[pageerror] e2e-provoked-uncaught","location":"uncaught"}` |

**`pageerror` is not optional.** An uncaught exception in the renderer — a React
render crash, the thing a smoke suite most needs to catch — is not a `console`
event. Without the third listener the console collector stays empty and the
suite stays green.

One thing the aborted-request provocation established by accident: resmon
handles a failed Analytics fetch **without logging anything**. The page degrades
quietly. So `requestfailed` is the only channel that sees a broken backend call,
and a verification layer that watches only the console would miss every one.

### Finding: the assertions had to be scoped, and it cost something

Running `smoke.spec.ts` alone was green 5 times out of 5. Running the whole
suite failed **3 times out of 3**, and then **5 times out of 5**, for two
different reasons — neither of them resmon's fault, and both of them worth
writing down because 1.8.7 will hit them again.

**First: third-party requests.** About resmon → Tutorials embeds six
`youtube-nocookie.com` iframes. Navigating away cancels whatever they still have
in flight, and Chromium reports each as `net::ERR_ABORTED`, arriving after the
next route is current and filed against whichever route that is:

```
Error: failed requests on /:
[ { "route": "/", "url": "https://www.youtube-nocookie.com/embed/C9F5H_-mzzY?…",
    "failure": "net::ERR_ABORTED" }, … ]
```

Between 2 and 6 of them per run, on the Dashboard, which embeds no video at all.

**Second: third-party console errors.** YouTube's own player bundle logs one:

```
"Permissions policy violation: compute-pressure is not allowed in this document."
  at https://www.youtube-nocookie.com/s/player/9470c977/player_embed_es6.vflset/en_US/base.js:5405
```

1 run in 5, from a player build number that changes between runs.

Both assertions are now scoped by `isOwnOrigin()` — resmon's own origins are
`http://127.0.0.1:*` (the renderer's static server and the backend) plus
messages with no source URL, which is what a `page.evaluate` raises. Third-party
events are **printed, not dropped**, so a person reading the log still sees them.

**What that scoping cannot see, stated plainly: a broken YouTube embed, or a
broken blog `<webview>`, no longer fails the suite.** Those are two real
user-visible surfaces on the About resmon page. If 1.8.7 wants them covered, it
needs a check that asserts the embed *loaded* rather than one that asserts
nothing failed.

### Finding: worker-scoped collectors leak across spec files

`observability.spec.ts` deliberately provokes a console error on `/analytics`.
It sorts before `smoke.spec.ts`, and with `workers: 1` Playwright reuses one
worker across files — so the Analytics smoke test inherited the provocation and
went red on 5 of 5 full-suite runs while the smoke file alone was green on 5 of
5. An auto-use fixture empties the collectors before each test. What that still
cannot fix, and what the fixture header says: a *late* event from the previous
route inside the same test is filed against the wrong route.

---

## Q4 — does the session-5 failure reproduce?

**No. The Search-record tab activates.** This was the most important question
this spike could answer and the answer is unambiguous.

Session 5 drove the renderer with headless Chrome against a served build and
reported that the report viewer's *Search record* tab "would not activate under
headless click automation". Under Playwright driving the app's own Electron, on
a real display, with a real trusted input event at the element's hit point:

```
Q4 DOM AFTER CLICK {
  "classesBefore":"tab-btn ",
  "classesAfter":"tab-btn tab-active",
  "activeLabel":"Search record",
  "recordPanelCount":1,
  "finalStatus":"completed"
}
```

The class transitions, `.tab-bar .tab-btn.tab-active` resolves to exactly one
element and its label is *Search record*, and `.search-record` — the panel the
tab selects, which fetches `/api/executions/{id}/search-record` on mount —
renders. The screenshot is `e2e/screenshots/15-search-record-tab.png`.

The click is `locator.click()`, dispatched through Chromium's input pipeline,
not `element.click()` and not a synthetic `MouseEvent`. That distinction is the
whole question: a React `onClick` fires for all three, but an element that is
covered, scrolled out of view or zero-size fails only the real one.

**What changed since session 5 is not knowable from here.** Three things differ
at once — Playwright instead of raw CDP, the app's own Electron instead of a
separate headless Chrome, and a real window instead of headless — and the
session-5 attempt is not in the repository to re-run. The honest statement is
that the failure does not reproduce in this configuration, not that a specific
one of those three was the cause.

---

## Q5 — can the three IPC channels be stubbed?

**Yes, from the main process, and nothing reaches the operating system.**

`electronApp.evaluate()` runs in the main process with the `electron` module in
scope, so `ipcMain.removeHandler()` followed by `ipcMain.handle()` **replaces**
the real handler rather than intercepting it — `dialog.showOpenDialog` is never
reached at all.

```
Q5 IPC RESULTS {"chosen":"/tmp/e2e-chosen-directory","opened":"","revealed":true}
Q5 GUARD COUNTS {
  "stubbed":{"chooseDirectory":1,"openPath":1,"revealPath":1},
  "escaped":{"showOpenDialog":0,"showMessageBox":0,"openExternal":0,
             "openPath":0,"showItemInFolder":0}
}
```

The `escaped` row is the point. "No native dialog opened" is a *measurement*,
not an inference: every OS-facing call `main.ts` makes is replaced with a
counter first. The five are the complete set, taken from
`grep -n 'dialog\.\|shell\.' electron/main.ts` — `dialog.showOpenDialog`,
`dialog.showMessageBox` (the auto-updater's prompt), `shell.openExternal`,
`shell.openPath`, `shell.showItemInFolder`.

A full pass over all fourteen routes with the guards installed:

```
P4 GUARD COUNTS AFTER FULL PASS {
  "stubbed":{"chooseDirectory":0,"openPath":0,"revealPath":0},
  "escaped":{"showOpenDialog":0,"showMessageBox":0,"openExternal":0,
             "openPath":0,"showItemInFolder":0}
}
```

Merely visiting every page opens nothing — which is expected, since all three
channels are behind buttons. The measurement that matters for 1.8.7 is that when
the buttons *are* pressed, the stubs answer and the OS never hears about it.

**What this cannot see:** the guards are installed after the app is up, so
anything a dialog might do during startup is outside them. Nothing in `main.ts`
does, but that is read from the code rather than measured.

---

## Q6 — CI under xvfb, and the packaged app

### The packaged app: **yes**

```
Q6 PACKAGED APP {"isPackaged":true,"version":"1.8.4","electron":"41.10.6",
                 "resources":"…/release/mac-arm64/resmon.app/Contents/Resources"}
Q6 PACKAGED BACKEND PORT 61145
Q6 PACKAGED EMPTY ROUTES []
```

All fourteen routes render from the shipped bundle, driven through
`executablePath: resmon.app/Contents/MacOS/resmon`, with the app's *own* bundled
Python rather than the checkout's venv (`RESMON_PYTHON` is deleted from the
packaged launch env on purpose). `RESMON_STATE_DIR` still redirects the state,
and `RESMON_DB_PATH` / `RESMON_REPORTS_DIR` are honoured because `main.ts` sets
them with `||`.

### The fuse: `EnableNodeCliInspectArguments` is **Enabled**

Playwright drives the main process over the Node inspector, so this fuse decides
whether `electronApp.evaluate()` works on a packaged app at all. Electron
Forge's default template disables it. **electron-builder 26.15.3 does not flip
fuses**, and resmon's `build` block asks for none:

```
$ npx @electron/fuses read --app release/mac-arm64/resmon.app
Fuse Version: v1
  RunAsNode is Enabled
  EnableCookieEncryption is Disabled
  EnableNodeOptionsEnvironmentVariable is Enabled
  EnableNodeCliInspectArguments is Enabled
  EnableEmbeddedAsarIntegrityValidation is Disabled
  OnlyLoadAppFromAsar is Disabled
  LoadBrowserProcessSpecificV8Snapshot is Disabled
  GrantFileProtocolExtraPrivileges is Enabled
  WasmTrapHandlers is Enabled
```

**This is a fact with a shelf life.** `RunAsNode` and
`EnableNodeCliInspectArguments` being on is what makes the packaged app
driveable — and both are also the fuses a hardening pass would want to turn
*off*. If resmon ever flips them, packaged-app verification stops working the
same day, silently. Worth a note wherever fuses are eventually configured.

### Playwright ships in no installer

`build.files` is `["dist/**/*", "package.json"]`, and electron-builder adds
production `dependencies` only. `@playwright/test` is a devDependency, so:

```
$ npx @electron/asar list app.asar | wc -l      → 723
$ npx @electron/asar list app.asar | grep -ci playwright → 0
```

**0 of 723 entries.** DMG sizes: `resmon-1.8.3-arm64.dmg` **221,086,731 B**
(built 2026-09-02, before this branch) → `resmon-1.8.4-arm64.dmg`
**221,100,923 B** (built on this branch), a difference of **14,192 bytes**
(+0.006%). That comparison spans a version bump and phase 1.8.5's whole backend,
so it is not a clean control — the asar listing is the real evidence and the
`files` glob is the reason.

`node_modules` grew **553 MB → 572 MB**. The three packages are `@playwright`
60 KB, `playwright` 5.0 MB, `playwright-core` 13 MB — **18.1 MiB**.

### xvfb on `ubuntu-latest`: see the CI run

`.github/workflows/ui-smoke.yml` runs the suite under
`xvfb-run --auto-servernum --server-args='-screen 0 1600x1000x24'`. The window
is fixed at 1440×900 by `RESMON_E2E`; the virtual display has to be larger than
the window, which is the only reason the screen size is stated.

The job installs Electron's system libraries with `sudo npx playwright
install-deps chromium` — used here for the app's own Electron, not to fetch a
browser — and `xvfb` from apt. It installs the backend's Python requirements
too, because the app under test spawns the real FastAPI backend; without that
the window opens and every page reads *Backend: Offline*.

**Yes — the app launches and every route is walked under xvfb**, on
`ubuntu-24.04` (runner image `20260831.293`), Node 20.

| Run | What it shows | Result |
|---|---|---|
| [33821624928](https://github.com/ryanjosephkamp/resmon/actions/runs/33821624928) | The first run, before the P6 correction below | 19 passed, 1 skipped, **1 failed** in 41.5 s |
| [33821961524](https://github.com/ryanjosephkamp/resmon/actions/runs/33821961524) | The suite as it stands | **20 passed**, 1 skipped, 34.7 s |
| [33822159270](https://github.com/ryanjosephkamp/resmon/actions/runs/33822159270) | `break_route=/no-such-page` — the P5 demonstration below | 20 passed, **1 failed** |

The skip is `packaged.spec.ts`, by design. **The first run's failure was this
spike's own spec, not the app, and it is a finding worth more than the green
tick.**

### Finding: xvfb has no window manager, so `maximize()` does nothing

`default-behaviour.spec.ts` asserted that with `RESMON_E2E` unset the window
maximizes. On CI it came back:

```
P6 RESMON_E2E UNSET {"bounds":{"width":1280,"height":820},"maximized":false,
                     "workArea":{"width":1600,"height":1000},…}
P6 RESMON_E2E SET   {"bounds":{"width":1440,"height":900},"maximized":false,
                     "workArea":{"width":1600,"height":1000},…}
```

`xvfb-run` starts a bare X server with **no window manager**, and
`BrowserWindow.maximize()` is a request that a window manager honours. With none
present the call is a no-op: the window stayed at the constructor's 1280×820 on
a 1600×1000 virtual screen. That is not the app misbehaving, and no
`RESMON_E2E` branch caused it.

The spec now asserts the portable property — *with the flag unset the app does
not take the E2E size, and takes whichever pre-flag size the display allows* —
and **logs which arm held**, so a run says out loud whether it verified the
maximize or not:

```
P6 UNSET WINDOW OUTCOME maximized to the work area (a window manager honoured it)     ← macOS
P6 UNSET WINDOW OUTCOME left at the 1280x820 default (no window manager — bare X,
                        e.g. xvfb); the maximize-on-open behaviour is NOT verified
                        by this run                                                   ← CI
```

**For 1.8.7, this generalises past one assertion.** Anything that depends on a
window manager is invisible on a bare-X runner: maximize and restore, the
`swipe` gesture `main.ts` binds for history navigation, window-level focus,
multi-window stacking, and anything about the title bar. A CI job under xvfb
verifies the *renderer* thoroughly and the *window* barely. If window behaviour
matters, the runner needs a light window manager alongside xvfb, and that is a
decision rather than an oversight.

---

### P5 — the job fails when a route fails to load, demonstrated

`ui-smoke.yml` takes a `break_route` `workflow_dispatch` input which sets
`RESMON_E2E_BREAK_ROUTE`; `routes.ts` then appends a route `App.tsx` does not
declare. React Router renders nothing for it while the sidebar and header paint
normally — the exact failure a smoke suite exists to catch.

Run [33822159270](https://github.com/ryanjosephkamp/resmon/actions/runs/33822159270),
dispatched with `break_route=/no-such-page`:

```
✘ 22 route smoke › Deliberately broken route (/no-such-page) loads with no console errors (622ms)
   Error: route /no-such-page rendered an empty <main class="main-content">
   Expected: > 0
   Received:   0
1 failed, 20 passed (36.0s)
```

The job exits non-zero. It is a `workflow_dispatch` input rather than a commit
on purpose: **a demonstration that needs a commit to reproduce stops being
reproducible the moment the commit is reverted.** Anyone can re-run it, from the
Actions tab or with:

```bash
gh workflow run ui-smoke.yml --repo ryanjosephkamp/resmon \
  --ref spike/ui-verification -f break_route=/no-such-page
```

The same input works locally: `RESMON_E2E_BREAK_ROUTE=/no-such-page npm run e2e:smoke`.

**And the mutation this demonstration actually performed.** With the *first*
version of the assertion — `body` has text, rather than `main.main-content` has
text — the broken route **passed**, because the sidebar's own labels satisfied
it. The break_route input did not merely confirm a working guard; it is what
found that the guard was not one.

---

## Q7 — what the app needed, and the `RESMON_E2E` guard

**Three hunks in `electron/main.ts`, all behind one guard, all test determinism.
None of them is behaviour a user could want, and none changes what the app
shows.**

| Hunk | Where | Why |
|---|---|---|
| 1 | `createWindow()`, the `BrowserWindow` constructor | A fixed window size from `RESMON_E2E_WIDTH` / `RESMON_E2E_HEIGHT`, defaulting to 1440×900. A maximized window is a different size on every machine and on CI it is whatever xvfb was told to be. A screenshot is only evidence if the viewport is written down. |
| 2 | `createWindow()`, the `ready-to-show` handler | `if (!isE2E()) mainWindow?.maximize()`. The other half of hunk 1 — maximizing would discard the size the constructor was given immediately. |
| 3 | `initAutoUpdater()` | An early return, so the packaged run neither calls the GitHub releases feed nor pops the "Update ready" dialog over a screenshot. **Unreachable in a checkout** — the `!app.isPackaged` return above it fires first. |

### What the brief expected and was not needed

- **A pinned backend port.** Not needed. The preload already carries the port
  the main process chose; the suite reads it back.
- **A way to skip the daemon-lock probe.** Not needed. `RESMON_STATE_DIR`
  pointing at an empty temp directory means `readLockFile()` returns `null` on
  every attempt and the app spawns its own backend. It costs two 250 ms backoffs
  and no health probe.

### How "unchanged when unset" was checked

Not by reading the diff. `e2e/default-behaviour.spec.ts` launches the same app
**twice**, from environments built by the same `launchEnv()` function and
differing in nothing but `RESMON_E2E`, and compares behaviour:

```
P6 RESMON_E2E UNSET {"bounds":{"width":1728,"height":1084},"maximized":true,
                     "workArea":{"width":1728,"height":1084},"zoom":1,
                     "title":"resmon","backendPort":"59956"}
P6 RESMON_E2E SET   {"bounds":{"width":1440,"height":900},"maximized":false,
                     "workArea":{"width":1728,"height":1084},"zoom":1,
                     "title":"resmon","backendPort":"59997"}
```

Unset, the window still maximizes to the full work area. Both launches agree on
everything the flag does not control: title, renderer URL shape, the preload
bridge, `isPackaged`, and spawning their own backend rather than attaching to
8742.

**Hunk 3 is not covered by this**, and that is stated rather than worked around:
in a checkout `initAutoUpdater` returns before it reaches the `isE2E()` line, so
there is no behaviour to observe. Covering it needs a packaged app on Windows or
Linux — see below.

### What `src/**` would want, proposed and not done

`src/**` was outside this spike's grant, so these are proposals for 1.8.7:

1. **Export the route table from `App.tsx`** and import it in `routes.ts`. This
   is the single highest-value change here: it turns a hand copy into a
   denominator, and makes "a route with no smoke test" impossible rather than
   merely unlikely. `mcp_server.TOOLS` is the model.
2. **`data-testid` on the report-viewer tabs.** `.tab-bar .tab-btn` matched by
   text works today and will keep working until somebody rewords a tab.
3. **A stable hook on each page's root**, so "the route rendered" can be
   asserted against that page rather than against `main.main-content` being
   non-empty. The current assertion is honest but coarse: a page that rendered
   only its title bar passes it.

---

## Q8 — how long, and how flaky

**Route smoke alone — 5 of 5 green.**

| Run | Wall clock | Result |
|---|---|---|
| 1 | 12.3 s | 14 passed |
| 2 | 11.7 s | 14 passed |
| 3 | 11.6 s | 14 passed |
| 4 | 11.7 s | 14 passed |
| 5 | 11.7 s | 14 passed |

**The whole suite (21 tests, 6 files) — 5 of 5 green**, after the two scoping
fixes in Q3:

| Run | Wall clock | Result |
|---|---|---|
| 1 | 71.5 s | 21 passed |
| 2 | 47.8 s | 21 passed |
| 3 | 40.9 s | 21 passed |
| 4 | 50.9 s | 21 passed |
| 5 | 40.6 s | 21 passed |

The spread — 40.6 s to 71.5 s — is the arXiv call in `search-record.spec.ts` and
the `npm run dist` app launch in `packaged.spec.ts`, both of which do real work.
The route sweep itself is ~600 ms per route and barely moves.

**And the runs before the fixes, because they are the more useful number:**

| Configuration | Result |
|---|---|
| Whole suite, before any scoping | 0 of 3 green — YouTube `ERR_ABORTED` on the Dashboard |
| Whole suite, requests scoped only | 0 of 5 green — the leaked provoked console error on `/analytics` |
| Whole suite, both scoped + collectors reset | 5 of 5 green |

A single spec file being green five times running said nothing about the suite.
That is the durable lesson from Q8 and it is why the table above reports both.

**The app launches once per worker, not once per test.** Fourteen cold launches
would be ~110 s instead of ~12 s, which is the difference between a job that can
run on every PR and one that cannot. The cost is that routes are not isolated
from one another; the collectors tag every event with the route that was current
when it fired, so a misattribution shows up as a surprising route rather than as
nothing.

---

## What could not be established from where this stood

Named plainly, because a spike that lists only what worked is not a spike.

- **Windows and Intel macOS.** One machine, arm64. `packaged.spec.ts` has the
  path for `win-unpacked` and `linux-unpacked` written down but neither has been
  run. The release matrix has four targets and this covers one and a half.
- **A signed or notarized app.** The `.app` measured here is unsigned
  (`CSC_IDENTITY_AUTO_DISCOVERY=false`), which is what resmon ships today —
  Apple enrolment is deferred. Whether a *hardened-runtime, signed* app still
  accepts the Node inspector argument Playwright launches it with is untested,
  and hardened runtime is exactly the setting that would break it.
- **Gatekeeper quarantine and app translocation.** The same gap Delegation 05
  recorded for sqlite-vec (Ledger 30). A `.app` run from a quarantined download
  is a different filesystem situation from one run out of `release/`.
- **The packaged app on CI.** The `ui-smoke.yml` job skips `packaged.spec.ts`;
  building an installer downloads a Python runtime and takes minutes. Packaged
  verification is a local, on-demand thing today.
- **Whether hunk 3 works.** `initAutoUpdater`'s `RESMON_E2E` return is
  unreachable in a checkout and the packaged run was macOS, where the updater is
  disabled anyway. It is written from the code, not measured.
- **Any window-manager behaviour, on CI.** Maximize and restore, the `swipe`
  gesture bound in `main.ts` for history navigation, window focus and stacking.
  All work locally; none is observable under `xvfb-run` as configured.
- **Why session 5 failed.** Three variables changed at once. This spike
  establishes that the failure does not reproduce here; it does not establish
  which difference was responsible.
- **Anything below the smoke line.** Every spec here asserts that a page
  *loads*. Nothing asserts that it is *correct* — no visual regression, no
  layout assertion, no accessibility check. Whether 1.8.7 wants any of those is
  its decision; this spike deliberately did not make it.

---

## Verification ledger

Per `workspace/plans/HANDBACK-FORMAT.md`. One row per property in the brief's
P-list. **Cannot see** is mandatory and non-empty.

| P | Check | Boundary | Establishes | Cannot see | Mutation | Denominator |
|---|---|---|---|---|---|---|
| **P1** — the app launches and `firstWindow()` resolves | `e2e/fixtures/resmon-app.ts` `app`/`win` fixtures; every one of the 21 tests depends on them | **real dependency, out-of-process** — the app's own Electron 41.10.6 binary, its own spawned Python backend, a real display locally and xvfb on CI | `_electron.launch()` starts resmon from `resmon_scripts/frontend`, `firstWindow()` resolves, and the window is serving `http://127.0.0.1:<port>/index.html` with the preload bridge attached | A launch that succeeds but takes minutes; the 180 s timeout would pass it. Nothing here measures startup time. Also: launch on Windows, on Intel macOS, or from a signed or quarantined bundle | Not mutated — a launch failure is not a subtle state, and the first CI run and the packaged-app run are two independent confirmations | 2 of 2 launch modes exercised (checkout, packaged `.app`); packaged on macOS arm64 only |
| **P2** — each of the 14 routes loads with zero console errors | `e2e/smoke.spec.ts`, parametrised over `ROUTES` | **real dependency, out-of-process** — real Chromium, real backend | Each route sets `location.hash`, renders a non-empty `main.main-content`, and produces no console error and no failed request **from `127.0.0.1`** | Three things. (1) A route in `App.tsx` that is not in `routes.ts` — the list is a copy. (2) A broken YouTube embed or blog `<webview>`, since assertions are scoped to resmon's origins. (3) Anything about a page beyond it rendering *something*: wrong content, broken layout, and an unreadable page all pass | `RESMON_E2E_BREAK_ROUTE=/no-such-page` fails the run, locally and on CI ([33822159270](https://github.com/ryanjosephkamp/resmon/actions/runs/33822159270)). **The same mutation passed against the first version of the assertion**, which is how the `body`-vs-`main.main-content` gap was found | 14 of 14, from `ROUTES` in `e2e/routes.ts` — **copied by hand** from `App.tsx`, not derived. This is the weakest denominator here and proposal 1 below is the fix |
| **P3** — the Search-record tab activates on click, or the DOM shows why not | `e2e/search-record.spec.ts` | **real dependency, out-of-process** — a real trusted Chromium input event via `locator.click()`, against a real execution seeded through `POST /api/search/dive` | The tab's class goes `tab-btn ` → `tab-btn tab-active`, the sole `.tab-active` element is labelled *Search record*, and `.search-record` renders after its own fetch | Whether the tab works from a *user's* pointer, on a display with a window manager and a real cursor — Playwright's event is trusted but synthesised. And whether session 5's failure was caused by headless mode, by raw CDP, or by the served-renderer shim: three variables changed at once | Not mutated. The before-state is asserted (`classesBefore` does not contain `tab-active`), so the transition is not a coincidence — but no deliberate break was introduced | 1 of 5 report-viewer tabs driven. Report, Log, Metadata and Progress were not clicked |
| **P4** — no native dialog opens and no `shell` call escapes | `e2e/ipc-stubs.spec.ts`, both tests | **real dependency, out-of-process** — real `ipcMain` handlers replaced in the real main process via `electronApp.evaluate` | All three IPC channels answer from stubs (1 call each), and all five OS-facing functions record **0** calls across a full 14-route pass | Anything called before `installIpcGuards` runs — i.e. during startup. Nothing in `main.ts` does, but that is read from the code, not measured. Also, the app's *renderer-side* callers are never pressed: this proves the stubs work, not that every button routes through them | Not mutated. The counters distinguish "stub reached" from "OS reached" and both were observed non-zero and zero respectively in the same run, which is the discriminating evidence | 5 of 5 OS-facing calls guarded; denominator from `grep -n 'dialog\.\|shell\.' electron/main.ts`. 3 of 3 IPC channels, denominator from `preload.ts`'s `exposeInMainWorld` |
| **P5** — the CI job fails when a route fails to load | `ui-smoke.yml` with `break_route`; run [33822159270](https://github.com/ryanjosephkamp/resmon/actions/runs/33822159270) | **real dependency, out-of-process** — a real GitHub Actions runner, xvfb, exit code 1 | A route that renders nothing makes the job red, and the message names the route and the empty element | A route that renders *something wrong*. The job fails on an empty outlet, not on incorrect content — every content regression in resmon's history would have passed this | This **is** the mutation, and it did real work: it failed the first version of the assertion's absence | 1 of 1 failure mode demonstrated (empty route). Other failure modes — a backend that never starts, a window that never opens — are not demonstrated |
| **P6** — default behaviour unchanged with `RESMON_E2E` unset | `e2e/default-behaviour.spec.ts` | **real dependency, out-of-process** — the same app launched twice, from environments built by one `launchEnv()` and differing only in the variable | With the flag unset the app takes its pre-flag window (maximized to the work area on macOS; the 1280×820 constructor size under xvfb, which has no window manager) and never the E2E size; title, renderer URL shape, preload bridge, `isPackaged` and spawn-its-own-backend are identical across both | **Hunk 3.** `initAutoUpdater`'s guard is unreachable in a checkout and the packaged run was macOS, where the updater is off — so 1 of the 3 hunks has no behavioural check at all. Also, this compares the flag's *own* branches; it cannot see a change to `main.ts` that affects both paths equally | Not mutated. The comparison is itself differential — the two launches are the control for each other | 2 of 3 `RESMON_E2E` hunks observed behaviourally. Denominator from the three `isE2E()` call sites in `electron/main.ts` |

### Not covered

- **Hunk 3 of `RESMON_E2E`** (the auto-updater skip) has no behavioural check.
  It needs a packaged app on Windows or Linux.
- **`packaged.spec.ts` does not run on CI.** It skips, with the reason in the
  skip message. Packaged verification is local and on demand.
- **Windows, Intel macOS, a signed app, a quarantined app.** None launched.
- **Window-manager behaviour on CI**: maximize/restore, the `swipe` gesture,
  focus, stacking.
- **Correctness of any page.** Every check here is "it rendered". No visual
  regression, no layout assertion, no accessibility check, no content assertion.

### Residual risk

Written by the implementer, and read against the ledger above.

1. **The copied route list is the biggest one.** P2's denominator is a hand
   copy, so the property "every route is swept" degrades silently the first time
   somebody adds a route. Nothing fails, nothing warns. Everything else here is
   sound and this one thing rots.
2. **Origin scoping hides two real surfaces.** The YouTube embeds and the blog
   `<webview>` are things a user sees, and the suite now cannot fail on them. A
   reader of a green run could reasonably believe About resmon was verified; it
   was verified apart from its two most fragile parts.
3. **"It rendered" is a low bar and a green suite may read as more than it is.**
   Every v1.8.3 interface defect — the white flash, the unwired back/forward,
   the inconsistent link behaviour — would pass every check in this directory.
   That is appropriate for a smoke suite and dangerous if the tick is read as
   "the interface is fine".
4. **The fuse state is one hardening PR from flipping.** `RunAsNode` and
   `EnableNodeCliInspectArguments` are enabled only because electron-builder
   leaves them alone. Turning them off is a reasonable security change, and it
   would break packaged-app verification the same day, with no warning that
   connects the two.
5. **CI verifies the renderer well and the window barely.** A regression in
   `main.ts`'s window handling — the part of the app that had no test at all,
   which is why this spike exists — is largely still untested under xvfb.

---

## For whoever writes the 1.8.7 brief

The three things that would change the shape of the layer, in the order they
would pay off:

1. **Make the route list a denominator, not a copy** (proposal 1 above). Every
   other property here is measured against a list that can silently go stale.
2. **Decide what to do about the two embedded third-party origins.** They are
   the only reason the assertions are scoped, and the scoping is the one place
   this suite lies by omission.
3. **Decide whether packaged-app verification belongs in CI.** It works, it is
   slow, and the fuse state it depends on is one hardening PR away from
   flipping.
