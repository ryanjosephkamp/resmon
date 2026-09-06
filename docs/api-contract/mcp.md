# The resmon MCP tool surface — contract v2

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
   does. A behavior change in an endpoint reaches MCP for free; a behavior change that
   forgets MCP is impossible.

The cost is honest and accepted: **the backend must be running.** resmon is a desktop
application, so in practice it is — but see *When the backend is not running*.

### Port discovery

The same way the renderer does it, in order:

1. `RESMON_PORT` in the environment.
2. The port file the backend writes into its state directory on startup.
3. `8742`, the default — **only when neither of the above named a port.**

Every candidate is confirmed with `GET /api/health` before use. This matters because a
user can run the packaged app and a dev build at once, on different ports.

**A named port is never widened to the default.** If step 1 or step 2 supplies a port and
that port does not answer, the answer is `backend_unavailable`. Implementing this found
why: when a named port had stopped answering, falling through to `8742` connected the
server to the **launchd daemon** — a different process, a different version, a different
database — and every tool then answered truthfully about the wrong corpus. A harness
asking "what did my routine find this week" would have reported another installation's
papers as the user's own. Failing is the correct outcome; the default exists only for a
backend old enough not to write a port file.

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
| `search_corpus` | `query`, `mode?` (keyword \| semantic), `sources?`, `date_from?`, `date_to?`, `limit=25`, `cursor?` | matching papers: id, title, authors, date, source, doi, url, plus `next_cursor`, `mode`, and in semantic mode `distance` per paper, `ranked_count`, `unranked_count`, `model` | `POST /api/explorer/search` |
| `find_similar` | `doc_id`, `limit=25` | the nearest papers with distances and sources; `reason` when the list is empty | `GET /api/documents/{doc_id}/similar` |
| `list_sources` | — | slug, name, coverage, whether a key is required and whether one is present | `GET /api/repositories/catalog` + `GET /api/credentials` |
| `list_routines` | `active_only?` | id, name, schedule, sources, keywords, last run, active | `GET /api/routines` |
| `get_routine` | `routine_id` | the full routine record | `GET /api/routines/{id}` |
| `list_executions` | `routine_id?`, `status?`, `limit=25`, `offset=0` | id, type, status, started, finished, result count | `GET /api/executions` |
| `get_execution` | `exec_id` | status, per-source counts, timings, AI lane used | `GET /api/executions/{id}` |
| `get_execution_results` | `exec_id`, `limit=25`, `offset=0` | the papers that run found | `GET /api/executions/{id}/references?format=json` |
| `get_search_record` | `exec_id` | the PRISMA-shaped reproducible record | `GET /api/executions/{id}/search-record` |
| `explain_match` | `doc_id` | which keywords matched, in which field, and what resmon cannot verify | `GET /api/documents/{doc_id}/why` |
| `get_paper_lifecycle` | `doc_id` | retraction, preprint→published, version changes, each with its notice link | `GET /api/documents/{doc_id}/lifecycle` |
| `get_analytics` | `view` (overview \| volume \| sources \| keywords \| routine-health \| discovery-lag), `window?` | the requested summary | `GET /api/analytics/{overview,publication-volume,source-contribution,keyword-contribution,routine-health,discovery-lag}` |
| `get_watchdog_findings` | `include_muted?` | findings, each labeled `broken` or `unusual`, with what-to-do and the thresholds used | `GET /api/watchdog` |
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
| `create_routine` | `name`, `keywords`, `sources`, `schedule`, optional `intent`, plus optional notification and AI settings | the created routine | `POST /api/routines` |
| `run_routine` | `routine_id` | `exec_id`, immediately | **needs a new endpoint — see below** |
| `activate_routine` | `routine_id` | `id`, `is_active: true` | `POST /api/routines/{id}/activate` |
| `deactivate_routine` | `routine_id` | `id`, `is_active: false` | `POST /api/routines/{id}/deactivate` |
| `update_settings` | `group`, `settings` | `group`, `changed` (a per-key `{from, to}` diff), `requested`, `unchanged_key_count` | `GET` + `PUT /api/settings/{group}` |

