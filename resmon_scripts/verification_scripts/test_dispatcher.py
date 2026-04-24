"""IMPL-R6 — `_dispatch_routine_fire` unit-level coverage.

Invokes the dispatcher directly (no APScheduler) with ``SweepEngine.run_prepared``
patched to a fast stub, then asserts the DB side-effects and progress-store
events documented in `resmon_routines.md` Appendix A.1.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

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


def _make_routine(**overrides) -> int:
    conn = resmon_mod._get_db()
    body = {
        "name": overrides.get("name", "dispatcher-test"),
        "schedule_cron": overrides.get("schedule_cron", "0 8 * * *"),
        "parameters": overrides.get("parameters", '{"query":"x","repositories":[]}'),
        "is_active": overrides.get("is_active", 1),
        "email_enabled": 0,
        "email_ai_summary_enabled": 0,
        "ai_enabled": overrides.get("ai_enabled", 0),
        "ai_settings": overrides.get("ai_settings"),
        "storage_settings": None,
        "notify_on_complete": 0,
        "execution_location": "local",
    }
    return database.insert_routine(conn, body)


def _wait_for_exec_count(expected: int, timeout: float = 5.0) -> list[dict]:
    conn = resmon_mod._get_db()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rows = database.get_executions(conn)
        if len(rows) >= expected:
            # Wait a beat for status to settle after the thread finishes.
            time.sleep(0.05)
            return database.get_executions(conn)
        time.sleep(0.05)
    return database.get_executions(conn)


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_dispatch_creates_automated_sweep_execution_with_routine_id():
    _reset_state()
    rid = _make_routine(parameters='{"query":"q1","repositories":[]}')
    resmon_mod._dispatch_routine_fire(rid, '{"query":"q1","repositories":[]}')

    rows = _wait_for_exec_count(1)
    assert len(rows) == 1, rows
    row = rows[0]
    assert row["execution_type"] == "automated_sweep"
    assert int(row["routine_id"]) == rid


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_dispatch_emits_progress_events():
    _reset_state()
    rid = _make_routine(parameters='{"query":"q2","repositories":[]}')

    captured: list[list[dict]] = []
    original_cleanup = progress_store.cleanup

    def _capture_then_cleanup(exec_id: int) -> None:
        captured.append(list(progress_store.get_events(exec_id)))
        original_cleanup(exec_id)

    with patch.object(progress_store, "cleanup", side_effect=_capture_then_cleanup):
        resmon_mod._dispatch_routine_fire(rid, '{"query":"q2","repositories":[]}')
        _wait_for_exec_count(1)
        # Give the _launch_execution thread time to hit its finally block.
        deadline = time.monotonic() + 5.0
        while not captured and time.monotonic() < deadline:
            time.sleep(0.05)

    assert captured, "progress_store.cleanup was never called"
    events = captured[0]
    types = [e.get("type") for e in events]
    assert "execution_start" in types
    assert "execution_complete" in types


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_dispatch_stamps_last_executed_at():
    _reset_state()
    rid = _make_routine(parameters='{"query":"q3","repositories":[]}')
    resmon_mod._dispatch_routine_fire(rid, '{"query":"q3","repositories":[]}')
    _wait_for_exec_count(1)

    conn = resmon_mod._get_db()
    row = database.get_routine_by_id(conn, rid)
    assert row is not None
    assert row.get("last_executed_at"), "last_executed_at was not stamped"


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_dispatch_noop_when_routine_inactive():
    _reset_state()
    rid = _make_routine(
        is_active=0, parameters='{"query":"q4","repositories":[]}',
    )
    resmon_mod._dispatch_routine_fire(rid, '{"query":"q4","repositories":[]}')

    # No background thread spawned — wait briefly, then confirm zero rows.
    time.sleep(0.2)
    conn = resmon_mod._get_db()
    rows = database.get_executions(conn)
    assert rows == [], rows


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_dispatch_noop_when_routine_missing():
    _reset_state()
    # Invoke with a routine id that was never inserted.
    resmon_mod._dispatch_routine_fire(999999, "{}")

    time.sleep(0.2)
    conn = resmon_mod._get_db()
    rows = database.get_executions(conn)
    assert rows == [], rows
