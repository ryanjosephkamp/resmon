---
layout: post
title: "resmon Update 19 — September 6, 2026"
date: 2026-09-06 01:00:00 -0400
categories: [updates]
---

# Update 19 — The Same Paper, Twice

## Metadata

- **Update number:** 19
- **Version:** 1.9.0 → 1.9.1
- **Theme:** resmon notices when it has found the same paper twice, and tells you whether a routine is finding what you meant

## The short version

Two things, both built on the embeddings v1.9.0 added.

**resmon now spots the same paper reaching it from two places** — an arXiv preprint and its
Crossref publication, a bioRxiv record and its PLOS version — and says so on the result. It
**never merges them**. Both records stay, both counts stay, and collapsing them into one row
is a switch you turn on, not something that happens to your list.

**And every routine can now be asked "is this finding what I meant?"** It shows the results
sitting furthest from what the routine is for, and papers already in your corpus that the
routine never returned.

## Why the duplicate rule took three tries

This is the part worth reading, because the first version of it was almost useless and the
number says so.

The obvious rule is: two papers are the same work if their titles match and their text is
close. That was built, run against a real 15,707-paper corpus, and thirty of the pairs it
produced were graded by hand. **Three were right. Twenty-seven were wrong** — a precision of
10%.

Twenty-five of the twenty-seven were the same thing: **journal front matter**. Crossref emits
a record for every issue of every journal, titled `Editorial Board`, `Issue Information`,
`Untitled`. Every pair of those has an identical title and an identical vector, and none of
them is the same work as any other.

The reason is worth stating plainly, because it is a mistake that looks like a feature. A
paper with **no abstract** is embedded from its title alone — so its vector *is* its title.
"Similar titles **and** close vectors" is then **one signal counted twice**, dressed up as
two. Nearly 3,000 of the corpus's papers are in that state.

So the rule now requires that both papers actually have an abstract before a title match
counts. A shared DOI is exempt, because a DOI names a work and needs no corroboration.

Measured again on two **fresh** samples — fresh because a score read off the sample that
chose the thresholds is a score fitted to itself — precision is **83% and 87%**.

And one more thing was tried and rejected. On the second sample the remaining errors
separated perfectly at a particular distance, and tightening the rule there would have taken
it to near-100%. On the third sample the same errors straddled that line while genuine pairs
fell the wrong side of it. So it was not adopted. A threshold that looks clean on one sample
and not the next is a threshold fitted to a sample.

Every remaining error, in both samples, is one boilerplate title an archive puts on unrelated
deposits.

## What the duplicate feature will not do

- **It will not delete or merge anything.** Ever. The corpus is worth having because it keeps
  what each source actually said, in that source's own words, with that source's own terms.
- **It will not hide a row unless you ask.** `Collapse duplicates` starts off. When you turn
  it on, the count above the list **does not move** — it still says how many papers matched —
  and the folded row says what it is standing in for. Turning it off brings everything back.
- **It says which kind of claim it is making.** `same DOI` is an identifier. `likely
  duplicate` is an inference from wording. Those are not the same strength of evidence and
  the badge does not pretend they are.

## The coverage audit

Under each routine: **Is this finding what I meant?**

It compares every paper the routine has returned against an **intent** — a sentence in your
own words describing what you actually want. Then two lists: the results furthest from that
intent, and papers **already in your corpus** that this routine never returned. The second is
usually the useful one; it is a keyword gap you can close.

Three things it is careful about.

**It says where the intent came from.** If you have not written one, it uses the routine's
keywords and tells you so — comparing a query against the results that query produced is
measuring it against itself, and reading that as a clean bill of health would be wrong.
Writing one sentence turns it into a real check.

**The cutoff is drawn from the routine's own results**, not a fixed distance, because a fixed
number means different things for different models and different subjects. With fewer than a
dozen embedded results it declines to draw one at all and says why, rather than dressing up a
guess as a measurement.

**resmon can only compare against papers it already holds.** This is the one that matters.
resmon has no idea what exists in the literature and is not in your corpus. "Missed" means
*this routine missed it and something else found it* — never *resmon missed it*. That sentence
appears everywhere the audit does.

Distance is not relevance, either. The model has not read the papers. The far end of the list
is a prompt to look, not a verdict, and it is worded that way.

## Also

- A corpus-wide duplicate scan takes about four minutes on 15,000 papers and runs when you
  ask for it. Sweeps read the links that exist; they never start a scan.
- Reports gain a section listing the pairs, which states in as many words that no count above
  it was adjusted.
- A bug found while building this: titles were compared by stripping everything that is not
  ASCII, which read **every Japanese title as zero words** — so an entire source's papers
  could never be linked, silently. NDL Search is one of resmon's 25 sources.
