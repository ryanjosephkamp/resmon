# AGENTS.md — working rules for AI agents in this repository

resmon is a desktop application that watches scholarly literature for a researcher and
tells them when their monitoring has broken. It is a FastAPI/SQLite backend and an
Electron/React renderer, built for four platform targets — `macos-14`, `macos-15-intel`,
`windows-latest`, `ubuntu-latest` — which produce seven published release assets (four
installers, two updater feeds and a blockmap). This line said "seven platform targets"
until 1.9a; the seven was the asset count.

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
├── resmon.py                       FastAPI app — 194 routes, the API seam
│                                   described in docs/api-contract/ (generated, guarded)
├── implementation_scripts/         backend modules
│   ├── api_base.py                 BaseAPIClient, NormalizedResult, RateLimiter, safe_request
│   ├── api_<slug>.py               one source client each; self-registering
│   ├── api_registry.py             slug → client class
│   ├── repo_catalog.py             REPOSITORY_CATALOG — public metadata served to the UI
│   ├── database.py                 schema + migrations
│   └── ...                         sweep_engine, scheduler, watchdog, lifecycle, …
├── verification_scripts/           pytest suite + conftest.py
├── cli/                            the `resmon` command line: standard library only,
│                                   pipx install ./resmon_scripts/cli
├── frontend/src/                   React renderer (pages/, components/, api/, hooks/)
└── frontend/atlas/                 the Atlas renderer, built beside the classic one
                                    (Vite, into dist/atlas); RESMON_UI=atlas serves it
```

Backend and renderer talk **only** over HTTP on `127.0.0.1`. That boundary is the seam:
work on one side of it cannot break the other except through an endpoint's shape.

**The Atlas renderer keeps nothing in browser storage.** It is served from a new loopback
port on every launch, and `localStorage` belongs to the origin, port included, so it starts
empty each time. A preference Atlas must remember is an engine route: the theme and accent
are `/api/appearance`. Accent tones are derived in `atlas/src/theme/accent.ts`, and
`theme/__tests__/accent.test.ts` holds every tone to its contrast line over 530 colors in
both themes. An Electron spec that depends on the system theme passes `colorScheme: null` to
`electron.launch`: Playwright otherwise tells the page the system is light, while the main
process reads the real one.

**The collection map (`/api/map`, `implementation_scripts/collection_map.py`) is derived
data with a stated basis.** Positions come from the set embedding model only when it has
embedded 90% of the corpus, otherwise from word statistics computed on the machine, and
the answer's `basis` says which: never describe a `words` map as placing papers by meaning.
Region names are always lexical. A full fit runs on a background thread (about 25 s and
under 600 MB at 100,000 papers, measured) and is cached beside the database as
`<db>-map.npz`, which `_erase_corpus` deletes because it holds words from the papers.
NumPy is the one dependency it added.

**The `resmon` command line is a client of the HTTP API, never of the database.** Like the MCP
server, it finds a running engine from files: `RESMON_PORT` alone when set, else `daemon.lock`
(the service, preferred because it owns the schedule), else the port file, with the token from
`api-token-<port>`. It never starts an engine for a command, because an engine's start is not a
read (a staged restore, a schema migration, adopting runs as interrupted, the delivery drain);
`resmon_cli/engine.py` sets that out. `test_cli.py` fails if any CLI module mentions `sqlite3` or
`implementation_scripts`, and drives the real service entry point and the window's engine through
`perf.instance`. `--json` prints the engine's body unchanged, so a route the CLI reads that changes
shape changes its output: the same test compares them.

## Commands

```bash
# Backend — from the repo root
.venv/bin/python -m pytest -q          # hermetic suite: 3147 pass, 5 skip, 108 deselected (CI, Python 3.11)
.venv/bin/python -m pytest -m live_network   # the 108 — real scholarly APIs, CLIs and sockets
                                             # 92 of them run weekly in CI; see below

