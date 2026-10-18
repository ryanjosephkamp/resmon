---
title: "HTTP API reference"
summary: "The endpoint-by-endpoint tour of the local API. The generated, guarded contract for every route is in the reference section."
order: 10
readmeLines:
  - "907-1254"
---
## API Reference

**The machine-readable contract is [`docs/api-contract/`](docs/api-contract/).** `openapi.json` there describes every one of the 184 routes — method, path, parameters, request body — and `http.md` indexes them against the user journeys they serve, with each route's auth class, whether it streams, and a one-line purpose. Both are generated from the running app and a test fails when they drift, so they cannot describe a version of resmon that no longer exists. The prose below is the guided tour of the same surface; where the two differ, the contract is the one that was checked. No route declares a response model, so the contract describes what each route *accepts* and this section is where you find what it *answers with*.

All REST endpoints are served by the local FastAPI daemon (`resmon_scripts/resmon.py`) bound to `127.0.0.1:8742` by default. Every request needs the backend's local API token in `Authorization: Bearer <token>` and a loopback `Host`; refusals are `401 token_missing` / `401 token_invalid` / `403 host_refused` / `403 origin_refused` ([security model](docs/local-api-security.md)). Requests and responses are JSON unless noted; error responses use FastAPI's standard `{"detail": "..."}` envelope and the shared frontend API client (`api/client.ts`) unwraps it into a single readable message. The groups below are summarized from the Backend sections of the corresponding info docs under `resmon_reports/info_docs/`.

### `/api/health`

- `GET /api/health` — cheap readiness probe used by the Electron main process to decide when to open the renderer window. Returns process identity, the app version, and `embeddings: {extension, reason}` — whether *this* backend can load the vector extension, and why not when it cannot. The extension load is attempted per call rather than read from a cached probe, because a health endpoint answering from memory would keep reporting a capability the process had lost; measured at 0.076 ms per repeat load on one connection.

### `/api/search`

Manual execution dispatch. Each endpoint registers a new execution with the admission controller, starts the `SweepEngine` pipeline on a worker thread, and returns the assigned execution id.

- `POST /api/search/dive` — single-repository Deep Dive. Body carries `repository`, `keywords`, optional `date_range`, `max_results`, `ai_enabled`, per-execution `ai_overrides`, and an optional ephemeral API key.
- `POST /api/search/sweep` — multi-repository Deep Sweep. Body carries `repositories` (array of slugs), `keywords`, optional `date_range`, `max_results` (applied **per repository**), `ai_enabled`, per-execution `ai_overrides`, and a map of ephemeral per-repository keys. Returns HTTP `429` with `Retry-After: 5` when the admission controller has no free slot.
- `GET /api/search/repositories` — repository catalog surface consumed by the search pages to render the repository selector.

### `/api/routines`

CRUD, activation, and cancel control for scheduled Automated Deep Sweeps.

- `GET /api/routines` — list of local routines; used by the Routines and Calendar pages.
- `POST /api/routines` — create a local routine; the response includes the row's `id`, which is then stored as `linked_routine_id` inside the matching `routine` configuration row.
- `PUT /api/routines/{id}` — patch routine fields (including the inline Email / AI / Notify column toggles on the Routines page, which each patch a single flag).
- Both take an optional `intent` — the sentence the coverage audit compares the routine's results against, stored in `routines.intent`. It is never defaulted from the keywords: an intent copied from a query would make every routine claim its owner stated one. A field absent from the body leaves the stored value alone; an empty string clears it.
- `DELETE /api/routines/{id}` — delete a routine; also removes the APScheduler job.
- `POST /api/routines/{id}/activate` / `POST /api/routines/{id}/deactivate` — register or unregister the APScheduler job without deleting the DB row. Invoked from the Routines table and from the Calendar popover's routine toggle.
- `POST /api/routines/{id}/run` — run once, now, outside the schedule. It also marks that routine's `recorded` missed fires `ran_late`: a run was started after those fires came due, which is what happened, and not that each missed fire produced its own run. The **Run now** button beside the missed-fire line on the Routines page is this endpoint.
- `GET / POST /api/routines/{id}/delivery-targets` and `PUT / DELETE .../{target_id}` — the routine's delivery destinations. `channel` is one of the schema's four: `email`, `folder`, `webhook`, `feed`. A destination resmon can already tell will not work — a webhook that is not `https://` and not on the loopback, a feed with no folder — is refused at the route with that said. A target's channel cannot be edited, because the deliveries already recorded against it were attempted over it.
- `GET /api/deliveries/{id}/bundle?exp=&sig=` — the bundle a webhook envelope linked to. **The one route resmon serves without its local API token**, because a webhook receiver is not resmon and should not hold a credential that opens every route; it carries a per-destination HMAC over the delivery id and an expiry instead, and the Host and Origin checks still apply. A missing, wrong or expired signature gets the same 403 as a delivery that was never a webhook. See [docs/local-api-security.md](docs/local-api-security.md) and [docs/delivery.md](docs/delivery.md).
- `GET /api/routines/{id}/deliveries` and `GET /api/executions/{id}/deliveries` — the delivery record, either way round.
- `POST /api/deliveries/{id}/deliver` — release one that was waiting for review. The only promotion out of `awaiting_review` there is.
- `POST /api/deliveries/{id}/skip` — decide not to send one.
- `POST /api/deliveries/{id}/retry` — a failed or skipped delivery back into the queue with the attempt counter reset: the human overruling the backoff, which is a different decision from the backoff's own retry and so a different route.

