# Evidence workspace v1

Evidence joins explicit projects to immutable local Library versions. Start in
Library, import or choose a file, follow **Open in Evidence / add to project**,
choose the intended project, and explicitly add that exact version. There is no
latest-import inference or second path-based import API.

## Identity, retention and schema 17

Projects have random UUIDs within the configured vault. Names are literal text,
1–120 Unicode codepoints after boundary trim. The bounds are 100 projects,
1,000 current members per project and 5,000 notes per project. Membership pins an
existing file/version pair in the same vault. Repeated add or absent-member
remove is a true no-op, preserving timestamps and revision. Removing membership
preserves original files, Library bytes, paper associations, provenance, other
projects and all saved notes. Re-adding the same identity reconnects those notes.
There is no project/note/file delete, adoption, relocation or recovery operation.

Schema 17 adds exactly `evidence_projects`, `evidence_project_files` and
`evidence_notes`, with explicit indexes `idx_evidence_project_files_order` and
`idx_evidence_notes_order`. The atomic 16→17 migration creates and validates exact
object SQL under a savepoint before advancing the marker. Existing partial or
wrong shapes refuse; restart validates rather than repairs. There is no backfill,
vault creation, file access or old-row rewrite. The physical table census is
32 application/FTS tables plus SQLite's internal `sqlite_sequence` before,
35 application/FTS tables plus that internal table afterward. Implicit unique
indexes are separate from the two explicit indexes.

Existing settings resets and corpus erasure retain projects, notes, the Library
catalog and managed bytes. Corpus erasure still removes paper associations to
those deleted papers. Database backup alone does not preserve managed files.
Library's existing no-follow/descriptor-relative platform requirements remain;
this phase does not establish new Windows Library support.

## Twelve HTTP operations

Every operation requires the exact loopback renderer Origin
`http://127.0.0.1:<port>` and `X-Resmon-Library: 1`. This is browser Origin
protection, not authentication of another local program capable of forging a
header. The guard applies before parsing. Evidence responses use `no-store` and
expose only their named download/identity headers to the renderer; existing
global CORS and other routes are unchanged. The Evidence client requires an
explicit desktop backend port and refuses the reserved daemon port; it has no
default-instance fallback.

| Method | Path under `/api/evidence/projects` | Request and result |
|---|---|---|
| GET | empty | `expected_vault_id`; paged project metadata |
| POST | empty | `expected_vault_id`, `name`; project at revision 1 |
| GET | `/{project_id}` | `expected_vault_id`; project and current counts |
| PATCH | `/{project_id}` | expected vault/revision, name; compare-and-swap rename |
| GET | `/{project_id}/files` | expected vault; paged current memberships and exact file metadata |
| POST | `/{project_id}/files` | expected vault/revision, `file_id`, `version_id`; add/no-op |
| DELETE | `/{project_id}/files/{file_id}` | expected vault/revision, `version_id`; membership only |
| GET | `/{project_id}/notes` | expected vault; optional exact `file_id` + `version_id`; paged saved records |
| POST | `/{project_id}/notes` | expected vault/revision, exact file/version, kind/body, passage anchor or null |
| PATCH | `/{project_id}/notes/{note_id}` | expected vault/project revision, `expected_note_revision`, body only |
| GET | `/{project_id}/reader/{file_id}` | expected vault, version, page, `representation=text` or `pdf` |
| POST | `/{project_id}/bundle` | expected vault/revision, explicit selected file/version array, `include_files` boolean |

Expected revision fields are named `expected_revision`; expected vault is
`expected_vault_id`. UUIDs are canonical lowercase; numeric inputs are exact
integers, never bool/float/string coercions. Unknown fields and duplicate JSON
or query keys refuse. Streamed JSON request bodies are at most 256 KiB.
Malformed input is 422, missing IDs 404, conflicting vault/version/revision 409,
and resource limits 413 or a typed page status. No lost-update retry is automatic.
The editor preserves unsaved body text on conflicts. After a concurrent note edit,
refresh, review its latest saved body and explicitly keep the draft against the
current revision before saving. This does not silently overwrite another edit.
The editor keeps text or a passage selected after an earlier save was submitted;
the success notice distinguishes the saved snapshot from newer unsaved changes.
An explicit selected-file membership refresh checks up to twenty pages of fifty
metadata rows at one revision/ceiling; absence from the first page is not removal.

