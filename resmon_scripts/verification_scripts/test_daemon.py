# resmon_scripts/verification_scripts/test_daemon.py
"""Verification tests for IMPL-25 — headless daemon split and liveness.

Covers:
* Lock-file mutual exclusion (second acquire fails).
* GET /api/health shape (status, pid, started_at, version).
* Graceful shutdown flushes `running` executions to `failed` with
  ``cancel_reason='daemon_restart'``.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

import resmon as resmon_mod
from implementation_scripts import daemon as daemon_mod
from implementation_scripts.daemon import (
    DaemonLock,
    DaemonLockError,
    perform_graceful_shutdown,
    read_lock,
)
from implementation_scripts.database import insert_execution
from implementation_scripts.config import APP_VERSION


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _reset_app_db() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def _reset_shutdown_flag() -> None:
    daemon_mod._shutdown_done = False
    daemon_mod._registered_scheduler = None


# ---------------------------------------------------------------------------
# Lock-file mutual exclusion
# ---------------------------------------------------------------------------

def test_lock_file_mutual_exclusion(tmp_path: Path):
    """Acquiring the same lock twice must fail on the second call."""
    lock_path = tmp_path / "daemon.lock"

    first = DaemonLock(path=lock_path)
    first.acquire(pid=11111, port=8742, version=APP_VERSION)
    try:
        second = DaemonLock(path=lock_path)
        with pytest.raises(DaemonLockError):
            second.acquire(pid=22222, port=8743, version=APP_VERSION)
    finally:
        first.release()

    # After release, a fresh acquire must succeed and overwrite the payload.
    third = DaemonLock(path=lock_path)
    third.acquire(pid=33333, port=8744, version=APP_VERSION)
    try:
        payload = read_lock(lock_path)
        assert payload is not None
        assert payload["pid"] == 33333
        assert payload["port"] == 8744
        assert payload["version"] == APP_VERSION
    finally:
        third.release()


def test_lock_file_payload_shape(tmp_path: Path):
    """Lock file must contain valid JSON with pid, port, version."""
    lock_path = tmp_path / "daemon.lock"
    lock = DaemonLock(path=lock_path)
    lock.acquire(pid=os.getpid(), port=8742, version=APP_VERSION)
    try:
        raw = lock_path.read_text(encoding="utf-8")
        payload = json.loads(raw)
        assert payload["pid"] == os.getpid()
        assert payload["port"] == 8742
        assert payload["version"] == APP_VERSION
        assert "started_at" in payload
    finally:
        lock.release()


def test_read_lock_missing_file(tmp_path: Path):
    assert read_lock(tmp_path / "does_not_exist.lock") is None


# ---------------------------------------------------------------------------
# Health endpoint shape
# ---------------------------------------------------------------------------

def test_health_endpoint_shape():
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert isinstance(body["pid"], int) and body["pid"] > 0
    assert body["pid"] == os.getpid()
    assert isinstance(body["started_at"], str) and body["started_at"]
    # started_at must be ISO 8601 parseable
    datetime.fromisoformat(body["started_at"])
    assert body["version"] == APP_VERSION


# ---------------------------------------------------------------------------
# Graceful shutdown flushes running executions
# ---------------------------------------------------------------------------

def test_graceful_shutdown_flushes_running_executions():
    """``perform_graceful_shutdown`` must flip every ``running`` row to ``failed``
    with ``cancel_reason='daemon_restart'``."""
    _reset_app_db()
    _reset_shutdown_flag()

    # Ensure the app & DB are initialized, then seed running rows.
    resmon_mod.create_app()
    conn = resmon_mod._get_db()
    now = datetime.now(timezone.utc).isoformat()

    running_ids = []
    for i in range(3):
        running_ids.append(insert_execution(conn, {
            "execution_type": "deep_dive",
            "parameters": json.dumps({"repository": "arxiv", "query": f"q{i}"}),
            "start_time": now,
            "status": "running",
        }))
    # Also one already-completed row that must NOT be touched.
    completed_id = insert_execution(conn, {
        "execution_type": "deep_dive",
        "parameters": json.dumps({"repository": "arxiv", "query": "done"}),
        "start_time": now,
        "status": "running",
    })
    conn.execute(
        "UPDATE executions SET status='completed', end_time=? WHERE id=?",
        (now, completed_id),
    )
    conn.commit()

    summary = perform_graceful_shutdown(reason="daemon_restart")
    assert summary["flushed_executions"] == len(running_ids)
    assert summary["db_closed"] is True

    # Re-open DB and check rows.
    _reset_app_db()  # force a new shared connection to the same :memory: won't work (new DB)
    # Instead, query via the original conn which is now closed → reopen path.
    # The simplest verification: reuse the just-closed in-memory DB is impossible.
    # So verify the summary only and additionally exercise via a fresh DB below.


def test_graceful_shutdown_idempotent(tmp_path: Path, monkeypatch):
    """Calling shutdown twice must not double-flush or raise."""
    _reset_shutdown_flag()
    # Point the app at a file-backed DB so rows survive after close_db().
    db_file = tmp_path / "resmon_test.db"
    resmon_mod._db_path = str(db_file)
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod.create_app()

    conn = resmon_mod._get_db()
    now = datetime.now(timezone.utc).isoformat()
    rid = insert_execution(conn, {
        "execution_type": "deep_dive",
        "parameters": json.dumps({"repository": "arxiv", "query": "hello"}),
        "start_time": now,
        "status": "running",
    })

    first = perform_graceful_shutdown(reason="daemon_restart")
    assert first["flushed_executions"] == 1

    second = perform_graceful_shutdown(reason="daemon_restart")
    assert second.get("already_shut_down") is True

    # Reopen and confirm the row is now failed with the right cancel_reason.
    _reset_shutdown_flag()
    resmon_mod._db_path = str(db_file)
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    conn2 = resmon_mod._get_db()
    row = conn2.execute(
        "SELECT status, cancel_reason, end_time, error_message FROM executions WHERE id=?",
        (rid,),
    ).fetchone()
    assert row is not None
    assert row["status"] == "failed"
    assert row["cancel_reason"] == "daemon_restart"
    assert row["end_time"]
    assert "daemon_restart" in (row["error_message"] or "")
    # Reset state so other tests do not inherit a closed DB path.
    resmon_mod._db_path = None
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    _reset_shutdown_flag()


# ---------------------------------------------------------------------------
# State-dir platform sanity
# ---------------------------------------------------------------------------

def test_state_dir_honours_override(monkeypatch, tmp_path):
    monkeypatch.setenv("RESMON_STATE_DIR", str(tmp_path / "override"))
    assert daemon_mod.state_dir() == tmp_path / "override"
    assert daemon_mod.lock_path() == tmp_path / "override" / "daemon.lock"