# Frontend — from resmon_scripts/frontend
npm run typecheck && npm test && npm run build   # 1054 tests across 102 suites
npm run e2e                                      # the real Electron app — 136 cases in 53 files, 29 routes; report actual pass/skip counts
npm run e2e:review                               # the same, on your display, into one folder
```

All five must pass before a PR opens. `npm run e2e` launches the app itself (PR #59); a
route you change must still load, and the renderer suite is jsdom and cannot tell you
that.

**CI runs the app twice, because one runner cannot see all of it.**
`ui-smoke.yml` has a `smoke` job on `ubuntu-latest` under `xvfb-run` and a
`window` job on `macos-15`. `xvfb-run` starts a bare X server with **no window
manager**, so maximize, focus and stacking are silent no-ops there — the
window-manager specs skip on that job, and its run summary lists every
`NOT VERIFIED` line the suite printed. A green tick from the xvfb job alone is
not a statement about the window.

`npm run e2e:review` runs the whole suite on your own display and writes the
screenshots and a Markdown summary to a directory **outside the repository** —
what passed, and what the run explicitly did not verify. That is the artifact a
handback embeds. Screenshots are not committed: `e2e/screenshots/` is
gitignored, because two branches that both run the suite both rewrite every
file, and a committed screenshot is a merge conflict rather than evidence.

**A source's `entity_search` capability is not a promise the client keeps.** The catalog
records how a source can be asked about a *person* — `au:"{name}"` for arXiv,
`creator="{name}"` for NDL — and `api_base.search_entity` asks by putting that syntax into
the query string. A client that **rewrites** the string destroys it, and the failure is
silent: arXiv answered `all:au:"…"` with HTTP 400 and NDL matched a literal
`creator="…"` against nothing, so both reported that the person had published nothing for
as long as the capability existed. `test_no_askable_client_rewrites_the_query_it_is_handed`
drives all thirteen field-query clients hermetically and requires the field and the name to
survive together into the request; `test_entity_search_live.py` drives every askable source
against the real API, weekly. **A live weekly test is what found this; it is not what will
catch it coming back.**

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
- **`live_network` is now two things, and the second marker draws the line.** Most live
  tests need the internet and nothing else, and `.github/workflows/live-network.yml`
  runs those **weekly** — because nothing ran them on a schedule and in 1.9 a live test
  contradicting the shipped MCP contract stayed red on `main` for two releases unheard.
  A live test that needs something belonging to the *person* — a signed-in agent CLI —
  also carries `needs_agent_cli`, and the weekly run's summary names every one it could
  not run. The selection lives in `verification_scripts/live_suite.py`, the workflow asks
  that file for it, and `test_live_suite.py` fails when the two halves stop partitioning
  the live suite exactly. **A new live test must fall in one half or the other.**
- **A provider's outage is quarantined, never skipped.** `live_quarantine.json` beside
  `live_suite.py` lists at most two live cases, each with a failure signature (such as
  `http_500`), a first-observed date, an expiry at most 30 days later, and the status
  captured from two vantage points. A quarantined case still runs and asserts. Only a
  failure whose recorded source outcome carries the signature becomes an xfail; any
  other failure fails the run, a pass is reported as a recovery, and an expired entry
  is ignored. Every summary prints "N of M asserted; Q quarantined" from a collection.
  Rules: `live_evidence.py`; proofs at a real exit status: `test_live_suite.py`.
- `conftest.py` installs an in-memory keyring and joins execution worker threads before
  fixture teardown. Both fixed real flakiness; both stay.
- **Every backend request needs the local API token** (2.2; `docs/local-api-security.md`).
  `conftest.py` configures a real token and swaps `TestClient` for one that addresses
  `http://127.0.0.1:<port>` and sends it; `RawTestClient` is the unauthenticated original.
  There is no switch that turns the guard off, and `Host: testserver` is refused. A test
  that starts its own backend process reads the token from `<RESMON_STATE_DIR>/api-token-<port>`;
  e2e specs call the backend through `e2eFetch` / `e2eAuth` from `fixtures/resmon-app.ts`,
  never a bare `fetch`, while the app's own requests are left untouched so the suite proves
  the renderer sends the token itself. Properties: `test_local_api_auth.py`.
- **`RESMON_STATE_DIR` alone does not isolate a run.** It is read by `daemon.state_dir()`,
  so the daemon lock and the `api-token-<port>` files follow it — but `config.py` never
  reads it. The database comes from `RESMON_DB_PATH`, falling back to a path relative to
  the checkout (`config.py:19`), reports from `RESMON_REPORTS_DIR`, and the port file from
  `RESMON_PORT_FILE`, which defaults to sitting beside the database. `electron/main.ts`
  does derive the first two from the state directory, but only inside `if (app.isPackaged)`
  (the block at `main.ts:390`). So a backend started directly — which is what a test
  harness does — and an unpackaged Electron run both keep using the checkout's `resmon.db`
  no matter what `RESMON_STATE_DIR` says, and two such runs with different state
  directories share one database. **Isolating a run means setting `RESMON_DB_PATH` and
  `RESMON_REPORTS_DIR` explicitly**, alongside `RESMON_STATE_DIR`; set `RESMON_PORT_FILE`
  too unless you want the port file beside the database.
