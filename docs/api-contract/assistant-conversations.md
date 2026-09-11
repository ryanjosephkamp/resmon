# Saved conversations: browse, snapshot, export (v1)

The Chats page reads the existing schema-14 assistant tables. It adds no runtime,
permission or filesystem endpoint. Existing assistant list/write/permission routes
retain their contracts. The legacy list defaults to 50, ordered by updated timestamp
then ID descending.

`GET /api/assistant/sessions/browse` accepts `limit` (default 50, 1–100),
`before_id` (positive SQLite 64-bit integer), `through_id` (nonnegative SQLite 64-bit integer) and `q` (up to
200 characters). Absent `through_id` chooses the current maximum session ID, or 0.
Rows sort by ID descending, with `id <= through_id` and optional `id < before_id`.
The response contains `sessions`, `through_id`, `next_before_id` (nullable) and
`has_more`, derived by requesting one extra row. Each row includes ID, displayed
title, stored runtime/model/timestamps and message count. `q` is a parameterized,
literal substring over the displayed title (`New conversation` for absent/empty
stored titles); `%`, `_` and the escape character are escaped. SQLite folds ASCII
case; non-ASCII characters match literally. This freezes an ID ceiling, not row
contents, title membership or a historical total. Refresh includes newly created IDs.

`GET /api/assistant/sessions/{id}` preserves `session`, `messages`, `totals` and
`running`. The SQLite fields now share one read transaction, rolled back on exit.
A connection with pending writes is refused rather than committed or called persisted.
Additive `snapshot` fields: `captured_at_utc`, `basis=persisted_messages_only`,
`message_count`, `last_message_id` (null for no messages). Additive
`activity_observation` fields: `observed_at_utc`, `turn_claimed`, `cli_running`,
`basis=in_memory_observation_not_atomic_with_sqlite`. `running` still means the
registered CLI-process observation. None establishes historical completion.

`GET /api/assistant/sessions/{id}/export?format=json|markdown` returns a JSON envelope:
`session_id`, `format`, `filename`, `content_type`, `text`, and `snapshot`. Filenames
are `resmon-chat-<id>.json` or `.md`; MIME types are `application/json` and
`text/markdown`. Generated UTF-8 text may be at most 8 MiB per format. Larger output
returns 413 with an explicit refusal and no truncation. Missing sessions return 404;
invalid query parameters/format return 422. These reads do not require an available CLI.

Both serializers use the same snapshot helper. JSON version 1 contains an explicit
session allowlist (ID, stored title, runtime/model, created/updated strings), ordered
messages (ID, role, exact content, timestamp, nullable recorded tokens/cost), snapshot,
separately observed current activity, `completion_status=unknown` and limitations.
Each tool field is `{data, unreadable}`; absent storage has null data. Unparseable JSON
also carries `raw`, preserving the original stored text. No CLI coordination IDs,
settings, environment, config paths or unrelated chats are added as metadata. Saved
message/tool text is preserved even if it contains sensitive information. Review it
before sharing. Recorded cost is not a billing claim; null is not zero.

Markdown places every variable value inside a literal code fence longer than any
backtick run in that value. This preserves text while preventing it from becoming
active Markdown links or HTML. Framing is formatting, not file byte equality.
Neither format includes live-only fragments, pending cards, inferred approval/effect
history, current effort or a promise of final completion.

The renderer validates session/format/filename/type and JSON content identity before
requesting a Blob download. Changing selection invalidates a pending export. A download
request is not confirmation of a native save. Scripted Electron `setSavePath` checks
prove saved bytes separately from any human chooser observation.

Continue opens the same local session in the existing Ask provider without sending.
One active turn owns its session synchronously in this renderer. Other chats remain
browsable/readable/exportable; target changes/new chat/active-session deletion wait.
Opening the active session preserves its stream and cards. Stop sends the existing
cancel request and retains ownership until both that request and the stream reader
settle. History refresh follows settlement. Late selection, creation, permission and
stream callbacks cannot retarget a later selection. Another renderer's active claim is
an observation, not a reattachment feature; backend 409 remains visible.
