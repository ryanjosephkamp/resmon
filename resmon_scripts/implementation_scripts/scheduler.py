# resmon_scripts/implementation_scripts/scheduler.py
"""APScheduler-based task scheduler for automated sweep routines."""

import json
import logging
from typing import Callable, Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.triggers.cron import CronTrigger

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
        "day_of_week": parts[4],
    }


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
        cron_kwargs = _parse_cron(routine_dict["schedule_cron"])

        # Ensure parameters is a string for storage
        params = routine_dict.get("parameters", "{}")
        if isinstance(params, dict):
            params = json.dumps(params)

        job = self._scheduler.add_job(
            _routine_callback,
            trigger=CronTrigger(**cron_kwargs),
            id=routine_id,
            name=routine_dict.get("name", f"routine-{routine_id}"),
            kwargs={"routine_id": int(routine_dict["id"]), "parameters": params},
            replace_existing=True,
            coalesce=True,
            misfire_grace_time=60,
        )
        logger.info("Routine added: id=%s, name=%s, cron=%s",
                     routine_id, routine_dict.get("name"), routine_dict["schedule_cron"])
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