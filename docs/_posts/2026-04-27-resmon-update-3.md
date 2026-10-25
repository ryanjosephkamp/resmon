---
layout: post
title: "resmon Update 3 — April 27, 2026"
date: 2026-04-27 12:00:00 -0400
categories: [updates]
---

# Update 3 — Calendar fixes, and a new About resmon page

## Fixed

- **Routine times on the Calendar are right.** Scheduled routines were drawn about four hours
  earlier than they actually ran, because the times were worked out in UTC instead of your
  local time. Custom cadences — every few hours, days, weeks, months, or years — now start and
  repeat on the right dates.
- **Short routines are drawn as short events.** A 30-minute routine used to appear as an
  orange bar across several days.
- **The Calendar looks a year ahead.** It used to project scheduled runs only 90 days out and
  dropped some fires of frequent routines without saying so. It now projects 12 months, and
  tells you when you have scrolled past that.

## New

- **More from the Calendar.** The Routines filter lists only active routines. Clicking an event
  shows the routine's name and schedule, with an **Edit Routine** button; changes show up on
  the Calendar and the Routines page right away.
- **About resmon,** a new page in the sidebar with four tabs:
  - **Tutorials:** eighteen short videos covering the whole app, each page, and each Settings
    tab. Every page header has a button that opens its tutorial. The full-app overview video
    in this release is a placeholder.
  - **Issues:** report a bug or ask for a feature by email or as a GitHub issue. The form fills
    in the details for you and asks for no account or password.
  - **Blog:** these release notes, read inside the app.
  - **About App:** moved here from Settings.
- **AI keys are one click away from Repositories & API Keys.** AI provider keys live in
  Settings → AI, and a button on the Repositories page now takes you there.
- **Runs remember the saved configuration they came from.** The Dashboard, Results & Logs, and
  the Calendar show a **Name** column and a **Saved as** badge.
- **View JSON** on each row of the Configurations page shows the saved configuration as text,
  with a copy button.
- **Danger Zone** in Settings → Advanced: eight actions that clear stored data, settings, or
  API keys. Each asks for confirmation, and the six that delete data or settings require you
  to type `CONFIRM`. A column of cloud actions is shown switched off; it was not available in
  this release.

## Upgrading

If resmon runs in the background on your computer, restart that background service after
upgrading so it picks up the new features.

## Version

1.1.0 → 1.2.0
