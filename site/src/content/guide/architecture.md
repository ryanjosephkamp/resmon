---
title: "Architecture"
summary: "The engine, the window, the scheduler, how runs are admitted and recorded, and the source tree."
order: 16
---
resmon is a desktop application with three parts on your own computer: a Python engine, an Electron shell, and Atlas, the React interface the shell shows. The renderer talks to the engine over HTTP on loopback and to the shell through a checked window bridge.

## The engine

The engine is one FastAPI application, `resmon_scripts/resmon.py`, over a SQLite database. It owns the sources, the schedule, the reports, and every rule about what a result means. It binds to `127.0.0.1` and nothing else.

Binding to the loopback address is not a boundary on its own, because any web page you open can send a request to it. Requests need the engine's local API token in an `Authorization: Bearer` header, a loopback `Host`, and, when they carry an `Origin`, the exact origin of resmon's own renderer. The one token exception is a delivery bundle fetched through its signed link; the route checks that signature instead. Refusals are `401 token_missing`, `401 token_invalid`, `403 host_refused`, and `403 origin_refused`. There is no setting that turns the guard off. The token is minted at start and written to an owner-only file beside the engine's state, which is how the command line and the MCP server find it. See [`docs/local-api-security.md`](docs/local-api-security.md).

The engine has 244 routes and database schema 27, described by the generated contract in [`docs/api-contract/`](docs/api-contract/) and toured in the [HTTP API reference](/resmon/guide/api-reference/).

### A run

`SweepEngine` runs every search, whether you asked for it or a watch fired. It asks up to eight selected sources at once, normalizes what comes back into one record shape, removes exact duplicates, writes the report, summarizes if asked, and records the outcome. Find a paper checks each candidate against the requested identifier or title and links kept copies sharing a DOI. The separate link scan also finds records that look like the same work; neither merges them. Each source has its own client in `implementation_scripts/api_<slug>.py`, registered through `api_registry.py`, with a rate limiter shared by every instance of that client, so concurrent runs contend on one limiter. A client that is failed by its source logs and returns nothing instead of raising, so one source being down degrades a run and does not abort it. Each source's outcome, and the reason for a zero, is recorded at the point of the request.

One rule keeps that honest: a run in which every selected source was asked and none answered is recorded as failed, not as completed with nothing.

### Admission

`admission.py` is the one gate on concurrent runs. At most 3 go at once unless you change it (1 to 8 in **Settings › In the background**). A search you start when none is free, a Restart, a Run again, and a watch's run wait their turn in one queue of up to 16 (1 to 64), first come, first served, and each starts when a run finishes. When the queue is full, a search is refused with HTTP 429 and a `Retry-After: 5` header, and a watch's run is dropped and the watch runs at its next time.

Three more rules sit beside it. A watch claims its place before its worker starts, so a watch that runs longer than its period is never fired on top of itself; a scheduled fire refused that way is recorded as skipped. **Run now** on a watch that is already running is refused. A search carries a client-chosen `request_id`, and two requests with the same id are one submission, so a double click makes one run. And a run whose process went away is marked **interrupted**, with the reason, not left saying it is running or called failed.

### Progress

A run's events go through `progress.py`, an in-memory bus with one list per run. Atlas reads a run's events once a second while it runs. The engine also serves them as server-sent events at `GET /api/executions/{id}/progress/stream`. After a run ends, its events are saved to the database so its Progress tab can be rebuilt after a restart. Cancelling is cooperative: it sets a flag, the pipeline notices at its next checkpoint, flushes a partial report, and ends as cancelled.

## The scheduler

Watches are fired by `ResmonScheduler`, a wrapper over APScheduler with its job store in the database, so jobs survive restarts. A schedule is a five-field cron expression, in the computer's time.

**Only one process owns the scheduler: the background service.** The engine a window starts for itself runs with the scheduler off. A window attaches to a running service only when the service is the same version of resmon. So without the service, nothing fires a watch on schedule, and Atlas says so in several places. If a fire comes due while nothing is running, the engine reads the job store's persisted next time before the scheduler starts and records the missed fire. It claims only what it observed, that the fire was in the past when it looked, and runs nothing to catch up.

## The window

The shell is Electron's main process (`resmon_scripts/frontend/electron/`). It serves Atlas's static files from a loopback port chosen at each launch, starts or attaches to an engine, hands its port and token to the renderer, and owns the things only a desktop app can do: the menu, file and folder pickers, notifications, the `--service` mode, and updates on Windows and Linux. The engine writes the token when it starts; a shell starting its own engine supplies one.

