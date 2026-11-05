# Contributing to resmon

resmon watches scholarly literature for a researcher and tells them when their monitoring has
broken. Contributions are welcome.

It is a single-maintainer project, so please open an issue before starting substantial work.

## Start here

| You want to | Read |
|---|---|
| Add a scholarly source | **[docs/adding-a-source.md](docs/adding-a-source.md)**, the long form |
| Run the app or the tests from a clone | **[Running from source](#running-from-source)** and **[Before you open a pull request](#before-you-open-a-pull-request)**, below |
| Change the HTTP API | **[Changing the HTTP API](#changing-the-http-api)**, below |
| Drive resmon from another tool over MCP | **[docs/api-contract/mcp.md](docs/api-contract/mcp.md)** |
| Know which sources are viable | **[docs/source-landscape.md](docs/source-landscape.md)** |
| Use the app | **[README.md](README.md)** and the [guide](https://ryanjosephkamp.github.io/resmon/guide/) |

## The one rule that outranks the others

**Never overclaim.** Every user-facing string, docstring, comment, log line, and pull-request body
says only what the code actually establishes.

A field extracted from a document, a field matched against the collection, and a field guessed by a
model are three different kinds of fact, and resmon labels which is which. Where the app cannot know
something, it says so instead of rendering a plausible number.

This is the product's whole differentiator, and it is a review gate: **a change that implies more
certainty than it earns is rejected even when the code is correct.**

In practice that means an absent value beats an invented one, a measured figure beats an estimate,
and "undocumented" is a correct answer.

The clearest worked example is the basis rule. An author match is a string match unless the source
gave an identifier, so every match records how it was made, and the interface labels it: ORCID match,
name + affiliation, or name only. Only the first is evidence of identity. The rule lives in
`implementation_scripts/entity_matching.py`, and the label on a paper is the basis the engine
stored. A feature that could not survive being described this way should not be described as if it
did.

## Running from source

You need Python 3.10, 3.11, or 3.12, Node.js 22.13 or newer, and Git.

```bash
git clone https://github.com/ryanjosephkamp/resmon.git
cd resmon
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cd resmon_scripts/frontend && npm install && npm start
```

`npm start` builds Atlas, the interface, and the Electron main process, then opens the app. The app
uses `python3` from your `PATH` for its engine, so start it with the virtual environment active, or
set `RESMON_PYTHON` to the environment's interpreter. A run from source keeps its database in
`resmon.db` and its reports in `resmon_reports/` at the root of the clone.

**To isolate a run from your other data,** set `RESMON_DB_PATH` and `RESMON_REPORTS_DIR` to places
of your own, along with `RESMON_STATE_DIR`, and `RESMON_PORT_FILE` unless you want the port file
beside the database. `RESMON_STATE_DIR` alone does not move the database.

## Before you open a pull request

Run the checks for what you changed. A change that touches a route runs all of them.

```bash
# Backend, from the root of the clone. The default run is hermetic: any test that
# reaches the network is marked live_network and is left out.
.venv/bin/python -m pytest -q
.venv/bin/python -m pytest -m live_network -q    # real sources; Actions › Live network runs the half that needs no signed-in command, when started by hand

# Interface, from resmon_scripts/frontend
npm run typecheck && npm run lint && npm test    # TypeScript, ESLint, and the Jest suites
npm run build                                    # Atlas and the Electron main process

# The real app, from resmon_scripts/frontend. Both launch what npm run build made.
npm run e2e                                      # Playwright specs that launch the Electron app and its engine
npm run journeys                                 # one test per user journey, through a driver
```

- **The backend suite.** CI runs it on Python 3.10, 3.11, and 3.12, plus the frontend job. 3.12 is
  not decoration: it releases the GIL around `sqlite3` aggressively, and it is the acceptance test for
  the per-thread-connection design. If that column alone goes red, suspect a shared
  `sqlite3.Connection`. Python 3.10 is the floor, so no `match` statements and no 3.11+ syntax. Tests
  are hermetic by default: `conftest.py` blocks any non-loopback socket from a test not marked
  `live_network`, and sets `RESMON_AI_CLI_DISCOVERY=configured-only` for the whole run, so a test
  finds only the fake command it names and never your own `claude` or `codex`. A test that tries to
  start a real one anyway fails.
- **`npm run e2e`** starts the engine with `RESMON_PYTHON` if you set it, and otherwise with the
  clone's `.venv`. It stops at global setup with one sentence if that interpreter is missing or cannot
  import the engine's dependencies. A spec that needs a signed-in command uses a fake one, and the
  harness sets `RESMON_AI_CLI_DISCOVERY=configured-only` so a test instance never finds your own
  `claude` or `codex`.
- **`npm run e2e:review`** runs the same suite on your own display, which is the only place the
  window-manager specs actually run, and writes the screenshots and a Markdown summary to a folder
  outside the repository. Screenshots are never committed.
- **`npm run journeys`** drives the real app through [`journeys/`](resmon_scripts/frontend/journeys/).
  Every spec is written in the words of a user journey and goes through a driver; none touches the
  interface's markup. `npm run typecheck:e2e` and `npm run typecheck:journeys` typecheck the two
  directories `npm run typecheck` does not cover.
- **Backend tests that go with a feature** are named for it: `test_library*.py`, `test_evidence*.py`,
  `test_selected_evidence*.py`, `test_assistant*.py`, `test_cli.py`, and so on. The desktop journeys
  are `e2e/atlas-files.spec.ts`, `e2e/atlas-evidence.spec.ts`, `e2e/atlas-answers.spec.ts`, and
  `e2e/atlas-chats-export.spec.ts`. Report the counts you actually ran, and what you could not run.

### Adding a screen

Every screen at a fixed address is listed in `resmon_scripts/frontend/atlas/src/screenPaths.ts`, and
`atlas/src/__tests__/screenPaths.test.ts` fails when that list and the router disagree. The e2e smoke
suite sweeps the list, and the journey register's `ROUTE_ROWS` must name the rows that carry each
entry. So a screen that exists has a smoke test and a journey, and there is no second list to
remember.

### Changing the HTTP API

`docs/api-contract/openapi.json` and `docs/api-contract/http.md` are generated from the running app,
and `test_api_contract.py` fails on any difference. A change to the surface takes its own pull
request:

1. Change the route. The guard goes red and names the routes that were added, removed, or reshaped.
2. From `resmon_scripts/`, regenerate the contract: `python -m implementation_scripts.api_contract --write`.
3. From `resmon_scripts/frontend/`, regenerate Atlas's types: `npm run gen:atlas-api`.
4. Commit the regenerated files in that pull request, and say in the body which routes changed and why.

A new route needs a line in `api_contract.ROUTE_JOURNEYS` naming the journey it serves. A route that
declares a `response_model` needs a case in `test_response_models.py`. A new or removed route also
changes the "N routes" count that `site/src/content/guide/api-reference.md` and
`docs/api-contract/http.md` state, and `test_the_route_count_is_what_the_docs_say` checks both;
update the guide page's tables to match. Editing a generated file to make a red test green, without
looking at what changed, defeats the guard. The failure message is the review.

### Tests that bite

Break the behavior on purpose and confirm the test fails. A test that asserts `isinstance(x, list)`
proves nothing. If nothing goes red when you sabotage the code, the test is checking shape instead of
behavior.

### Docs move in step

A user-visible change updates, in the same pull request, the guide page that covers it, under
`site/src/content/guide/`, and the README when it changes what is described there. The project site
is built from `site/` and published out of `docs/`: run `npm ci && npm run build` in `site/` and
commit the result. [`site/README.md`](site/README.md) explains how. A pull request that ships a
feature with no documentation is incomplete.

### No new runtime dependency without saying so

resmon ships a bundled Python interpreter, and every dependency lands in a build of roughly 900 MB.
If a change needs one, say so explicitly in the pull request body and justify it. Most of the time
there is a smaller answer: the MCP server speaks the protocol directly instead of adding an SDK.

## Pull-request bodies

The body is how a maintainer, and the next contributor, learn what happened. Every one carries:

- **What changed and why**
- **How it was verified**: the exact commands and their output counts
- **What it deliberately does not do**
- **Files touched outside the obvious set**, with the reason

That last section is load-bearing. An unexplained file outside the scope of the change is a review
failure regardless of whether the change is good.

Keep branches short: one deliverable, days rather than weeks, small enough to review in a sitting.
Branch prefixes: `feat/ fix/ perf/ test/ docs/ chore/ release/`.

Commit messages are concise and imperative: `Add OpenAlex rate-limit fallback`, not `Added` or
`Adds`.

## Reporting issues

Open an issue at <https://github.com/ryanjosephkamp/resmon/issues>. **Settings › About resmon** has a
button that opens that page; resmon never sends the report itself, so you write and submit it from
your own account.

Include the resmon version (it is on **Settings › About resmon**), your operating system, exact
reproduction steps, and the relevant lines of the log. A run's log is on its page, under the **Log**
tab. The background service writes `resmon-daemon.out.log` and `resmon-daemon.err.log` in the `logs`
folder of resmon's state directory. Redact API keys and personal data before pasting.

**Security-sensitive reports,** such as credential handling, injection, or keyring access, should not
be filed as public issues. Contact the maintainer privately through the links at
<https://ryanjosephkamp.github.io/>.

## Extending resmon for yourself

resmon is MIT-licensed and made to be extended: a documented source template
([docs/adding-a-source.md](docs/adding-a-source.md)) and an MCP server that exposes the app to your
own tools ([docs/api-contract/mcp.md](docs/api-contract/mcp.md)). Adding a source you need to your own
copy is a supported way to use the project.

What you build on resmon is yours and is your responsibility. A source that needs your own key is
governed by that provider's terms, which bind you, not resmon; see
[Sources and their terms](https://ryanjosephkamp.github.io/resmon/guide/sources/).

## Code of conduct

Be respectful and constructive. Focus feedback on the code and the technical trade-offs, not the
contributor.
