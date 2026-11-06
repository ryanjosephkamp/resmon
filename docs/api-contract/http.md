# The HTTP surface, by journey

**Generated. Do not edit by hand.** `implementation_scripts/api_contract.py` writes this file from the running FastAPI application; `verification_scripts/test_api_contract.py` regenerates it and fails on any difference. Regenerate with `python -m implementation_scripts.api_contract --write`.

244 routes, over 49 register rows: 44 rows are carried by at least one route and 5 are not. Every route appears in at least one table — the guard fails when one does not.

## How to read a row

**Auth.** `token` means the request must carry `Authorization: Bearer <this backend's token>`, a loopback `Host` on this backend's own port, and — when it is a browser request, which is to say when it carries an `Origin` — this app's renderer origin. The MCP server and Electron's main process send no `Origin` and are judged on the token alone. `signed link` means the guard lets the request past the token check and the route checks a per-destination HMAC instead. The full model, including what it does not defend, is [local-api-security.md](../local-api-security.md); the classes here are computed from `api_auth.AUTH_EXEMPT_PATHS` and `api_auth.AUTH_SIGNED_PATHS` rather than transcribed from that page.

**SSE.** `yes` means the handler answers with `text/event-stream`. The response is a sequence of events, not a JSON body, and a client that reads it with an ordinary fetch-and-parse will hang.

**Purpose.** The first line of the endpoint's docstring, for the 155 of 244 routes that have one. The remaining 89 show FastAPI's generated summary instead, *in italics*: it is the function's own name with the underscores taken out, and it is here because an invented sentence would read like documentation without being any.

**Response.** The `response_model` the route declares, for the 206 of 244 routes that declare one — `openapi.json` carries its schema under that name, and a typed client can be generated from it. The remaining 38 show `—`: they declare no model, so `openapi.json` describes their 200 body as the empty schema `{}` and what they answer with is described in prose in [README.md](../../README.md) and in the five feature contracts beside this file. Nothing here guesses at a response shape.

A declared model is a **lower bound** on the body, not an exact description. Every one of them is an `additionalProperties: true` schema, because FastAPI filters a response against its model and a key nobody declared would otherwise be dropped from the reply silently; `implementation_scripts/response_models.py` sets that out in full and `verification_scripts/test_response_models.py` holds every model to it by comparing each route's body with what its handler returned on the same request. So a client may rely on a declared field being there, and may not rely on there being nothing else.

What survives is the **key**. An undeclared value is re-serialized by pydantic rather than by FastAPI's `jsonable_encoder`, and the two disagree for three types: a `Decimal` becomes a string rather than a float, a `PurePath` raises instead of serializing (the concrete `Path` beside it is fine, which is the trap), and `inf`/`nan` become a quiet `null` where an unmodeled route answered 500. None is reachable in the routes modeled today; the table and the test that keeps it true are in `response_models.py`, and anyone modeling a further route should read it first.

## J01 — Deep Dive

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/executions/{exec_id}/progress/events` | token | — | — | The run's progress events, from the `since`-th on (0, every one). |
| `GET` | `/api/executions/{exec_id}/progress/stream` | token | yes | — | *Stream Progress* |
| `POST` | `/api/search/dive` | token | — | `RunStarted` | Start a Deep Dive, or queue it when resmon runs as many as it allows (202). |
| `GET` | `/api/search/repositories` | token | — | `list` | *Search Repositories* |

## J02 — Deep Sweep

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/executions/{exec_id}/find` | token | — | `FindResult` | A find's question and what each source it named said: found or not, how it matched, what differs, its open copy. |
| `GET` | `/api/executions/{exec_id}/progress/events` | token | — | — | The run's progress events, from the `since`-th on (0, every one). |
| `GET` | `/api/executions/{exec_id}/progress/stream` | token | yes | — | *Stream Progress* |
| `POST` | `/api/find` | token | — | `RunStarted` | Find a paper across the sources that can look it up: a run, or queued like one (202). |
| `GET` | `/api/find/plan` | token | — | `FindPlan` | What a typed query reads as (a DOI, an arXiv id, a PMID, or a title), and which sources it would ask. |
| `GET` | `/api/search/repositories` | token | — | `list` | *Search Repositories* |
| `POST` | `/api/search/sweep` | token | — | `RunStarted` | Start a Deep Sweep, or queue it when resmon runs as many as it allows (202). |

## J03 — Routines

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/executions/{exec_id}/full-text` | token | — | `RunFullText` | Every PDF a run asked for (a watch with its opt-in on), and what came of each. |
| `GET` | `/api/routines` | token | — | `list` | *List Routines* |
| `POST` | `/api/routines` | token | — | `RoutineCreated` | *Create Routine* |
| `DELETE` | `/api/routines/{routine_id}` | token | — | — | *Delete Routine Endpoint* |
| `GET` | `/api/routines/{routine_id}` | token | — | `Routine` | Fetch a single routine by ID. |
| `PUT` | `/api/routines/{routine_id}` | token | — | `RoutineUpdated` | *Update Routine Endpoint* |
| `POST` | `/api/routines/{routine_id}/activate` | token | — | `RoutineActivation` | *Activate Routine* |
| `POST` | `/api/routines/{routine_id}/deactivate` | token | — | `RoutineActivation` | *Deactivate Routine* |
| `GET` | `/api/routines/{routine_id}/documents` | token | — | `RoutineDocuments` | The papers this routine's runs collected that a collection holds: a watch's constellation on its map. |
| `POST` | `/api/routines/{routine_id}/run` | token | — | `RoutineRunStarted` | Run a routine immediately, outside its schedule. |
| `GET` | `/api/scheduler/jobs` | token | — | — | *Get Scheduler Jobs* |
| `GET` | `/api/scheduler/status` | token | — | `SchedulerStatus` | Whether this database's active routines will fire, and what decides it. |

## J04 — Background daemon

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/scheduler/status` | token | — | `SchedulerStatus` | Whether this database's active routines will fire, and what decides it. |
| `GET` | `/api/service/daemon-status` | token | — | `DaemonStatus` | Return ground-truth daemon status read from `daemon.lock`. |
| `POST` | `/api/service/install` | token | — | `ServiceInstalled` | Render the platform unit template and write it to the install path. |
| `GET` | `/api/service/status` | token | — | `ServiceStatus` | Return whether the daemon unit file is installed and its path, and on macOS what launchd holds. |
| `POST` | `/api/service/uninstall` | token | — | `ServiceUninstalled` | Remove the unit file; optionally deregister with the OS first, keeping the file if that fails. |

