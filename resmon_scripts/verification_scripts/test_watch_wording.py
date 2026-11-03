"""A watch is called a watch wherever the engine writes a sentence for a person.

Identifiers, columns, API field names, and routes keep their stored names;
these tests hold only the words a person reads: a run's label on the source
wall, a notification's subject, an email, a run log's header, the Watchdog's
fallback names, and the sentences admission refuses with.
"""

from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import source_wall, watchdog  # noqa: E402
from implementation_scripts.admission import RoutineAlreadyRunning, RoutineFireWaiting  # noqa: E402
from implementation_scripts.database import init_db, insert_routine, record_missed_fire  # noqa: E402
from implementation_scripts.email_notifier import compose_notification  # noqa: E402
from implementation_scripts.logger import TaskLogger  # noqa: E402
import resmon as resmon_mod  # noqa: E402


def test_the_source_wall_labels_a_watch_runs_column_with_the_watch_name():
    row = {"execution_type": "automated_sweep", "routine_id": 4}
    assert source_wall._run_label(row, {4: "Graph neural networks"}) == "Watch — Graph neural networks"
    assert source_wall._run_label({"execution_type": "automated_sweep"}, {}) == "Watch"
    assert source_wall._run_label({"execution_type": "deep_sweep"}, {}) == "Deep Sweep"


def test_a_notification_for_a_watch_run_without_a_name_says_watch():
    body = resmon_mod._desktop_notification_body(
        sqlite3.connect(":memory:"),
        {"id": 1, "execution_type": "automated_sweep", "status": "failed"}, None)
    assert body.startswith("Watch failed;")


def test_an_email_for_a_watch_says_watch_and_names_an_unnamed_one_as_unknown():
    def body(message) -> str:
        return message.get_payload()[0].get_payload(decode=True).decode("utf-8")

    assert "Watch: Perovskites" in body(compose_notification({"routine_name": "Perovskites", "status": "completed"}))
    unnamed = body(compose_notification({"status": "completed"}))
    assert "Watch: Unknown watch" in unnamed and "Routine" not in unnamed


def test_a_run_log_header_says_watch_name(tmp_path):
    log = tmp_path / "run.log"
    TaskLogger(log, operation_type="automated_sweep", routine_name="Perovskites", execution_id=3).finalize(
        status="COMPLETED")
    header = log.read_text(encoding="utf-8")
    assert "Watch Name: Perovskites" in header and "Routine" not in header


def test_the_watchdog_names_an_unnamed_watch_as_a_watch():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn=conn)
    now = datetime(2026, 8, 20, 12, 0, 0, tzinfo=timezone.utc)
    routine_id = insert_routine(conn, {
        "name": "", "schedule_cron": "0 8 * * *", "parameters": "{}", "is_active": 1,
    })
    record_missed_fire(conn, routine_id, (now - timedelta(days=1)).isoformat(), disposition="skipped")
    routine = {"id": routine_id, "name": None, "is_active": 1}
    findings = watchdog._check_skipped_fires(conn, [routine], now)
    assert findings and findings[0]["scope"]["name"] == f"Watch {routine_id}"
    assert f"'Watch {routine_id}'" in findings[0]["title"]


@pytest.mark.parametrize("error,expected", [
    (RoutineAlreadyRunning(12, 40), "Watch 12 is already running as execution 40."),
    (RoutineAlreadyRunning(12, None), "Watch 12 is already running."),
    (RoutineFireWaiting(12, "queued"), "Watch 12 was queued, not started."),
])
def test_admission_refuses_in_a_sentence_that_says_watch(error, expected):
    assert str(error) == expected
