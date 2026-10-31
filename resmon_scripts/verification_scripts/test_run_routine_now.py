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
    # A test that installed the real drain takes it out again, so a queue
    # another file fills is not drained into this file's routines.
    admission.set_dispatcher(None)
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


class _Busy:
    """resmon at its run limit: every slot held by runs outside the test.

    ``set_max`` clamps to a floor of one, so the limit is reached by holding
    that one slot with an id no execution in the test has.
    """

    HELD = 999_999

    def __init__(self, queue_limit: int = 16) -> None:
        admission.set_max(1)
        admission.set_queue_limit(queue_limit)
        with admission._lock:
            admission._active.add(self.HELD)

    def finish(self) -> None:
        """The held run ends: the slot frees and the queue drains, as it does in production."""
        admission.note_finished(self.HELD)


def _wait_for(predicate, timeout: float = 10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    return predicate()


def _runs_of(rid: int) -> list:
    conn = resmon_mod._get_db()
    return conn.execute("SELECT id FROM executions WHERE routine_id = ?", (rid,)).fetchall()


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_run_now_at_the_limit_is_queued_and_says_it_will_start_on_its_own(client):
    """The answer used to be a 409 telling the person to wait and try again,
    while the fire was in fact queued: trying again queued a second one."""
    rid = _make_routine(is_active=1)
    _Busy()
    resp = client.post(f"/api/routines/{rid}/run")

    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["execution_id"] is None
    assert body["queued"] is True and body["queue_position"] == 1
    assert body["detail"].startswith("resmon is already running 1 run, as many as it allows at once, so this one is queued.")
    assert "starts on its own" in body["detail"]
    assert "try again" not in body["detail"]
    assert _runs_of(rid) == []


def test_run_now_twice_while_queued_waits_once(client):
    rid = _make_routine(is_active=1)
    _Busy()
    assert client.post(f"/api/routines/{rid}/run").status_code == 202
    assert client.post(f"/api/routines/{rid}/run").json()["queue_position"] == 1
    assert admission.queue_depth() == 1


def test_run_now_with_the_queue_full_too_is_refused_and_says_it_was_not_queued(client):
    rid = _make_routine(is_active=1)
    other = _make_routine(is_active=1)
    _Busy(queue_limit=1)
    assert client.post(f"/api/routines/{other}/run").status_code == 202

    resp = client.post(f"/api/routines/{rid}/run")

    assert resp.status_code == 409
    assert "This run was not queued" in resp.json()["detail"]
    assert resp.headers["X-Resmon-Conflict"] == "admission_queue_full"
    assert admission.queue_depth() == 1


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_a_queued_run_now_starts_when_a_slot_frees_even_for_a_paused_routine(client):
    """The queue had no dispatcher in production, so a queued fire never ran.

    Startup installs it now; this drives the real one. A paused routine's
    queued Run now still runs, because a person asked for it, and stays paused.
    """
    resmon_mod._init_admission_on_startup()
    rid = _make_routine(is_active=0)
    busy = _Busy()
    assert client.post(f"/api/routines/{rid}/run").status_code == 202

    busy.finish()

    assert _wait_for(lambda: _runs_of(rid)), "the queued run never started"
    conn = resmon_mod._get_db()
    assert not bool(database.get_routine_by_id(conn, rid)["is_active"])


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_a_queued_scheduled_fire_of_a_paused_routine_does_not_run(client):
    """Pausing is how a person stops a routine running on its own; a fire that
    was queued before the pause must not run after it."""
    resmon_mod._init_admission_on_startup()
    rid = _make_routine(is_active=0)
    busy = _Busy()
    with admission._lock:
        admission._queue.clear()
    assert admission.admit_routine(rid, '{"query":"neural","repositories":[]}') == "queued"

    busy.finish()
    time.sleep(0.5)

    assert _runs_of(rid) == []


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
