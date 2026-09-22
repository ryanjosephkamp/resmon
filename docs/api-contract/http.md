# The HTTP surface, by parity-register row

**Generated. Do not edit by hand.** `implementation_scripts/api_contract.py` writes this file from the running FastAPI application; `verification_scripts/test_api_contract.py` regenerates it and fails on any difference. Regenerate with `python -m implementation_scripts.api_contract --write`.

184 routes, over 44 register rows: 39 rows are carried by at least one route and 5 are not. Every route appears in at least one table — the guard fails when one does not.

## How to read a row

**Auth.** `token` means the request must carry `Authorization: Bearer <this backend's token>`, a loopback `Host` on this backend's own port, and — when it is a browser request, which is to say when it carries an `Origin` — this app's renderer origin. The MCP server and Electron's main process send no `Origin` and are judged on the token alone. `signed link` means the guard lets the request past the token check and the route checks a per-destination HMAC instead. The full model, including what it does not defend, is [local-api-security.md](../local-api-security.md); the classes here are computed from `api_auth.AUTH_EXEMPT_PATHS` and `api_auth.AUTH_SIGNED_PATHS` rather than transcribed from that page.

**SSE.** `yes` means the handler answers with `text/event-stream`. The response is a sequence of events, not a JSON body, and a client that reads it with an ordinary fetch-and-parse will hang.

**Purpose.** The first line of the endpoint's docstring, for the 86 of 184 routes that have one. The remaining 98 show FastAPI's generated summary instead, *in italics*: it is the function's own name with the underscores taken out, and it is here because an invented sentence would read like documentation without being any.

**No response schemas.** Not one of the 184 routes declares a `response_model`, so `openapi.json` describes every 200 body as the empty schema `{}`. What a route accepts — its path and query parameters and its request body — is fully described there; what it answers with is described in prose in [README.md](../../README.md) and in the five feature contracts beside this file. Nothing here guesses at a response shape.

## J01 — Deep Dive

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/executions/{exec_id}/progress/events` | token | — | *Get Execution Progress Events* |
| `GET` | `/api/executions/{exec_id}/progress/stream` | token | yes | *Stream Progress* |
| `POST` | `/api/search/dive` | token | — | *Search Dive* |
| `GET` | `/api/search/repositories` | token | — | *Search Repositories* |

## J02 — Deep Sweep

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/executions/{exec_id}/progress/events` | token | — | *Get Execution Progress Events* |
| `GET` | `/api/executions/{exec_id}/progress/stream` | token | yes | *Stream Progress* |
| `GET` | `/api/search/repositories` | token | — | *Search Repositories* |
| `POST` | `/api/search/sweep` | token | — | *Search Sweep* |

## J03 — Routines

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/routines` | token | — | *List Routines* |
| `POST` | `/api/routines` | token | — | *Create Routine* |
| `DELETE` | `/api/routines/{routine_id}` | token | — | *Delete Routine Endpoint* |
| `GET` | `/api/routines/{routine_id}` | token | — | Fetch a single routine by ID. |
| `PUT` | `/api/routines/{routine_id}` | token | — | *Update Routine Endpoint* |
| `POST` | `/api/routines/{routine_id}/activate` | token | — | *Activate Routine* |
| `POST` | `/api/routines/{routine_id}/deactivate` | token | — | *Deactivate Routine* |
| `POST` | `/api/routines/{routine_id}/run` | token | — | Run a routine immediately, outside its schedule. |
| `GET` | `/api/scheduler/jobs` | token | — | *Get Scheduler Jobs* |

## J04 — Background daemon

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/service/daemon-status` | token | — | Return ground-truth daemon status read from `daemon.lock`. |
| `POST` | `/api/service/install` | token | — | Render the platform unit template and write it to the install path. |
| `GET` | `/api/service/status` | token | — | Return whether the daemon unit file is installed and its path. |
| `POST` | `/api/service/uninstall` | token | — | Remove the unit file; optionally deregister with the OS first. |