Evidence timestamps are generated with microsecond UTC precision; malformed
stored timestamps refuse reads/exports without repairing the saved record.

JSON envelopes carry `contract_version: 1`, vault and project where applicable.
List queries use `after_id` (default 0), `through_id` (initial current maximum)
and `limit` (1–50, default 50); IDs ascend. Responses include `through_id`,
`next_after_id`, `has_more`, `total` and a count basis. Later inserts appear on
explicit refresh. A ceiling is not a time-travel snapshot across removals.
Collection file/note lists include current project revision; a mixed refresh
is rejected by the renderer. Bundle generation uses a single SQL read snapshot.

No Evidence tool is added to MCP or to the assistant. The existing manifest
remains 25 tools, 18 reads and seven confirmation writes; notes are not implicitly
sent to any model. Route counts describe declared surfaces, not proof that every
historical capability has been exercised.

## Reading and immutable passages

TXT/MD reuse Library's literal UTF-8 reader: at most 256 KiB, 5,000 logical lines,
no NUL, one logical page. Only CRLF/CR→LF changes the text projection; retained
bytes and Unicode composition remain unchanged. HTML, Markdown and links stay
literal. A text projection has the `library-text-lf/v1` extraction contract.

PDF input is at most 16 MiB and 200 physical pages. The existing Library 64 MiB
import limit is unchanged: a larger retained PDF is explicitly unreadable in-app.
One fixed pypdf 6.18.1 child receives only already-verified bytes and one requested
page. The parent owns a 20-second timeout, bounded pipes, cancellation and exact
process reaping. Child output is at most 200,000 codepoints and 1 MiB of JSON.
The page tree is bounded to 2,000 root-inclusive nodes and depth 32; form
invocations to 100. Public configuration limits declared/decoded streams and
image buffers to 8 MiB, zlib recovery input to 1 MiB, flate columns to 16,384 and
row length to 1 MiB, XMP input/elements to 1 MiB/10,000 and outline entries/depth
to 1,000/32. `jbig2dec_binary=None`; no image, attachment, XMP or outline extraction
API is called. Strict parsing or parser warnings refuse rather than save
silently shortened text. Encrypted files, including empty-password encryption,
refuse without password collection. No extras, OCR or external decoder is added.

The fixed child uses an empty owned directory and a minimal environment; it has
no app database handle, arbitrary command/path input or credential environment.
The interface, audit hook, configuration, output bounds and timeout do not prove
a portable hard RSS ceiling or OS/network sandbox. Aggregate parsing can still
exceed nominal stream budgets. The parent permits one child at a time, with no
automatic retry, and reaps it on completion, failure or cancellation.

PDF page statuses are `extracted`, `no_text`, `unsupported`, `malformed`,
`limit_exceeded`, `timeout` or `unavailable`. Text results identify requested page,
page count when known, examined pages and all remaining pages as `not_examined`.
No text is not evidence of no content. Canonical extraction can omit or reshape
columns, equations, images and tables; it makes no scientific completeness claim.
PDF extraction contract: `pypdf-6.18.1/plain-lf/v1`.

PDF.js 6.3.289 displays one canvas with at most four million pixels/16 MiB. Zoom
reduces resolution where needed. It uses an actual version-matched local worker,
terminated on close, selection change, failure or a 20-second rendering timeout;
there is no fake-worker fallback. XFA, WASM, system fonts, worker fetching,
autofetch, streams and ranges are disabled; parsing stops at errors. CMaps and
standard fonts are local. Rendering disables annotations and provides no viewer,
action/link/form/attachment layer. Unsupported codecs can make the image fail
while canonical text remains available. The sole CSP addition is local
`worker-src 'self'`. Canvas geometry never defines saved text offsets.

