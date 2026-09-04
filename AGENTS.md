# AGENTS.md — working rules for AI agents in this repository

resmon is a desktop application that watches scholarly literature for a researcher and
tells them when their monitoring has broken. It is a FastAPI/SQLite backend and an
Electron/React renderer, distributed as an installer for seven platform targets.

Two harnesses work this repository: **Claude Code** and **Codex**. This file is the
contract both read. Claude Code additionally carries a private workspace `CLAUDE.md`
holding project history; anything a Codex session needs is here.

---

## The one rule that outranks the others

**Never overclaim.** Every user-facing string, docstring, comment, PR body and log line
says only what the code actually establishes. A field extracted from a document, a field
matched against the corpus, and a field guessed by a model are three different kinds of
fact, and resmon labels which is which. Where the app cannot know something, it says so
rather than rendering a plausible number.

This is the product's whole differentiator, and it is a review gate: a change that
implies more certainty than it earns is rejected even when the code is correct.

---

## Layout

```
resmon_scripts/
├── resmon.py                       FastAPI app — 88 routes, the API seam
├── implementation_scripts/         backend modules
│   ├── api_base.py                 BaseAPIClient, NormalizedResult, RateLimiter, safe_request
│   ├── api_<slug>.py               one source client each; self-registering
│   ├── api_registry.py             slug → client class
│   ├── repo_catalog.py             REPOSITORY_CATALOG — public metadata served to the UI
│   ├── database.py                 schema + migrations
│   └── ...                         sweep_engine, scheduler, watchdog, lifecycle, …
├── verification_scripts/           pytest suite + conftest.py
└── frontend/src/                   React renderer (pages/, components/, api/, hooks/)
```

Backend and renderer talk **only** over HTTP on `127.0.0.1`. That boundary is the seam:
work on one side of it cannot break the other except through an endpoint's shape.

## Commands

```bash
# Backend — from the repo root
.venv/bin/python -m pytest -q          # hermetic suite: 1018 pass, 45 deselected
.venv/bin/python -m pytest -m live_network   # the 45 — real scholarly APIs and CLIs

# Frontend — from resmon_scripts/frontend
npm run typecheck && npm test && npm run build   # 190 tests across 26 suites
npm run e2e                                      # the real Electron app — 24 routes
```

