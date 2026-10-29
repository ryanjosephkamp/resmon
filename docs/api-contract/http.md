# The HTTP surface, by parity-register row

**Generated. Do not edit by hand.** `implementation_scripts/api_contract.py` writes this file from the running FastAPI application; `verification_scripts/test_api_contract.py` regenerates it and fails on any difference. Regenerate with `python -m implementation_scripts.api_contract --write`.

194 routes, over 48 register rows: 43 rows are carried by at least one route and 5 are not. Every route appears in at least one table — the guard fails when one does not.

## How to read a row

**Auth.** `token` means the request must carry `Authorization: Bearer <this backend's token>`, a loopback `Host` on this backend's own port, and — when it is a browser request, which is to say when it carries an `Origin` — this app's renderer origin. The MCP server and Electron's main process send no `Origin` and are judged on the token alone. `signed link` means the guard lets the request past the token check and the route checks a per-destination HMAC instead. The full model, including what it does not defend, is [local-api-security.md](../local-api-security.md); the classes here are computed from `api_auth.AUTH_EXEMPT_PATHS` and `api_auth.AUTH_SIGNED_PATHS` rather than transcribed from that page.

**SSE.** `yes` means the handler answers with `text/event-stream`. The response is a sequence of events, not a JSON body, and a client that reads it with an ordinary fetch-and-parse will hang.

**Purpose.** The first line of the endpoint's docstring, for the 94 of 194 routes that have one. The remaining 100 show FastAPI's generated summary instead, *in italics*: it is the function's own name with the underscores taken out, and it is here because an invented sentence would read like documentation without being any.

**Response.** The `response_model` the route declares, for the 157 of 194 routes that declare one — `openapi.json` carries its schema under that name, and a typed client can be generated from it. The remaining 37 show `—`: they declare no model, so `openapi.json` describes their 200 body as the empty schema `{}` and what they answer with is described in prose in [README.md](../../README.md) and in the five feature contracts beside this file. Nothing here guesses at a response shape.

A declared model is a **lower bound** on the body, not an exact description. Every one of them is an `additionalProperties: true` schema, because FastAPI filters a response against its model and a key nobody declared would otherwise be dropped from the reply silently; `implementation_scripts/response_models.py` sets that out in full and `verification_scripts/test_response_models.py` holds every model to it by comparing each route's body with what its handler returned on the same request. So a client may rely on a declared field being there, and may not rely on there being nothing else.

What survives is the **key**. An undeclared value is re-serialized by pydantic rather than by FastAPI's `jsonable_encoder`, and the two disagree for three types: a `Decimal` becomes a string rather than a float, a `PurePath` raises instead of serializing (the concrete `Path` beside it is fine, which is the trap), and `inf`/`nan` become a quiet `null` where an unmodeled route answered 500. None is reachable in the routes modeled today; the table and the test that keeps it true are in `response_models.py`, and anyone modeling a further route should read it first.

## J01 — Deep Dive

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/executions/{exec_id}/progress/events` | token | — | — | *Get Execution Progress Events* |
| `GET` | `/api/executions/{exec_id}/progress/stream` | token | yes | — | *Stream Progress* |
| `POST` | `/api/search/dive` | token | — | `RunStarted` | *Search Dive* |
| `GET` | `/api/search/repositories` | token | — | `list` | *Search Repositories* |

## J02 — Deep Sweep

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/executions/{exec_id}/progress/events` | token | — | — | *Get Execution Progress Events* |
| `GET` | `/api/executions/{exec_id}/progress/stream` | token | yes | — | *Stream Progress* |
| `GET` | `/api/search/repositories` | token | — | `list` | *Search Repositories* |
| `POST` | `/api/search/sweep` | token | — | `RunStarted` | *Search Sweep* |

