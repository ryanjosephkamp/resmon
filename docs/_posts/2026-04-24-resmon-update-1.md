---
layout: post
title: "resmon Update 1 — April 24, 2026"
date: 2026-04-24 12:00:00 -0400
categories: [updates]
---

# Update 1 — Config-Deletion Propagation Fix & Query Keyword Transparency

## Metadata

- **Update number:** 1
- **Update type:** mixed (bugfix + feature)
- **Date:** 2026-04-24
- **Author:** Ryan Kamp
- **Commit hash:** 707c07221f607297a7a919bd3f4d527a968832c8
- **Commit timestamp:** 2026-04-25T03:01:35-04:00
- **GitHub push timestamp:** 2026-04-25T07:01:45Z

## Summary

This update ships the first post-release change set for resmon. It fixes a frontend cache-staleness bug where deleted `manual_dive` / `manual_sweep` configurations continued to appear in the Deep Dive and Deep Sweep `Load Configuration` dropdowns, and it introduces a "Query Keyword Transparency" feature that surfaces, on every page where a user picks repositories, exactly how each repository's upstream API combines space-separated keywords. The feature also adds a consolidated, grouped, color-coded glossary on the Repositories & API Keys page and per-repository keyword-combination metadata in the catalog and on `.ai/prep/repos.csv`. Per-repository research replaces the previously lumped row for SSRN, RePEc, PLOS, DBLP, and IEEE Xplore (SSRN and RePEc are not in the active catalog and were therefore not added; PLOS, DBLP, and IEEE were classified individually).

## Motivation

Both items in this update originated in the user's first-after-release feedback session and map back to the change inventory in `.ai/updates/update_4_24_26/update_4_24_26_workflow.md`:

