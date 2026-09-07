# Published release verification

## Procedure

This procedure observes a published installer on the host that runs it. It does not
establish that another platform's installer launches, that every control works, or
that a release should ship. Record failures and unverified properties without
repairing the application as part of this check.

1. Start in the authorized checkout. Run `pwd` before each Git command, inspect
   status and remotes, fetch `upstream`, and create a `codex/` branch from
   `upstream/main`. Record the exact baseline commit and any change from the
   delegation's baseline. Leave unrelated checkouts and existing applications alone.
2. Create a uniquely named scratch directory outside the checkouts, with separate
   `assets`, `arm64`, `x64`, and `evidence` subdirectories. Use explicit repository
   arguments: `gh release view <tag> --repo ryanjosephkamp/resmon --json
   tagName,url,publishedAt,assets` and `gh release download <tag> --repo
   ryanjosephkamp/resmon --dir <scratch>/assets`. Preserve the metadata; compare
   each downloaded file's byte size (`stat -f '%z' <file>` on macOS) with its release-asset size. Record the actual
   asset inventory, not an assumed count. Do not infer launchability from sizes.
3. Before launching, inspect the matching checkout's Electron startup code.
   `tryAttachToDaemon()` reads `daemon.lock` under `stateDir()` and can contact
   that port even when the daemon's version differs. A normal launch on a machine
   with a live daemon is therefore not isolated. Where contacting port 8742 is
   prohibited, do not perform an HTTP health check or launch with the default
   state directory. Capture `lsof -nP -iTCP:8742 -sTCP:LISTEN` before and after;
   this inspects the listener without connecting. It cannot establish unchanged
   HTTP health, database contents, or uninterrupted service.
4. Inspect the downloaded DMG's extended attributes with `xattr -l`, mount it
   read-only with `hdiutil attach -readonly -nobrowse`, and use `ditto` to copy
   its `.app` into the architecture's scratch subdirectory, never `/Applications`.
   For example: `hdiutil attach -readonly -nobrowse -mountpoint
   <scratch>/mount-arm64 <scratch>/assets/resmon-<version>-arm64.dmg`, then
   `ditto <scratch>/mount-arm64/resmon.app <scratch>/arm64/resmon.app`.
   Preserve attributes. Inspect the copied application's attributes and
   `Contents/Info.plist`; record the download method and quarantine state. Do not
   remove quarantine, re-sign the bundle, or change system security policy.
5. Launch the copied published arm64 app through LaunchServices with a fresh
   state directory and separate Electron user data. For example, after creating
   the directories, run the following with absolute paths substituted:

   ```sh
   open -n -a <scratch>/arm64/resmon.app \
     --env RESMON_STATE_DIR=<scratch>/arm64/state \
     --stdout <scratch>/evidence/arm64-stdout.log \
     --stderr <scratch>/evidence/arm64-stderr.log \
     --args --user-data-dir=<scratch>/arm64/electron-user-data
   ```

   Do not set `RESMON_PYTHON` to a checkout interpreter or enable `RESMON_E2E`:
   the published bundle and its ordinary renderer behavior are the subject.
   Confirm the startup log identifies an ephemeral backend port other than 8742.
   Record this isolated-state launch as a controlled variation of the ordinary
   Finder path. This isolates the database and Chromium profile, **not the OS
   keyring or system service installation**. Opening Cloud Storage may probe an
   existing Drive credential; do not link, unlink, save keys, or invoke backup as
   part of a route walk. If macOS blocks launch, capture its exact message. A Finder
   right-click → Open retry must preserve isolation; do not retry in a way that
   loses the state-directory override. If that cannot be guaranteed, record the
   retry as unverified. Do not claim that an unquarantined command-line download
   exercised the browser-download Gatekeeper path.
