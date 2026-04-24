# resmon_scripts/verification_scripts/test_scheduler_email_cloud.py
"""Step 10 verification: scheduler, email notifier, and cloud storage."""

import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.database import init_db
from implementation_scripts.scheduler import ResmonScheduler
from implementation_scripts.email_notifier import compose_notification
from implementation_scripts.cloud_storage import check_connection


def test_scheduler_add_remove_routine():
    """A routine can be added to and removed from the scheduler."""
    scheduler = ResmonScheduler(db_url="sqlite:///:memory:")
    scheduler.start()
    try:
        job_id = scheduler.add_routine({
            "id": 1, "name": "Test Routine",
            "schedule_cron": "0 8 * * *",
            "parameters": '{"query": "test"}'
        })
        assert job_id is not None
        jobs = scheduler.get_active_jobs()
        assert len(jobs) >= 1
        scheduler.remove_routine(1)
    finally:
        scheduler.shutdown()


def test_email_composition():
    """compose_notification produces a valid MIME message."""
    execution_data = {
        "routine_name": "Test Routine",
        "start_time": "2026-04-15T08:00:00Z",
        "end_time": "2026-04-15T08:01:00Z",
        "status": "completed",
        "result_count": 10,
        "new_count": 8,
    }
    message = compose_notification(execution_data, ai_summary=None)
    assert "Test Routine" in message.as_string()
    assert "completed" in message.as_string().lower()


def test_cloud_check_disconnected():
    """check_connection returns False when no OAuth token is stored."""
    assert check_connection() is False
