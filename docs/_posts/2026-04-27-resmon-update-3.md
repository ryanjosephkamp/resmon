---
layout: post
title: "resmon Update 3 — April 27, 2026"
date: 2026-04-27 12:00:00 -0400
categories: [updates]
---

# Update 3 — Calendar Bug Cluster, AI-Key Deep-Link, and the New About resmon Page (Tutorials, Issues, Blog, About App)

## Metadata

- **Update number:** 3
- **Update type:** mixed (bugfix + feature)
- **Date:** 2026-04-27
- **Author:** Ryan Kamp
- **Commit hash:** 0570bc5ac416b42b774b3e1609e1602d6c8adc27
- **Commit timestamp:** 2026-04-30T17:35:25-04:00
- **GitHub push timestamp:** 2026-04-30T21:35:39Z
- **App version:** 1.1.0 → 1.2.0

## Summary

This update lands two Calendar bugs, one small deep-link feature, and one large feature — a brand-new top-level **About resmon** page — together with eleven out-of-band additions that emerged mid-flight and were folded into the same change set per the `T-UPD-ADD` rule. The Calendar's scheduled-routine times no longer drift by ~4 hours and Custom-cadence first-fire / interval anomalies (every-N-months, every-5-hours, every-5-days, every-3-weeks, every-1-year) all expand correctly; the 30-minute "orange-bar" cosmetic bug is fixed; and the expansion window now extends to a full 12 months with a user-facing notice when the FullCalendar viewport is navigated past the horizon. The Repositories & API Keys page gains a "Looking for AI API key settings?" deep-link button to `Settings → AI`. A new top-level **About resmon** page hosts four tabs — **Tutorials** (eighteen embedded YouTube walk-throughs covering the full app, every page, and every Settings sub-tab), **Issues** (a credentials-free `mailto:` + GitHub-issue-deep-link form), **Blog** (an in-app reader fed by the new GitHub Pages site at `https://ryanjosephkamp.github.io/resmon/`), and **About App** (relocated out of Settings); a shared `TutorialLinkButton` is rendered next to every page header and every Settings sub-panel header so any user can deep-link straight into the matching tutorial section. App version bumps `1.1.0 → 1.2.0`.

## Motivation

All items in this update originated in the user's third-after-release feedback session and map back to the change inventory in [`.ai/updates/update_4_27_26/update_4_27_26_workflow.md`](../update_4_27_26/update_4_27_26_workflow.md).

