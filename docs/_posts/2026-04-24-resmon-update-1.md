---
layout: post
title: "resmon Update 1 — April 24, 2026"
date: 2026-04-24 12:00:00 -0400
categories: [updates]
---

# Update 1 — Deleted configurations stay deleted, and each repository says how it combines keywords

## Fixed

- **A deleted configuration no longer lingers.** After you deleted a Deep Dive or Deep Sweep
  configuration on the Configurations page, it could still be picked from the **Load
  Configuration** dropdown on Deep Dive or Deep Sweep, and loading it filled in the form. The
  dropdowns now refresh whenever a configuration is deleted, saved, or imported anywhere in the
  app. Routines were not affected.

## New

- **How each repository combines your keywords.** Repositories differ in what they do with
  several space-separated keywords: some require all of them (implicit AND), some accept any of
  them (OR), and several rank results by relevance instead. Deep Dive, Deep Sweep, and the
  routine editor now show a short note under the repository selector for each repository you
  pick.
- **A glossary on the Repositories & API Keys page** explains each term — Implicit AND,
  Explicit AND, Implicit OR, Explicit OR, Relevance-ranked, Lucene, and Solr — and each
  repository's details panel shows its keyword behavior with notes.
- Where resmon has not confirmed a repository's behavior against its own documentation, the
  label says **"upstream-default, unverified"** rather than guessing. In this release that
  applies to DBLP, IEEE Xplore, and PLOS.

## Version

1.0.0. This update did not change the version number.
