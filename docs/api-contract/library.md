# Library: owned copies and bounded text

Library pairs one explicitly created child vault with one application database.
The user chooses an existing parent directory and confirms Create; no existing
folder is adopted. The server creates `resmon-library-<vault UUID>`, a `vault.json`
marker containing exactly `{"version":1,"vault_id":"<UUID>"}`, and `files/`.
Each retained object has a server-generated file UUID and immutable version UUID:
`files/<file UUID>/<version UUID>.<pdf|txt|md>`.

## Storage and migration

Schema 16 adds exactly three tables (`library_vault`, `library_files`,
`library_file_documents`) and one explicit index
(`idx_library_file_documents_document`). SQLite also creates the implicit indexes
required by UNIQUE and PRIMARY KEY constraints. The migration runs after schema 15,
validates existing/new DDL inside a savepoint, then advances the schema marker.
A conflicting table, view, index or denied statement cannot leave a partially
marked schema 16. Initialization creates no vault directory and backfills no links.
Existing paper, queue, provenance and assistant rows are retained.

Imports stream selected raw bytes, never a server-side source path. Names are
display basenames, 1–255 characters, without separators or Unicode controls. PDF
requires its `%PDF-` envelope; this is not parsing, validation or malware scanning.
TXT/MD requires strict UTF-8 without NUL. Empty and unsupported files are refused.
The limits are 64 MiB/file, 20 sequential files/UI selection, 1 GiB retained/vault
and 10,000 catalog items. An exact duplicate may reuse its entry at capacity.

One exclusive import lock and SQLite write transaction protect quota checks and
publication. The operation writes/fsyncs a uniquely owned staging file, publishes
with exclusive creation, and commits the catalog only after full retained bytes
exist. A digest match requires full byte-for-byte comparison and the same media
interpretation; reuse preserves the first basename/file/version. A digest collision
or media conflict refuses. Different bytes receive different UUIDs. Caught failures
clean only this operation's unpublished bytes; prior retained copies and originals
are never deleted, moved or overwritten. A crash can leave a lock or orphan bytes;
these block further import and are neither adopted nor automatically repaired.
A retained size that differs from its catalog also blocks import, so quota checks
cannot silently use an outdated size. Status still does not hash every retained file.

All managed access walks directories through no-follow descriptors, checks the
paired marker, and rejects symlinks, nonregular files and hard-linked retained
objects. There is no unsafe fallback on platforms lacking the required primitives.
macOS/Linux behavior must be tested on their actual runtimes; this implementation
does not provide a Windows reparse-point implementation. The local OS/user is
trusted. This is not confinement against a hostile local process or a guarantee
against every storage/power-loss race. An external opener resolves its path after
the backend's verification, so later filesystem changes remain an OS boundary.

Paper links name existing `documents.id` values explicitly. They mean an owner
association in this database, not fuzzy matching or scientific identity. Deleting
that paper cascades only its association rows. Reused IDs inherit no old links.
Existing corpus erasure and settings/factory resets retain Library catalog/files.
The UI provides no Library removal, replacement, relink or recovery operation.

## Nine HTTP routes

All nine require one exact `Origin: http://127.0.0.1:<port>` with a valid explicit
port and `X-Resmon-Library: 1`, checked before body parsing or protected effects.
Null, foreign, missing, repeated or malformed Origins/headers refuse with 403.
Existing OPTIONS/CORS handling is unchanged. This guards browser cross-origin
requests; another local process can forge these headers. No global authentication,
CORS, daemon or assistant/MCP tool change is introduced.

All UUIDs use canonical lowercase spelling. Unknown/repeated query keys and extra
JSON body fields refuse. Domain failures return `detail.reason` and a user-facing
`detail.message`; raw filesystem paths are not leaked through OS/SQLite errors.

| Method and path | Input and result |
|---|---|
| GET `/api/library` | No input. Versioned status, vault UUID/label (no absolute root), recorded counts and limits. |
| POST `/api/library/vault` | JSON `parent_directory`. Explicitly create one new managed child; 201 status envelope. Existing configuration cannot switch roots. |
| GET `/api/library/files` | Required `expected_vault_id`; optional `q`, `through_id`, `before_id`, `limit` (1–100, default 50). Descending keyset page and fixed ceiling. |
| POST `/api/library/files` | Required query `expected_vault_id`, `filename`; optional existing `document_id`. `application/octet-stream` body. 201 new copy or 200 exact duplicate, with file/version and link receipt. |
| GET `/api/library/files/{file_id}` | Required `expected_vault_id`. Recorded metadata and explicit current paper links. |
| POST `/api/library/files/{file_id}/paper-links` | JSON `expected_vault_id`, positive integer `document_id`. Idempotent association receipt. |
| POST `/api/library/files/{file_id}/open` | JSON `expected_vault_id`, `expected_version_id`. Verify marker, path, regular file, size and SHA256 before returning the selected absolute path for existing desktop IPC. |
| GET `/api/library/export` | Required `expected_vault_id`; `format=json` only. Complete inventory envelope described below. |
| GET `/api/library/files/{file_id}/text` | Required `expected_vault_id`, `expected_version_id`. Bounded literal text envelope; successes and refusals have `Cache-Control: no-store`. |