6. Derive the route list by evaluating `allRouteHashes()` from
   `resmon_scripts/frontend/src/routes.ts` in the recorded checkout. Include
   parent routes and every declared child, including redirecting parents. Walk
   each in the published application's window, wait for its content, and save
   one numbered screenshot and one observation per route. State separately the
   number of rendered route entries, the brief's expected count, and the count
   derived from the file. A visible page shell is not verification of every
   control, external embed, or workflow on that page.

   With the checkout's frontend dependencies installed, this prints the route
   denominator without launching either app (run from `resmon_scripts/frontend`):

   ```sh
   node - <<'JS'
   const fs = require('fs'), ts = require('typescript');
   const source = fs.readFileSync('src/routes.ts', 'utf8');
   const js = ts.transpileModule(source, {
     compilerOptions: { module: ts.ModuleKind.CommonJS }
   }).outputText;
   const routeExports = {};
   new Function('exports', js)(routeExports);
   const routes = routeExports.allRouteHashes();
   console.log(JSON.stringify({ count: routes.length, routes }, null, 2));
   JS
   ```

7. On Repositories, record the source count actually displayed. On About resmon
   → About App, record the displayed version. Record visible errors and any
   console observations with their collection limits. Do not expose credentials
   or existing personal data in public evidence.
   For releases with first-run onboarding, capture all step details before any
   action. Use one fresh state/profile to test Skip followed by reload, and a
   second fresh state/profile to test first-routine retirement without Skip.
   Record the actual initial route: if ordinary startup opens Dashboard, do not
   call a later visit the first opening or claim the card never appeared. Create
   the routine through the UI, record its initial status, deactivate it if needed,
   and revisit/reload Dashboard. Keep the precise requested sequence unverified
   when the launch path cannot provide it.

   For an assistant check, use the published panel and the installed CLI. Record
   a read-only question's tool call, answer, cards (if any), and cost line. Ask
   for activation of an isolated inactive routine, capture any approval card,
   **deny it**, then reload Routines to inspect the state. Never approve an
   assistant write in this procedure. If sign-in is missing, record the exact
   panel message and stop that portion. If a turn fails or times out, retain the
   displayed message and distinguish absent evidence from a successful read or
   denied write; an absent cost line is not a zero-cost measurement.

8. Quit arm64 before repeating the mount, copy, isolated launch, version check,
   and bounded observation with the x64 DMG. Record whether Rosetta is available
   and whether the x64 app launches. If unavailable, report that limit; do not
   install Rosetta or modify the machine to make this check pass. Unless a
   second full route walk was performed, do not claim one for x64.
9. State which other platforms were not launched and why. On this Mac, Windows
   and Linux evidence is limited to the downloaded asset names and byte sizes.
10. Quit only the applications started for this run. Check their recorded process
    IDs have exited and repeat the non-contact listener observation. Detach only
    the volumes mounted for this run. Preserve reviewed screenshots and receipts
    outside the repository, attach them to the PR, verify the attachment links,
    then remove the run's downloaded installers, copied apps, and temporary state.
    Use `hdiutil detach <scratch>/mount-arm64` and the corresponding x64 mountpoint;
    do not detach unrelated pre-existing volumes.
11. Run the repository's required checks and record exact commands, counts,
    failures, skips, and environmental limitations. Keep their locally built app
    evidence distinct from the published-installer walkthrough. Commit only this
    document, push the branch according to `AGENTS.md`, and open one PR against
    `ryanjosephkamp/resmon`. Its body records what changed, verification, deliberate
    limits, and any files outside the brief. Screenshots are PR attachments,
    never committed files.

## v1.8.7 run

### Subject and launch conditions

