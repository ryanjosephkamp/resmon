# resmon_scripts/implementation_scripts/scheduler.py
"""APScheduler-based task scheduler for automated sweep routines."""

import json
import logging
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.triggers.base import BaseTrigger
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from dateutil.relativedelta import relativedelta

try:
    from tzlocal import get_localzone  # type: ignore
except Exception:  # pragma: no cover
    get_localzone = None  # type: ignore

from .config import DEFAULT_DB_PATH

logger = logging.getLogger(__name__)

_DEFAULT_DB_URL = f"sqlite:///{DEFAULT_DB_PATH}"

# ---------------------------------------------------------------------------
# Dispatcher indirection (IMPL-R3)
#
# The scheduler module is deliberately decoupled from FastAPI and SweepEngine.
# resmon.py installs the real dispatcher via ``set_dispatcher`` at startup
# (IMPL-R4); tests install a no-op or recording dispatcher. When no
# dispatcher is installed, a routine fire logs an error and returns so the
# APScheduler thread does not raise.
# ---------------------------------------------------------------------------

_dispatcher: Optional[Callable[[int, str], None]] = None


def set_dispatcher(fn: Optional[Callable[[int, str], None]]) -> None:
    """Install the callable invoked on each routine fire.

    The callable receives ``(routine_id: int, parameters: str)``. Passing
    ``None`` clears the dispatcher (used in test teardown).
    """
    global _dispatcher
    _dispatcher = fn


def _parse_cron(cron_expr: str) -> dict:
    """Parse a 5-field cron expression into CronTrigger keyword arguments.

    Format: ``minute hour day month day_of_week``

    Note on day-of-week: standard cron numbers Sunday=0 (and accepts 7 as
    a Sunday alias), but APScheduler's ``day_of_week`` field numbers
    Monday=0. To preserve the user-facing standard-cron semantics
    (e.g. ``0 8 * * 1-5`` means Monday-Friday at 08:00, not Tuesday-
    Saturday), numeric tokens in the day-of-week field are rewritten to
    the equivalent named-day tokens APScheduler interprets correctly.
    """
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        raise ValueError(
            f"Expected 5-field cron expression, got {len(parts)} fields: '{cron_expr}'"
        )
    return {
        "minute": parts[0],
        "hour": parts[1],
        "day": parts[2],
        "month": parts[3],
        "day_of_week": _normalize_dow(parts[4]),
    }


# Standard-cron → APScheduler named-day translation. Standard cron:
# 0/7 = Sun, 1 = Mon, ..., 6 = Sat. APScheduler accepts ``mon``, ``tue``,
# ..., ``sun`` and resolves them unambiguously regardless of its own
# Mon=0 internal numbering.
_DOW_NAMES = {
    "0": "sun", "1": "mon", "2": "tue", "3": "wed",
    "4": "thu", "5": "fri", "6": "sat", "7": "sun",
}


def _normalize_dow(field: str) -> str:
    """Rewrite numeric day-of-week tokens to APScheduler-safe names.

    Handles single values, comma lists, and ``A-B`` ranges. Leaves the
    ``*``, ``?``, step (``*/N``), and already-named tokens untouched.
    """
    field = field.strip()
    if not field or field in ("*", "?"):
        return field

    def _name(tok: str) -> str:
        tok = tok.strip().lower()
        return _DOW_NAMES.get(tok, tok)

    out_parts = []
    for piece in field.split(","):
        piece = piece.strip()
        # Step expression like ``*/2`` or ``mon/2`` — leave as-is.
        if "/" in piece:
            out_parts.append(piece.lower())
            continue
        if "-" in piece:
            a, b = piece.split("-", 1)
            out_parts.append(f"{_name(a)}-{_name(b)}")
        else:
            out_parts.append(_name(piece))
    return ",".join(out_parts)


# ---------------------------------------------------------------------------
# Structured "every N <unit>" schedule support (Update 3 fix).
#
# Cron's ``*/N`` semantics restart at every period boundary (month, day,
# year), which produces alternating short / correct intervals for
# cadences like "every 5 days" or "every 3 weeks". For these custom
# cadences the routine carries a structured ``_schedule`` block inside
# its ``parameters`` JSON, and we trigger from that instead of the cron
# string. The cron field stays present for backward-compat / display.
#
# Schedule shape:
#   {"type": "interval", "unit": "hours|days|weeks|months|years",
#    "every": N, "hour": H, "minute": M}
# ---------------------------------------------------------------------------

