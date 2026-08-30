# The resmon MCP tool surface — contract v1

**Status: frozen on merge.** Changing anything below takes its own pull request that says
what changed and why. Implementation is built against this document, not the other way
round.

This exists because two things consume the same surface: external harnesses (Claude Code,
Codex, anything else speaking MCP) from phase 1.8, and resmon's own embedded assistant in
phase 2.0. Built once, consumed twice — so the shape is settled before either is written.

---

## Architecture

The server is `resmon_scripts/mcp_server.py`, speaking **MCP over stdio**. It is a client
of the running resmon backend, reaching it over HTTP on `127.0.0.1`.

**It never opens the database directly.** Two reasons, both concrete:

1. The backend owns its connections, the scheduler, and admission control. A second
   process writing that SQLite file is the BUG-020 failure class over again — that bug
   cost a release to find, and the fix was one connection per thread inside a single
   process.
2. Going through the API means the tool surface cannot drift from what the app itself
   does. A behaviour change in an endpoint reaches MCP for free; a behaviour change that
   forgets MCP is impossible.

The cost is honest and accepted: **the backend must be running.** resmon is a desktop
application, so in practice it is — but see *When the backend is not running*.

### Port discovery

The same way the renderer does it, in order:

1. `RESMON_PORT` in the environment.
2. The port file the backend writes into its state directory on startup.
3. `8742`, the default.

Every candidate is confirmed with `GET /api/health` before use. This matters because a
user can run the packaged app and a dev build at once, on different ports.

### When the backend is not running

Every tool returns a single structured error:

```json
{"error": "backend_unavailable",
 "message": "resmon is not running. Start the resmon app and try again.",
 "tried": ["http://127.0.0.1:8742"]}
```

Never a stack trace, never a hang, never a silent empty result. A harness that gets an
empty paper list because the app is closed would report "you have no papers", which is a
lie the surface must not make possible.

---

## Safety

These are guarantees, not defaults, and the implementation is reviewed against them.

- **No credential values, ever.** No tool returns, accepts, or logs an API key. Where a
  credential is relevant, the tool names its **alias** (`anthropic_api_key`) and its
  presence (`present` / `absent` / `unreadable`) — the same three-state honesty the
  Repositories page already ships.
- **Nothing destructive in v1.** No delete, no erase, no factory reset, no credential
  writes. Those wait for a confirmation model worth trusting; a tool call is too cheap an
  action to hang data loss on. The excluded endpoints are listed at the end so the
  omission is visible rather than accidental.
- **Writes are limited to three tools**, each of which a user could trigger by hand in one
  click, and each of which is recorded in the execution history like any other run.
- **Token efficiency is a contract term, not an aspiration.** Every list tool paginates and
  defaults to a small page. No tool returns full report HTML or a whole corpus. A harness
  asking "what did my arXiv routine find this week" must not cost a five-hour usage
  window — the Master Plan sets this requirement for 2.0 and it starts here.

---

## Error model

Every tool returns either its documented success shape or:

```json
{"error": "<machine_code>", "message": "<human sentence>", "detail": {}}
```

Codes: `backend_unavailable` · `not_found` · `invalid_argument` · `conflict` ·
`upstream_error` · `internal_error`.

`message` is written for a person to read. It never contains a credential value, and it
never claims more than the backend actually reported.

---

## Tools

Every tool below is backed by an endpoint that exists today, except `run_routine`, which is
called out explicitly.

### Read

| Tool | Arguments | Returns | Backed by |
|---|---|---|---|
| `health` | — | version, schema version, scheduler state, daemon state | `GET /api/health` |
| `search_corpus` | `query`, `sources?`, `date_from?`, `date_to?`, `limit=25`, `offset=0` | matching papers: id, title, authors, date, source, doi, url | `POST /api/explorer/search` |
| `list_sources` | — | slug, name, coverage, whether a key is required and whether one is present | `GET /api/repositories/catalog` + `GET /api/credentials` |
| `list_routines` | `active_only?` | id, name, schedule, sources, keywords, last run, active | `GET /api/routines` |
| `get_routine` | `routine_id` | the full routine record | `GET /api/routines/{id}` |
| `list_executions` | `routine_id?`, `status?`, `limit=25`, `offset=0` | id, type, status, started, finished, result count | `GET /api/executions` |
| `get_execution` | `exec_id` | status, per-source counts, timings, AI lane used | `GET /api/executions/{id}` |
| `get_execution_results` | `exec_id`, `limit=25`, `offset=0` | the papers that run found | `GET /api/executions/{id}/report` |
| `get_search_record` | `exec_id` | the PRISMA-shaped reproducible record | `GET /api/executions/{id}/search-record` |
| `explain_match` | `doc_id` | which keywords matched, in which field, and what resmon cannot verify | `GET /api/documents/{doc_id}/why` |
| `get_paper_lifecycle` | `doc_id` | retraction, preprint→published, version changes, each with its notice link | `GET /api/documents/{doc_id}/lifecycle` |
| `get_analytics` | `view` (overview \| volume \| sources \| keywords \| routine-health \| discovery-lag), `window?` | the requested summary | `GET /api/analytics/*` |
| `get_watchdog_findings` | `include_muted?` | findings, each labelled `broken` or `unusual`, with what-to-do and the thresholds used | `GET /api/watchdog` |
| `export_references` | `exec_id` or `doc_ids`, `format` (bibtex \| ris \| csv \| json) | the exported text | `POST /api/export/references` |