- `_db_path = ":memory:"` is backed by a temp file, not a true in-memory database, so
  every thread's connection sees the same data.
- A test that asserts on the scheduler needs it live — CI deliberately leaves
  `RESMON_DISABLE_SCHEDULER` unset.
- **A release that bumps `SCHEMA_VERSION` is gated on `test_cumulative_upgrade.py`,
  and adds the fixture of the version it ships.** Each schema step has its own
  upgrade test starting from the step before it; five green step tests are not the
  journey a user takes, which is one `init_db` across every step at once over a
  database a *released* resmon wrote. That database is
  `verification_scripts/fixtures/v2.1.0/corpus_schema_13.sql`, generated by driving
  tag v2.1.0's own code — the generator is committed beside it and one case
  regenerates and diffs, skipping where the tag is absent (CI clones at depth 1).
  The procedure and the rule for the next release are in
  [`docs/release-verification.md`](docs/release-verification.md).

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

## Generation counters in the renderer

Four of the twelve renderer files that declare a numeric `useRef` counter
were written with a single one that several independent operations took a
ticket from. Anything that bumped it discarded
the outcome of every other operation still in flight, and a discarded outcome
is written nowhere: no result, no refusal, no sentence saying a request was
abandoned. The user clicks, the request completes, and the page looks exactly
as it did before — which is the one thing this application exists not to do.
Review is a poor defense, because the code reads as a correct stale-response
guard; and the suite stays green, because it asserts what the *surviving*
operation does.

There are three reasons to drop an answer, and the bug is one counter made to
carry all three. `src/hooks/useRuns.ts` separates them and is the easy path:

- **A later run of the same control.** `begin(key)` claims a ticket and
  supersedes only that key. A key may carry its subject — ``delete:${id}`` —
  so deleting one row cannot erase another row's refusal.
- **The component is gone.** `mounted` carries it, `current` reads it, and no
  counter is involved. `end()` says it at a Close click rather than waiting
  for the commit.
- **The subject changed** — another project, another file. That is an identity
  checked when the answer arrives, or `token(key)` to watch a counter without
  claiming it. A counter used for this is what makes operations cancel one
  another.

Anything that is none of those three is an outcome the user is owed.

`src/__tests__/generationCounterShape.test.ts` reads the renderer's syntax
tree for three shapes that are nearly always wrong, and an occurrence that
is deliberate goes in `generationCounters.allow.json` with its reason and the
number of occurrences examined:

- **A ticket with no claim** — reading a counter as a ticket without bumping
  it. That operation can never be the newest run of anything, so every other
  control erases it.
- **A cleanup that cancels nothing** — an effect with dependencies whose body
  sets a flag `true` and whose cleanup sets the same flag `false`. On a re-run
  the body undoes the clear on the next line, so it cancels only a true
  unmount, and whether that is safe then depends on a `key` in a *different*
  file that nobody editing that file would know to preserve. A cleanup that
  also claims a new generation is not this shape. **Decide explicitly whether
  your effect can re-run without remounting, and make the cleanup work either
  way rather than relying on a property of another file.**
- **A late claim on another key** — `begin(key)` reached after the function has
  already suspended, in a function that holds no ticket on `key`. By then
  another run may own that key, and claiming it invalidates that run. This one
  is here because the change that added the first two rules shipped an instance
  of it: a delete claimed the selection key after its await, invalidating an
  open that was in flight, whose `finally` releases the panel's busy flag only
  while its own ticket is current. The flag stranded and the panel said
  nothing. **Claim a key before your first await, or do not claim it.**

The guard is syntax and its reach is narrow on purpose. `LIMITS` in that file
is the full list and is the part to read; the ones worth knowing before you
write anything are that **nothing here models what a ticket gates**, so a
release guarded by a ticket another operation can invalidate is invisible to
all three rules; that a counter bumped by something which is not an operation
is not caught (an effect resetting an editor when its subject changes — that
one cost a saved evidence note); that two operations which each *do* claim
from one shared counter are not caught, and neither is one control paged under
two keys that should have been one; and that a counter built out of state or a
closure is not visible to syntax at all. Those are found by asking, for each
outstanding request, which controls are still enabled and what each of them
would do to it — and then deleting the guard you just wrote to see whether
anything turns red.

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

