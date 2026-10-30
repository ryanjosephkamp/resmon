---
title: "Architecture"
summary: "The backend, the renderer, the scheduler, the admission controller, the progress stream, the technology stack and the layout of the source tree."
order: 8
readmeLines:
  - "670-868"
---
## Architecture Overview

resmon is a local-first desktop application composed of two cooperating processes: an Electron main process and a Python FastAPI backend. The Electron main process launches the Python backend as a child process (or attaches to an already-running headless daemon managed by `daemon.py` + `service_manager.py`) and hosts the React renderer window. The renderer never calls Python directly — it talks to the backend exclusively over `fetch`-based JSON on `http://127.0.0.1:<port>` (default `8742`, discovered via `window.resmonAPI.getBackendPort()`) and over Server-Sent Events for live progress.

### Backend — FastAPI + SQLite

The backend is a single FastAPI application constructed at module load in `resmon_scripts/resmon.py`. A shared `sqlite3.Connection` backs every request, the database path defaults to `resmon.db` at the project root, and the schema is owned by `implementation_scripts/database.py` with a version-tracked migration path on startup. Binding to `127.0.0.1` is not a boundary on its own — any web page in any browser on the machine can send requests to loopback — so since 2.2 the outermost ASGI layer (`LocalApiGuard`) refuses every request, on every route, that does not name a loopback `Host` on the backend's own port, come from the app's own renderer origin when it has an `Origin`, and carry the backend's per-instance token in `Authorization: Bearer`. CORS answers the renderer's exact origin and nothing else, and `Access-Control-Allow-Private-Network` is sent only on a preflight from that origin that asks for it. What this defends and what it does not: [`docs/local-api-security.md`](docs/local-api-security.md). All SQL is parameterized; all credentials flow through a single `credential_manager.py` module that owns OS-keyring access.

The core pipeline is `SweepEngine` (`implementation_scripts/sweep_engine.py`), which orchestrates query → normalize → dedup → link → report → summarize → finalize for both manual and routine-fired runs. Per-source API clients (26 repositories) live under `implementation_scripts/api_*.py` and are registered through `api_registry.py`. Results are normalized by `normalizer.py`, deduplicated by DOI and by (title, first author), and rendered by `report_generator.py` into Markdown, with optional PDF and LaTeX exports through `report_exporter.py`.

### Frontend — Electron + React

The renderer is a React 18 + TypeScript single-page application bundled with Webpack and served into an Electron window (`electron/main.ts`, `dist/electron/main.js`). Routing uses `react-router-dom` `HashRouter` because the packaged app is loaded from `file://` where push-state history is unreliable. `ExecutionProvider` wraps every route to hold live multi-execution state. All HTTP access is centralized in two API-client wrappers (`api/client.ts`, `api/repositories.ts`), each of which sets `Cache-Control: no-store` and unwraps FastAPI's `{detail: "..."}` error envelope into a single readable message. A `FloatingWidget` overlay is mounted outside `MainContent` so it survives route transitions and continues to pulse for any running execution.

### LLM Integration — BYOK Remote and Local (ollama)