`explain_match` and `get_watchdog_findings` carry resmon's refusals with them: the
watchdog's own list of what it cannot judge, and match transparency's statement that most
sources are relevance-ranked so a paper matching no keyword is expected rather than a
fault. **A harness must receive those caveats, not a cleaned-up answer** — stripping them
would make an honest product dishonest through an integration.

### Write

| Tool | Arguments | Returns | Backed by |
|---|---|---|---|
| `run_sweep` | `query`, `sources`, `date_from?`, `date_to?`, `max_results?`, `ai_enabled?` | `exec_id`, immediately | `POST /api/search/sweep` |
| `create_routine` | `name`, `keywords`, `sources`, `schedule`, plus optional notification and AI settings | the created routine | `POST /api/routines` |
| `run_routine` | `routine_id` | `exec_id`, immediately | **needs a new endpoint — see below** |

All three return as soon as the execution is admitted. Progress is polled with
`get_execution`; there is deliberately no streaming tool in v1, because a harness holding
an SSE stream open is a poor fit for a request/response tool surface and polling is honest
about what it costs.

`create_routine` creates the routine **inactive**. Scheduling something on a user's
machine is not a side effect a tool call should have; the user activates it in the app, or
a later contract version adds an explicit `activate_routine`.

---

## The one gap this contract found

**There is no way to run a routine on demand.** Routines are activated (scheduled) or
deactivated; running one now means rebuilding its configuration by hand as a sweep. The
scheduler fires them through `_dispatch_routine_fire(routine_id, parameters)`, which
prepares, admits, launches and stamps the execution — but nothing HTTP reaches it.

That is a gap in the application, not only in this surface: "run my arXiv routine now" is
something a person should be able to do from the interface too.

`run_routine` therefore requires **`POST /api/routines/{routine_id}/run`**, landing with
the MCP implementation. It is a thin wrapper over the same dispatcher the scheduler uses,
so a manual run and a scheduled fire take one code path and cannot diverge.

One deliberate behavioural difference: `_dispatch_routine_fire` returns early for an
inactive routine, because an inactive routine should not fire *on a schedule*. A manual
run is an explicit instruction, so **the endpoint runs an inactive routine** and says so in
its response. `is_active` governs scheduling, not permission.

---

## Excluded from v1, on purpose

Listed so the omissions are visible and arguable rather than silently missing.

| Excluded | Why |
|---|---|
| `/api/admin/*` — erase corpus, erase app data, factory reset, erase keys | Destructive and irreversible. No confirmation model a tool call can satisfy. |
| `PUT` / `DELETE /api/credentials/{name}` | Writing credentials through a tool surface means a credential passing through a harness. Never. |
| `PUT /api/settings/*` | Reconfiguring the app underneath a user is a 2.0 assistant concern, where there is a person in the conversation to confirm with. |
| `DELETE /api/routines/{id}`, `DELETE /api/executions/{id}` | Destructive. Same reasoning. |
| `/api/service/install`, `/api/service/uninstall` | Touches launchd / systemd on the user's machine. |
| `/api/cloud/*` | Google Drive linking is an OAuth flow that needs a browser and a person. |
| `/api/executions/{id}/progress/stream` | SSE does not fit a request/response tool surface. Poll `get_execution`. |
| `/api/lifecycle/check` | Long-running corpus-wide job. A tool call that runs for an hour is a trap; revisit with a job-handle model. |

---

## Versioning

This document is contract **v1**. The server reports it in its MCP initialisation
response. Additive changes — new tools, new optional arguments — bump the minor version and
do not require a new contract document. Removing a tool, renaming an argument, or changing
a return shape is a **breaking** change: new major version, new document, and the 2.0
assistant is updated in the same pull request, because it is the other consumer.