## J03 — Routines

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/routines` | token | — | `list` | *List Routines* |
| `POST` | `/api/routines` | token | — | `RoutineCreated` | *Create Routine* |
| `DELETE` | `/api/routines/{routine_id}` | token | — | — | *Delete Routine Endpoint* |
| `GET` | `/api/routines/{routine_id}` | token | — | `Routine` | Fetch a single routine by ID. |
| `PUT` | `/api/routines/{routine_id}` | token | — | `RoutineUpdated` | *Update Routine Endpoint* |
| `POST` | `/api/routines/{routine_id}/activate` | token | — | `RoutineActivation` | *Activate Routine* |
| `POST` | `/api/routines/{routine_id}/deactivate` | token | — | `RoutineActivation` | *Deactivate Routine* |
| `GET` | `/api/routines/{routine_id}/documents` | token | — | `RoutineDocuments` | The papers this routine's runs collected: a watch's constellation. |
| `POST` | `/api/routines/{routine_id}/run` | token | — | `RoutineRunStarted` | Run a routine immediately, outside its schedule. |
| `GET` | `/api/scheduler/jobs` | token | — | — | *Get Scheduler Jobs* |
| `GET` | `/api/scheduler/status` | token | — | `SchedulerStatus` | Whether this database's active routines will fire, and what decides it. |

## J04 — Background daemon

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/scheduler/status` | token | — | `SchedulerStatus` | Whether this database's active routines will fire, and what decides it. |
| `GET` | `/api/service/daemon-status` | token | — | `DaemonStatus` | Return ground-truth daemon status read from `daemon.lock`. |
| `POST` | `/api/service/install` | token | — | `ServiceInstalled` | Render the platform unit template and write it to the install path. |
| `GET` | `/api/service/status` | token | — | `ServiceStatus` | Return whether the daemon unit file is installed and its path. |
| `POST` | `/api/service/uninstall` | token | — | `ServiceUninstalled` | Remove the unit file; optionally deregister with the OS first. |

## J05 — Analytics

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/analytics/discovery-lag` | token | — | `DiscoveryLag` | Median days between publication and resmon first seeing each paper. |
| `GET` | `/api/analytics/keyword-contribution` | token | — | `KeywordContribution` | Per keyword: papers it found that no other keyword did. |
| `GET` | `/api/analytics/overview` | token | — | `AnalyticsOverview` | Everything the Analytics page needs, in one round trip. |
| `GET` | `/api/analytics/publication-volume` | token | — | `PublicationVolume` | Papers per publication month, split by source or subject category. |
| `GET` | `/api/analytics/routine-health` | token | — | `RoutineHealth` | Per routine: new results per run, and whether it has gone quiet. |
| `GET` | `/api/analytics/source-contribution` | token | — | `SourceContribution` | Per source: papers delivered, and how many nothing else found. |
| `GET` | `/api/analytics/summary` | token | — | `CorpusSummary` | *Analytics Summary* |

## J06 — Watchdog

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/documents/{doc_id}/lifecycle` | token | — | — | Lifecycle events recorded against one paper. |
| `GET` | `/api/lifecycle` | token | — | — | Recorded lifecycle events, and how much of the corpus they cover. |
| `POST` | `/api/lifecycle/check` | token | — | — | Start a bounded lifecycle check over the least recently checked papers. |
| `POST` | `/api/lifecycle/for-documents` | token | — | — | Lifecycle events for a page of results, in one round trip. |
| `POST` | `/api/lifecycle/stop` | token | — | — | Ask a running check to stop after its current slice. |
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
| `GET` | `/api/profiles/{profile_id}/matches` | token | — | `WatchProfileMatchPage` | Papers matched to this profile, **each with the basis it was matched on**. |

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
| `GET` | `/api/documents/{doc_id}` | token | — | `Paper` | One paper as stored, and where it stands in the reading queue. |
| `GET` | `/api/documents/{doc_id}/why` | token | — | `PaperWhy` | What is locally verifiable about why this paper is in the corpus. |
| `POST` | `/api/explorer/export` | token | — | — | Export everything matching the current filters, not just the page shown. |
| `POST` | `/api/explorer/facets` | token | — | — | Available filter values and their counts, for the current filters. |
| `POST` | `/api/explorer/search` | token | — | `ExplorerPage` | Search the whole corpus. POST because the filter set is a structure. |