Search uses literal filename substring matching with SQLite's built-in `lower`
semantics (ASCII case folding), not a publication search. The initial page supplies
`through_id`; later pages retain it and use strict `before_id`. Refresh starts a
new ceiling. Metadata/list responses declare `availability: not_checked`; they
check the vault pairing but do not hash all files. Unavailable/mismatched vaults
refuse access instead of falling through to another path.

## Read-only text projection

The same retained-file resolver serves Open, duplicate verification and text reads.
The text route permits exact retained TXT/MD only, at most 256 KiB of original
bytes, 5,000 logical lines, and 2 MiB of serialized JSON. It verifies vault/file/
version/size/hash, rereads the selected descriptor with a bounded buffer and checks
the resulting bytes again. Strict UTF-8 decoding rejects NUL and malformed input.
CRLF and lone CR normalize to LF for display. A trailing LF counts a final empty
logical line; stored bytes and metadata remain unchanged.

The envelope contains exactly `version: 1`, `kind: resmon-library-text`, `vault_id`,
`file_id`, `version_id`, `sha256`, `media_type`, `encoding: utf-8`,
`normalization: crlf-cr-to-lf-v1`, original `byte_size`, `line_count` and `text`.
No absolute path, metadata from unrelated settings, excerpt cache or write occurs.
PDF, oversized text and invalid bytes refuse visibly with verified external Open
available as a separate request. A refusal never claims partial reading succeeded.

The renderer validates the response identity and limits, renders literal text nodes
with line numbers, and provides case-sensitive local find/previous/next navigation.
Matches move keyboard focus to their line; closing returns focus to Read.
Success and error callbacks are gated on current selection/request lifetime.
Switching or closing cannot display an older read, initiate its delayed Open, or
download its delayed inventory. There is no Markdown/HTML execution, remote embed,
PDF parser/OCR, RAG, live AI, persistent excerpt, annotation or citation system.

## Complete portable inventory

Export uses a single recorded-metadata snapshot and deterministic catalog order.
The response fields are `version`, `vault_id`, `format`, `filename`, `content_type`
and JSON `text`. The inner document has `version: 1`,
`kind: resmon-library-inventory`, `vault_id`, `generated_at_utc`, all `files` and
explicit `limits`. Each file contains UUIDs, original basename, format, byte size,
SHA256, portable relative path, import time, explicit local paper IDs/basis and
`availability: not_checked`. Absolute root/source paths, paper titles, credentials,
provider settings and retained bytes are excluded. Both backend and renderer refuse
an inventory exceeding 8 MiB without truncation.

The actual renderer Blob download validates both envelopes and expected vault.
An inventory is not a file bundle, backup, relocation tool or fresh integrity scan.
Original basenames can be private: review before sharing. A database backup alone
does not restore the managed files; no automatic Library cloud backup is added.

## Verification pointers and limits

`test_library.py` covers filesystem/SQL publication, preservation, quota, duplicate
comparison, keyset paging and explicit associations. `test_library_upgrade.py`
uses the populated schema-15 SQL fixture and distinct migration blockers.
`test_library_boundary.py` drives all nine routes over real isolated HTTP, including
chunked-body limit enforcement. `test_library_text.py` covers retained byte/line/
response limits and identity refusals. Renderer tests cover literal content and
delayed success/error/current-selection behavior; `e2e/library.spec.ts` drives the
real disposable Electron/HTTP/import/read/Open-request/restart/inventory/reset
journey and checks original/retained hashes.

The Electron picker, OS-open return value and download destination are scripted;
the backend, IPC request and download bytes are real. This does not prove native
dialog behavior, an external viewer, a human/Android interaction, hostile-file
safety or independent audit. The separately authored briefing prototype is not
part of this app, its reader API, or this public source tree.

## Evidence handoff

A selected Library item can hand its exact vault/file/version identity to
[Evidence](evidence.md) for explicit project membership, bounded PDF/TXT/MD
reading, literal saved notes and selected ZIP export. Existing Library import,
reader, external Open, inventory and nine-route contracts remain unchanged.
Evidence does not infer the latest imported file or publication identity.
