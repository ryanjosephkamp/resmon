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
    the routine has not fired when its own history says it should have; a
    scheduled fire was skipped because the run before it was still going. These
    are reported as certainties because they are certainties.

``unusual``
    A departure from a baseline this user's own data established. A source that
    reliably returned papers has returned none several runs running. These are
    reported as questions, never as failures, and always with the baseline and
    the sample size attached, because the innocent explanation -- the field went
    quiet -- is genuinely possible every time.

``advice``
    Not an alarm. A pattern in what resmon measured, such as how long after
    their dates a source's papers have reached the collection, stated with
    what the measurement does and does not show. Never counted in the alarm
    total.

``withdrawn``
    A source resmon no longer asks, by decision, that runs still recorded.
    Not a fault and not an alarm: nothing about the source can be checked or
    fixed, and the finding says whether a watch still selects it.

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

import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from statistics import median

from . import analytics, repo_catalog, zero_reason
from .api_registry import RETIRED_NAMES, RETIRED_REPOSITORIES

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
# it is: resmon sent a query and got nothing usable back from the source.
#
# ``upstream_failure`` is the source not replying at all. ``parse_failure`` is
# the source replying with something resmon cannot read -- a 200 whose body
# will not parse, a schema that changed under us. Neither raises, because
# every client degrades rather than failing a sweep, and both leave the user
# with nothing while the run reads ``ok``. A reply that cannot be read on
# every run for a fortnight is precisely the silent breakage this component
# exists to catch, and it was the one shape it still could not see.
#
# ``window_unanswerable`` is deliberately **not** here. It is not a fault at
# all -- the source is behaving correctly and the window is the user's -- and
# alarming on it would train people to ignore the watchdog, which is the
# failure this whole file is written against.
ERROR_EQUIVALENT_ZERO_REASONS = frozenset({"upstream_failure", "parse_failure"})

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
    return (
        int(run.get("result_count") or 0) == 0
        and run.get("zero_reason") in ERROR_EQUIVALENT_ZERO_REASONS
    )


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

# How far back a scheduled fire that did not run, because the run before it was
# still going, keeps its watch on the Watchdog. A week: long enough to be seen
# by someone who looks in once a week, short enough that a watch whose interval
# was lengthened clears on its own. Every skipped fire stays on the watch's
# Schedule tab whatever its age.
SKIPPED_FIRES_WINDOW_DAYS = 7

# --- Cadence advice --------------------------------------------------------

# Advise re-timing a routine only when a source's median discovery lag exceeds
# its polling interval by this factor. Below it the polling interval is a
# plausible cause of the measured lag and the advice would be circular.
CADENCE_LAG_MULTIPLE = 2.0