## J13 — The assistant (CLI lane)

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
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
| `POST` | `/api/ai/models` | token | — | — | Return the list of model IDs the BYOK credential can access. |
| `GET` | `/api/settings/ai` | token | — | `AiSettings` | *Get Ai Settings* |
| `PUT` | `/api/settings/ai` | token | — | `SettingsSaved` | *Update Ai Settings* |

## J18 — Reports and exports

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/executions` | token | — | `list` | *List Executions* |
| `POST` | `/api/executions/export` | token | — | — | Bundle the reports and logs for the selected executions into a .zip. |
| `DELETE` | `/api/executions/{exec_id}` | token | — | — | *Delete Execution* |
| `GET` | `/api/executions/{exec_id}` | token | — | `Run` | *Get Execution* |
| `GET` | `/api/executions/{exec_id}/documents` | token | — | `RunPapersPage` | One page of the papers this run found, each with its stored id. |
| `GET` | `/api/executions/{exec_id}/log` | token | — | `RunLog` | *Get Execution Log* |
| `GET` | `/api/executions/{exec_id}/references` | token | — | — | Export one run; JSON can explicitly include corpus IDs for follow-up reads. |
| `GET` | `/api/executions/{exec_id}/report` | token | — | `RunReport` | *Get Execution Report* |
| `GET` | `/api/executions/{exec_id}/search-record` | token | — | — | The complete, dated account of one search. |
| `POST` | `/api/export/references` | token | — | — | Render one selection, with one entry per stored document ID. |

## J19 — Live monitoring

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/executions/active` | token | — | `ActiveRuns` | *Active Executions* |
| `POST` | `/api/executions/{exec_id}/cancel` | token | — | `RunCancelRequested` | Request cooperative cancellation of a running execution. |
| `GET` | `/api/executions/{exec_id}/progress/events` | token | — | — | *Get Execution Progress Events* |
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
| `POST` | `/api/configurations/export` | token | — | `ConfigurationExport` | *Export Configurations* |
| `POST` | `/api/configurations/import` | token | — | `ConfigurationImportResult` | *Import Configurations* |
| `DELETE` | `/api/configurations/{config_id}` | token | — | `ConfigurationDeleted` | *Delete Configuration Endpoint* |
| `PUT` | `/api/configurations/{config_id}` | token | — | `ConfigurationUpdated` | *Update Configuration Endpoint* |

