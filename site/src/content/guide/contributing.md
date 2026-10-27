---
title: "Contributing"
summary: "Reporting issues, the blog, the Danger Zone, submitting pull requests, commit messages and the code of conduct."
order: 15
readmeLines:
  - "1521-1566"
---
## Contributing

Contributions are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for the short version, **[docs/adding-a-source.md](docs/adding-a-source.md)** for adding a scholarly source, and **[AGENTS.md](AGENTS.md)** if you are working this repository with an AI harness. resmon is a single-maintainer project, so the workflow below is deliberately lightweight; please open an issue before starting substantial work so the scope can be scoped and any related changes in the `.ai:/prep/` planning documents can be coordinated.

### Reporting Issues

The fastest path is the in-app **About resmon → Issues** tab, which builds either a pre-populated `mailto:` link to the maintainer or a pre-populated GitHub issue deep link from a single form (no credentials are stored or transmitted by the app — the user reviews and sends in their own email client or on GitHub). Alternatively, open a GitHub issue directly at [`https://github.com/ryanjosephkamp/resmon/issues/new`](https://github.com/ryanjosephkamp/resmon/issues/new) with:

1. A short, specific title.
2. The resmon version (git commit hash or packaged build number), host OS, Python version (`python3 --version`), and Node.js version (`node --version`).
3. Reproduction steps — the page, the operation, the exact form input, and the observed error.
4. Relevant log excerpts. Per-execution logs live under `resmon_reports/logs/`; the background service writes `resmon-daemon.err.log` and `resmon-daemon.out.log` in the `logs/` folder of resmon's state directory (`~/Library/Application Support/resmon/logs` on macOS), each capped at 5 MB with two older copies. Redact any API keys or personal data before pasting.
5. A screenshot of the UI state when the bug is visual.

Security-sensitive reports (credential handling, SQL injection, OAuth flow, keyring access) should not be filed as public issues. Email the maintainer directly instead.

### Blog

Per-update release notes are republished verbatim to the public resmon blog at [`https://ryanjosephkamp.github.io/resmon/`](https://ryanjosephkamp.github.io/resmon/) (source under `docs/_posts/`, served by GitHub Pages). The same posts are also readable inside the app from the **About resmon → Blog** tab, which fetches the Atom feed and renders each post in an origin-locked Electron `<webview>`.

### Maintenance / Danger Zone

The **Settings → Advanced → Danger Zone** section centralizes every destructive maintenance action behind a two-tier confirmation gate: the two API-key wipes (repository keys, AI provider keys) use a simple OK / Cancel modal because they are recoverable by re-entering the keys, while the six data / settings destructions (delete all executions, delete all saved configurations, delete all routines, reset all settings, full reset, factory reset) require typing the literal word `CONFIRM` into a text input before the destructive button enables.

### Submitting Pull Requests

1. Fork the repository and create a topic branch off `main` (`feat/<short-slug>`, `fix/<short-slug>`, or `docs/<short-slug>`).
2. Keep the change focused — one logical unit per pull request.
3. Match the existing code style. Python follows PEP 8 with 4-space indentation; TypeScript/TSX follows the repository's Prettier defaults. Do not reformat unrelated files.
4. Run the verification suites before pushing:
   - Backend: `pytest resmon_scripts/verification_scripts/`
   - Frontend type check: `cd resmon_scripts/frontend && npm run typecheck`
   - Frontend renderer tests: `cd resmon_scripts/frontend && npm test`
   - Journey suite (the real app, one test per user journey): `cd resmon_scripts/frontend && npm run build && npm run journeys`. It can also be pointed at another build; see `resmon_scripts/frontend/journeys/README.md`.
5. If the change touches a repository client, add or update the corresponding test under `resmon_scripts/verification_scripts/` and the matching fixture. New repositories additionally require a row in `repo_catalog.py` and a registration in `api_registry.py`.
6. If the change alters user-visible behavior, update the affected page info document under `resmon_reports/info_docs/` and, where relevant, this README.
7. Open the pull request against `main`. The description must explain **what** changed, **why** it changed, and how the change was verified. Link the originating issue.

### Commit Messages

Commit messages follow a concise, imperative style (`Add OpenAlex rate-limit fallback`, not `Added` or `Adds`). Multi-line bodies are encouraged for non-trivial changes; reference the issue number in the body rather than the subject line.

### Code of Conduct

Be respectful and constructive. Focus feedback on the code and the technical trade-offs, not the contributor.
