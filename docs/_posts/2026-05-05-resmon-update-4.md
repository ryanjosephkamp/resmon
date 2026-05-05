---
layout: post
title: "resmon Update 4 — May 5, 2026"
date: 2026-05-05 12:00:00 -0400
categories: [updates]
---

# Update 4 — Background Routine Reliability: Scheduler / Jobstore Lifecycle, Daemon-Attach Race, and Advanced-Tab Honesty

## Metadata

- **Update number:** 4
- **Update type:** bugfix
- **Date:** 2026-05-05
- **Author:** Ryan Kamp
- **Commit hash:** 9bb710562208ab053536b4bd6f49411b2174a595
- **Commit timestamp:** 2026-05-05T15:59:55-04:00
- **GitHub push timestamp:** 2026-05-05T20:00:06Z
- **App version:** 1.2.0 → 1.2.1

## Summary

This update is a reliability patch for scheduled Routines firing while the resmon window is closed. It closes three coupled defects: (i) routine ↔ APScheduler-jobstore lifecycle integrity (deleted routines no longer leave ghost `apscheduler_jobs` rows, daemon startup reconciles any pre-existing ghosts, and routine jobs are registered with a 1-hour `misfire_grace_time` so a fire whose nominal moment briefly passed still runs); (ii) the dual-backend race in which the Electron main process raced a launchd-bootstrapping daemon and silently spawned a competing backend with its own scheduler against the shared SQLite jobstore (now: `pingHealth` waits ~3 s with retry/backoff, lock-file presence forces a wait rather than a spawn, and even a legitimate fallback spawn honors `RESMON_DISABLE_SCHEDULER=1` so the renderer-spawned backend never owns a scheduler); and (iii) Advanced-tab honesty — the "Run resmon in the background" status block now reads `daemon.lock` and probes the daemon's actual port through a new `GET /api/service/daemon-status` route, so the displayed pid / version / `last_started` reflect the real daemon and any future dual-backend race surfaces immediately rather than being masked. App version bumps `1.2.0 → 1.2.1`.

## Motivation

All five fixes originated in a diagnostic session after the user observed in Update 3's tutorial-recording flow that, having used the Settings → Advanced Danger Zone to wipe data and re-enable "Run resmon in the background," scheduled Routines no longer fired when the app window was closed even though the Advanced tab reported the daemon as Installed and "up." The full diagnosis lives in [`resmon_update_4_overview.md`](./resmon_update_4_overview.md); the change inventory and batching plan live in [`update_5_5_26_workflow.md`](./update_5_5_26_workflow.md). The five items map back to the workflow doc as Fixes A–E:

- **Fix A — Routine ↔ jobstore lifecycle integrity** (workflow item #1, Batch 1). `delete_routine` did not remove the matching `apscheduler_jobs` row; the dispatcher kept trying to fire ghost jobs whose owning routine was gone, and a Danger-Zone wipe could leave ghosts behind that no UI surface could reach. Coupled with Fix B in Batch 1 because both touch `scheduler.py` / `database.py` / the FastAPI startup wiring and are exercised by the same scheduler verification suite.
- **Fix B — Default `misfire_grace_time` for routine jobs** (workflow item #2, Batch 1). APScheduler's default `misfire_grace_time` of 1 second silently dropped any fire whose nominal moment had passed by even a brief window — exactly the failure mode produced by a daemon restart, a scheduler reattach, or the app's own scheduler dying without a clean `shutdown()`.
- **Fix C — Robust daemon attach in the Electron main process** (workflow item #3, Batch 2). The 500 ms `/api/health` timeout returned `false` during the launchd daemon's bootstrap window; the renderer then silently spawned its own backend with its own scheduler against the same SQLite jobstore, and once the spawned backend died at app close every queued fire was marked "missed by N hours."
- **Fix D — Renderer-spawn never owns a scheduler** (workflow item #4, Batch 2). Defense in depth for Fix C: even when a renderer-spawned fallback is legitimate (no daemon installed at all), the spawned backend must not start a `ResmonScheduler` against the shared jobstore. Implemented as a `RESMON_DISABLE_SCHEDULER=1` env var that `main.ts` sets on the spawned child and the FastAPI startup hook honors.
- **Fix E — Advanced tab daemon-status truthfulness** (workflow item #5, Batch 3). The Advanced tab populated its daemon-status line from `GET /api/health` against whichever backend the renderer was attached to, so a renderer-spawned fallback masqueraded as the daemon and the dual-backend race was invisible to the user. The fix reads `daemon.lock` server-side and probes the daemon's actual port through a new endpoint.

## Changes

### Batch 1 — Fixes A + B (scheduler / jobstore lifecycle cluster)

- `resmon_scripts/implementation_scripts/scheduler.py` — `add_routine` registers each routine job with `misfire_grace_time=3600`; new `reconcile_jobstore_with_routines` method drops every `apscheduler_jobs` row whose id has no matching `routines.id` with `is_active=1`; called once from the FastAPI startup hook before active routines are re-registered. (Fix B + Fix A reconciliation.)
- `resmon_scripts/implementation_scripts/database.py` — `delete_routine` removes the matching `apscheduler_jobs` row in the same transaction as the `routines` delete (idempotent against APScheduler-side removals; deletion-time job removal is tolerant of an already-gone row). (Fix A cascade.)
- `resmon_scripts/resmon.py` — startup hook calls `scheduler.reconcile_jobstore_with_routines()` before re-registering active routines so any pre-existing ghosts are dropped on first boot of the patched daemon. (Fix A startup wiring.)
- `resmon_scripts/verification_scripts/test_scheduler_reconciliation.py` *(new)* — regression: seeds an orphan `apscheduler_jobs` row, runs reconciliation, asserts removal; seeds a job whose owning routine is `is_active=0`, asserts removal; seeds a job whose owning routine is active, asserts retention.
- `resmon_scripts/verification_scripts/test_routine_scheduler_sync.py` *(new)* — regression: inserts a routine, registers its job, calls `delete_routine`, asserts no orphan `apscheduler_jobs` row remains.
- `resmon_scripts/verification_scripts/test_scheduler_lifecycle.py` *(new)* — regression: asserts new routine jobs are added with `misfire_grace_time=3600`.
- `resmon_scripts/verification_scripts/test_scheduler_wiring.py` *(new)* — verifies the FastAPI startup hook invokes `reconcile_jobstore_with_routines` before re-registration.

### Batch 2 — Fixes C + D (dual-backend race cluster)

- `resmon_scripts/frontend/electron/main.ts` — `pingHealth` AbortController timeout raised from 500 ms to ~3 s; the lock-file → health-probe sequence is wrapped in a 2–3 attempt retry loop with brief backoff (hard ceiling ~4.5 s wall); when `read_lock()` returns a payload but the health probe has not yet responded, the main process waits for the daemon rather than falling through to the spawn branch; the spawn branch sets `RESMON_DISABLE_SCHEDULER=1` on the child env so a legitimate renderer-spawned fallback never owns a scheduler.
- `resmon_scripts/resmon.py` — FastAPI startup hook gates `ResmonScheduler` instantiation and `set_dispatcher` on `os.environ.get("RESMON_DISABLE_SCHEDULER")` being unset / falsy; default behavior preserved for direct `python resmon.py <port>` invocations and for `create_app()` test calls.
- `resmon_scripts/frontend/dist/electron/main.js` — rebuilt from `main.ts` via `tsc --project tsconfig.electron.json`.
- `resmon_scripts/verification_scripts/test_scheduler_disable_env.py` *(new)* — regression: with `RESMON_DISABLE_SCHEDULER=1` set, `create_app()` startup must not instantiate `ResmonScheduler` and must not call `set_dispatcher`; with the env var unset / falsy, scheduler startup proceeds normally.

### Batch 3 — Fix E (Advanced tab daemon-status truthfulness)

- `resmon_scripts/resmon.py` — new `GET /api/service/daemon-status` route that calls `daemon.read_lock()`, probes `http://127.0.0.1:<lock_port>/api/health` via `httpx` (1.5 s timeout), and returns `{ lock_present, running, pid, port, version, started_at, lock_pid, lock_port, lock_version, error, is_self }`; the `is_self` flag is set when the probed pid equals the current process pid so the renderer can render the distinction between "daemon is the current backend" and "daemon is a separate process."
- `resmon_scripts/frontend/src/components/Settings/AdvancedSettings.tsx` — added `DaemonStatusResponse` type; `refresh()` polls `/api/service/daemon-status` alongside the existing `/api/service/status` and `/api/health` calls; status block rewritten to render three explicit states ("daemon up" with pid/version and an `, this process` tag when `is_self`; "lock present but unreachable" with the diagnostic error; "no daemon running"); the renderer-attached backend's identity is shown separately as `· this window → pid …, v…` so any divergence between the two is immediately visible. `Last started` is now sourced from the daemon-status response rather than `/api/health`.
- `resmon_scripts/frontend/dist/bundle.js` — rebuilt from the renderer source via `webpack --mode production`.
- `resmon_scripts/verification_scripts/test_daemon_status_endpoint.py` *(new)* — three regression tests: (a) no lock file → `lock_present=False, running=False`; (b) stale lock pointing at a closed port → `lock_present=True, running=False, error` populated; (c) valid lock + monkey-patched `httpx.Client` returning a healthy response → `running=True` with daemon identity surfaced.

### T-UPD-3 documentation pass (this step)

- `resmon_scripts/implementation_scripts/config.py` — `APP_VERSION = "1.2.0"` → `"1.2.1"`.
- `resmon_scripts/frontend/package.json` — `"version": "1.2.0"` → `"1.2.1"`.
- `resmon_scripts/frontend/src/components/AboutResmon/AboutAppTab.tsx` — `backendVersion` initial fallback bumped `1.0.0` → `1.2.1`; "Recent Update" card rewritten to summarize Update 4 (replacing the Update 3 copy).
- `resmon_reports/info_docs/settings_info.md` — Advanced panel description now documents the new `GET /api/service/daemon-status` endpoint and the three-state status block; endpoint table gains the new route.
- `resmon_reports/info_docs/system_info.md` — "headless daemon split" paragraph now documents the raised `pingHealth` timeout / retry+backoff, the lock-file-aware wait, and the `RESMON_DISABLE_SCHEDULER` env gate that ensures only the daemon ever owns a scheduler.
- `resmon_reports/info_docs/routines_info.md` — Delete-a-routine flow now documents the `delete_routine` cascade into `apscheduler_jobs`, the daemon-startup reconciliation, and the `misfire_grace_time=3600` registration default.
- `.ai/updates/update_5_5_26/update_5_5_26.md` — this log.
- `.ai/updates/updates.csv` — appended Update 4 row (commit_hash / commit_timestamp / github_push_timestamp = pending; T-UPD-4 will overwrite).

## Verification

Per-batch test command and results (verification suite at `resmon_scripts/verification_scripts/`):

- **Batch 1** — `python -m pytest resmon_scripts/verification_scripts/test_scheduler_disable_env.py resmon_scripts/verification_scripts/test_scheduler_lifecycle.py resmon_scripts/verification_scripts/test_scheduler_wiring.py resmon_scripts/verification_scripts/test_scheduler_reconciliation.py resmon_scripts/verification_scripts/test_routine_scheduler_sync.py resmon_scripts/verification_scripts/test_daemon.py` — all passing (this superset is the same command used for the post-Batch-3 sanity run; per-batch counts were captured at the time of each batch report).
- **Batch 2** — Python regression `test_scheduler_disable_env.py` covers Fix D's `RESMON_DISABLE_SCHEDULER` env gate; Fix C's Electron main-process retry/backoff is exercised by manual UI verification (the project does not currently host a JS-side Electron main test harness — same posture documented in Updates 2 and 3).
- **Batch 3** — `python -m pytest resmon_scripts/verification_scripts/test_daemon_status_endpoint.py resmon_scripts/verification_scripts/test_daemon.py resmon_scripts/verification_scripts/test_service_units.py` → **21/21 passing, 0 skipped**.
- **Frontend build** — `cd resmon_scripts/frontend && npm run build` succeeded after the Batch 2 / Batch 3 edits (webpack production renderer bundle clean; `tsc --project tsconfig.electron.json` for `dist/electron/main.js` clean).
- **Manual UI smoke** — daemon was restarted via `launchctl kickstart -k gui/$UID/com.resmon.daemon` to reload the patched Python; `resmon.app` launched and attached to the daemon on port 8742 (no fallback backend spawned); `GET /api/service/daemon-status` returns the documented shape with `is_self=true` when the renderer is attached to the daemon.

Concatenated counts string (for the CSV row): `backend: 21/21 passing, 0 skipped on the targeted batch-3 suite (test_daemon_status_endpoint.py + test_daemon.py + test_service_units.py); batch-1 suite (test_scheduler_disable_env.py + test_scheduler_lifecycle.py + test_scheduler_wiring.py + test_scheduler_reconciliation.py + test_routine_scheduler_sync.py + test_daemon.py) all passing; platform-gated Linux systemd --user and Windows Task Scheduler tests remain skipped on macOS via their existing skipif guards (no daemon / service-unit code path on those platforms changed in this update); frontend: webpack production build clean after every batch; manual UI smoke confirmed daemon attach via launchd, no fallback backend spawn, /api/service/daemon-status three-state rendering, and that scheduled Routines now fire from the daemon's scheduler with the new misfire grace`.

## Follow-ups

- **Stale-daemon caveat for upgrading users.** As with Updates 2 and 3, an existing `resmon-daemon` started before this update is still running the old `scheduler.py` / `database.py` / `resmon.py` and therefore still has the 1-second misfire grace, the `delete_routine` cascade gap, and the missing `/api/service/daemon-status` route. Users upgrading from 1.2.0 should restart the daemon (`launchctl kickstart -k gui/$UID/com.resmon.daemon` on macOS, `systemctl --user restart resmon-daemon` on Linux, or unregister/re-register the Task Scheduler entry on Windows) so the renderer attaches to a fresh backend.
- **Electron main-process test harness.** Fix C's retry/backoff / lock-file-aware wait is currently covered only by manual UI verification. A future update could introduce a focused JS-side test harness for `frontend/electron/main.ts` (mocking `fetch` and the lock-file reader) so Fix C's branches are regression-protected the same way Fix D is.
- **Scheduler-diagnostics surface.** The Advanced tab's `/api/scheduler/jobs` panel now reflects the daemon's jobstore truthfully (since only the daemon owns a scheduler). A small follow-up could surface `misfire_grace_time` and the most-recent reconciliation pass timestamp on each row for operator transparency.