## J05 — Analytics

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/analytics/discovery-lag` | token | — | Median days between publication and resmon first seeing each paper. |
| `GET` | `/api/analytics/keyword-contribution` | token | — | Per keyword: papers it found that no other keyword did. |
| `GET` | `/api/analytics/overview` | token | — | Everything the Analytics page needs, in one round trip. |
| `GET` | `/api/analytics/publication-volume` | token | — | Papers per publication month, split by source or subject category. |
| `GET` | `/api/analytics/routine-health` | token | — | Per routine: new results per run, and whether it has gone quiet. |
| `GET` | `/api/analytics/source-contribution` | token | — | Per source: papers delivered, and how many nothing else found. |
| `GET` | `/api/analytics/summary` | token | — | *Analytics Summary* |

## J06 — Watchdog

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/documents/{doc_id}/lifecycle` | token | — | Lifecycle events recorded against one paper. |
| `GET` | `/api/lifecycle` | token | — | Recorded lifecycle events, and how much of the corpus they cover. |
| `POST` | `/api/lifecycle/check` | token | — | Start a bounded lifecycle check over the least recently checked papers. |
| `POST` | `/api/lifecycle/for-documents` | token | — | Lifecycle events for a page of results, in one round trip. |
| `POST` | `/api/lifecycle/stop` | token | — | Ask a running check to stop after its current slice. |
| `GET` | `/api/profiles/{profile_id}/lifecycle` | token | — | Retractions and other lifecycle findings on this profile's papers. |
| `GET` | `/api/watchdog` | token | — | Findings, what could not be judged yet, and the thresholds used. |
| `POST` | `/api/watchdog/mute` | token | — | Acknowledge one finding so it stops counting toward the alarm total. |
| `POST` | `/api/watchdog/unmute` | token | — | Un-acknowledge a finding, returning it to the alarm total. |

## J07 — Watch profiles

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/profiles` | token | — | *List Watch Profiles* |
| `POST` | `/api/profiles` | token | — | *Create Watch Profile* |
| `POST` | `/api/profiles/import` | token | — | Import one or more exported profiles. |
| `POST` | `/api/profiles/matches/for-documents` | token | — | Which watch profiles matched a page of papers, and on what basis. |
| `GET` | `/api/profiles/starter` | token | — | The curated set that ships with the app, not yet anybody's profile. |
| `DELETE` | `/api/profiles/{profile_id}` | token | — | Remove a profile and its matches. **The corpus is untouched.** |
| `GET` | `/api/profiles/{profile_id}` | token | — | *Get Watch Profile* |
| `PUT` | `/api/profiles/{profile_id}` | token | — | *Update Watch Profile* |
| `GET` | `/api/profiles/{profile_id}/export` | token | — | *Export Watch Profile* |
| `GET` | `/api/profiles/{profile_id}/lifecycle` | token | — | Retractions and other lifecycle findings on this profile's papers. |
| `GET` | `/api/profiles/{profile_id}/matches` | token | — | Papers matched to this profile, **each with the basis it was matched on**. |

## J08 — Author identity and entity search

No route of its own. The capability is in the normaliser, the catalog's `entity_search` syntax and `api_base.search_entity`; it reaches a user through the routes of J01, J02 and J07.

## J09 — Semantic search

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/documents/{document_id}/similar` | token | — | The papers nearest this one, with distances and their sources. |
| `POST` | `/api/embeddings/backfill` | token | — | Embed every document lacking a vector for the active model. |
| `POST` | `/api/embeddings/backfill/cancel` | token | — | Stop after the batch in flight. Vectors already written are kept. |
| `GET` | `/api/embeddings/estimate` | token | — | What a backfill would cost, before it starts. |
| `POST` | `/api/embeddings/probe` | token | — | Ask the configured (or supplied) lane to embed one short string. |
| `POST` | `/api/embeddings/rebuild` | token | — | Rebuild the vector index from the canonical table. |
| `GET` | `/api/embeddings/status` | token | — | N of M embedded with model X, the run, the index, and the extension. |
| `POST` | `/api/explorer/search` | token | — | Search the whole corpus. POST because the filter set is a structure. |
| `GET` | `/api/settings/embeddings` | token | — | The stored settings, plus everything the tab needs to render honestly. |
| `PUT` | `/api/settings/embeddings` | token | — | Store the settings, refusing a provider that cannot embed. |

