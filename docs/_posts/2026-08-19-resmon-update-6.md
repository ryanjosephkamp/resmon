---
layout: post
title: "resmon Update 6 — August 19, 2026"
date: 2026-08-19 12:00:00 -0400
categories: [updates]
---

# Update 6 — Analytics: What Your Corpus Can Tell You About Itself

## Metadata

- **Update number:** 6
- **Update type:** feature
- **Date:** 2026-08-19
- **Version:** 1.3.0 → 1.4.0
- **Scope:** analytics, reference exports, Electron security

## Summary

resmon has always recorded a great deal about every paper it finds — the source, the
DOI, the authors, the publication date, the subject categories, whether the paper was
new to you at the time, and the moment resmon itself first saw it. Until now it did
almost nothing with any of it: a list, a count, and a Markdown report.

This release adds an **Analytics** page that answers four questions from data already
on your disk, and **BibTeX / RIS / CSV export** so the papers a sweep finds can go
straight into a reference manager.

Nothing on the Analytics page queries a repository. Opening it costs no API quota and
works offline.

## Motivation

Two of the questions here are ones a researcher cannot easily answer any other way.

**Which of your repositories are actually earning their place?** resmon can query
fifteen sources. Some of them will be re-reporting papers that another source already
gave you. Every one of those costs time and rate-limit budget on every single sweep,
and contributes nothing. Nobody can tell you which, because it depends entirely on what
*you* search for.

**How long does each source take to surface a paper?** This one resmon is unusually
placed to answer. Because it stamps `first_seen_at` itself, it knows how long each
repository took to deliver a paper *to you* after that paper was published. No
repository publishes this figure about itself. It has a direct practical consequence: a
source with a two-week median will not deliver anything sooner because a routine runs
hourly.

## Changes

### The Analytics page

- **Which sources earn their place.** Per repository, papers that nothing else found,
  against papers that also arrived from somewhere else. Papers are identified across
  sources by DOI, falling back to a normalised title, because the same paper arriving
  from arXiv and OpenAlex is two rows by design. A source with almost no unique
  contribution is a candidate for deselecting.
- **How quickly each source surfaces a paper.** Median, fastest, and slowest days
  between publication and resmon first seeing it. Negative lags are kept rather than
  discarded — some sources date a paper later than they post it, and dropping those
  would flatter the source.
- **Routine health.** New results per run, per routine, with a sparkline and an explicit
  count of consecutive runs that found nothing. A routine marked **Quiet** has returned
  nothing new for several runs, which usually means its keywords are too narrow or its
  field has gone still.
- **Publication volume over time.** Papers per month, stacked by source or by subject
  category, with a legend and a table view of the same figures. A paper in two
  categories is counted in both. An undated paper stays in your corpus totals but is
  left off the timeline rather than assigned a guessed date.

### On figures that say "not enough data yet"

This is the part you will notice, so it is worth being explicit about the rule.

**Counts are always shown.** "Fourteen papers from arXiv" is true whether your corpus
holds fourteen papers or fourteen thousand, so there is no reason to withhold it.

**Averages and percentages are held back until they mean something.** A median of three
numbers is not a finding, it is three numbers. Below the threshold resmon shows the
count and what it still needs — "3 (needs 5)" — rather than printing a confident median
computed from almost nothing.

**A percentage of nothing is undefined, not zero.** DOI coverage on an empty corpus
shows an em dash. Rendering it as "0%" would be a claim about your data rather than an
admission that there isn't any yet.

The same applies to routines: one quiet run is not evidence that a routine is finished,
so resmon will not call a routine healthy or quiet until it has three completed runs.
Until then it says *"Too early to tell"* and states how many runs it needs.

The thresholds are deliberately low — five dated papers for a lag median, three runs for
a routine verdict. They exist to stop a single data point being presented as a trend,
not to withhold information from a small corpus. Every figure also carries the sample
size it was computed from, so nothing is hidden.

**On an empty corpus the page does not draw empty charts.** It explains what it will
show once you have run a search, and links to Deep Dive and Deep Sweep. An axis with no
data on it reads as breakage, not as emptiness.

### Reference exports

Results & Logs gains **BibTeX**, **RIS** and **CSV** buttons alongside the existing
export. These give you the *papers*, in the formats reference managers read, rather than
the report about them:

- **BibTeX** — LaTeX, Overleaf, JabRef, and Zotero's importer.
- **RIS** — EndNote, Papers, Mendeley, and most publisher sites.
- **CSV** — a spreadsheet, or your own scripts.

Selecting several runs produces one file. Papers with a DOI are exported as journal
articles and those without — usually preprints — as generic entries, because claiming a
venue resmon does not know would be worse than leaving it out. Cite keys are made unique
within a file, BibTeX special characters are escaped including inside URLs, and
abstracts are collapsed to a single line, since multi-line values break several
importers and RIS outright.

### Security

The Electron window no longer disables the browser's same-origin policy. That flag dated
from when the interface was loaded from a `file://` URL and could not otherwise reach its
own backend; the interface has since been served by a local HTTP server, which made the
flag unnecessary. Removing it was verified two ways: a cross-origin request succeeded in
a browser with the policy enforced, and the running app was observed issuing proper CORS
preflight requests — which a browser only sends when the policy is in force.

## Verification

| | Before | After |
|---|---|---|
| Backend tests | 404 | **423** |
| Renderer tests | 13 | **21** |
| CI | 3.10, 3.11, 3.12 green | unchanged, still green |
| Analytics endpoints | — | 6 |
| Export formats | Markdown, PDF, LaTeX | **+ BibTeX, RIS, CSV** |

The analytics tests treat the empty and thin corpus as first-class cases rather than
edge cases, because that is the state every new install is in.

## Follow-ups

- The Analytics page has no tutorial video yet; its entry shows the standard placeholder.
- Analytics are computed on each page load with no caching. On a few thousand papers this
  is instant. On a corpus a hundred times larger the author count walks every row, and
  that will want revisiting.
- The corpus-wide faceted explorer and cross-execution comparison described in the Phase 2
  plan are not in this release.
