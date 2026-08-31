---
layout: post
title: "resmon Update 12 — August 31, 2026"
date: 2026-08-31 18:00:00 -0400
categories: [updates]
---

# Update 12 — resmon, From Wherever You Work

## Metadata

- **Update number:** 12
- **Version:** 1.8.1 → 1.8.2
- **Theme:** resmon becomes something your AI tools can drive — and four more places to look

## The short version

**resmon now exposes itself to your AI harness.** If you work in Claude Code, Codex, or anything
else that speaks the Model Context Protocol, it can now read and drive resmon without you
leaving it: search your corpus, ask why a paper matched, check the watchdog, start a sweep, run
a routine.

**And resmon can finally run a routine on demand.** It could not, before. Not through the API,
not from the interface, not at all — running a saved routine meant rebuilding its configuration
by hand as a one-off sweep. That turned out to be a gap in the app, not just a missing tool.

Four new sources bring the catalog to **25**, and this release completes phase 1.8.

## Driving resmon from your harness

Start resmon, then register the server with your harness. For Claude Code that is one command:

```
claude mcp add resmon -- python3 /full/path/to/resmon_scripts/mcp_server.py
```

Seventeen tools cover searching your corpus, listing sources and routines, inspecting past runs
and what they found, match transparency, paper lifecycle, analytics, the watchdog, and reference
export — plus three that start work: run a sweep, create a routine, run a routine.

Then you can simply ask. *What did my arXiv routine find this week? Why did that paper match?
Is anything broken?*

### What it will not do

This is worth reading before you connect it, because the omissions are deliberate.

**Nothing destructive is exposed.** No delete, no erase, no factory reset. Not "guarded by a
confirmation" — **absent**. A tool call is too cheap an action to hang data loss on, and there is
no confirmation model here worth trusting yet.

**It never touches your API keys.** No tool reads, writes or returns a credential. Where a key is
relevant, a tool names its *slot* — `core_api_key` — and whether one is stored. Never the value.

**A routine created through a tool is created inactive.** Putting something on a schedule that
runs on your machine is not a side effect a tool call gets to have. You activate it in resmon,
having looked at it.

**resmon has to be running.** The server talks to your running copy over your own machine's
loopback address; it never opens the database itself. When resmon is closed, every tool says so
in one clear sentence — because a harness told "you have no papers" would repeat that to you as
fact.

One detail we would rather state than have you find: the server checks a port you set, then the
port file resmon writes, and only falls back to the default when neither names one. During
development, falling back attached it to a *different* resmon installation and it answered
perfectly truthfully about the wrong database. It will not do that now.

## Running a routine now

**Settings aside — you could not do this before.** Routines ran on their schedule or not at all.

`POST /api/routines/{id}/run` runs one immediately. It is a thin wrapper over the same machinery
the scheduler uses, so a manual run and a scheduled one cannot drift apart: the run is recorded
against the routine, appears in routine health, and the watchdog counts it like any other.

**An inactive routine will run**, and the response says so. Deactivating a routine stops it
running *on its own*; it was never meant to mean the routine may never run again. Otherwise you
would have to activate it, run it, and deactivate it again to get one result.

There is no button for this yet. The endpoint exists, your harness can call it, and the interface
catches up next.

## Four more sources

The catalog goes from 21 to **25**, all keyless:

| Source | What it adds |
|---|---|
| **Dryad** | Curated research datasets across disciplines, CC0 |
| **Open Library** | Books and humanities bibliographic metadata |
| **NIST RMM** | NIST papers, technical reports and software metadata |
| **NDL Search** | The Japanese national bibliography — the largest geography gap the catalog had |

These were the first sources chosen *after* checking their licence terms rather than before, and
two of them show what that changes.

**NDL** publishes an open metadata slice, and its live responses turned out not to match its own
summary of that slice — some records carry licences the summary does not mention, and some carry
no licence statement at all. resmon keeps a record only when its rights are explicitly one of
three known-open licences, and drops it otherwise. Fewer records, all of them ones we may keep.

**NIST's API has been returning an error since we added it.** The client handles that gracefully
and the catalog page says plainly that its field mapping has never been checked against a live
response — so if you see nothing from NIST, you can tell whether that is the source being empty
or the source being down.

## Credits we owe, now shown

Six of the sources resmon queries make a credit a **condition** of using their data — not a
courtesy. **resmon was showing none of them.**

CORE, NDL Search, NIST, OpenAIRE, PLOS and Semantic Scholar now have their credits displayed at
the top of **Repositories & API Keys**, unconditionally, in the exact wording each asks for. Not
tucked inside a panel you have to expand — a credit you have to go looking for is not displayed
in the sense the obligation means.

Sources that merely *ask* for a credit are shown on their own row instead, marked as requested
rather than required. The distinction is deliberate: OpenAIRE's metadata is licensed on condition
of attribution, while arXiv publishes a sentence it would like you to use. Rendering both the
same way would overstate one and understate the other.

## Whose terms bind you

Some sources need **your own API key**, which you register for yourself.

When a source runs on your key, **that provider's terms bind you, not resmon.** resmon can
decline to ship an integration it believes puts users in breach — and did, withdrawing IEEE
Xplore last release for exactly that reason — but it cannot accept a licence on your behalf, and
it does not monitor whether your use stays inside one. That is now said on the page where you
enter keys, rather than only in a document.

Eleven of the sources resmon ships publish terms that neither clearly permit nor clearly forbid
what resmon does with them. They are active, and that assessment is written down rather than
dressed up as a clearance.

## Also in this release

- **A crash that could have taken the app down as it quit.** resmon gives each background job its
  own database connection, and closing them all on shutdown could close one while a running sweep
  was still using it — which does not raise an error, it ends the process. It was found in a test
  that failed once in twenty-five runs, and it was real: the app closes connections the same way
  when you quit it. Connections belonging to a running job are now left alone until it finishes.
- **Contributing to resmon is documented properly.** A `CONTRIBUTING.md`, and a full guide to
  adding a scholarly source that opens with the licence question rather than closing on it. If
  you point your own AI harness at resmon and ask it to add a source you need, that guide is
  written for it as much as for you.

## Verification

- 859 backend tests, 22 live-network tests against real scholarly APIs, 139 renderer tests.
- CI green on Python 3.10, 3.11 and 3.12 plus the frontend job.
- The MCP server was driven end to end against a real running backend, not only against test
  doubles — which is how the wrong-installation bug above was found.
- No new dependencies. The MCP server speaks the protocol directly rather than adding a library.
- Schema unchanged at 9.