## J05 — Analytics

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/analytics/discovery-lag` | token | — | `DiscoveryLag` | Median days between publication and resmon first seeing each paper. |
| `GET` | `/api/analytics/keyword-contribution` | token | — | `KeywordContribution` | Per keyword: papers it found that no other keyword did. |
| `GET` | `/api/analytics/overview` | token | — | `AnalyticsOverview` | Everything the Analytics page needs about one collection, in one round trip. |
| `GET` | `/api/analytics/publication-volume` | token | — | `PublicationVolume` | Papers per publication month, split by source or subject category. |
| `GET` | `/api/analytics/routine-health` | token | — | `RoutineHealth` | Per routine whose papers land in the collection: new results per run, and whether it has gone quiet. |
| `GET` | `/api/analytics/source-contribution` | token | — | `SourceContribution` | Per source: papers delivered, and how many nothing else found. |
| `GET` | `/api/analytics/summary` | token | — | `CorpusSummary` | *Analytics Summary* |

## J06 — Watchdog

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/documents/{doc_id}/lifecycle` | token | — | — | Lifecycle events recorded against one paper. |
| `GET` | `/api/lifecycle` | token | — | `LifecycleReport` | Recorded lifecycle events, and how much of the corpus they cover. |
| `POST` | `/api/lifecycle/check` | token | — | `LifecycleCheckStarted` | Start a bounded lifecycle check over the least recently checked papers. |
| `POST` | `/api/lifecycle/for-documents` | token | — | `LifecycleForDocuments` | Lifecycle events for a page of results, in one round trip. |
| `POST` | `/api/lifecycle/stop` | token | — | `LifecycleStopAnswer` | Ask a running check to stop before its next request. |
| `GET` | `/api/profiles/{profile_id}/lifecycle` | token | — | `WatchProfileLifecycle` | Retractions and other lifecycle findings on this profile's papers. |
| `GET` | `/api/watchdog` | token | — | `WatchdogReport` | Findings, what could not be judged yet, and the thresholds used. |
| `POST` | `/api/watchdog/mute` | token | — | `WatchdogMuteAck` | Acknowledge one finding so it stops counting toward the alarm total. |
| `POST` | `/api/watchdog/unmute` | token | — | `WatchdogMuteAck` | Un-acknowledge a finding, returning it to the alarm total. |

## J07 — Watch profiles

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/profiles` | token | — | `WatchProfileList` | *List Watch Profiles* |
| `POST` | `/api/profiles` | token | — | `WatchProfile` | *Create Watch Profile* |
| `POST` | `/api/profiles/import` | token | — | `WatchProfileImportResult` | Import one or more exported profiles. |
| `POST` | `/api/profiles/matches/for-documents` | token | — | `WatchProfileMatchesByDocument` | Which watch profiles matched a page of papers, and on what basis. |
| `GET` | `/api/profiles/starter` | token | — | `StarterWatchProfileList` | The curated set that ships with the app, not yet anybody's profile. |
| `DELETE` | `/api/profiles/{profile_id}` | token | — | `WatchProfileDeleted` | Remove a profile and its matches. **The corpus is untouched.** |
| `GET` | `/api/profiles/{profile_id}` | token | — | `WatchProfile` | *Get Watch Profile* |
| `PUT` | `/api/profiles/{profile_id}` | token | — | `WatchProfile` | *Update Watch Profile* |
| `GET` | `/api/profiles/{profile_id}/export` | token | — | `WatchProfileExport` | *Export Watch Profile* |
| `GET` | `/api/profiles/{profile_id}/lifecycle` | token | — | `WatchProfileLifecycle` | Retractions and other lifecycle findings on this profile's papers. |
| `GET` | `/api/profiles/{profile_id}/matches` | token | — | `WatchProfileMatchPage` | Papers of a collection matched to this profile, **each with the basis it was matched on**. |

## J08 — Author identity and entity search

No route of its own. The capability is in the normaliser, the catalog's `entity_search` syntax and `api_base.search_entity`; it reaches a user through the routes of J01, J02 and J07.

## J09 — Semantic search

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/documents/{document_id}/similar` | token | — | — | The papers nearest this one, with distances and their sources. |
| `POST` | `/api/embeddings/backfill` | token | — | — | Embed every document lacking a vector for the active model. |
| `POST` | `/api/embeddings/backfill/cancel` | token | — | — | Stop after the batch in flight. Vectors already written are kept. |
| `GET` | `/api/embeddings/estimate` | token | — | — | What a backfill would cost, before it starts. |
| `POST` | `/api/embeddings/probe` | token | — | — | Ask the configured (or supplied) lane to embed one short string. |
| `POST` | `/api/embeddings/rebuild` | token | — | — | Rebuild the vector index from the canonical table. |
| `GET` | `/api/embeddings/status` | token | — | `EmbeddingStatus` | N of M embedded with model X, the run, the index, and the extension. |
| `POST` | `/api/explorer/search` | token | — | `ExplorerPage` | Search the whole corpus. POST because the filter set is a structure. |
| `GET` | `/api/settings/embeddings` | token | — | `EmbeddingSettingsPage` | The stored settings, plus everything the tab needs to render honestly. |
| `PUT` | `/api/settings/embeddings` | token | — | `EmbeddingSettingsSaved` | Store the settings, refusing a provider that cannot embed. |

## J10 — Near-duplicate links

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/documents/{document_id}/links` | token | — | — | What else in the corpus looks like the same work as this paper. |
| `POST` | `/api/links/collapse-preview` | token | — | `CollapsePreview` | Which of these ids a collapse *would* fold, without folding anything. |
| `POST` | `/api/links/for-documents` | token | — | `PaperLinks` | Links for a page of results in one round trip. |
| `POST` | `/api/links/scan` | token | — | — | Find near-duplicates across the corpus. Returns immediately. |
| `POST` | `/api/links/scan/cancel` | token | — | — | Stop after the document in flight. Links already written are kept. |
| `GET` | `/api/links/status` | token | — | — | How many links are stored, by method, and the scan's state. |

## J11 — Coverage audit

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/routines/{routine_id}/coverage` | token | — | `RoutineCoverage` | Is this routine finding what its owner meant, and what is it missing? |

