---
layout: post
title: "resmon Update 2 — April 25, 2026"
date: 2026-04-25 12:00:00 -0400
categories: [updates]
---

# Update 2 — Readable calendar views, desktop notifications, and one AI key per provider

## Fixed

- **Calendar week and day views are readable.** Events in those views were drawn as a colored
  block with differently colored text on top, and the two clashed. They now use the same
  status dot and colored label as the month view.
- **Desktop notifications fire.** With notifications turned on in Settings → Notifications,
  nothing appeared for finished runs. They now appear for manual runs and for routines,
  including routines that run in the background while the resmon window is closed. This was
  tested by hand on macOS; on Linux and Windows it is covered by unit tests only.

## New

- **Store an AI key for each provider.** resmon used to keep one AI key at a time, so trying a
  second provider meant deleting the first key. Each provider now has its own slot. A key you
  had already saved moves to the slot for the provider you had selected, the first time this
  version starts.
- **Settings → AI has a Stored API Keys table** with each provider's status, its default model,
  and buttons to clear either. Click a provider's name to make it the default. Length, Tone,
  Temperature, and Extraction Goals each have a short explanation on hover.
- **The same AI settings on every run.** Deep Dive, Deep Sweep, and the routine editor share
  one AI panel: provider, model, length, tone, temperature, and extraction goals. Fill in only
  the fields you want to change for that run; blank fields use your defaults, and nothing you
  set for one run changes your saved settings. The model list loads from the provider, you can
  enter a missing key from the panel, and **Save as default model** keeps a choice for later.
- **Edit a saved configuration** from its row on the Configurations page. Routine, sweep, and
  dive configurations each open the matching editor.
- **Importing a routine configuration creates its routine,** switched off, so an import never
  starts anything on a schedule by itself. The Routines page shows it without a reload.

## Upgrading

If resmon runs in the background on your computer, restart that background service after
upgrading. An older service keeps running the old code and quietly ignores the new
default-model setting.

## Version

1.0.0 → 1.1.0
