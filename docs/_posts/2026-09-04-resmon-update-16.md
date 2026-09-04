---
layout: post
title: "resmon Update 16 — September 4, 2026"
date: 2026-09-04 18:00:00 -0400
categories: [updates]
---

# Update 16 — Why Nothing Came Back

## Metadata

- **Update number:** 16
- **Version:** 1.8.5 → 1.8.6
- **Theme:** a source that returns nothing tells you why, or tells you it does not know

## The short version

**When a source comes back with zero results, resmon now says why — on the monitor while the
run is happening, on the results row afterwards, in the report, and in the search record.**

Before this release every zero looked the same. A source whose endpoint was down, a source
that answered with something resmon could not read, a source that cannot filter your date
window at all, and a source in a genuinely quiet field all produced one row: `✓ done`, `0`.
There was no way to tell them apart, because by the time anything could look at them they
were identical.

## What you see now

Run a Deep Dive on ERIC with a two-week date window and the monitor says:

> ⚠ **No Answer** — ERIC filters by publication year only, so a window shorter than one whole
> calendar year cannot be answered. resmon did not widen your window.

An endpoint that is down says:

> **arXiv could not be queried: HTTP 503 after 3 attempts. This is not a zero — the source did
> not answer.**

A source that answered and genuinely had nothing says so too, and keeps its green tick,
because that is a real measurement and not a fault:

> CORE answered (HTTP 200) and resmon found no records in the reply.

The results row carries a one-line summary — *2 of 5 sources could not answer* — with a link
straight into the search record, where each source's sentence sits under the table.

## The rule, because it is the whole point

**A zero reason is either a recorded fact with a named source of truth, or it is "not
recorded". There is no third state.**

resmon will not infer why a source was quiet. It knows what its own HTTP calls did, it knows
when a client refused to send a query at all, and it knows when a reply would not parse.
Anything beyond that would be a plausible story rather than an observation, and a wrong
explanation is worse than none — it stops you looking.

## Runs from before this release carry no reason, and say so

This is the part to know before you go looking at your history.

Nothing was recording any of this until now, so **every execution you already have will say
"resmon did not record whether {source} answered on this run."** That is not a bug and it is
not going to fill in retroactively. There is no backfill and there will not be one: a reason
reconstructed after the fact for a run nobody observed is exactly the kind of confident guess
this release exists to remove.

Your search records will show those zeros as unexplained rather than as measured, and count
them separately from both the sources that answered and the sources that could not. New runs
carry the reason from the moment you upgrade.

## The search record stops overstating your coverage

This one matters if you cite resmon in a methods section. The reproducible search record
counted every completed source as one that *answered*, including sources whose endpoint had
returned an error — because resmon's clients degrade rather than failing your whole sweep, so
an outage was recorded as a completed run with zero results.

It no longer does. "3 of 5 sources answered" now means three sources actually replied, and a
new caveat names the ones that did not, because a search strategy listing them as searched
would be overstating its coverage.

## The watchdog can see two more kinds of breakage

The watchdog exists to catch monitoring that has silently stopped working. Two failure modes
were invisible to it, and both are now counted as runs where the source did not answer:

- **An endpoint that could not be reached.** Nothing raises, so this looked like a quiet field.
- **A reply resmon could not read** — a 200 whose body will not parse, a response format that
  changed underneath us.

Both count toward the same run of failures, so a source alternating between them cannot slip
past the threshold. The finding names which of the two it was, because being told your source
is unreachable when it is answering fine and has changed its format sends you looking for a
problem that is not there.

Neither counts as the last time that source answered successfully — a source down for a month
used to be reported as having answered an hour ago — and neither can be part of the baseline
of what a source normally returns.

**Thresholds have not changed**, and a window a source cannot answer is deliberately *not*
treated as a failure. ERIC refusing a two-week window is correct behaviour.

## Dates are not equally precise everywhere, and the Repositories page now says so

Every source's detail panel gains a **Date Filtering** row: the finest date precision
resmon's query to that source can express.

Most take exact dates. NASA ADS takes whole months. DataCite, DBLP, ERIC, Open Library and
Semantic Scholar take whole years. Two of those **refuse** rather than widen: ERIC and Open
Library expose only a publication year, so a window shorter than one calendar year cannot be
answered at all, and resmon does not quietly widen a window you did not ask it to widen.

If you have ever run a short-window search against either and wondered why it came back empty
— that was why, and now the run tells you.

## Also in this release

- **The live activity log stops printing internal event names at you.** A repository skipped
  for a missing API key produced the literal text `repo_skipped_missing_key` in the log. It
  now says what happened and where to fix it.
- **The report's footer generalises.** It listed only repositories skipped for a missing key;
  it now lists every source that returned nothing, with the reason for each.
- **The MCP `get_search_record` tool** carries the reasons, and says when a run predates them.

## Upgrading

Nothing to do. No configuration changes, and nothing about how your routines run has changed
— this release only adds what resmon records and shows about a zero.

Windows and Linux update themselves. macOS builds are unsigned, so replace the app manually —
right-click → Open on first launch.
