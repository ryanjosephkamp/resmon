---
title: "Configuration"
summary: "Configuration types, the JSON shape they are stored in, and the export and import workflow."
order: 9
readmeLines:
  - "869-906"
---
## Configuration

resmon persists reusable search parameters as named rows in the `configurations` table and treats them as the primary unit of reproducibility for Deep Dive, Deep Sweep, and Routine runs. A configuration is a saved bundle of parameters — repository (or repository set), keywords, per-repository result cap, AI toggle and AI settings, email toggles, storage settings, and (for routines) schedule and execution-location fields. Date ranges are deliberately **not** persisted; they are chosen fresh per run or per routine fire so a saved configuration always produces a time-current window.

### Configuration Types

Every row carries a `config_type` constrained by a CHECK constraint to one of three values:

| `config_type` | Produced by | Consumed by | Purpose |
|---|---|---|---|
| `manual_dive` | Deep Dive page's **Save Configuration** action | Deep Dive page's **ConfigLoader** | Reusable single-repository query preset. |
| `manual_sweep` | Deep Sweep page's **Save Configuration** action | Deep Sweep page's **ConfigLoader** | Reusable multi-repository query preset. |
| `routine` | Routines page's create/edit modal | Routines page (restores everything except the date range) and the Calendar popover | Scheduled Automated Deep Sweep bound to a cron expression. |

Rows are keyed by an auto-increment integer `id`; names are not uniquely constrained, so multiple configurations with the same name are permitted. The Configurations page at `#/configurations` opens on the **Routine Configs** tab by default and exposes a **Manual Configs** tab that shows `manual_dive` and `manual_sweep` entries together.

### JSON Shape

The `parameters` column stores a JSON document whose shape matches the search page that produced it. Representative (non-exhaustive) field sets:

- **`manual_dive`** — `repository` (single slug), `keywords`, `max_results`, `ai_enabled`, optional `ai_overrides` (`length`, `tone`, `model`).
- **`manual_sweep`** — `repositories` (array of slugs), `keywords`, `max_results_per_repo`, `ai_enabled`, optional `ai_overrides`.
- **`routine`** — every `manual_sweep` field plus `cron_expression`, `email_enabled`, `results_in_email`, `notify_on_completion`, and a `linked_routine_id` pointing at the row in the `routines` table that APScheduler registers a job under.

Deleting a configuration whose `config_type` is `routine` cascades to the linked routine row when the stored parameters contain a valid `linked_routine_id` pointing at an existing routine; the delete-confirmation dialog surfaces the cascade count before the user confirms.

### Export and Import Workflow

The Configurations page supports a round-trip JSON workflow for moving presets between machines:

1. Select one or more rows via the per-row checkboxes or the select-all header checkbox.
2. Click **Export Selected** — the frontend sends `POST /api/configurations/export` with `{ ids: [...] }`; the backend writes a ZIP archive of individual JSON files through `config_manager.export_configs` and returns `{ "path": "<absolute path>" }`.
3. The success banner shows the archive path for 10 seconds; on desktop a **Reveal in Finder** (macOS) / **Reveal in File Explorer** button is rendered when the Electron preload has exposed `window.resmonAPI.revealPath`.
4. On the receiving machine, click **Import** and pick one or more `.json` files through the native file picker. Each file is validated — any file whose name does not end in `.json` short-circuits the entire batch with an inline error — and surviving files are POSTed as `multipart/form-data` to `/api/configurations/import`. The backend writes each upload to a temporary `.json` file and hands it to `config_manager.import_configs`, which validates the payload and inserts a new configuration row. The response carries `{ "imported": <n>, "errors": [] }`.
5. Click **Delete Selected** to open the confirmation dialog (which counts how many of the selected rows are routines so the cascade impact is visible). Confirming issues one `DELETE /api/configurations/{id}` per selected row; per-row failures are swallowed so the batch proceeds.

Imports are always additive: a new row is inserted with a fresh integer id. Nothing is overwritten, so round-tripping is safe to repeat.