- **Bug 1 — Calendar scheduled-routine times incorrect** (workflow item #1, batch 1). Daily / weekday / weekly / monthly cron expansions on the Calendar page rendered 4 hours earlier than they actually fired (UTC vs. local-time mismatch), and several Custom cadences exhibited first-fire / interval anomalies. The Calendar's 90-day expansion window also silently truncated upcoming fires for high-frequency cadences with no user-facing notice.
- **Bug 2 — Cosmetic 30-minute routines render as multi-day orange bars** (workflow item #2, batch 1). Same Calendar subsystem; FullCalendar event mapping was treating short-duration routine fires as all-day events.
- **Feature 3 — "Looking for AI API key settings?" deep-link button** (workflow item #3, batch 2). Users repeatedly looked for AI provider keys (OpenAI, Anthropic, etc.) on the Repositories & API Keys page even though those keys live on `Settings → AI`. A small inline button between the page intro paragraph and the scope selector now routes them directly to `/settings/ai`.
- **Feature 4 — New About resmon top-level page** (workflow item #4, batch 3). Users had no in-app place to learn how each page worked, no credentials-free way to file a bug or request a feature, and no surfaced channel for per-update release notes. The About App tab was also crowding the Settings page. Update 3 introduces the new top-level page with **Tutorials**, **Issues**, **Blog**, and the relocated **About App** tab, plus a shared `TutorialLinkButton` next to every page and every Settings sub-panel header.
- **Out-of-band additions (T-UPD-ADD).** Eleven user-requested additions emerged after T-UPD-1 was scaffolded and during T-UPD-2 execution; they were folded into the active batches per the workflow's T-UPD-ADD rule. They are listed under [Changes](#changes) below and motivated individually in `update_4_27_26_workflow.md` (OOB-1 … OOB-11).

## Changes

### Batch 1 — Calendar bug cluster (Bug 1 + Bug 2 + window extension + horizon notice)

- `resmon_scripts/resmon.py` — `/api/calendar/events` cron expansion now resolves trigger fire times in the local timezone rather than UTC (fixes the ~4-hour shift); Custom-cadence first-fire arithmetic is reworked to honor `IntervalTrigger` start-date semantics for every-N-hours / every-N-days / every-N-weeks / every-N-months / every-N-years schedules so first-fires and intervals are correct; the expansion window is extended from 90 days to a full 12 months and `MAX_PER_ROUTINE` is raised proportionally so high-frequency cadences (`every 5 hours`) are not truncated; the response now carries a `horizon_end` timestamp the frontend can compare against the FullCalendar viewport.
- `resmon_scripts/frontend/src/pages/CalendarPage.tsx` — FullCalendar event mapping now sets `allDay: false` and a real `end` derived from the routine duration so 30-minute routines render as a tight bar rather than a full-width orange band; renders a user-facing notice when the FullCalendar viewport is navigated past the 12-month horizon explaining that the calendar only projects scheduled fires up to 12 months ahead.

### Batch 2 — Repositories & API Keys deep-link button

- `resmon_scripts/frontend/src/pages/RepositoriesPage.tsx` — adds a "Looking for AI API key settings?" inline button between the page intro paragraph and the scope selector that routes to `/settings/ai`.

### Batch 3 — About resmon page + tutorial deep-link buttons + Settings → About App relocation

- **New top-level page and routes.**
  - `resmon_scripts/frontend/src/pages/AboutResmonPage.tsx` *(new)* — top-level page with the tab strip and nested router; final tab order **Tutorials → Issues → Blog → About App** (Issues and Blog were added under OOB-5 / OOB-6).
  - `resmon_scripts/frontend/src/components/AboutResmon/TutorialsTab.tsx` *(new)* — eighteen tutorial sections (one full-app overview + ten page sections + seven Settings sub-tab sections), each with an embedded `youtube-nocookie.com/embed/<id>` iframe, a TOC, and prev / next navigation; deep-link hash drives smooth-scroll into view.
  - `resmon_scripts/frontend/src/components/AboutResmon/AboutAppTab.tsx` *(new — relocated content)* — the previous Settings → About App panel content, now mounted under `/about-resmon/about-app`.
  - `resmon_scripts/frontend/src/App.tsx` — adds the `/about-resmon/*` route and the sidebar nav entry appended after Settings.
- **Shared `TutorialLinkButton` next to every page header and every Settings sub-panel header.**
  - `resmon_scripts/frontend/src/components/AboutResmon/TutorialLinkButton.tsx` *(new)* — single shared component navigating to `/about-resmon/tutorials#<anchor>`.
  - All ten page components (`DashboardPage`, `DeepDivePage`, `DeepSweepPage`, `RoutinesPage`, `CalendarPage`, `ResultsPage`, `ConfigurationsPage`, `MonitorPage`, `RepositoriesPage`, `SettingsPage`) plus all seven Settings sub-panels (`EmailSettings`, `CloudAccountSettings`, `CloudSettings`, `AISettings`, `StorageSettings`, `NotificationSettings`, `AdvancedSettings`) render `TutorialLinkButton` next to their `<h1>` / `<h2>` headers.
- **Settings → About App removal.**
  - `resmon_scripts/frontend/src/pages/SettingsPage.tsx` — removes the `About App` `NavLink` and nested `<Route>`; removes the `AboutAppSettings` import; tab count goes 8 → 7. The `Settings` index redirect to `/settings/email` is unchanged.
  - `resmon_scripts/frontend/src/components/Settings/AboutAppSettings.tsx` — deleted (content relocated to `AboutResmon/AboutAppTab.tsx`).

### Out-of-band additions (T-UPD-ADD)

- **OOB-1 — Calendar `Routines: x of y` dropdown filters to active-only.** `resmon_scripts/frontend/src/pages/CalendarPage.tsx` — `fetchData` seeds `visibleRoutines` from the active subset and a derived `activeRoutines` constant drives the `Select all` action and the rendered checkbox list.
- **OOB-2 — Calendar event popover shows `Name:` and `Cron Schedule:` info lines.** `resmon_scripts/frontend/src/pages/CalendarPage.tsx` — popover renders two new `event-popover-meta` lines for the matching active routine.
- **OOB-3 — `Edit Routine` button on Calendar popover + shared `RoutineEditModal` + cross-page sync.**
  - `resmon_scripts/frontend/src/lib/routinesBus.ts` *(new)* — pub/sub bus mirroring `configurationsBus.ts` with `notifyRoutinesChanged()` + `useRoutinesVersion()`.
  - `resmon_scripts/frontend/src/components/Routines/RoutineEditModal.tsx` *(new)* — extracted reusable create/edit modal that broadcasts on both `routinesBus` and `configurationsBus` on save.
  - `resmon_scripts/frontend/src/pages/RoutinesPage.tsx` — refactored to consume the shared modal; subscribes to `useRoutinesVersion()`.
  - `resmon_scripts/frontend/src/pages/CalendarPage.tsx` — adds the `Edit Routine` popover button; subscribes to `useRoutinesVersion()` and re-runs `fetchData()` on save without closing the popover.
- **OOB-4 — `.modal-overlay` z-index above the Calendar event popover.** `resmon_scripts/frontend/src/styles/global.css` — bumps `.modal-overlay` from `z-index: 1000` → `1100`.
- **OOB-5 — `About resmon → Issues` tab + GitHub issue templates.**
  - `resmon_scripts/frontend/src/components/AboutResmon/IssuesTab.tsx` *(new)* — credentials-free form with two read-only submit paths (`mailto:` link + GitHub-issue deep link); both routed through `window.resmonAPI.openPath` (falls back to `window.location.href` / `window.open` when the preload bridge is unavailable).
  - `.github/ISSUE_TEMPLATE/bug.yml`, `feature.yml`, `question.yml`, `config.yml` *(new)* — typed GitHub issue forms whose IDs match the slugs the Issues tab generates.
  - `resmon_scripts/frontend/src/pages/AboutResmonPage.tsx` — mounts the new tab between Tutorials and About App.
- **OOB-6 — `About resmon → Blog` tab + GitHub Pages publishing infrastructure.**
  - `resmon_scripts/frontend/src/components/AboutResmon/BlogTab.tsx` *(new)* — fetches the Atom feed at `https://ryanjosephkamp.github.io/resmon/feed.xml`, parses client-side via `DOMParser`, renders a two-pane layout with an origin-locked Electron `<webview>`; off-origin links open in the user's default browser.
  - `resmon_scripts/frontend/electron/main.ts` — enables `webPreferences.webviewTag: true` and adds a `will-attach-webview` hardening hook that scrubs `nodeIntegration`, `preload`, and any non-https `src`.
  - `resmon_scripts/frontend/src/index.html` — widens the CSP `<meta>` to permit `https://ryanjosephkamp.github.io` for `frame-src` / `child-src` / `connect-src`, plus `https://www.youtube-nocookie.com` and `https://www.youtube.com` for the Tutorials embeds.
  - `docs/_config.yml`, `docs/Gemfile`, `docs/index.md`, `docs/README.md`, `docs/_posts/2026-04-23-welcome-to-the-resmon-blog.md` *(new — Jekyll site scaffolding)*. The two republished update posts (`docs/_posts/2026-04-24-resmon-update-1.md`, `docs/_posts/2026-04-25-resmon-update-2.md`) shipped in a separate `7f1ea24` commit on 2026-04-29 ahead of T-UPD-4 and are noted here for the record; they are not staged as part of the Update 3 commit.
  - `resmon_scripts/frontend/src/pages/AboutResmonPage.tsx` — mounts the new tab between Issues and About App.
- **OOB-7 — New T-UPD-5 prompt template in `update_prompts.md`.** `.ai/updates/update_prompts.md` — adds a **T-UPD-5 — Publish Update as Blog Post** prompt template formalizing the seven-step per-post procedure, bumps the document to version 1.3, extends the usage / TOC / hard rules to reflect the new five-prompt sequence, and adds a "Push before publish" hard rule.
- **OOB-8 — `saved_configuration_id` linkage on the `executions` table.**
  - `resmon_scripts/implementation_scripts/database.py` — adds a nullable `saved_configuration_id INTEGER REFERENCES saved_configurations(id) ON DELETE SET NULL` column to the `executions` table via an idempotent `ALTER TABLE … ADD COLUMN` migration.
  - `resmon_scripts/resmon.py` — `_enrich_execution_row` `LEFT JOIN`s `saved_configurations` and projects `saved_configuration_id` + `saved_configuration_name` onto every execution-returning endpoint; extends `DiveRequest` and `SweepRequest` with an optional `saved_configuration_id`; adds `PATCH /api/executions/{id}` accepting `{ saved_configuration_id: int }`.
  - `resmon_scripts/frontend/src/pages/DeepDivePage.tsx`, `resmon_scripts/frontend/src/pages/DeepSweepPage.tsx` — track the loaded id in a `loadedConfigIdRef` populated by `ConfigLoader.applyConfig`; user edits clear the ref via a `dirtyRef` guard.
  - `resmon_scripts/frontend/src/components/Save/SaveConfigButton.tsx`, `resmon_scripts/frontend/src/pages/CalendarPage.tsx` — `PATCH` the originating execution row with the new id after a successful Save Config.
- **OOB-9 — `Saved as <name>` badge + `Name` column wiring.** `resmon_scripts/frontend/src/pages/DashboardPage.tsx`, `resmon_scripts/frontend/src/components/Results/ResultsList.tsx`, `resmon_scripts/frontend/src/pages/CalendarPage.tsx`, `resmon_scripts/frontend/src/components/Save/SaveConfigButton.tsx` — adds a `Name` column (with `saved_configuration_name → routine_name → Execution #{id}` fallback chain) and a `Saved as <name>` badge that reconciles in place after a save broadcast.
- **OOB-10 — Configurations page `View JSON` per-row read-only modal.** `resmon_scripts/frontend/src/pages/ConfigurationsPage.tsx` — adds a per-row `View JSON` button next to `Edit` that opens a read-only modal with a Copy-to-clipboard button.
- **OOB-11 — Settings → Advanced **Danger Zone** (16 destructive actions, two-tier confirmation).**
  - `resmon_scripts/frontend/src/components/Settings/ConfirmDangerModal.tsx` *(new)* — typed-`CONFIRM` confirmation gate for the six destructive data/settings actions.
  - `resmon_scripts/frontend/src/components/Settings/AdvancedSettings.tsx` — appends a Danger Zone section with two columns (Local / Cloud) of 8 buttons each; broadcasts on `configurationsBus`, `routinesBus`, and the `resmon:execution-completed` window event on success; the cloud column is rendered disabled with a `Coming soon` muted note.
  - `resmon_scripts/resmon.py` — adds 8 admin route handlers under `POST /api/admin/...`; the two API-key wipes accept an empty body, the six data/settings destructions require `{ "confirm": "CONFIRM" }`.
  - `resmon_scripts/implementation_scripts/database.py` — helpers for whole-table truncates with FK cascade.
  - `resmon_scripts/implementation_scripts/credential_manager.py` — bulk-wipe helpers for the API-key categories.

### Documentation, version, and About App tab

- `resmon_reports/info_docs/about_resmon_info.md`, `settings_info.md`, `calendar_info.md`, `configs_info.md`, `dashboard_info.md`, `results_and_logs_info.md`, `repos_and_api_keys_info.md`, `system_info.md`, `deep_dive_info.md`, `deep_sweep_info.md` — refreshed in T-UPD-3 sub-tranche 1 to reflect Update 3 changes (`routines_info.md` and `monitor_info.md` were verified up-to-date and left as-is).
- `resmon_scripts/implementation_scripts/config.py` — bumps `APP_VERSION` from `1.1.0` to `1.2.0`.
- `resmon_scripts/frontend/package.json` — bumps `version` from `1.1.0` to `1.2.0`.
- `resmon_scripts/frontend/src/components/AboutResmon/AboutAppTab.tsx` — version banner now reads `1.2.0` and the Recent Update card is rewritten with this update's number, name, and summary.
- `README.md` — adds an `#/about-resmon/*` row to the routes table, an **About resmon** bullet under Key Features describing all four tabs, a short **Blog** subsection linking the GitHub Pages site, a note in the existing **Reporting Issues** subsection that issues can be filed via the in-app form, and a brief **Maintenance / Danger Zone** subsection pointing readers at Settings → Advanced.

## Verification

Test results from each batch and from the OOB additions, run from the project root with the `.venv` virtualenv active and the frontend tooling under `resmon_scripts/frontend/`.

- **Batch 1 (Calendar bug cluster):**
  - `pytest resmon_scripts/verification_scripts/ -q` → all green; the Calendar timezone-shift and IntervalTrigger first-fire fixes are exercised by the existing scheduler / cron expansion suites.
  - Frontend: `webpack 5.106.2 compiled successfully`; manual UI verification of every cron expression enumerated in the bug report (8 AM daily, midnight daily, Mon 9 AM, weekday 8 AM, first-of-month, every-2-months, every-5-hours, every-5-days, every-3-weeks, every-1-year, plus a 30-minute routine) on month / week / day views.
- **Batch 2 (AI-key deep-link button):** `webpack 5.106.2 compiled successfully`; manual click-through on the Repositories & API Keys page → lands on `#/settings/ai`.
- **Batch 3 (About resmon page + tutorial deep-link buttons + Settings relocation):**
  - `cd resmon_scripts/frontend && npm run typecheck` → clean.
  - `webpack 5.106.2 compiled successfully`; renderer `bundle.js` ~1.06 MiB after the YouTube embed pivot.
  - Manual nav to `/about-resmon` confirmed all four tabs; manual click-through on every `TutorialLinkButton` instance (10 page headers + 7 Settings sub-panel headers) confirmed correct deep-link behavior; Settings tab count is 7 with no stranded `/settings/about` references.
- **OOB-1 / OOB-2 / OOB-3 / OOB-4 (Calendar polish + RoutineEditModal + z-index fix):** webpack build clean; manual UI smoke confirmed the Routines dropdown now shows active-only routines, the popover surfaces the `Name:` and `Cron Schedule:` lines, the `Edit Routine` button opens the modal above the popover and updates both Calendar and Routines without a manual reload.
- **OOB-5 (Issues tab + GitHub issue templates):** webpack build clean; manual click-through on **Open in Email** opened the default mail client with the correct subject / body / diagnostic block, and **File on GitHub** opened the GitHub new-issue page with the correct template auto-selected and the form fields pre-populated.
- **OOB-6 (Blog tab + GitHub Pages):** webpack build clean; the GitHub Pages site is live at `https://ryanjosephkamp.github.io/resmon/`; the in-app Blog tab successfully fetches `feed.xml`, lists the three published posts, and renders each post in the embedded `<webview>`. Off-origin links route to the user's default browser.
- **OOB-7 (T-UPD-5 prompt template):** documentation-only change; no test suite applies. Verified by re-reading the document end-to-end after the edit.
- **OOB-8 (`saved_configuration_id` linkage):** `pytest resmon_scripts/verification_scripts/ -q` → green (idempotent migration covered by the existing schema-migration suite); manual UI verification of the round-trip on Deep Dive → Save Config → Dashboard / Results & Logs / Calendar popover.
- **OOB-9 (`Saved as <name>` badge + `Name` column):** webpack build clean; manual UI verification of the fallback chain (`saved_configuration_name → routine_name → Execution #{id}`) and of the in-place reconciliation when a save originates on a different page.
- **OOB-10 (View JSON modal):** webpack build clean; manual UI verification of the read-only modal across all three config types (`manual_dive`, `manual_sweep`, `routine`); Copy-to-clipboard succeeded under both `navigator.clipboard.writeText` and the `document.execCommand('copy')` fallback path.
- **OOB-11 (Danger Zone):** `pytest resmon_scripts/verification_scripts/ -q` → green for the new admin-route tests (typed-`CONFIRM` gate enforced server-side, FK cascades verified). Manual UI verification of all 8 local actions (the two API-key wipes through the simple modal, the six data/settings destructions through the typed-`CONFIRM` modal); cloud column rendered disabled with the `Coming soon` note as designed.

Skipped tests: platform-gated Linux `systemd --user` and Windows Task Scheduler tests remain skipped on macOS via their existing `skipif` guards (these were exercised under Update 2's manual verification matrix and are not re-exercised here because no notification-dispatch code changed in this update). No new dependencies; the `executions.saved_configuration_id` ALTER is idempotent and forward-compatible with installs that already migrated.

Commands:

```bash
# Backend
source .venv/bin/activate && pytest resmon_scripts/verification_scripts/ -q

# Frontend
cd resmon_scripts/frontend
npm run typecheck
npm run build
npm start  # full Electron + backend smoke
```

## Follow-ups

- **Tutorials full-app overview video** — the full-app overview entry currently embeds a placeholder video; the user has reserved the final replacement recording for **Update 4** so the rest of the app can be bug-tested first. The placeholder is functional and replaceable by a single `youtubeId` change.
- **Cloud-side Danger Zone column** — the eight cloud-mirror buttons in the Settings → Advanced Danger Zone are intentionally rendered disabled (`Coming soon`). They will activate when the `Cloud Account` feature lands and the matching `/api/admin/cloud/...` routes are added.
- **Stale-daemon caveat (carried forward from Update 2's settings-allowlist)** — users upgrading should kill any running `resmon-daemon` process so the renderer attaches to a fresh backend that has loaded the new admin endpoints and the `executions.saved_configuration_id` migration.
