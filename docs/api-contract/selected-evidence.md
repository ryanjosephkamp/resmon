# Selected-evidence answers, version 1

A project can send an explicit selection of retained file versions, physical PDF
pages, complete canonical text pages or exact Unicode codepoint passages to an
existing CLI/API connection. A manual briefing is the same bounded operation with
a different requested output mode. It is never scheduled. Opening a preview or
saved answer does not invoke a model. Each explicit Send admits one new domain
answer; it does not adopt or append to an ordinary Ask session.

## Selection and consent

Select 1–5 current file/version memberships, at most 12 distinct selected or
passage-note-anchor-checked pages and 24 distinct segments. Identical segments
collapse; overlapping or repeated occurrences remain distinct. Page text retains
the existing LF extraction contract. Passage offsets are global Unicode
codepoints with an exclusive end, never UTF-16 indices or fuzzy matches.

Optional owner-note bodies start unselected: at most 8 individually selected
notes, 2,000 codepoints each and 8 KiB total. A passage selection does not include
its note body. Note provenance means a saved local note, not authenticated
identity or document evidence. Note references cannot substitute for citations.

Source text has both a 48 KiB UTF-8 and 24,000-codepoint ceiling. The instruction
has 1–4,000 codepoints and a 16 KiB ceiling. The complete app user payload has a
96 KiB ceiling; the separately versioned application system payload has a 16 KiB
ceiling. Missing, corrupt, encrypted, unsupported, image-only or over-limit
selections refuse the entire preview. There is no silent truncation or omission.
Digest verification reads the selected retained file bytes; reaching a PDF page
examines its structure. Those reads do not establish whole-paper understanding.

The preview displays the exact source and note text, filenames, versions, page
coverage, public requested settings, limitations, system/user bytes and hashes.
Canonical JSON uses sorted keys, compact separators, literal Unicode, no
NaN/duplicate keys/lone surrogates. The request hash covers the payload without
its own digest. The user prompt is `{request_sha256,payload}`. Source hashes omit
only `source_id` and `source_sha256`; sources have deterministic S01–S24 IDs.

The backend owns previews: one assembly at a time, 120 seconds maximum, four live
previews, 512 KiB resident total, 600-second expiry. Send requires the exact
vault/runtime/preview/request hash plus `confirmed:true`; it re-extracts and
rechecks the selected SQL facts, route and rules before transactional admission.
An identical repeated consent returns the existing answer without another call.
An expired or restart-lost preview cannot be revived. Source strings are literal
untrusted data; there is no automatic secret-removal guarantee.

## Seven routes

Every route uses the existing Evidence origin/`X-Resmon-Library: 1` guards,
explicit vault identity, bounded request bodies and `Cache-Control: no-store`.
No selected-answer MCP tool is added. Paths below begin with
`/api/evidence/projects/{project_id}`.

| Method and suffix | Purpose |
| --- | --- |
| POST `/answer-previews` | Explicit selections/notes/instruction/mode/choices with expected project revision and runtime |
| POST `/answers` | Hash-bound consent; returns the admitted or replayed saved answer |
| GET `/answers` | Project-scoped ascending history, fixed ID ceiling, at most 50 rows per page |
| GET `/answers/{answer_id}` | Durable answer plus immutable request, selected excerpts and public reports |
| GET `/answers/{answer_id}/events` | One owned SSE subscriber; expected runtime required |
| POST `/answers/{answer_id}/cancel` | Cancel the exact owner/runtime operation |
| GET `/answers/{answer_id}/export?format=zip` or `format=html` | One explicit saved-answer ZIP or separate static HTML document |

SSE frames carry answer/request/project/vault/runtime identities and monotonic
sequence numbers. Initial state is a full saved snapshot, followed by bounded
progress/partial/report/terminal events. A subscriber must attach within 30
seconds. Disconnect/navigation, queue overflow or Stop requests cancellation.
Queued events are bounded to 16 frames and 256 KiB; there is no reconnect/resume
or automatic retry. Renderer responses are rejected on stale identities.

## Runtime and output

The `selected_evidence_v1` profile is optional in the two existing runtimes;
ordinary Ask rules and permissions retain their defaults. The CLI receives a
fresh native UUID, empty working directory, empty tools/MCP configuration, no
history/resume/slash commands/settings sources and the separate system asset.
Observed startup must report that exact UUID and explicit empty tools/MCP lists.
The three existing API families send one request with no tool declarations or
history, using existing configured authentication. Requested model/effort and
literal reported model observations remain separate; API effort is unsupported.
Offline fixtures establish these wire contracts, not native/live compatibility.

Operations have a 300-second publication deadline. CLI lines are limited to
256 KiB, aggregate stdout to 1 MiB and stderr to 16 KiB. API response bodies are
limited to 1 MiB with 10-second connect/write/pool and 60-second read-inactivity
timeouts; redirects, compression and retries are refused. Accepted model text is
limited to 64 KiB. Stop immediately prevents further publication; owned local
cleanup may take up to 65 seconds and keeps admission blocked until confirmed.
Unknown prior-owner cleanup remains a refusal. Local cancellation does not prove
remote cancellation, provider retention, billed cost or hidden native context.

