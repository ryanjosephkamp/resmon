---
layout: post
title: "resmon Update 22 — September 6, 2026"
date: 2026-09-06 21:00:00 -0400
categories: [updates]
---

# Update 22 — Bring your own key

## Metadata

- **Update number:** 22
- **Version:** 2.0.0 → 2.0.1
- **Theme:** the assistant for people who do not have a subscription CLI, and three things that were quietly not being watched

## The short version

Update 21 shipped the **✦ Ask** panel and said, at the bottom, *"No API-key assistant yet. If
you have an Anthropic or OpenAI key but no CLI, the panel cannot use it. That is the next
release."*

This is that release. Under **Settings → AI → Assistant**, *Run it with* now offers **an API
key of your own** alongside the `claude` command. Anthropic, OpenAI, Google, xAI, Together,
DeepSeek, Alibaba, or a custom OpenAI-compatible endpoint.

It is the same panel, the same tools, the same confirmation card, and the same rules on the
same system channel. What changed is who runs the loop: resmon does it itself instead of
handing it to a command.

## Three things are different, and resmon says all three

**It reports tokens, not money.** A provider API tells you how many tokens a call used. It
does not tell you what they cost, and resmon does not maintain anyone's price list. So a turn
on this route shows a token count and says *cost not reported*, rather than a dollar figure
computed from a table this app would have to keep correct for eight providers. The `claude`
route still shows a real cost, because the command reports one.

**A turn stops after eight tool steps or 100,000 tokens.** The command enforces a spending
ceiling on itself; here the ceiling has to be on something resmon can count. Both numbers are
twice the largest of the ten requests measured for 2.0.0 — four tool steps and about 53,000
tokens at the top end — so an ordinary answer is nowhere near them and a loop is stopped.

**It remembers what was said, not what the tools returned.** A provider API keeps no session,
so resmon replays the conversation itself: your messages and its replies. The raw output of an
earlier tool call is *not* re-sent. That means a long conversation does not pay to re-send a
page of papers on every turn, and text lifted from a paper's abstract does not follow you from
turn to turn. The assistant can see what it told you; it cannot see the evidence it told you
from.

## Which providers can do this at all

The same three-state answer the embedding lane uses, with the evidence that established each
one:

- **OpenAI** and **Anthropic** — established from the SDKs resmon ships, which is better
  evidence than a probe and is checked by a test rather than quoted in a comment.
- **xAI** and **Google** — established by a probe. Sending a deliberately malformed `tools`
  field gets a complaint naming `tools`; sending a made-up field gets *"cannot find field"*.
  The difference is the answer.
- **Together, DeepSeek, Alibaba** — **unknown**, and it says so. Those APIs check your key
  before they look at the body, so an invalid key gets the same 401 whatever you send and
  there is nothing to observe from outside. resmon will send the tools and show you exactly
  what comes back, rather than recording a guess with a citation attached.
- A **custom endpoint** is unknowable in advance, by definition.

## A first screen that asks for nothing

A brand-new install now opens on a **Getting started** card: three optional things — a command
you already subscribe to, a provider key, a key for one of the five sources that take one —
each with a link to where it is set and a mark for what resmon can already see.

None of it is required. resmon searches all 25 sources with no AI and no keys at all, and the
card says so in its first line. It reports **found** and **configured** and never **working**,
because resmon cannot tell whether a command is signed in or a key accepted until the first
paper goes through it. **Skip** puts it away permanently, and it retires itself the moment you
have run anything.

## When the CLI has lost your conversation

`claude` keeps its conversations in its own storage. If you clear its history, or restore
resmon's database onto a machine whose command has never seen that conversation, resmon used
to answer *"exit code 1"* and lose your message.

Now it recognises what the command actually said, answers your message in a fresh session, and
tells you in place: your earlier messages are still on screen, and the assistant can no longer
see them.

## The part nobody was watching

resmon has a suite of tests that talk to the real internet — every source client, the whole
tool surface, the search extension loading inside a running backend. They are excluded from
the ordinary test run because they are slow and because a provider having an outage is not a
bug in resmon. **Nothing ran them on a schedule.**

In 1.9 one of them started asserting the opposite of what the search contract says, and it sat
red for two releases with nobody hearing about it. That was found in 2.0.0 by someone happening
to type the command.

There is now a weekly job. It runs every live test that needs only a network — 56 of the 72 —
and its summary names, by test, every one it could not run and why. The sixteen it skips need
an agent command installed and signed in, which no build machine has.

**It found something on its first run.** 2.0.0 added an assistant settings group to the app
after the tool surface's allowlist was frozen earlier in the same release, so the assistant
could not change its own model — and nobody had decided that. It can now, behind the same
confirmation card as everything else. Contract v2.1.

## Also in this release

- The assistant's settings section hides the effort control on the API-key route, because none
  of the provider APIs takes one. A control that silently did nothing would be worse than no
  control — the same rule the summary lanes follow.
- Both routes now go through **one** permission function. The command reaches it as a tool in
  another process and the API-key loop reaches it as a function call, so *"the same card"* is a
  fact about the code rather than two things that resemble each other.

## What is still not here

**No voice.** The packaging spike came back with numbers: bundling local transcription adds
80–90 MB to every installer, the redistribution questions for its dependencies are unanswered,
and there is no signing story for microphone access on macOS. It returns as its own piece of
work when the model can be downloaded on first use instead of shipped, not before.

**No Ollama assistant.** Ollama does support tool calling — resmon checked, and got a real tool
call back from a local model — but driving it as an assistant is its own piece of work and is
recorded rather than rushed.