**Every write tool carries `requires_confirmation: true` in `tools/list`, and every
read tool carries it as `false`.** The field is resmon's own, not part of MCP. It is
emitted for both, because a harness that has to infer "no flag means safe" is one
release away from inferring it about a tool that grew teeth. `mcp_server.WRITE_TOOLS`
and `READ_TOOLS` are derived from the same table, and the embedded assistant builds
its pre-approved `--allowedTools` list from `READ_TOOLS` — one source, so the set the
model may call without asking cannot drift from the set this document calls safe.

The three sweep-and-run tools return as soon as the execution is admitted. Progress is polled with
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

One deliberate behavioral difference: `_dispatch_routine_fire` returns early for an
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
| ~~`PUT /api/settings/*`~~ | **Lifted in v2.0** as `update_settings`, on the condition this row named: a person in the conversation confirms it. Settings outside the group allowlist are still out of reach — see the v2.0 and v2.1 amendments. |
| `PUT /api/settings/execution` | Deliberately *not* in `update_settings`'s allowlist. Admission control — how many executions run at once, how deep the routine fire queue goes — is a decision about the machine rather than about the research, and the endpoint does not take `SettingsBody`. |
| `DELETE /api/routines/{id}`, `DELETE /api/executions/{id}` | Destructive. Same reasoning. |
| `/api/service/install`, `/api/service/uninstall` | Touches launchd / systemd on the user's machine. |
| `/api/cloud/*` | Google Drive linking is an OAuth flow that needs a browser and a person. |
| `/api/executions/{id}/progress/stream` | SSE does not fit a request/response tool surface. Poll `get_execution`. |
| `/api/lifecycle/check` | Long-running corpus-wide job. A tool call that runs for an hour is a trap; revisit with a job-handle model. |

---

## Amendments

### v2.1 — 6 September 2026, phase 2.0b

Additive: no tool arrives, none is removed, and no return shape moves.
`update_settings`'s group allowlist gains **`assistant`** — the group holding
`assistant_runtime`, `assistant_model` and `assistant_effort`.

**It is an amendment rather than a footnote because v2.0 shipped with that group
unreachable and undecided.** The group landed in `resmon.py` during 2.0a, after this
allowlist was frozen earlier in the same phase, so the app had a settings group that
was neither on the list nor deliberately excluded. The test written to force exactly
that decision — `test_no_settings_group_the_app_has_is_silently_reachable` — is
`live_network`, and nothing ran the live suite on a schedule. It was the first finding
of `.github/workflows/live-network.yml`, which now does, weekly.

Reachable rather than excluded, deliberately: *"use opus for the assistant"* is among
the likeliest things a person will ask the assistant itself; it is confirm-gated like
every other write; a runtime change takes effect on the next turn, because the runtime
is built per turn; and none of the three keys is credential-shaped, so the name guard
still stands unchanged.

**21 tools, 41 distinct method-and-path pairs** — the two new ones are the group's own
`GET` and `PUT`. All 41 resolve; `test_mcp_routes_resolve.py` checks it on every run.

### v2.0 — 6 September 2026, phase 2.0a

**Breaking, and the break is the confirmation model rather than a return shape.** No
tool was removed and no existing return shape moved; three tools arrive, and every
write tool now declares `requires_confirmation`. A caller that ignores that flag is
running writes this document says a person approves first, so callers are *not*
unaffected — which is the test the versioning rule below applies, and it is why this
is a major bump rather than v1.4.

