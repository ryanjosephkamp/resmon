# Workflows

Seven workflows, ten jobs. Two things are true of every one of them, and a new job is not finished until
both are true of it as well.

## Every job carries a repository guard

```yaml
if: github.repository == 'ryanjosephkamp/resmon'
```

GitHub Actions is free for standard runners on a public repository and billed on a private one. These
workflows are written for this repository and are not meant to run anywhere a copy of it might be pushed.
Without the guard a private fork or mirror runs the whole matrix — including the macOS legs, which bill at
a multiplier — on every branch push, and the bill arrives with no signal that anything unusual happened.
That has already cost real money once.

**The guard was demonstrated, not assumed.** During review of the pull request that added it, one job's
guard was pointed at a repository name this repository does not have, with the sibling job in the same
workflow left correct as a control. The altered job reported `skipped` within ninety seconds while the
control queued normally. So the condition genuinely gates execution, and a false guard yields *skipped*.

That second half matters more than the first. **A required status check that skips is never satisfied**,
and branch protection waits for it forever with a symptom that does not look like its cause. Two
consequences:

- If this repository is ever renamed or transferred, all ten jobs skip and merging freezes. The fix is to
  update the literal in every workflow. A variable would avoid that, but a literal is the form that cannot
  be changed from inside a fork, which is the whole point.
- A new job that is also a required check must have its guard true here before it is made required.

## Every job carries a timeout

GitHub's default is 360 minutes per job. Nothing here needs anything like that, and an unbounded job is how
a hung runner turns into a long, quiet bill. The values below are set from measured history, not estimated:

| Job | Limit | Longest observed | Source |
|---|---|---|---|
| `ci.yml` backend | 40 | 22.5 min (Python 3.10) | 29 successful runs to 2026-10-18 |
| `ci.yml` frontend | 10 | 1.5 min | same |
| `ui-smoke.yml` smoke | 25 | — | set when written |
| `ui-smoke.yml` window | 30 | — | set when written |
| `journeys.yml` candidate | 40 | — | set when written |
| `journeys.yml` classic | 45 | — | set when written |
| `live-network.yml` live | 45 | — | set when written |
| `release.yml` build | 60 | 7m09s, worst single leg | v2.2.0 and v2.3.0 |
| `sqlite-vec-probe.yml` | 35 | — | set when written |
| `voice-probe.yml` | 50 | — | set when written |

`release.yml`'s limit is per matrix leg, and the matrix is four legs — `macos-14`, `macos-15-intel`,
`windows-latest`, `ubuntu-latest` — across three platforms.

## The one job with a second condition

`journeys.yml`'s `classic` leg builds a second application from the `classic` branch and runs this
checkout's suite against it. That is minutes of runner time whose answer only changes when the suite or
the renderer does, so it runs on a schedule, on dispatch, and on pull requests — not on every push. The
guard is ANDed in front of that filter:

```yaml
if: >-
  github.repository == 'ryanjosephkamp/resmon'
  && (
    github.event_name == 'schedule'
    || github.event_name == 'workflow_dispatch'
    || github.event_name == 'pull_request'
  )
```

## Making a job go red

Several workflows take an input that fails something on purpose — `break_row` in `journeys.yml`,
`break_route` in `ui-smoke.yml`. A job that cannot be made to fail on demand has to be trusted on
somebody's word, and this repository has shipped a job that reported green with failing tests inside it.
Use the input before you believe a new gate.
