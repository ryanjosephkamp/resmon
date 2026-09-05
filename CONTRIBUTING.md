# Contributing to resmon

resmon watches scholarly literature for a researcher and tells them when their monitoring has
broken. Contributions are welcome — from people, and from agents working on their behalf.

It is a single-maintainer project, so please open an issue before starting substantial work.

## Start here

| You want to | Read |
|---|---|
| Add a scholarly source | **[docs/adding-a-source.md](docs/adding-a-source.md)** — the long form |
| Work this repo with an AI harness | **[AGENTS.md](AGENTS.md)** — the contract both harnesses read |
| Drive resmon from your harness | **[docs/api-contract/mcp.md](docs/api-contract/mcp.md)** |
| Know which sources are viable | **[docs/source-landscape.md](docs/source-landscape.md)** |
| Set up, run, or understand the app | **[README.md](README.md)** |

## The one rule that outranks the others

**Never overclaim.** Every user-facing string, docstring, comment, log line and pull-request
body says only what the code actually establishes.

A field extracted from a document, a field matched against the corpus, and a field guessed by
a model are three different kinds of fact, and resmon labels which is which. Where the app
cannot know something, it says so rather than rendering a plausible number.

This is the product's whole differentiator, and it is a review gate: **a change that implies
more certainty than it earns is rejected even when the code is correct.**

In practice that means an absent value beats an invented one, a measured figure beats an
estimate, and "undocumented" is a correct answer.

## Before you open a pull request

All five must pass:

```bash
.venv/bin/python -m pytest -q                    # hermetic backend suite — 1137 pass
.venv/bin/python -m pytest -m live_network -q    # real APIs — CI cannot run these
cd resmon_scripts/frontend && npm run typecheck && npm test && npm run build
npm run e2e                                      # the real Electron app, every route
```

`npm run e2e:review` runs the same suite on your own display — which is the only
place the window-manager specs actually run — and writes the screenshots and a
Markdown summary to a folder outside the repository. Use it before asking anyone
to look at an interface change. Screenshots are never committed.

### Adding a page

Routes live in one table, `resmon_scripts/frontend/src/routes.ts`. `App.tsx` renders from
it and the Playwright suite imports it, so **a page that exists is a page with a smoke
test** — there is no second list to remember. Add the route there and to `App.tsx`'s
`PAGE_ELEMENTS`, and `npm run e2e` sweeps it on the next run. A Settings or About tab is
read out of that page's own `<Routes>` block, so those go in the table's `children` too.

`src/__tests__/routes.test.tsx` fails when the table and the app disagree, including when
a `<Route>` is hand-written in `App.tsx` to bypass the table. That guard is the whole
point: before it, the e2e route list was a hand copy and a new page was unswept with
nothing going red.

CI runs the backend suite on Python 3.10, 3.11 and 3.12 plus the frontend job. **3.12 is not
decoration** — it releases the GIL around `sqlite3` aggressively and is the acceptance test
for the per-thread-connection fix. If that column alone goes red, suspect a shared
`sqlite3.Connection`.

Python 3.10 is the floor: no `match` statements, no 3.11+ syntax.

### Tests that bite

Break the behavior on purpose and confirm the test fails. A test that asserts
`isinstance(x, list)` proves nothing. If nothing goes red when you sabotage the code, the
test is checking shape rather than behavior.

### Docs move in step

A user-visible change updates, in the same pull request: the README section that covers it,
the relevant `PageHelp` entry, and the affected page info document under
`resmon_reports/info_docs/`. A pull request that ships a feature with no documentation is
incomplete.

### No new runtime dependency without saying so

resmon ships a bundled Python interpreter, and every dependency lands in a ~900 MB build. If
a change needs one, say so explicitly in the pull request body and justify it. Most of the
time there is a smaller answer — the MCP server speaks the protocol directly rather than
adding an SDK.

## Pull-request bodies

The body is how a maintainer, and the next agent, learn what happened. Every one carries:

- **What changed and why**
- **How it was verified** — the exact commands and their output counts
- **What it deliberately does not do**
- **Files touched outside the obvious set**, with the reason

That last section is load-bearing. An unexplained file outside the scope of the change is a
review failure regardless of whether the change is good.

Keep branches short: one deliverable, days rather than weeks, small enough to review in a
sitting. Branch prefixes: `feat/ fix/ perf/ test/ docs/ chore/ release/`.

Commit messages are concise and imperative — `Add OpenAlex rate-limit fallback`, not `Added`
or `Adds`.

## Reporting issues

The fastest path is the in-app **About resmon → Issues** tab, which builds a pre-populated
email or GitHub issue from one form. The app never sends the report itself; you review and
send it.

Include the resmon version, your OS, Python and Node versions, exact reproduction steps, and
relevant log excerpts from `resmon_reports/logs/`. **Redact API keys and personal data before
pasting.**

**Security-sensitive reports** — credential handling, injection, the OAuth flow, keyring
access — should not be filed as public issues. Email the maintainer directly.

## Extending resmon for yourself

resmon is MIT-licensed and deliberately agent-friendly: `AGENTS.md`, a documented source
template, and an MCP server that exposes the app to your own harness. Pointing your harness at
this repository and asking it to add a source you need is a supported way to use the project.

What you build on resmon is yours and is your responsibility — see the disclaimer in the
README's [Sources and their terms](README.md#sources-and-their-terms) section, which matters
particularly when you add a source that needs your own API key.

## Code of conduct

Be respectful and constructive. Focus feedback on the code and the technical trade-offs, not
the contributor.
