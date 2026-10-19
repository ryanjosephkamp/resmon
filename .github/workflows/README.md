# Workflows

Seven workflows, eleven jobs. Two things are true of every one of them, and a new job is not finished until
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

**On a fork, this looks like nothing happening.** A fork runs no jobs on push and its Actions tab stays
empty with no explanation, which is the intended outcome and an unhelpful first impression. A pull request
*from* a fork does run these checks, because `pull_request` is evaluated in the base repository's context —
that is GitHub's documented behavior and has not been exercised here, since there is no fork to try it on.

## Every job carries a timeout

GitHub's default is 360 minutes per job. Nothing here needs anything like that, and an unbounded job is how
a hung runner turns into a long, quiet bill. The values below are set from measured history, not estimated:

| Job | Limit | Longest successful run | Sample |
|---|---|---|---|
| `ci.yml` backend | 40 | 22.5 min (Python 3.10) | 20 successful 3.10 legs of the 30 most recent CI runs |
| `ci.yml` frontend | 10 | 1.5 min (spread 0.9–1.5) | 29 successful legs of the same 30 runs |
| `ui-smoke.yml` smoke | 25 | 9.8 min | 11 |
| `ui-smoke.yml` window | 30 | 12.7 min | 13 |
| `journeys.yml` candidate | 40 | 8.6 min | 8 |
| `journeys.yml` classic | 45 | 8.3 min | 7, but see below |
| `live-network.yml` live | 45 | 3.2 min | 7, and the limit is deliberately far above it |
| `release.yml` build | 60 | 7m09s, worst single leg | v2.2.0 and v2.3.0 |
| `sqlite-vec-probe.yml` | 35 | 9.7 min (macos-x64) | 23 |
| `voice-probe.yml` | 50 | 14.8 min (macos-x64) | 5 |

Measured 2026-10-18 from the 25 most recent runs of each workflow (30 for `ci.yml`), successful legs only.
Headroom runs from **1.78x to 14x**, and the tightest is the one worth watching: `ci.yml` backend, at
40 against a measured 22.5. That leg is a required check and its duration grows with the suite, so it is
the row that will need raising first.

The gaps this table once left blank were not hiding a problem, and recording that is worth more than a
blank row that invites the opposite assumption.

Two rows need their caveat read with them. The `classic` sample has a median of 0.1 minutes, because most
of those runs stopped at the job's own changed-files step rather than building a second application — look
in the `scope` step, not the `on:` block, which has no path filter — so only the 8.3 is a real build, and
the sample is one observation and not seven. And `live-network`'s limit is far
above its observed time on purpose: its slow case is a provider being slow, which is the thing it exists to
observe, not a runner being stuck.

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
