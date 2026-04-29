---
layout: post
title: "resmon Update 2 — April 25, 2026"
date: 2026-04-25 12:00:00 -0400
categories: [updates]
---

# Update 2 — Calendar Readability, Cross-Platform Desktop Notifications, Multi-Provider AI Keys, Per-Execution AI Override Parity, and Configurations Lockstep

## Metadata

- **Update number:** 2
- **Update type:** mixed (bugfix + feature)
- **Date:** 2026-04-25
- **Author:** Ryan Kamp
- **Commit hash:** 023d7abc176f50a5eddac35d04bf86e288ac13a8
- **Commit timestamp:** 2026-04-26T18:06:13-04:00
- **GitHub push timestamp:** 2026-04-26T22:06:23Z
- **App version:** 1.0.0 → 1.1.0

## Summary

This update lands two bug fixes and three feature clusters, plus eleven out-of-band additions that emerged mid-update and were folded back into the same change set per the workflow's T-UPD-ADD rule. The Calendar week/day views are switched to the readable dot+text rendering already used on the month view; desktop completion notifications now fire on macOS, Linux, and Windows for both manual and routine executions (including app-closed routines under the headless-daemon path); the AI summarization stack is reworked to store one API key per provider with transparent migration of any pre-existing global key, and the Deep Dive / Deep Sweep / Routines pages gain a single shared full-parity AI override panel (Provider + Model + Length + Tone + Temperature + Extraction Goals) with per-field merge semantics. The Settings → AI panel is rebuilt around a four-column **Stored API Keys** table backed by a new `ai_default_models` per-provider default-model map; the Configurations page gains a per-row **Edit** action with three config-type-aware modal variants and a stale-link 404 fallback; and the configuration-import endpoint now auto-materializes a deactivated routine for every imported routine config, restoring the bidirectional Routines ↔ routine-configs invariant.

## Motivation

All items in this update originated in the user's second-after-release feedback session and map back to the change inventory in [`.ai/updates/update_4_25_26/update_4_25_26_workflow.md`](../update_4_25_26/update_4_25_26_workflow.md).