## J10 — Near-duplicate links

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/documents/{document_id}/links` | token | — | What else in the corpus looks like the same work as this paper. |
| `POST` | `/api/links/collapse-preview` | token | — | Which of these ids a collapse *would* fold, without folding anything. |
| `POST` | `/api/links/for-documents` | token | — | Links for a page of results in one round trip. |
| `POST` | `/api/links/scan` | token | — | Find near-duplicates across the corpus. Returns immediately. |
| `POST` | `/api/links/scan/cancel` | token | — | Stop after the document in flight. Links already written are kept. |
| `GET` | `/api/links/status` | token | — | How many links are stored, by method, and the scan's state. |

## J11 — Coverage audit

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/routines/{routine_id}/coverage` | token | — | Is this routine finding what its owner meant, and what is it missing? |

## J12 — Explorer

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/documents/{doc_id}/why` | token | — | What is locally verifiable about why this paper is in the corpus. |
| `POST` | `/api/explorer/export` | token | — | Export everything matching the current filters, not just the page shown. |
| `POST` | `/api/explorer/facets` | token | — | Available filter values and their counts, for the current filters. |
| `POST` | `/api/explorer/search` | token | — | Search the whole corpus. POST because the filter set is a structure. |

## J13 — The assistant (CLI lane)

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/assistant/permissions` | token | — | Ask the person, and hold this request open until they answer. |
| `POST` | `/api/assistant/permissions/{request_id}` | token | — | The panel's Allow / Deny. |
| `GET` | `/api/assistant/sessions` | token | — | *List Assistant Sessions* |
| `POST` | `/api/assistant/sessions` | token | — | *Create Assistant Session* |
| `GET` | `/api/assistant/sessions/{session_id}` | token | — | *Get Assistant Session* |
| `POST` | `/api/assistant/sessions/{session_id}/cancel` | token | — | Stop the running turn. Idempotent, and it says which happened. |
| `POST` | `/api/assistant/sessions/{session_id}/messages` | token | yes | *Send Assistant Message* |
| `GET` | `/api/assistant/status` | token | — | Whether the assistant can run, and if not, the reason in one sentence. |
| `GET` | `/api/settings/ai/cli-status` | token | — | Report whether each subscription-lane CLI can be found, and where. |
| `GET` | `/api/settings/assistant` | token | — | *Get Assistant Settings* |
| `PUT` | `/api/settings/assistant` | token | — | *Update Assistant Settings* |

## J14 — The assistant on a key

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/ai/models` | token | — | Return the list of model IDs the BYOK credential can access. |
| `GET` | `/api/assistant/status` | token | — | Whether the assistant can run, and if not, the reason in one sentence. |

## J15 — First-run card

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/onboarding` | token | — | What the first-run card renders, as facts rather than as prose. |
| `POST` | `/api/onboarding/dismiss` | token | — | Put the card away for good. |

## J16 — Weekly live-network job

No route. A GitHub Actions workflow over `verification_scripts/live_suite.py` and `live_quarantine.json`.

## J17 — AI summarization lanes

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/ai/models` | token | — | Return the list of model IDs the BYOK credential can access. |
| `GET` | `/api/settings/ai` | token | — | *Get Ai Settings* |
| `PUT` | `/api/settings/ai` | token | — | *Update Ai Settings* |

## J18 — Reports and exports

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/executions` | token | — | *List Executions* |
| `POST` | `/api/executions/export` | token | — | Bundle the reports and logs for the selected executions into a .zip. |
| `DELETE` | `/api/executions/{exec_id}` | token | — | *Delete Execution* |
| `GET` | `/api/executions/{exec_id}` | token | — | *Get Execution* |
| `GET` | `/api/executions/{exec_id}/documents` | token | — | One page of the papers this run found, each with its stored id. |
| `GET` | `/api/executions/{exec_id}/log` | token | — | *Get Execution Log* |
| `GET` | `/api/executions/{exec_id}/references` | token | — | Export one run; JSON can explicitly include corpus IDs for follow-up reads. |
| `GET` | `/api/executions/{exec_id}/report` | token | — | *Get Execution Report* |
| `GET` | `/api/executions/{exec_id}/search-record` | token | — | The complete, dated account of one search. |
| `POST` | `/api/export/references` | token | — | Render one selection, with one entry per stored document ID. |

