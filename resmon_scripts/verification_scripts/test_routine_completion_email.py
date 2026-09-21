"""IMPL-R7 — the routine completion email, through the schema-21 queue.

The branch inside ``_launch_execution._run`` no longer sends anything: it
enqueues one ``deliveries`` row per enabled target and wakes the drain. What
this file has always claimed still holds and is still what is asserted --
``email_sender.send_routine_completion_email`` is called exactly once for a
routine with ``email_enabled`` truthy, never for one without it, never for a
manual dive, and a failure inside it never fails the execution -- with the
drain driven synchronously here rather than started as a thread, so the
assertions read the record rather than a sleep.

The one genuinely new claim is the last one: a failure is now *recorded*,
with a reason and a time to try again, where before it produced a log line
and nothing else.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database, delivery  # noqa: E402
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


def _configure_smtp() -> None:
    """Enough SMTP settings for the email adapter to get as far as sending.

    The adapter resolves the configuration itself now, so that "SMTP is not
    configured" reaches ``deliveries.last_error`` as a reason the user can act
    on instead of a log line. That makes these settings a precondition of the
    send, where before they lived inside the function under patch. The password
    goes to the keyring ``conftest`` installs in memory -- no credential
    reaches a table or a setting (B12).
    """
    conn = resmon_mod._get_db()
    database.set_setting(conn, "smtp_server", "127.0.0.1")
    database.set_setting(conn, "smtp_port", "2525")
    database.set_setting(conn, "smtp_username", "resmon@example.org")
    database.set_setting(conn, "smtp_to", "reader@example.org")
    from implementation_scripts.credential_manager import store_credential
    store_credential("smtp_password", "not-a-real-password")


def _drain() -> int:
    """Run the delivery drain to exhaustion on this thread. Returns attempts."""
    conn = resmon_mod._get_db()
    return delivery.DeliveryQueue(lambda: conn).drain(conn)


def _deliveries() -> list:
    conn = resmon_mod._get_db()
    return [dict(r) for r in conn.execute("SELECT * FROM deliveries ORDER BY id")]


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
    _configure_smtp()
    rid = _make_routine(email_enabled=1, email_ai_summary_enabled=1)
    resmon_mod._dispatch_routine_fire(rid, '{"query":"x","repositories":[]}')

    conn = resmon_mod._get_db()
    rows = database.get_executions(conn)
    assert len(rows) == 1
    exec_id = rows[0]["id"]
    _wait_for_completion(exec_id)

    queued = _deliveries()
    assert len(queued) == 1, queued
    assert queued[0]["channel"] == "email"
    assert queued[0]["state"] == "queued"
    assert _drain() == 1

    assert mock_send.call_count == 1, mock_send.call_args_list
    kwargs = mock_send.call_args.kwargs
    # "AI Summary in Email" was redefined as "Results in Email": the routine
    # flag ``email_ai_summary_enabled`` now attaches the execution results
    # .zip rather than inlining an AI summary in the body, and resmon.py
    # passes ``include_ai_summary=False`` accordingly. This assertion still
    # expected the old behavior and so failed against correct code.
    assert kwargs.get("include_ai_summary") is False
    assert kwargs.get("attachment_path"), (
        "email_ai_summary_enabled should attach the results bundle"
    )
    assert str(kwargs["attachment_path"]).endswith(".zip")
    assert kwargs["routine"]["id"] == rid
    assert int(kwargs["execution"]["routine_id"]) == rid

    delivered = _deliveries()[0]
    assert delivered["state"] == "delivered"
    assert delivered["attempts"] == 1
    assert delivered["last_error"] is None


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

    assert _drain() == 0
    assert _deliveries() == []
    assert mock_send.call_count == 0, mock_send.call_args_list


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch(
    "implementation_scripts.email_sender.send_routine_completion_email",
    side_effect=RuntimeError("smtp boom"),
)
def test_email_failure_does_not_fail_execution(mock_send):
    _reset_state()
    _configure_smtp()
    rid = _make_routine(email_enabled=1)
    resmon_mod._dispatch_routine_fire(rid, '{"query":"x","repositories":[]}')

    conn = resmon_mod._get_db()
    rows = database.get_executions(conn)
    assert len(rows) == 1
    exec_id = rows[0]["id"]
    _wait_for_completion(exec_id)

    final = database.get_execution_by_id(conn, exec_id)
    assert final["status"] == "completed"

    assert _drain() == 1
    assert mock_send.call_count == 1
    # The failure is recorded rather than lost: state, reason and a next
    # attempt, which is the whole point of schema 21.
    row = _deliveries()[0]
    assert row["state"] == "failed"
    assert "smtp boom" in row["last_error"]
    assert row["attempts"] == 1
    assert row["next_attempt_at_utc"] is not None


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

    assert _deliveries() == []
    assert mock_send.call_count == 0, mock_send.call_args_list