## J12 — Explorer

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/collections` | token | — | `CollectionList` | Every collection, the one the app shows, and the default one. |
| `POST` | `/api/collections` | token | — | `CollectionSummary` | Make an empty collection. Names are unique without regard to case. |
| `PUT` | `/api/collections/current` | token | — | `CollectionCurrent` | Remember the collection the app shows, by its id or its name. |
| `DELETE` | `/api/collections/{collection_id}` | token | — | `CollectionDeleted` | Delete a collection, never its papers. |
| `GET` | `/api/collections/{collection_id}` | token | — | `CollectionDetail` | One collection, and what deleting it would do to its papers and watches. |
| `PUT` | `/api/collections/{collection_id}` | token | — | `CollectionSummary` | *Rename Collection* |
| `POST` | `/api/collections/{collection_id}/papers` | token | — | `CollectionPapersChanged` | Move or copy papers into this collection. No paper leaves the database. |
| `POST` | `/api/collections/{collection_id}/papers/undo` | token | — | `CollectionPapersUndone` | Undo a move or a copy into this collection, from what it answered. |
| `GET` | `/api/documents/{doc_id}` | token | — | `Paper` | One paper as stored, and where it stands in the reading queue. |
| `GET` | `/api/documents/{doc_id}/why` | token | — | `PaperWhy` | What is locally verifiable about why this paper is in the corpus. |
| `POST` | `/api/explorer/export` | token | — | — | Export everything matching the current filters, not just the page shown. |
| `POST` | `/api/explorer/facets` | token | — | — | Available filter values and their counts, for the current filters. |
| `POST` | `/api/explorer/search` | token | — | `ExplorerPage` | Search the whole corpus. POST because the filter set is a structure. |

## J13 — The assistant (CLI lane)

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/ai/cli/sign-in` | token | — | `AiCliSignIn` | Ask the command itself whether it is signed in. No model call, no cost. |
| `POST` | `/api/ai/cli/sign-in` | token | — | `AiCliSignInOpened` | Start the command's own login in a terminal, or say the command to run. |
| `GET` | `/api/ai/last-answered` | token | — | `AiLastAnswered` | Which model last answered each requested alias, from answers already kept. |
| `POST` | `/api/assistant/permissions` | token | — | `AssistantPermissionDecision` | Ask the person, and hold this request open until they answer. |
| `POST` | `/api/assistant/permissions/{request_id}` | token | — | `AssistantPermissionAnswered` | The panel's Allow / Deny. |
| `GET` | `/api/assistant/sessions` | token | — | `AssistantSessions` | *List Assistant Sessions* |
| `POST` | `/api/assistant/sessions` | token | — | `AssistantSession` | *Create Assistant Session* |
| `GET` | `/api/assistant/sessions/{session_id}` | token | — | `AssistantTranscript` | *Get Assistant Session* |
| `POST` | `/api/assistant/sessions/{session_id}/cancel` | token | — | `AssistantTurnCancelled` | Stop the running turn. Idempotent, and it says which happened. |
| `POST` | `/api/assistant/sessions/{session_id}/messages` | token | yes | — | *Send Assistant Message* |
| `GET` | `/api/assistant/status` | token | — | `AssistantStatus` | Whether the assistant can run, and if not, the reason in one sentence. |
| `GET` | `/api/settings/ai/cli-status` | token | — | `AiCliStatus` | Report whether each subscription-lane CLI can be found, and where. |
| `GET` | `/api/settings/assistant` | token | — | `AssistantSettings` | *Get Assistant Settings* |
| `PUT` | `/api/settings/assistant` | token | — | `SettingsSaved` | *Update Assistant Settings* |

## J14 — The assistant on a key

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/ai/models` | token | — | — | Return the list of model IDs the BYOK credential can access. |
| `GET` | `/api/assistant/status` | token | — | `AssistantStatus` | Whether the assistant can run, and if not, the reason in one sentence. |

## J15 — First-run card

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/onboarding` | token | — | `OnboardingState` | What the first-run card renders, as facts rather than as prose. |
| `POST` | `/api/onboarding/dismiss` | token | — | `OnboardingDismissed` | Put the card away for good. |

## J16 — Weekly live-network job

No route. A GitHub Actions workflow over `verification_scripts/live_suite.py` and `live_quarantine.json`.

## J17 — AI summarization lanes

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/ai/cli/sign-in` | token | — | `AiCliSignIn` | Ask the command itself whether it is signed in. No model call, no cost. |
| `POST` | `/api/ai/cli/sign-in` | token | — | `AiCliSignInOpened` | Start the command's own login in a terminal, or say the command to run. |
| `GET` | `/api/ai/last-answered` | token | — | `AiLastAnswered` | Which model last answered each requested alias, from answers already kept. |
| `POST` | `/api/ai/models` | token | — | — | Return the list of model IDs the BYOK credential can access. |
| `GET` | `/api/settings/ai` | token | — | `AiSettings` | *Get Ai Settings* |
| `PUT` | `/api/settings/ai` | token | — | `SettingsSaved` | *Update Ai Settings* |

## J18 — Reports and exports

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/executions` | token | — | `list` | The runs, newest first, a page at a time; how many match is the `X-Resmon-Total` header. |
| `POST` | `/api/executions/archive` | token | — | — | The same archive `POST /api/executions/export` writes, as bytes. |
| `POST` | `/api/executions/export` | token | — | — | Bundle the reports and logs for the selected executions into a .zip. |
| `DELETE` | `/api/executions/{exec_id}` | token | — | — | Delete a run's record; its report and log files stay where they were written. |
| `GET` | `/api/executions/{exec_id}` | token | — | `Run` | *Get Execution* |
| `GET` | `/api/executions/{exec_id}/bundle` | token | — | — | One run's bundle as bytes: the archive `POST /api/executions/export` writes. |
| `GET` | `/api/executions/{exec_id}/documents` | token | — | `RunPapersPage` | One page of the papers this run found, each with its stored id. |
| `GET` | `/api/executions/{exec_id}/log` | token | — | `RunLog` | *Get Execution Log* |
| `GET` | `/api/executions/{exec_id}/references` | token | — | — | Export one run; JSON can explicitly include corpus IDs for follow-up reads. |
| `GET` | `/api/executions/{exec_id}/report` | token | — | `RunReport` | *Get Execution Report* |
| `GET` | `/api/executions/{exec_id}/search-record` | token | — | — | The complete, dated account of one search. |
| `POST` | `/api/export/references` | token | — | — | Render one selection, with one entry per stored document ID. |