## J19 — Live monitoring

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/executions/active` | token | — | *Active Executions* |
| `POST` | `/api/executions/{exec_id}/cancel` | token | — | Request cooperative cancellation of a running execution. |
| `GET` | `/api/executions/{exec_id}/progress/events` | token | — | *Get Execution Progress Events* |
| `GET` | `/api/executions/{exec_id}/progress/stream` | token | yes | *Stream Progress* |

## J20 — Calendar

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/calendar/events` | token | — | *Calendar Events* |

## J21 — Saved configurations

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/configurations` | token | — | *List Configurations* |
| `POST` | `/api/configurations` | token | — | *Create Configuration* |
| `POST` | `/api/configurations/export` | token | — | *Export Configurations* |
| `POST` | `/api/configurations/import` | token | — | *Import Configurations* |
| `DELETE` | `/api/configurations/{config_id}` | token | — | *Delete Configuration Endpoint* |
| `PUT` | `/api/configurations/{config_id}` | token | — | *Update Configuration Endpoint* |

## J22 — Repositories and keys

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/credentials` | token | — | Return per-credential status for every known credential name. |
| `POST` | `/api/credentials/validate` | token | — | *Validate Credential* |
| `DELETE` | `/api/credentials/{key_name}` | token | — | *Delete Credential Endpoint* |
| `PUT` | `/api/credentials/{key_name}` | token | — | *Store Credential Endpoint* |
| `GET` | `/api/repositories/catalog` | token | — | Return the static repository catalog (never returns secrets). |
| `GET` | `/api/search/repositories` | token | — | *Search Repositories* |

## J23 — Notifications and email

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/settings/email` | token | — | *Get Email Settings* |
| `PUT` | `/api/settings/email` | token | — | *Update Email Settings* |
| `POST` | `/api/settings/email/test` | token | — | Send a test email using the currently-stored SMTP settings. |
| `GET` | `/api/settings/notifications` | token | — | *Get Notification Settings* |
| `PUT` | `/api/settings/notifications` | token | — | *Update Notification Settings* |

## J24 — Google Drive backup

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/cloud/backup` | token | — | *Cloud Backup* |
| `POST` | `/api/cloud/link` | token | — | *Cloud Link* |
| `GET` | `/api/cloud/status` | token | — | *Cloud Status* |
| `POST` | `/api/cloud/unlink` | token | — | *Cloud Unlink* |
| `GET` | `/api/settings/cloud` | token | — | *Get Cloud Settings* |
| `PUT` | `/api/settings/cloud` | token | — | *Update Cloud Settings* |

## J25 — In-app documentation

No route. The tutorials and every `PageHelp` entry are renderer assets, shipped inside the app rather than fetched.

## J26 — Danger Zone

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/admin/erase-ai-keys` | token | — | *Admin Erase Ai Keys* |
| `POST` | `/api/admin/erase-app-data` | token | — | Erase the corpus + configs + executions + every API key. |
| `POST` | `/api/admin/erase-configs` | token | — | *Admin Erase Configs* |
| `POST` | `/api/admin/erase-corpus` | token | — | Erase every collected paper. Executions, configs and keys are kept. |
| `POST` | `/api/admin/erase-execution-data` | token | — | Erase all configs + all executions. Settings and API keys untouched. |
| `POST` | `/api/admin/erase-executions` | token | — | *Admin Erase Executions* |
| `POST` | `/api/admin/erase-repo-keys` | token | — | *Admin Erase Repo Keys* |
| `POST` | `/api/admin/factory-reset` | token | — | Erase every secret, config, execution, setting, and collected paper. |
| `POST` | `/api/admin/reset-settings` | token | — | Reset every setting plus erase every API key. Configs/executions kept. |

## J27 — Citation graph

No route. Recorded in the register as not carried forward.

## J28 — Reading queue

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/reading-queue` | token | — | One page of saved papers. `status` omitted (or `all`) means both. |
| `POST` | `/api/reading-queue` | token | — | Save a stored paper. Saving one already saved returns it unchanged. |
| `DELETE` | `/api/reading-queue/{document_id}` | token | — | Take a paper out of the queue. The paper itself is not touched. |
| `PUT` | `/api/reading-queue/{document_id}` | token | — | Mark a saved paper read or unread. |