## J22 — Repositories and keys

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/credentials` | token | — | `CredentialsPresence` | Return per-credential status for every known credential name. |
| `POST` | `/api/credentials/validate` | token | — | — | *Validate Credential* |
| `DELETE` | `/api/credentials/{key_name}` | token | — | `CredentialChanged` | *Delete Credential Endpoint* |
| `PUT` | `/api/credentials/{key_name}` | token | — | `CredentialChanged` | *Store Credential Endpoint* |
| `GET` | `/api/repositories/catalog` | token | — | `list` | Return the static repository catalog (never returns secrets). |
| `GET` | `/api/search/repositories` | token | — | `list` | *Search Repositories* |

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
| `POST` | `/api/cloud/backup` | token | — | `CloudBackupUploaded` | *Cloud Backup* |
| `POST` | `/api/cloud/link` | token | — | `CloudLinked` | *Cloud Link* |
| `GET` | `/api/cloud/status` | token | — | `CloudStatus` | *Cloud Status* |
| `POST` | `/api/cloud/unlink` | token | — | `CloudUnlinked` | *Cloud Unlink* |
| `GET` | `/api/settings/cloud` | token | — | `CloudSettings` | *Get Cloud Settings* |
| `PUT` | `/api/settings/cloud` | token | — | `SettingsSaved` | *Update Cloud Settings* |

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
| `GET` | `/api/reading-queue` | token | — | `ReadingQueuePage` | One page of saved papers. `status` omitted (or `all`) means both. |
| `POST` | `/api/reading-queue` | token | — | `ReadingQueueEntry` | Save a stored paper. Saving one already saved returns it unchanged. |
| `DELETE` | `/api/reading-queue/{document_id}` | token | — | `ReadingQueueRemoval` | Take a paper out of the queue. The paper itself is not touched. |
| `PUT` | `/api/reading-queue/{document_id}` | token | — | `ReadingQueueEntry` | Mark a saved paper read or unread. |

## J29 — Recorded-source coverage

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/coverage/source-wall` | token | — | `SourceWall` | Every source's recorded answer to each of the last `limit` runs. |
| `GET` | `/api/executions/{exec_id}` | token | — | `Run` | *Get Execution* |
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
| `GET` | `/api/library` | token | — | `LibraryStatus` | *Library Status* |
| `GET` | `/api/library/export` | token | — | `LibraryInventory` | *Library Inventory* |
| `GET` | `/api/library/files` | token | — | `LibraryFiles` | *Library List* |
| `POST` | `/api/library/files` | token | — | `LibraryImported` | *Library Import* |
| `GET` | `/api/library/files/{file_id}` | token | — | `LibraryFileDetail` | *Library Detail* |
| `POST` | `/api/library/files/{file_id}/open` | token | — | `LibraryOpened` | *Library Open* |
| `POST` | `/api/library/files/{file_id}/paper-links` | token | — | `LibraryLinked` | *Library Link* |
| `GET` | `/api/library/files/{file_id}/text` | token | — | `LibraryText` | *Library Read Text* |
| `POST` | `/api/library/vault` | token | — | `LibraryStatus` | *Library Create Vault* |

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
| `GET` | `/api/routines/{routine_id}` | token | — | `Routine` | Fetch a single routine by ID. |
| `POST` | `/api/routines/{routine_id}/run` | token | — | `RoutineRunStarted` | Run a routine immediately, outside its schedule. |
| `POST` | `/api/search/dive` | token | — | `RunStarted` | *Search Dive* |
| `POST` | `/api/search/sweep` | token | — | `RunStarted` | *Search Sweep* |
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
| `GET` | `/api/backup/last` | token | — | `BackupLast` | The last bundle, the last restore outcome, and whether an undo copy exists. |
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

The guard is in front of all 194 routes, not only the two listed here: `AUTH_EXEMPT_PATHS` is an explicitly empty constant and a test fails if it grows. The two rows above are the routes that are *about* the guard — the one that registers a renderer origin (and refuses to do so for a request carrying an `Origin`, because a browser must not be able to widen the allowlist), and the one route that proves itself with a signature instead of the token.

## J43 — Upgrade in place

No route. Migrations run inside `database.init_db` at start; the journey is exercised by `test_cumulative_upgrade.py` against a released fixture.

