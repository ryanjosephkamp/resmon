# Workflows

Seven workflows, eleven jobs. Two things are true of every one of them, and a new job is not finished until
both are true of it as well.

**This page used to be the whole of the enforcement, and it had already drifted.** It said *ten* jobs
while the tree held eleven: `ci.yml`'s `lint` was added without the count moving, and had no row in the
timeout table below. Nothing was broken by that — `lint` carries both — but a denominator that is one
short is a denominator nobody can use, and "every one of them" means nothing when the reader and the tree
disagree about how many there are. The rule is now held by
`resmon_scripts/verification_scripts/test_workflow_hygiene.py`, which parses every file in this directory
and fails when a job lacks either, when this page's count disagrees with the files, or when the table
below has no row for a job. It runs inside `ci.yml`'s backend job rather than as a job of its own,
deliberately — see *A new gate must not be a check that can skip*, below.

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

- If this repository is ever renamed or transferred, all eleven jobs skip and merging freezes. The fix is to
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
| `ci.yml` lint | 10 | 0.63 min (38 s; spread 23–38 s) | 16 successful legs of the 20 most recent CI runs, 2026-10-19 |
| `ci.yml` frontend | 10 | 1.5 min (spread 0.9–1.5) | 29 successful legs of the same 30 runs |
| `ci.yml` site | 10 | 24s | 2 runs, and see below |
| `ui-smoke.yml` smoke | 25 | 9.8 min | 11 |
| `ui-smoke.yml` window | 30 | 12.7 min | 13 |
| `journeys.yml` candidate | 40 | 8.6 min | 8 |
| `live-network.yml` live | 45 | 3.2 min | 7, and the limit is deliberately far above it |
| `release.yml` build | 60 | 7m09s, worst single leg | v2.2.0 and v2.3.0 |
| `sqlite-vec-probe.yml` | 35 | 9.7 min (macos-x64) | 23 |
| `voice-probe.yml` | 50 | 14.8 min (macos-x64) | 5 |

Measured 2026-10-18 from the 25 most recent runs of each workflow (30 for `ci.yml`), successful legs only;
the `lint` row was measured separately on 2026-10-19, when the job-count check above found it missing.
Headroom runs from **1.78x to 16x**, and the tightest is the one worth watching: `ci.yml` backend, at
40 against a measured 22.5. That leg is a required check and its duration grows with the suite, so it is
the row that will need raising first.

The `lint` row's sample is 16 and not 20 because the per-run job listing for two of the twenty runs
returned a server error and two others carried no `lint` leg at all. Four unknowns out of twenty, named
rather than rounded away.

The gaps this table once left blank were not hiding a problem, and recording that is worth more than a
blank row that invites the opposite assumption.

Two rows need their caveat read with them. **`site` has a sample of two**, both from the pull request
that added it: 52 seconds for the run that was made to fail on purpose, on a cold npm cache, and 24 for
the green run after it, with the cache warm. The limit is 10 minutes against the only successful run's 24
seconds, which is about 25x and the widest margin in this table — deliberately, and for a reason that is
the opposite of the usual one. Two observations are not a distribution, both came from the same hour on
the same branch, and neither includes a cold `actions/setup-node` cache on a runner that has never seen
this `package-lock.json`. The row should be remeasured once the job has a few weeks behind it, and until
then the limit is sized for what has not been observed rather than for what has. It is also the cheapest
job here, so a wide limit costs little if it is never approached.

The other: `live-network`'s limit is far above its observed time on purpose: its slow case is a provider being slow, which is the thing it exists to
observe, not a runner being stuck.

`release.yml`'s limit is per matrix leg, and the matrix is four legs — `macos-14`, `macos-15-intel`,
`windows-latest`, `ubuntu-latest` — across three platforms.

## A new gate must not be a check that can skip

The guard above makes a job **skip** rather than fail off this repository, and a required status check
that skips is never satisfied. That makes a new job the worst possible home for a check about the guard:
the one gate whose whole subject is "does every job carry the thing that makes jobs skip" would itself be
the gate most likely to skip and freeze merging, with a symptom that looks nothing like its cause.

So the guard-and-timeout rule is a pytest case in `test_workflow_hygiene.py`, running inside `ci.yml`'s
backend job — already required, already guarded, and unskippable because it is an assertion inside a suite
rather than a job with a condition in front of it. The same reasoning applies to anything else that wants
to check this directory: add it to the suite, not to the matrix.

## Making a job go red

Several workflows take an input that fails something on purpose — `break_row` in `journeys.yml`,
`break_route` in `ui-smoke.yml`. A job that cannot be made to fail on demand has to be trusted on
somebody's word, and this repository has shipped a job that reported green with failing tests inside it.
Use the input before you believe a new gate.