_INTERVAL_UNITS = ("minutes", "hours", "days", "weeks", "months", "years")


def _local_tz():
    if get_localzone is None:
        return None
    try:
        return get_localzone()
    except Exception:
        return None


def _extract_schedule(parameters: Any) -> Optional[dict]:
    """Pull the optional ``_schedule`` block out of a routine's parameters."""
    if parameters is None:
        return None
    if isinstance(parameters, str):
        try:
            parameters = json.loads(parameters)
        except (json.JSONDecodeError, TypeError):
            return None
    if not isinstance(parameters, dict):
        return None
    sched = parameters.get("_schedule")
    if not isinstance(sched, dict):
        return None
    if sched.get("type") != "interval":
        return None
    unit = sched.get("unit")
    every = sched.get("every")
    if unit not in _INTERVAL_UNITS:
        return None
    try:
        every = int(every)
    except (TypeError, ValueError):
        return None
    if every < 1:
        return None
    hour = int(sched.get("hour", 0) or 0)
    minute = int(sched.get("minute", 0) or 0)
    return {"unit": unit, "every": every, "hour": hour, "minute": minute}


class _CalendarIntervalTrigger(BaseTrigger):
    """APScheduler trigger that advances by N months or N years.

    Used for custom cadences cron cannot express cleanly
    (e.g. "every 5 months", "every 2 years").
    """

    __slots__ = ("unit", "every", "hour", "minute", "timezone")

    def __init__(self, *, unit: str, every: int, hour: int, minute: int, timezone) -> None:
        if unit not in ("months", "years"):
            raise ValueError(f"_CalendarIntervalTrigger: unsupported unit {unit!r}")
        self.unit = unit
        self.every = max(1, int(every))
        self.hour = int(hour)
        self.minute = int(minute)
        self.timezone = timezone

    def _anchor(self, now):
        return now.replace(hour=self.hour, minute=self.minute, second=0, microsecond=0)

    def get_next_fire_time(self, previous_fire_time, now):
        if self.timezone is not None:
            now_local = now.astimezone(self.timezone)
        else:
            now_local = now
        if previous_fire_time is not None:
            prev_local = previous_fire_time.astimezone(self.timezone) if self.timezone else previous_fire_time
            delta = relativedelta(months=self.every) if self.unit == "months" else relativedelta(years=self.every)
            cand = prev_local + delta
        else:
            cand = self._anchor(now_local)
            if cand <= now_local:
                # Bump forward until we pass now.
                step = relativedelta(months=self.every) if self.unit == "months" else relativedelta(years=self.every)
                while cand <= now_local:
                    cand = cand + step
        return cand


def _build_trigger(routine_dict: dict):
    """Return a (trigger, description) pair for a routine.

    Prefers the structured ``_schedule`` block if present; falls back to
    the legacy 5-field cron string otherwise.
    """
    sched = _extract_schedule(routine_dict.get("parameters"))
    tz = _local_tz()
    if sched is not None:
        unit = sched["unit"]
        every = sched["every"]
        hour = sched["hour"]
        minute = sched["minute"]
        if unit in ("minutes", "hours", "days", "weeks"):
            kwargs: dict = {}
            if unit == "minutes":
                kwargs["minutes"] = every
            elif unit == "hours":
                kwargs["hours"] = every
            elif unit == "days":
                kwargs["days"] = every
            else:
                kwargs["weeks"] = every
            # Anchor at today's H:M local; if that's already past, the
            # IntervalTrigger will pick the next slot relative to start_date.
            now = datetime.now(tz) if tz is not None else datetime.now()
            anchor = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if unit in ("minutes", "hours"):
                anchor = now.replace(minute=minute, second=0, microsecond=0)
            # If anchor is in the past, walk it forward by one period so
            # the first fire is in the future.
            step = timedelta(**kwargs)
            while anchor <= now:
                anchor = anchor + step
            return IntervalTrigger(start_date=anchor, timezone=tz, **kwargs), f"interval every {every} {unit}"
        # months / years
        return _CalendarIntervalTrigger(
            unit=unit, every=every, hour=hour, minute=minute, timezone=tz
        ), f"interval every {every} {unit}"
    # Legacy cron path.
    cron_kwargs = _parse_cron(routine_dict["schedule_cron"])
    return CronTrigger(**cron_kwargs), routine_dict["schedule_cron"]


