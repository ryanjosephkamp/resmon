"""The upload after each run says what happened, in the run's own log.

With Settings › Cloud Storage's *Upload each run's report* on, the engine
uploads a finished run's report and log to Google Drive. It runs after the
run's log has been written, and every line it logged used to go into the
logger's memory and never reach the file: a run whose upload was skipped
because Google Drive was not connected looked exactly like one whose upload
worked. These hold the log to what happened, with Google Drive replaced by
stand-ins: nothing here signs in to anything or uploads anything.
"""

from __future__ import annotations

import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import cloud_storage  # noqa: E402
from implementation_scripts.database import get_connection, init_db, set_setting  # noqa: E402
from implementation_scripts.logger import TaskLogger  # noqa: E402
from implementation_scripts.sweep_engine import SweepEngine  # noqa: E402


@pytest.fixture
def run(tmp_path):
    """A finished run's log and report, and an engine over a fresh database."""
    path = tmp_path / "corpus.db"
    init_db(path)
    conn = get_connection(path)
    log_path = tmp_path / "logs" / "log_7.txt"
    task_log = TaskLogger(log_path, operation_type="deep_dive", execution_id=7)
    task_log.log("The run's last line.")
    task_log.finalize(status="COMPLETED")
    report = tmp_path / "markdowns" / "report_7.md"
    report.parent.mkdir()
    report.write_text("# resmon Literature Report\n", encoding="utf-8")
    try:
        yield SweepEngine(db_conn=conn, config={"ai_enabled": False}), conn, task_log, report, log_path
    finally:
        conn.close()


def _uploads_started() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name.startswith("resmon-autobackup-")]


def test_append_reaches_a_log_that_has_already_been_written(tmp_path):
    log_path = tmp_path / "log.txt"
    task_log = TaskLogger(log_path, operation_type="deep_dive")
    task_log.log("before")
    task_log.finalize(status="COMPLETED")

    task_log.append("after")

    text = log_path.read_text(encoding="utf-8")
    assert "Status: COMPLETED" in text
    assert text.rstrip().endswith("after")
    assert text.index("Status: COMPLETED") < text.index("after")


def test_switched_off_it_writes_nothing_and_asks_nothing(run, monkeypatch):
    engine, conn, task_log, report, log_path = run
    asked: list[str] = []
    monkeypatch.setattr(cloud_storage, "is_token_stored", lambda: asked.append("token") or True)
    before = log_path.read_text(encoding="utf-8")

    engine._maybe_auto_backup(7, task_log, report, log_path)

    assert log_path.read_text(encoding="utf-8") == before
    assert asked == []


def test_not_connected_is_said_in_the_runs_log(run, monkeypatch):
    engine, conn, task_log, report, log_path = run
    set_setting(conn, "cloud_auto_backup", "true")
    monkeypatch.setattr(cloud_storage, "is_token_stored", lambda: False)
    monkeypatch.setattr(cloud_storage, "probe_api", lambda: pytest.fail("probed Google with nothing linked"))

    engine._maybe_auto_backup(7, task_log, report, log_path)

    assert "Auto-backup skipped: Google Drive is not connected." in log_path.read_text(encoding="utf-8")
    assert _uploads_started() == []


def test_a_link_google_refuses_is_said_with_its_reason(run, monkeypatch):
    engine, conn, task_log, report, log_path = run
    set_setting(conn, "cloud_auto_backup", "true")
    monkeypatch.setattr(cloud_storage, "is_token_stored", lambda: True)
    monkeypatch.setattr(cloud_storage, "probe_api", lambda: (False, "accessNotConfigured"))

    engine._maybe_auto_backup(7, task_log, report, log_path)

    assert ("Auto-backup skipped: Google Drive could not be used (accessNotConfigured)."
            in log_path.read_text(encoding="utf-8"))


def test_an_upload_says_it_started_and_what_it_uploaded(run, monkeypatch):
    engine, conn, task_log, report, log_path = run
    set_setting(conn, "cloud_auto_backup", "true")
    monkeypatch.setattr(cloud_storage, "is_token_stored", lambda: True)
    monkeypatch.setattr(cloud_storage, "probe_api", lambda: (True, None))
    sent: list[list[Path]] = []

    def upload(paths, base_dir, folder_name=None):
        sent.append([Path(p) for p in paths])
        return {"uploaded_ids": ["a", "b"], "total_files": 2, "folder_name": folder_name}

    monkeypatch.setattr(cloud_storage, "upload_paths", upload)

    engine._maybe_auto_backup(7, task_log, report, log_path)
    for thread in _uploads_started():
        thread.join(timeout=10)

    assert sent == [[report, log_path]], "it uploaded something other than this run's report and log"
    text = log_path.read_text(encoding="utf-8")
    assert "Auto-backup: uploading execution #7 artifacts to Google Drive..." in text
    assert "Auto-backup complete: uploaded 2/2 files to 'execution-7-" in text
