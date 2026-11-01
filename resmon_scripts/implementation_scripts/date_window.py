# resmon_scripts/implementation_scripts/date_window.py
"""A watch's dates when they move with time, computed when the watch fires.

A watch stored its dates as ``date_from`` / ``date_to`` and every fire passed
them to every source unchanged. That leaves two choices and both fail:

* **Fixed dates** ask for the same days for ever. A watch saved with last
  May's two days asks for those two days every night.
* **No dates** ask each source for its own order. A source that sorts by date
  (arXiv) then returns its newest papers; a relevance-ranked one (Crossref,
  OpenAlex and others: the catalog's ``result_order``) returns the most
  relevant papers of all years, mostly the same ones every run, and the watch
  finds almost nothing new while looking healthy.

``parameters.date_window`` is the third choice, explicit and opt-in:

``{"since": "previous_run"}``
    Papers published since this watch's previous run.
``{"last_days": N}``
    Papers published in the N days before the run starts.

Either is turned into real dates **when the watch fires** (scheduled or Run
now, which is the same ``_dispatch_routine_fire``) and those dates are written
into the run's own parameters as ``date_from`` with no ``date_to``, beside a
record of how they were reached (``date_window_computed``). Everything that
states a run's dates reads them from there, so the run page, the search record
and the report say the dates that were actually asked, never "since the
previous run" without them.

A watch without the key is unchanged: an undated watch stays undated and a
dated one keeps its dates. Only the person's choice changes a watch.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Optional

from . import zero_reason

__all__ = [
    "DEFAULT_DAYS",
    "MAX_DAYS",
    "OVERLAP_DAYS",
    "WindowError",
    "apply",
    "coverage_note",
    "default_start_words",
    "normalized",
    "previous_run",
    "resolve",
    "validate_parameters",
]

# How far before the previous run's start a "since the previous run" window
# begins. At least a day, because sources date papers by calendar day in their
# own time zone: a paper dated the day of the previous run may have been listed
# after that run asked. Three rather than one, because a source lists a paper
# some time after the date it carries; arXiv, the commonest date-sorted source,
# announces Thursday-afternoon and Friday submissions on Sunday and Monday
# evenings, so the previous run could not have seen a paper dated up to about
# three days before it. Not more, because each run returns at most its cap
# from each source, and a wider window spends that cap on papers the previous
# run already returned, which on a busy subject pushes the new ones out.
# Sources that date by month or year are not helped by any overlap: each rounds
# the window to whole months or years its own way, as its catalog entry says.
OVERLAP_DAYS = 3

# What a "since the previous run" watch asks when there is no previous run to
# start from: its first run, or one whose earlier runs all failed before any
# source answered. A week covers a daily or a weekly schedule's first window
# without asking for years of papers on the first night.
DEFAULT_DAYS = 7

# The longest "in the last N days" window: ten years. A longer one is a
# watch with a start date, which "Between two dates" says plainly.
MAX_DAYS = 3650

_SINCE = "previous_run"


class WindowError(ValueError):
    """A ``date_window`` the engine will not store, with the sentence why."""


def normalized(raw: object) -> Optional[dict]:
    """``parameters.date_window`` in its one stored shape, or ``None`` when absent.

    Refused rather than repaired: a window the engine reads differently from
    the person who wrote it would fire into dates nobody chose.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict) or len(raw) != 1:
        raise WindowError(
            'date_window is either {"since": "previous_run"} or {"last_days": N}, '
            "with nothing else beside it.")
    if "since" in raw:
        if raw["since"] != _SINCE:
            raise WindowError(
                'date_window.since can only be "previous_run": papers published '
                "since the watch's previous run.")
        return {"since": _SINCE}
    if "last_days" in raw:
        days = raw["last_days"]
        if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= MAX_DAYS:
            raise WindowError(
                f"date_window.last_days is a whole number of days from 1 to {MAX_DAYS}.")
        return {"last_days": days}
    raise WindowError(
        'date_window is either {"since": "previous_run"} or {"last_days": N}.')


