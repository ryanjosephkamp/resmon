# Reading Queue Page — Info Doc

## Page Overview

### Purpose

The Reading queue is where a paper goes when the user decides they want to read it. resmon
could already find papers and export a whole run's references; it had nowhere to keep the
handful out of a run that were actually worth reading. The page holds **membership over the
corpus** — which stored papers were saved, and whether they have been read — and nothing else.

It deliberately holds no notes, no PDFs, no reminders, no tags and no ranking. Each of those
absences is a decision: a queue that quietly becomes a reference manager is one a user stops
trusting to be complete.

### Primary User Flows

1. Open a run in **Results & Logs**, switch to its **Papers** tab, and save a paper with
   `Save to read`.
2. Open **Reading queue** from the sidebar. It opens on **To read**; **Read** and **All** are
   the other two filters, each showing its count.
3. `Mark read` / `Mark unread` on a row moves it between the two states.
4. `Remove` takes the paper out of the queue. The paper itself is kept.
5. Tick papers and export them as **BibTeX**, **RIS** or **CSV** through the same exporter
   Results & Logs uses.
6. Open `Why am I seeing this?` on any row for the same match evidence the Explorer shows.

### Inputs and Outputs

- **Inputs:** the filter buttons, per-row state and removal buttons, row checkboxes, and the
  pager. `GET /api/reading-queue?status=&limit=&offset=` supplies the list.
- **Outputs:** membership rows written to `reading_queue`, and a reference file downloaded
  through `POST /api/export/references` with the selected document IDs.

### Known Constraints or Permissions

- **Nothing on this page deletes a paper.** `Remove` deletes one membership row; the document,
  its authors, its provenance and every run that found it are untouched, and it remains in the
  Explorer. The only route that deletes papers is Settings → Advanced, which the user operates.
- **Saving is idempotent and never resets state.** A later run rediscovering the same stored
  record, saved again, keeps the state the user gave it — including `Read`.
- **Identity is the stored document ID.** Two records that look like the same work stay two
  entries, on the same rule that makes resmon link near-duplicates rather than merge them.
- **Selection is per page.** The export covers the papers ticked on the page in view; changing
  the page or filter clears the ticks, and a paper that leaves the visible page after a state
  change stops being selected.
- **An upgraded database starts the queue empty.** resmon never observed which papers a user
  meant to read before schema 14, and will not infer it from execution history.
- Page size is 50 by default; the backend refuses a `limit` above 200.

## Frontend

### Route and Main Component

- Route: `/reading-queue`, declared in `resmon_scripts/frontend/src/routes.ts` and rendered
  from `App.tsx`'s `PAGE_ELEMENTS`. Sidebar entry: **Reading queue**.
- Main component: `resmon_scripts/frontend/src/pages/ReadingQueuePage.tsx`.

### Child Components and Hooks

- `PaperCard` (`components/Reading/PaperCard.tsx`) — one stored paper, rendered identically
  here and in the run's Papers tab. Renders `url` as a link only for `http`/`https`.
- `ExecutionPapers` (`components/Results/ExecutionPapers.tsx`) — the Papers tab of a run: a
  page of the run's stored papers with their `queue_status` and a `Save to read` button.
- `WhyThisPaper` (`components/Explain/WhyThisPaper.tsx`) — the existing evidence panel, given
  the corpus document ID; the Papers tab additionally passes the execution ID so the
  explanation is scoped to that run.
- `PageHelp` — the collapsible "About this page" panel.
- `readingQueueApi` (`api/readingQueue.ts`) — the four queue calls and the papers call.
- `downloadReferences` (`lib/referenceDownload.ts`) — shared with Results & Logs, so both
  pages make the same request and turn the same failures into the same sentence.

### UI State Model

- `filter` / `offset` drive the request; `viewRef` holds the same pair for callbacks that
  complete later. A mutation refreshes **the view current when it lands**, not the one that
  was current when it was clicked.
- `requestId` makes the most recently issued list request the winner, so a slow earlier
  response cannot replace a newer page.
- The effective selection is **derived from the rows on screen** (`visibleSelected`), not held
  independently of them: counts, the select-all state, the export body and the export buttons'
  enabled state all read from it, so what is exported and what the user can see ticked cannot
  come apart. The stored set is additionally pruned to the page on every successful load.
- State on screen is state a response confirmed. A failed load, state change, removal or
  export shows the backend's message and leaves the rows as they were.

## Backend

### Endpoints

| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/reading-queue` | One page of entries with the stored document, `total` for the filter and `counts` for all three. `status` is `to_read`, `read`, or `all`/omitted. Order is `saved_at` then `document_id`, both descending. |
| POST | `/api/reading-queue` | Saves `{"document_id": n}`. Idempotent — an already-saved paper is returned unchanged, original `saved_at` and all. 201 either way; 404 for an unknown document. |
| PUT | `/api/reading-queue/{document_id}` | `{"status": "to_read"｜"read"}`. Sets `read_at` when a paper becomes read, clears it when it stops being read. A request that changes nothing writes nothing. 404 when not in the queue, 400 for an unknown status. |
| DELETE | `/api/reading-queue/{document_id}` | Removes the membership row only. 404 when there was nothing to remove. |
| GET | `/api/executions/{id}/documents` | One page of a run's stored papers with their corpus IDs and `queue_status`. |

Export reuses `POST /api/export/references` with `document_ids`; there is no separate export
route, and the formats and output-wide citation-key allocation are the existing ones.

### Module and Storage

- `implementation_scripts/reading_queue.py` — every read and write to the one table, plus the
  status constants and page-size limits the HTTP layer validates against.
- Schema **14** adds `reading_queue(document_id PRIMARY KEY, status, saved_at, updated_at,
  read_at)` with `idx_reading_queue_status_saved` over `(status, saved_at DESC, document_id
  DESC)`. Two CHECKs: `status IN ('to_read','read')`, and `read_at` set exactly when the paper
  is read. `document_id` references `documents(id)` **ON DELETE CASCADE**, so the
  owner-operated corpus erase cannot leave a saved paper that no longer exists.
- The migration is additive and backfills nothing.

## Verification

- `verification_scripts/test_reading_queue.py` — the queue over a real backend on a real
  socket: identity, state effects, refusals, concurrency, removal, the corpus-erase cascade,
  export through the shared serializer, and a restart.
- `verification_scripts/test_reading_queue_upgrade.py` — schema 14 over a committed
  schema-13 fixture built by the previous release's own code, including the full-text triggers
  and the search behaviour that depends on them.
- `frontend/src/__tests__/ReadingQueue.test.tsx` — the interface claims only what a response
  said, including the selection and delayed-completion cases.
- `frontend/e2e/reading-queue.spec.ts` — the journey in the real Electron app over a 51-paper
  authored run, with the same two continuity cases.