## J29 — Recorded-source coverage

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/executions/{exec_id}` | token | — | *Get Execution* |
| `GET` | `/api/executions/{exec_id}/search-record` | token | — | The complete, dated account of one search. |

## J30 — Runtime identity

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/health` | token | — | Liveness endpoint. Returns process identity so clients can attach-or-spawn. |
| `POST` | `/api/renderer/heartbeat` | token | — | Renderer-presence ping. |

## J31 — Readable Ask

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/assistant/sessions/{session_id}/messages` | token | yes | *Send Assistant Message* |

## J32 — Chats and export

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/assistant/sessions` | token | — | *List Assistant Sessions* |
| `GET` | `/api/assistant/sessions/browse` | token | — | *Browse Assistant Sessions* |
| `DELETE` | `/api/assistant/sessions/{session_id}` | token | — | *Delete Assistant Session* |
| `GET` | `/api/assistant/sessions/{session_id}` | token | — | *Get Assistant Session* |
| `GET` | `/api/assistant/sessions/{session_id}/export` | token | — | *Export Assistant Session* |

## J33 — Composer choices

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/assistant/sessions/{session_id}/messages` | token | yes | *Send Assistant Message* |

## J34 — Owned Library

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/library` | token | — | *Library Status* |
| `GET` | `/api/library/export` | token | — | *Library Inventory* |
| `GET` | `/api/library/files` | token | — | *Library List* |
| `POST` | `/api/library/files` | token | — | *Library Import* |
| `GET` | `/api/library/files/{file_id}` | token | — | *Library Detail* |
| `POST` | `/api/library/files/{file_id}/open` | token | — | *Library Open* |
| `POST` | `/api/library/files/{file_id}/paper-links` | token | — | *Library Link* |
| `GET` | `/api/library/files/{file_id}/text` | token | — | *Library Read Text* |
| `POST` | `/api/library/vault` | token | — | *Library Create Vault* |

## J35 — Evidence workspace

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/evidence/projects` | token | — | *Evidence Projects* |
| `POST` | `/api/evidence/projects` | token | — | *Evidence Create Project* |
| `GET` | `/api/evidence/projects/{project_id}` | token | — | *Evidence Project Detail* |
| `PATCH` | `/api/evidence/projects/{project_id}` | token | — | *Evidence Rename Project* |
| `POST` | `/api/evidence/projects/{project_id}/bundle` | token | — | *Evidence Bundle* |
| `GET` | `/api/evidence/projects/{project_id}/files` | token | — | *Evidence Files* |
| `POST` | `/api/evidence/projects/{project_id}/files` | token | — | *Evidence Add File* |
| `DELETE` | `/api/evidence/projects/{project_id}/files/{file_id}` | token | — | *Evidence Remove File* |
| `GET` | `/api/evidence/projects/{project_id}/notes` | token | — | *Evidence Notes* |
| `POST` | `/api/evidence/projects/{project_id}/notes` | token | — | *Evidence Create Note* |
| `PATCH` | `/api/evidence/projects/{project_id}/notes/{note_id}` | token | — | *Evidence Edit Note* |
| `GET` | `/api/evidence/projects/{project_id}/reader/{file_id}` | token | — | *Evidence Read* |

## J36 — Selected-evidence answers

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/evidence/projects/{project_id}/answer-previews` | token | — | *Selected Answer Preview* |
| `GET` | `/api/evidence/projects/{project_id}/answers` | token | — | *Selected Answer History* |
| `POST` | `/api/evidence/projects/{project_id}/answers` | token | — | *Selected Answer Send* |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}` | token | — | *Selected Answer Detail* |
| `POST` | `/api/evidence/projects/{project_id}/answers/{answer_id}/cancel` | token | — | *Selected Answer Cancel* |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}/events` | token | yes | *Selected Answer Events* |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}/export` | token | — | *Selected Answer Export* |

## J37 — Portable saved-answer HTML

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/evidence/projects/{project_id}/answers/{answer_id}/export` | token | — | *Selected Answer Export* |

