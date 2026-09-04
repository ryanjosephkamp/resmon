---
layout: post
title: "resmon Update 17 — September 4, 2026"
date: 2026-09-04 21:30:00 -0400
categories: [updates]
---

# Update 17 — A Transport Failure Is Not an Answer

## Metadata

- **Update number:** 17
- **Version:** 1.8.6 → 1.8.7
- **Theme:** a correctness fix on the honesty surface v1.8.6 shipped, and the app is now tested in a real browser

## The short version

**v1.8.6 could tell you a source answered when it never did. If you are on 1.8.6, update.**

Update 16 was about a source that returns nothing saying why. This release fixes a hole in
that: three kinds of network failure were recorded as *nothing at all*, and a zero with no
recorded failure reads as "the source answered and had nothing". So the search record could
print

> arXiv answered (HTTP 200) and resmon found no records in the reply.

about a source resmon never got a reply from. That is exactly the overclaim v1.8.6 was built
to remove, on the surface v1.8.6 built, and it shipped inside it.

## What was actually wrong

resmon records a failure when a query to a source fails. It was recording only the two
failures it retries:

| What happened | Recorded in 1.8.6 |
|---|---|
| Connection refused | ✅ the source did not answer |
| Request timed out | ✅ the source did not answer |
| **Connection reset part-way through the reply** | ❌ nothing |
| **Server hung up without replying** | ❌ nothing |
| **A proxy refused the connection** | ❌ nothing |

For the bottom three the run had one attempt on record and no failures, which resmon reads as
*"it was asked, and it answered"*. Every surface downstream then repeated that: the monitor,
the results row, the report, and the reproducible search record.

**Every network failure is now recorded.** Nothing about retry behaviour changed — the same
requests are retried the same number of times. What changed is only what the run writes down,
which was the whole of the fault.

If you sit behind a corporate proxy or a VPN, you are the person most likely to have seen the
wrong sentence, because a proxy refusing a tunnel is one of the three.

### Runs from before 1.8.7 are not corrected

resmon does not rewrite history it did not observe. A run recorded under 1.8.6 that hit one of
these three keeps its `answered (HTTP 200)` sentence, and there is no way to tell from the
record which runs those were. **A search record from 1.8.6 or earlier should not be cited as
evidence that a source answered.** New runs are recorded correctly from the moment you update.

## Why this was not caught

Every test of that code path used a stand-in that raised only the two exceptions the code
already handled. **A test double cannot fail the way the real dependency fails** — the same
root cause as three earlier defects in this project. The replacement test drives a real
socket: a listener that refuses, one that hangs up, one that answers garbage, and one that
answers normally, with the last as a control so that widening what counts as a failure has not
swallowed the honest "the source answered and had nothing" case.

## The app is now tested in a real browser

The rest of this release is the verification layer behind that kind of fix.

Until now resmon's interface was checked by 190 tests that ran against a simulated browser,
and **nothing had ever started the actual app**. The window code — 700 lines carrying every
interface fix from the last few releases — had no test of any kind.

Now, on every change, the real application launches and:

- **all 24 pages** are opened and checked for errors, including the ten Settings and About
  tabs that were never being swept before. The page list is a single table the app itself
  renders from, so a page that exists is a page with a test.
- **the window itself** is checked — the background colour that fixes the white flash on open,
  external links opening in resmon's own window rather than throwing you out to a browser, and
  the Back/Forward menu items.
- **the seventeen tutorial videos and the in-app blog** are checked to have actually *loaded*.
  A video that has been removed still returns a normal response and renders "Video
  unavailable"; each embed is now asked directly whether its player is really there.
- **the packaged app** — the thing you actually install — is launched and walked, and it
  refuses to report success if it is checking a stale build.

It runs on two machines in CI, because a Linux test runner has no window manager and cannot
see window behaviour at all. Each run publishes a list of **what it did not verify**, rather
than a green tick that implies everything.

## Also in this release

- **A Browse… button** beside *"Where is the `claude` command?"* in Settings → AI. Both agent
  CLIs install somewhere a file dialog hides by default — `claude` under a hidden folder,
  `codex` inside the ChatGPT app bundle — so the picker is set up to show both. Typing the
  path by hand still works.

## Upgrading

Nothing to do, and no settings change. Windows and Linux update themselves. macOS builds are
unsigned, so replace the app manually — right-click → Open on first launch.