Observed on **2026-09-05**, macOS **26.3.1 (a)**, build **25D771280a**, arm64 host.
The subject was [the published v1.8.7 release](https://github.com/ryanjosephkamp/resmon/releases/tag/v1.8.7),
published at `2026-09-04T21:18:46Z`. The checkout and fetched `upstream/main` were
`30658b5` (`release: 1.8.7 — a transport failure is not an answer (#73)`), exactly
the brief's baseline. The branch is `codex/docs-release-launch-check`; the Codex
prefix follows `AGENTS.md` rather than the brief's example `docs/` branch.

Assets were downloaded with `gh release download v1.8.7 --repo
ryanjosephkamp/resmon --dir /private/tmp/resmon-release-check-20260905/assets`.
Both DMGs were mounted read-only and their apps copied with `ditto` into that
scratch directory. No local build was substituted for either published app.
The arm64 bundle's `app.asar` was also read to confirm it honors the state-directory
override and otherwise probes the daemon lock's port.

Both LaunchServices launches used `open -n -a <copied-app>` with the procedure's
`--env RESMON_STATE_DIR`, `--stdout`, `--stderr`, and `--user-data-dir` arguments;
x64 additionally used `--arch x86_64`. Neither enabled `RESMON_E2E` nor supplied
`RESMON_PYTHON`. The apps used their bundled backend interpreters. Native UI
automation clicked the sidebar and tab links and captured the application window.

### Asset inventory

All seven downloaded sizes equaled their GitHub release metadata sizes.
The table reports byte counts, not estimates from the rounded release-page labels.

| Asset | Release bytes | Downloaded bytes |
|---|---:|---:|
| `latest-linux.yml` | 378 | 378 |
| `latest.yml` | 349 | 349 |
| `resmon-1.8.7-arm64.dmg` | 221,085,262 | 221,085,262 |
| `resmon-1.8.7-setup-x64.exe` | 194,649,899 | 194,649,899 |
| `resmon-1.8.7-setup-x64.exe.blockmap` | 203,931 | 203,931 |
| `resmon-1.8.7-x64.dmg` | 222,970,638 | 222,970,638 |
| `resmon-1.8.7-x86_64.AppImage` | 250,603,195 | 250,603,195 |

The two DMG SHA-256 values also matched the release asset digests:

- arm64: `bc54e77dd967ccec59e23095c2fbe9f93ea97d00b37c43c0ce5b1d40b17c9c2d`.
- x64: `4fcc758b59a733690cbf058336d25b292f5512b02b77d585aefc0930c9adfa0c`.

Windows and Linux were **not launched**: this run used a macOS host and no
Windows or Linux execution environment. No claim about those installers is made
beyond their names and sizes. Updater-feed contents and update installation were
not verified in this run.

### Gatekeeper observation

No Gatekeeper warning or confirmation dialog was observed on either controlled
LaunchServices launch. `xattr -l` showed `com.apple.provenance` and no
`com.apple.quarantine` attribute on each downloaded DMG and copied app root.
No attribute was removed or added, no bundle was re-signed, and system security
policy was not changed.

Consequently the brief's assumed first-launch block did not occur. The
**quarantined browser-download / Finder right-click → Open path remains unverified**.
A plain Finder retry would also lose the per-launch state override and could
probe the prohibited daemon. The result is an isolated launch of the published
bundle, not proof of the unmodified Finder/Gatekeeper path.

### Arm64 route walk

**24 of the brief's 24 route entries rendered; 24 entries were derived from
`allRouteHashes()` in the checkout's `routes.ts`.** The Settings and About parent
entries were visited separately from their redirect targets. Screenshots are
numbered `01`–`24` in the PR evidence archive; each is one window viewport, not a
full-page capture. No searches, scheduled runs, credential changes, destructive
actions, test emails, or backups were initiated.

| # | Requested route | Observation | Screenshot |
|---:|---|---|---|
| 1 | `/` | Welcome content; no active routines or recent activity. | `01-dashboard.png` |
| 2 | `/dive` | Repository/date/keyword form and Run Deep Dive control rendered. | `02-deep-dive.png` |
| 3 | `/sweep` | Multi-source form rendered; selector reads “0 of 25 selected.” | `03-deep-sweep.png` |
| 4 | `/routines` | Routine table rendered with “No routines configured.” | `04-routines.png` |
| 5 | `/calendar` | September 2026 grid rendered; previous/next controls show square glyphs. | `05-calendar.png` |
| 6 | `/results` | Filters and execution table rendered with “No executions found.” | `06-results.png` |
| 7 | `/analytics` | “Nothing to analyze yet” panel rendered. | `07-analytics.png` |
| 8 | `/watchdog` | Empty-history and unchecked-corpus notices rendered. | `08-watchdog.png` |
| 9 | `/explorer` | Filters and “Nothing collected yet” panel rendered. | `09-explorer.png` |
| 10 | `/configurations` | Routine Configs table rendered with “No configurations.” | `10-configurations.png` |
| 11 | `/monitor` | “No active executions” panel rendered. | `11-monitor.png` |
| 12 | `/repositories` | Attributions and source table rendered; 25 source rows counted from its accessibility tree. | `12-repositories.png` |
| 13 | `/settings` | Redirected to `/settings/email`; email form rendered. | `13-settings.png` |
| 14 | `/settings/email` | Email form rendered; no email was sent. | `14-settings-email.png` |
| 15 | `/settings/cloud` | After loading, displayed “Linked — API unreachable (RefreshError)”; Backup Now disabled. | `15-settings-cloud.png` |
| 16 | `/settings/ai` | Provider/key-status form rendered; detected an installed Claude Code command and selected its lane. | `16-settings-ai.png` |
| 17 | `/settings/storage` | Retention controls, explanatory note, and export location rendered. | `17-settings-storage.png` |
| 18 | `/settings/notifications` | Notification choices and “Current: granted” permission status rendered. | `18-settings-notifications.png` |
| 19 | `/settings/advanced` | Service/concurrency/diagnostics/danger-zone controls rendered; “no daemon running” concerns the isolated state directory. | `19-settings-advanced.png` |
| 20 | `/about-resmon` | Redirected to `/about-resmon/tutorials`; contents and overview rendered; the captured video area was black. | `20-about-resmon.png` |
| 21 | `/about-resmon/tutorials` | Tutorial contents and an overview video thumbnail rendered; playback untested. | `21-about-resmon-tutorials.png` |
| 22 | `/about-resmon/issues` | Issue form rendered; nothing submitted. | `22-about-resmon-issues.png` |
| 23 | `/about-resmon/blog` | After loading, post list and embedded resmon Blog page rendered. | `23-about-resmon-blog.png` |
| 24 | `/about-resmon/about-app` | Version reads **1.8.7**; also shows “Current release line: 1.5.x” and Update 7 prose. | `24-about-resmon-about-app.png` |

The Repositories count is a count of the **25 rendered source-row buttons**, not
a total badge displayed by that page. `repository-rows.txt` in the evidence archive
lists them. The Deep Sweep screenshot independently displays the selector's total.
This does not verify that any source search succeeds.

The initial database and profile were fresh, but the keyring was shared with the
host. Cloud Storage's automatic connection probe found an existing credential and
reported `RefreshError`. It was not linked, unlinked, or repaired during this run.

### Console and visible discrepancies

After the arm64 walkthrough, the main renderer's DevTools Console contained one
error and one warning, captured in `25-arm64-console.png`:

- A `data:application/x-font-ttf` font was blocked by `default-src 'self'`, with
  the console explaining that `font-src` was not explicitly set.
- `Unrecognized feature: 'web-share'.`

The Calendar screenshot shows square navigation glyphs. That observation and the
font error are both recorded; this run did not diagnose their causal relationship.
About App's version is 1.8.7 while its separate release-line sentence says 1.5.x.
Neither discrepancy was repaired or assigned release-blocking severity.

The Blog webview's separate Console displayed zero messages when inspected.
This was a post-walk console inspection, not continuous per-route console capture;
it does not establish that every renderer, iframe, or discarded webview was
error-free. Startup stderr recorded `[DEP0180] DeprecationWarning: fs.Stats
constructor is deprecated` on both architectures. Arm64 also recorded
`Google Drive connection check failed: RefreshError`. One intermediate log read
showed `sysmon request failed with error: sysmond service not found`; it was not
present in the later complete stderr read and is retained here as an observation,
not attributed to a diagnosed application defect.

### x64 / Rosetta result

`file` identified the copied x64 executable as `Mach-O 64-bit executable x86_64`.
`pkgutil --pkg-info com.apple.pkg.RosettaUpdateAuto` found an installed Rosetta
receipt, and `open --arch x86_64` launched the app on this arm64 host. The Dashboard
rendered with Backend Online, and About App displayed **1.8.7**. Evidence:
`26-x64-dashboard.png` and `27-x64-about-app.png`. A full x64 route walk was not
performed. No Rosetta installation was needed. A native automation lookup initially
timed out on the `/private/tmp` spelling; selecting the running bundle's registered
`/tmp` path resolved it without changing the app.

### Isolation and cleanup

Arm64 launched app PID **25852**, bundled backend PID **25864**, backend port
**56875**, and renderer port **56882**. x64 launched app PID **27087**, bundled
backend PID **27137**, backend port **58176**, and renderer port **58205**.
The task's four recorded app/backend PIDs were absent after quitting both apps.
Both task-mounted DMGs were detached. Downloaded assets, copied apps, and temporary
state were removed after preserving evidence outside the repository.

Before and after, `lsof -nP -iTCP:8742 -sTCP:LISTEN` showed the same Python listener:
PID **1150**, FD **12u**, socket identifier **0xaa26ce450f50da0e**, address
**127.0.0.1:8742**. The task did not bind or connect to that port, stop that process,
or edit its lock. The explicit user prohibition took precedence over the brief's
conflicting before/after `curl` instruction. **P3's requested HTTP-health proof is
not established**; these snapshots only establish unchanged listener identity at
the two observation times. There was no packet trace or continuous health monitor.

### Repository checks, distinct from the release walk

| Command | Observed result |
|---|---|
| `.venv/bin/python -m pytest -q` | 1,030 passed, 45 deselected, 59.43 s with local socket access. |
| `npm run typecheck` | Exit 0. |
| `npm test -- --runInBand` | 190 passed, 26 suites passed. |
| `npm run build` | Exit 0; renderer and Electron builds completed. |
| `npm run e2e` | 58 passed, 2 skipped, 2.0 min on the macOS display. |

Frontend commands ran from `resmon_scripts/frontend`; pytest ran from the checkout
root. The first sandboxed pytest attempt returned 1,012 passed, 4 failed, 14 errors,
45 deselected because loopback socket operations were denied. The rerun above used
local socket access and passed without source changes.

The e2e run skipped the local packaged-app launch because the existing local
bundle was **1.8.4**, not the checkout's 1.8.7, and skipped the strict no-CLI
environment case because a real Codex command was detected. It also printed
`P13c MONITOR NOT VERIFIED`: a no-HTTP search completed before the active-execution
poll could adopt it, leaving zero zero-reason Monitor rows. These limitations are
not replaced by the published-app screenshots. The 45 live-network backend tests,
video playback, actual source searches, AI calls, notifications, email, backup,
updating, and Windows/Linux execution were not verified by this release walk.

### Evidence and scope

The PR evidence archive is `resmon-v1.8.7-launch-screenshots.zip`: 27 native-window
PNGs, a 24-route screenshot/hash manifest, the rendered source-row list, the asset
size/DMG-digest receipt, and before/after listener snapshots. Screenshots were
reviewed as window captures; they are not a pixel-complete design or accessibility
audit. No screenshots are committed. The sole repository change is this document;
no application code, dependencies, workflows, or other documentation changed.

## v2.0.1 run

### Subject and launch conditions

Observed on **2026-09-06 (America/New_York; 2026-09-07 UTC)**, macOS
**26.3.1 (a)**, build **25D771280a**, arm64 host. The subject was
[the published v2.0.1 release](https://github.com/ryanjosephkamp/resmon/releases/tag/v2.0.1),
published at `2026-09-06T22:05:42Z`. The checkout baseline was
`055c4f9f9930811af871e381ff88ca986611c960` (current `upstream/main`, including
PR #98); branch `codex/release-launch-v2`. This is the checkout used to derive the
route denominator, not a claim that every change on that baseline is in the DMG.

All release assets were downloaded with `gh release download v2.0.1 --repo
ryanjosephkamp/resmon --dir /tmp/resmon-v2-launch-20260906/assets`. Both DMGs
were mounted read-only and the apps copied with `ditto` outside both checkouts.
The published arm64 `app.asar` was read to confirm `RESMON_STATE_DIR` and the
daemon-lock lookup before launch. No checkout interpreter or local build was
substituted for the published bundle.

LaunchServices used the procedure's `open -n -a`, `--env RESMON_STATE_DIR`,
`--stdout`, `--stderr`, and `--user-data-dir` arguments. Every launch had new
backend state and a new Chromium profile. Neither `RESMON_E2E` nor
`RESMON_PYTHON` was supplied. Native accessibility actions operated the app's
sidebar, tabs, forms, and assistant; screenshots are individual window viewports.

### Asset inventory

All **seven** downloaded names and byte sizes matched the release metadata.
SHA-256 was computed for all seven files and matched GitHub's asset digests.

| Asset | Release bytes | Downloaded bytes |
|---|---:|---:|
| `latest-linux.yml` | 378 | 378 |
| `latest.yml` | 349 | 349 |
| `resmon-2.0.1-arm64.dmg` | 221,270,814 | 221,270,814 |
| `resmon-2.0.1-setup-x64.exe` | 194,928,665 | 194,928,665 |
| `resmon-2.0.1-setup-x64.exe.blockmap` | 204,366 | 204,366 |
| `resmon-2.0.1-x64.dmg` | 223,212,602 | 223,212,602 |
| `resmon-2.0.1-x86_64.AppImage` | 250,853,419 | 250,853,419 |

DMG SHA-256:

- arm64: `9f893f842291d4f551275cec1d187d6b43291d079ad50d45336d6e95fe2591e9`.
- x64: `6fb67b0da5885f3c5ba2c25ee803b484746342dcc49cdf4a5477bde67c1c061b`.

Windows and Linux were **not launched**: this run had a macOS host and no
Windows/Linux execution environment. Size and digest agreement does not establish
launchability. Updater contents and update installation were not exercised.

### Gatekeeper observation

`xattr -l` showed `com.apple.provenance`, with no `com.apple.quarantine`, on both
DMGs and copied app roots. No Gatekeeper warning appeared on the controlled
launches. No attributes were removed, bundles re-signed, or security settings
changed. The **quarantined browser-download / Finder right-click → Open path
remains unverified**.

### Arm64 route walk

**24 of 24 route entries rendered**, with 24 derived by evaluating
`allRouteHashes()` from the baseline's `routes.ts`. The brief requires every route
rather than stipulating a numeric count. Both redirecting parents were clicked
separately from their child tabs. This establishes the visible content in these
viewports, not every control or workflow on each page.

| # | Requested route | Observation | Screenshot |
|---:|---|---|---|
| 1 | `/` | Welcome, three-step Getting started card, empty activity. | `01-dashboard-first-run.png` |
| 2 | `/dive` | Repository/date/keyword form and Run control. | `02-deep-dive.png` |
| 3 | `/sweep` | Multi-source form; “0 of 25 selected.” | `03-deep-sweep.png` |
| 4 | `/routines` | “No routines configured” before creating the task routine. | `04-routines.png` |
| 5 | `/calendar` | September grid; previous/next chevrons visibly render. | `05-calendar.png` |
| 6 | `/results` | Filters and “No executions found.” | `06-results.png` |
| 7 | `/analytics` | “Nothing to analyze yet.” | `07-analytics.png` |
| 8 | `/watchdog` | Empty-history notice and unchecked-corpus explanation. | `08-watchdog.png` |
| 9 | `/explorer` | Filters and “Nothing collected yet.” | `09-explorer.png` |
| 10 | `/configurations` | Routine Configs table contains the newly created task routine. | `10-configurations.png` |
| 11 | `/monitor` | “No active executions.” | `11-monitor.png` |
| 12 | `/repositories` | Attributions and 25 source-row buttons in the accessibility tree. | `12-repositories.png` |
| 13 | `/settings` | Redirected to Email; form rendered. | `13-settings-parent.png` |
| 14 | `/settings/email` | Email form; no send or save action. | `14-settings-email.png` |
| 15 | `/settings/cloud` | “Linked — API unreachable (RefreshError)”; Backup Now disabled. | `15-settings-cloud.png` |
| 16 | `/settings/ai` | Key-status table and automatically selected Claude Code lane. | `16-settings-ai.png` |
| 17 | `/settings/storage` | Retention note and export-location controls. | `17-settings-storage.png` |
| 18 | `/settings/notifications` | Choices and “Current: granted.” | `18-settings-notifications.png` |
| 19 | `/settings/advanced` | Installed service, isolated window PID, no active scheduler jobs. | `19-settings-advanced.png` |
| 20 | `/about-resmon` | Redirected to Tutorials; contents and video thumbnail rendered. | `20-about-parent.png` |
| 21 | `/about-resmon/tutorials` | Contents and video thumbnail; playback not tested here. | `21-about-tutorials.png` |
| 22 | `/about-resmon/issues` | Issue form; nothing submitted. | `22-about-issues.png` |
| 23 | `/about-resmon/blog` | Post list and embedded published blog loaded. | `23-about-blog.png` |
| 24 | `/about-resmon/about-app` | Version **2.0.1**, release line **2.0.x**. | `24-about-app.png` |

The 25-source count is from rendered row buttons, not a total badge on
Repositories. `repository-rows.txt` records the list; Deep Sweep independently
shows its selector total. No source searches were run in the published app.
Cloud Storage probed an existing system-keyring credential automatically and
reported `RefreshError`. No credential, backup, or service-installation controls
were changed. Advanced's “no daemon running” describes the isolated state and is
not an observation about the existing port-8742 daemon.

### What only an install can show

**First-run card.** In fresh arm64 state the Dashboard displayed these exact
step details (`01-dashboard-first-run.png`):

| Step | Detail on this machine |
|---|---|
| Use an AI subscription you already pay for | “resmon found Claude Code and Codex on this machine.” |
| Or bring an API key | “No AI provider is configured.” |
| Add a key for a source that wants one | “5 of resmon's sources can take a key of their own. The rest need none.” |

The footer explicitly distinguishes found/configured from working. Clicking
**Skip**, then reloading with Cmd-R, left the card absent
(`first-run-skipped-reloaded.png`).

A second new state/profile launch also opened Dashboard and displayed the card
(`second-initial-dashboard.png`). The published startup opens `/index.html`
without a route override, so **the brief's routine-before-first-Dashboard / card
never-appears sequence was not established**. No startup patch or database seed
was substituted for that user path. Instead, without clicking Skip, the Routines
form created `First routine retirement check`, using the First of month preset.
The UI created it Active; it was immediately deactivated using the direct routine
control (`second-first-routine.png`). Returning to Dashboard removed the card,
and Cmd-R did not bring it back (`second-dashboard-after-routine.png`,
`second-dashboard-reloaded.png`). This establishes automatic retirement after
routine creation in that sequence; it does not prove the card never appeared.

**Assistant.** In the first isolated app the direct Routines form created
`Release verification inactive routine` with cron `0 0 1 * *`. It initially
appeared Active and was deactivated before asking the assistant
(`assistant-routine-inactive-before.png`). AI, email and notification flags were
off. No scheduled execution was observed.

The read-only question “What sources do I have?” stayed at “Working…” and then
showed **“resmon could not finish that turn.”** after approximately five minutes
(`assistant-readonly-working.png`, `assistant-readonly-failed.png`). No answer,
tool-call entry, approval card, or cost line was displayed in the observed panel.
A process observation identified the real `/Users/noir/.local/bin/claude` child
of the bundled backend. This was not a mocked CLI. The panel did not report a
sign-in error, so this run does not establish that missing sign-in caused the
failure or that authentication succeeded.

The next request, “Please activate the routine named Release verification inactive
routine,” likewise ended after approximately five minutes with **“resmon could
not finish that turn.”** (`assistant-activation-failed.png`). No approval card
appeared in the observed panel, so there was **nothing to deny**. No assistant
card was approved. Reloading Routines showed the routine still **Inactive**
(`assistant-routine-inactive-after.png`). **P3's successful read/tool-call and
write-card/denial behavior remain unverified.** The panel displayed no cost line
for either failed turn; cost is unavailable, not measured as zero. No application
repair or alternate runtime was introduced to obtain a different result.

**Calendar and About App.** `05-calendar.png` shows left/right month chevrons,
not squares. `24-about-app.png` shows “resmon version 2.0.1” and “Current release
line: 2.0.x.” These are published-window observations.

### Console and visible discrepancies

After the route walk, the main renderer's DevTools Console showed one warning:
`Unrecognized feature: 'web-share'.` (`arm64-console.png`). No font-blocking error
was present in that inspection. This was a post-walk snapshot, not continuous
capture of every renderer or webview; the Blog webview's separate console was
not inspected. Startup stderr recorded `[DEP0180] DeprecationWarning: fs.Stats
constructor is deprecated`. Cloud Storage's `RefreshError`, both assistant
failures, and the routine form's initial Active status are observations, not
release grades or diagnoses. None was repaired by this task.

### x64 / Rosetta result

`file` identified the copied executable as `Mach-O 64-bit executable x86_64`.
An existing `com.apple.pkg.RosettaUpdateAuto` receipt was present; no Rosetta
installation was performed. `open -n --arch x86_64` launched the copied app with
fresh state/profile. Dashboard showed Backend Online and the first-run card
(`x64-dashboard.png`); About App showed **2.0.1** and **2.0.x**
(`x64-about-app.png`). The initial native automation lookup timed out while the
app was starting; a later lookup of the same path succeeded. This was a bounded
Dashboard/About observation, not a full x64 route walk or an assistant check.

### Isolation and cleanup

| Launch | App PID | Bundled backend PID | Backend port | Renderer port |
|---|---:|---:|---:|---:|
| arm64 first state | 63636 | 63642 | 55442 | 55452 |
| arm64 second state | 64376 | 64383 | 57256 | 57271 |
| x64 | 65684 | 65840 | 58328 | 58369 |

All six recorded app/backend PIDs were absent after quitting the task apps.
The two task-mounted DMGs were detached. Before/after `lsof -nP -iTCP:8742
-sTCP:LISTEN` snapshots were byte-for-byte identical: Python PID **1150**, FD
**12u**, socket **0xaa26ce450f50da0e**, **127.0.0.1:8742**. No task launch bound
or attached to that port and no HTTP probe was made to it. **This establishes
listener identity at two times, not unchanged HTTP health or continuous service.**

Screenshots and receipts are retained outside the repository at
`~/Documents/resmon-codex/release-evidence/v2.0.1-20260906/`. Downloaded assets,
all three copied apps, and their temporary state/profile directories were removed
after attachment verification. The verification download was also removed.

### Repository checks, distinct from the release walk

| Command | Observed result |
|---|---|
| `.venv/bin/python -m pytest -q` | **1,546 passed, 2 skipped, 74 deselected**, 106.50 s. |
| `npm run typecheck` | Exit 0. |
| `npm test` | **275 passed, 32 suites passed**, 7.616 s. |
| `npm run build` | Exit 0; renderer and Electron builds completed. |
| `npm run e2e` | **69 passed, 2 skipped**, 2.9 min on the macOS display. |

Backend tests ran from the checkout root; frontend commands from
`resmon_scripts/frontend`. The E2E packaged-app case skipped because the existing
local bundle is **1.8.4**, not 2.0.1. Its no-CLI case skipped because it detected
the installed Codex command. It also printed `P13c MONITOR NOT VERIFIED`: a
no-HTTP execution finished before the Monitor poll adopted it. Those limitations
stay attached to the locally built E2E result; the published screenshots do not
replace them. The **74 live-network backend tests were not run**.

### Evidence and scope

The [PR evidence comment](https://github.com/ryanjosephkamp/resmon/pull/100#issuecomment-5563442522)
attaches [resmon-v2.0.1-launch-evidence.zip](https://github.com/user-attachments/files/31891573/resmon-v2.0.1-launch-evidence.zip)
and four inline previews. The archive contains **37 screenshots**: the
numbered route screenshots and additional onboarding, assistant, console and
x64 captures, a screenshot SHA-256 manifest, route denominator, rendered source
list, release metadata, asset verification, and listener/process receipts.
Screenshots were reviewed before publication and are not committed. A signed-in
Chrome download of the attachment matched the original archive byte-for-byte;
all four inline previews loaded. Unauthenticated command-line requests to the
archive returned 404, so anonymous download access was not established.

The sole repository change is `docs/release-verification.md`. The procedure now
makes the two onboarding states, actual initial route, and assistant failure/cost
reporting explicit. No application code, dependency, workflow, or other document
changed. No release go/no-go judgment is made. Beyond the specific observations
above, this run did not establish quarantined Gatekeeper behavior, the exact
routine-before-first-Dashboard sequence, successful assistant answers/tool calls,
write approval/denial behavior, cost, video playback in the published app,
source searches, summaries, notifications, email, backup, updating, a full x64
walk, or Windows/Linux execution.
