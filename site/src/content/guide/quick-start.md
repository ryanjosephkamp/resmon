---
title: "Quick start"
summary: "A first Deep Dive, a first Deep Sweep, and a first scheduled routine."
order: 7
readmeLines:
  - "616-669"
---
## Quick Start Guide

**On a brand-new install the Dashboard opens with a *Getting started* card.** It lists
three optional things — an agent CLI you already subscribe to, an AI provider key, and a
key for one of the few sources that wants one — with a link to where each is set, and a
mark showing what resmon can already see. None of them is required: resmon searches all
the unkeyed sources with no AI and no keys at all. The card reports **found** and **configured**
and never **working**, because resmon cannot tell whether a command is signed in or a key
accepted until the first paper goes through it. `Skip` puts it away permanently, and it
retires itself the moment you have run anything.

The following walkthroughs cover the three core workflows. Each flow assumes the app is running and that any required API keys for keyed repositories (CORE, NASA ADS, Springer Nature) are either stored under **Repositories & API Keys** or provided as ephemeral per-execution keys.

### Run a Deep Dive

A Deep Dive runs a targeted one-off query against a **single** repository.

1. Open the **Deep Dive** page at `#/dive`.
2. In the repository selector (single-select), choose one source.
3. Optionally restrict the date range with **Date Range** — note that the date range is intentionally **not** saved as part of a configuration and must be picked fresh for every run.
4. Enter one or more keywords in the chip-style **Keywords** input; keywords are joined with spaces to form the query.
5. Adjust the **Max Results** slider (range 10–500, step 10, default 100).
6. Optionally toggle **Enable AI Summarization**. When enabled, the *Override AI settings for this run* disclosure offers per-execution overrides for length, tone, and model; empty overrides fall back to the app defaults.
7. If the selected repository requires a credential that is not already stored in the OS keyring, enter an ephemeral key in the inline **Key Status** panel. Ephemeral keys are sent only in the request body and are never persisted.
8. Click **Run Deep Dive**. The page sends `POST /api/search/dive`, registers the returned execution id with `ExecutionContext`, and the floating widget begins streaming progress. When the execution reaches a terminal state, an **Execution #N** result card is rendered inline with counts and a **View Report** link to `#/results?exec=<id>`.

### Run a Deep Sweep

A Deep Sweep runs a broad one-off query across **multiple** repositories, one after another, then normalizes and de-duplicates the combined result set by DOI and by title + first author.

1. Open the **Deep Sweep** page at `#/sweep`.
2. In the repository selector (multi-select), choose every source to include.
3. Enter one or more keywords; the same query string is issued to every selected repository.
4. Optionally restrict the date range (again, not persisted by *Save Configuration*).
5. Adjust the **Max Results** slider — the cap applies **per repository**, so the merged result set can be up to `repositories.length × max_results` before de-duplication.
6. Optionally toggle **Enable AI Summarization** and its per-execution overrides.
7. For each selected repository that requires a credential, enter an ephemeral key in the inline Key Status panel if the key is not already stored in the keyring.
8. Click **Run Deep Sweep**. The page sends `POST /api/search/sweep` and registers the execution with `ExecutionContext`. The backend first calls an admission controller; if the concurrent-execution cap is reached, the server returns HTTP `429` with a `Retry-After: 5` header and a message that points to **Settings → Advanced** — this surfaces verbatim as the form error.

### Create and Activate a Routine

A Routine is a scheduled Automated Deep Sweep: the same multi-repository pipeline, bound to a saved configuration and a 5-field cron expression.

1. Open the **Routines** page at `#/routines` and click **New Routine** to open the create modal.
2. Enter a **Name** and choose a **Cron expression** (5-field `m h dom mon dow`, default `0 8 * * *`). Any configuration-related fields can be pre-populated by loading a saved `routine` configuration through the inline **ConfigLoader** — this restores everything except the date range.
3. Select repositories, enter keywords, and set an optional date range and a per-repository **Max Results** cap.
4. Set the per-routine flags as needed:
   - **AI** — enable AI summarization for each fire.
   - **Email** — email the report on completion (the global SMTP settings must be configured under **Settings → Email**).
   - **Results-in-Email** — include the AI summary inline in the notification email.
   - **Notify-on-Completion** — raise a desktop notification when a fire finishes.
5. Submit the modal. The routine is persisted via `POST /api/routines`, and APScheduler registers a job under the routine's id.
6. Manage the routine from its row in the routines table: **Activate/Deactivate** preserves the DB row while adding or removing the APScheduler job; the inline **Email**, **AI**, and **Notify** column toggles patch a single flag each; and if a fire is currently running, a **Cancel Run** button appears on the row and stops the live execution.
