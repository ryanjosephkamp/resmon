"""IMPL-R7 — routine completion email hook in `_launch_execution`.

Verifies the branch added inside ``_launch_execution._run``: when the
execution is ``automated_sweep`` with a ``routine_id`` and the routine has
``email_enabled`` truthy, ``email_sender.send_routine_completion_email``
is called exactly once. When ``email_enabled`` is falsy, it is never
called. Email failures must never fail the execution.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database  # noqa: E402
from implementation_scripts.admission import admission  # noqa: E402
from implementation_scripts.progress import progress_store  # noqa: E402


def _reset_state() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    with admission._lock:
        admission._active.clear()
        admission._queue.clear()
    admission.set_max(3)
    admission.set_queue_limit(16)


def _fast_run_prepared(self, exec_id: int) -> dict:
    progress_store.emit(exec_id, {"type": "execution_start", "execution_id": exec_id})
    progress_store.emit(exec_id, {"type": "execution_complete", "execution_id": exec_id})
    progress_store.mark_complete(exec_id)
    database.update_execution_status(self.db, exec_id, "completed")
    return {"execution_id": exec_id, "status": "completed"}


def _make_routine(*, email_enabled: int, email_ai_summary_enabled: int = 0) -> int:
    conn = resmon_mod._get_db()
    body = {
        "name": "email-hook-test",
        "schedule_cron": "0 8 * * *",
        "parameters": '{"query":"x","repositories":[]}',
        "is_active": 1,
        "email_enabled": email_enabled,
        "email_ai_summary_enabled": email_ai_summary_enabled,
        "ai_enabled": 0,
        "ai_settings": None,
        "storage_settings": None,
        "notify_on_complete": 0,
        "execution_location": "local",
    }
    return database.insert_routine(conn, body)


def _wait_for_completion(exec_id: int, timeout: float = 5.0) -> None:
    conn = resmon_mod._get_db()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = database.get_execution_by_id(conn, exec_id)
        if row and row.get("status") in ("completed", "failed", "cancelled"):
            # Allow the finally block to fully drain.
            time.sleep(0.1)
            return
        time.sleep(0.05)


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch("implementation_scripts.email_sender.send_routine_completion_email")
def test_email_sent_when_enabled(mock_send):
    _reset_state()
    rid = _make_routine(email_enabled=1, email_ai_summary_enabled=1)
    resmon_mod._dispatch_routine_fire(rid, '{"query":"x","repositories":[]}')

    conn = resmon_mod._get_db()
    rows = database.get_executions(conn)
    assert len(rows) == 1
    exec_id = rows[0]["id"]
    _wait_for_completion(exec_id)

    assert mock_send.call_count == 1, mock_send.call_args_list
    kwargs = mock_send.call_args.kwargs
    assert kwargs.get("include_ai_summary") is True
    assert kwargs["routine"]["id"] == rid
    assert int(kwargs["execution"]["routine_id"]) == rid


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch("implementation_scripts.email_sender.send_routine_completion_email")
def test_email_skipped_when_disabled(mock_send):
    _reset_state()
    rid = _make_routine(email_enabled=0)
    resmon_mod._dispatch_routine_fire(rid, '{"query":"x","repositories":[]}')

    conn = resmon_mod._get_db()
    rows = database.get_executions(conn)
    assert len(rows) == 1
    _wait_for_completion(rows[0]["id"])

    assert mock_send.call_count == 0, mock_send.call_args_list


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch(
    "implementation_scripts.email_sender.send_routine_completion_email",
    side_effect=RuntimeError("smtp boom"),
)
def test_email_failure_does_not_fail_execution(mock_send):
    _reset_state()
    rid = _make_routine(email_enabled=1)
    resmon_mod._dispatch_routine_fire(rid, '{"query":"x","repositories":[]}')

    conn = resmon_mod._get_db()
    rows = database.get_executions(conn)
    assert len(rows) == 1
    exec_id = rows[0]["id"]
    _wait_for_completion(exec_id)

    final = database.get_execution_by_id(conn, exec_id)
    assert final["status"] == "completed"
    assert mock_send.call_count == 1


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch("implementation_scripts.email_sender.send_routine_completion_email")
def test_email_skipped_for_manual_dive(mock_send):
    """Manual dive executions (no routine_id) never trigger the routine email."""
    _reset_state()
    conn = resmon_mod._get_db()
    from implementation_scripts.sweep_engine import SweepEngine

    engine = SweepEngine(
        db_conn=conn,
        config={"ai_enabled": False, "ai_settings": None},
    )
    exec_id = engine.prepare_execution("deep_dive", [], {"query": "x"})
    progress_store.register(exec_id)
    resmon_mod._launch_execution(engine, exec_id, conn)
    _wait_for_completion(exec_id)

    assert mock_send.call_count == 0, mock_send.call_args_list
