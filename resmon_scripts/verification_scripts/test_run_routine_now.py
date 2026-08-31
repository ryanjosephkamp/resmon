"""POST /api/routines/{id}/run — running a routine outside its schedule.

Writing the MCP contract found that resmon had no way to run a routine on
demand at all. That is a gap in the application, not only in the tool surface,
so the endpoint lands with the MCP server and is a thin wrapper over
``_dispatch_routine_fire`` -- the same function the scheduler calls -- so a
manual run and a scheduled fire cannot drift apart.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

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
    resmon_mod._get_db()
    with admission._lock:
        admission._active.clear()
        admission._queue.clear()
    admission.set_max(3)
    admission.set_queue_limit(16)


def _fast_run_prepared(self, exec_id: int) -> dict:
    progress_store.emit(exec_id, {"type": "execution_start", "execution_id": exec_id})
    progress_store.mark_complete(exec_id)
    database.update_execution_status(self.db, exec_id, "completed")
    return {"execution_id": exec_id, "status": "completed"}


def _make_routine(is_active: int = 1) -> int:
    conn = resmon_mod._get_db()
    return database.insert_routine(conn, {
        "name": "run-now-test",
        "schedule_cron": "0 8 * * *",
        "parameters": '{"query":"neural","repositories":[]}',
        "is_active": is_active,
        "email_enabled": 0,
        "email_ai_summary_enabled": 0,
        "ai_enabled": 0,
        "ai_settings": None,
        "storage_settings": None,
        "notify_on_complete": 0,
        "execution_location": "local",
    })


@pytest.fixture(autouse=True)
def _fresh():
    _reset_state()
    yield
    resmon_mod.close_db()


@pytest.fixture
def client():
    return TestClient(resmon_mod.app)


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_running_an_active_routine_creates_an_execution(client):
    rid = _make_routine(is_active=1)
    resp = client.post(f"/api/routines/{rid}/run")
    assert resp.status_code == 200
    body = resp.json()
    assert body["routine_id"] == rid
    assert body["was_inactive"] is False
    assert isinstance(body["execution_id"], int)


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_the_execution_is_stamped_with_its_routine(client):
    """A manual run must be attributable to the routine, like a scheduled one.

    This is what makes the run show up in routine health and the watchdog's
    per-routine history rather than looking like a stray manual sweep.
    """
    rid = _make_routine(is_active=1)
    exec_id = client.post(f"/api/routines/{rid}/run").json()["execution_id"]

    conn = resmon_mod._get_db()
    deadline = time.monotonic() + 5
    row = None
    while time.monotonic() < deadline:
        row = database.get_execution_by_id(conn, exec_id)
        if row:
            break
        time.sleep(0.05)
    assert row is not None
    assert int(row["routine_id"]) == rid
    assert row["execution_type"] == "automated_sweep"


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_an_inactive_routine_runs_and_the_response_says_so(client):
    """is_active governs scheduling, not permission.

    Refusing here would mean activating a routine, running it, and
    deactivating it again just to get one result.
    """
    rid = _make_routine(is_active=0)
    resp = client.post(f"/api/routines/{rid}/run")
    assert resp.status_code == 200
    body = resp.json()
    assert body["was_inactive"] is True
    assert "not scheduled" in body["detail"]
    assert isinstance(body["execution_id"], int)


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_running_an_inactive_routine_does_not_activate_it(client):
    """A one-off run must not quietly put the routine back on the schedule."""
    rid = _make_routine(is_active=0)
    client.post(f"/api/routines/{rid}/run")
    conn = resmon_mod._get_db()
    assert not bool(database.get_routine_by_id(conn, rid)["is_active"])


def test_a_missing_routine_is_a_404(client):
    resp = client.post("/api/routines/999999/run")
    assert resp.status_code == 404


def test_a_declined_admission_is_a_409_that_explains_itself(client):
    """Not a generic failure: the caller can act on "wait and retry".

    Driven by refusing admission directly rather than by filling the
    controller, because a routine admission *enqueues* when slots are busy and
    ``set_max`` clamps to a floor of one -- so there is no honest way to force
    a refusal from outside. What matters here is the endpoint's branch: when
    the dispatcher declines to start anything, the caller is told why.
    """
    rid = _make_routine(is_active=1)
    with patch.object(admission, "try_admit", return_value=False):
        resp = client.post(f"/api/routines/{rid}/run")
    assert resp.status_code == 409
    assert "already running" in resp.json()["detail"]


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_the_scheduler_path_still_skips_an_inactive_routine(client):
    """allow_inactive must not leak into scheduled fires.

    Deactivating is how a user stops a routine running on its own; if the
    dispatcher's default changed, that would silently stop working.
    """
    rid = _make_routine(is_active=0)
    assert resmon_mod._dispatch_routine_fire(
        rid, '{"query":"neural","repositories":[]}',
    ) is None