All five must pass before a PR opens. `npm run e2e` launches the app itself (PR #59); a
route you change must still load, and the renderer suite is jsdom and cannot tell you
that.

**Adding a page means adding a row, not a route.** `frontend/src/routes.ts` is the one
route table: `App.tsx` renders from it and `e2e/routes.ts` imports it, so a new page is
swept by the smoke suite automatically and a page cannot exist without one.
`src/__tests__/routes.test.tsx` fails if `App.tsx` hand-writes a `<Route>` around the
table, or if a Settings/About tab is declared in its page and not in the table's
`children`. CI runs the backend suite on Python 3.10, 3.11 and
3.12, plus the frontend job; **3.12 is not decoration** — it releases the GIL around
sqlite3 aggressively and is the acceptance test for the per-thread-connection fix. If
that column alone goes red, suspect a shared `sqlite3.Connection`.

## Test-suite facts you cannot infer from the code

- **Hermeticity is enforced.** `conftest.py` blocks any non-loopback socket from a test
  not marked `live_network`. A new test that needs the network carries the marker.
- `conftest.py` installs an in-memory keyring and joins execution worker threads before
  fixture teardown. Both fixed real flakiness; both stay.
- `_db_path = ":memory:"` is backed by a temp file, not a true in-memory database, so
  every thread's connection sees the same data.
- A test that asserts on the scheduler needs it live — CI deliberately leaves
  `RESMON_DISABLE_SCHEDULER` unset.

---

## Branch and PR protocol

`main` is protected and reached only through a pull request. Three remotes:

| Remote | Repository | Role |
|---|---|---|
| `upstream` | `ryanjosephkamp/resmon` (public) | **The original. PRs open here.** |
| `origin` | `ryanjosephkamp/resmon-upgrade` (private) | working mirror |
| `archive` | `ryanjosephkamp/resmon-classic` (private) | frozen pre-harness app |

```bash
git fetch upstream && git checkout -b <prefix>/<slug> upstream/main
# … work, test …
git push origin <prefix>/<slug> && git push upstream <prefix>/<slug>
gh pr create --repo ryanjosephkamp/resmon --base main --head <prefix>/<slug>
```

Branch prefixes: `feat/ fix/ perf/ test/ docs/ chore/ release/`. **Codex sessions prefix
every branch `codex/`** so ownership is legible in the branch and PR lists.

Force-pushing, history rewriting and deletion in `ryanjosephkamp/resmon` are prohibited
without exception — including on your own branch once its PR is open.

Keep branches short: one deliverable, days rather than weeks, and small enough to review
in a sitting. A branch growing past that was mis-specified; split it.

### PR bodies

The PR body is how the other harness and the maintainer learn what happened — it is the
only channel between sessions. Every PR carries:

**What changed and why** · **How it was verified** (the exact commands and their output
counts) · **What it deliberately does not do** · **Files touched outside the brief**, if
any, with the reason.

That last section is load-bearing for delegated work: an unexplained file outside the
brief's ownership list is a review failure regardless of whether the change is good.

---

## Conventions

- **Docs move in step.** A user-visible change updates, in the same PR: the README
  section that covers it, `AboutResmon/TutorialsTab.tsx`, and the relevant `PageHelp`
  entry. A PR that ships a feature with no documentation is incomplete.
- **Comments explain the why**, especially the non-obvious one. This codebase's comments
  record what broke and how it was found; match that density and that voice.
- Type hints on new Python; no `any` in new TypeScript.
- Python 3.10 is the floor — no `match` statements or 3.11+ syntax.
- No new runtime dependency without saying so explicitly in the PR body: the app ships a
  bundled interpreter and every dependency lands in a ~900 MB build.

## The two "cloud"s — do not conflate them

`resmon_scripts/cloud/`, the resmon-cloud microservice, was **deleted**. It is gone on
purpose and does not come back.

`implementation_scripts/cloud_storage.py` is **Google Drive backup**, a live desktop
feature. `/api/cloud/*`, `/api/settings/cloud`, the `cloud_sync` table and the
Settings → Cloud Storage tab all belong to it and all stay.

---

## Adding a source client

**Full guide: [`docs/adding-a-source.md`](docs/adding-a-source.md).** Read it before starting
— it carries the terms questions, the field-level storage rule, the attribution states and the
retirement mechanism, all of which came from getting them wrong. What follows is the file list
and the contract; the guide is the reasoning behind them.

**Ask the license question first.** resmon *stores* what it retrieves, indefinitely, and the
user may back that database up to their own cloud storage. A source can be technically perfect
and still be unusable: J-STAGE was refused on its terms, and IEEE Xplore shipped and was later
withdrawn because §4(c) forbids using a retrieval application against its content at all.
Check `docs/source-landscape.md` first — 22 shipped sources and 27 candidates are already
assessed.

**Store only the fields the terms permit.** Where a source conditions a field on provenance,
license or an access flag, the client reads that field and honours it. Reference
implementation: `_licensed_abstract` in `implementation_scripts/api_inspire_hep.py`. A record
whose abstract cannot lawfully be kept is still indexed, without one.

**Record an attribution obligation, do not invent one.** Catalog entries carry `attribution`,
`attribution_requirement` (`none` / `requested` / `required`) and `attribution_source`.
Required means a license condition and renders unconditionally; requested means a courtesy.
The default is `none`, and silence is the correct value.

A new source `<slug>` touches these files and no others:

| File | Change |
|---|---|
| `implementation_scripts/api_<slug>.py` | **new** — subclass `BaseAPIClient`, implement `search()` and `get_name()`, call `register_client()` at module scope |
| `implementation_scripts/api_registry.py` | add `"api_<slug>"` to `_CLIENT_MODULES`, alphabetically |
| `implementation_scripts/repo_catalog.py` | add an `_entry(...)` to `REPOSITORY_CATALOG`, alphabetically by slug |
| `verification_scripts/test_repo_catalog.py` | the two catalog-length assertions |
| `verification_scripts/test_api_repositories_catalog.py` | the catalog-length assertion |
| `verification_scripts/test_api_tier*.py` | registration + instantiation, and a `live_network` search test |
| `frontend/src/components/Forms/RepositorySelector.tsx` | the offline fallback slug list |
| `README.md` → *Supported Repositories* | one row |

Contract for the client itself:

- `search()` returns `list[NormalizedResult]`, honours `date_from` / `date_to` /
  `max_results`, and returns `[]` on upstream failure — logged, never raised. A source
  being down degrades the sweep; it does not fail it.
- Every HTTP call goes through `safe_request()` with a **module-level** `RateLimiter`
  shared by all instances of that client — concurrent sweeps must contend on one object.
- The rate limit is whatever the upstream publishes, or slower. Where the upstream states
  none, pick a conservative number and record the reasoning in a comment.
- `source_repository` is the slug, lowercase, matching the catalog entry.
- `external_id` is stable across runs: dedup and the lifecycle checks key on it.
- A malformed record is skipped and logged, never allowed to abort the batch.

**The catalog is not decoration.** `rate_limit`, `upstream_policy` and
`keyword_combination` are rendered to the user on the Repositories page and are read as
statements of fact. `keyword_combination` in particular describes how the *upstream*
combines space-separated terms — implicit AND, explicit OR, relevance-ranked — and
getting it wrong makes the app lie about someone else's search engine. Verify it against
the upstream's documentation rather than assuming.

**Retiring a source takes two changes, not one.** Removing a module from `_CLIENT_MODULES`
does not retire it: every `api_*.py` calls `register_client()` at import scope, so any import
puts the source back into the process-wide registry — which is how `api_ieee` stayed reachable
and its tests kept passing when they should have failed. Add the slug to
`api_registry.RETIRED_REPOSITORIES` with the reason a user should see, *and* remove the
module's `_register()` call. Keep the client on disk.

`match_explain.py` holds `_LOCALLY_FILTERED_SOURCES`: the sources whose keyword matching
resmon performs itself and can therefore speak about with certainty. A new source belongs
in that set only if resmon does the filtering — for relevance-ranked upstreams it does
not, and claiming otherwise is an overclaim.

---

## Ownership

These files change through Claude Code only, because something downstream depends on
their shape:

`resmon.py` · `implementation_scripts/database.py` · `implementation_scripts/api_base.py`
· `.github/workflows/*` · `docs/_posts/*` · this file

A delegated task may touch the shared registry files — `api_registry.py`,
`repo_catalog.py`, `match_explain.py`, and the catalog-length assertions — **when its
brief names them**. Otherwise a change there is a collision.

Where a single deliverable needs both harnesses at once, the endpoint shapes are written
into `docs/api-contract/<slice>.md` and merged before either side starts. That file is
frozen for the duration: changing it takes its own PR.

---

## Delegated tasks

A delegated task arrives as a written brief that names its deliverables, its acceptance
criteria, and every file it may touch. Work the brief. Where it is silent or wrong,
record the question in the PR body and proceed with the reading you state — do not widen
the change to cover it.

Every delegated PR is reviewed by Claude Code against its brief before it reaches the
maintainer. Expect the review to check contract conformance, whether the tests genuinely
exercise the behavior they name, and whether anything in the diff claims more than it
proves.
