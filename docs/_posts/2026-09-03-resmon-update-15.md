---
layout: post
title: "resmon Update 15 — September 3, 2026"
date: 2026-09-03 18:00:00 -0400
categories: [updates]
---

# Update 15 — Your Plan, First

## Metadata

- **Update number:** 15
- **Version:** 1.8.4 → 1.8.5
- **Theme:** the plan you already pay for becomes the default way to get AI summaries

## The short version

**resmon now summarizes through the Claude Code or Codex command you already installed and
signed into, by default. You do not need to bring an API key to get AI summaries.**

That was always possible — the subscription lane shipped in 1.8.1 — but it was buried under
"If that fails, try…", capped at 25 papers, and explicitly not recommended for bulk work,
because it started a whole agent session for every single paper. This release sends five
papers per call instead, which is what made it affordable enough to put first.

## What a paper costs now

Measured, not estimated: the same ten abstracts, summarized one at a time and then five at a
time, through the real `claude` command.

| | one at a time | five per call | ratio |
|---|---|---|---|
| Cost per paper (the CLI's own accounting) | $0.0811 | $0.0271 | **0.33×** |
| Input-side tokens per paper | 5,593 | 1,289 | **0.23×** |
| Wall-clock per paper | 16.1 s | 6.8 s | 0.42× |
| Summaries inside the requested length band | 10/10 | 10/10 | unchanged |

The reason the input side falls so much further than the clock: roughly 5,600 tokens of every
call are fixed — the summarization constitution and the prompt scaffold. One paper at a time
pays that per paper. Five at a time pays it once.

**The per-run limit moves from 25 papers to 50.** At a third of the cost, fifty papers now
spend less of your plan's window than twenty-five did before. Not a hundred: in testing, a
batch occasionally came back one summary short, and each of those costs a follow-up call.
Reaching the limit is still not an error — the rest of the papers go to your next lane and
the run records the limit as the reason.

## Does batching make the summaries worse?

This is the question worth asking about any change like this, so here is what was actually
checked and what was not.

**Each summary is told to draw only on its own paper**, and the prompt says so explicitly.
To test whether that holds, ten synthetic abstracts were written, each containing one invented
word that appears nowhere else. If a summary of paper three mentioned paper seven's invented
word, that is a fact crossing between papers. Across six batched runs on both commands —
sixty summaries — **that happened zero times**.

**What that does not prove.** Those synthetic abstracts are about deliberately unrelated
things: a beetle survey, a compiler pass, a radar array. Real papers in one sweep are all on
your topic, and two of them being quietly conflated would produce plausible prose with no
invented word to catch it. That is the harder case and it is not measured. If you see a
summary that reads like it belongs to a different paper, that is worth reporting.

**Length compliance was equal to one-at-a-time**, and a batch that comes back short is re-sent
one paper at a time rather than accepted with gaps.

## Choosing a model and how hard it thinks

Both commands now offer a model dropdown and an effort level — and the two lists are different
kinds of fact, so resmon labels which is which.

**Codex reports a real catalog.** `codex debug models` lists the models it offers and, for each
one, the reasoning levels that model supports. resmon shows that, and offers only the levels
codex says your chosen model accepts.

**Claude Code has no way to list models.** What it documents is aliases — `opus`, `sonnet`,
`haiku`, `fable`. So that is what resmon offers, labelled as *names the command accepts*, not
as models your account can reach, which resmon has not checked. Both dropdowns keep anything
you have already typed, because either command may accept names resmon cannot enumerate.

**There is no effort control for API-key providers**, because none of the eight has one.
Offering a knob that silently did nothing for most providers would be worse than not offering
it, and the settings page says so in a line.

Leaving effort unset passes nothing at all. That matters for Codex, which reads its own
`model_reasoning_effort` from your `~/.codex/config.toml` — resmon will not override a
preference you set for yourself.

## Smaller things

- **"Where is the command?" moved behind Advanced**, and opens by itself when resmon could not
  find the command. It only matters then.
- **A fresh install proposes a command it finds** on your machine by pre-selecting it. It does
  not switch AI on, does not save anything, and says on screen that resmon cannot know whether
  you are signed in until the first paper.
- **Two settings were being silently discarded.** The full path to your command and the
  per-run paper limit could be sent to resmon and were then dropped before storage. Setting
  either did nothing at all. Fixed.
- **A false warning is gone.** Every run using a subscription lane logged "AI skipped: API key
  missing" — a lane with no key to be missing — while going on to produce summaries perfectly
  well. Runs now report the actual reason, from the lane that had it, after the attempt.

## Upgrading

Nothing to do. Existing configurations are untouched: if you have an API key set as your
provider, it stays your provider. The default only affects what a fresh install proposes.

Windows and Linux update themselves. macOS builds are unsigned, so replace the app manually —
right-click → Open on first launch.