_SEVERITY_ORDER = {"broken": 0, "unusual": 1, "advice": 2, "withdrawn": 3}


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

    Only ``completed`` and ``failed`` executions are included. A run still in
    flight has recorded some of its sources and not others, and counting the
    not-yet-recorded ones as absent would make a sweep in progress look like a
    source that stopped answering.

    **``cancelled`` and ``interrupted`` runs are excluded on the same
    reasoning, and that is deliberate.** Both stopped part-way through for a
    reason that has nothing to do with the sources: the user cancelled, or the
    backend went away (schema 19). Their ``execution_sources`` rows are a
    partial record of which sources happened to have been reached by then, and
    feeding that to the watchdog would report a source as having gone quiet
    when what actually happened is that resmon stopped asking. The cost is that
    a source which really did break during an interrupted run is not seen until
    the next complete one -- which is the right way round: the watchdog exists
    to say when monitoring has broken, and it must not say so on evidence it
    does not have.
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
        WHERE e.status IN ('completed', 'failed')   -- see the docstring: not cancelled, not interrupted
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
    upstream failure or a parse failure has no exception -- nothing raised --
    and its detail is the JSON the engine wrote. Reading the exception field
    for all of them was how the old wording ended up saying "raised an error"
    about a run that did not.

    The two no-answer reasons need different clauses. An upstream failure is
    the source not replying; a parse failure is the source replying with
    something resmon cannot read. Telling a user their source is unreachable
    when it is answering perfectly well and has changed its response format
    sends them to look for a problem that is not there.
    """
    if run["status"] == "error":
        return str(run.get("error_message") or "unknown error")

    detail = run.get("zero_detail")
    parsed: dict = {}
    if isinstance(detail, str) and detail:
        try:
            loaded = json.loads(detail)
        except (ValueError, TypeError):
            loaded = None
        if isinstance(loaded, dict):
            parsed = loaded
    kind = parsed.get("detail")

    if run.get("zero_reason") == "parse_failure":
        if kind == "incomplete_page":
            return (
                "the source answered and resmon could not read the reply "
                "(the page it returned was incomplete)"
            )
        return "the source answered and resmon could not read the reply"

    status = parsed.get("status")
    if status:
        return f"the source answered HTTP {status}"
    if kind == "timeout":
        return "the request timed out"
    if kind == "connect":
        return "resmon could not open a connection"
    if kind == "refused":
        return "the source refused the request"
    if kind:
        return str(kind).replace("_", " ")
    return "the source did not answer"


def _source_name(slug: str) -> str:
    """The name a person knows a source by, a withdrawn one included."""
    for entry in repo_catalog.REPOSITORY_CATALOG:
        if entry.slug == slug:
            return entry.name
    return RETIRED_NAMES.get(slug) or slug


def _retired_reason(run: dict) -> str:
    """The withdrawal reason a run recorded, for a source this build no longer lists."""
    try:
        detail = json.loads(run.get("zero_detail") or "{}")
    except (ValueError, TypeError):
        return ""
    return str(detail.get("detail") or "") if isinstance(detail, dict) else ""


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
                # Named by the source, never by its keychain slot: the slot is
                # resmon's bookkeeping, and the person adds the key by source.
                name = _source_name(source)
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
                    title=f"{name} has no API key configured",
                    detail=(
                        f"{name} needs an API key, and none is stored. {where} "
                        "This is not an inference from the results — resmon "
                        "checks for the key before querying."
                    ),
                    what_to_do=(
                        "Add the key under Settings › Sources, or remove "
                        f"{name} from the routines that select it."
                    ),
                    evidence={
                        # The row a person reads, in words. The slot itself
                        # stays in the evidence for a client that needs it, under
                        # a key no screen labels.
                        "credential_name": f"An API key for {name} (none is stored)",
                        "credential_slot": latest.get("credential_name"),
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
            # Nor a zero with no reason on record: resmon did not observe
            # whether the source answered that run, and the Source wall, the
            # run's coverage, and the search record all read it that way
            # (``zero_reason.answered``). Counting it here said a source the
            # wall calls never answered had last answered on a day it
            # returned nothing at all.
            last_ok = next(
                (r for r in runs
                 if zero_reason.answered(r["status"], int(r["result_count"] or 0),
                                         r.get("zero_reason"))), None,
            )
            last_ok_at = _parse_ts(last_ok["start_time"]) if last_ok else None
            since = _humanise_days(_days_between(last_ok_at, now)) if last_ok_at else None
            evidence = {
                "consecutive_errors": consecutive_errors,
                # The same clause the detail quotes. ``error_message`` alone
                # is empty for an outage recorded as ``ok / 0`` -- nothing
                # raised -- so the card said "HTTP 400" in its sentence and
                # showed no most recent error beside it.
                "last_error": _failure_detail(latest),
                "last_zero_reason": latest.get("zero_reason"),
                "last_success_at": last_ok["start_time"] if last_ok else None,
                "runs_recorded": len(runs),
            }

            # A withdrawn source is not down and needs no key: resmon declines
            # to ask it, by decision, and will not ask it again. Advice to
            # check whether it is reachable would send the user after a fault
            # that does not exist.
            withdrawn = RETIRED_REPOSITORIES.get(source)
            if withdrawn is None and latest.get("zero_reason") == "retired":
                withdrawn = _retired_reason(latest)
            if withdrawn is not None:
                still_selected = active_sources.get(source)
                findings.append(_finding(
                    key=f"source_errors:{source}",
                    # Withdrawn, not broken: resmon declines to ask it, and
                    # calling that a fault beside "nothing needs changing"
                    # said two things at once.
                    severity="withdrawn",
                    kind="source_errors",
                    scope={"type": "source", "id": source},
                    title=f"{source} was withdrawn from resmon",
                    # True whatever ended each run in the streak: some may
                    # have been real failures from before the withdrawal.
                    detail=(
                        f"{source} has been withdrawn, and resmon got nothing "
                        f"from it on each of its last {consecutive_errors} runs. "
                        + (withdrawn or "")
                    ).strip(),
                    what_to_do=(
                        f"Remove {source} from "
                        + _join_names(still_selected)
                        + (", which still selects it." if len(set(still_selected)) == 1
                           else ", which still select it.")
                        + " Nothing about the source needs checking: it will "
                        "not be asked again."
                        if still_selected else
                        f"No active routine selects {source} any more, so no "
                        "future run will ask for it and nothing needs changing. "
                        "Mute this if the record of those runs is no longer useful."
                    ),
                    evidence=evidence,
                ))
                continue

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
                evidence=evidence,
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


def _check_skipped_fires(conn: sqlite3.Connection, routines: list[dict],
                         now: datetime) -> list[dict]:
    """Active routines with scheduled fires that did not run, in the last week.

    A recorded fact, not an inference: each row in ``routine_missed_fires``
    with disposition ``skipped`` is a fire that came due while the routine's
    previous run was still going, was refused, and will not run (no catch-up
    run is started). A watch whose runs outlast its interval runs at a fraction
    of the cadence its owner set, and until this rule that showed only on the
    watch's own Schedule tab and in the engine log.
    """
    active = {int(r["id"]): r.get("name") or f"Routine {r['id']}"
              for r in routines if r.get("is_active")}
    if not active:
        return []
    since = (now - timedelta(days=SKIPPED_FIRES_WINDOW_DAYS)).astimezone(timezone.utc).isoformat()
    findings: list[dict] = []
    for row in conn.execute(
        "SELECT routine_id, COUNT(*) AS n, MAX(due_at_utc) AS last_due "
        "FROM routine_missed_fires WHERE disposition = 'skipped' AND due_at_utc >= ? "
        "GROUP BY routine_id",
        (since,),
    ).fetchall():
        routine_id = int(row["routine_id"])
        if routine_id not in active:
            continue
        name, n = active[routine_id], int(row["n"])
        times = "time" if n == 1 else "times"
        findings.append(_finding(
            key=f"routine_fires_skipped:{routine_id}",
            severity="broken",
            kind="routine_fires_skipped",
            scope={"type": "routine", "id": routine_id, "name": name},
            title=(f"'{name}' did not run {n} {times} it was due in the last "
                   f"{SKIPPED_FIRES_WINDOW_DAYS} days"),
            # When the last one was due is in the evidence, as an instant a
            # screen says in the reader's own time; a sentence would have to
            # print it in UTC.
            detail=(
                "Each time, the run before it was still going, so resmon "
                "skipped the fire: it runs one copy of a watch at a time and "
                "does not run a skipped fire later. This watch is running less "
                "often than its schedule says."
            ),
            what_to_do=(
                "Give the watch a longer interval, or fewer sources, so a run "
                "finishes before the next is due. Its Schedule tab lists every "
                "fire that did not run."
            ),
            evidence={
                "skipped_fires": n,
                "last_skipped_due_at_utc": row["last_due"],
                "window_days": SKIPPED_FIRES_WINDOW_DAYS,
            },
        ))
    return findings


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
                    "(Settings › In the background). Pausing and resuming the "
                    "watch on its page re-registers its schedule."
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
    """Say when a routine's sources' papers have arrived long after their dates.

    What is measured is discovery lag (``analytics.discovery_lag``): for every
    dated paper from a source in the collection, the days from the date the
    paper carries to when resmon first collected it, by any watch or search.
    That gap includes the time a routine waits between runs, a search that
    asked for older papers, and whatever delay the source has, and resmon
    cannot tell those apart. So the finding fires only when the median is a
    multiple of the routine's interval, and says only that: it does not claim
    the source updates slowly, or that running less often would find papers
    no later.
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
    lag_words = _humanise_days(slowest["median_lag_days"])
    # By name: this finding is a watch's, and a screen renames only a source
    # finding's own key.
    source_name = _source_name(slowest["source"])

    return _finding(
        key=f"cadence_advice:{routine['id']}",
        severity="advice",
        kind="cadence_advice",
        scope={"type": "routine", "id": routine["id"], "name": name},
        title=(
            f"{source_name}'s papers reached your collection a median of "
            f"{lag_words} after their dates"
        ),
        detail=(
            f"'{name}' runs about every {_humanise_days(cadence)}. Across "
            f"{int(slowest['sample_size'] or 0):,} dated papers from {source_name} in "
            "your collection, resmon first collected each a median of "
            f"{slowest['median_lag_days']} days after the date it carries"
            + (f", and {others} other source{'s' if others != 1 else ''} this "
               "watch asks show a median more than "
               f"{CADENCE_LAG_MULTIPLE:g} times its interval too" if others else "")
            + ". The lag runs from a paper's date to the first run, of any "
            "watch or search, that collected it: it includes the time between "
            "runs, searches that asked for older papers, and any delay at the "
            "source, and resmon cannot tell those apart."
        ),
        what_to_do=(
            f"If {source_name} lists papers that long after their dates, "
            f"a schedule closer to every {lag_words} would send it fewer "
            "requests. This measurement does not show whether that would find "
            "papers later than now."
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

    findings = source_findings + routine_findings + _check_skipped_fires(conn, routines, now)
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
            "skipped_fires_window_days": SKIPPED_FIRES_WINDOW_DAYS,
        },
        # False when there is no history at all to reason over. The interface
        # says "nothing to check yet" rather than "all clear", which would be
        # a claim the watchdog has not earned.
        "sufficient": bool(history or runs_by_routine),
    }