## J19 — Live monitoring

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/executions/active` | token | — | `ActiveRuns` | The runs this engine is running, each with its search and its events, and the queue. |
| `POST` | `/api/executions/seen` | token | — | `RunsSeen` | The run monitor's panel was opened: every run that has failed until now is seen. |
| `DELETE` | `/api/executions/waiting/{ticket}` | token | — | `WaitingWithdrawn` | Take a run that waits for a free slot out of the queue, before it starts. |
| `POST` | `/api/executions/{exec_id}/cancel` | token | — | `RunCancelRequested` | Request cooperative cancellation of a running execution. |
| `GET` | `/api/executions/{exec_id}/progress/events` | token | — | — | The run's progress events, from the `since`-th on (0, every one). |
| `GET` | `/api/executions/{exec_id}/progress/stream` | token | yes | — | *Stream Progress* |

## J20 — Calendar

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/calendar/events` | token | — | `list` | *Calendar Events* |

## J21 — Saved configurations

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/configurations` | token | — | `list` | *List Configurations* |
| `POST` | `/api/configurations` | token | — | `ConfigurationCreated` | *Create Configuration* |
| `POST` | `/api/configurations/archive` | token | — | — | The same archive `POST /api/configurations/export` writes, as bytes. |
| `POST` | `/api/configurations/export` | token | — | `ConfigurationExport` | *Export Configurations* |
| `POST` | `/api/configurations/import` | token | — | `ConfigurationImportResult` | *Import Configurations* |
| `DELETE` | `/api/configurations/{config_id}` | token | — | `ConfigurationDeleted` | *Delete Configuration Endpoint* |
| `PUT` | `/api/configurations/{config_id}` | token | — | `ConfigurationUpdated` | *Update Configuration Endpoint* |

## J22 — Repositories and keys

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/credentials` | token | — | `CredentialsPresence` | Return per-credential status for every known credential name. |
| `POST` | `/api/credentials/validate` | token | — | — | Test a key against its provider: one typed here, or the AI key already stored. |
| `DELETE` | `/api/credentials/{key_name}` | token | — | `CredentialChanged` | *Delete Credential Endpoint* |
| `PUT` | `/api/credentials/{key_name}` | token | — | `CredentialChanged` | *Store Credential Endpoint* |
| `GET` | `/api/repositories/catalog` | token | — | `list` | Return the static repository catalog (never returns secrets). |
| `GET` | `/api/search/repositories` | token | — | `list` | *Search Repositories* |
| `GET` | `/api/settings/sources` | token | — | `SourceSettings` | The contact address resmon gives Crossref and OpenAlex, and the sources it goes to. |
| `PUT` | `/api/settings/sources` | token | — | `SourceSettings` | Set the contact address, or clear it with null or an empty string, after which nothing is sent. |

## J23 — Notifications and email

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/settings/email` | token | — | `EmailSettings` | *Get Email Settings* |
| `PUT` | `/api/settings/email` | token | — | `SettingsSaved` | *Update Email Settings* |
| `POST` | `/api/settings/email/test` | token | — | `TestEmailSent` | Send a test email using the currently-stored SMTP settings. |
| `GET` | `/api/settings/notifications` | token | — | `NotificationSettings` | *Get Notification Settings* |
| `PUT` | `/api/settings/notifications` | token | — | `SettingsSaved` | *Update Notification Settings* |

## J24 — Google Drive backup

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/backup` | token | — | `BackupWritten` | Write one bundle: the snapshotted database, the vault's bytes, optionally reports. |
| `POST` | `/api/backup/drive-upload-notice/acknowledge` | token | — | `DriveUploadNoticeAcknowledged` | Dismiss the notice that the upload to Google Drive is gone, by deleting the settings it is read from. |
| `GET` | `/api/backup/last` | token | — | `BackupLast` | The last bundle, the last restore outcome, the undo copies, and the copy kept before the last upgrade. |
| `GET` | `/api/settings/storage` | token | — | `StorageSettings` | *Get Storage Settings* |
| `PUT` | `/api/settings/storage` | token | — | `SettingsSaved` | *Update Storage Settings* |

## J25 — In-app documentation

No route. The tutorials and every `PageHelp` entry are renderer assets, shipped inside the app rather than fetched.

## J26 — Danger Zone

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/admin/erase-ai-keys` | token | — | `AiKeysErased` | *Admin Erase Ai Keys* |
| `POST` | `/api/admin/erase-app-data` | token | — | `AppDataErased` | Erase the corpus + configs + executions + every API key. |
| `POST` | `/api/admin/erase-configs` | token | — | `ConfigurationsErased` | *Admin Erase Configs* |
| `POST` | `/api/admin/erase-corpus` | token | — | `CorpusErased` | Erase every collected paper. Executions, configs and keys are kept. |
| `POST` | `/api/admin/erase-execution-data` | token | — | `ExecutionDataErased` | Erase all configs + all executions. Settings and API keys untouched. |
| `POST` | `/api/admin/erase-executions` | token | — | `ExecutionsErased` | *Admin Erase Executions* |
| `POST` | `/api/admin/erase-repo-keys` | token | — | `RepositoryKeysErased` | *Admin Erase Repo Keys* |
| `POST` | `/api/admin/factory-reset` | token | — | `FactoryReset` | Erase every secret, config, execution, setting, and collected paper. |
| `POST` | `/api/admin/reset-settings` | token | — | `SettingsReset` | Reset every setting plus erase every API key. Configs/executions kept. |

## J27 — Citation graph

No route. Recorded in the register as not carried forward.

## J28 — Reading queue

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/reading-queue` | token | — | `ReadingQueuePage` | One page of a collection's saved papers. `status` omitted (or `all`) means both. |
| `POST` | `/api/reading-queue` | token | — | `ReadingQueueEntry` | Save a stored paper. Saving one already saved returns it unchanged. |
| `POST` | `/api/reading-queue/batch` | token | — | `ReadingQueueBatchSaved` | Save many papers at once: each one not in the queue is added, each one in it is left as it is. |
| `POST` | `/api/reading-queue/batch/all` | token | — | `ReadingQueueBatchSaved` | Save every paper of a search, a run, or Today, read by the engine rather than listed. |
| `POST` | `/api/reading-queue/batch/undo` | token | — | `ReadingQueueBatchUndone` | Undo a save of many: the entries it added go, unless they changed since. |
| `DELETE` | `/api/reading-queue/{document_id}` | token | — | `ReadingQueueRemoval` | Take a paper out of the queue. The paper itself is not touched. |
| `PUT` | `/api/reading-queue/{document_id}` | token | — | `ReadingQueueEntry` | Mark a saved paper read or unread. |
| `POST` | `/api/reading-queue/{document_id}/restore` | token | — | `ReadingQueueRestored` | Undo a removal: the entry back with the state and dates it had. |