### `/api/executions`

History, reporting, log and progress surfaces, export, delete, and cancel control for every execution (Deep Dive, Deep Sweep, Automated Deep Sweep).

- `GET /api/executions/{id}` — execution metadata row (type, status, query, counts, timestamps, routine id, etc.).
- `GET /api/executions/{id}/report` — rendered Markdown report.
- `GET /api/executions/{id}/log` — raw per-execution log text (written by `TaskLogger`).
- `GET /api/executions/{id}/progress/events` — historical progress event list. Returns the live `progress_store` events if the execution is still registered in memory and falls back to persisted events from the `execution_progress` table after cleanup.
- `GET /api/executions/{id}/progress/stream` — SSE progress stream (used by `ExecutionContext` and the Monitor page) with `~300 ms` heartbeats, `last_event_id` resumption, and a post-terminal drain.
- `GET /api/executions/active` — cheap `{active_ids: [...]}` payload polled every 3 seconds as a safety net that attaches background-initiated runs.
- `POST /api/executions/export` — body `{ "ids": [...] }`; the backend assembles a zip bundle of the selected executions' reports, logs, and artifacts and returns `{ "path": "<absolute path>" }`. When the Storage tab's `export_directory` is set, the zip lands there; otherwise a temp file is used.
- `POST /api/executions/{id}/cancel` — cooperative cancel: sets the `ProgressStore` cancel flag, the pipeline's 2-second heartbeat observes it, a partial report is flushed, and the execution finalizes as `cancelled`.
- `GET /api/executions/{id}/documents?limit=&offset=&only_new=` — one page of the papers the run stored, newest publication first, each carrying its corpus document `id` and its `queue_status` (`to_read`, `read`, or `null` when it is not saved). `limit` defaults to 50 and is capped at 200; an unknown execution is a 404 and an out-of-range `limit` or a negative `offset` is a 400. This is what the Papers tab reads — an execution id is not a paper id, and the report is prose.
- `DELETE /api/executions/{id}` — delete an execution row and its artifacts. Papers the run found stay in the corpus, and any reading-queue entries pointing at them stay too.

### `/api/configurations`

