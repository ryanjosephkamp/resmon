---
layout: post
title: "resmon Update 20 — September 6, 2026"
date: 2026-09-06 12:00:00 -0400
categories: [updates]
---

# Update 20 — Saying What You Meant

## Metadata

- **Update number:** 20
- **Version:** 1.9.1 → 1.9.2
- **Theme:** the coverage audit gets the one thing it was missing, and both of its lists stop pretending to be complete

## The short version

Update 19 shipped the coverage audit: ask any routine *is this finding what I meant?* and it
shows the results sitting furthest from what the routine is for, and papers already in your
corpus that the routine never returned.

It compares against an **intent** — a sentence describing what you are actually looking for.
There was nowhere to write one. Every audit therefore fell back to the routine's keywords,
which means comparing a query against the results that query produced. The panel said so, in
those words, and the reading was still circular.

**There is now a box in the routine editor.** *What this routine is really looking for* —
optional, one sentence, and the audit compares against it from the next time you open the
panel.

**And both audit lists now say how long they really are.** They show 25 papers. If there are
312, the list says *Showing 25 of 312* instead of stopping quietly at 25 and letting you read
that as the whole answer.

## Why the field was worth its own release

The audit's value is entirely in the gap between what you told resmon to search for and what
you actually wanted. Keywords are the first; the intent is the second. Without a place to
write the second, the audit could only compare the first against itself — and an honest label
on a circular reading is still a circular reading.

Writing one takes a sentence. *Methods for irregular time series in astronomy* is a different
statement from `time series AND astronomy`, and the difference is exactly what the audit is
looking for.

Nothing is filled in for you. resmon will not copy your keywords into the field: a routine
whose intent was written by resmon would claim you had stated one, and the whole point of the
distinction is that the app can tell you which of the two facts it used.

## The counts

A list capped at 25 with nothing said about the cap is a small lie of omission — it reads as
"there are 25", which is a number resmon never measured. Both lists now carry their total.

One of the two totals is honest in a further way. The off-target count is exact: it is drawn
from the routine's own results, all of which are ranked. The *missed in corpus* count comes
from a bounded query over the index rather than a scan of it, so when that query fills up with
papers still inside the range, resmon knows there are at least that many and does not know how
many more. It says **at least** in that case, rather than printing a precise number it did not
measure.

## Also in this release

Editing a routine now discards the cached audit for it, so writing an intent and reopening the
panel shows the new comparison rather than the previous answer.

For harnesses driving resmon over MCP, `create_routine` takes an optional `intent`, and
`get_routine`'s coverage counts are now the totals rather than the length of the page they
came from. Contract v1.3, additive; nothing existing changes shape.

## What has not changed

The audit still only compares against papers resmon already holds. It has no idea what exists
in the literature and is not in your corpus, "missed" still means *missed by this routine and
found by something else*, and that sentence is still printed under the lists rather than in a
footnote.