## J29 — Recorded-source coverage

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/coverage/source-wall` | token | — | `SourceWall` | Every source's recorded answer to each of the last `limit` runs. |
| `GET` | `/api/executions/{exec_id}` | token | — | `Run` | *Get Execution* |
| `GET` | `/api/executions/{exec_id}/find` | token | — | `FindResult` | A find's question and what each source it named said: found or not, how it matched, what differs, its open copy. |
| `GET` | `/api/executions/{exec_id}/search-record` | token | — | — | The complete, dated account of one search. |

## J30 — Runtime identity

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/health` | token | — | `Health` | Liveness endpoint. Returns process identity so clients can attach-or-spawn. |
| `POST` | `/api/renderer/heartbeat` | token | — | `RendererHeartbeat` | Renderer-presence ping. |

## J31 — Readable Ask

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/assistant/sessions/{session_id}/messages` | token | yes | — | *Send Assistant Message* |

## J32 — Chats and export

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/assistant/sessions` | token | — | `AssistantSessions` | *List Assistant Sessions* |
| `GET` | `/api/assistant/sessions/browse` | token | — | `AssistantSessionPage` | *Browse Assistant Sessions* |
| `DELETE` | `/api/assistant/sessions/{session_id}` | token | — | `AssistantSessionDeleted` | *Delete Assistant Session* |
| `GET` | `/api/assistant/sessions/{session_id}` | token | — | `AssistantTranscript` | *Get Assistant Session* |
| `GET` | `/api/assistant/sessions/{session_id}/export` | token | — | `AssistantExport` | *Export Assistant Session* |

## J33 — Composer choices

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/assistant/sessions/{session_id}/messages` | token | yes | — | *Send Assistant Message* |

## J34 — Owned Library

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/documents/{doc_id}/full-text` | token | — | `FullTextRequest` | Get the PDF: ask for this paper's open-access PDF into the Library. |
| `GET` | `/api/executions/{exec_id}/full-text` | token | — | `RunFullText` | Every PDF a run asked for (a watch with its opt-in on), and what came of each. |
| `POST` | `/api/full-text/for-documents` | token | — | `list` | For each paper: its open copies, the one resmon would get or why none, its latest request, its Library PDF. |
| `GET` | `/api/full-text/rules` | token | — | `FullTextRules` | The limits on downloads, the license rule, and the sources and sites never downloaded from. |
| `GET` | `/api/library` | token | — | `LibraryStatus` | *Library Status* |
| `GET` | `/api/library/export` | token | — | `LibraryInventory` | *Library Inventory* |
| `GET` | `/api/library/files` | token | — | `LibraryFiles` | *Library List* |
| `POST` | `/api/library/files` | token | — | `LibraryImported` | *Library Import* |
| `DELETE` | `/api/library/files/{file_id}` | token | — | `LibraryRemoved` | Take a file out of the Library. Its bytes are held in the Library folder's |
| `GET` | `/api/library/files/{file_id}` | token | — | `LibraryFileDetail` | *Library Detail* |
| `POST` | `/api/library/files/{file_id}/open` | token | — | `LibraryOpened` | *Library Open* |
| `POST` | `/api/library/files/{file_id}/paper-links` | token | — | `LibraryLinked` | *Library Link* |
| `GET` | `/api/library/files/{file_id}/pdf` | token | — | — | A kept PDF's bytes, for the reader outside Evidence: verified, up to the one read limit. |
| `GET` | `/api/library/files/{file_id}/picture` | token | — | — | The first-page picture kept for this exact version, or 404 `no_picture`. |
| `PUT` | `/api/library/files/{file_id}/picture` | token | — | `LibraryPicture` | Keep the first-page picture the renderer drew of this version: WebP, PNG or JPEG, 512 KiB at most. |
| `GET` | `/api/library/files/{file_id}/removal` | token | — | `LibraryRemoval` | What would go with this file if it were removed: its paper links, and the projects |
| `GET` | `/api/library/files/{file_id}/shared-wording` | token | — | `SharedWordingLibrary` | The last comparison of this file since the engine started, or that there is none. |
| `POST` | `/api/library/files/{file_id}/shared-wording` | token | — | `SharedWordingLibrary` | Compare this file, page by page, with the abstracts and the other Library files. |
| `GET` | `/api/library/files/{file_id}/text` | token | — | `LibraryText` | *Library Read Text* |
| `GET` | `/api/library/removed` | token | — | `LibraryRemovedList` | Every removed file still on record, newest first, and whether its bytes are still held. |
| `DELETE` | `/api/library/removed/{file_id}` | token | — | `LibraryForgotten` | Drop a removed file's record once its bytes have left the Library folder; refused while they are held. |
| `POST` | `/api/library/removed/{file_id}/release` | token | — | `LibraryReleased` | The held file's verified path, under the name it was imported as, for the desktop's Trash. |
| `POST` | `/api/library/removed/{file_id}/restore` | token | — | `LibraryFileDetail` | Undo a removal: the folder, the row and every row that went with it, as they were. |
| `POST` | `/api/library/vault` | token | — | `LibraryStatus` | *Library Create Vault* |
| `POST` | `/api/library/vault/move` | token | — | `LibraryMovedStatus` | Move the Library folder into another folder, keeping its name. Across disks the |
| `POST` | `/api/library/vault/relink` | token | — | `LibraryStatus` | Record where the Library folder is now, after checking it is this Library's own. |

