---
layout: post
title: "resmon Update 10 — August 30, 2026"
date: 2026-08-30 18:00:00 -0400
categories: [updates]
---

# Update 10 — AI On Your Terms

## Metadata

- **Update number:** 10
- **Version:** 1.7.0 → 1.8.0
- **Theme:** one provider failing should not cost you the run — and when something does fail, the app should be able to say what

## The short version

Until this release, AI summarization in resmon had exactly one way to succeed and one
way to fail. You picked a provider; if it worked, you got summaries; if it didn't, you
got a line in the activity log and a run that completed looking perfectly healthy.

Two things change in 1.8.0.

**You can now configure a chain of providers.** Anthropic first, a cheaper model second,
Ollama on your own machine as the floor — any providers, in any order. When one cannot
produce a summary, the next one tries.

**Failures became facts the app can reason about.** Every attempt is now recorded: which
provider, which model, how many papers it summarized, and the classified reason it
stopped. That closes the largest blind spot the 1.7 watchdog had — a run where every
single AI call failed used to finish and look fine.

This release also adds **four new sources**, bringing the catalog from 15 to 19.

## Not every failure means the same thing

This is the idea the whole feature rests on, and getting it wrong is expensive in both
directions.

A rejected API key is not going to start working on the next paper. Neither is an
exhausted quota, a model that does not exist, or a provider your machine cannot reach.
Presenting a dead credential once per paper burns an entire run rediscovering the same
fact two hundred times. resmon calls these **lane-fatal** and retires that provider for
the rest of the run.

An abstract longer than the model's context window is a different animal entirely. So is
content a provider declines, or a one-off server error. The provider is fine; *this
paper* is the problem. Abandoning a working provider over one difficult abstract would
silently downgrade every summary that came after it. resmon calls these
**document-local**, falls through for that one paper, and keeps the provider primary.

| Failure | Examples | What happens |
|---|---|---|
| **Lane-fatal** | rejected key, exhausted quota, unknown model, unreachable provider | that provider is retired for the run |
| **Document-local** | context window exceeded, content declined, one-off `5xx` | that paper falls through; the provider stays |

If this sounds like the distinction the watchdog draws between `broken` — a recorded
fact — and `unusual` — an inference from your own history, it is the same discipline
applied to a different problem. Two things that look alike in a log are worth separating
when they demand opposite responses.

## What gets recorded

Each execution now stores one row per provider it tried: the provider and model, the
**alias** of the credential slot used (never the key itself), how many papers it
attempted, how many it summarized, and the classified reason it stopped.

A provider that was never reached is recorded as **skipped** rather than left out —
because "we never needed it" and "it was not configured" are different facts and you are
entitled to both. A provider that got some papers and not others is **partial**, held
deliberately apart from **failed**: partial is a normal day with one awkward abstract,
failed is a provider that did not work.

And the report header now names the provider that **actually produced** the summaries.
A report saying "anthropic" when Ollama did the work would be precisely the kind of quiet
lie the last release was about.

## Two things this release refuses to do

**There is no summarizer of last resort.** If every provider in your chain fails, those
papers have no AI summary, and the execution says why. resmon has never had a keyless
extractive fallback underneath the AI — our own planning documents claimed it did, and
that was wrong. It has been corrected rather than quietly built to match.

**The subscription lane is not here yet.** Driving the Claude Code or Codex CLI you have
already installed and logged into — so AI usage draws on a plan you already pay for — is
the next release, not this one. The lane exists in the data model and is honestly
reported as unimplemented rather than silently skipped.

## Four new sources

The catalog goes from 15 to 19:

- **Zenodo** — CERN's general repository: preprints, datasets and software, all with DOIs
- **INSPIRE-HEP** — the curated high-energy physics literature database
- **OpenAIRE** — the EU-wide open-science aggregator
- **medRxiv** — which resmon has been *able* to search since early on, but never made
  selectable. The client supported it; the registry never registered it. Fixed.

Each carries an honest description of how its upstream actually combines your keywords.
OpenAIRE's now reads **"Combination semantics undocumented"**, because OpenAIRE documents
that behavior as undefined — and a catalog field that renders to you as a statement about
someone else's search engine should not guess.

## Under the hood

- New `execution_ai` table (schema 9), the sibling of the per-source record 1.7 added.
- Provider configuration resolves into an ordered list of lanes. An existing
  single-provider setup is read as a one-lane chain **at load time** — no data moves,
  nothing migrates, and downgrading to an earlier build still works.
- The MCP tool surface is now frozen as a written contract in `docs/api-contract/mcp.md`,
  ahead of the server itself. Writing it surfaced a genuine gap: resmon has no way to run
  a routine on demand at all. That is being fixed.
- 485 → 570 backend tests, 111 → 121 renderer tests, 15 live-network tests against real
  scholarly APIs.

## Upgrading

Nothing to do. Your existing AI configuration keeps working exactly as it did — the
fallback section starts empty, and an empty chain is the old behavior. Add a fallback
only if you want one.
