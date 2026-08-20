---
layout: post
title: "resmon Update 8 — August 20, 2026"
date: 2026-08-20 18:00:00 -0400
categories: [updates]
---

# Update 8 — resmon Can Finally Be Installed. By Anyone.

## Metadata

- **Update number:** 8
- **Version:** 1.5.0 → 1.6.0
- **Theme:** distribution — installers for every desktop platform, self-updating on two of them

## The short version

Until today, running resmon meant cloning the repository and building it yourself.
As of 1.6.0 there are real installers for all three desktop platforms, built and
published automatically on every release:

- **macOS** — a DMG for Apple Silicon and a separate DMG for Intel. Drag to
  Applications. Builds are currently unsigned, so the first launch needs a trip
  through System Settings → Privacy & Security → *Open Anyway* (macOS 15+) or
  right-click → Open (earlier); the README documents every path, including the
  one-line terminal alternative.
- **Windows** — a standard installer with a choosable install directory.
  SmartScreen warns on unsigned installers: *More info → Run anyway*.
- **Linux** — an AppImage. `chmod +x`, run.

**Windows and Linux installs keep themselves current.** The app checks the
project's GitHub Releases shortly after launch and every six hours, downloads in
the background, and offers *restart now* or *on next quit*. macOS cannot
self-update while builds are unsigned — its update machinery validates code
signatures — so macOS stays manual-install for now, and never pretends otherwise.

## What else landed in 1.6.0

- **The app no longer attaches to a mismatched background daemon.** An installed
  1.5.0 talking to an old 1.2.1 daemon produced 404s on pages the old backend had
  never heard of, while the status bar said "Online". The attach handshake now
  requires an exact version match; anything else gets its own bundled backend on
  its own port.
- **App state lives where it belongs.** A packaged resmon keeps its database and
  reports in the per-user application-support directory, not inside the app
  bundle — surviving updates, and unaffected by macOS running quarantined apps
  from read-only locations.
- **Analytics is cached.** Every figure used to be recomputed on each page load.
  Results now cache against a fingerprint of the corpus, so the page is instant
  until something actually changes — and correct the moment it does.
- **The renderer test suite nearly doubled** (27 → 52), aimed at the pages that
  changed most in recent releases.

## For the record

The pre-1.6 application is archived permanently as `v1.5-classic`. The release
pipeline signs and notarizes automatically the day an Apple Developer certificate
is configured; nothing about it needs to change but the secrets.
