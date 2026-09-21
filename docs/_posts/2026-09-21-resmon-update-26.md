---
layout: post
title: "resmon Update 26 — September 21, 2026"
date: 2026-09-21 09:00:00 -0400
categories: [updates]
---

# Update 26 — The run that finishes, and the report that arrives

## Metadata

- **Update number:** 26
- **Version:** 2.2.0 → 2.3.0
- **Theme:** a run says what actually happened to it, and a routine's report has somewhere
  to go and a record of whether it got there

## This is the classic checkpoint

2.3.0 is the last feature release of resmon's current interface. From here, 2.x continues on
a `classic` branch for security fixes only, and the next major version rebuilds the
interface on the same engine — the same backend, the same database, the same corpus — and is
measured against 2.3.0 journey by journey, page by page, rather than against an idea of what
the app does. Nothing here is being retired and no date is being promised. This release is
the line the rebuild gets compared to, which is why it is worth having the numbers in it be
true.

## The short version

Three schema steps, and all three are about resmon being able to say what happened rather
than what it assumes happened.

A run whose backend was force-quit used to sit at `running` for ever, or — on the graceful
path — was written down as `failed`, which was an overclaim: resmon never observed a
failure. There is now a fifth word for it, **interrupted**, with ownership columns behind it
so the judgement is a fact and not a guess, and a **Restart** that links the new run back to
the one it came from (#139).

A routine could fire twice, or be started by hand while its own scheduled fire was already
running. Now there is **one run per routine and one run per submission**, enforced by the
database rather than by a check the application hoped it won because it looked first — and a
record of **missed fires**, the ones whose time had already passed while resmon was not
running (#141).

And a routine's report now has **somewhere to go**. Email, a folder, a webhook and a feed:
four destinations, each with its own row, its own attempts, its own reason for not having
arrived yet and its own time to try again (#146, #148).

Plus a **backup and restore** that treats the database and the Library vault as one pair,
with a drill that proves the restore (#153).

## A run that was interrupted says so

`executions.status` had four values — `running`, `completed`, `failed`, `cancelled` — and
none of them is true of a run whose backend was killed. The graceful shutdown path had
written `failed` for years.

Schema 19 rebuilds the table with a fifth value, `interrupted`, and four columns that make
the reconciliation on the next start something resmon can establish rather than assume:
`owner_pid` and `owner_runtime_id` say which process claimed the row, `last_seen_at_utc`
says when that process was last observed working on it, and `interrupted_reason` says which
of the two ways resmon found out — `daemon_restart` when it watched itself stop,
`owner_dead` when a later start found the owning process gone, `unknown` when neither can be
established. A 30-second heartbeat and a stamp at each stage boundary are what give that
judgement something to read (#139).

The rule is one-sided on purpose. A row is adopted as interrupted only where its owner can
be *established* to be gone; a pid that has been reused, or one belonging to another user,
reads as alive. Being wrong towards alive costs a row that waits for the next start. Being
wrong the other way tells somebody a live run has stopped. That rule was written out in
three places and is now one implementation, tested over its four branches (#149).

`Restart` re-runs an interrupted execution with the same parameters and records
`restarted_from` on the new row. The original is never edited — the history stays exactly as
it happened. The real Results page, the badge, the reason sentence, the last-seen time and
the Restart click are exercised in a real Electron window rather than in jsdom (#147), and
the renderer now derives its status vocabulary from one exported list that a test compares
against the CHECK in `database.py`, so a status added to the schema and forgotten in the
renderer fails instead of leaving a finished run showing as still running (#145).

## One run per routine, and the fires that were missed

Two things could produce a second simultaneous run of the same routine: the scheduler firing
while a hand-started run was in flight, and a submission retried by a client that never saw
the first response.

The first is now a claim taken under a lock before the worker thread starts and released in
its `finally` — not a query on `executions.status`, which is both too late (the row does not
exist yet) and too long (a force-quit backend's rows would refuse the routine for ever). The
second is `executions.request_id` with a partial UNIQUE index over it: one run per
submission, enforced by SQLite (#141).

The global admission slot now follows the same discipline. A worker thread that died between
being admitted and reaching its own `try` used to hold the slot for the life of the backend,
and enough of those meant every Deep Dive and Deep Sweep answered 429 while nothing at all
was running. The slot is released from the same outer `finally` as the routine claim, in the
same order, and the release is idempotent (#143). The order matters enough to have its own
guard (#149).

`routine_missed_fires` records one row per scheduled fire whose time had already passed when
resmon next started. It claims exactly what was observed — that the persisted next fire was
in the past when we read it — and not that the run did not happen. **No catch-up run is
started.** Whether resmon should silently run a week of missed sweeps on the morning a laptop
is opened is a decision for its owner, not a default chosen by a migration (#141).

## The report has somewhere to go

Until now a routine's report went to email, from inside the execution worker's own thread,
while still holding that run's admission slot. A mail server that accepted a connection and
then sat there held the slot open with it.

Schema 21 adds `routine_delivery_targets` — where a routine's report is sent — and
`deliveries`, one row per execution and destination carrying the attempts made, the reason
it has not arrived, and when to try again. The completion hook no longer sends anything: it
enqueues a row per enabled destination and wakes a drain thread that owns the sending
(#146).

Four channels ship, which is the whole of the schema's vocabulary:

- **Email** is the existing sender moved behind a channel adapter — now recorded, retried,
  and attaching the same bundle the export route builds, search-record companions included,
  which the email hook had always quietly left out.
- **Folder** writes that bundle into a directory you chose, atomically. A synced folder
  becomes a delivery destination with no code of ours on the wire.
- **Webhook** posts a signed JSON envelope: what ran, when, how many results and how many
  new, the read-time coverage line, the report's sha256, a link to the search record, and
  the bundle either as a time-limited link the receiver fetches or, if you ask, inline. The
  signature is HMAC-SHA256 over the exact bytes posted, keyed with a per-target secret in
  your keyring. HTTPS only, except for a receiver on 127.0.0.1 (#148).
- **Feed** writes an Atom file a reader can subscribe to.

A target can be set to **review** instead of automatic, and then its delivery waits at
`awaiting_review` until you say so. There is deliberately no automatic promotion anywhere in
that module, however long the wait is.

Failures back off one minute, five minutes, twenty-five minutes and then stop with the
reason on the row. `UNIQUE(execution_id, target_id)` plus a compare-and-swap claim is what
makes *delivered exactly once* something the database enforces. A row left mid-delivery by a
backend that was force-quit is re-queued on the next start — and only where that owner can
be established to be gone, because resmon would rather send a report twice than never (#146,
#148, #149).

The bundle link is the one route that answers without resmon's local API token. A webhook
receiver is not resmon and has no business holding a credential that opens every route, so
the link carries its own proof: a signature over the delivery id and an expiry, checked by
the route, with the Host and Origin guards still applying (#148).

## Backup and restore, as one pair

Nothing in resmon backed up the database or a single vault byte, and nothing could restore.
`POST /api/cloud/backup` uploaded the reports tree to Drive and had no counterpart on the
way back.

There is now one bundle: the database snapshotted through SQLite's own backup API —
consistent under WAL, no sidecars — every retained vault byte re-hashed against the catalog
on the way out, optionally the reports tree, and a manifest naming every file, its hash, the
table counts, and, **by name and never by value**, the keyring entries a restore cannot
bring back.

The restore is staged, because a request thread cannot safely replace the database its own
process has open. `/api/restore` verifies the bundle and writes a pointer; the next start
acts on it before anything opens the database, moving the current database aside rather than
deleting it. And there is a drill: the restore is exercised end to end rather than asserted
(#153).

## Three schema steps in one launch, proven from a corpus 2.2.0 wrote

A 2.2.0 corpus walks **18 → 21** on the first launch of 2.3.0: the `executions` rebuild with
its wider CHECK and its new columns, then `request_id` and `routine_missed_fires`, then the
two delivery tables.

That walk is proven against a database **v2.2.0's own code wrote** — the fixture that
release left behind, committed beside its generator, regenerated out of process and diffed
so that the claim "this is what v2.2.0 produced" stays falsifiable (#135). It is not a
hand-reasoned idea of what an older database looks like, which is the class of mistake that
shipped a broken migration once before.

2.3.0 leaves the same thing for the release after it: a schema-21 corpus its own code wrote,
seeded at every value of every enumerated CHECK the schema carries — except two that no code
in 2.3.0 writes, which are named in the generator rather than invented. And the walk case
now runs over **every** released fixture rather than only the newest, because adding this
one would otherwise have silently dropped the 18 → 21 walk — which is exactly the walk a
2.2.0 user takes.

CI gained two guards worth naming: it refuses a committed symlink or a maintainer's home
directory in a tracked file before anything installs, and that guard was proven by being
made to go red (#154); and the e2e suite now names the interpreter it starts the backend
with, and fails loudly instead of exiting 0 on a run where most specs never ran (#150).

## Smaller things

- **Nine registered sources that the acknowledgments had never credited** are credited, and
  the lead-in no longer carries a count that had gone stale (#140).
- **Tutorials link the YouTube walk-throughs instead of embedding them.** The tab renders no
  third-party frame and sends no request to YouTube; every link opens in your own browser
  (#134). The two YouTube origins then left the renderer's Content-Security-Policy, where
  nothing needed them and nothing would have noticed if something started using them again —
  and a test now pins the exact source set per directive, because a CSP only ever loosens
  silently (#144).
- **Two dependencies, examined.** `tailwindcss` had been a runtime dependency since the
  initial commit and was never used: no import, no directive, no build step, and a
  production `dist` that is byte-for-byte identical without it. It is gone. APScheduler's
  `[sqlalchemy]` extra, which *was* being relied on, is now declared (#138, #144).
- **A live test that finds nothing now fails by asserting** rather than passing quietly
  (#137), and a HAL budget case no longer depends on how precisely `time.sleep` returns
  (#145).

## What this release does not do

- **It does not run your missed sweeps for you.** A missed fire is recorded, not caught up
  (#141).
- **`routine_missed_fires.disposition` has three values and resmon writes two.** `skipped`
  is in the vocabulary so a later policy needs no migration; nothing writes it yet, and the
  fixture this release leaves behind therefore contains no row at that value (#141).
- **A delivery record is a record of what resmon did, not proof of what arrived.** A folder
  delivery says the bundle was written; it cannot tell you your sync client uploaded it. A
  webhook delivery says the receiver answered; it cannot tell you a person read it.
- **A row left `delivering` may have been sent.** resmon re-queues it on the next start and
  would rather you see one report twice than never see it (#146).
- **`interrupted` is what resmon can establish, not everything that is true.** A pid that
  has been reused, or one owned by another user, reads as alive, and its row stays
  `running` until something can say otherwise (#139, #149).
- **A restore cannot bring back your keyring.** The manifest names the entries by name so
  you know what to re-enter; the values were never in the bundle (#153).
- **The upgrade proof walks 13 → 21 and 18 → 21, from corpora v2.1.0 and v2.2.0 wrote.** It
  establishes nothing about a database written by any other version, about sqlite-vec, or
  about the renderer.
- **An MCP server needs no change this time.** The contract is still 2.3 and the inventory
  is still twenty-five tools. A 2.3 MCP server pointed at a 2.2 backend simply gets no
  delivery summary back.
- **macOS builds are still unsigned.** They cannot self-update, which is why no
  `latest-mac.yml` is published for them.
