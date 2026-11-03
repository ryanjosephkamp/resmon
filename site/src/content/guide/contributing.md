---
title: "Contributing"
summary: "Reporting a problem, opening a pull request, the checks to run, and how docs and tests move with a change."
order: 18
---
Contributions are welcome. resmon is a single-maintainer project, so please open an issue before starting substantial work, so the scope can be agreed first. [CONTRIBUTING.md](CONTRIBUTING.md) is the full version; this page is the short one. To add a scholarly source, read [`docs/adding-a-source.md`](docs/adding-a-source.md).

## Reporting a problem

Open an issue at [github.com/ryanjosephkamp/resmon/issues](https://github.com/ryanjosephkamp/resmon/issues). **Settings › About resmon** has a button that opens that page. resmon never sends a report itself: you write the issue and submit it from your own account.

Include:

1. A short, specific title.
2. The resmon version, which **Settings › About resmon** shows, and your operating system.
3. The steps that reproduce it: the screen, what you did, and what happened.
4. The relevant lines of the log. A run's log is on its page, under the **Log** tab. The background service writes `resmon-daemon.out.log` and `resmon-daemon.err.log` to a `logs` folder in resmon's state directory, each capped at 5 MB with two older copies. Redact API keys and personal data before pasting.

Security-sensitive reports, such as credential handling or keyring access, should not be public issues. Contact the maintainer privately through the links at [ryanjosephkamp.github.io](https://ryanjosephkamp.github.io/).

## Running the app and the tests

From a clone, with Python 3.10, 3.11, or 3.12 and Node.js 22.13 or newer. See [Install and launch](/resmon/guide/install/) for setup.

```bash
# Backend, from the root of the clone. Tests that reach the network are marked live_network and left out.
.venv/bin/python -m pytest -q

# Interface, from resmon_scripts/frontend
npm run typecheck && npm run lint && npm test
npm run build

# The real app, after npm run build
npm run e2e         # Playwright specs that launch the Electron app and its engine
npm run journeys    # one test per user journey, through a driver
```

CI runs the backend suite on Python 3.10, 3.11, and 3.12, and the interface checks on Node.js 22. `npm run e2e:review` runs the e2e suite on your own display and writes screenshots and a summary outside the repository. Screenshots are never committed.

## Pull requests

1. Branch from `main` as `feat/<slug>`, `fix/<slug>`, `perf/<slug>`, `test/<slug>`, `docs/<slug>`, or `chore/<slug>`.
2. Keep the change to one deliverable that can be reviewed in a sitting.
3. Match the surrounding code. Python needs type hints on new code and nothing newer than 3.10. TypeScript has no `any` in new code.
4. Run the checks above for what you changed.
5. Update the guide page that covers a user-visible change, in the same pull request. The site is built from `site/` and published out of `docs/`.
6. If you add a route, regenerate the contract with `python -m implementation_scripts.api_contract --write` from `resmon_scripts/` and Atlas's types with `npm run gen:atlas-api` from `resmon_scripts/frontend/`, and commit both.
7. Open the pull request against `main`. The description says what changed and why, how it was verified (the exact commands and their output counts), what it deliberately does not do, and any file outside the obvious set, with the reason.

A change that implies more certainty than the code earns is rejected even when the code is correct. A field extracted from a document, a field matched against the collection, and a field guessed by a model are different kinds of fact, and resmon labels which is which.

## Commit messages

Commit messages are concise and imperative: `Add OpenAlex rate-limit fallback`, not `Added` or `Adds`. Put the issue number in the body, not the subject.

## Code of conduct

Be respectful and constructive. Focus feedback on the code and the technical trade-offs, not the contributor.
