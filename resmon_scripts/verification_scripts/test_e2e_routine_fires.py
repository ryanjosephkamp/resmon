"""IMPL-R6 — End-to-end routine fire via APScheduler.

Posts a routine via the REST API, replaces its schedule with a near-term
``DateTrigger`` so APScheduler fires within the polling window, then asserts
the resulting ``/api/executions`` row matches the expected shape.
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database  # noqa: E402
from implementation_scripts.admission import admission  # noqa: E402
from implementation_scripts.progress import progress_store  # noqa: E402


def _fast_run_prepared(self, exec_id: int) -> dict:
    progress_store.emit(exec_id, {"type": "execution_start", "execution_id": exec_id})
    progress_store.emit(exec_id, {"type": "execution_complete", "execution_id": exec_id})
    progress_store.mark_complete(exec_id)
    database.update_execution_status(self.db, exec_id, "completed")
    return {"execution_id": exec_id, "status": "completed"}


def _reset_state() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod.scheduler = None
    with admission._lock:
        admission._active.clear()
        admission._queue.clear()
    admission.set_max(3)
    admission.set_queue_limit(16)


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_routine_fires_end_to_end():
    _reset_state()
    from apscheduler.triggers.date import DateTrigger
    from resmon import app

    with TestClient(app) as client:
        resp = client.post(
            "/api/routines",
            json={
                "name": "e2e-fire",
                "schedule_cron": "0 8 * * *",
                "parameters": {"query": "e2e", "repositories": []},
                "is_active": True,
            },
        )
        assert resp.status_code == 201, resp.text
        rid = resp.json()["id"]

        # Replace the cron trigger with a near-term DateTrigger so APScheduler
        # fires it within the polling window, then force the scheduler to
        # pick up the imminent run time.
        sched = resmon_mod.scheduler
        assert sched is not None
        fire_at = datetime.now() + timedelta(seconds=2)
        sched._scheduler.reschedule_job(str(rid), trigger=DateTrigger(run_date=fire_at))
        sched._scheduler.wakeup()

        # Poll up to 10 s for an automated_sweep execution to appear.
        deadline = time.monotonic() + 10.0
        target_row = None
        while time.monotonic() < deadline:
            resp = client.get("/api/executions")
            assert resp.status_code == 200
            rows = resp.json()
            for row in rows:
                if (
                    row.get("execution_type") == "automated_sweep"
                    and int(row.get("routine_id") or -1) == rid
                    and row.get("status") in ("completed", "failed", "cancelled")
                ):
                    target_row = row
                    break
            if target_row is not None:
                break
            time.sleep(0.2)

        assert target_row is not None, "no automated_sweep execution appeared within 10s"
        assert target_row["execution_type"] == "automated_sweep"
        assert int(target_row["routine_id"]) == rid
        assert target_row["status"] == "completed"