## J44 — Driving resmon from an external harness (MCP)

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/analytics/discovery-lag` | token | — | `DiscoveryLag` | Median days between publication and resmon first seeing each paper. |
| `GET` | `/api/analytics/keyword-contribution` | token | — | `KeywordContribution` | Per keyword: papers it found that no other keyword did. |
| `GET` | `/api/analytics/overview` | token | — | `AnalyticsOverview` | Everything the Analytics page needs, in one round trip. |
| `GET` | `/api/analytics/publication-volume` | token | — | `PublicationVolume` | Papers per publication month, split by source or subject category. |
| `GET` | `/api/analytics/routine-health` | token | — | `RoutineHealth` | Per routine: new results per run, and whether it has gone quiet. |
| `GET` | `/api/analytics/source-contribution` | token | — | `SourceContribution` | Per source: papers delivered, and how many nothing else found. |
| `GET` | `/api/credentials` | token | — | `CredentialsPresence` | Return per-credential status for every known credential name. |
| `GET` | `/api/documents/{doc_id}/lifecycle` | token | — | — | Lifecycle events recorded against one paper. |
| `GET` | `/api/documents/{doc_id}/why` | token | — | `PaperWhy` | What is locally verifiable about why this paper is in the corpus. |
| `GET` | `/api/documents/{document_id}/similar` | token | — | — | The papers nearest this one, with distances and their sources. |
| `GET` | `/api/executions` | token | — | `list` | *List Executions* |
| `GET` | `/api/executions/{exec_id}` | token | — | `Run` | *Get Execution* |
| `GET` | `/api/executions/{exec_id}/references` | token | — | — | Export one run; JSON can explicitly include corpus IDs for follow-up reads. |
| `GET` | `/api/executions/{exec_id}/search-record` | token | — | — | The complete, dated account of one search. |
| `POST` | `/api/explorer/search` | token | — | `ExplorerPage` | Search the whole corpus. POST because the filter set is a structure. |
| `POST` | `/api/export/references` | token | — | — | Render one selection, with one entry per stored document ID. |
| `GET` | `/api/health` | token | — | `Health` | Liveness endpoint. Returns process identity so clients can attach-or-spawn. |
| `GET` | `/api/profiles` | token | — | `WatchProfileList` | *List Watch Profiles* |
| `POST` | `/api/profiles` | token | — | `WatchProfile` | *Create Watch Profile* |
| `GET` | `/api/profiles/{profile_id}` | token | — | `WatchProfile` | *Get Watch Profile* |
| `GET` | `/api/profiles/{profile_id}/matches` | token | — | `WatchProfileMatchPage` | Papers matched to this profile, **each with the basis it was matched on**. |
| `GET` | `/api/repositories/catalog` | token | — | `list` | Return the static repository catalog (never returns secrets). |
| `GET` | `/api/routines` | token | — | `list` | *List Routines* |
| `POST` | `/api/routines` | token | — | `RoutineCreated` | *Create Routine* |
| `GET` | `/api/routines/{routine_id}` | token | — | `Routine` | Fetch a single routine by ID. |
| `POST` | `/api/routines/{routine_id}/activate` | token | — | `RoutineActivation` | *Activate Routine* |
| `GET` | `/api/routines/{routine_id}/coverage` | token | — | `RoutineCoverage` | Is this routine finding what its owner meant, and what is it missing? |
| `POST` | `/api/routines/{routine_id}/deactivate` | token | — | `RoutineActivation` | *Deactivate Routine* |
| `GET` | `/api/routines/{routine_id}/deliveries` | token | — | `RoutineDeliveries` | *List Routine Deliveries* |
| `POST` | `/api/routines/{routine_id}/run` | token | — | `RoutineRunStarted` | Run a routine immediately, outside its schedule. |
| `POST` | `/api/search/sweep` | token | — | `RunStarted` | *Search Sweep* |
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

## J47 — Collection map: where every paper sits

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/documents/briefs` | token | — | `list` | A line about each paper asked for, for the plate's hover: title, authors, |
| `GET` | `/api/map` | token | — | `CollectionMap` | Where every paper sits on the Atlas plate, and on what basis. |

## J48 — Today: the papers since you last looked

| Method | Path | Auth | SSE | Response | Purpose |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/documents/briefs` | token | — | `list` | A line about each paper asked for, for the plate's hover: title, authors, |
| `GET` | `/api/today` | token | — | `Today` | The papers resmon first collected since Today was last looked at, by watch. |
| `POST` | `/api/today/looked` | token | — | `TodayLooked` | Record that Today was looked at now: the next window starts here. |

## Closed vocabularies

Every list below is generated from the object named beside it and tested equal to it. A value added to the code and not to this file, or to this file and not to the code, is a failing test.

**Execution status** — from the `executions.status` CHECK in `database._EXECUTIONS_V19_DDL`. 5 values:

`running` · `completed` · `failed` · `cancelled` · `interrupted`

**Interrupted reason** — from `database.INTERRUPTED_REASONS`. 3 values:

`owner_dead` · `daemon_restart` · `unknown`

**Zero reason** — from `zero_reason.ZERO_REASONS`. 10 values:

`missing_key` · `retired` · `window_unanswerable` · `upstream_failure` · `parse_failure` · `rights_filtered` · `records_unusable` · `entity_unsupported` · `answered_empty` · `not_recorded`

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