AI summarization is optional and fully bring-your-own-key. `implementation_scripts/llm_factory.py` (`build_llm_client_from_settings`) reads the persisted `ai_*` settings and returns either a `RemoteLLMClient` (OpenAI, Anthropic, Google, xAI, Meta, DeepSeek, Alibaba, or a user-defined custom provider), a `LocalLLMClient` backed by a local [ollama](https://ollama.com) instance over its REST API (`implementation_scripts/llm_local.py`), or `None` when the provider is unset — "AI unconfigured" is a silent no-op, never an exception. The custom-provider base URL is validated to be HTTPS unless the host is loopback, both in the Settings → AI panel and in the factory. Token-aware chunking and provider-agnostic summarization live in `summarizer.py` with prompt scaffolding in `prompt_templates.py`. API keys are never logged, never included in exception messages, and never returned by any GET endpoint; key lookup honors an ephemeral per-execution stack that takes precedence over the keyring value.

### Scheduler — APScheduler with SQLAlchemy Job Store

Routine firing is driven by `ResmonScheduler` (`implementation_scripts/scheduler.py`), a thin wrapper over APScheduler's `BackgroundScheduler` with a `SQLAlchemyJobStore` backed by `sqlite:///resmon.db`, so jobs persist across app restarts. Cron parsing is strict 5-field (`minute hour day month day_of_week`). The scheduler is decoupled from FastAPI via a dispatcher indirection: `set_dispatcher(fn)` installs the callback invoked on each fire, and the APScheduler worker thread can never raise because a missing dispatcher is logged and returned. On startup, `_init_scheduler_on_startup` re-registers every active routine from `get_routines(conn)`; on shutdown, the scheduler is gracefully stopped.

Only one process owns a scheduler. The packaged app starts its own backend with `RESMON_DISABLE_SCHEDULER=1` and attaches to the background service only when that service runs the same version, so routines fire only where the service runs. A service unit names the database and reports folder of the backend that installed it (`--db-path` and `--reports-dir` on the daemon's command line), so a service installed from the packaged app serves the app's own corpus rather than the checkout-relative defaults inside the app bundle.

### Admission Controller

`implementation_scripts/admission.py` (`ExecutionAdmissionController`) is the single global gate on concurrent executions. `max_concurrent` is clamped to `[1, 8]` (default `3`) and the routine-fire queue is clamped to `[1, 64]` (default `16`). **Manual** admission is reject-or-pass: if no slot is free, REST endpoints raise HTTP `429` with a `Retry-After: 5` header that the Deep Dive / Deep Sweep forms surface verbatim. **Routine** admission falls through to a bounded FIFO queue that drains as slots free; overflow past `queue_limit` is dropped with a logged error. Live limits are reloaded from the `settings` table at startup and updated through `PUT /api/settings/execution` (Settings → Advanced panel).

### SSE Progress Stream

Live progress is streamed through `ProgressStore` (`implementation_scripts/progress.py`), a thread-safe in-memory bus between pipeline worker threads and the SSE endpoint. Each `exec_id` owns its own event list, lock, cancel-flag `threading.Event`, and completion boolean. The backend exposes three surfaces on top of it:

- `GET /api/executions/active` — a cheap `{active_ids: [...]}` payload polled by `ExecutionContext` every 3 seconds as a safety net that attaches background-initiated runs and detects dropouts.
- `GET /api/executions/{id}/progress/events` — the full event list, used by the 1-second per-execution poller that drives `ExecutionContext` and thus the Monitor page and FloatingWidget.
- `GET /api/executions/{id}/progress/stream` — a true SSE endpoint emitting `event: progress` frames with `id: <cursor>` headers, `~300 ms` heartbeats (`: heartbeat\n\n`), `last_event_id` resumption, and a post-terminal drain that replays any persisted-but-unread events before closing.

Standard SSE headers are set (`Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`) and `PrivateNetworkMiddleware` does not buffer the stream. After an execution ends, buffered events are persisted into the `execution_progress` table so the Monitor and Results pages can reconstruct the stream after a process restart. Cancellation is cooperative: `POST /api/executions/{id}/cancel` sets the cancel flag, the pipeline's 2-second heartbeat notices, a partial report is flushed, and the execution finalizes as `cancelled`.

#### Interrupted runs and Restart (schema 19)

Cancellation is the *orderly* way a run stops, and it is the only one the paragraph above describes. A backend that is force-quit, loses power, or is killed by Electron on the way out does not get to flush anything, and the run's row used to sit at `running` for ever: it appeared in no active list, could not be cancelled, and claimed in Results & Logs to still be searching.

`executions.status` has a fifth value for that: **`interrupted`**. It is deliberately not `failed` — nothing went wrong with the search, the process it was running inside went away, and saying `failed` was an overclaim resmon made about itself for several releases. The row records `interrupted_reason`, one of:

| Reason | What resmon observed |
|---|---|
| `daemon_restart` | resmon watched itself stop and wrote the row on the way out. |
| `owner_dead` | A later start found the process that owned the row gone. |
| `unknown` | Neither could be established. |

Each run records the pid and runtime id of the backend that owns it (`owner_pid`, `owner_runtime_id`) and stamps `last_seen_at_utc` at every pipeline stage boundary and every 30 seconds inside a long one. On startup, before the scheduler starts, `_reconcile_executions_on_startup` adopts every `running` row whose owner can be *established* to be gone. Everything else is left running and counted in the log: a pid that has been reused, or one belonging to another user, reads as alive, because telling a user that a live run has died is the worse mistake.

Rows written before schema 19 recorded no owner at all, so there is no liveness fact to read and the only remaining evidence is the clock. Those are adopted after **24 hours**. That number is a judgement rather than a measurement: resmon puts no ceiling on how long a sweep may take and the admission queue makes a routine fire wait for a slot with no timeout, so there was no shorter number in the code to borrow. It goes stale on its own as pre-2.3 history ages out.

From an interrupted, failed or cancelled row, **Restart** (`POST /api/executions/{id}/restart` → 202) begins a fresh execution with the source's search terms, databases and date window, carrying `restarted_from` back to it; `GET /api/executions/{id}` reports both that link and the `restarted_into` ids. The source row is never modified — it is a record of what happened. Restart is **not** resume: progress events are persisted once, at the end of a run, so an interrupted run has nothing durable to carry forward. It reproduces the search and the AI on/off choice (read from whether the source has `execution_ai` lane rows), not the provider, model or credential of the day — `parameters` never held those, and reconstructing them would be a guess. A restart goes through the same manual admission cap as a Deep Sweep, and cancelling a row that is not running now answers 409 with a sentence naming its state.

#### One run per routine, one run per submission, and the fires nobody was up for (schema 20)

Three doors lead into a routine fire — the scheduler's callback, `POST /api/routines/{id}/run`, and the admission queue draining a fire it had held — and until 2.3 none of them knew about the others. A routine that ran longer than its own period would be fired again on top of itself, and a person who clicked **Run now** while a scheduled sweep was in flight got a second one.

A fire is now admitted only after an atomic **claim** on the routine, taken under a lock before the worker thread starts and released in that thread's `finally`. It is deliberately not a `SELECT ... WHERE status = 'running'`: the execution row does not exist yet when the second fire arrives, so that query is too late — and after a force-quit it is far too long, because rows nobody owns would refuse the routine for ever. (Those rows are schema 19's business, above.) The claim lives in the memory of the backend that owns the scheduler; a second fire while it is held is answered **409** naming the live execution id, on all three doors, and the MCP `run_routine` tool passes that id through as `{"conflict": "routine_already_running", "execution_id": N}`.

`POST /api/search/dive`, `POST /api/search/sweep` and `POST /api/executions/{id}/restart` accept an optional client **`request_id`**. Two requests carrying the same id are one submission: the second is answered with the execution the first started, as `{"execution_id": N, "duplicate": true}`, and no second row is ever written — `executions.request_id` carries a partial `UNIQUE` index over it. The renderer mints one id per *in-flight request* and disables the submit control while that request is running, so a second click cannot become a second run and a retry of the same submission is answered with the run already going. The id is never minted at page load: fixed for the life of the page, it would answer a user's genuine second search with their first one's results.

Finally, **missed fires**. A routine due at 07:00 on a morning the laptop stayed shut was not skipped loudly — it was skipped invisibly, because re-adding routines on startup recomputes each job's next fire from the present moment and overwrites the overdue time before anything can read it. resmon now reads the jobstore's persisted `next_run_time` *before* starting the scheduler and before the re-add, and writes a row into `routine_missed_fires` for every active routine whose fire had already passed. `GET /api/routines/{id}` reports `missed_fires` (a count and the last overdue time) and the detail; the Routines page says "missed N fires while resmon was closed; last due …", and routine-health analytics carries the count beside the run series — a routine can look healthy by every other measure while quietly running a third as often as its owner believes.

What that row claims is exactly what was observed: the next fire was in the past when resmon looked. It is not a claim that the run did not happen — APScheduler's one-hour misfire grace means a fire found a few minutes late can still run — and **nothing is run to catch up**. Whether resmon should quietly perform a weekend of missed sweeps the moment a laptop opens is a decision for its owner, not a default chosen by a migration; the `disposition` column exists to record that policy when there is one.

### Delivery: where a report goes, and whether it got there

Until schema 21 a routine had exactly one destination — an email, sent inline from the execution worker — and resmon recorded nothing about it. A mail server that had started refusing connections, a password that had been rotated, a laptop with no network: each produced a line in a log file nobody reads, and the user's completion emails simply stopped. For an application whose subject is *telling you when your monitoring has broken*, that was the wrong way round.

A routine now has a list of **destinations** (`routine_delivery_targets`), and every attempt to reach one is a row in `deliveries`: which run, which destination, the state, how many attempts, the reason it has not arrived, and when the next attempt is due. Four channels ship:

- **Email** — the existing sender, now behind a channel adapter. The bundle it attaches (when *Results in Email* is on) is the one `POST /api/executions/export` builds, search-record companions included; the old hook quietly left those out, so a mailed bundle was poorer than the same user's downloaded one. The SMTP password stays in the OS keyring and never reaches a table, a setting or an error message.
- **Folder** — the same bundle, unpacked into a directory you choose, plus a `delivery.json` naming the run and the report's sha256. It is written to a temporary name and renamed into place, so a sync client watching the folder never uploads a half-written report. This is what makes iCloud, Dropbox, OneDrive or a shared drive a delivery destination with no code of ours on the wire. A directory that is not there — an unmounted drive, a folder that is not signed in — is refused with that said, and the reason is recorded rather than the delivery being dropped.
- **Webhook** — an `https://` address you own, which receives a signed JSON envelope: the routine and run, when it finished, how many results and how many were new, the read-time coverage line, the report's sha256, a link to the search record, and the report bundle. The bundle travels as a 24-hour signed link the receiver fetches from resmon, or inline as base64 when you tick *Send the bundle inside the envelope*. Every envelope is signed with a secret you set on the destination and resmon holds in the OS keyring; it will not send an unsigned one. Plain `http://` is refused except for a receiver on `127.0.0.1`. A non-2xx answer or a timeout is a recorded failure carrying the status code — never the address. The receiver's side of the contract is [docs/delivery.md](docs/delivery.md).
- **Feed** — an Atom 1.0 file at `<folder>/resmon/<routine>/feed.xml`, rewritten whole and renamed into place on each delivery, holding the newest 50 runs newest-first. One entry per run, linking to the folder channel's bundle directory when the routine has one and carrying the summary alone when it does not. Every string in it is escaped, there is no script, no tracker and no secret-bearing link — a feed file gets copied into shared folders and read by software resmon has no relationship with, so the signed bundle link deliberately never appears in one.

Each destination is **automatic** or **waits for review**. A review destination's delivery is recorded as `awaiting_review` and sits there, through restarts, until a person releases it; nothing promotes it, ever. Delivery, skip and retry are the three decisions the queue is deliberately not allowed to make.

The completion hook no longer sends anything: it enqueues one row per enabled destination and wakes a **drain thread**, which claims a due row by compare-and-swap, delivers it, and writes back. That matters beyond tidiness — the old hook talked to a mail server on the execution worker's thread, still holding that run's admission slot. Failures back off 1 minute, 5 minutes, 25 minutes and then stop with the reason on the row; `UNIQUE(execution_id, target_id)` plus the CAS is what makes "delivered exactly once" a fact the database enforces. A row left mid-delivery by a backend that was force-quit is re-queued on the next start, and only where that owner can be established to be gone — resmon would rather send a report twice than never.

**B4, kept by the migration**: every routine that had `email_enabled = 1` gets one automatic email target, whose blank address means the recipient in Settings → Email. An existing user's completion emails keep arriving with nothing to edit, and `email_enabled` is still the switch the Routines page toggles — an email destination on a routine with the switch off is not queued.

What resmon claims is what it did: that it handed the report to your mail server, wrote it into the folder, or got a 2xx from your receiver. Whether the message reached an inbox, whether the folder finished syncing, and what the receiver did with the envelope after answering, it cannot see, and the panel says so.

### Backup into a folder

`implementation_scripts/backup.py` writes a bundle — the database through SQLite's backup API, the Library vault, optionally the reports, and a manifest of hashes — into the folder `export_directory` names. resmon does not sign in to Google: a backup kept in Google Drive is one written into the folder Google Drive for desktop keeps, which that client uploads. The Google Drive sign-in and upload resmon used to have (`cloud_storage.py`) were removed on October 30, 2026, along with the Google client libraries.

## Technology Stack

| Category | Component | Purpose |
|---|---|---|
| **Backend** | Python 3.10+, FastAPI 0.135, Starlette 1.0, Uvicorn 0.44, Pydantic 2.12 | HTTP server, request validation, ASGI runtime |
| **Backend** | httpx 0.28, lxml 6.0, beautifulsoup4 4.14 | Repository API clients, XML/HTML parsing |
| **Backend** | cryptography 46, keyring 25.7 | OS-keyring credential storage, envelope encryption helpers |
| **Backend** | nltk 3.9, tiktoken 0.12 | Text normalization and token-aware chunking for summarization |
| **Frontend** | Electron 41, Node.js 22.13+, npm 10+ | Desktop shell, main-process bridging |
| **Frontend** | React 19, React Router 7 (`HashRouter`), TypeScript 6 | Renderer SPA and routing |
| **Frontend** | Webpack 5, ts-loader 9, css-loader 7, style-loader 4, html-webpack-plugin 5 | Build pipeline |
| **Frontend** | FullCalendar 6 (`@fullcalendar/react`, `daygrid`, `timegrid`, `interaction`) | Calendar page rendering |
| **Frontend** | `electron-builder` 26 | Packaged-app distribution |
| **Database** | SQLite 3 (stdlib `sqlite3`), SQLAlchemy 2.0 | Local state, schema migrations, APScheduler job store |
| **LLM — Remote (BYOK)** | `openai` 2.31, `anthropic` 0.95, plus provider-agnostic `httpx` clients for Google, xAI, Meta, DeepSeek, Alibaba, and custom HTTPS endpoints | Remote summarization backends |
| **LLM — Local** | [ollama](https://ollama.com) REST API (`/api/generate`, `/api/tags`) via `llm_local.py` | On-device open-weight model inference (Llama, Gemma, Qwen, etc.) |
| **Scheduling** | APScheduler 3.11 (`BackgroundScheduler` + `SQLAlchemyJobStore`) | Routine cron jobs, persistent across restarts |
| **Service integration** | launchd (macOS), `systemd --user` (Linux), Task Scheduler (Windows) via `service_manager.py` | Optional headless-daemon OS service |
| **Email** | stdlib `smtplib` (via `email_notifier.py` + `email_sender.py`), `python-multipart` 0.0.26 | Transactional SMTP notifications and attachment handling |
| **Testing** | pytest 9.0, pytest-timeout 2.4 | Backend unit and integration tests under `resmon_scripts/verification_scripts/` |
| **Testing** | TypeScript `tsc --noEmit` (`npm run typecheck`) | Frontend type checking |

## Project Structure

```
resmon/
├── README.md                       # This file.
├── LICENSE                         # MIT license.
├── requirements.txt                # Pinned Python dependencies.
├── resmon.db                       # SQLite database (created on first launch).
│
├── resmon_scripts/                 # All application source code.
│   ├── resmon.py                   # FastAPI app entrypoint (routes, startup/shutdown hooks).
│   │
│   ├── implementation_scripts/     # Backend modules.
│   │   ├── admission.py              # Concurrent-execution admission controller.
│   │   ├── analytics.py              # Corpus analytics queries (thin-corpus policy).
│   │   ├── explorer.py               # Corpus-wide search, faceting, keyset pagination.
│   │   ├── ai_models.py              # Provider model-catalog probing.
│   │   ├── api_*.py                  # Per-repository API clients (26 active sources).
│   │   ├── api_base.py               # Shared rate limiter + HTTP client base class.
│   │   ├── api_registry.py           # Slug → client dispatch table.
│   │   ├── config.py                 # APP_NAME, paths, defaults.
│   │   ├── config_manager.py         # Configuration JSON export/import.
│   │   ├── credential_manager.py     # OS-keyring credential vault + ephemeral stack.
│   │   ├── daemon.py                 # Headless-daemon lock file, state dir, attach/spawn logic.
│   │   ├── database.py               # Schema, migrations, parameterized queries.
│   │   ├── email_notifier.py         # Email templating and dispatch.
│   │   ├── email_sender.py           # SMTP transport.
│   │   ├── lifecycle.py              # Retractions, preprint→published, version tracking.
│   │   ├── llm_factory.py            # Provider whitelist + client construction.
│   │   ├── llm_local.py              # ollama REST client.
│   │   ├── llm_remote.py             # Remote-BYOK client (OpenAI, Anthropic, etc.).
│   │   ├── logger.py                 # Rotating app logger + per-execution TaskLogger.
│   │   ├── match_explain.py          # Keyword match transparency + per-keyword contribution.
│   │   ├── normalizer.py             # Cross-source metadata normalization + dedup.
│   │   ├── progress.py               # ProgressStore (SSE/poll event bus + cancel flag).
│   │   ├── reading_queue.py          # Saved-paper membership: To read / Read, over document ids.
│   │   ├── prompt_templates.py       # Summarization prompt scaffolding.
│   │   ├── repo_catalog.py           # Repository metadata catalog.
│   │   ├── report_generator.py       # Markdown report composition.
│   │   ├── reference_export.py       # BibTeX / RIS / CSV / JSON reference exports.
│   │   ├── report_exporter.py        # PDF / LaTeX export pipeline.
│   │   ├── scheduler.py              # ResmonScheduler (APScheduler wrapper).
│   │   ├── search_record.py          # PRISMA-shaped reproducible search record.
│   │   ├── service_manager.py        # launchd / systemd / Task Scheduler integration.
│   │   ├── summarizer.py             # Token-aware chunking + provider-agnostic summarization.
│   │   ├── sweep_engine.py           # End-to-end query → dedup → report → summarize pipeline.
│   │   ├── utils.py                  # Shared helpers.
│   │   ├── watchdog.py               # Silent-failure detection over execution history.
│   │   └── assets/                   # Static backend assets (templates, figures).
│   │
│   ├── frontend/                   # Electron + React renderer.
│   │   ├── package.json              # Node dependencies and build scripts.
│   │   ├── webpack.config.js         # Renderer bundle config.
│   │   ├── tsconfig.json             # Renderer TypeScript config.
│   │   ├── tsconfig.electron.json    # Electron-main TypeScript config.
│   │   ├── electron/                 # Electron main-process sources (preload, IPC bridge).
│   │   ├── src/                      # Renderer SPA.
│   │   │   ├── index.tsx               # React root.
│   │   │   ├── App.tsx                 # HashRouter + layout + providers.
│   │   │   ├── api/                    # Typed HTTP client wrappers.
│   │   │   ├── components/             # Shared components (Sidebar, Header, FloatingWidget, …).
│   │   │   ├── context/                # ExecutionContext.
│   │   │   ├── hooks/                  # useExecutions, useRepoCatalog.
│   │   │   ├── pages/                  # One component per route (DashboardPage, AnalyticsPage, ExplorerPage, …).
│   │   │   ├── styles/                 # Global stylesheets.
│   │   │   ├── types/                  # Shared TypeScript types.
│   │   │   └── __tests__/              # Renderer unit tests.
│   │   └── dist/                     # Build output (renderer/, electron/).
│   │
│   ├── service_units/              # launchd plists, systemd units, Task Scheduler XML.
│   └── verification_scripts/       # pytest-based backend verification suite.
│
└── resmon_reports/                 # All user-facing outputs (REPORTS_DIR).
    ├── markdowns/                    # Per-execution Markdown reports.
    ├── pdfs/                         # Exported PDF reports.
    ├── latex/                        # Exported LaTeX reports.
    ├── figures/                      # Static figures embedded in reports.
    ├── logs/                         # Per-execution TaskLogger logs.
    └── info_docs/                    # 11 implementation-grounded info documents.
```

OS-scoped state (daemon lock file, the background service's logs) lives outside the repository, under `~/Library/Application Support/resmon` on macOS, `$XDG_STATE_HOME/resmon` on Linux, and `%LOCALAPPDATA%\resmon` on Windows (resolved by `daemon.state_dir()`). The background service's two logs there, `logs/resmon-daemon.out.log` and `logs/resmon-daemon.err.log`, are capped at 5 MB each with two older copies, and every line carries a time.

