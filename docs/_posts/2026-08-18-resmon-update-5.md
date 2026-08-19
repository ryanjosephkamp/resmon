---
layout: post
title: "resmon Update 5 — August 18, 2026"
date: 2026-08-18 12:00:00 -0400
categories: [updates]
---

# Update 5 — Hardening: A Clean Install That Actually Starts, a Suite That Actually Finishes, and CI to Keep It That Way

## Metadata

- **Update number:** 5
- **Update type:** bugfix / infrastructure
- **Date:** 2026-08-18
- **Version:** 1.2.1 → 1.3.0
- **Scope:** packaging, concurrency, test infrastructure, continuous integration, documentation

## Summary

Twenty-five defects were found by installing resmon exactly the way the README tells
a new user to, running everything the project ships, and then reading the parts that
had never been exercised. Twenty-four are fixed. The one that remains is documented
here rather than quietly left in place.

Five of them were found by CI itself, after the first eighteen were already fixed —
including the one that mattered most to users.

The headline is unglamorous: **a fresh clone could not start**, and **the test
suite could not finish**. Both are fixed, and there is now CI so neither can come
back unnoticed.

## Motivation

resmon's features were in good shape — the frontend type-checked cleanly, the
production build succeeded, and 290 backend tests passed. The problems were all
*around* that working core, in the places nobody re-checks once they work on the
machine they were written on.

Three of them could only be found by starting from nothing:

- `requirements.txt` never listed `python-dateutil`, which the scheduler imports.
  It had simply always been present in the author's environment.
- The cloud service's dependencies were pinned nowhere, so nine test files could
  not even be collected — and behind that, `cloud/metrics.py` turned out to have
  a syntax error and to have never been importable at all.
- Reading the OS keychain had no time limit, and on macOS that call waits on a GUI
  prompt. It hung the whole test suite indefinitely.

## Changes

### A clean install works

- **Added `python-dateutil` to `requirements.txt`.** Without it, a virtualenv built
  from the README could not `import resmon`, and all 53 backend test files failed
  at collection.
- **Pinned the cloud service's own dependencies** — PyJWT, PyNaCl, boto3, alembic,
  prometheus-client, python-json-logger, redis — and `moto` for the test that
  stands up a local S3. The Dockerfile no longer re-specifies them.
- **Fixed a syntax error in `cloud/metrics.py`**: a missing comma after the
  `executions_total` help string. The cloud microservice had never parsed. The
  missing dependencies had been hiding it, because the import failed earlier.

### Every thread now has its own database connection

The deepest fix in this release, and the one that took the longest to characterise
honestly.

resmon kept a **single** process-wide `sqlite3.Connection` and used it from every
FastAPI request thread *and* every execution worker thread, with nothing serialising
them. sqlite3 connections are not safe for concurrent use. Python 3.10 and 3.11
largely got away with it because their `sqlite3` module holds the GIL across most
operations; 3.12 releases it far more aggressively, so the race was lost reliably
there and intermittently everywhere else. It surfaced as, variously:

```
sqlite3.InterfaceError:   bad parameter or other API misuse
sqlite3.ProgrammingError: Cannot operate on a closed database
sqlite3.OperationalError: cannot start a transaction within a transaction
```

Each thread now opens its own connection. `_get_db()` is the single point every call
site already went through, so the change lands everywhere at once rather than only on
the path that happened to expose it; the execution worker additionally rebinds the
engine, which had captured the request thread's connection at construction.

Two supporting changes were needed. `init_db` now commits — schema left inside an open
transaction on one connection is invisible to every other. And the `":memory:"` test
hook is now backed by a temp file rather than a real in-memory database: an in-memory
database is private to its own connection, and the obvious workaround, SQLite's
shared-cache mode, takes coarser table-level locks that `busy_timeout` does not retry.
Tests now run against exactly the file-plus-WAL configuration resmon actually ships.

**Python 3.12 is supported, and is in CI**, alongside 3.10 and 3.11.