## The app as the background service

`--service` launches the app as the background service: no window, no Dock icon, and
the engine (`implementation_scripts.daemon`, the scheduler's owner) as its child. One
resmon runs per Chromium profile; a second launch exits 0 and the running one opens
the window on its own engine. Notifications go from the engine to a token-guarded
listener on loopback in the app (`electron/host.ts`, `desktop_notifier.notify`), so
macOS credits them to resmon; one the app does not take is posted the old way.
**No installed unit runs `--service` yet** — `service_manager` still starts the bare
engine. Under `RESMON_E2E` or `RESMON_NOTICES_TO_LOG` the app logs each notice as a
`[main] notice {…}` line instead of putting it on the screen. Journey:
`e2e/service-host.spec.ts`; the memory each form costs: `python -m perf host`.

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

**"Degrades the sweep" is a rule about the client, not about the run's status.** The two
were once read as one. The bullet above binds `search()`: one source's failure must not
propagate as an exception that aborts the run. It does not follow that a run in which
*nothing* answered is a success. Where every source that was asked came back with a
recorded non-answer there is nothing left to degrade to, and the execution is `failed` —
a run reporting `completed` with `result_count = 0` over a dead source states an empty
field where a failure happened, which is the one thing this app exists to refuse. Sources
resmon never asked — no key, withdrawn, no author query, a window the source filters too
coarsely — are not failures and never make a run one.

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

**`docs/api-contract/openapi.json` and `docs/api-contract/http.md` are generated, and
guarded.** They describe the whole HTTP surface — every route's method, path, parameters
and request body, and which of the 48 parity-register rows each route serves — and they
are written by `implementation_scripts/api_contract.py` from the real FastAPI app, never
by hand. `verification_scripts/test_api_contract.py` regenerates both in-process and fails
on any difference, naming the routes that were added, removed or reshaped. So a change to
the surface takes its own PR: change the route, run
`python -m implementation_scripts.api_contract --write` from `resmon_scripts/`, commit the
regenerated files in that PR, and say in the body what changed and why. The Atlas renderer's
types are generated from the same file: run `npm run gen:atlas-api` in `frontend/` and commit
`atlas/src/api/schema.d.ts` too, or `npm run typecheck` fails. A **new route also
needs a line in `api_contract.ROUTE_JOURNEYS`** naming the register row it serves; without
one the guard stays red. Editing either file to make a red test green, rather than to
record a change you meant, is the one thing this mechanism exists to stop.
`docs/api-contract/README.md` is the half-page version of all of this.

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

**The journey suite.** `resmon_scripts/frontend/journeys/` holds one automated
test per row of the 3.0 parity register, and the same suite runs against more
than one build: `RESMON_JOURNEY_APP` names the `frontend/` directory of the app
under test and `RESMON_JOURNEY_DRIVER` chooses `classic` or `candidate`, so the
app as it is and the app as it was can be measured from one commit. The
candidate is the Atlas interface: a journey Atlas does not carry yet is skipped
with "Not in Atlas yet", never failed and never passed, so a candidate run's
skip count is what the switch-over waits on. Nothing in a
spec touches the renderer — every spec goes through `driver.ts`, written in the
words of the journeys, and `register.spec.ts` greps for a renderer call or a
stray import and fails on a hit, which is what will make these specs survive the
renderer rebuild. **A register row and its spec exist together**: the same guard
fails when a built row has no spec and when a spec claims no row, so a journey
cannot quietly stop being covered. Rows not yet built name the slice that owes
them. Run it with `npm run journeys`, `npm run journeys:classic` and
`npm run typecheck:journeys`; the directory's own `README.md` carries the
copy-pasteable pair of commands for an arbitrary build. CI is `journeys.yml`,
two legs, both with a `break_row` input.

Saved conversation read/export contract: `docs/api-contract/assistant-conversations.md`;
Chats journey: `resmon_scripts/frontend/e2e/chats-export.spec.ts`.

Atlas Search and the run (slice 1 of the screens): `atlas/src/screens/Search.tsx`,
`Run.tsx` and `screens/runs/`; the run routes' bodies are the "starting a run" and
"runs" slices of `test_response_models.py`; real-app journey `e2e/atlas-search.spec.ts`.
The zero-reason vocabulary is generated into both renderers by `npm run gen:zero-reason`.
Atlas the collection and the paper (slice 2): `screens/collection/` (Search › Your
collection at `/search`, Ask the sources at `/search/ask`, a paper at `/papers/:id`),
`screens/library/ReadingQueue.tsx`, the shared sky `screens/sky/PaperSky.tsx`; real-app
journey `e2e/atlas-collection.spec.ts`.
Atlas Watches (slice 3a): `screens/watches/` (every watch and the month ahead at
`/watches`, a watch at `/watches/:id` with its constellation, nights, coverage audit and
delivery record); the routes' bodies are the "watches", "where a watch's reports go" and
"the calendar" slices of `test_response_models.py`; real-app journey `e2e/atlas-watches.spec.ts`.
Atlas People (slice 3b): `screens/watches/people/` (watch profiles at `/watches/people`, a
person at `/watches/people/:id`, each match's basis on the collection's rows); the live
warning in `people/model.ts` is held to `watch_profiles.basis_warning_for` by
`test_watch_profiles.py`, as the classic editor's is; real-app journey `e2e/atlas-people.spec.ts`.
Atlas Settings and Saved (slice 3c): Settings is one group at a time at `/settings/:group`
(`screens/settings/`: the background service, email and its stored password, notifications),
and Search › Saved at `/search/saved` keeps saved searches and every watch's copy, with
export and import (`screens/collection/Saved.tsx`); the routes' bodies are the "the background
service" and "a credential stored or removed" slices of `test_response_models.py`; real-app
journey `e2e/atlas-settings.spec.ts`, which sets its own `RESMON_SERVICE_UNIT_DIR` and an
in-memory keyring, and never presses the service switch.
Atlas's watch editor (slice 3d): `/watches/new` and `/watches/:id/edit`
(`screens/watches/WatchEditor.tsx`, its model `editor.ts`), begun empty, from a saved search,
from Ask the sources, or from a person's page; every schedule it offers stores a cron expression
whose words are exact, and one it cannot state is kept as it is. Destinations are changed in place
on a watch's "Where reports go" tab (`Destinations.tsx`). The source catalog both screens choose
from is `screens/sources/`. Real-app journey `e2e/atlas-watch-editor.spec.ts`; nothing it saves
is left watching.
Atlas Health (slice 4): `screens/health/` (the Source wall at `/health`, drawn from
`GET /api/coverage/source-wall` with one SVG mark per state, named by `data-mark`; the Watchdog at
`/health/watchdog`; the engine this window is talking to at `/health/engine`); the routes' bodies are
the "the source wall" and "analytics" slices of `test_response_models.py`; real-app journey
`e2e/atlas-health.spec.ts`. J16's gate and the authored source's up and down are renderer-free in
`journeys/drivers/candidate.ts`. Analytics is Health's third tab (`/health/analytics`,
`Analytics.tsx`, `analyticsModel.ts`): the engine's numbers only, its own sentence where a view has
too little, and a source's or a category's row opens Search › Your collection narrowed by
`?source=` or `?category=`; real-app journey `e2e/atlas-analytics.spec.ts`. A chart's neutral is
the `--chart-context` token, checked against the accent for color-blind separation.
Atlas Library › Your files (slice 5): `/library/files` (`screens/library/Files.tsx`, `libraryApi.ts`):
a vault made inside a folder the person chooses, files imported byte for byte (the one route outside
the typed client, because its body is raw bytes), read as literal text, linked to a paper by its
number, opened and shown by the engine's verified path. Every Library call sends
`X-Resmon-Library: 1` (`LibraryOriginGuard`). The routes' bodies are the "the owned library" slice
of `test_response_models.py`; real-app journey `e2e/atlas-files.spec.ts`, with the folder chooser,
the opener and the download destination scripted.
Atlas Library › Evidence: `/library/evidence` (`Evidence.tsx`, `evidenceApi.ts`, `evidenceModel.ts`).
A file comes from Your files by Open in Evidence and is added to a project only when asked. A
passage is pinned to one page's text by its hash and Unicode codepoint offsets (classic's
`selectionAnchor` and `resolveSaved`, ported); a page read once is not read again, and a
`reader_busy` refusal is retried, because the engine reads one PDF page at a time. The Evidence
routes parse their own bodies, so these calls go out raw and come back typed. The routes' bodies are
the "evidence projects" slice of `test_response_models.py`; real-app journey
`e2e/atlas-evidence.spec.ts`. A PDF page is drawn by the shipped PDF.js 6.3.289 (`PdfPage.tsx`,
`pdfjs.ts`): `atlas/vite.config.ts` copies the 188 files `src/__tests__/pdfjs.test.ts` pins from
`vendor/pdfjs/6.3.289`, byte for byte, renaming only `.mjs` to `.js` for the main process's MIME
table, and the CSP names `worker-src 'self'`.
Its Answers view (`Answers.tsx`, `answersApi.ts`, `answersModel.ts`) asks a question of, or a
briefing from, exact excerpts: nothing is sent until the engine's preview is shown, the event stream
is held while an answer runs (the engine cancels an unsubscribed one), and leaving the view cancels
it. Every request is re-checked in the renderer (canonical JSON, the request, prompt, system and
source hashes) and every citation must be its source's text at exactly its codepoint range; a
citation opens the frozen quote and re-reads the current page through `Reader.tsx`, which resolves
saved passages and citations as one `Pin`. The routes' bodies are the "selected-evidence answers" slice of
`test_response_models.py`; real-app journey `e2e/atlas-answers.spec.ts`, on the authored loopback
model of `selectedEvidenceTransport`.
Atlas Ask: `/ask` (`screens/ask/`): the assistant and its saved conversations in one screen, the
rail being the conversations. The assistant's state is held above the routes (`AskProvider`),
because a turn is one streamed response and a card is the engine holding the runtime: leaving Ask
must not close either. A new conversation is fixed to its connection, model and effort when its
first message is sent; each turn shows what it requested and what the runtime reported as two
claims, and a saved conversation says its completion is unknown. ⌘/ (Ctrl+/) opens Ask with the
caret in the composer. Settings › AI (`settings/Ai.tsx`) holds the summary lane and Ask's defaults,
and Search's *Summarize each paper* sends `ai_enabled`. The routes' bodies are the "assistant" slice
of `test_response_models.py`; real-app journey `e2e/atlas-ask.spec.ts`, on `fake_claude.py`.