# ---------------------------------------------------------------------------
# What the report reads, for serving it again while that is unchanged
# ---------------------------------------------------------------------------

#: The longest one report is served again. Some findings depend on the clock
#: as well as on the record (a routine overdue, a skipped fire leaving the
#: week's window), so a report is never older than this, whatever the record
#: says.
KEEP_SECONDS = 60.0


def what_it_reads(conn: sqlite3.Connection) -> tuple:
    """A cheap fingerprint of everything ``report`` reads.

    Runs (one starting, ending, or deleted), each run's per-source record,
    the routines (any change to a watch: its schedule, its settings, its name,
    turning it on or off), recorded fires, the mutes, the newest paper (an
    erased corpus), and the app's stored settings. While it is unchanged, so is
    the report, until the clock moves. It costs a handful of indexed lookups
    where the report scans every run.
    """
    row = tuple(conn.execute(
        "SELECT"
        " (SELECT COUNT(*) || ':' || IFNULL(MAX(id), 0) || ':' || IFNULL(MAX(end_time), '')"
        "  || ':' || IFNULL(SUM(status IN ('running', 'cancelling')), 0) FROM executions),"
        " (SELECT COUNT(*) || ':' || IFNULL(MAX(rowid), 0) FROM execution_sources),"
        " (SELECT IFNULL(group_concat(id || '|' || is_active || '|' || IFNULL(last_executed_at, '') || '|'"
        "  || IFNULL(schedule_cron, '') || '|' || IFNULL(parameters, '') || '|' || name, char(30)), '')"
        "  FROM routines),"
        " (SELECT COUNT(*) || ':' || IFNULL(MAX(id), 0) || ':' || IFNULL(SUM(disposition = 'skipped'), 0)"
        "  FROM routine_missed_fires),"
        " (SELECT IFNULL(group_concat(finding_key || '@' || muted_at, char(30)), '') FROM watchdog_mutes),"
        " (SELECT IFNULL(MAX(id), 0) FROM documents)"
    ).fetchone())
    # The report reads no stored setting today; a setting changing still
    # starts it afresh, so one it comes to read is never served stale. Hashed,
    # so no setting's value is held beside the report.
    settings = hashlib.sha256()
    for key, value in conn.execute("SELECT key, value FROM app_settings ORDER BY key"):
        settings.update(f"{key}\x1e{value}\x1f".encode("utf-8", "replace"))
    return row + (settings.hexdigest(),)