- **Bug — Improper Config Deletion** (workflow item #1, batch 1). After deleting a `manual_dive` or `manual_sweep` configuration from the Configurations page, the deleted entry was still selectable in the `Load Configuration` dropdown on the Deep Dive and Deep Sweep pages and could still auto-populate the form. The Routines page was unaffected. Root cause: the shared `ConfigLoader` only refetched on its `configType` / `refreshKey` props, neither of which changed when a deletion happened on a different page; there was no cross-page invalidation channel.
- **Feature — Query Keyword Transparency** (workflow item #2, batch 2). Users had no in-app indication of how each repository's upstream API combines keywords (some are implicit AND, some are implicit OR, several are relevance-ranked Lucene/Solr backends). The user requested per-repo banners on Deep Dive, Deep Sweep, and Routines, an enriched expander plus a glossary on the Repositories & API Keys page, the same metadata in `.ai/prep/repos.csv`, and individual research for the lumped row in `.ai/prep/keyword_booleans_overview.md`.

## Changes

### Batch 1 — Improper Config Deletion (cluster, shared root cause)

- `resmon_scripts/frontend/src/lib/configurationsBus.ts` *(new, 33 lines)* — tiny in-renderer pub/sub bus with `notifyConfigurationsChanged()` and `useConfigurationsVersion()` so any mutation site can invalidate every mounted `ConfigLoader` without page-to-page coupling.
- `resmon_scripts/frontend/src/components/Forms/ConfigLoader.tsx` — subscribe to the bus via `useConfigurationsVersion()` and add the version to the fetch effect's dependency array so deletions, saves, and imports anywhere in the app force a refetch.
- `resmon_scripts/frontend/src/pages/ConfigurationsPage.tsx` — call `notifyConfigurationsChanged()` after a successful delete and after a successful import.
- `resmon_scripts/frontend/src/pages/DeepDivePage.tsx` — call `notifyConfigurationsChanged()` after a successful "Save Configuration" so newly saved rows immediately appear in sibling loaders.
- `resmon_scripts/frontend/src/pages/DeepSweepPage.tsx` — same notify-on-save wiring as Deep Dive.

### Batch 2 — Query Keyword Transparency (single feature)

- `resmon_scripts/implementation_scripts/repo_catalog.py` — add `keyword_combination` and `keyword_combination_notes` fields to `RepoCatalogEntry` and populate them for all 16 active repositories, using "Implicit AND", "Explicit OR", "Relevance-ranked", or "Relevance-ranked (… upstream-default, unverified)" labels per the workflow's uncertainty policy. DBLP, IEEE Xplore, and PLOS are individually classified (replacing the previously lumped row); SSRN and RePEc are not in the active catalog and were therefore not added.
- `resmon_scripts/verification_scripts/test_repo_catalog.py` — extend `expected_keys` and add `test_keyword_combination_populated_for_every_active_repo`.
- `resmon_scripts/frontend/src/api/repositories.ts` — extend the `RepoCatalogEntry` TypeScript interface with the two new optional fields.
- `resmon_scripts/frontend/src/components/Forms/KeywordCombinationBanner.tsx` *(new, 42 lines)* — compact banner mounted under the repository selector on Deep Dive, Deep Sweep, and Routines that shows the keyword-combination label and notes for each currently selected repository, with a tooltip pointing to the consolidated glossary.
- `resmon_scripts/frontend/src/components/Repositories/KeywordSemanticsGlossary.tsx` *(new, 182 lines)* — consolidated, expandable glossary on the Repositories & API Keys page. Three categories ("Boolean combination", "Ranking & confidence", "Underlying search platforms"), each rendered as a color-accented section with a card grid of color-coded badge + short label + definition for every term ("Implicit AND", "Explicit AND", "Implicit OR", "Explicit OR", "Relevance-ranked", "upstream-default, unverified", "Lucene", "Solr"). Iterated through three visual formats during review; final layout is the grouped card-grid format.
- `resmon_scripts/frontend/src/components/Repositories/RepoDetailsPanel.tsx` — render the new "Effective Default Keyword Combination" and "Keyword Combination Notes" rows in the per-repo expander.
- `resmon_scripts/frontend/src/pages/DeepDivePage.tsx` — mount `KeywordCombinationBanner` for the selected single repository.
- `resmon_scripts/frontend/src/pages/DeepSweepPage.tsx` — mount `KeywordCombinationBanner` for each selected repository.
- `resmon_scripts/frontend/src/pages/RoutinesPage.tsx` — mount `KeywordCombinationBanner` in the Create/Edit modal for each selected repository.
- `resmon_scripts/frontend/src/pages/RepositoriesPage.tsx` — mount `KeywordSemanticsGlossary` above the catalog table.
- `.ai/prep/repos.csv` *(internal scaffolding, not tracked by git)* — extended with `keyword_combination` and `keyword_combination_notes` columns mirroring the catalog entries; per the user's directive this file is enriched in place rather than relocated.

### Out-of-Band Additions (T-UPD-ADD)

None.

## Verification

- **Backend unit tests:** `python -m pytest resmon_scripts/verification_scripts/test_repo_catalog.py -q` → `10 passed in 0.02s`. Includes the new `test_keyword_combination_populated_for_every_active_repo` and the extended `test_catalog_as_dicts_shape` `expected_keys` set.
- **Frontend production build:** `npm run build:renderer` (run from `resmon_scripts/frontend/`) → `webpack 5.106.2 compiled successfully in 5111 ms` after batch 2's components were finalized. Re-run after each visual iteration of the glossary; final iteration also compiled cleanly.
- **Manual UI verification:** the live Electron app (attached to the running daemon on `127.0.0.1:8742`) was used to verify (a) deleting a `manual_dive` config from the Configurations page makes it disappear from the Deep Dive `Load Configuration` dropdown without a reload, and the same for `manual_sweep` on the Deep Sweep page; (b) the keyword-combination banner appears under the repository selector on Deep Dive, Deep Sweep, and the Routines create/edit modal, and lists one row per selected repository with the correct label; (c) the consolidated glossary on the Repositories & API Keys page expands, renders three category sections with colored accents, and shows every defined term as a card; (d) each row in the catalog table exposes the two new entries in its expander.
- **Skipped tests:** none. No frontend Jest suite was run because the project does not currently maintain one for these surfaces; manual UI verification is the existing standard for renderer-only changes.

## Follow-ups

- Optional: add a Playwright/Jest smoke test for `ConfigLoader` cross-page invalidation so future regressions are caught without manual reproduction.
- Optional: confirm the "upstream-default, unverified" labels for DBLP, IEEE Xplore, and PLOS by directly probing each upstream search box; promote the labels to the unqualified form once verified.
- The cloud catalog mirror (if/when the cloud service serializes the catalog independently) will need the two new fields surfaced in its `/api/v2/repositories/catalog` response; not in scope for this update.