def _set(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_parameters(parameters: object) -> Optional[dict]:
    """The window a watch's parameters ask for, checked as they will be stored.

    A window that moves and fixed dates beside it are refused together: one of
    the two would be ignored at fire time, and what is stored has to be what
    runs.
    """
    if not isinstance(parameters, dict):
        return None
    window = normalized(parameters.get("date_window"))
    if window and (_set(parameters.get("date_from")) or _set(parameters.get("date_to"))):
        raise WindowError(
            "A watch asks either for papers in a window that moves with each run "
            "(date_window) or between fixed dates (date_from and date_to), not both. "
            "Clear the dates, or remove date_window.")
    return window


def _instant(stamp: object) -> Optional[datetime]:
    """An execution's ``start_time`` as an instant; SQLite's zone-less stamps are UTC."""
    if not isinstance(stamp, str) or not stamp.strip():
        return None
    text = stamp.strip().replace(" ", "T")
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    try:
        at = datetime.fromisoformat(text)
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def previous_run(conn: sqlite3.Connection, routine_id: int) -> Optional[dict]:
    """The latest run of this watch, by start time, in which a source answered.

    "Answered" is ``zero_reason.answered``, the rule the search record and the
    executions API already share: the source replied to the query resmon sent.
    A run that failed before querying, or in which every source failed (a
    laptop that fired offline, say), asked nothing that was answered, so a
    window starting from it would skip the days it was meant to cover; it is
    passed over and the run before it is used instead.
    """
    rows = conn.execute(
        "SELECT e.id, e.start_time, s.status, s.result_count, s.zero_reason "
        "FROM executions e JOIN execution_sources s ON s.execution_id = e.id "
        "WHERE e.routine_id = ? ORDER BY e.start_time DESC, e.id DESC",
        (int(routine_id),),
    ).fetchall()
    for row in rows:
        status, count, reason = row[2], row[3], row[4]
        if not zero_reason.answered(status, count or 0, reason):
            continue
        started = _instant(row[1])
        if started is None:
            continue
        return {"execution_id": int(row[0]), "start_time": row[1], "started": started}
    return None


def _words(day: date) -> str:
    return f"{day:%B} {day.day}, {day.year}"


def _days(n: int) -> str:
    return "1 day" if n == 1 else f"{n} days"


def _sentence(record: dict, *, upcoming: bool) -> str:
    start = _words(date.fromisoformat(record["date_from"]))
    basis = record["basis"]
    if basis == "last_days":
        days = _days(record["days"])
        if upcoming:
            return (f"Each run asks for papers published in the {days} before it starts: "
                    f"a run today asks from {start}, with no end date.")
        return f"Papers published in the last {days}: from {start}, with no end date."
    if basis == "no_previous_run":
        days = _days(record["default_days"])
        if upcoming:
            return (f"This watch has no run yet in which a source answered, so its next run "
                    f"asks for the last {days}: from {start} if it runs today, with no end date.")
        return (f"Papers published since the previous run. This watch has no earlier run in "
                f"which a source answered, so this run asks for the last {days}: from {start}, "
                "with no end date.")
    started = _words(record["previous_started_on"])
    overlap = _days(record["overlap_days"])
    run = f"run {record['previous_execution_id']}"
    if upcoming:
        return (f"The next run asks for papers published from {start}, with no end date: "
                f"{run}, the latest in which a source answered, started on {started}, and the "
                f"window starts {overlap} before that, because a source often lists a paper "
                "after the date it carries.")
    return (f"Papers published since the previous run: from {start}, with no end date. "
            f"{run.capitalize()}, the latest earlier run in which a source answered, started "
            f"on {started}; the window starts {overlap} before that, because a source often "
            "lists a paper after the date it carries.")


def default_start_words(source: str, start: dict) -> str:
    """Why a source was asked from a start the run did not set, after its name.

    ``start`` is what the source's client noted when the run gave it no start
    date (``api_base.note_default_start``): resmon reads every record in a
    bioRxiv or medRxiv range itself, for at most 45 seconds, so each is asked
    for the catalog's ``default_start_days`` before the run, or before the
    run's end date when that is earlier. The run's log puts these words after
    the source's id ("biorxiv: asked from ..."), and its record after
    "{name} was".
    """
    day = _words(date.fromisoformat(str(start["date_from"])))
    before = "the run's end date" if start.get("before") == "end_date" else "the run started"
    return (f"asked from {day}, {_days(int(start['days']))} before {before}, because the run "
            f"set no start date: resmon reads every preprint in a {source} range itself, and "
            f"{source}'s whole archive is far more than a search can read in 45 seconds.")


def resolve(
    conn: sqlite3.Connection,
    routine_id: int,
    window: dict,
    *,
    now: Optional[datetime] = None,
    tz: Optional[tzinfo] = None,
    upcoming: bool = False,
) -> dict:
    """The dates *window* asks for if this watch runs at *now*, and how.

    Days are this computer's calendar days (``tz`` is for tests), the days its
    owner sees the runs on. ``upcoming`` words the sentence for the watch's
    own page, before a run, rather than for the run's record.
    """
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(tz).date()
    record: dict = {
        "mode": "last_days" if "last_days" in window else "since_previous_run",
        "basis": "last_days",
        "date_from": None,
        "date_to": None,
        "days": None,
        "previous_execution_id": None,
        "previous_start_time": None,
        "overlap_days": None,
        "default_days": None,
        "computed_at": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if "last_days" in window:
        record["days"] = int(window["last_days"])
        record["date_from"] = (today - timedelta(days=record["days"])).isoformat()
    else:
        found = previous_run(conn, routine_id)
        if found is None:
            record["basis"] = "no_previous_run"
            record["default_days"] = DEFAULT_DAYS
            record["date_from"] = (today - timedelta(days=DEFAULT_DAYS)).isoformat()
        else:
            started_on = found["started"].astimezone(tz).date()
            record["basis"] = "previous_run"
            record["previous_execution_id"] = found["execution_id"]
            record["previous_start_time"] = found["start_time"]
            record["overlap_days"] = OVERLAP_DAYS
            # A start stamped later than today (a clock put back) still asks
            # back from today, never for papers not yet dated.
            first = min(started_on, today) - timedelta(days=OVERLAP_DAYS)
            record["date_from"] = first.isoformat()
            record["previous_started_on"] = started_on
    record["sentence"] = _sentence(record, upcoming=upcoming)
    record.pop("previous_started_on", None)
    return record


def apply(
    conn: sqlite3.Connection,
    routine_id: int,
    params: dict,
    *,
    now: Optional[datetime] = None,
    tz: Optional[tzinfo] = None,
) -> Optional[dict]:
    """Write a firing watch's computed dates into the run's parameters.

    Returns the record, or ``None`` for a watch with no ``date_window`` (fixed
    dates or none), whose parameters are left exactly as stored. A window
    stored before validation existed and not readable now is not guessed at:
    the run is refused the window rather than given dates nobody chose.
    """
    if params.get("date_window") is None:
        return None
    window = normalized(params.get("date_window"))
    record = resolve(conn, routine_id, window, now=now, tz=tz)
    params["date_from"] = record["date_from"]
    params["date_to"] = None
    params["date_window_computed"] = record
    return record


def coverage_note(conn: sqlite3.Connection, routine_id: int, parameters: object) -> Optional[str]:
    """What the coverage audit's "never returned" list cannot mean, for a moving window.

    A watch that asks only for recent papers never asked for an older one, so
    an older paper close to its intent is missing from its results because of
    its dates, not its terms. ``None`` for a watch whose window does not move,
    or that has not yet run with one.
    """
    if not isinstance(parameters, dict) or parameters.get("date_window") is None:
        return None
    earliest: Optional[str] = None
    for (raw,) in conn.execute(
        "SELECT parameters FROM executions WHERE routine_id = ?", (int(routine_id),),
    ):
        try:
            params = json.loads(raw) if isinstance(raw, str) else {}
        except (ValueError, TypeError):
            continue
        computed = params.get("date_window_computed") if isinstance(params, dict) else None
        start = computed.get("date_from") if isinstance(computed, dict) else None
        if isinstance(start, str) and (earliest is None or start < earliest):
            earliest = start
    if earliest is None:
        return None
    return (f"This watch asks each run only for recent papers, and its runs have asked for papers "
            f"published from {_words(date.fromisoformat(earliest))} on. A paper published before "
            "that was never asked for, so its absence from this watch's results is about its date, "
            "not the terms.")
