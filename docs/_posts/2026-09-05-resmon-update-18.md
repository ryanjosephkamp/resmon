---
layout: post
title: "resmon Update 18 — September 5, 2026"
date: 2026-09-05 22:00:00 -0400
categories: [updates]
---

# Update 18 — It Understands Papers

## Metadata

- **Update number:** 18
- **Version:** 1.8.7 → 1.9.0
- **Theme:** resmon stops treating papers as strings

## The short version

resmon can now compare papers by **meaning** rather than by the words you happened to type.
Set up an embedding model — a local one is free and needs no key — and two things appear:
the Explorer can sort results by how close each paper is to your search, and every result
gains **Papers like this one**, its nearest neighbours in your own corpus with the distance
and the source of each.

Nothing leaves your machine unless you choose a paid provider. On a real 15,707-paper
corpus, embedding everything took **six minutes and eighteen seconds** and cost nothing.

## What you have to know before you turn it on

**An Anthropic key cannot do this.** Anthropic does not offer an embeddings API. **Neither
can the Claude Code or Codex command** — they have no embedding command, so the
subscription that pays for your summaries does not pay for this. Both are listed in the
provider menu, disabled, with the reason, rather than quietly left out.

What *does* work: a local Ollama model (`ollama pull nomic-embed-text`, and then pick
Ollama), or a key from OpenAI, Google, xAI, Together or Alibaba. Each of those answers was
established by asking the provider's own API on 5 September 2026, with a control request to
a path that cannot exist — because an authentication check that runs before routing answers
401 for everything, and a bare 401 would prove nothing. DeepSeek is marked **unverified**
rather than guessed at: it answers 401 for paths that do not exist too, so there was nothing
to observe from outside. Enter a key and press Probe, and you will have a definite answer.

**A server that lists models can still refuse to embed.** This is the trap the whole feature
was built around. The machine this was developed on runs Ollama, lists two models happily,
and answers an embedding request with *"This server does not support embeddings"* — because
a chat model is not an embedding model. resmon reports that as "that is not an embedding
model, pull one", never as a corpus with nothing in it to rank.

## What it costs

Measured on a copy of a real 15,707-paper corpus:

| | |
|---|---|
| Time to embed everything | **378 seconds** (41.6 papers/second) |
| Cost, local model | **nothing** |
| Cost, OpenAI `text-embedding-3-small` | about **$0.09** for the same corpus |
| Database growth | 33 MB → 174 MB — about **9 KB per paper** |

That last row is the real price and it is worth knowing before you press the button — so
**Settings shows it before you start**, beside the token cost, computed from the model's own
vector width. A local model is free to call and still fills the disk, and the panel says
both. The
vectors are stored **twice**: once in a plain table any SQLite can read, and once in the
search index. That is deliberate. An index needs a loadable extension, and a database whose
only copy of the vectors lived inside one would be unreadable by anything that could not
load it. Dropping the index reclaims about a third of the growth and costs a rebuild; it
never costs a vector.

## What it refuses to do

**When it cannot work, it is absent — not present and broken.** If your build cannot load
the vector extension, or you have not set up a model, the sort control and the similar panel
do not appear at all. There is no slow fallback that computes distances by hand and pretends
to be the same feature. That happens for real: one of the machines resmon is tested on runs
a Python built without SQLite extension support, and resmon says exactly that.

**Papers it has not embedded are marked, not hidden.** Mid-backfill, a ranked list shows
unembedded papers last, labelled *not ranked* rather than given a large distance. They have
not been judged distant; they have not been judged.

**Two models' numbers never mix.** Vectors from different models live in unrelated spaces,
so a corpus half-embedded by one and half by another would produce a confident, meaningless
order. The model is recorded on every paper, and a ranking will not cross between them.
There is no fallback chain for embeddings for the same reason: falling back would give a
wrong answer rather than a degraded one.

## Where the limits are, stated plainly

**Closest and Newest can return different numbers of papers, and that is the feature.**
Newest matches on the words you type. Closest instead ranks everything your *other* filters
allow — source, category, author, date — by how near it is to your phrase, so it will show
you a paper that contains none of your words. Ask it *how do cells decide to divide* and it
answers with work on asymmetric division; a word-match returns nothing at all, because no
title contains that sentence.

This is the one thing in the release that was designed one way and shipped another. The
first build ranked *inside* the word filter, which sounds safer and is: switching the sort
could never change which papers you were looking at. Then it was measured against a real
15,707-paper corpus with twenty ordinary questions, and **eleven of them returned an empty
page** while the vectors, asked directly, found a relevant paper for nearly every one. A
control that says "Closest to" and answers from a keyword match is not doing what it says,
so it was changed before this shipped.

**Distances compare titles and abstracts, not full text.** resmon does not store full text
and does not pretend to. And 19% of this corpus has no abstract at all — mostly sources
whose terms do not permit resmon to keep one — so those papers are embedded from a title
alone. Each row records which, because two vectors built from different amounts of text are
not equally informative.

## Also in this release

- The MCP surface gains `find_similar` and a `semantic` mode on `search_corpus` — 18 tools,
  contract v1.2. The reply reports the mode it **served**, not the one asked for, so an
  assistant can never report a relevance ranking that is really a date order.
- `/api/health` now says whether this backend can load the vector extension, and why not
  when it cannot.
- Two things the app had been saying that were not true are fixed: the tutorial claimed a
  subscription lane sends ten papers per call when it sends five, and the agent-facing
  documentation said resmon builds for seven platform targets when it builds for four and
  publishes seven files.