Composer choices: `docs/api-contract/assistant-choices.md` (schema 15); captured fake-runtime journey: `resmon_scripts/frontend/e2e/composer-choices.spec.ts`.

Library storage, schema 16 and bounded TXT/MD reading: `docs/api-contract/library.md`; real disposable journey: `resmon_scripts/frontend/e2e/library.spec.ts`. Library-specific backend tests are `test_library.py`, `test_library_upgrade.py`, `test_library_boundary.py` and `test_library_text.py`. Native picker/opener results and download destinations are scripted in the Electron journey; report actual pass/skip counts separately.

Evidence workspace/schema 17: `docs/api-contract/evidence.md`; its six scoped
backend files are `test_evidence.py`, `test_evidence_reader.py`, `test_evidence_pdf.py`,
`test_evidence_export.py`, `test_evidence_upgrade.py` and `test_evidence_boundary.py`.
The actual disposable desktop journey is `e2e/evidence.spec.ts`; directory/download
destinations are scripted. New renderer unit suites cover exact selection, stale
responses, note conflicts, download identity and all 188 publisher asset hashes.
The required checks include e2e typecheck and the existing four-target sqlite-vec
packaging probe when requirements change. Report actual executed/skipped counts
and limits; a green probe does not establish every platform's reader behavior.


Selected answers/schema 18: `docs/api-contract/selected-evidence.md`; seven routes
and six backend files `test_selected_evidence.py`, `test_selected_evidence_context.py`,
`test_selected_evidence_runtime.py`, `test_selected_evidence_export.py`,
`test_selected_evidence_upgrade.py`, `test_selected_evidence_boundary.py`.
The two actual synthetic CLI/API Electron journeys are in
`e2e/selected-evidence.spec.ts`. The separate versioned system asset is
`implementation_scripts/assets/selected_evidence_rules.md`; ordinary Ask defaults
and the existing 25-tool MCP inventory are unchanged.

Portable saved-answer HTML: `docs/portable-briefing.md` and the additive
`selected-answer-html/v1` section of `docs/api-contract/selected-evidence.md`.
Renderer/SQLite tests are in `test_portable_briefing.py`; the actual downloaded
file, seven-state offline reader, citation/return, keyboard, widths, zoom and
print journey is `e2e/portable-briefing.spec.ts`. Download destinations are
scripted; physical Android and human native Save/Cancel remain separate.
