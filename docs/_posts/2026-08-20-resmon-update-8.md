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
  Applications. Builds are currently unsigned, and macOS blocks a downloaded
  unsigned app with a *“resmon.app” is damaged* dialog — it is not damaged; that
  is Gatekeeper's standard refusal. One command clears it for good:
  `xattr -dr com.apple.quarantine /Applications/resmon.app`. The README covers
  the variants.
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

## The same-day 1.6.1 hotfix

1.6.0's installers carried a genuine distribution bug: the bundled Python was a
virtual environment, and a venv is never actually portable — its interpreter
links the build machine's Python at an absolute path, and the standard library
stays behind. Every 1.6.0 build worked on machines that happened to have the
build Python (including every machine it was tested on) and crashed on clean
ones.

1.6.1 replaces the venv with a genuinely relocatable standalone CPython
([python-build-standalone](https://github.com/astral-sh/python-build-standalone)),
with everything installed inside the bundle and nothing referencing a path
outside it. The release pipeline now *runs the shipped interpreter* on every
platform and rejects any user-level framework linkage, so this class of bug
cannot ship again. Windows and Linux 1.6.0 installs self-heal through
auto-update; macOS users should download 1.6.1.

## For the record

The pre-1.6 application is archived permanently as `v1.5-classic`. The release
pipeline signs and notarizes automatically the day an Apple Developer certificate
is configured; nothing about it needs to change but the secrets.
