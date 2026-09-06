---
layout: post
title: "resmon Update 21 — September 6, 2026"
date: 2026-09-06 18:00:00 -0400
categories: [updates]
---

# Update 21 — Ask

## Metadata

- **Update number:** 21
- **Version:** 1.9.2 → 2.0.0
- **Theme:** an assistant inside the app that can do what you can do, and cannot do anything you have not agreed to

## The short version

There is a **✦ Ask** button in the corner of every page now. It opens a panel, and you can
tell it what you want in words: *what did my arXiv routine find this week*, *set up a weekly
sweep on graphene*, *why did resmon match this paper*, *export last run's references*, *turn
that routine on*.

It runs the `claude` command you already installed and signed into, so it draws on the plan
you already pay for. resmon never sees your credential.

Two things about it are worth more than the feature itself.

## Everything it tells you came from a tool call

The assistant has no other source. It cannot answer about your corpus from memory, from
training, or from what is usually true of applications like this one — it has to ask resmon,
and resmon answers with the same care the rest of the app does. When a source returned
nothing, it passes on the recorded reason, or says the reason was not recorded. When a paper
matched, it passes on what resmon cannot verify along with what it can.

That is not a style guide handed to a model. resmon starts it with **its own tool surface and
nothing else** — no built-in tools, none of your own MCP servers or skills, an empty working
directory — so there is nothing else for it to reach.

## Anything that changes something waits for you

Ask it to create a routine, run a sweep, turn something on, or change a setting, and you get a
**card**: a sentence saying what will happen, the exact call underneath, and Allow / Deny.
Nothing runs until you press one.

That is enforced outside the model rather than asked of it. The assistant is given the fifteen
tools that only read. Every other call goes through a permission step resmon controls and the
assistant cannot invoke, and the write does not execute until the answer comes back. Denying
is an answer: the call does not run, and it is told so.

**Some things it cannot do at all**, because they are not in its tools: deleting anything,
erasing your corpus, resetting the app, writing a credential, installing the background
service, linking cloud storage. Ask, and it will tell you to do it in the app.

**It cannot reach an API key in either direction.** No tool returns one, and no tool can name
one. That is checked against a real key planted in a real keyring, with the assistant asked for
it directly, twice.

## Why the papers cannot talk to it

Titles and abstracts come from the open internet, and sooner or later one of them will contain
text addressed to the assistant: instructions, claims of authority, a request to run
something. That text is data it reports on, never an instruction it follows — and the rules
saying so arrive **above** the conversation, on the command's own system channel, rather than
beside the text where they would be arguing with it as a peer.

We know what happens when that goes wrong, because it happened here. In 1.8.4 two
summarization lanes told the model to follow a constitution and attached nothing; unable to go
looking, it invented a file search and returned the results as a paper's summary. The rules
now arrive on a channel a test watches, at the point the command is actually built.

## What a turn costs

Ten typical requests were measured against the real command before this shipped. The median
turn is under nine cents' worth of usage; the dearest — creating a routine, which is four tool
calls and a confirmation — was nineteen. Asking it to delete your corpus is the cheapest thing
you can do, because it declines without calling anything.

Every turn carries a hard ceiling the command enforces on itself, set at four times that
dearest measurement. An answer that runs away is stopped and says so rather than quietly
spending your window.

## What is not here

**Codex is not offered for the assistant.** resmon can give a Codex session its own tools but
cannot take away Codex's shell, and `codex exec` has no way for you to approve a command
before it runs — so an assistant on Codex would be an agent that can run commands on your
machine while reading text off the internet. It remains a summarization lane, where it is
given no tools at all. The Settings tab says this rather than leaving Codex unmentioned.

**No voice yet.** There is no microphone substrate in the app, and the routes to transcription
are a native dependency or a hosted key. That is being looked at properly rather than bolted
on.

**No API-key assistant yet.** If you have an Anthropic or OpenAI key but no CLI, the panel
cannot use it. That is the next release.

## Also in this release

- **Twenty-one MCP tools**, contract v2.0, for harnesses driving resmon from outside: the
  three new ones plus a `requires_confirmation` flag on every tool, so an external harness
  knows which calls to put in front of you instead of inferring that an unmarked tool is safe.
- `create_routine` returns the routine it created rather than an id and a name.
- A `live_network` test had been asserting the opposite of what the semantic-search contract
  says since 1.9. It is fixed, and the route-conformance check that three contract amendments
  promised as a manual act is now a test that runs every time.

## Under the hood

Conversations are kept in the database and survive closing the app. Each turn is its own
short-lived command process resumed by id, so stopping one is a clean stop and a backend
restart orphans nothing.

Two things were found by building it and are worth naming. The panel's process was being given
a carefully-chosen slice of the environment, which dropped `USER` — and without `USER` the
command cannot read its own login, so every answer would have been *"not signed in"* from a
command that was signed in. And the guard against two answers at once had a window in it wide
enough for two commands to join the same conversation. Both were found by tests that took the
trouble to be awkward.
