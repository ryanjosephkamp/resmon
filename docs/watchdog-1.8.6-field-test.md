# The 1.8.6 watchdog rule change, run against the real corpus

Phase 1.8.6 changes two calibrated watchdog rules. The 1.7 field test set the
standard for this: a rule that has never met real history is not calibrated,
it is guessed. So both rules were run against a **copy** of the maintainer's
live daemon database before they merged.

Nothing here touched the original database, started a scheduler, or made a
network call. The copy was read; the watchdog only reads history.

## The corpus

| | |
|---|---|
| Documents | 15,687 |
| Executions | 78 (63 completed, 13 failed, 2 running) |
| Per-source records | 338, reconstructed by `init_db`'s progress-event backfill |
| Status mix | 337 `ok`, 1 `error` |
| **`ok` rows that returned zero** | **182** |
| **Rows carrying a `zero_reason`** | **0** |

That last row is the whole shape of this test. This database predates schema 10
by four months, so **every** zero in it is unexplained and there is nothing to
backfill — a reason invented now for a run nobody observed is precisely what
this phase exists to prevent.

## What changed

Two rules read the new column:

1. A zero recorded as `upstream_failure` **or `parse_failure`** counts as a
   **failure to get an answer**, both for the consecutive-failure rule and for
   "it last answered successfully" — which previously could name an outage as a
   success, because an outage is recorded `ok / 0`.
2. A zero recorded as `upstream_failure`, `parse_failure` or
   `window_unanswerable` is **not a measurement of the field**, so it cannot be
   part of a baseline of what a source normally returns.

A NULL reason keeps the pre-1.8.6 reading in both.

`parse_failure` was left out of rule 1 when this phase was first written, on
the grounds that a phase already changing the baseline denominator should not
also change when an alarm fires. The planning session decided otherwise at
reconciliation, and the reasoning is the stronger one: a source that answers
with something resmon cannot read on every run for a fortnight is exactly the
silent breakage this component exists to catch. Nothing raises, every run reads
`ok`, and the user simply gets nothing. Bound C below is the same test applied
to that decision.

## Result: the report is unchanged, byte for byte

The same corpus, the same day, the watchdog before and after the change:

```
$ diff before.json after.json
$ echo $?
0
```

Nine findings before, the same nine after, in the same order, with the same
wording — and zero `not_enough_data` entries in both.

| Finding | Severity |
|---|---|
| `'midnight_agents_crossref_ai' has not run for 5 weeks` | broken |
| `'midnight_agents_arxiv_ai' has found nothing new in its last 5 runs` | unusual |
| `'midnight_agents_crossref_ai' has found nothing new in its last 5 runs` | unusual |
| `arxiv has returned nothing on its last 4 runs` | unusual |
| `doaj has returned nothing on its last 15 runs` | unusual |
| `plos has returned nothing on its last 15 runs` | unusual |
| `semantic_scholar has returned nothing on its last 20 runs` | unusual |
| `'daily_agents' may be running more often than its sources update` | advice |
| `'midnight_agents_crossref_ai' may be running more often than its sources update` | advice |

**This is the result the change was designed for and it is also the weakest
possible evidence, which is why the next section exists.** Every row carries a
NULL reason, so neither new rule can fire; "unchanged" here proves there is no
regression on existing installs and proves nothing at all about the rules
themselves.

## Bounds: what the change would do to this history

None of these is a measurement. Each labels **all 182** real `ok / 0` rows with
**one** reason, to show the direction and the size of the change against the
real corpus's shape rather than a fixture's. What actually happened on those
182 runs is not knowable and is not claimed.

### Bound A — if every one of them had been an outage

```
$ python fieldtest-bound.py resmon.db upstream_failure
labelled 182 ok/0 rows as upstream_failure
findings: 12
```

The four `source_quiet` findings (severity **unusual**, an inference) become
seven `source_errors` findings (severity **broken**, a recorded fact), and
`dblp`, `europepmc` and `ieee` — silent before — appear. That is the correct
direction: a source that has not answered for 29 runs is broken, not quiet, and
the old code could not say so because nothing raised.

The two failure modes are one streak, not two — a source alternating between
an unreachable endpoint and an unreadable reply would otherwise never reach
either threshold. And the sentence distinguishes them, because telling someone
their source is unreachable when it is answering fine and has changed its
response format sends them to look for a problem that is not there:

```
resmon got no answer from arxiv on each of its last 4 runs. The most recent
one: the source answered and resmon could not read the reply. It last answered
successfully 7 days ago.
```

### Bound C — if every one of them had been an unreadable reply

```
$ python fieldtest-bound.py resmon.db parse_failure
labelled 182 ok/0 rows as parse_failure
findings: 12
```

The same twelve findings as bound A, with the same seven sources promoted from
`source_quiet` to `source_errors` — as it should be, since both reasons are now
error-equivalent and this corpus's zeros fall in the same places whichever
reason is applied. What differs is the sentence, quoted above: bound A says
*the source answered HTTP 503*, bound C says *the source answered and resmon
could not read the reply*.

### Bound B — if every one of them had been a real empty answer

```
$ python fieldtest-bound.py resmon.db answered_empty
labelled 182 ok/0 rows as answered_empty
findings: 9
```

Identical to today's report, which is the other half of the check: labelling a
zero as a genuine answer must change nothing.

### One correction to the phase brief

The brief predicted the baseline change would produce "more `unjudged`, fewer
`source_quiet`" on a real corpus. **Fewer `source_quiet`: yes, 4 → 0. More
`unjudged`: no, 0 → 0.** On this history the consecutive-failure rule fires
first and returns before the baseline check is reached, so the sources whose
baselines shrank never got as far as being judged on one. The shrinkage is real
and is exercised by `test_a_baseline_is_not_built_from_runs_the_source_never_answered`;
it simply is not what this corpus demonstrates.

## Reproducing it

The scripts are two files, both read-only against a copy:

* `fieldtest.py <copy.db> <out.json>` — migrate the copy, run the watchdog,
  dump the findings.
* `fieldtest-bound.py <copy.db> <reason> <out.json>` — the same, with every
  `ok / 0` row labelled with one reason first.

The database is copied from the daemon's own checkout; the path is in the
maintainer's workspace notes, not here.
