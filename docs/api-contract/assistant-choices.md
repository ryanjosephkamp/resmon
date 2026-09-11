# Assistant choices (v1, schema 15)

Choices bind a future conversation to the existing Claude CLI or API-key assistant
adapter. They do not identify an account, executable build, resolved alias, price or
provider-verified effective configuration. No catalog request or live probe runs for
this feature. Tool inventory, system instructions, permission payloads and destructive
endpoint exclusions are unchanged.

## Status and requests

`GET /api/assistant/status` retains its fields and adds `composer_choices` version 1:
`default_request`, nullable `default_error`, `connections`, `claude_aliases`,
`claude_efforts` and `limitations`. Each connection includes runtime/provider/label,
implemented/available, reason and effort support; offered APIs include their existing
request family. The descriptor derives 11 provider rows from `PROVIDER_TOOL_CALLING`:
Claude Code, eight offered APIs and two unavailable adapters (Codex/Ollama). It derives
four CLI aliases and five effort strings from `ai_models`; these are suggestions,
not an account-verified compatibility matrix. Availability checks existing local
prerequisites, not authentication. No locator or credential is added to the descriptor.

`POST /api/assistant/sessions` accepts an optional `choices` object. Omission captures
current defaults with `settings_default` provenance. Explicit null is invalid. The
complete object is:

```json
{"version":1,"runtime":"claude_cli","provider":"claude_code","model":"opus","effort":"high"}
```

No extra or missing fields, coercion or unknown version is accepted. Runtime is
`claude_cli` or `api_key`; the latter requires an offered provider. Model is a literal,
nonblank string of at most 512 characters without Unicode controls, or CLI-only null.
CLI effort is null or an existing `low|medium|high|xhigh|max` string. API effort must
be null: the adapter sends no effort parameter. Invalid creation returns 400; malformed
outer models return 422. Creation records a fixed binding; send checks its readiness.
Null CLI values omit flags, leaving native defaults unknown. The renderer seeds its
draft once and never writes global defaults or replaces an edited draft on late status.

## Binding and admission

A bound send accepts `text`, not a per-turn override. Changing connection/model/effort
explicitly starts an empty conversation without copying messages or native IDs.
Global default changes cannot retarget a bound conversation. A private SHA-256 digest
compares only the configured CLI locator, custom API URL, or built-in provider descriptor.
It is not a credential/corpus fingerprint and is never exported. It cannot detect
account changes, replacement binary contents, DNS changes or alias resolution.

Admission resolves the fixed runtime once, checks local availability, claims the
per-session bus, then acquires a SQLite write lock. It rechecks binding and configured
locator under that lock and commits the user message plus requested-choice snapshot
atomically. A changed locator, stale adoption or existing active turn returns 409
before admitting a user row. The captured runtime and prior API text history are
passed directly to the worker; it does not reconstruct them from global defaults.
A reader disconnect keeps the claim until that worker finishes and requests cancellation.
There is no durable worker recovery or cross-process runtime coordination mechanism.

Legacy sessions remain unbound/readable/exportable after upgrade. Their first send
requires `legacy_adoption: {confirmed:true, choices:<complete object>}`. Missing or
unconfirmed adoption returns 409 `legacy_adoption_required`. A different runtime kind
returns 409 `runtime_change_requires_new_conversation`. API confirmation states that
saved same-chat user/assistant text will be sent to the selected future provider, with
prior provider unknown. Prior tool data/system messages are not replayed. CLI
confirmation states that earlier messages remain local and are not sent: it allocates
a fresh native session and never resumes the historical unverified ID. Binding, new
native coordination identity, user row and requested snapshot commit together. A later
adoption returns 409 `already_bound`; history and legacy session.model are preserved.

## Durable request and report evidence

Schema 15 adds only `assistant_session_choices`, `assistant_turn_choices` and partial
unique index `idx_assistant_turn_choices_assistant_message` on nonnull assistant message
IDs. Session choices reference session ID with cascade deletion; turn choices reference
the user message with cascade and optional assistant message with SET NULL. Session
fields are version/runtime/provider, requested_model/requested_effort, model_basis,
effort_basis, binding_basis, created_at_utc and private route_digest. Bases distinguish
explicit, settings_default, runtime_default, not_supported effort and new versus
legacy_confirmed binding. Turn fields are version, immutable requested_json,
reported_json (initially []), created_at_utc and the two message IDs.

The common final migration uses one savepoint for both tables, index, exact object
shape validation and marker 14→15. Blocking views/tables/indexes or failed DDL/marker
writes raise and roll back phase DDL; an upgraded database keeps marker 14. Fresh and
upgraded databases receive the same DDL. Repeated/restarted initialization adds no rows.
There is no historical backfill or inferred settings history. Earlier migrations remain
separate; this does not promise whole-history atomicity from every old schema version.

SSE adds `turn_choices` after admission and `turn_model_report` after an observation is
persisted, each with session_id/user_message_id. Reports have sequence, literal model,
source and observed_at_utc. Sources are `claude_system_init_model`, `api_response_model`
and `google_response_modelVersion`; a requested model echoed at API start is not a
report. Missing/invalid response models remain absent, ordered repeated/different valid
reports remain distinct. Requested values are not rewritten. Report append and final
reply linking each acquire a SQLite write lock to avoid lost updates or duplicate
reply rows. The renderer associates metadata with its owning session and user turn.

A persisted request can outlive a missing response. Assistant linkage proves only
that an assistant row was stored. Reports are response claims, not proof of actual
execution or billing; effective effort and historical completion remain unknown.
Snapshot/export use explicit public allowlists and the existing one-transaction read,
8 MiB refusal and literal-text rendering. See [conversations](assistant-conversations.md).

## Verification pointers

`test_assistant_choices.py`, `test_schema_upgrade.py`, `test_assistant_store.py`,
`test_assistant_runtime.py`, `test_assistant_api_runtime.py`, `test_assistant_api.py` and
`test_assistant_export.py` cover real SQLite and authored process/HTTP boundaries.
`ComposerChoices.test.tsx`, `AssistantPanel.test.tsx` and `ChatsPage.test.tsx` cover
renderer state/identity. `e2e/composer-choices.spec.ts` uses actual Electron/backend/SSE,
a captured fake CLI, loopback API recipient and scripted downloads. These establish
local contracts, not real account/model compatibility or native chooser behavior.