| Change | Detail |
|---|---|
| `activate_routine` / `deactivate_routine` are new | v1 created routines inactive and said an explicit `activate_routine` was what a later version should add. Both are confirm-gated. Deactivating keeps the routine and everything it has found; it comes off its schedule. |
| `update_settings` is new | The `PUT /api/settings/*` exclusion is lifted on exactly the condition its own row stated. Four guards, all structural: the **group** is an allowlist (`ai`, `email`, `embeddings`, `cloud`, `storage`, `notifications`; `assistant` was added in v2.1); a **credential-shaped key** (`key`, `token`, `secret`, `password`, `passphrase`, `credential`, `auth`) is refused **on its name, before any request is built**, so the tool cannot be *asked* for a secret; the legal key list is read from `GET /api/settings/{group}` rather than copied here, and an unknown key is **refused rather than dropped** — the backend's PUT ignores keys outside the group, which is right for a form and a lie for a tool; and the answer is a **before/after diff**, not "success". |
| Every tool declares `requires_confirmation` | See the note under the Write table. |
| `create_routine` now returns the routine it created | `POST /api/routines` answers with `{id, name}`; this document promised "the created routine". The tool reads the record back over one localhost `GET`, so the claim is true and `is_active: 0` is a fact the caller can see rather than a sentence resmon asserts about itself. |

**No credential value crosses this surface in either direction**, and the guard is now
two-sided: v1's rule that no tool *returns* a key, and v2's rule that no tool can
*name* one. `test_the_credential_denylist_excludes_nothing_that_exists` asserts
against a real backend that no legitimate settings key matches a denied word, so the
denylist is a standing guard rather than a filter quietly doing nothing.

**The route re-check is now a test, not a promise.** v1.1, v1.2 and v1.3 each carry a
sentence saying every route was re-checked against the running app while the amendment
was written — and it was, each time, by a person. A check performed at freeze time has
to be performed again at the next freeze and can be quietly skipped, which is precisely
the failure v1.1 exists to record. `verification_scripts/test_mcp_routes_resolve.py`
drives every tool in `TOOLS` through a recording double and resolves every address it
sends against `resmon.app.routes`, one test case per pair, on every run.

`mcp_server.py`'s **21 tools** reach **39 distinct method-and-path pairs**, and all 39
resolve. The jump from v1.3's 25 is `update_settings`, which reads and writes each of
six groups. Two things were found by doing this rather than by trusting the document,
and both are recorded above: `POST /api/routines`'s thin response, and
`/api/settings/execution` — a settings route that is not a settings *group*, which the
allowlist test excludes by name and with a reason.

### v1.3 — 6 September 2026, phase 1.9b revision 2

Additive. `create_routine` gains one optional argument and no tool changed shape, so the
minor version moves and existing callers are unaffected — the rule this document's
*Versioning* section already states.

| Change | Detail |
|---|---|
| `create_routine` gains `intent` (optional) | The sentence the coverage audit compares a routine's results against, stored in `routines.intent`. **It is never defaulted from `keywords`.** A routine whose intent is its own keywords is being measured against itself, `get_routine` reports which of the two the audit used, and filling the column in at creation would erase that distinction at the one moment it can still be made honestly. Omitted when not given, rather than sent empty. |
| `get_routine`'s `coverage.off_target_count` and `coverage.missed_in_corpus_count` are **totals** | They were the length of the returned page. Both audit lists are capped at 25, so a routine with 312 off-target results reported `25` — a number resmon never measured, arriving at a harness as a precise fact. No field was added or removed; the value is corrected. |
| `coverage.missed_in_corpus_count_is_lower_bound` is new | The missed side is a bounded index query rather than a scan. When it comes back full with its furthest row still inside the reference distance, the total is a floor and this says so. "63" and "at least 63" are different facts. |

**Every route the server calls was re-checked against the app while this amendment was
written**, the v1.1 lesson applied for the third time — not only the two rows above.
`mcp_server.py`'s 18 tools reach **25 distinct method-and-path pairs**, and all 25 resolve
against `resmon.app.routes`, including the six analytics paths behind `get_analytics`'s
view names. No endpoint was added this release; the count stays at 106.

### v1.2 — 5 September 2026, phase 1.9a

Additive. `search_corpus` gains `mode`, and `find_similar` is new. No tool was removed and
no return shape moved, so the major version is unchanged and existing callers are
unaffected.

*Amended before release, 5 September 2026: the `mode="semantic"` row below described the
ranking as covering "the same filtered set". The field test showed what that costs and the
row is rewritten. v1.2 had not shipped, so this is an amendment to an unreleased contract
rather than a version bump — but it is recorded rather than quietly edited, because a
contract whose history can be rewritten is not one.*