Output is one strict JSON object: version, matching request hash/mode, status
`answer` or `insufficient_evidence`, sections and limitations. At most 6 sections,
36 items, 72 citations, 1,000 codepoints per quote, 20,000 visible codepoints and
nesting depth 8 are allowed. Section kinds are summary/details/limitations/questions.
Item kinds are source_statement/interpretation/note_summary/question. Source
statements and interpretations require exact selected citations; note summaries
require selected note IDs and cannot cite document sources. Unknown fields,
unsupported wrappers, invalid citations or missing explicit runtime completion
produce failed, unvalidated output without a model repair request.

A citation proves its selected text identity only. It never proves that the quote
supports a claim. The UI renders literal text and first shows the saved excerpt;
opening the existing reader requires an exact current version/hash/extraction/
codepoint check. Missing originals never cause a latest-version or fuzzy fallback.

## Durable state and export

Schema 17→18 adds exactly `evidence_answers` and
`idx_evidence_answers_project_order` (plus SQLite's implicit UNIQUE indexes).
There is no historical backfill or rewrite. The immutable request and private
owner binding are inserted at admission. Admitted/running rows have one terminal
CAS winner: succeeded/refused/failed/cancelled/interrupted. Checkpoints and ordered
reports are bounded; terminal updates preserve the final available prefix. A
restarted backend preserves the last durable prefix, records interrupted and
unknown completion/cleanup, and never automatically extracts, invokes or resumes.

There is a 1,000-answer project cap; refusal does not delete any answer. History
and export validate saved records without original-file or model access. Corrupt
rows are explicit unreadable refusals and are not repaired. Public projections
exclude route digests, configured paths, native session IDs and credentials.
Usage contains only reported token counts with provenance; billing stays unknown.

The ZIP contains exactly `answer.json`, `answer.md`, `evidence.json`, each at most
1 MiB and 4 MiB total uncompressed. It is one SQL snapshot with safe constant
paths, literal fenced Markdown and selected excerpts/notes/coverage. Partial and
terminal failures stay explicitly unvalidated. The download checks exact identity
headers, length and SHA256 before the browser flow; owned spools and object URLs
are cleaned. It is not a full-paper archive, encrypted backup or restore format.

## Portable HTML, selected-answer-html/v1

`format=html` extends that same guarded endpoint; omitted and unknown formats
refuse. Schema remains 18, with 165 app route decorators (19 Evidence routes,
including the same seven selected-answer routes) and unchanged 25-tool MCP
inventory. Export reads exactly one validated `selected_evidence.detail` public
snapshot, using its existing single read transaction. No originals, runtime,
private binding or native-session history is consulted.

The response is `text/html; charset=utf-8`, with fixed attachment filename
`selected-answer.html`, no-store, nosniff and the restrictive document CSP. Headers:

| Header | Value |
| --- | --- |
| `X-Resmon-Evidence-Contract` | `selected-answer-html/v1` |
| `X-Resmon-Vault` / `X-Resmon-Project` | Exact selected vault/project UUIDs |
| `X-Resmon-Bundle` | Saved answer UUID |
| `X-Resmon-Version` | Saved request SHA256 |
| `Content-Length` / `X-Resmon-SHA256` | Final UTF-8 byte count / SHA256 |

The final document, after escaping, is at most 4,194,304 bytes; app-authored CSS
is at most 65,536 bytes. Oversize returns `export_limit`/413 before advertising a
download. Cancellable render/write work uses the existing owned spool/chunks and
cleanup; a failure does not mutate saved rows or claim a complete file.

The renderer escapes every untrusted value as text, retaining CR codepoints with
character references. It emits only index-derived IDs and fragment links, native
details, semantic headings and wrapping system-font CSS. There are no scripts,
active resources, forms, interpreted Markdown, auto-linked URLs or embedded PDFs.
CSP is early in the file and also in HTTP: default/script/connect/image/media/
object/frame/font sources are none; base-uri and form-action are none; style-src
permits only the SHA256 of the exact authored CSS. Browser support for CSP is
additional defense, not the basis for accepting untrusted markup.

All seven saved states retain their validation, cleanup, timestamps and unknowns.
Structured results appear only after existing validation; other available text
is explicitly incomplete/unvalidated. Each citation targets its exact saved
source/quote/codepoint range and has a distinct return link. Selected notes,
source identities, coverage basis, requested settings, literal observations and
reported usage remain separate. No source URL becomes an external link.

The frontend validates exact headers/identities, bounded bytes, SHA256, UTF-8,
document envelope and owned cancellation before creating a download object URL.
It never inserts export HTML into the app DOM. Changing the answer/project/vault
retires the prior export and its status. The legacy three-argument
`downloadSelectedAnswer(project, answer, signal)` still selects ZIP. For an
identical saved snapshot, ZIP bytes, member order/names and public JSON/Markdown
remain unchanged; HTML is not inserted into the ZIP.

Checks: `test_portable_briefing.py`, additions to the selected export/boundary
suites and renderer download/view suites, and `e2e/portable-briefing.spec.ts`.
The latter uses real HTTP and scripted download destinations, then a separate
file reader after app shutdown with request observation/cancellation installed
before loading. It does not establish physical Android, human native Save/Cancel
or live-model acceptance. See [the reading guide](../portable-briefing.md).
