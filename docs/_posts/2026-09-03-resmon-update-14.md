---
layout: post
title: "resmon Update 14 — September 3, 2026"
date: 2026-09-03 09:00:00 -0400
categories: [updates]
---

# Update 14 — Some AI Summaries Were Invented

## Metadata

- **Update number:** 14
- **Version:** 1.8.3 → 1.8.4
- **Theme:** a correctness fix on the AI path

## The short version

**If you used resmon's AI summaries through an agent CLI subscription or a local ollama model,
some of those summaries may not have been drawn from the paper at all.** They could be invented.

This is fixed. It affected two of the three ways resmon can summarize. If you only ever used an
API key — OpenAI, Anthropic, Google and the rest — you were never affected.

This release exists only for that. It ships now rather than waiting for the next feature.

## What went wrong

Every summarization prompt resmon sends opens with the same instruction: *"Write the summary in
strict adherence to the attached constitution."* That constitution is a real document — it is the
set of rules that tells the model not to introduce facts, numbers or claims that are not in the
source, and to say when something is unclear rather than guess. It is the reason resmon's
summaries are careful.

**Only one of the three routes actually attached it.** The API-key route sent it correctly. The
subscription route (driving the `claude` or `codex` command-line tool you already have) and the
local route (ollama) both sent the instruction with nothing behind it.

The consequence was worse than a summary written without the rules.

An agent that is told to follow a document, cannot find it, and cannot go looking for it — resmon
deliberately runs these tools with no file access — sometimes **invents the search instead**. What
came back was a fabricated transcript of the tool reading files that do not exist, and resmon
stored that as the paper's summary. It arrived in the correct format, so nothing downstream
noticed.

The lane did not report an error. It reported success.

## Nothing on your machine was accessed

This is worth saying plainly, because the symptom looks alarming: the fabricated summaries contain
what appear to be file paths and file contents from your computer.

**They are not real.** We tested this directly by placing a marked file in the working directory
the tool runs in; its actual contents never appeared in any response. The tools genuinely are
disabled. The model was inventing both the file access and what it claimed to find. No file on
your system was read.

## How to spot an affected summary

resmon does not keep AI summaries in its database — they are written into the report file for the
run that produced them. So there is nothing to clean up in your corpus, and **nothing already
written gets corrected retroactively.** Old reports keep whatever they were given.

An invented summary is usually obvious once you look. It reads like a transcript rather than
prose, and contains text of this shape:

```
<invoke name="Read">
<parameter name="file_path">...</parameter>
```

Searching your saved reports for `<invoke` or `function_results` will find them.

To identify which runs *could* be affected, resmon already records the summarization route used
for each run. Any run whose AI route was `subscription` or `local`, and which produced at least
one summary, is a candidate. It is a candidate rather than a certainty: the failure was
intermittent — the same prompt sometimes produced a perfectly good summary and sometimes produced
an invented one.

One limit on that, stated rather than glossed: resmon has only recorded the route per run since
v1.8.0. The subscription route did not exist before v1.8.1, so every run that used it is covered.
Local ollama summarization is older than that record, so **runs from before v1.8.0 that used a
local model cannot be identified this way** — searching those reports for the text above is the
only check available.

**Re-running the routine regenerates the summaries correctly.** That is the fix for an affected
report, and it is the only one needed.

## What changed

Each route now delivers the constitution through its own proper channel, so the rules sit *above*
the paper text rather than beside it. That ordering matters: an abstract is text fetched from the
internet, and anything hidden in one should be arguing with a system-level instruction rather than
sitting alongside it as an equal.

| Route | How the constitution is delivered |
| --- | --- |
| `claude` | `--append-system-prompt` |
| `codex` | an `AGENTS.md` written into the temporary working directory |
| ollama | the `system` field on `/api/generate` |

Both command-line channels were checked against the actual installed tools before being chosen,
and both routes were then run end to end to confirm they produce real summaries of the right
length.

## Why our tests did not catch it

Worth recording, because it is the third time this project has been caught by the same shape of
gap.

Every existing test asked whether the constitution **exists** — that it loads, that it is cached,
that it stays within its size budget. All of them passed. What was broken was whether it
**arrives**, and nothing tested that.

There are now tests that check transmission at the exact boundary each route crosses, plus one
that fails if a *new* route is ever added without such a check.

One further note, because it cuts against the obvious fix: a test that calls the real command-line
tool and checks the output **does not catch this**, and we established that by measuring rather
than assuming — with the fix removed, that test still passed, because the failure only happens
some of the time. It was kept for something it does catch reliably, and the test file says so in
plain terms. A test whose name promises more than it checks is how all three of these problems
shipped.

## Upgrading

Same as always. Download the installer for your platform below. On macOS the build is unsigned, so
if you see *"resmon is damaged and can't be opened"*, clear the quarantine flag:

```
xattr -dr com.apple.quarantine /Applications/resmon.app
```

Your database, routines and settings are untouched by this release.