A passage records physical/logical page, extraction contract, page-text SHA256,
start/end Unicode codepoint offsets and exact quote, joined to vault/project/
file/version and retained-byte digest. Quote and body each allow at most 20,000
codepoints; a passage body may be empty, a plain-note body must not be empty.
The backend re-reads verified bytes and recomputes the exact hash/quote/range
before the transaction, then rechecks membership, revision and cancellation
before insert. Body editing never modifies an anchor. Reopening displays saved
text even when bytes are missing; highlighting requires the same contract, hash,
page and exact range. Mismatch remains unresolved, without fuzzy reanchoring or
latest-version fallback.

## Selected portable bundle

Select 1–20 distinct current file versions in one project. Metadata-only is the
default and explicitly says retained bytes were not checked. Optional file mode
rehashes every included retained descriptor against the captured identity while
streaming into an owned spool. Missing, corrupt, over-limit or cancelled input
cannot become a completed partial archive. A consistent SQLite read snapshot
captures project revision, membership, file metadata and all notes for exactly
the selected versions. Removed or unselected members are excluded.

The only ZIP entries are `manifest.json`, `notes.md` and, in file mode,
`files/<file_uuid>/<version_uuid>.<pdf|txt|md>`. Paths are generated from validated
identity/media fields; user names are values only. Markdown escapes user syntax
and uses fences longer than literal backtick runs. There are no absolute/private
paths, unrelated settings/corpus/session rows, credentials, route locators or
native runtime IDs. Limits: 256 MiB retained bytes, 4 MiB manifest, 4 MiB notes.
Both actual stream counts and captured metadata are checked. Temporary spools
are owned and cleaned on error, cancellation, completion or abandoned response.

The manifest identifies `format=evidence-bundle`, `version=1`, random bundle ID,
capture time, mode, vault, project UUID/name/revision, selected file/version/
SHA256/size/media/name, optional safe content path, exact saved note records and
verification status. Rehashed bytes do not imply re-extracted passages. UUIDs and
hashes are portable identity, not permission to attach the bundle to another
live database. This is not encrypted backup/restore or a redistribution-rights
judgment. Review selected files, original names and notes before sharing.

## Verification and distribution

`test_evidence*.py` uses authored SQLite/filesystem/parser/socket fixtures and
labelled failure injection. `e2e/evidence.spec.ts` exercises the actual desktop
journey with isolated source/state/profile and scripted native destinations.
The five ordinary local gates and e2e typecheck remain required. A requirements
change also triggers the existing four-target sqlite-vec packaging probe; its
success is not proof of a reader journey on all packaged platforms.

There are 188 pinned PDF.js/CMap/font/notice source assets, 3,700,085 bytes.
Webpack preserves all publisher bytes. Only the two built module filenames map
from `.mjs` to `.js`, allowing the unchanged renderer HTTP server to assign its
existing JavaScript MIME type. Both remain native ES modules; this is not a
source modification, transpilation or extra asset. The scoped loader preserves
native `import()` rather than CommonJS require. No npm PDF runtime, native
canvas, package scripts, Node upgrade or new build dependency is used.

See [third-party notices](../third-party-notices.md) and the exact asset-hash
assertion in `src/__tests__/pdfjs.test.ts`. Installer launch/release verification
and independent acceptance remain separate from implementing-session tests.


## Selected answers (schema 18)

The separate [selected-answer contract](selected-evidence.md) adds seven explicit
preview, answer, event, history and selected-text export routes. The original
12 Evidence routes retain their request, origin, storage and effect contracts.
Schema 18 adds one answer table and its project-order index without backfilling
or rewriting existing Evidence records. Selecting a passage does not select its
note body; answers have separate consent and history from ordinary Ask.