## J38 — Interrupted runs and Restart

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/executions/{exec_id}` | token | — | *Get Execution* |
| `POST` | `/api/executions/{exec_id}/restart` | token | — | Start a fresh execution with the source's parameters, linked back to it. |
| `POST` | `/api/renderer/heartbeat` | token | — | Renderer-presence ping. |

## J39 — One run per routine, one per submission, missed fires

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/routines/{routine_id}` | token | — | Fetch a single routine by ID. |
| `POST` | `/api/routines/{routine_id}/run` | token | — | Run a routine immediately, outside its schedule. |
| `POST` | `/api/search/dive` | token | — | *Search Dive* |
| `POST` | `/api/search/sweep` | token | — | *Search Sweep* |
| `GET` | `/api/settings/execution` | token | — | *Get Execution Settings* |
| `PUT` | `/api/settings/execution` | token | — | *Update Execution Settings* |

## J40 — Delivery: where a report goes, and whether it got there

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/deliveries/{delivery_id}/bundle` | signed link | — | The report bundle a webhook envelope linked to, for whoever holds the link. |
| `POST` | `/api/deliveries/{delivery_id}/deliver` | token | — | Release a delivery that was waiting for review. The only promotion. |
| `POST` | `/api/deliveries/{delivery_id}/retry` | token | — | Start the attempt sequence again, after the backoff has given up. |
| `POST` | `/api/deliveries/{delivery_id}/skip` | token | — | *Skip Delivery* |
| `GET` | `/api/executions/{exec_id}/deliveries` | token | — | *List Execution Deliveries* |
| `GET` | `/api/routines/{routine_id}/deliveries` | token | — | *List Routine Deliveries* |
| `GET` | `/api/routines/{routine_id}/delivery-targets` | token | — | *List Routine Delivery Targets* |
| `POST` | `/api/routines/{routine_id}/delivery-targets` | token | — | *Add Routine Delivery Target* |
| `DELETE` | `/api/routines/{routine_id}/delivery-targets/{target_id}` | token | — | *Delete Routine Delivery Target* |
| `PUT` | `/api/routines/{routine_id}/delivery-targets/{target_id}` | token | — | *Update Routine Delivery Target* |

## J41 — Backup and restore

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/backup` | token | — | Write one bundle: the snapshotted database, the vault's bytes, optionally reports. |
| `GET` | `/api/backup/last` | token | — | The last bundle, the last restore outcome, and whether an undo copy exists. |
| `POST` | `/api/backup/verify` | token | — | Recompute every hash and report what a restore would and would not do. |
| `POST` | `/api/restore` | token | — | Verify a bundle and stage it. The restore itself happens on the next start. |
| `POST` | `/api/restore/acknowledge` | token | — | Dismiss the one-time "what a restore did not bring back" card. |
| `POST` | `/api/restore/cancel` | token | — | Forget a staged restore. Nothing had been moved yet, so nothing is undone. |
| `POST` | `/api/restore/undo-copy/delete` | token | — | Delete the database copies a restore set aside. Irreversible, so confirm-gated. |
| `GET` | `/api/settings/storage` | token | — | *Get Storage Settings* |
| `PUT` | `/api/settings/storage` | token | — | *Update Storage Settings* |

## J42 — Local API locked to this app

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `POST` | `/api/auth/renderer-origin` | token | — | Allow one more exact renderer origin on this backend. |
| `GET` | `/api/deliveries/{delivery_id}/bundle` | signed link | — | The report bundle a webhook envelope linked to, for whoever holds the link. |

The guard is in front of all 184 routes, not only the two listed here: `AUTH_EXEMPT_PATHS` is an explicitly empty constant and a test fails if it grows. The two rows above are the routes that are *about* the guard — the one that registers a renderer origin (and refuses to do so for a request carrying an `Origin`, because a browser must not be able to widen the allowlist), and the one route that proves itself with a signature instead of the token.

