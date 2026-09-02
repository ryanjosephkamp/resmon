---
layout: post
title: "resmon Update 11 — August 31, 2026"
date: 2026-08-31 12:00:00 -0400
categories: [updates]
---

# Update 11 — Your Own Plan, and an Honest Accounting

## Metadata

- **Update number:** 11
- **Version:** 1.8.0 → 1.8.1
- **Theme:** using the AI you already pay for — and withdrawing a source we should not have shipped

## The short version

Two things in this release, and they are opposites in a way worth saying out loud. One is
a feature people asked for. The other is a feature being taken away.

**resmon can now use the AI subscription you already have.** If you have Claude Max or a
ChatGPT plan and you have the command-line tool installed, resmon will drive that tool
instead of asking you for a metered API key. Your AI summaries come out of the plan you
are already paying for.

**IEEE Xplore has been withdrawn.** It worked. We read its terms properly and found that
it cannot be used the way resmon uses it — not by resmon, and not by you with your own
key. So it is gone, and this post explains exactly why rather than burying it in a
changelog line.

Both of those are the same commitment from a different angle: say what is true, including
when what is true is inconvenient.

## Using a plan you already pay for

Under **Settings → AI**, in the `If that fails, try…` chain, there are two new options:
`Claude Code (your Claude plan)` and `Codex (your ChatGPT plan)`. Add one and resmon will
run the command-line tool you already installed and signed into.

resmon never asks for your password, never embeds a sign-in flow, and never sees your
credential. It runs the tool; the tool handles its own authentication, exactly as it does
when you use it yourself. If you are not signed in, resmon says so and moves to the next
provider in your chain rather than pretending something else went wrong.

### Finding the command, and why that is harder than it sounds

resmon looks in three places, in this order: a path you set yourself, then the places the
installers put things, then your `PATH`.

That order looks backwards and is not. On macOS, an app launched from the Finder does not
inherit the `PATH` you see in a terminal — it gets a minimal one, and **neither tool is in
it**. The Claude command lives in a user-local folder. The Codex command lives *inside*
the ChatGPT application bundle, where it is on no `PATH` at all, ever.

So a version of this feature that searched `PATH` first would work perfectly for anyone
testing it from a terminal and fail for everyone using the installed app. That is the same
class of bug as the one that broke upgrades in 1.6.0, and it is worth being explicit that
we went looking for it this time instead of finding out later.

Settings shows you which of the three routes found your command. If none did, it lists
every path it searched — because "not found" on its own just sends you off to reinstall
something you already have.

### Two things to know before you turn it on

**It is slow, and it spends the window you work in.** Each paper starts a whole agent
session, which takes far longer than an API call, and it draws on the same usage allowance
you use for your own work. A 200-paper sweep routed through it could cost you the plan you
actually need that afternoon.

So the lane is **capped at 25 papers per run** by default — editable per lane — and it is
not the default for bulk summarizing. Hitting the cap is not an error: the lane stands
down, the remaining papers go to your next provider, and the run records that the cap was
the reason. The interface tells you all of this *before* the run, not after.

**Summaries come out of the tools' structured output**, not by reading their console
chatter. When that does not produce something usable, resmon says the tool returned
something it could not use, and moves on. It will not hand you a fragment of a progress
message dressed up as a summary of your paper.

One detail we would rather state than have you discover: each summarizing call runs in an
empty scratch directory with the tool's own file and command access switched off. Abstracts
are text fetched from the internet, and these tools can run commands on your machine. A
summarizer needs neither, so it gets neither.

## IEEE Xplore has been withdrawn

IEEE Xplore was a working source in 1.8.0 and is not in 1.8.1. Nothing broke. We read the
[IEEE Xplore API Terms of Use](https://developer.ieee.org/API_Terms_of_Use2) properly and
found four clauses that resmon cannot satisfy:

- the license covers only non-commercial activity **within the licensee's own institution**;
- clause 4(c) forbids using "any robot, spider, site search/retrieval application, or other
  device to retrieve or index any portion of the Content";
- clause 4(f) requires users to agree not to retain the content in bulk;
- clause 12 requires deleting the content from your system if the terms end.

resmon *is* a retrieval application. It keeps a corpus indefinitely and can back it up to
Google Drive. There is no setting that reconciles that with clause 4(c), and there is no
partial version of this that works.

The part that decided it: **you** register for the IEEE key, not us. The terms bind you
personally. Shipping an integration that cannot be used without putting you in breach of an
agreement you signed is not a trade-off we get to make on your behalf.

If you have an IEEE key stored, it is simply no longer used; nothing was deleted. Routines
that name IEEE keep running — that source reports itself as unavailable, with the reason
above, and the rest of the routine is unaffected. The code is still in the repository, so
a written license from IEEE would bring the source back unchanged.

### INSPIRE-HEP was fixed rather than withdrawn

The same review found a narrower problem at INSPIRE-HEP. Its terms allow reuse of an
abstract only where INSPIRE reports that abstract's own source as arXiv or CERN; abstracts
supplied by publishers are carried under licenses INSPIRE cannot pass on. resmon was
storing whichever abstract came first without checking.

It now checks. Records whose only abstract is publisher-supplied are still found, still
indexed, still searchable — they just have no abstract stored. In a sample of 100 records,
that was about one in five.

That is a real reduction in what you get from INSPIRE, and we are not going to describe it
as anything else. It is the correct reduction: the alternative is keeping text we have no
permission to keep.

### Where the review came from

All of this came out of a full terms review of every source resmon ships, published in the
repository as `docs/source-landscape.md`. It also surveys 27 sources resmon does *not* have
yet, with the license question asked **first** rather than last — which is how we ended up
finding these three after the fact rather than before.

Eleven further sources are marked unresolved: their published terms do not clearly grant
what resmon does, and they also do not forbid it. They are still active. Recording that
honestly seemed better than either quietly ignoring the question or dropping a third of the
catalog on a technicality.

## Also in this release

- **1.8.0 told you it was 1.7.0.** The version number lives in two files, and the 1.8.0 tag
  bumped one of them. So every 1.8.0 install answered its own health check with "1.7.0", and
  **About → About App** — which displays exactly that field — showed you the previous
  release number. Nothing else was affected; the app was 1.8.0 in every respect except the
  label it showed you. Fixed, and there is now a test that fails if the two files ever
  disagree again, because nothing was checking.
- **ERIC's catalog note** now says that a date window narrower than a whole year returns
  nothing from ERIC. Only publication year is searchable there, so resmon reports zero
  results rather than silently widening the window you asked for.
- **Retired sources now explain themselves.** A routine naming a withdrawn source used to
  record "Unknown repository", which describes a bug rather than a decision. It now records
  the actual reason.

## Counts

- 21 sources (was 22)
- 709 backend tests, 18 live-network, 134 renderer
- Schema 9, unchanged