class ResmonScheduler:
    """Wrapper around APScheduler's ``BackgroundScheduler``.

    The scheduler persists jobs to SQLite via the SQLAlchemy job store so
    routines survive application restarts.
    """

    def __init__(self, db_url: str | None = None) -> None:
        url = db_url or _DEFAULT_DB_URL
        jobstores = {"default": SQLAlchemyJobStore(url=url)}
        self._scheduler = BackgroundScheduler(jobstores=jobstores)
        self._running = False
        logger.info("ResmonScheduler initialized (job store: %s)", url)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the background scheduler."""
        if not self._running:
            self._scheduler.start(paused=False)
            self._running = True
            logger.info("Scheduler started.")

    def shutdown(self) -> None:
        """Gracefully shut down the scheduler, waiting for running jobs."""
        if self._running:
            self._scheduler.shutdown(wait=True)
            self._running = False
            logger.info("Scheduler shut down.")

    # ------------------------------------------------------------------
    # Routine management
    # ------------------------------------------------------------------

    def add_routine(self, routine_dict: dict) -> str:
        """Register a routine as a cron-triggered job.

        *routine_dict* must contain at least ``id``, ``name``,
        ``schedule_cron`` (5-field), and ``parameters`` (JSON string or
        dict).

        Returns the APScheduler job ID (string form of the routine id).
        """
        routine_id = str(routine_dict["id"])
        trigger, description = _build_trigger(routine_dict)

        # Ensure parameters is a string for storage
        params = routine_dict.get("parameters", "{}")
        if isinstance(params, dict):
            params = json.dumps(params)

        job = self._scheduler.add_job(
            _routine_callback,
            trigger=trigger,
            id=routine_id,
            name=routine_dict.get("name", f"routine-{routine_id}"),
            kwargs={"routine_id": int(routine_dict["id"]), "parameters": params},
            replace_existing=True,
            coalesce=True,
            misfire_grace_time=60,
        )
        logger.info("Routine added: id=%s, name=%s, schedule=%s",
                     routine_id, routine_dict.get("name"), description)
        return job.id

    def remove_routine(self, routine_id: int) -> None:
        """Remove a scheduled routine by its ID."""
        job_id = str(routine_id)
        try:
            self._scheduler.remove_job(job_id)
            logger.info("Routine removed: id=%s", job_id)
        except Exception:
            logger.warning("Routine not found for removal: id=%s", job_id)

    def update_routine(self, routine_id: int, routine_dict: dict) -> str:
        """Reschedule an existing routine with updated parameters.

        Internally removes the old job and adds a new one.
        """
        self.remove_routine(routine_id)
        routine_dict.setdefault("id", routine_id)
        return self.add_routine(routine_dict)

    def get_active_jobs(self) -> list[dict]:
        """Return a list of dicts describing all active scheduled jobs."""
        jobs = self._scheduler.get_jobs()
        result: list[dict] = []
        for job in jobs:
            result.append({
                "id": job.id,
                "name": job.name,
                "next_run_time": str(job.next_run_time) if job.next_run_time else None,
                "trigger": str(job.trigger),
            })
        return result


# ---------------------------------------------------------------------------
# Job callback — delegates to the installed dispatcher (IMPL-R3).
# ---------------------------------------------------------------------------

def _routine_callback(routine_id: int, parameters: str) -> None:
    """Execute a scheduled routine fire via the installed dispatcher.

    When no dispatcher is installed this logs an error and returns; the
    APScheduler worker thread must never raise out of a job.
    """
    if _dispatcher is None:
        logger.error(
            "Routine fire dropped — no dispatcher installed: routine_id=%d",
            routine_id,
        )
        return
    try:
        _dispatcher(routine_id, parameters)
    except Exception:
        logger.exception(
            "Dispatcher raised for routine_id=%d; fire is lost",
            routine_id,
        )