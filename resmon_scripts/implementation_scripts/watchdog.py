"""The watchdog: tell the user when their monitoring has stopped working.

A literature monitor fails silently. When a source starts refusing queries, or
an API key expires, or the scheduler stops firing a routine, the user sees the
same thing they see when the field is simply quiet: nothing. Silence is the
output of both a working monitor and a broken one, and every tool in this
category leaves the user to tell them apart unaided.

This module interrogates the silence. It reads the per-source execution record
(``execution_sources``), the executions themselves, and the routines, and
reports where reality has departed from what that history establishes as
normal.

The vocabulary is the feature
-----------------------------
An alarm that is wrong gets muted, and a muted watchdog misses the real
failure it was built for. So findings are graded, and the grades mean
different things:

``broken``
    A recorded fact, not an inference. The source raised an error on each of
    its last several runs; the credential a source requires is not configured;
    the routine has not fired when its own history says it should have. These
    are reported as certainties because they are certainties.

``unusual``
    A departure from a baseline this user's own data established. A source that
    reliably returned papers has returned none several runs running. These are
    reported as questions, never as failures, and always with the baseline and
    the sample size attached, because the innocent explanation -- the field went
    quiet -- is genuinely possible every time.

``advice``
    Not a problem at all. Cadence guidance derived from discovery lag. Never
    counted in the alarm total.

Everything the watchdog cannot yet judge is reported too, under
``not_enough_data``. A watchdog silent because nothing is wrong and a watchdog
silent because it has three data points look identical otherwise, and the
difference matters to someone deciding whether to trust it.

Where each rule is evaluated
----------------------------
Source rules run **globally per source** rather than per (routine, source).
A source erroring is a property of the source, and pooling every execution that
touched it gives the largest sample and the fewest false alarms. The
routine-specific case -- one routine's query has died while others still work --
is caught by the routine rules instead. Splitting source rules per routine would
multiply the findings and thin every sample that feeds them, which is the
trade that turns a watchdog into noise.

Thresholds are deliberately conservative, and stated in the payload so the
interface can show its work.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from statistics import median

from . import analytics

# --- Source thresholds -----------------------------------------------------

# Consecutive failing runs before a source is called broken. Three, because a
# single upstream blip is normal and two in a row is bad luck.
CONSECUTIVE_ERRORS = 3

# Consecutive runs returning zero results before a source that used to return
# papers is called unusual. Higher than the error threshold: an error is
# evidence of a fault, a zero is evidence of nothing in particular.
CONSECUTIVE_ZEROS = 4

# Runs recorded for a source before its history counts as a baseline at all.
MIN_BASELINE_RUNS = 5

# Of those baseline runs, how many must actually have returned papers before
# "it used to return papers" is a claim worth making.
MIN_PRODUCTIVE_BASELINE_RUNS = 3

# A source last seen this long ago is not reported for a missing key unless an
# active routine still selects it. Old one-off sweeps should not alarm forever.
MISSING_KEY_RECENCY_DAYS = 30

# --- What an "ok / 0" row is worth -----------------------------------------
#
# Until schema 10 every source that finished without raising was ``ok``, so a
# source whose endpoint 503'd on every run of a month looked to this file
# exactly like a source in a quiet field. Clients degrade rather than raise --
# that is a deliberate contract and it is right -- and the cost was that the
# watchdog could not tell an outage from silence.

# A zero for one of these reasons is a source that **did not answer**. The
# consecutive-failure rule treats it like an error row, because that is what
# it is: resmon sent a query and got nothing back from the source.
#
# Only ``upstream_failure`` is here, and the omissions are deliberate.
# ``window_unanswerable`` is not a fault at all -- the source is behaving
# correctly and the window is the user's -- and alarming on it would train
# people to ignore the watchdog. ``parse_failure`` is a genuine candidate and
# is deliberately left out of *this* phase: it changes when an alarm fires,
# and this phase already changes the baseline denominator. Its rows are still
# dropped from the baseline below, so a source that only ever returns
# unreadable replies goes to `unjudged` with a stated reason rather than
# silently counting as healthy.
ERROR_EQUIVALENT_ZERO_REASONS = frozenset({"upstream_failure"})

# A zero for one of these reasons is not a measurement of the field, so it
# cannot be part of a baseline of what the source normally returns. Dropping
# them shrinks the denominator: on a real corpus this produces *more*
# `unjudged` sources and *fewer* `source_quiet` findings, which is the correct
# direction -- a baseline built from runs where the source never answered was
# never a baseline.
NOT_A_MEASUREMENT_ZERO_REASONS = frozenset({
    "upstream_failure",
    "parse_failure",
    "window_unanswerable",
})


def _did_not_answer(run: dict) -> bool:
    """Did this run fail to get an answer out of the source?

    A NULL ``zero_reason`` keeps the pre-1.8.6 reading, which is what every
    historical row has: an ``ok`` row is treated as an answer because nothing
    observed otherwise. That is the honest default and it is why this rule
    changes nothing about existing recorded history.
    """
    if run["status"] == "error":
        return True
    return run.get("zero_reason") in ERROR_EQUIVALENT_ZERO_REASONS


def _is_a_measurement(run: dict) -> bool:
    """Can this run stand as evidence of what the source normally returns?"""
    if run["status"] != "ok":
        return False
    return run.get("zero_reason") not in NOT_A_MEASUREMENT_ZERO_REASONS


# --- Routine thresholds ----------------------------------------------------

# Completed runs before the gap between them is treated as this routine's
# normal cadence.
MIN_RUNS_FOR_CADENCE = 3

# A routine is overdue once it has been silent for more than this multiple of
# its own observed cadence...
OVERDUE_CADENCE_MULTIPLE = 3

# ...and at least this long in absolute terms. An hourly routine three hours
# late is not news; a closed laptop explains it. A day late is.
OVERDUE_FLOOR_DAYS = 1.0

# Consecutive runs finding nothing new before a routine that used to find
# things is called unusual. Stricter than analytics.routine_health's ``stale``
# (three runs, no history requirement) because this one raises an alarm and
# that one only labels a row.
FLATLINE_RUNS = 5

# --- Cadence advice --------------------------------------------------------

# Advise re-timing a routine only when a source's median discovery lag exceeds
# its polling interval by this factor. Below it the polling interval is a
# plausible cause of the measured lag and the advice would be circular.
CADENCE_LAG_MULTIPLE = 2.0

_SEVERITY_ORDER = {"broken": 0, "unusual": 1, "advice": 2}


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def _parse_ts(value: str | None) -> datetime | None:
    """Parse a stored timestamp, tolerating the formats already on disk.

    ``utils.now_iso`` writes ``...Z``; SQLite's own ``datetime('now')`` default
    writes ``YYYY-MM-DD HH:MM:SS`` with no zone. Both appear in these tables.
    Everything resmon stores is UTC, so a naive value is read as UTC rather
    than as local time -- reading it as local would shift every gap by the
    user's offset and make an overdue routine look punctual.
    """
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00").replace(" ", "T", 1)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _days_between(earlier: datetime | None, later: datetime | None) -> float | None:
    if earlier is None or later is None:
        return None
    return (later - earlier).total_seconds() / 86400.0


def _humanise_days(days: float | None) -> str:
    """Render a duration the way a person would say it."""
    if days is None:
        return "an unknown time"
    if days < 1 / 24:
        return "under an hour"
    if days < 1:
        hours = int(round(days * 24))
        return f"{hours} hour{'s' if hours != 1 else ''}"
    if days < 14:
        whole = int(round(days))
        return f"{whole} day{'s' if whole != 1 else ''}"
    if days < 60:
        weeks = int(round(days / 7))
        return f"{weeks} week{'s' if weeks != 1 else ''}"
    months = int(round(days / 30))
    return f"{months} month{'s' if months != 1 else ''}"


# ---------------------------------------------------------------------------
# Data gathering
# ---------------------------------------------------------------------------


def _source_history(conn: sqlite3.Connection) -> dict[str, list[dict]]:
    """Every recorded run of every source, newest first.

    Only executions that reached a terminal state are included. A run still in
    flight has recorded some of its sources and not others, and counting the
    not-yet-recorded ones as absent would make a sweep in progress look like a
    source that stopped answering.
    """
    rows = conn.execute(
        """
        SELECT es.source            AS source,
               es.status            AS status,
               es.result_count      AS result_count,
               es.error_message     AS error_message,
               es.credential_name   AS credential_name,
               es.zero_reason       AS zero_reason,
               es.zero_detail       AS zero_detail,
               e.id                 AS execution_id,
               e.start_time         AS start_time,
               e.execution_type     AS execution_type
        FROM execution_sources es
        JOIN executions e ON e.id = es.execution_id
        WHERE e.status IN ('completed', 'failed')
        ORDER BY e.start_time DESC, e.id DESC
        """
    ).fetchall()

    history: dict[str, list[dict]] = {}
    for row in rows:
        history.setdefault(row["source"], []).append(dict(row))
    return history


def _routine_runs(conn: sqlite3.Connection) -> dict[int, list[dict]]:
    """Completed runs per routine, newest first."""
    rows = conn.execute(
        """
        SELECT routine_id, id, start_time, new_result_count, result_count
        FROM executions
        WHERE routine_id IS NOT NULL AND status = 'completed'
        ORDER BY start_time DESC, id DESC
        """
    ).fetchall()

    runs: dict[int, list[dict]] = {}
    for row in rows:
        runs.setdefault(row["routine_id"], []).append(dict(row))
    return runs


def _active_routine_sources(routines: list[dict]) -> dict[str, list[str]]:
    """Map each source to the active routines that still select it."""
    selected: dict[str, list[str]] = {}
    for routine in routines:
        if not routine.get("is_active"):
            continue
        for source in _routine_repositories(routine):
            selected.setdefault(source, []).append(routine.get("name") or "a routine")
    return selected


def _routine_repositories(routine: dict) -> list[str]:
    raw = routine.get("parameters")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
    if not isinstance(raw, dict):
        return []
    repositories = raw.get("repositories")
    if not isinstance(repositories, list):
        return []
    return [str(r) for r in repositories if r]


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------


def _finding(
    *,
    key: str,
    severity: str,
    kind: str,
    scope: dict,
    title: str,
    detail: str,
    what_to_do: str,
    evidence: dict,
) -> dict:
    return {
        "key": key,
        "severity": severity,
        "kind": kind,
        "scope": scope,
        "title": title,
        "detail": detail,
        "what_to_do": what_to_do,
        "evidence": evidence,
    }


def _failure_detail(run: dict) -> str:
    """What the most recent failing run actually recorded, in one clause.

    An ``error`` row has an exception string. An ``ok / 0`` row recorded as an
    upstream failure has no exception -- nothing raised -- and its detail is
    the JSON the engine wrote. Reading the exception field for both was how the
    old wording ended up saying "raised an error" about a run that did not.
    """
    if run["status"] == "error":
        return str(run.get("error_message") or "unknown error")
    detail = run.get("zero_detail")
    if isinstance(detail, str) and detail:
        try:
            parsed = json.loads(detail)
        except (ValueError, TypeError):
            parsed = {}
        if isinstance(parsed, dict):
            kind = parsed.get("detail")
            status = parsed.get("status")
            if status:
                return f"the source answered HTTP {status}"
            if kind == "timeout":
                return "the request timed out"
            if kind == "connect":
                return "resmon could not open a connection"
            if kind:
                return str(kind).replace("_", " ")
    return "the source did not answer"


def _check_sources(
    history: dict[str, list[dict]],
    active_sources: dict[str, list[str]],
    now: datetime,
) -> tuple[list[dict], list[dict]]:
    findings: list[dict] = []
    unjudged: list[dict] = []

    for source, runs in sorted(history.items()):
        # ``cancelled`` runs say nothing about the source -- the user stopped
        # it -- so they are dropped rather than counted as a failure or a zero.
        runs = [r for r in runs if r["status"] != "cancelled"]
        if not runs:
            continue

        latest = runs[0]
        latest_at = _parse_ts(latest["start_time"])

        # --- Rule: the source needs a key that is not configured -----------
        if latest["status"] == "skipped_missing_key":
            age_days = _days_between(latest_at, now)
            still_selected = active_sources.get(source)
            recent = age_days is not None and age_days <= MISSING_KEY_RECENCY_DAYS
            if still_selected or recent:
                credential = latest.get("credential_name") or "an API key"
                if still_selected:
                    where = (
                        "It is still selected by "
                        + _join_names(still_selected)
                        + ", so every one of those runs returns nothing from it."
                    )
                else:
                    where = (
                        f"It was last used {_humanise_days(age_days)} ago and "
                        "returned nothing from this source."
                    )
                findings.append(_finding(
                    key=f"source_missing_key:{source}",
                    severity="broken",
                    kind="source_missing_key",
                    scope={"type": "source", "id": source},
                    title=f"{source} has no API key configured",
                    detail=(
                        f"{source} requires the credential '{credential}', which is "
                        f"not set. {where} This is not an inference from the "
                        "results — resmon checks for the key before querying."
                    ),
                    what_to_do=(
                        "Add the key under Repositories & API Keys, or remove "
                        f"{source} from the routines that select it."
                    ),
                    evidence={
                        "credential_name": latest.get("credential_name"),
                        "last_run_at": latest["start_time"],
                        "selected_by_active_routines": still_selected or [],
                    },
                ))
            continue

        # --- Rule: consecutive failures to get an answer -------------------
        consecutive_errors = 0
        for run in runs:
            if not _did_not_answer(run):
                break
            consecutive_errors += 1

        if consecutive_errors >= CONSECUTIVE_ERRORS:
            # "Last answered successfully" must not count a run where the
            # source never answered. Before schema 10 it did, because an
            # outage was recorded as ``ok / 0`` -- so a source that had been
            # down for a month was reported as having answered an hour ago.
            last_ok = next(
                (r for r in runs
                 if r["status"] == "ok" and not _did_not_answer(r)), None,
            )
            last_ok_at = _parse_ts(last_ok["start_time"]) if last_ok else None
            since = _humanise_days(_days_between(last_ok_at, now)) if last_ok_at else None
            findings.append(_finding(
                key=f"source_errors:{source}",
                severity="broken",
                kind="source_errors",
                scope={"type": "source", "id": source},
                title=(
                    f"{source} has failed on its last "
                    f"{consecutive_errors} runs"
                ),
                # The old wording said every one of those runs "raised an
                # error". That is no longer true of every counted run and
                # never was of all of them: an upstream that answers 503 is
                # recorded as ``ok / 0`` and raises nothing at all. The
                # sentence says what actually happened, and the most recent
                # run's own recorded reason is what it quotes.
                detail=(
                    f"resmon got no answer from {source} on each of its last "
                    f"{consecutive_errors} runs. The most recent one: "
                    f"{_failure_detail(latest)}."
                    + (f" It last answered successfully {since} ago." if since
                       else " There is no successful run on record.")
                ),
                what_to_do=(
                    f"Check whether {source} is reachable and whether any key it "
                    "needs is still valid. Until it answers, results from it are "
                    "missing from every routine that selects it."
                ),
                evidence={
                    "consecutive_errors": consecutive_errors,
                    "last_error": latest.get("error_message"),
                    "last_zero_reason": latest.get("zero_reason"),
                    "last_success_at": last_ok["start_time"] if last_ok else None,
                    "runs_recorded": len(runs),
                },
            ))
            continue

        # --- Rule: a productive source has gone quiet -----------------------
        # Only runs where the source actually answered can say what it
        # normally returns. A run where it 503'd, replied unreadably, or could
        # not express the window is not a measurement of the field, and a
        # baseline built from those was never a baseline.
        ok_runs = [r for r in runs if _is_a_measurement(r)]
        if len(ok_runs) < MIN_BASELINE_RUNS:
            dropped = sum(
                1 for r in runs
                if r["status"] == "ok" and not _is_a_measurement(r)
            )
            reason = (
                f"{len(ok_runs)} run{'s' if len(ok_runs) != 1 else ''} on "
                f"record; a baseline needs {MIN_BASELINE_RUNS}."
            )
            if dropped:
                # Saying "1 run on record" about a source that has run twenty
                # times, nineteen of them without an answer, would be true and
                # useless. The reason names what was set aside and why.
                reason += (
                    f" {dropped} further run{'s' if dropped != 1 else ''} "
                    "returned nothing for a recorded reason that is not a "
                    "measurement of the field, so they are not counted here."
                )
            unjudged.append({
                "scope": {"type": "source", "id": source},
                "reason": reason,
                "runs_recorded": len(ok_runs),
                "runs_needed": MIN_BASELINE_RUNS,
                "runs_not_a_measurement": dropped,
            })
            continue

        zero_streak = 0
        for run in ok_runs:
            if (run["result_count"] or 0) > 0:
                break
            zero_streak += 1

        baseline = ok_runs[zero_streak:]
        productive = [r for r in baseline if (r["result_count"] or 0) > 0]

        if (
            zero_streak >= CONSECUTIVE_ZEROS
            and len(productive) >= MIN_PRODUCTIVE_BASELINE_RUNS
        ):
            typical = int(median([r["result_count"] for r in productive]))
            last_productive_at = _parse_ts(productive[0]["start_time"])
            findings.append(_finding(
                key=f"source_quiet:{source}",
                severity="unusual",
                kind="source_quiet",
                scope={"type": "source", "id": source},
                title=f"{source} has returned nothing on its last {zero_streak} runs",
                detail=(
                    f"Across the {len(productive)} runs before that, {source} "
                    f"returned a median of {typical} results. It answered without "
                    "error each time since, and returned zero. That can mean the "
                    "field is quiet, that the query no longer matches anything "
                    "there, or that the source changed what it will answer — "
                    "resmon cannot tell which from here."
                ),
                what_to_do=(
                    f"Run a Deep Dive against {source} with a deliberately broad "
                    "query. If that returns papers, the source is fine and the "
                    "routine's query is the thing to look at."
                ),
                evidence={
                    "zero_runs": zero_streak,
                    "baseline_runs": len(productive),
                    "typical_results": typical,
                    "last_productive_run_at": (
                        productive[0]["start_time"] if productive else None
                    ),
                    "quiet_for": _humanise_days(
                        _days_between(last_productive_at, now)
                    ),
                },
            ))

    return findings, unjudged


def _join_names(names: list[str]) -> str:
    unique = sorted(set(names))
    if len(unique) == 1:
        return f"'{unique[0]}'"
    if len(unique) == 2:
        return f"'{unique[0]}' and '{unique[1]}'"
    return ", ".join(f"'{n}'" for n in unique[:-1]) + f", and '{unique[-1]}'"


def _observed_cadence_days(runs: list[dict]) -> float | None:
    """The median gap between consecutive runs, in days.

    Measured rather than read off the schedule. A cron expression says when a
    routine is meant to fire; the gaps say when it did, which is the only thing
    that can be compared against how long it has now been silent. It also
    covers every schedule shape resmon supports without parsing any of them.
    """
    if len(runs) < MIN_RUNS_FOR_CADENCE:
        return None
    times = [_parse_ts(r["start_time"]) for r in runs]
    times = [t for t in times if t is not None]
    if len(times) < MIN_RUNS_FOR_CADENCE:
        return None
    gaps = [
        (times[i] - times[i + 1]).total_seconds() / 86400.0
        for i in range(len(times) - 1)
    ]
    gaps = [g for g in gaps if g > 0]
    return median(gaps) if gaps else None


def _check_routines(
    routines: list[dict],
    runs_by_routine: dict[int, list[dict]],
    lag_by_source: dict[str, dict],
    now: datetime,
) -> tuple[list[dict], list[dict]]:
    findings: list[dict] = []
    unjudged: list[dict] = []

    for routine in routines:
        if not routine.get("is_active"):
            # A paused routine is not firing on purpose. Reporting it would be
            # the first false alarm every user sees.
            continue

        routine_id = routine["id"]
        name = routine.get("name") or f"Routine {routine_id}"
        runs = runs_by_routine.get(routine_id, [])
        cadence = _observed_cadence_days(runs)

        if cadence is None:
            unjudged.append({
                "scope": {"type": "routine", "id": routine_id, "name": name},
                "reason": (
                    f"{len(runs)} completed run{'s' if len(runs) != 1 else ''}; "
                    f"a cadence needs {MIN_RUNS_FOR_CADENCE}."
                ),
                "runs_recorded": len(runs),
                "runs_needed": MIN_RUNS_FOR_CADENCE,
            })
            continue

        last_run_at = _parse_ts(runs[0]["start_time"])
        silent_days = _days_between(last_run_at, now)

        # --- Rule: the routine is overdue against its own cadence -----------
        if silent_days is not None and silent_days > max(
            cadence * OVERDUE_CADENCE_MULTIPLE, cadence + OVERDUE_FLOOR_DAYS
        ):
            findings.append(_finding(
                key=f"routine_overdue:{routine_id}",
                severity="broken",
                kind="routine_overdue",
                scope={"type": "routine", "id": routine_id, "name": name},
                title=f"'{name}' has not run for {_humanise_days(silent_days)}",
                detail=(
                    f"This routine is active and has run every "
                    f"{_humanise_days(cadence)} on average across its last "
                    f"{len(runs)} runs. It has now been silent for "
                    f"{_humanise_days(silent_days)}. Scheduled runs happen in "
                    "the resmon background service, so this usually means that "
                    "service is not running."
                ),
                what_to_do=(
                    "Check that resmon's background service is running "
                    "(Settings → Advanced). Reactivating the routine on the "
                    "Routines page re-registers its schedule."
                ),
                evidence={
                    "last_run_at": runs[0]["start_time"],
                    "silent_days": round(silent_days, 2),
                    "typical_gap_days": round(cadence, 2),
                    "runs_recorded": len(runs),
                },
            ))

        # --- Rule: the routine has stopped finding anything new -------------
        if len(runs) >= FLATLINE_RUNS:
            recent = runs[:FLATLINE_RUNS]
            if all((r["new_result_count"] or 0) == 0 for r in recent):
                earlier_productive = [
                    r for r in runs[FLATLINE_RUNS:]
                    if (r["new_result_count"] or 0) > 0
                ]
                if earlier_productive:
                    last_new_at = _parse_ts(earlier_productive[0]["start_time"])
                    findings.append(_finding(
                        key=f"routine_flatlined:{routine_id}",
                        severity="unusual",
                        kind="routine_flatlined",
                        scope={"type": "routine", "id": routine_id, "name": name},
                        title=(
                            f"'{name}' has found nothing new in its last "
                            f"{FLATLINE_RUNS} runs"
                        ),
                        detail=(
                            "It used to. The last run that found a new paper was "
                            f"{_humanise_days(_days_between(last_new_at, now))} "
                            "ago. A narrow query in a slow-moving field looks "
                            "exactly like this and is perfectly healthy, so this "
                            "is a prompt to check, not a fault."
                        ),
                        what_to_do=(
                            "Open the routine and widen one term, or check the "
                            "Watchdog entries for the sources it uses — a source "
                            "that has gone quiet produces this too."
                        ),
                        evidence={
                            "runs_without_new_results": FLATLINE_RUNS,
                            "last_new_result_at": earlier_productive[0]["start_time"],
                            "runs_recorded": len(runs),
                        },
                    ))

        # --- Advice: cadence against measured discovery lag -----------------
        advice = _cadence_advice(routine, name, cadence, lag_by_source)
        if advice:
            findings.append(advice)

    return findings, unjudged


def _cadence_advice(
    routine: dict,
    name: str,
    cadence: float,
    lag_by_source: dict[str, dict],
) -> dict | None:
    """Suggest a slower cadence when the sources cannot keep up with it.

    The honest caveat, which the payload carries so the interface can print it:
    discovery lag is measured from when *resmon* first saw each paper, so it
    includes however long the routine waited before asking. That is why the
    advice only fires when the lag is a multiple of the interval — at that
    point the polling interval cannot account for the gap and the source's own
    indexing delay must.
    """
    slow: list[dict] = []
    for source in _routine_repositories(routine):
        lag = lag_by_source.get(source)
        if not lag or not lag.get("sufficient"):
            continue
        median_days = lag.get("median_days")
        if median_days is None or median_days <= 0:
            continue
        if median_days > max(cadence, 1 / 24) * CADENCE_LAG_MULTIPLE:
            slow.append({
                "source": source,
                "median_lag_days": median_days,
                "sample_size": lag.get("sample_size"),
            })

    if not slow:
        return None

    slow.sort(key=lambda s: s["median_lag_days"], reverse=True)
    slowest = slow[0]
    others = len(slow) - 1

    return _finding(
        key=f"cadence_advice:{routine['id']}",
        severity="advice",
        kind="cadence_advice",
        scope={"type": "routine", "id": routine["id"], "name": name},
        title=f"'{name}' may be running more often than its sources update",
        detail=(
            f"This routine runs about every {_humanise_days(cadence)}. "
            f"{slowest['source']} has taken a median of "
            f"{slowest['median_lag_days']} days to surface a paper to you, "
            f"across {slowest['sample_size']} dated papers"
            + (f", and {others} other source{'s' if others != 1 else ''} "
               "here are slower than the interval too" if others else "")
            + ". Running more often than that costs requests without finding "
            "anything sooner. Note that this lag is measured from when resmon "
            "first saw each paper, so it includes the waiting this routine "
            "already does — the real indexing delay is at most this, never more."
        ),
        what_to_do=(
            f"Consider a slower schedule, closer to every "
            f"{_humanise_days(slowest['median_lag_days'])}. Nothing is broken "
            "either way."
        ),
        evidence={
            "cadence_days": round(cadence, 2),
            "slow_sources": slow,
            "lag_includes_polling_interval": True,
        },
    )


# ---------------------------------------------------------------------------
# Mutes
# ---------------------------------------------------------------------------


def get_mutes(conn: sqlite3.Connection) -> dict[str, dict]:
    """Every muted finding key, with when it was muted."""
    rows = conn.execute(
        "SELECT finding_key, muted_at, note FROM watchdog_mutes"
    ).fetchall()
    return {row["finding_key"]: dict(row) for row in rows}


def mute(conn: sqlite3.Connection, finding_key: str, note: str | None = None) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO watchdog_mutes (finding_key, note) VALUES (?, ?)",
        (finding_key, note),
    )
    conn.commit()


def unmute(conn: sqlite3.Connection, finding_key: str) -> None:
    conn.execute(
        "DELETE FROM watchdog_mutes WHERE finding_key = ?", (finding_key,)
    )
    conn.commit()


def _prune_stale_mutes(conn: sqlite3.Connection, live_keys: set[str]) -> None:
    """Forget mutes whose condition has resolved.

    A mute is an acknowledgement of a specific condition, not a permanent
    exemption for that source or routine. When the source starts answering
    again the finding disappears; if it later fails again, that is news, and
    a mute left lying around would swallow it.
    """
    rows = conn.execute("SELECT finding_key FROM watchdog_mutes").fetchall()
    stale = [row["finding_key"] for row in rows if row["finding_key"] not in live_keys]
    if not stale:
        return
    conn.executemany(
        "DELETE FROM watchdog_mutes WHERE finding_key = ?",
        [(key,) for key in stale],
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def report(conn: sqlite3.Connection, *, now: datetime | None = None) -> dict:
    """Everything the watchdog can say about this install, right now.

    ``now`` is injectable so tests can place a corpus in time without sleeping.
    """
    now = now or datetime.now(timezone.utc)

    routines = [dict(r) for r in conn.execute(
        "SELECT id, name, schedule_cron, parameters, is_active, last_executed_at "
        "FROM routines ORDER BY name"
    ).fetchall()]

    history = _source_history(conn)
    runs_by_routine = _routine_runs(conn)
    active_sources = _active_routine_sources(routines)

    # Discovery lag scans every dated paper in the corpus, and it feeds exactly
    # one rule: cadence advice, which only applies to active routines. On an
    # install with none — or one still on its first couple of runs — that scan
    # is pure cost, and this report is fetched on every Dashboard load.
    lag_by_source: dict[str, dict] = {}
    if any(r.get("is_active") for r in routines):
        lag = analytics.discovery_lag(conn)
        lag_by_source = {row["source"]: row for row in lag.get("sources", [])}

    source_findings, source_unjudged = _check_sources(history, active_sources, now)
    routine_findings, routine_unjudged = _check_routines(
        routines, runs_by_routine, lag_by_source, now,
    )

    findings = source_findings + routine_findings
    _prune_stale_mutes(conn, {f["key"] for f in findings})
    mutes = get_mutes(conn)

    for finding in findings:
        muted = mutes.get(finding["key"])
        finding["muted"] = muted is not None
        finding["muted_at"] = muted["muted_at"] if muted else None

    findings.sort(key=lambda f: (
        f["muted"],
        _SEVERITY_ORDER.get(f["severity"], 9),
        f["title"],
    ))

    alarms = [
        f for f in findings
        if f["severity"] in ("broken", "unusual") and not f["muted"]
    ]

    return {
        "checked_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "findings": findings,
        "counts": {
            "broken": sum(1 for f in alarms if f["severity"] == "broken"),
            "unusual": sum(1 for f in alarms if f["severity"] == "unusual"),
            "advice": sum(
                1 for f in findings
                if f["severity"] == "advice" and not f["muted"]
            ),
            "muted": sum(1 for f in findings if f["muted"]),
            "alarms": len(alarms),
        },
        "not_enough_data": source_unjudged + routine_unjudged,
        "watching": {
            "sources": len(history),
            "routines": sum(1 for r in routines if r.get("is_active")),
        },
        "thresholds": {
            "consecutive_errors": CONSECUTIVE_ERRORS,
            "consecutive_zeros": CONSECUTIVE_ZEROS,
            "min_baseline_runs": MIN_BASELINE_RUNS,
            "flatline_runs": FLATLINE_RUNS,
            "overdue_cadence_multiple": OVERDUE_CADENCE_MULTIPLE,
            "overdue_floor_days": OVERDUE_FLOOR_DAYS,
            "cadence_lag_multiple": CADENCE_LAG_MULTIPLE,
            "min_runs_for_cadence": MIN_RUNS_FOR_CADENCE,
        },
        # False when there is no history at all to reason over. The interface
        # says "nothing to check yet" rather than "all clear", which would be
        # a claim the watchdog has not earned.
        "sufficient": bool(history or runs_by_routine),
    }