## J43 — Upgrade in place

No route. Migrations run inside `database.init_db` at start; the journey is exercised by `test_cumulative_upgrade.py` against a released fixture.

## J44 — Driving resmon from an external harness (MCP)

| Method | Path | Auth | SSE | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/api/analytics/discovery-lag` | token | — | Median days between publication and resmon first seeing each paper. |
| `GET` | `/api/analytics/keyword-contribution` | token | — | Per keyword: papers it found that no other keyword did. |
| `GET` | `/api/analytics/overview` | token | — | Everything the Analytics page needs, in one round trip. |
| `GET` | `/api/analytics/publication-volume` | token | — | Papers per publication month, split by source or subject category. |
| `GET` | `/api/analytics/routine-health` | token | — | Per routine: new results per run, and whether it has gone quiet. |
| `GET` | `/api/analytics/source-contribution` | token | — | Per source: papers delivered, and how many nothing else found. |
| `GET` | `/api/credentials` | token | — | Return per-credential status for every known credential name. |
| `GET` | `/api/documents/{doc_id}/lifecycle` | token | — | Lifecycle events recorded against one paper. |
| `GET` | `/api/documents/{doc_id}/why` | token | — | What is locally verifiable about why this paper is in the corpus. |
| `GET` | `/api/documents/{document_id}/similar` | token | — | The papers nearest this one, with distances and their sources. |
| `GET` | `/api/executions` | token | — | *List Executions* |
| `GET` | `/api/executions/{exec_id}` | token | — | *Get Execution* |
| `GET` | `/api/executions/{exec_id}/references` | token | — | Export one run; JSON can explicitly include corpus IDs for follow-up reads. |
| `GET` | `/api/executions/{exec_id}/search-record` | token | — | The complete, dated account of one search. |
| `POST` | `/api/explorer/search` | token | — | Search the whole corpus. POST because the filter set is a structure. |
| `POST` | `/api/export/references` | token | — | Render one selection, with one entry per stored document ID. |
| `GET` | `/api/health` | token | — | Liveness endpoint. Returns process identity so clients can attach-or-spawn. |
| `GET` | `/api/profiles` | token | — | *List Watch Profiles* |
| `POST` | `/api/profiles` | token | — | *Create Watch Profile* |
| `GET` | `/api/profiles/{profile_id}` | token | — | *Get Watch Profile* |
| `GET` | `/api/profiles/{profile_id}/matches` | token | — | Papers matched to this profile, **each with the basis it was matched on**. |
| `GET` | `/api/repositories/catalog` | token | — | Return the static repository catalog (never returns secrets). |
| `GET` | `/api/routines` | token | — | *List Routines* |
| `POST` | `/api/routines` | token | — | *Create Routine* |
| `GET` | `/api/routines/{routine_id}` | token | — | Fetch a single routine by ID. |
| `POST` | `/api/routines/{routine_id}/activate` | token | — | *Activate Routine* |
| `GET` | `/api/routines/{routine_id}/coverage` | token | — | Is this routine finding what its owner meant, and what is it missing? |
| `POST` | `/api/routines/{routine_id}/deactivate` | token | — | *Deactivate Routine* |
| `GET` | `/api/routines/{routine_id}/deliveries` | token | — | *List Routine Deliveries* |
| `POST` | `/api/routines/{routine_id}/run` | token | — | Run a routine immediately, outside its schedule. |
| `POST` | `/api/search/sweep` | token | — | *Search Sweep* |
| `GET` | `/api/watchdog` | token | — | Findings, what could not be judged yet, and the thresholds used. |

Read out of `resmon_scripts/mcp_server.py` rather than transcribed: `api_contract.mcp_driven_routes()` parses every `backend.request(method, path)` call in that module — method included, so a path the harness only reads does not appear here as a path it also deletes — and matches each against the route table.

Calls in `mcp_server.py` that resolve to no single route, and so are not in the table above: `GET /api/settings/{}`, `PUT /api/settings/{}`. The settings path is built from a tool argument and reaches the `GET`/`PUT /api/settings/*` routes; it is named here rather than dropped, because a table that quietly omits what it could not read is worse than one that says so.

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
