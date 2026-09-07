---
layout: post
title: "resmon Update 23 — September 7, 2026"
date: 2026-09-07 09:00:00 -0400
categories: [updates]
---

# Update 23 — Watch a person, and know what that is worth

## Metadata

- **Update number:** 23
- **Version:** 2.0.1 → 2.1.0
- **Theme:** watching people instead of words, and refusing to pretend a name is an identity

## The short version

Until now a resmon routine watched **words**. If you wanted to know when a particular
researcher published, you guessed a keyword query that might catch them and lived with
whatever else it caught.

This release adds **watch profiles**: a person you point a routine at. A name, whatever
identifiers you have for them, where they work. A routine can then follow them for **new
papers**, or for **retractions on the papers already matched to them**.

And it adds the thing that makes that honest. **An author match is a string match unless the
source gave an identifier, and resmon says so on every paper.**

## Why that sentence is the whole feature

Scholarly sources do not agree on who anybody is. Most of them return an author's *name* and
nothing else. So "papers by Jane Doe" from such a source means "papers with the string *Jane
Doe* in the author field" — which includes every other Jane Doe who has ever published.

Nearly every tool that offers author monitoring quietly presents that as the person. resmon
will not. Every match records **how** it was made, and the badge says which:

- **ORCID match** — the source returned this profile's ORCID on this paper. This is evidence
  of identity.
- **name + affiliation** — a name matched and an affiliation on the record matched one of the
  profile's. That is not identity: another researcher with this name at this institution would
  match too.
- **name only** — this name is on the paper. That is the entire claim.

A `name only` match is never presented as the person, and the string the source actually
returned is shown beside it. `J. Smith` next to a profile called `John Smith` tells you how
weak the match is better than any summary could.

If a profile has no ORCID, resmon tells you — **while you are typing it**, not after you save
— that every match it can ever produce will be name-only.

## We measured it, and the numbers are in the app

Four profiles, every source resmon can ask about a person, **1,369 matches**, sixty-nine of
them graded by hand. All of this is on the Watch Profiles page under *Why every match carries
a basis*.

**The middle badge barely exists.** `name only` was 90% of all matches, `ORCID match` 9%, and
`name + affiliation` **nine matches in 1,369 — 0.7%**. In practice the rule is binary: an
ORCID, or a string. That was not what we expected, and it is the strongest argument we have
for finding an ORCID before you create a profile.

**Every ORCID match was the right person — 30 of 30.**

**The `name + affiliation` matches span at least five different researchers.** Two were a
distinctive name and were correct. The other seven were one common name at one large
institution: a computer-vision researcher, a laser physicist, a geochronologist, a photonics
engineer and an optics researcher, all labelled identically. Not one is a false claim in
resmon's terms — the badge says *a name matched and an affiliation matched* — and that is
exactly why it says that and nothing more.

**Of thirty name-only matches, seventeen named somebody whose identity could be checked.
Fifteen were right. One was wrong.** The wrong one is worth the whole exercise: Open Library's
record for *Coleridge's Political Thought* lists **Jennifer A. Doudna** as a co-author. It is
an upstream cataloguing error, resmon matched it faithfully, and it appears in the list
labelled **name only** — which is precisely the right amount of confidence to have had.

The other thirteen came from profiles that name no particular person. There is no answer to
"is this them" for those, so we did not invent one.

## Two sources that had never worked

Writing the live tests for this found that two sources' author search had **never returned
anything**, for anybody, and looked exactly like the person having published nothing.

- **arXiv** was being asked `all:au:"Yoshua Bengio"` — arXiv answers that with HTTP 400.
- **NDL Search** was being asked for the literal string `creator="…"` rather than a creator
  query.

Both are fixed, and both now have a test that asserts the exact query leaving the client, so
the regression cannot come back between weekly runs.

## Retractions, by person

A watch routine in `retractions` mode adds **no new provider and invents no finding**. It runs
the lifecycle check you already have, restricted to that person's papers, and reports the
notices resmon already holds — every one with its link, and every one carrying the basis of
the match it arrived through. A retraction attached to a name is not a retraction attached to
a person, and a report that blurred those about somebody named would be defamatory.

How much of that person's work has actually been checked is stated above the findings. "No
retractions found" means nothing unless you can see how much was looked at.

## The rest of it

- **Profiles are yours.** They export and import as JSON on one documented shape, so you can
  move them between machines or share one. A file with one bad entry still imports the good
  ones and says which line it could not read.
- **A starter set ships with the app** — nine well-known open-science figures, every ORCID
  checked against the public ORCID record on the day it was added, with the citation stored
  beside it. A tenth candidate was dropped because his record has no public name to check
  against.
- **Twenty of resmon's twenty-seven sources can be asked about an author at all.** The seven
  that cannot say so on the run's own source row rather than returning a bare zero.
- **A source's author search is a candidate generator, never a verdict.** Every record that
  comes back is re-checked against the profile locally, and the ones that do not survive are
  counted in the run rather than dropped in silence.
- **Your harness gets all of it.** MCP contract v2.2 adds four tools, and every match row
  carries its basis with no argument that removes it.

## What this release does not do

- **Institutions and groups are not here yet.** You can store an institution profile, but no
  routine mode can use one, so the routine editor does not offer it. Affiliation matching and
  institution-wide output are the next release.
- **Aliases are not sent to sources.** A source's author search takes one name, so aliases are
  used when resmon checks the answer rather than when it asks the question. A paper filed only
  under an alias can still be missed.
- **We measured precision, not recall.** Nothing here tells you how many of a person's papers
  resmon did not find.
- **`name only` is the common case.** It is not an error and it is not coloured like one. It
  is a weaker claim, clearly labelled, and it is on you to decide what it is worth.