See [Configuration](#configuration) for the full round-trip workflow.

- `GET /api/configurations` — list all rows (optional `config_type` filter). `parameters` is JSON-decoded into a dict per row when possible, otherwise returned as the raw string.
- `POST /api/configurations` — create a configuration from a `ConfigCreate` body (`name`, `config_type`, `parameters`). Response: `{ "id", "name", "config_type" }`.
- `PUT /api/configurations/{id}` — update a configuration from a `ConfigUpdate` body (`name?`, `parameters?`); 404 if the id is unknown.
- `DELETE /api/configurations/{id}` — delete a configuration; cascades to the linked routine when `config_type == 'routine'` and the parameters carry a valid `linked_routine_id`.
- `POST /api/configurations/export` — body `{ "ids": [...] }`; writes a ZIP archive of per-config JSON files and returns `{ "path": "<absolute path>" }`.
- `POST /api/configurations/import` — accepts a multipart `files: list[UploadFile]` of `.json` files; response `{ "imported": <n>, "errors": [...] }`.

### `/api/analytics`

Read-only analysis of the locally stored corpus. Every endpoint reads the `documents`,
`execution_documents`, `executions`, and `routines` tables — no external requests are made,
so these work offline and consume no repository quota.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/analytics/overview` | All four sections plus the corpus summary, in one round trip. Used by the Analytics page. |
| GET | `/api/analytics/summary` | Corpus headline counts: papers, distinct papers after de-duplication, distinct authors, sources used, completed executions, DOI coverage. |
| GET | `/api/analytics/source-contribution` | Per source: total papers, papers unique to that source, and papers that also arrived elsewhere. Identity is DOI, falling back to a normalized title. |
| GET | `/api/analytics/discovery-lag` | Per source: median, fastest, and slowest days between `publication_date` and `first_seen_at`. |
| GET | `/api/analytics/routine-health` | Per routine: new results per run, consecutive runs with nothing new, and a `healthy` / `stale` / `insufficient_data` status. |
| GET | `/api/analytics/publication-volume` | Papers per publication month. `?group_by=source\|category` (default `source`), `?months=N` (default 12). |
| GET | `/api/analytics/keyword-contribution` | Per keyword: papers matched, papers **no other keyword** matched, and papers no keyword accounts for. `?execution_id=N` scopes to one run; omitted, it pools every keyword ever searched against the whole corpus. Reads every candidate document once, so it is cached and is not part of `/overview`. |

**Thin-corpus contract.** Every payload carries `sample_size`. Any derived statistic also
carries `sufficient`; when it is `false` the value is `null` and `insufficient_reason`
explains why. Counts are always reported — a percentage of an empty corpus is `null`, not
`0.0`, because a proportion of nothing is undefined rather than zero. The thresholds live
in `implementation_scripts/analytics.py` (`MIN_SAMPLE_FOR_LAG`, `MIN_RUNS_FOR_HEALTH`,
`STALE_RUN_THRESHOLD`) and are deliberately low: they exist to stop a single data point
being presented as a trend, not to withhold information from a small corpus.

### `/api/executions/{id}/search-record`

The complete, dated account of one search. Reads only what the run already recorded.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/executions/{id}/search-record` | JSON: search parameters, per-source identification counts, deduplication figures with their PRISMA mapping, and the caveats. |
| GET | `/api/executions/{id}/search-record?format=markdown` | The same as a `text/markdown` download, shaped for a methods section. |

**Why each figure carries a `prisma` field.**

| resmon figure | PRISMA 2020 box | Note |
|---|---|---|
| Per-source `records_identified` | Records identified from databases | Maps cleanly. |
| `cross_source_duplicates` | Duplicate records removed before screening | **resmon does not remove them.** It flags the overlap and keeps both rows. Reported as duplicates *found*. |
| `discarded_unusable` | Records marked as ineligible by automation tools | A data-quality discard (no title, no identifier) — not a relevance judgement. |
| `records_added` | Records screened | Records newly added to the corpus and therefore available for screening. |
| `already_held` | **none** | Records a repeating search re-encountered. PRISMA describes a single search; this has no box, and the record says so. |

`cross_source` was computed on every run since the beginning but never stored. Runs
predating schema 8 report it as `null` — *not recorded* — rather than `0`, because "we did
not measure this" and "there were none" are different claims and a methods section must not
make the second on the first's behalf. Schema 8 promotes all five deduplication figures out
of the progress-events blob into columns and backfills the four that history can supply.

### `/api/documents/{id}/why`

Match transparency for one paper. Reads only stored metadata; makes no external requests.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/documents/{id}/why` | Per keyword: whether it appears, and in which of title / abstract / categories / authors. Plus a `verdict`, a `headline`, the source's documented keyword semantics, and `what_resmon_cannot_see`. `?execution_id=N` scopes to one run's keywords; omitted, the union across every run that returned the paper is explained. |

**What it will not claim.** resmon cannot know why an upstream source returned a paper.
Most sources are relevance-ranked — they score documents against the whole
query and return the best matches, so a paper can legitimately come back containing none
of the terms literally. resmon also stores only title, abstract, authors and categories,
never full text, so a match may exist somewhere it cannot see. Both limits ship in
`what_resmon_cannot_see` on **every** response, including ones where every keyword matched:
a title match makes a paper *plausible*, which is not the same as knowing the upstream's
reasoning, and the difference matters to anyone defending a search strategy.

The `verdict` grades the explanation, never the paper:

| Verdict | Meaning |
|---|---|
| `resmon_filtered` | For bioRxiv and medRxiv, resmon filtered date-range API records locally instead of relying on an upstream result ranking. |
| `local_evidence` | At least one keyword is verifiably present. The paper is a plausible match. |
| `no_local_evidence` | Nothing matched in what resmon stores. Normal on a relevance-ranked source. |
| `no_keywords_recorded` | The run stored no keywords, so there is nothing to check against. |

Matching is word-boundary and case-insensitive, phrase-aware for quoted keywords, and
tolerant of terms that end in punctuation (`C++`, `cs.LG`). Keywords containing `AND` /
`OR` / `NOT` are **flagged, not parsed** — several upstreams forward operators verbatim,
and implementing a boolean engine whose semantics differed from the upstream's would be
another way of over-claiming.

### `/api/lifecycle`

What has happened to papers since resmon found them. The **only** part of resmon that
makes outbound requests without the user starting a search, which is why the check is
explicit rather than automatic.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/lifecycle` | Recorded events, severity counts, **coverage**, and the state of any running check. |
| POST | `/api/lifecycle/check` | Starts a bounded background check over the least recently checked papers. `{"limit": N}`, default 200. `409` if one is already running. |
| POST | `/api/lifecycle/for-documents` | Events for up to 500 document ids in one round trip — what the Explorer uses to badge a page of results. |
| GET | `/api/documents/{id}/lifecycle` | Events for one paper, plus whether it has ever been checked. |

**Never assert alone.** `record_lifecycle_finding` raises `MissingNoticeError` when a
finding arrives without a resolvable `notice_url`, so a lifecycle event that a reader
cannot open cannot be stored, let alone displayed. A false retraction flag is defamatory
and "we inferred it from the metadata" is not a defense. The upstream `label` is kept
verbatim — resmon does not translate "Correction" into "Retraction" or soften
"Retraction" into "Update", because the wording *is* the claim — and `provider_source`
records whether Crossref got the notice from Retraction Watch or from the publisher.

| Severity | Used for |
|---|---|
| `critical` | retraction, withdrawal, removal, partial retraction — the paper was withdrawn from the record |
| `caution` | expression of concern — explicitly **not** a retraction |
| `informational` | correction, erratum, new version, preprint reaching a journal |

An unrecognised Crossref update type is recorded as `informational` with its label intact,
never promoted to a retraction.

**Coverage is part of the answer.** The payload reports how many papers were checked, how
many carry no DOI or supported identifier and therefore *cannot* be checked, how many
errored, and how many remain — because an empty findings list over an unchecked corpus is
"nobody looked", not "nothing has been retracted", and the interface must be able to tell
the two apart. Papers whose Crossref batch failed are left unchecked rather than stamped
clean; a DOI Crossref simply has no record of is a real answer and *is* marked checked, so
one unknown DOI cannot stall the walk through the corpus. Papers are re-checked after 30
days.

**Batching.** DOIs go to Crossref forty at a time and arXiv ids fifty at a time, so a corpus
of fifteen thousand papers is a few hundred requests rather than fifteen thousand. The first
draft of this feature queried arXiv one paper per request with a per-run default of 200,
which meant covering a real corpus would have taken seventy-nine presses of a button —
bounded, but not usable. It was fixed before 1.7.0 shipped.

### `/api/watchdog`

Silent-failure detection over the same local data. Reads `execution_sources`, `executions`,
and `routines`; makes no external requests.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/watchdog` | `findings`, `counts`, `not_enough_data`, `watching`, and the `thresholds` used. |
| POST | `/api/watchdog/mute` | Acknowledge one finding by `finding_key`. It stays listed and stops counting. |
| POST | `/api/watchdog/unmute` | Return a finding to the alarm total. |

Each finding carries a stable `key`, a `severity` of `broken` / `unusual` / `advice`, the
`scope` it concerns, a `title`, a `detail`, a `what_to_do`, and the `evidence` behind it.

**The severity contract.** `broken` is only ever used for conditions resmon recorded
happening — never for an inference. `unusual` is a departure from a baseline the user's own
history established, and its payload always carries that baseline and its sample size.
`advice` is not an alarm and is excluded from `counts.alarms`. Thresholds live in
`implementation_scripts/watchdog.py` and are deliberately conservative: an alarm that is
wrong gets muted, and a muted watchdog misses the failure it was built for.

**Per-source execution record.** The `execution_sources` table stores what each source did
on each run — `ok`, `error`, `skipped_missing_key`, or `cancelled`, with the raw result
count and any error text. The sweep engine writes a row as each repository finishes.
Databases created before this table are backfilled once from the progress events already
stored on each execution, so the watchdog is useful on an existing install immediately
rather than after several more runs. Failing to write a health row never fails a sweep.

**Per-lane AI record.** The `execution_ai` table is the same idea for AI (schema 9). One
row per lane per execution records what was tried — provider, model, and the *alias* of the
credential slot used, never its value — alongside `docs_attempted` / `docs_succeeded` and,
on failure, a classified error kind. `ok`, `partial` and `failed` are held apart on purpose:
partial is a normal run with one awkward abstract, failed is a lane that did not work.

Before this table an AI failure was a line in the task log, which meant a run whose every
summary failed still completed and looked healthy. Failures are now classified as
**lane-fatal** (a rejected key, an exhausted quota, a model that does not exist — the lane
is finished for this run) or **document-local** (an abstract past the context window, content
the provider declined — this paper failed and the lane did not). That distinction is what
fallback chains will act on. As with the per-source record, failing to write an AI row never
fails a sweep.

### `/api/explorer`

Corpus-wide search. `POST` rather than `GET` because the filter set is a structure with
repeated values, not a flat query string.

| Method | Path | Returns |
|---|---|---|
| POST | `/api/explorer/search` | One page of matching papers plus `next_cursor`. Body: `query`, `sources[]`, `authors[]`, `categories[]`, `date_from`, `date_to`, `cursor`, `limit`, `sort` (`newest` \| `similarity`). With `similarity`, `query` is the **ranking phrase rather than a text filter** — the structured filters still apply and are unchanged by the sort, so the two sorts can return different sets. Carries `distance` per paper, `ranked_count`, `unranked_count` and `model`; reports the `sort` it actually served, and `similarity_unavailable` when it could not rank. `used_full_text_index` is always false in this mode, because the phrase never goes through FTS. |
| GET | `/api/documents/{id}/similar?k=` | The nearest papers to this one, with distances and sources, self excluded. Costs one index query and nothing at any embedding provider — the vector is already stored. An empty list carries `reason`. |
| GET | `/api/documents/{id}/links` | Records that look like the same work as this one, each with the `method` that found it (`shared_doi` or `vector+title`) and a rendered label. |
| POST | `/api/links/for-documents` | Links for a page of results in one round trip — what the Explorer uses to badge them. |
| POST | `/api/links/collapse-preview` | Which of these ids a collapse *would* fold. Returns a grouping; folds nothing. |
| GET/POST | `/api/links/status`, `/api/links/scan`, `/api/links/scan/cancel` | The corpus-wide scan: how many links are stored by method, start, and stop after the document in flight. ~4 minutes on 15,000 papers. |
| GET | `/api/routines/{id}/coverage` | The coverage audit: the two lists, the distribution the cutoff came from, and `cannot_see`. Each list is capped at 25 and carries its total (`off_target_total`, `missed_in_corpus_total`); the missed total comes from a bounded index query, so `missed_in_corpus_total_is_lower_bound` says when it is a floor rather than a count. |
| POST | `/api/explorer/facets` | Available filter values with counts, for the current filters. A facet excludes its own filter so alternatives stay selectable. |
| POST | `/api/explorer/export` | Everything matching the filters as `bibtex`, `ris`, `csv`, or `json` — not just the current page. |

### `/api/embeddings`

Configuring the embedding model and embedding the corpus. All eight endpoints are no-ops on
an install that has not set one up, which is the state every install starts in.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/settings/embeddings` | The stored settings, the resolved lane, the capability, the backfill status, and a **can-embed answer for every provider resmon lists** — including the ones that cannot, each with its reason and the live observation that reason rests on. |
| PUT | `/api/settings/embeddings` | Stores them. **Refuses a provider that cannot embed with HTTP 400 and the sentence**, at configuration rather than at backfill: a user who picks Anthropic learns it when they pick it, not after waiting for a run that was never going to produce anything. A model change rebuilds the index from the stored vectors. |
| POST | `/api/embeddings/probe` | Asks the configured — or a supplied, unsaved — lane to embed one short string, and reports the width it answered with. This is the only thing that turns a claim about a *provider* into a fact about *this* machine: a local server can list its models happily and still refuse to embed, because a chat model is not an embedding model, and the probe says exactly that. |
| GET | `/api/embeddings/status` | `N of M embedded with model X`, the running backfill, the index state, and the extension state — read from the database rather than from run counters, so the numbers are right after a restart. |
| GET | `/api/embeddings/estimate` | What a backfill would cost, computed from the documents that will actually be sent. A provider with no price on record reports `cost_usd: null`, never `0` — zero reads as free. |
| POST | `/api/embeddings/backfill` | Embeds every document lacking a vector for the active model, on a worker thread. Refused before it starts if the lane cannot embed. |
| POST | `/api/embeddings/backfill/cancel` | Stops after the batch in flight. Vectors already written are kept. |
| POST | `/api/embeddings/rebuild` | Rebuilds the vector index from the canonical table — the one action that fixes a database copied from a machine that could not load the extension. |

**Resume is a query, not a bookmark.** The work remaining is *rows lacking a vector for the
active model*, which is a fact about the database rather than about the last run, so it is
correct after a cancel, a crash, a model change and a corpus that grew in between. A stored
cursor would be wrong after any of those and would look right. The write is idempotent on
`(document_id, model)`, so a re-run costs a wasted call and never a duplicate row.

**Scale contract.** The design target is 100,000 papers, and three choices follow from it,
each measured rather than assumed:

- **Free text uses FTS5**, declared external-content so abstracts are not stored twice, with
  triggers keeping it in step. `LIKE '%term%'` has no usable prefix and reads every abstract.
  Where FTS5 is unavailable the query degrades to `LIKE` and `used_full_text_index` reports it.
- **Authors and categories are read from `document_authors` and `document_categories`**,
  indexed copies of the comma-joined strings on `documents`, which remains the source of truth.
- **Pagination is keyset, on the generated column `pub_sort`.** SQLite will not match a
  row-value comparison against an *expression* index, so the sort key is a real column. At row
  90,000 of 100,000: `SEARCH` in 0.30 ms, against 1.66 ms for `LIMIT/OFFSET` at the same depth.
  `pub_sort` is `COALESCE(publication_date, '')` — against a real `NULL` a row-value comparison
  yields `NULL`, which would silently drop every undated paper out of pagination.

Totals are capped at `COUNT_CAP` (10,000) and reported as `total_is_capped`; counting an
unbounded match set is the one query that cannot be bounded, and an exact five-digit number
changes no decision.

### `/api/reading-queue`

Membership over the corpus: which papers the user saved, and whether they have read them. Nothing here
deletes a paper.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/reading-queue?status=&limit=&offset=` | One page of saved papers, each with its membership row and the stored document. `status` is `to_read`, `read`, or `all` / omitted; `limit` defaults to 50 and is capped at 200. Carries `total` for the current filter and `counts` for all three. Order is `saved_at` then `document_id`, both descending, so a paper cannot appear on two pages. |
| POST | `/api/reading-queue` | Save `{"document_id": n}`. **Idempotent**: a paper already saved is returned unchanged, including its original `saved_at` and a `read` status it already had. 201 either way; 404 for a document the corpus does not hold. |
| PUT | `/api/reading-queue/{document_id}` | `{"status": "to_read" \| "read"}`. Sets `read_at` when a paper becomes read and clears it when it stops being read. A request that changes nothing writes nothing, so `updated_at` records state changes rather than requests. 404 when the paper is not in the queue; 400 for an unknown status. |
| DELETE | `/api/reading-queue/{document_id}` | Removes the membership row only. The document, its authors, its provenance and every run that found it are untouched. 404 when there was nothing to remove. |

The queue exports through the existing `POST /api/export/references` with `document_ids`; there is no
separate export route, and the formats and citation-key allocation are the ones documented below.

Erasing the corpus from **Settings → Advanced** deletes queue rows along with the papers, by
`ON DELETE CASCADE` — a saved paper that no longer exists would be an entry nobody could open.

### `/api/export`

| Method | Path | Returns |
|---|---|---|
| GET | `/api/executions/{id}/references` | The execution's papers as `?format=bibtex\|ris\|csv\|json`. JSON accepts `?include_ids=true` to add existing corpus document IDs. `?only_new=true` restricts to papers that were new at the time of the run. Responds with a `Content-Disposition` attachment header. |
| POST | `/api/export/references` | The same formats for `{"document_ids": [...], "format": "..."}` or `{"execution_ids": [...], "format": "..."}`. Execution selections union stored document IDs and render once; unknown executions fail with 404. Nonempty document IDs cannot be combined with execution IDs. |

### `/api/calendar`

- `GET /api/calendar/events?start=<iso>&end=<iso>` — combined payload of historical executions (from `get_executions(conn, limit=500)`) and expanded upcoming routine fires. `start` / `end` are parsed with `datetime.fromisoformat(...)` (trailing `Z` replaced with `+00:00`). Defaults clamp the window to `[now, now + 90 days]`; `window_start` is forced to `now` so past fires are never synthesized from cron. Each event carries `id`, `title`, `start`, `end`, `color`, `execution_id`, `routine_id`, `type`, `status`, `query`, `total_results`, `new_results`. Scheduled expansion is capped at `MAX_PER_ROUTINE = 200` fires per routine per request.

### `/api/settings`

Read/write surface for the eight Settings panels. Each slice is a keyed subset of the `settings` table, written through `set_setting`.

- `GET /api/settings/email` / `PUT /api/settings/email` — `smtp_server`, `smtp_port`, `smtp_username`, `smtp_from`, `smtp_to`.
- `POST /api/settings/email/test` — sends a test email using the saved SMTP settings and the stored `smtp_password` credential.
- `GET /api/settings/ai` / `PUT /api/settings/ai` — `ai_provider`, `ai_model`, `ai_local_model`, `ai_summary_length`, `ai_tone`, `ai_temperature`, `ai_extraction_goals`, `ai_custom_base_url`, `ai_custom_header_prefix`.
- `GET /api/settings/cloud` / `PUT /api/settings/cloud` — `cloud_auto_backup` and related toggles.
- `GET /api/settings/storage` / `PUT /api/settings/storage` — `pdf_policy`, `txt_policy`, `archive_after_days`, `export_directory` (policy values are constrained to `save` / `archive` / `discard`).
- `GET /api/settings/notifications` / `PUT /api/settings/notifications` — desktop-notification toggles.
- `GET /api/settings/execution` / `PUT /api/settings/execution` — admission-controller tunables (`max_concurrent` clamped to `[1, 8]`, routine queue clamped to `[1, 64]`); reloaded live by the admission controller.
- Diagnostics: `GET /api/scheduler/jobs` (APScheduler job snapshot consumed by Settings → Advanced), `POST /api/service/install` and related `/api/service/*` routes for OS-service integration via `service_manager.py`.

### `/api/credentials`

Presence-only surface over the OS keyring through `credential_manager.py`. Secrets are never returned; `GET` responses only report whether a named credential exists.

- `GET /api/credentials` — map of `{credential_name: present_boolean}`.
- `PUT /api/credentials/{name}` — store a credential (Email panel uses `smtp_password`; AI panel derives names from the provider, e.g. `openai_api_key`, `anthropic_api_key`, `custom_llm_api_key`).
- `DELETE /api/credentials/{name}` — remove a credential.
- `POST /api/credentials/validate` — validate a remote LLM key (Test key button on the AI panel).
- `POST /api/ai/models` — list the per-provider model catalog using either the freshly typed key or the stored credential (Load models button on the AI panel).

### `/api/cloud`

Google Drive backup — see [Google Drive Backup](#google-drive-backup).

- `GET /api/cloud/status` — `{ is_linked, api_ok, api_reason }` describing the Google Drive link state.
- `POST /api/cloud/link` — triggers the Google Drive OAuth installed-app flow; the resulting token is stored in the OS keyring.
- `POST /api/cloud/unlink` — removes the stored token.
- `POST /api/cloud/backup` — ad-hoc backup of the report tree to the linked Drive folder; returns `{ uploaded, total_files, folder_name, web_view_link }`.
