---
layout: post
title: "resmon Update 9 — August 30, 2026"
date: 2026-08-30 12:00:00 -0400
categories: [updates]
---

# Update 9 — resmon Tells You the Truth

## Metadata

- **Update number:** 9
- **Version:** 1.6.1 → 1.7.0
- **Theme:** trust — knowing when your monitoring has stopped working, and what your results actually mean

## The short version

Every literature monitor competes on finding papers. None of them tell you when the
finding has stopped working.

That is the gap this release closes. A monitor fails *silently*: when a source starts
refusing queries, or an API key expires, or a scheduled routine quietly stops firing,
what you see is an empty inbox — exactly what you see when the field is genuinely quiet.
Silence is the output of both a working monitor and a broken one, and until now resmon
left you to tell them apart unaided.

1.7.0 adds four features, and one idea runs through all of them: **resmon should never
tell you something it cannot support.** Each is defined as much by what it refuses to
claim as by what it reports.

## The watchdog

A new page that compares every source and every routine against baselines built from
your own history, and says where reality has departed from them.

Findings come in two grades, and the difference is the point:

- **Broken** — something resmon *recorded happening*. A source that raised an error on
  each of its last three runs. A credential a source requires that is not configured. A
  routine that has not fired when its own history says it should have. These are stated
  as certainties because they are certainties.
- **Looks unusual** — an inference from your own baseline. A source that reliably
  returned papers has returned none several runs running. These are stated as questions,
  always with the baseline and the sample size attached, because the innocent
  explanation — the field went quiet — is genuinely possible every time.

Thresholds are deliberately conservative and **printed in the interface**, so you can
judge for yourself whether silence from the watchdog means anything. Everything it
*cannot* yet judge is listed too: a watchdog that is quiet because all is well and one
that is quiet because it has three data points look identical otherwise.

Findings can be muted individually, and a mute expires when its condition clears — so if
the same source fails again later, you are told again.

It also gives **cadence advice** from resmon's own discovery-lag data: if a routine runs
daily against a source that takes a median of six days to index, running daily costs
requests and buys nothing.

When we tested this against a real four-month corpus of 15,645 papers, it found six
things — including a routine that had silently stopped firing five weeks earlier while
its two siblings kept running. Nothing in the app would have said so.

## Why am I seeing this?

Query tuning has always been done blind: change a term, wait a week, guess from what
arrives whether it helped.

Every result in the Explorer now carries a **Why am I seeing this?** panel showing which
of your keywords actually appear in that paper, and where — title, abstract, subject
categories, or author list. Matching is on whole words, so `AI` does not match `said`.

Corpus-wide, the Analytics page gains **which keywords earn their place**: how many papers
each keyword found that no other keyword of yours did. A term whose every paper another
term also finds is costing a slot in every query and buying nothing — and that is
invisible without the arithmetic.

**What it refuses to claim matters as much.** resmon cannot know why an upstream source
returned a paper — most sources rank by relevance rather than filtering on literal terms —
and it stores no full text. Both limits appear on *every* explanation, including ones
where every keyword matched, rendered beside the evidence rather than hidden behind a
tooltip. A keyword match makes a paper *plausible*; that is not the same as knowing the
source's reasoning.

There is exactly one source resmon speaks about with certainty: bioRxiv/medRxiv has no
keyword search of its own, so resmon does the filtering and knows precisely why a paper
is in the set.

## Corpus lifecycle

Your corpus has always been frozen at the moment resmon found each paper. A paper you
read in March can be retracted in June and nothing would say so — and discovering after
submission that work you built on was retracted is a career-grade problem.

resmon now checks three things:

- **Retractions and expressions of concern**, through Crossref, which has distributed the
  Retraction Watch database openly since 2023.
- **Preprints that have since reached a journal**, so you can cite the peer-reviewed
  version.
- **Newer versions** of papers you hold, on both bioRxiv and arXiv.

**resmon never asserts a lifecycle event on its own authority.** Every finding carries a
link to the notice behind it, and one that cannot produce a link is refused at the
database layer — it cannot be stored, let alone displayed. A false retraction flag is
defamatory, and "we inferred it from the metadata" is not a defense.

The publisher's own wording is kept verbatim, an expression of concern is graded *below* a
retraction and said to be weaker, and a correction renders as the routine scholarly
upkeep it is. Coloring a correction like a retraction would teach you to ignore the
color — after which the retraction goes unread too.

Coverage travels with the findings. An empty list over an unchecked corpus means *nobody
looked*, not *nothing has been retracted*, and the page says which. Papers with no usable
identifier are counted separately rather than quietly treated as clean.

This is the only part of resmon that makes outbound requests without you starting a
search, so it runs only when you ask.

## The reproducible search record

Every systematic review's methods section requires the same account of a search — exact
terms, sources queried, per-database retrieval counts, deduplication figures, date, and
software version — and it is assembled by hand in spreadsheets essentially everywhere.

resmon has recorded all of it since the beginning. Any execution now exports it as JSON or
as a Markdown document shaped for a **PRISMA 2020** flow diagram.

The work here is the labeling, not the layout. resmon's counters do not map cleanly onto
PRISMA's boxes, and printing them under PRISMA headings would publish a claim resmon
cannot support:

- Cross-source duplicates are reported as **found**, never **removed** — resmon flags the
  overlap and keeps both copies, so "duplicates removed" would describe an operation that
  never happened.
- "Already held from an earlier run" has **no PRISMA box at all**. It is an artefact of
  monitoring over time rather than running a single search, and the record says so.
- A figure that was never measured reads **not recorded**, never `0`, because a reviewer
  reads `0` as a measurement.

Sources that were selected but contributed nothing stay in the record, naming why. A
strategy listing a database as searched when its key was missing overstates its coverage.

## Also in this release

- **The Danger Zone now tells the truth.** Until this release *nothing* there deleted a
  single paper — not "Erase all app data", and not even **Factory reset**, which on a real
  install meant tens of thousands of papers surviving a reset that claimed to erase
  everything. There is now a dedicated **Erase the paper corpus** action; "Erase all app
  data" and "Factory reset" include the corpus, because their names already claimed it;
  and every remaining action states explicitly whether your papers are affected.
- **Credentials report themselves honestly.** An unreadable keychain entry is reported as
  unreadable rather than as "no key set", with a breaker bounding the stall.
- **Page help starts collapsed**, instead of greeting you expanded on every page.
- **Lifecycle checks batch properly** — Crossref forty DOIs at a time, arXiv fifty ids at
  a time — so a fifteen-thousand-paper corpus is a few hundred requests rather than
  fifteen thousand, with a "check everything" option and a cooperative stop.

## Verification

- **485 backend tests**, plus a `live_network` test that pins the Crossref contract
  against the real API, so a change there fails loudly instead of going quiet.
- **111 renderer tests.**
- CI green on Python 3.10, 3.11 and 3.12.
- **No new dependencies.** Four features, zero additions to the dependency tree.
- Database schema 5 → 8, with migrations that backfill from data already on disk: existing
  installs get watchdog history and deduplication figures on first launch rather than
  starting from nothing.

## Installing

Same as 1.6.0 — DMGs for Apple Silicon and Intel, a Windows installer, and a Linux
AppImage, published automatically on the release. Windows and Linux installs update
themselves; macOS builds remain unsigned pending Apple Developer enrolment, so the README
covers the Gatekeeper steps.