## J35 — Evidence workspace

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/evidence/projects` | token | — | `EvidenceProjects` | *Evidence Projects* |
| `POST` | `/api/evidence/projects` | token | — | `EvidenceProjectDetail` | *Evidence Create Project* |
| `GET` | `/api/evidence/projects/{project_id}` | token | — | `EvidenceProjectDetail` | *Evidence Project Detail* |
| `PATCH` | `/api/evidence/projects/{project_id}` | token | — | `EvidenceProjectDetail` | *Evidence Rename Project* |
| `POST` | `/api/evidence/projects/{project_id}/bundle` | token | — | — | *Evidence Bundle* |
| `GET` | `/api/evidence/projects/{project_id}/files` | token | — | `EvidenceMembers` | *Evidence Files* |
| `POST` | `/api/evidence/projects/{project_id}/files` | token | — | `EvidenceMemberAdded` | *Evidence Add File* |
| `DELETE` | `/api/evidence/projects/{project_id}/files/{file_id}` | token | — | `EvidenceMemberRemoved` | *Evidence Remove File* |
| `GET` | `/api/evidence/projects/{project_id}/notes` | token | — | `EvidenceNotes` | *Evidence Notes* |
| `POST` | `/api/evidence/projects/{project_id}/notes` | token | — | `EvidenceNoteSaved` | *Evidence Create Note* |
| `PATCH` | `/api/evidence/projects/{project_id}/notes/{note_id}` | token | — | `EvidenceNoteSaved` | *Evidence Edit Note* |
| `GET` | `/api/evidence/projects/{project_id}/reader/{file_id}` | token | — | `EvidencePageText` | *Evidence Read* |

## J36 — Selected-evidence answers

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/evidence/projects/{project_id}/answer-previews` | token | — | `SelectedPreview` | *Selected Answer Preview* |
| `GET` | `/api/evidence/projects/{project_id}/answers` | token | — | `SelectedAnswers` | *Selected Answer History* |
| `POST` | `/api/evidence/projects/{project_id}/answers` | token | — | `SelectedAnswer` | *Selected Answer Send* |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}` | token | — | `SelectedAnswer` | *Selected Answer Detail* |
| `POST` | `/api/evidence/projects/{project_id}/answers/{answer_id}/cancel` | token | — | `SelectedAnswer` | *Selected Answer Cancel* |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}/events` | token | yes | — | *Selected Answer Events* |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}/export` | token | — | — | *Selected Answer Export* |

## J37 — Portable saved-answer HTML

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}/export` | token | — | — | *Selected Answer Export* |

## J38 — Interrupted runs and Restart

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/executions/{exec_id}` | token | — | `Run` | *Get Execution* |
| `POST` | `/api/executions/{exec_id}/restart` | token | — | `RunRestarted` | Start a fresh execution with the source's parameters, linked back to it. |
| `POST` | `/api/renderer/heartbeat` | token | — | `RendererHeartbeat` | Renderer-presence ping. |

## J39 — One run per routine, one per submission, missed fires

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/find` | token | — | `RunStarted` | Find a paper across the sources that can look it up: a run, or queued like one (202). |
| `GET` | `/api/routines/{routine_id}` | token | — | `Routine` | Fetch a single routine by ID. |
| `POST` | `/api/routines/{routine_id}/run` | token | — | `RoutineRunStarted` | Run a routine immediately, outside its schedule. |
| `POST` | `/api/search/dive` | token | — | `RunStarted` | Start a Deep Dive, or queue it when resmon runs as many as it allows (202). |
| `POST` | `/api/search/sweep` | token | — | `RunStarted` | Start a Deep Sweep, or queue it when resmon runs as many as it allows (202). |
| `GET` | `/api/settings/execution` | token | — | `ExecutionSettings` | *Get Execution Settings* |
| `PUT` | `/api/settings/execution` | token | — | `ExecutionSettingsSaved` | *Update Execution Settings* |

## J40 — Delivery: where a report goes, and whether it got there

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/deliveries/{delivery_id}/bundle` | signed link | — | — | The report bundle a webhook envelope linked to, for whoever holds the link. |
| `POST` | `/api/deliveries/{delivery_id}/deliver` | token | — | `DeliveryActed` | Release a delivery that was waiting for review. The only promotion. |
| `POST` | `/api/deliveries/{delivery_id}/retry` | token | — | `DeliveryActed` | Start the attempt sequence again, after the backoff has given up. |
| `POST` | `/api/deliveries/{delivery_id}/skip` | token | — | `DeliveryActed` | *Skip Delivery* |
| `GET` | `/api/executions/{exec_id}/deliveries` | token | — | — | *List Execution Deliveries* |
| `GET` | `/api/routines/{routine_id}/deliveries` | token | — | `RoutineDeliveries` | *List Routine Deliveries* |
| `GET` | `/api/routines/{routine_id}/delivery-targets` | token | — | `DeliveryTargets` | *List Routine Delivery Targets* |
| `POST` | `/api/routines/{routine_id}/delivery-targets` | token | — | `DeliveryTargetAdded` | *Add Routine Delivery Target* |
| `DELETE` | `/api/routines/{routine_id}/delivery-targets/{target_id}` | token | — | — | *Delete Routine Delivery Target* |
| `PUT` | `/api/routines/{routine_id}/delivery-targets/{target_id}` | token | — | — | *Update Routine Delivery Target* |

## J41 — Backup and restore

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/backup` | token | — | `BackupWritten` | Write one bundle: the snapshotted database, the vault's bytes, optionally reports. |
| `GET` | `/api/backup/last` | token | — | `BackupLast` | The last bundle, the last restore outcome, the undo copies, and the copy kept before the last upgrade. |
| `POST` | `/api/backup/verify` | token | — | `BundleReport` | Recompute every hash and report what a restore would and would not do. |
| `POST` | `/api/restore` | token | — | `RestoreStaged` | Verify a bundle and stage it. The restore itself happens on the next start. |
| `POST` | `/api/restore/acknowledge` | token | — | `RestoreAcknowledged` | Dismiss the one-time "what a restore did not bring back" card. |
| `POST` | `/api/restore/cancel` | token | — | `RestoreCancelled` | Forget a staged restore. Nothing had been moved yet, so nothing is undone. |
| `POST` | `/api/restore/undo-copy/delete` | token | — | `RestoreUndoCopiesDeleted` | Delete the database copies a restore set aside. Irreversible, so confirm-gated. |
| `GET` | `/api/settings/storage` | token | — | `StorageSettings` | *Get Storage Settings* |
| `PUT` | `/api/settings/storage` | token | — | `SettingsSaved` | *Update Storage Settings* |