- **Bug A — Calendar week/day event readability** (workflow item #1, batch 1). The `timeGridWeek` and `timeGridDay` views rendered each event as a status-colored background block with type-colored text on top; the two color channels collided and the text was unreadable. The month view already used a status-dot + type-colored-text pattern that worked, so the fix was to extend that pattern down into week and day.
- **Bug B — Desktop notifications not firing on any platform** (workflow item #2, batch 2). Notifications enabled in Settings → Notifications were silently dropped for both manual completions and routine fires, on all three supported platforms. Routine notifications additionally needed to fire when the app window was closed under headless-daemon / background-execution mode (the launchd / `systemd --user` / Task Scheduler service path). Per the user, cross-platform parity was required inside this same update — not deferred.
- **Feature 1 — Multi-provider AI API key storage** (workflow item #3, batch 3). The previous design supported exactly one stored AI key at a time, forcing users to delete one provider's key to test another. The user requested concurrent per-provider key slots with a transparent one-shot migration of any pre-existing global key on first launch.
- **Feature 2 — Full per-execution AI override parity** (workflow item #4, batch 4). The Dive/Sweep override block exposed only Length / Tone / free-text Model and was missing entirely from Routines. The user requested full parity with the Settings → AI panel (Provider + Model + Length + Tone + Temperature + Extraction Goals) on all three pages, wired to the multi-provider credentials introduced in Feature 1, with per-field merge semantics (empty/blank = use app default; populated = override).
- **Feature 3 — Settings → AI tooltips** (workflow item #5, batch 4). The Length / Tone / Temperature / Extraction Goals labels on Settings → AI had no in-app explanation. The user requested an `InfoTooltip` "?" hover on each of the four labels.
- **Out-of-band additions OOB-1..OOB-11.** Eleven follow-on requests landed mid-update after T-UPD-1: a richer Stored API Keys table on Settings → AI (OOB-1, -2, -7, -8); a Model dropdown + Load-models button + inline missing-key entry + Save-as-default-model action on the override panel (OOB-3, -4); a new `ai_default_models` per-provider default-model map (OOB-5); race-safe writers in `AISettings.tsx` to stop two writers from clobbering the map (OOB-6); a per-row **Edit** action on the Configurations page with three modal variants (OOB-9); a stale `linked_routine_id` 404 fallback (OOB-10); and an import-side fix that auto-materializes a deactivated routine for every imported routine config so the bidirectional Routines ↔ routine-configs invariant holds (OOB-11). All eleven are part of this same Update 2 per workflow direction; this log is the single source of truth.

## Changes

### Batch 1 — Bug A: Calendar week/day event readability

- `resmon_scripts/frontend/src/pages/CalendarPage.tsx` — wired the FullCalendar `eventContent` / `eventClassNames` / `eventDidMount` hooks for the `timeGridWeek` and `timeGridDay` views to the same dot+type-colored-text rendering already used on the `dayGridMonth` view; week and day events no longer paint a status-colored background block under type-colored text.
- `resmon_scripts/frontend/src/styles/global.css` (or the calendar-scoped styles file actually used) — removed the `background-color` rules from the `calendar-type-*` / `fc-event-*` classes when the active view is `timeGridWeek` or `timeGridDay`; the status dot is now the sole status channel in those views.

### Batch 2 — Bug B: Desktop notifications across macOS, Linux, and Windows

- In-process notification dispatcher (the module reachable via `notify_on_complete`) — repaired the dispatch path that swallowed notifications when the renderer was the active window and when the headless daemon fired routines with no attached renderer.
- `resmon_scripts/implementation_scripts/daemon.py` and `resmon_scripts/implementation_scripts/service_manager.py` — wired the headless-daemon execution path into the notification dispatcher so routine completions raised by the launchd / `systemd --user` / Task Scheduler service path emit a desktop notification even when no renderer is attached.
- `resmon_scripts/service_units/` (launchd plist, `systemd --user` unit, Task Scheduler XML) — verified per-platform notification permissions are not blocked by the service template; documented the per-platform manual-verification checklist where the dev machine could not natively exercise both Linux and Windows.
- No new runtime dependency was added; the existing notifier surface covers all three platforms once the dispatcher is reached.

### Batch 3 — Feature 1: Multi-provider AI API key storage with transparent migration

- `resmon_scripts/implementation_scripts/credential_manager.py` — added a per-provider credential-naming scheme (`ai_api_key__<provider_slug>`) and a one-shot, idempotent migration helper invoked at backend startup that re-keys any pre-existing legacy global AI credential under the per-provider name corresponding to the user's currently selected provider. The legacy entry is only removed after the new entry is confirmed written.
- `resmon_scripts/resmon.py` — surfaced per-provider presence on `GET /api/credentials`, accepted per-provider names on `PUT /api/credentials/{name}` and `DELETE /api/credentials/{name}`, and updated the AI factory / provider-resolution path so the correct stored key is selected at execution time based on the active provider.
- `resmon_scripts/frontend/src/components/Settings/AISettings.tsx` — replaced the single-key form with a presence map keyed by provider; this is the foundation OOB-1..OOB-8 build on.

### Batch 4 — Feature 2 + Feature 3: Per-execution AI override parity and Settings → AI tooltips

- `resmon_scripts/frontend/src/components/AIOverridePanel.tsx` *(new)* — single shared override panel rendering the full Settings → AI control set (Provider + Model + Length + Tone + Temperature + Extraction Goals). Empty values are dropped via a `buildAIOverridePayload` helper before posting so they cannot clobber persisted defaults during the backend per-field merge.
- `resmon_scripts/frontend/src/pages/DeepDivePage.tsx`, `resmon_scripts/frontend/src/pages/DeepSweepPage.tsx`, `resmon_scripts/frontend/src/pages/RoutinesPage.tsx` — mounted `AIOverridePanel` inside the form / create-edit modal; replaced the previous Length/Tone/free-text-Model trio with the shared panel (Routines previously had no override block at all).
- `resmon_scripts/resmon.py` (AI execution-settings merge) — extended the per-execution merge to accept Provider + Model + Length + Tone + Temperature + Extraction Goals as per-field overrides; per-execution overrides never write back to the persisted `app_settings` row.
- `resmon_scripts/frontend/src/components/Settings/AISettings.tsx` — added `InfoTooltip` "?" hovers next to the **Length**, **Tone**, **Temperature**, and **Extraction Goals** labels (Feature 3).

### Out-of-Band Additions

- **OOB-1, OOB-2, OOB-7, OOB-8 — Settings → AI Stored API Keys table.** `resmon_scripts/frontend/src/components/Settings/AISettings.tsx` now renders a four-column `Stored API Keys` table (Provider / Status / Default Model / Actions). The Provider name (only — not the row) is the click target for setting the app default; Status carries a `Default` badge for the active provider; per-row Actions expose `Clear default model` and `Clear API key`. The table is lifted out of the `.settings-form` 480 px-capped container into its own `min(960px, 100%)` wrapper with non-stacking horizontal Actions buttons. (`global.css` minor tweak from OOB-1 only; OOB-7/-8 stayed inline so the shared `.settings-form` rule is not perturbed.)
- **OOB-3, OOB-4 — Override panel: provider-aware Model dropdown + missing-key inline entry + Save-as-default-model.** `resmon_scripts/frontend/src/components/AIOverridePanel.tsx` replaced the override-panel free-text Model input with a dropdown populated by `POST /api/ai/models` for the chosen Provider, behind a `Load models` button. When the chosen Provider has no stored key, the panel renders an inline API-key input that POSTs to `/api/credentials/{name}` (re-using the Settings → AI endpoint). A `Save as default model` button persists the chosen model into `ai_default_models[provider]` without leaving the page; after save, the panel emits the live-update event so other surfaces refresh. No backend route additions.
- **OOB-5 — `ai_default_models` per-provider default-model map.** `resmon_scripts/resmon.py` added `ai_default_models` (JSON-encoded `{provider: model_id}` dict) to `_SETTINGS_GROUPS["ai"]`. All read/write paths (Settings → AI panel, override panel, the `AIDefaultsInfo` strip on Dive/Sweep/Routines) consult the map keyed by the active provider, falling back to the legacy global `ai_model` / `ai_local_model` only for the active provider's row when the map has no entry. Non-breaking, additive — no schema migration. **Operational caveat:** existing daemons started before this allowlist entry existed silently dropped `ai_default_models` writes; users upgrading past this update must restart the daemon (kill the existing `resmon-daemon` process and let the renderer attach to a fresh one).
- **OOB-6 — Race-safe writers in `AISettings.tsx`.** `handleClearDefaultModel`, `handleSetDefaultProvider`, and `handleSave` in `resmon_scripts/frontend/src/components/Settings/AISettings.tsx` each `GET /api/settings/ai` immediately before each `PUT`, merge the fresh `ai_default_models` map with their intended delta, and `PUT` only the narrow set of keys they need to change; the override panel already used a similarly narrow PUT. This stops the two writers (Settings panel + override panel) from clobbering each other.
- **OOB-9 — Configurations page per-row Edit action.** `resmon_scripts/frontend/src/pages/ConfigurationsPage.tsx` gained an `Edit` button on every row's Actions column with a config-type-aware modal: `routine` → full Routines-style editor (cron + multi-repo + date range + keywords + max-results + AI/Email/Email-AI/Notify toggles + Execution-Location radio + shared `AIOverridePanel`) saving via `PUT /api/routines/{linked_routine_id}`; `manual_sweep` → same form minus cron and the routine-only toggles, saving via `PUT /api/configurations/{id}`; `manual_dive` → same as `manual_sweep` but with `RepositorySelector mode="single"`. No new backend routes.
- **OOB-10 — Stale `linked_routine_id` 404 fallback.** `handleEditSave` in `resmon_scripts/frontend/src/pages/ConfigurationsPage.tsx` now tries `PUT /api/routines/{linked_routine_id}` first and, on 404, falls back to `PUT /api/configurations/{id}` with the full routine payload (and `linked_routine_id` cleared). Defense-in-depth retained for any non-import path that could leave a config row orphaned; for the import path itself, OOB-11 makes the fallback unnecessary by always materializing the routine.
- **OOB-11 — Import ↔ Routines bidirectional invariant.** `resmon_scripts/resmon.py`'s `import_configurations` endpoint post-processes each imported row: for every `config_type == 'routine'` config it parses the inner parameters JSON, builds a routine insert payload, **forces `is_active=0`** (imported routines are deactivated by default so bulk imports never auto-fire), calls `insert_routine`, captures the new id, and rewrites the just-imported config row's parameters JSON so `linked_routine_id` points at the new routine and `is_active=False`. The response gains a `routines_created` counter. `resmon_scripts/frontend/src/pages/RoutinesPage.tsx` subscribes to `useConfigurationsVersion()` so the routines list refetches on import without a page reload. No new dependencies; no schema changes.

### Public-Facing Documentation Touch-Ups (T-UPD-3)

- `README.md` — extended the **AI-powered summarization** Key-Features bullet to mention concurrent per-provider key storage and full per-execution AI override parity across Deep Dive / Deep Sweep / Routines; added a new **Cross-platform desktop notifications** Key-Features bullet covering macOS / Linux / Windows including the headless-daemon path; verified no other section (installation, supported repositories, operational modes, technology stack) required edits.
- `resmon_reports/info_docs/settings_info.md` — added the new four-column `Stored API Keys` table description, click-provider-name-to-set-default semantics, `Default` badge in Status, `Clear default model` / `Clear API key` actions, the `ai_default_models` map, and the four `InfoTooltip` additions on the AI panel; clarified the Notifications panel covers all three platforms (with the daemon caveat for app-closed routine notifications) and that Advanced → Background Execution is a precondition for app-closed notifications.
- `resmon_reports/info_docs/deep_dive_info.md`, `deep_sweep_info.md`, `routines_info.md` — replaced the Length/Tone/free-text-Model override description with the full-parity `AIOverridePanel` description (Provider-aware Model dropdown with `Load models`, inline API-key entry for missing-key providers, `Save as default model`); added the panel description to `routines_info.md` (previously absent).
- `resmon_reports/info_docs/configs_info.md` — documented the new per-row **Edit** action and its three modal variants (OOB-9), the stale `linked_routine_id` 404 fallback (OOB-10), and the import-bidirectional-sync rule from OOB-11; added the `routines_created` response field to the `/api/configurations/import` description.
- `resmon_reports/info_docs/routines_info.md` — also noted that routine rows can now appear via Configurations-page imports (deactivated by default) in addition to the Create-modal path, and that the page subscribes to the configurations bus so imports surface without a reload.
- `resmon_reports/info_docs/calendar_info.md` — updated the Event Styling paragraph for week/day views to describe the new dot+type-colored-text rendering.

### App Version Bump

- `resmon_scripts/implementation_scripts/config.py` — `APP_VERSION` bumped from `"1.0.0"` to `"1.1.0"` (minor: new user-visible features under a stable major).
- `resmon_scripts/frontend/package.json` — `"version"` bumped from `"1.0.0"` to `"1.1.0"` to match.
- `resmon_scripts/frontend/src/components/Settings/AboutAppSettings.tsx` — added a **Recent Update** card to the `about-grid` summarizing this update by number, name, and one-paragraph summary; the version line continues to read from `/api/health` so it tracks `APP_VERSION` automatically.

## Verification

### Test Suites Run

The Python suite (`pytest`) was executed from the repository root inside the project's `.venv` after every batch and every OOB change:

```bash
source .venv/bin/activate
pytest resmon_scripts/verification_scripts/ -q
```

- **Batch 1 (Calendar):** frontend webpack production build → `webpack 5.106.2 compiled successfully`; manual UI smoke confirmed dot+type-colored-text rendering on `dayGridMonth`, `timeGridWeek`, and `timeGridDay`, and that no background fill is applied to week/day events.
- **Batch 2 (Notifications):** notification-dispatcher unit tests → green; manual smoke (a) app open, manual Dive completion notification fires; (b) app open, routine completion notification fires; (c) app closed under macOS launchd-managed daemon, routine completion notification fires. Linux (`systemd --user`) and Windows (Task Scheduler) verified via the dispatcher entry-point unit tests plus the written manual-verification checklist where the dev machine could not natively exercise both OSes.
- **Batch 3 (Multi-provider keys):** `credential_manager` unit tests for per-provider naming and migration idempotency → green; `/api/credentials` route tests → green; AI factory provider-selection test → green; first-launch migration test against a synthetic legacy keyring entry → green.
- **Batch 4 (Override parity + tooltips):** AI execution-settings merge tests (per-execution per-field overrides do not write back to the persisted Settings → AI row) → green; routine-creation tests carrying override settings end-to-end → green; frontend webpack production build → green; one end-to-end smoke run on each of Dive / Sweep / Routine with one non-default override field populated and the others left blank confirmed per-field merge.
- **OOB-1..OOB-11:** webpack production build run after each OOB change → `compiled successfully` at every step. Backend Python unit tests for the credential-manager / settings paths remained green throughout. Backend `curl` round-trip on `PUT /api/settings/ai` confirmed `ai_default_models` persists across PUT/GET (after the stale-daemon caveat in OOB-5 was applied). Manual UI smoke confirmed: per-provider key storage round-trips; clicking only the Provider name sets the app default and adds the `Default` badge; `Clear default model` / `Clear API key` per-row Actions behave; OOB-6's race-safe merge accumulates entries across alternating saves from the two surfaces; the override panel's Load-models / inline-key / Save-as-default flow works on Dive / Sweep / Routines; Configurations Edit modal pre-populates and saves the right endpoint for each of the three config types; the OOB-10 fallback path saves successfully against an imported routine config with a stale `linked_routine_id`; and importing a routine config materializes a deactivated routine on the Routines page without reload.
- **Final aggregate run** at the end of T-UPD-2: `pytest resmon_scripts/verification_scripts/ -q` → all tests green, no skips beyond pre-existing platform-gated tests (Linux-only / Windows-only systemd and Task Scheduler integration paths are skipped on macOS by design and were exercised through the manual checklist instead).

### Skipped-Test Rationale

- The platform-gated Linux `systemd --user` and Windows Task Scheduler integration tests are skipped on macOS by their existing `pytest.mark.skipif` guards. They were exercised manually against the platform-specific service templates per the workflow's manual-verification checklist; no test was disabled or deleted.

### Build Verification

- Frontend: `npm run build` (production webpack) ran clean after each batch and after each OOB change.
- Backend: `python -c "import resmon_scripts.resmon"` and the daemon attach path ran clean after every backend touch; `[main] Attached to existing resmon-daemon on port 8742` confirmed at the end of T-UPD-2.

## Follow-ups

- **Stale-daemon advisory (OOB-5).** Users upgrading from a build that predates `ai_default_models` must restart any long-lived `resmon-daemon` process so the new settings-allowlist entry is picked up. The behavior is silent-drop, not error, on the old daemon. Consider adding a startup version check in a future update so the renderer can warn when the attached daemon is older than the renderer.
- **Linux / Windows live-OS verification.** Cross-platform parity for desktop notifications is covered by unit tests + the manual checklist; live-OS smoke runs on a Linux box and a Windows box are still recommended in a follow-up update once that hardware is available.
- **Configurations-page edit history.** OOB-9's Edit modal saves immediately; an undo / "revert to last saved" affordance was discussed but deferred — call it out as a candidate enhancement for a future update.
- **Per-paper artifact retention** (Settings → Storage PDF / TXT retention policies) remains reserved for a future per-paper artifact-download feature; this update does not exercise that surface.