Every window is the same renderer on the same engine, with the same port and token: the engine trusts one renderer origin, so the windows share one loopback server. Each window is its own document, so its page and its history are its own, and the main process answers each window's requests about that window alone: its downloads, its file pickers, and its run notifications. What stays one per engine is the engine's: the scheduler (in the service), the PDF reader, which reads one page at a time and is asked again when busy, and an assistant conversation, which runs one turn at a time whichever window sent it.

Atlas is React 19 and TypeScript built with Vite. Most HTTP calls use one typed client over types generated from the engine's OpenAPI schema; byte uploads, downloads, event streams, and the Evidence calls also use the authenticated transport directly. Server state is read with TanStack Query. Routes are hash routes, because the renderer is a set of static files and a path route would ask the server for a file that is not there on a reload. Because the origin includes a port that is new on every launch, browser storage starts empty each time, so Atlas keeps nothing there. A preference it must remember, such as the theme, accent, or top-bar arrangement, is an engine route. Unsent search and watch forms, and Back and Forward's places in the Runs tab and Library, stay in memory per history entry.

## What is stored and what is derived

The database holds the papers and the collections they are in, runs and their per-source outcomes, watches, schedules, saved searches, people and their matches, the reading queue, Library and Evidence records, assistant conversations, delivery records, and settings. Keys and passwords are not in it; they are in your operating system's keychain.

Some answers are derived from the papers and kept in files beside the database, and are deleted with the corpus because they hold words from it. They are never backed up, and are rebuilt:

- **The collection map** (`<db>-map.npz` for the default collection, `<db>-map-<id>.npz` for each other). A full fit of one collection's papers runs in a child process and is cached. The map reports whether it placed papers by embedding or by shared wording.
- **The shared-wording scan** (`<db>-wording.json`), recorded with the version of the method that made it.

Embeddings are stored as plain rows in a table any SQLite can read, with a `sqlite-vec` index over them that can be rebuilt.

## The command line and MCP

The `resmon` command and the MCP server are clients of the HTTP API. Neither opens the database, and neither starts an engine, because starting one is not a read: it applies a staged restore, migrates the schema, marks runs whose process is gone as interrupted, and drains the delivery queue. The command uses `RESMON_PORT` alone when set, otherwise the service's `daemon.lock`, then the port file. MCP tries `RESMON_PORT`, then the port file, and never the lock or a default port. Both read the token from `api-token-<port>` in the state directory. MCP contract 1.1 has 26 tools, 19 reads and seven writes; see [Ask and the MCP server](/resmon/guide/assistant/).

## Technology

| Part | Components |
|---|---|
| Engine | Python 3.10 or later (3.10, 3.11, and 3.12 are tested; builds bundle 3.11), FastAPI, Starlette, Uvicorn, Pydantic, httpx |
| Data | SQLite in WAL mode with one connection per thread, SQLAlchemy and APScheduler for the job store, `sqlite-vec` for similarity, NumPy for the collection map |
| Parsing | lxml, Beautiful Soup, pypdf for Evidence |
| Summaries and Ask | The `openai` and `anthropic` clients, httpx clients for the other providers, an Ollama client, tiktoken for chunking, and the `claude` and `codex` commands run as child processes |
| Secrets | `keyring` for the operating system's keychain |
| Shell | Electron 41, Node.js 22.13 or later |
| Interface | React 19, TypeScript, Vite, React Router (hash routes), TanStack Query and Virtual, `openapi-fetch`, PDF.js for drawing PDF pages, and KaTeX for math in Markdown and TeX files |
| Tests | pytest, Jest, Playwright |
| Packaging | electron-builder, with a relocatable CPython from python-build-standalone |

## The source tree

```
resmon/
├── README.md, CONTRIBUTING.md, LICENSE, requirements.txt, pytest.ini
├── docs/                        reference documents and the published site (built from site/)
├── site/                        the project site's source
├── resmon_reports/              figures; reports are written under it when running from source
└── resmon_scripts/
    ├── resmon.py                the FastAPI application
    ├── mcp_server.py            the MCP server
    ├── implementation_scripts/  the engine: sweep_engine, scheduler, admission, database, delivery,
    │                            backup, api_<slug>.py (one per source), repo_catalog, and the rest
    ├── cli/                     the resmon command line (standard library only)
    ├── service_units/           launchd, systemd, and Task Scheduler templates
    ├── verification_scripts/    the backend tests
    └── frontend/
        ├── atlas/               the interface: src/screens, src/shell, src/api, src/theme
        ├── electron/            the main process and preload
        ├── e2e/                 Playwright specs that launch the real app
        ├── journeys/            one test per user journey, through a driver
        └── scripts/             build and packaging scripts
```

An installed app keeps its data outside this tree, in the state directory for your platform. See [Install and launch](/resmon/guide/install/).