There are six new tests aimed squarely at the concurrency rather than waiting for it to
surface by luck — including one that hammers the database from twelve threads at once,
and one that asserts the worker thread does not reuse the request thread's connection.
All six were checked against the pre-fix code first: three of them fail there, which is
the only evidence that a regression test is worth having.

### Concurrency and lifecycle

- **Keychain reads are now bounded.** Every keyring call runs on a daemon thread
  joined with a timeout. Reads degrade to "credential not present"; writes and
  deletes raise rather than falsely reporting success. Previously
  `GET /api/cloud/status` could hang forever and hold an ASGI worker with it.
- **An execution can no longer strand its concurrency slot.** `admission.note_finished`
  was the last unguarded statement in a `finally` block, after the progress-persist
  step. Any database error there leaked the slot permanently — and after three
  (the default cap) resmon rejected every Deep Dive and Deep Sweep with HTTP 429
  while nothing was actually running. Slot release now has its own `finally`.
- **Rate limiting works under load.** `RateLimiter.acquire()` had no lock, so
  concurrent sweeps sharing a source's limiter all woke together. Measured against
  arXiv's 0.33 req/s ceiling, four concurrent sweeps issued every request within
  0.00 s of each other — 1.32 req/s, four times the advertised limit, the kind of
  thing that earns a temporary IP block. Now correctly serialised.
- **A new execution no longer inherits an old one's progress log.**
  `ProgressStore.register()` only touched its dictionary entry instead of clearing
  it. Reachable in practice: cleanup is skipped whenever the persist step raises,
  and "Erase executions" resets `sqlite_sequence`, so ids restart at 1.
- **`get_connection()` rejects a wrong-typed argument.** It used to apply `str()`
  to whatever it was given, so passing a connection created a database file
  literally named `<sqlite3.Connection object at 0x...>` rather than raising. One
  caller did exactly that, and its schema setup had been silently doing nothing.
- **Service install/uninstall cannot hang.** The `launchctl` / `systemctl` /
  `schtasks` calls behind `POST /api/service/install` had no timeout.

### AI summarization was unusable on a fresh offline install

The most user-facing defect of the set, and it was CI that exposed it.

`summarizer.py` bootstraps NLTK's sentence tokenizer at import, downloading the
`punkt_tab` data if it is missing. pip does not ship NLTK's corpora, so on a fresh
install that download is the only thing standing between a user and a working
summarizer — and `nltk.download(quiet=True)` returns `False` on failure rather than
raising. On a machine that is offline, behind a firewall, or simply cannot reach
NLTK's servers, the bootstrap failed **silently**, and every later call raised
`LookupError: Resource 'punkt_tab' not found`, failing the whole execution.

So: enable AI summarization, run a sweep without a network path to NLTK, and the
headline feature died with an error naming a Python library the user never asked
about. The README never mentioned the data either.

Sentence splitting now degrades to a regex splitter with one clear warning naming the
exact command to install the data properly, and the README documents it as an optional
step with an honest description of what skipping it costs.

A related fix in the same file: the tiktoken encoder was wrapped in `except KeyError`,
but tiktoken *downloads* its vocabulary, so for a known model it fails with a network
error instead — which escaped the constructor entirely. The character-count fallback
the class documents was unreachable in exactly the case that needed it.

### The renderer

- **The Monitor page's tab focus works.** Closing the focused execution tab left
  focus pointing at the execution that had just been removed.
  `clearExecution()` computed the next focus inside one React state updater nested
  in another and read it from the outer one — which React runs first, so the value
  was never observed.

### Test infrastructure

- **Jest now runs the renderer specs.** Three well-written
  `@testing-library/react` specs had been in the repository with no runner and no
  `test` script, so they had never executed once. They run unchanged, and found
  the focus bug above within minutes.
