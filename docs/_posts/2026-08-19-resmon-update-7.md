---
layout: post
title: "resmon Update 7 — August 19, 2026"
date: 2026-08-19 18:00:00 -0400
categories: [updates]
---

# Update 7 — Explorer: Every Paper You Have Ever Collected, in One Place

## Metadata

- **Update number:** 7
- **Update type:** feature
- **Date:** 2026-08-19
- **Version:** 1.4.0 → 1.5.0
- **Scope:** corpus search, database indexing, reference export

## Summary

Update 6 gave resmon an Analytics page that could tell you which of your repositories
were earning their place and which of your routines had gone quiet. It could not,
however, show you a single paper. You could learn that arXiv dominated a category and
then have no way to read what was in it.

This release adds the **Explorer**: search and filter every paper resmon has ever
collected, across all executions and routines, and go straight from a number on a chart
to the papers behind it.

It also gives the database the indexes it has never had.

## Motivation

Until now, papers could only be looked at one execution at a time. That is the wrong
unit. An execution is a thing resmon did; a corpus is the thing you actually care
about. Questions like "everything from bioRxiv about protein folding since March,
regardless of which routine found it" had no way to be asked at all.

The second motivation is duller and more important. **`documents` had no indexes.** Not
one, beyond the uniqueness constraint that came free with the table definition. Every
filter resmon has ever run was a full scan of every row. At a few hundred papers that is
invisible; at a hundred thousand it is the difference between a tool and a wait.

## Changes

### The Explorer

- **Free text over titles and abstracts**, searched together, with the last word treated
  as a prefix so results narrow as you type.
- **Filter by source, subject category, author, and publication date range.** Each value
  shows how many papers carry it, so you can see what a filter will cost before applying
  it. Filters combine with AND: a paper must satisfy all of them.
- **Filters live in the address bar.** A filtered view can be bookmarked, reloaded, or
  sent to someone, and the Back button behaves.
- **Clicking a source or a category on the Analytics page opens the Explorer already
  filtered to it.** This is the point of the feature. Analytics tells you something is
  worth looking at; the Explorer is where you look.
- **BibTeX, RIS, and CSV export everything matching your filters** — not just the papers
  currently on screen. Filtering to a topic and exporting the whole set is the real use.

Empty states are distinguished, because they mean different things: *nothing matches
these filters* offers to clear them, while *nothing collected yet* points at Deep Dive.

### The indexes

Three pieces of work, each measured on a real 100,000-paper database rather than assumed.

**Free text uses a full-text index.** `LIKE '%term%'` has no usable prefix, so SQLite
reads every abstract in the table. The FTS5 index is declared *external-content*, so it
stores tokens and a row pointer rather than a second copy of every abstract, and triggers
keep it in step with inserts, updates, and deletes. Free-text search across a hundred
thousand papers: **10.8 ms**.

**Authors and categories are normalized.** They are stored as comma-joined strings, which
is fine for display and impossible to filter or count without reading every row. Two
indexed companion tables now carry them. The original strings are untouched — `documents`
remains the source of truth, and the new tables are derived from it.

### The pagination, which took three attempts

This is the part worth writing down, because the first two attempts were **slower than
doing nothing clever at all**.

The conventional wisdom is that `LIMIT 50 OFFSET 90000` is slow, because the database
walks and discards ninety thousand rows to reach the ones you asked for. So the first
implementation replaced it with a cursor: remember where the last page ended, and ask for
rows after that point.

It was slower. Measured at row 90,000 of 100,000:

| Approach | Query plan | Time |
|---|---|---|
| First cursor attempt | `SCAN` | 3.83 ms |
| Plain `LIMIT/OFFSET` | `SCAN` | 1.66 ms |
| Second cursor attempt | `SCAN` | 3.83 ms |
| **What shipped** | **`SEARCH`** | **0.30 ms** |

The first attempt compared the cursor with an `OR` of two conditions — *date is earlier,
or date is equal and id is lower*. That is logically correct and useless to the query
planner, which cannot turn it into a single seek. It scanned, and the extra condition
made it scan more slowly than the plain offset.

Rewriting it as a single tuple comparison fixed the logic but not the plan, for a
different reason: the sort key was an *expression*, and SQLite will not match this kind
of comparison against an index built on an expression. The fix was to make the sort key a
real generated column and index that. The plan changed from `SCAN` to `SEARCH`, and the
time fell by a factor of twenty.

**None of this was visible without measuring.** The first version looked correct, passed
its tests, and was slower than the code it replaced.

One further detail, because it would have failed silently: that sort key treats a paper
with no publication date as an empty string rather than a null. Compared against a real
null, a tuple comparison yields null — and **every undated paper would have disappeared
from the results with no error anywhere**. On the benchmark database that is 3,945 papers
that would simply not have existed. There is now a test that walks a mixed corpus and
asserts every paper is reached.

Facet counting had a smaller version of the same lesson: it was joining to a table it did
not need, since the link table's own key already held the answer. Removing the join took
it from 735 ms to 12 ms.

### Measured, on 100,000 papers

| Query | Time |
|---|---|
| First page, no filters | 0.32 ms |
| Free text | 10.8 ms |
| Author filter | 22 ms |
| Every filter at once | 25.6 ms |
| Facet counts, unfiltered | 52 ms |
| A page at row 90,000 | 0.30 ms |

Result totals above ten thousand are reported as "10,000+". Counting an unbounded match
set is the one query that cannot be bounded, and the exact five-digit number changes no
decision anyone makes.

## Verification

| | Before | After |
|---|---|---|
| Backend tests | 423 | **439** |
| Renderer tests | 21 | **27** |
| Indexes on `documents` | **0** | 5, plus a full-text index |
| CI | 3.10, 3.11, 3.12 green | unchanged, still green |

## Follow-ups

- Neither Analytics nor the Explorer has a tutorial video yet; both show the standard
  placeholder.
- Analytics is still computed on each page load without caching. The Explorer's indexes
  do not help it.
- The benchmark corpus is synthetic — a hundred thousand rows of realistic shape, but
  generated. Real abstracts vary more in length and real author names are far more
  diverse, which mostly makes the facet lists work harder.