## J42 — Local API locked to this app

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/auth/renderer-origin` | token | — | — | Allow one more exact renderer origin on this backend. |
| `GET` | `/api/deliveries/{delivery_id}/bundle` | signed link | — | — | The report bundle a webhook envelope linked to, for whoever holds the link. |

The guard is in front of all 244 routes, not only the two listed here: `AUTH_EXEMPT_PATHS` is an explicitly empty constant and a test fails if it grows. The two rows above are the routes that are *about* the guard — the one that registers a renderer origin (and refuses to do so for a request carrying an `Origin`, because a browser must not be able to widen the allowlist), and the one route that proves itself with a signature instead of the token.

## J43 — Upgrade in place

No route. Migrations run inside `database.init_db` at start; the journey is exercised by `test_cumulative_upgrade.py` against the committed upgrade fixtures.

## J44 — Driving resmon from an external harness (MCP)

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/analytics/discovery-lag` | token | — | `DiscoveryLag` | Median days between publication and resmon first seeing each paper. |
| `GET` | `/api/analytics/keyword-contribution` | token | — | `KeywordContribution` | Per keyword: papers it found that no other keyword did. |
| `GET` | `/api/analytics/overview` | token | — | `AnalyticsOverview` | Everything the Analytics page needs about one collection, in one round trip. |
| `GET` | `/api/analytics/publication-volume` | token | — | `PublicationVolume` | Papers per publication month, split by source or subject category. |
| `GET` | `/api/analytics/routine-health` | token | — | `RoutineHealth` | Per routine whose papers land in the collection: new results per run, and whether it has gone quiet. |
| `GET` | `/api/analytics/source-contribution` | token | — | `SourceContribution` | Per source: papers delivered, and how many nothing else found. |
| `GET` | `/api/collections` | token | — | `CollectionList` | Every collection, the one the app shows, and the default one. |
| `GET` | `/api/credentials` | token | — | `CredentialsPresence` | Return per-credential status for every known credential name. |
| `GET` | `/api/documents/{doc_id}/lifecycle` | token | — | — | Lifecycle events recorded against one paper. |
| `GET` | `/api/documents/{doc_id}/why` | token | — | `PaperWhy` | What is locally verifiable about why this paper is in the corpus. |
| `GET` | `/api/documents/{document_id}/similar` | token | — | — | The papers nearest this one, with distances and their sources. |
| `GET` | `/api/executions` | token | — | `list` | The runs, newest first, a page at a time; how many match is the `X-Resmon-Total` header. |
| `GET` | `/api/executions/{exec_id}` | token | — | `Run` | *Get Execution* |
| `GET` | `/api/executions/{exec_id}/references` | token | — | — | Export one run; JSON can explicitly include corpus IDs for follow-up reads. |
| `GET` | `/api/executions/{exec_id}/search-record` | token | — | — | The complete, dated account of one search. |
| `POST` | `/api/explorer/search` | token | — | `ExplorerPage` | Search the whole corpus. POST because the filter set is a structure. |
| `POST` | `/api/export/references` | token | — | — | Render one selection, with one entry per stored document ID. |
| `GET` | `/api/health` | token | — | `Health` | Liveness endpoint. Returns process identity so clients can attach-or-spawn. |
| `GET` | `/api/profiles` | token | — | `WatchProfileList` | *List Watch Profiles* |
| `POST` | `/api/profiles` | token | — | `WatchProfile` | *Create Watch Profile* |
| `GET` | `/api/profiles/{profile_id}` | token | — | `WatchProfile` | *Get Watch Profile* |
| `GET` | `/api/profiles/{profile_id}/matches` | token | — | `WatchProfileMatchPage` | Papers of a collection matched to this profile, **each with the basis it was matched on**. |
| `GET` | `/api/repositories/catalog` | token | — | `list` | Return the static repository catalog (never returns secrets). |
| `GET` | `/api/routines` | token | — | `list` | *List Routines* |
| `POST` | `/api/routines` | token | — | `RoutineCreated` | *Create Routine* |
| `GET` | `/api/routines/{routine_id}` | token | — | `Routine` | Fetch a single routine by ID. |
| `POST` | `/api/routines/{routine_id}/activate` | token | — | `RoutineActivation` | *Activate Routine* |
| `GET` | `/api/routines/{routine_id}/coverage` | token | — | `RoutineCoverage` | Is this routine finding what its owner meant, and what is it missing? |
| `POST` | `/api/routines/{routine_id}/deactivate` | token | — | `RoutineActivation` | *Deactivate Routine* |
| `GET` | `/api/routines/{routine_id}/deliveries` | token | — | `RoutineDeliveries` | *List Routine Deliveries* |
| `POST` | `/api/routines/{routine_id}/run` | token | — | `RoutineRunStarted` | Run a routine immediately, outside its schedule. |
| `POST` | `/api/search/sweep` | token | — | `RunStarted` | Start a Deep Sweep, or queue it when resmon runs as many as it allows (202). |
| `GET` | `/api/watchdog` | token | — | `WatchdogReport` | Findings, what could not be judged yet, and the thresholds used. |

Read out of `resmon_scripts/mcp_server.py` rather than transcribed: `api_contract.mcp_driven_routes()` parses every `backend.request(method, path)` call in that module — method included, so a path the harness only reads does not appear here as a path it also deletes — and matches each against the route table.

