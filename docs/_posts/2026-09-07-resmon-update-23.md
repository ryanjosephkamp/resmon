---
layout: post
title: "resmon Update 23 — September 7, 2026"
date: 2026-09-07 06:00:00 -0400
categories: [updates]
---

# Update 23 — Five Minutes of Nothing

## Metadata

- **Update number:** 23
- **Version:** 2.0.1 → 2.0.2
- **Theme:** a hotfix — the assistant could hang for five minutes and then tell you nothing useful

## What was broken

If you installed resmon 2.0.0 or 2.0.1 and asked the assistant a question, it was possible
for the panel to sit there for **five minutes** and then say:

> resmon could not finish that turn.

That is every packaged install of 2.0.0 and 2.0.1, on any platform, since **6 September**.
It did not affect anyone running resmon from a checkout.

The cause is that the `claude` command resmon runs can, in some states, start and then say
nothing at all. resmon waited for it — patiently, for the full five-minute silence limit it
uses for a turn that is *thinking* — and then reported a failure that named nothing and
suggested nothing.

## What changed

The wait is now split in two, because there are two different situations and they deserve
different answers.

A turn that has begun answering and then goes quiet is thinking, and still gets five
minutes. A turn that has said **nothing at all** has not begun, and now gets **thirty
seconds** — after which resmon stops waiting and tells you:

> The claude command started but said nothing for 30 seconds, so resmon stopped waiting. It
> normally answers within a second. Run `claude` once in a terminal to check it works and is
> signed in, then try again.

Thirty seconds is not a guess. Across every measurement taken while chasing this — from a
shell, from the packaged app, from the development build, spawned by Node, spawned by
Electron, with and without the tool servers attached, cold and warm — the command's first
line arrived between **0.25 and 2.98 seconds**. Thirty is ten times the slowest ever seen.

## What this does and does not fix

**It does not stop the command hanging.** It stops resmon treating a command that has said
nothing as one that is thinking hard. If the underlying hang happens to you, you now learn
within half a minute, with a sentence you can act on, instead of losing five minutes to a
spinner.

Being straight about the rest: the hang itself was not reproducible by the time this fix was
written. It was reproduced against the published 2.0.1 build, seven candidate causes were
each ruled out by measurement — a keychain prompt, inherited environment variables, the tool
servers, output buffering, the spawn options, the process shape, resmon's own spawn code —
and then the machine's `claude` login, which had expired, was signed back in and the hang
stopped happening. That points at the expired-login path as the likely cause, and it is
**not established**. The work is written up in full in the project's handback rather than
summarised into a certainty here.

## If you saw this

**Update to 2.0.2.** If the assistant then tells you the command said nothing, run `claude`
once in a terminal and check it is signed in — that is the state that produced this in the
field.

## Also

A new check runs the assistant inside a backend that Electron actually launched, which is
the shape the defect lived in and the one nothing covered: the packaged checks asserted that
the tool servers *listed their tools*, never that a *turn* produced its first line.

End-to-end confirmation against the published 2.0.2 build, with a signed-in command, is a
separate verification pass and has not been done yet. This post does not claim it.