- **Live-network tests are separated from unit tests.** Nine tests hit real
  scholarly APIs; they are marked `live_network` and deselected by default, so the
  suite runs offline and in CI. The three affected files are each *mixed*, so they
  are marked test-by-test — marking whole files would have dropped eight hermetic
  tests from the default run.
- **Added a `conftest.py`.** The suite raced its own background worker threads and
  reached for the developer's real keychain. It now waits for worker threads before
  any fixture teardown, and installs an in-memory keyring.

- **Hermeticity is now enforced, not assumed.** Marking the live tests by hand was not
  enough: two stragglers were missed and only surfaced when arXiv rate-limited a CI
  runner. Both swallowed their own network errors, so locally they simply passed.
  `conftest.py` now blocks any non-loopback socket from a test that is not marked
  `live_network`, and the failure message names the host and says what to do.

### Continuous integration

- **Added `.github/workflows/ci.yml`.** On every push and pull request: `compileall`
  over the whole tree, an explicit import of both the desktop backend and the cloud
  service from a clean install, the hermetic pytest suite on Python 3.10 and 3.11,
  and then typecheck, renderer tests, and build for the frontend.

  It earned its place immediately, catching two things a local run could not: the
  suite only worked under `python -m pytest` because that adds the working
  directory to `sys.path`, and `npm ci` rejected a lockfile that npm itself cannot
  make portable across platforms.

### Documentation

- **The repository count is now correct.** The README claimed 16 sources, the tests
  claimed 17, and the catalog that actually feeds the Repositories page exposes 15.
  medRxiv was the phantom: it is served by the bioRxiv client but has no catalog
  entry, so it cannot be selected separately. The README says so now instead of
  advertising a source the UI does not offer.
- **Removed five directories from the project structure** that are not in the
  repository: `given_scripts/`, `notebooks/`, `resmon_experiments/`,
  `resmon_printouts/`, `resmon.app/`.
- Migrated four deprecated FastAPI `on_event` hooks to a `lifespan` handler, and
  renamed a Pydantic field that shadowed a base-class attribute. resmon's own code
  now emits no warnings.

### Four flaky tests, one root cause

CI failed repeatedly on the same commit while every local run passed. Each failure
turned out to be the same pattern: **a test's scope ends at the HTTP response while
the work continues on a daemon thread.**

- A calendar-colour test's arXiv mock was restored before the background execution
  used it, so the execution quietly queried the real API.
- A cancel test slept a fixed second and hoped the execution had finished.
- Fixtures closed the shared database while a worker was still writing to it.
- Two "returns immediately" tests let their worker escape the patch scope entirely.
  With the network blocked it then retried with backoff for longer than the
  thread-join timeout, survived into the next test, and re-registered its execution
  id in the process-wide progress store. Because every test gets a fresh in-memory
  database, ids restart at 1 — so the next test's SSE read saw that id as live and
  streamed heartbeats until the run was killed.

All four are fixed, and the suite now runs green across repeated CI runs.

## Verification

Measured on a fresh `git clone` into a new virtualenv, not on a working tree:

| | Before | After |
|---|---|---|
| Clean install from `requirements.txt` | backend will not import | imports; cloud service too |
| Backend suite | hangs indefinitely | 404 passed, 4 skipped, ~40 s |
| Test files that can be collected | 44 of 53 | 53 of 53 |
| Renderer tests | 3 specs, never run | 13 passing |
| Warnings from resmon's own code | 3 | 0 |
| CI | none | green on 3.10, 3.11, 3.12 and the frontend |

## Follow-ups

One finding is **not** fixed, and is worth stating plainly.

- **BUG-016 — `webSecurity: false`.** The Electron main window disables the
  same-origin policy. It may well be unnecessary now that the renderer is served
  over `http://127.0.0.1` rather than `file://`. Verifying that requires exercising
  every page against a live backend, so the flag was left alone rather than flipped
  blind.

Also outstanding: the cloud service's privacy notice is not tracked in the
repository, so the test that checks its contents now skips with an explanatory
message instead of failing.