| Change | Detail |
|---|---|
| `search_corpus` gains `mode` (`keyword` default, `semantic`) | Semantic mode ranks the corpus by distance from the query, **within the structured filters**. `sources`, `date_from` and `date_to` still narrow it and are untouched by the mode; `query` is the difference — a text filter in `keyword` mode, the thing distance is measured *from* in `semantic` mode. **The two modes can therefore return different sets**, and a harness that needs the keyword set asks for `keyword`. |
| Why that is not "the same filtered set" | It was, in the first draft of this amendment, and a field test on a real 15,707-paper corpus retired it before the contract shipped. The text filter is an `AND` over every word in the query, so a plain-English question matches no paper and a ranking restricted to it has nothing to order: **eleven of twenty natural queries returned an empty answer**, while the same vectors unfiltered found a relevant paper for almost all of them. A `semantic` mode that can only re-order a keyword match is not one. |
| The answer always reports the mode it **served** | Semantic mode can decline — no embedding model configured, the model refused, the extension will not load. When it does, the reply carries `mode: "keyword"` and a `mode_unavailable` sentence. A harness told it received a ranking it did not receive would report a relevance order that is a chronology; that is the overclaim this contract exists to prevent, arriving through an integration. |
| Semantic replies carry `ranked_count` and `unranked_count` | Papers with no vector are appended rather than dropped, so part of a semantic answer may be unordered. The counts say how much. |
| `find_similar` is new | One index query, no call to any embedding provider: the paper's vector is already stored. An empty list **always** carries a `reason`, because "this paper is not embedded", "nothing else is" and "this build cannot load the extension" are three different situations and a bare `[]` would let a harness report "resmon found nothing similar" for any of them. |

**Every route in the table above was re-checked against the running app while this
amendment was written**, not only the two being changed — that is the v1.1 lesson applied
rather than recorded. All 17 paths `mcp_server.py` calls resolve to a live route, including
the six analytics paths behind `get_analytics`'s view names.

### v1.1 — 31 August 2026, from implementing it

Three items in v1 named endpoints or arguments that do not exist as written. Found by
building against the document and checking every route rather than trusting it, which is
the same lesson the delegation briefs produced: pre-writing an API detail you have not
verified produces a confident error.

| Was | Now | Why |
|---|---|---|
| `get_execution_results` ← `GET /api/executions/{id}/report` | ← `GET /api/executions/{id}/references?format=json` | `/report` returns `{"report_text": ...}` — the entire rendered Markdown. Returning it would break this document's own token-efficiency guarantee, stated two sections above. |
| `search_corpus` takes `offset` | takes `cursor`, returns `next_cursor` | The corpus seeks on `(publication_date DESC, id DESC)` with an opaque cursor so the index descends rather than walks. Emulating an offset would re-walk every prior page per call. An explicit `offset` is refused rather than ignored. |
| `get_analytics` ← `/api/analytics/*` | ← the six real paths, named | Three view names do not match their route: `volume`, `sources` and `keywords` are served by `publication-volume`, `source-contribution` and `keyword-contribution`. The view names stay as the tool's vocabulary. |

Port discovery also gained an explicit rule — a named port is never widened to the default
— which is a clarification rather than a change of intent, and is recorded in that section
with the reason it was needed.

These are additive and clarifying rather than breaking: no tool was removed and no return
shape a caller depended on changed, because there were no callers yet. The contract stays
**v1**; this is its first amendment.

*(Superseded in numbering by v1.2 above, which formalises the minor-version scheme this
section describes. The three corrections here still stand.)*

---

## Versioning

This document is contract **v2.1**. The server reports it in its MCP initialisation
response (`mcp_server.CONTRACT_VERSION`). Additive changes — new tools, new optional arguments — bump the minor version and
do not require a new contract document. Removing a tool, renaming an argument, or changing
a return shape is a **breaking** change: new major version, new document, and the 2.0
assistant is updated in the same pull request, because it is the other consumer.
