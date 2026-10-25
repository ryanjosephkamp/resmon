---
layout: post
title: "resmon Update 4 — May 5, 2026"
date: 2026-05-05 12:00:00 -0400
categories: [updates]
---

# Update 4 — Routines that run while the window is closed, and a truthful status line

This release fixes routines that stopped running in the background when the resmon window was
closed, even though Settings → Advanced said the background service was installed and running.

## Fixed

- **A deleted routine leaves nothing behind.** Deleting a routine could leave its scheduled job
  in place, and the scheduler kept trying to run a routine that no longer existed. Deleting a
  routine now removes its job, and any leftover jobs are cleaned up when the background service
  starts.
- **A slightly late run still happens.** If a routine's start time had passed by even a second
  — after a restart, for example — the run was skipped. A run that is up to an hour late now
  goes ahead.
- **Only one backend schedules routines.** When the app opened while the background service
  was still starting, it could give up waiting and start a second backend of its own, with its
  own scheduler. When the window closed, that backend stopped, and routines were recorded as
  missed. The app now waits longer for the service, and a backend the app starts itself never
  runs routines.
- **Settings → Advanced shows the real background service.** The status line used to describe
  whichever backend the window happened to be connected to. It now checks the background
  service directly and shows its process, version, and start time, and says separately which
  backend the window is using, so a mismatch is visible.

## Upgrading

Restart the background service after upgrading, or it keeps running the old code:

- macOS: `launchctl kickstart -k gui/$UID/com.resmon.daemon`
- Linux: `systemctl --user restart resmon-daemon`
- Windows: remove and re-add the resmon task in Task Scheduler

## Version

1.2.0 → 1.2.1