Calls in `mcp_server.py` that resolve to no single route, and so are not in the table above: `GET /api/settings/{}`, `PUT /api/settings/{}`. The settings path is built from a tool argument and reaches the `GET`/`PUT /api/settings/*` routes; it is named here rather than dropped, because a table that quietly omits what it could not read is worse than one that says so.

## J45 — Source wall: what every source did on recent runs

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/coverage/source-wall` | token | — | `SourceWall` | Every source's recorded answer to each of the last `limit` runs. |

## J46 — Appearance: theme and accent

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/appearance` | token | — | `Appearance` | *Get Appearance* |
| `PUT` | `/api/appearance` | token | — | `Appearance` | *Update Appearance* |
| `GET` | `/api/top-bar` | token | — | `TopBar` | The top bar's sections in order, the hidden ones, the start page, and where the resmon name goes. |
| `PUT` | `/api/top-bar` | token | — | `TopBar` | Store the whole arrangement, and answer it as it was stored. |

## J47 — Collection map: where every paper sits

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/documents/briefs` | token | — | `list` | A line about each paper asked for, for the plate's hover: title, authors, |
| `GET` | `/api/executions/{exec_id}/document-ids` | token | — | `RunDocumentIds` | Every paper this run stored that is in the collection, by id. |
| `GET` | `/api/map` | token | — | `CollectionMap` | Where every paper of a collection sits on the Atlas plate, and on what basis. |
| `GET` | `/api/map/facets` | token | — | `MapFacets` | What the map's filters and colors read about every paper of a collection: |
| `GET` | `/api/map/find` | token | — | `MapFind` | The papers of a collection whose title or authors contain `q`, newest |
| `GET` | `/api/map/views/{name}` | token | — | `MapView` | The filters and colors a map was last left with, and how the list |
| `PUT` | `/api/map/views/{name}` | token | — | `MapView` | *Put Map View* |

## J48 — Today: the papers since you last looked

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `PUT` | `/api/collections/current` | token | — | `CollectionCurrent` | Remember the collection the app shows, by its id or its name. |
| `POST` | `/api/documents/briefs` | token | — | `list` | A line about each paper asked for, for the plate's hover: title, authors, |
| `GET` | `/api/today` | token | — | `Today` | The papers runs put in a collection since its Today was last looked at, by watch. |
| `POST` | `/api/today/looked` | token | — | `TodayLooked` | Record that a collection's Today was looked at now: its next window starts here. |
| `GET` | `/api/today/papers` | token | — | `TodayPapersPage` | The next page of a collection's new papers on Today, after the page before it. |

## J49 — Shared wording across papers

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/library/files/{file_id}/shared-wording` | token | — | `SharedWordingLibrary` | The last comparison of this file since the engine started, or that there is none. |
| `POST` | `/api/library/files/{file_id}/shared-wording` | token | — | `SharedWordingLibrary` | Compare this file, page by page, with the abstracts and the other Library files. |
| `GET` | `/api/shared-wording` | token | — | `SharedWording` | The last scan, the scan in progress, and the pairs it found by group. |
| `GET` | `/api/shared-wording/pairs/{a}/{b}` | token | — | `SharedWordingPair` | Two abstracts side by side, the passages they share, and the numbers. |
| `GET` | `/api/shared-wording/papers/{document_id}` | token | — | `SharedWordingForPaper` | The pairs one paper is in, for its page. |
| `POST` | `/api/shared-wording/scan` | token | — | `SharedWordingJob` | Compare every abstract with every other, in the background. Returns at once. |
| `POST` | `/api/shared-wording/scan/cancel` | token | — | `SharedWordingCancel` | Stop the scan in progress. The answer stored before it is kept. |

## Closed vocabularies

Every list below is generated from the object named beside it and tested equal to it. A value added to the code and not to this file, or to this file and not to the code, is a failing test.

**Execution status** — from the `executions.status` CHECK in `database._EXECUTIONS_V19_DDL`. 5 values:

`running` · `completed` · `failed` · `cancelled` · `interrupted`

**Interrupted reason** — from `database.INTERRUPTED_REASONS`. 3 values:

`owner_dead` · `daemon_restart` · `unknown`

**Zero reason** — from `zero_reason.ZERO_REASONS`. 11 values:

`missing_key` · `retired` · `window_unanswerable` · `upstream_failure` · `parse_failure` · `rights_filtered` · `records_unusable` · `entity_unsupported` · `answered_in_part` · `answered_empty` · `not_recorded`

**Zero reasons that mean the source did not answer** — from `zero_reason.DID_NOT_ANSWER`. 6 values:

`entity_unsupported` · `missing_key` · `parse_failure` · `retired` · `upstream_failure` · `window_unanswerable`

**Delivery state** — from `database.DELIVERY_STATES`. 6 values:

`queued` · `awaiting_review` · `delivering` · `delivered` · `failed` · `skipped`

**Delivery channel** — from `database.DELIVERY_CHANNELS`. 4 values:

`email` · `folder` · `webhook` · `feed`

**Delivery channels with an adapter behind them** — from `delivery.SHIPPED_CHANNELS`. 4 values:

`email` · `folder` · `webhook` · `feed`

**Delivery target mode** — from `database.DELIVERY_TARGET_MODES`. 2 values:

`automatic` · `review`

**Guard refusal** — from the `_refusal(...)` calls in `api_auth.check`. 4 values:

`401 token_invalid` · `401 token_missing` · `403 host_refused` · `403 origin_refused`

`NULL` is a fourth value `interrupted_reason` may hold, and means the row was never interrupted rather than that the reason was lost. `not_recorded` is the tenth zero reason and means resmon did not observe why the source returned nothing; it is not a reason, and it is never rendered as one.

## Admission, and the one 429

`POST /api/search/dive` and `POST /api/search/sweep` are refused `429` when the admission controller has no free slot for a manual run. The body is FastAPI's ordinary `{"detail": "<sentence>"}` — a sentence naming the current cap, not a code — and the answer carries `Retry-After: 5`. A resubmission of a run that is already going is answered with that run instead, before the cap is consulted: it is not new demand on capacity. Routine fires are not refused; they queue. The controller is `implementation_scripts/admission.py`, and the cap is `GET`/`PUT /api/settings/execution`.
