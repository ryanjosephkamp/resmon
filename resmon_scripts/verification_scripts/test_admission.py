"""Tests for the ExecutionAdmissionController (IMPL-R1).

Covers:
    (a) manual admit under cap
    (b) manual reject at cap
    (c) routine enqueue when full
    (d) queue drain on note_finished
    (e) queue overflow drops with a log
    (f) set_max applies mid-flight
    (g) note_finished is idempotent, drain included
    (h) the slot survives a worker that dies before the pipeline's ``try``
"""

import logging
import sys
import threading
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.admission import ExecutionAdmissionController


def _fresh(max_concurrent=2, queue_limit=3):
    return ExecutionAdmissionController(max_concurrent=max_concurrent, queue_limit=queue_limit)


# ---------------------------------------------------------------------------
# (a) manual admit under cap
# ---------------------------------------------------------------------------

def test_manual_admit_under_cap():
    c = _fresh(max_concurrent=2)
    assert c.try_admit(kind="manual", exec_id=1) is True
    assert c.try_admit(kind="manual", exec_id=2) is True
    assert c.current_active() == 2


# ---------------------------------------------------------------------------
# (b) manual reject at cap
# ---------------------------------------------------------------------------

def test_manual_reject_at_cap():
    c = _fresh(max_concurrent=1)
    assert c.try_admit(kind="manual", exec_id=1) is True
    # At cap: manual attempts return False and do not enqueue.
    assert c.try_admit(kind="manual", exec_id=2) is False
    assert c.queue_depth() == 0
    assert c.current_active() == 1


# ---------------------------------------------------------------------------
# (c) routine enqueue when full
# ---------------------------------------------------------------------------

def test_routine_enqueues_when_full():
    c = _fresh(max_concurrent=1, queue_limit=3)
    assert c.try_admit(kind="manual", exec_id=10) is True
    # Routine cannot admit; it enqueues instead.
    assert c.try_admit(kind="routine", routine_id=77, params_json='{"q":"x"}') is False
    assert c.queue_depth() == 1
    assert c.try_admit(kind="routine", routine_id=78, params_json='{"q":"y"}') is False
    assert c.queue_depth() == 2


# ---------------------------------------------------------------------------
# (d) queue drain on note_finished
# ---------------------------------------------------------------------------

def test_queue_drains_on_note_finished():
    c = _fresh(max_concurrent=1, queue_limit=3)

    dispatched: list[tuple[int, str]] = []
    event = threading.Event()

    def dispatcher(routine_id: int, params_json: str) -> None:
        dispatched.append((routine_id, params_json))
        event.set()

    c.set_dispatcher(dispatcher)

    assert c.try_admit(kind="manual", exec_id=100) is True
    assert c.try_admit(kind="routine", routine_id=55, params_json="{}") is False
    assert c.queue_depth() == 1

    # Finishing the active execution should free a slot and dispatch the
    # queued routine fire on a daemon thread.
    c.note_finished(100)
    assert event.wait(timeout=2.0), "dispatcher was not invoked after note_finished"
    assert dispatched == [(55, "{}")]
    assert c.queue_depth() == 0


# ---------------------------------------------------------------------------
# (e) queue overflow drops with a log
# ---------------------------------------------------------------------------

def test_queue_overflow_drops_with_log(caplog):
    c = _fresh(max_concurrent=1, queue_limit=2)
    assert c.try_admit(kind="manual", exec_id=1) is True
    # Fill the queue to capacity.
    assert c.try_admit(kind="routine", routine_id=1, params_json="{}") is False
    assert c.try_admit(kind="routine", routine_id=2, params_json="{}") is False
    assert c.queue_depth() == 2

    with caplog.at_level(logging.WARNING, logger="implementation_scripts.admission"):
        # This one overflows.
        result = c.try_admit(kind="routine", routine_id=999, params_json="{}")

    assert result is False
    assert c.queue_depth() == 2, "overflowed fire must not be enqueued"
    assert any(
        "overflow" in rec.getMessage().lower() and "999" in rec.getMessage()
        for rec in caplog.records
        if rec.levelno == logging.WARNING
    ), "expected a WARNING log mentioning overflow and routine_id=999"


# ---------------------------------------------------------------------------
# (f) set_max applies mid-flight
# ---------------------------------------------------------------------------

def test_set_max_applies_mid_flight():
    c = _fresh(max_concurrent=1, queue_limit=4)
    assert c.try_admit(kind="manual", exec_id=1) is True
    # At cap: another manual is rejected.
    assert c.try_admit(kind="manual", exec_id=2) is False

    # Grow the cap — the next manual should admit without waiting.
    c.set_max(3)
    assert c.try_admit(kind="manual", exec_id=2) is True
    assert c.try_admit(kind="manual", exec_id=3) is True
    assert c.current_active() == 3

    # Shrink the cap below current active: new admits are rejected until
    # enough finishes happen.
    c.set_max(2)
    assert c.try_admit(kind="manual", exec_id=4) is False
    c.note_finished(1)
    # Still at 2 active (ids 2 and 3) — new admit still rejected.
    assert c.try_admit(kind="manual", exec_id=4) is False
    c.note_finished(2)
    # Now only exec_id=3 active; new admit succeeds.
    assert c.try_admit(kind="manual", exec_id=4) is True


# ---------------------------------------------------------------------------
# Drain-queue: synchronous helper is also exercised by the dispatcher path.
# ---------------------------------------------------------------------------

def test_drain_queue_runs_all_available_slots():
    c = _fresh(max_concurrent=2, queue_limit=4)
    # Pre-seed the queue by filling active and enqueuing.
    c.try_admit(kind="manual", exec_id=1)
    c.try_admit(kind="manual", exec_id=2)
    c.try_admit(kind="routine", routine_id=10, params_json="a")
    c.try_admit(kind="routine", routine_id=11, params_json="b")
    assert c.queue_depth() == 2

    dispatched: list[int] = []
    lock = threading.Lock()
    ready = threading.Event()

    def dispatcher(routine_id: int, params_json: str) -> None:
        with lock:
            dispatched.append(routine_id)
            if len(dispatched) == 2:
                ready.set()

    # Free both active slots then drain.
    c.note_finished(1)
    c.note_finished(2)
    c.drain_queue(dispatcher)

    # One of the two fires may have been dispatched by note_finished; the rest
    # by drain_queue. Either way, both should land within the timeout.
    assert ready.wait(timeout=2.0) or len(dispatched) >= 1
    # Give the second dispatcher a brief grace period if drain raced ahead.
    deadline = time.time() + 2.0
    while len(dispatched) < 2 and time.time() < deadline:
        time.sleep(0.01)
    assert sorted(dispatched) == [10, 11]


# ---------------------------------------------------------------------------
# (g) note_finished is idempotent, drain included
# ---------------------------------------------------------------------------

def test_note_finished_is_idempotent_and_drains_once():
    """A second release of the same id must not hand out a second fire.

    The execution worker now calls ``note_finished`` from two nested
    ``finally`` blocks, so the ordinary path calls it twice for one execution.
    Releasing the slot twice was always harmless; draining twice was not, and
    this is the case that says so: the queued fire dispatched by the first call
    has not reached its own ``note_admitted`` yet, so the naive check "queue
    non-empty and active below cap" is still true on the second call.
    """
    c = _fresh(max_concurrent=1, queue_limit=4)

    dispatched: list[int] = []
    lock = threading.Lock()
    first = threading.Event()

    def dispatcher(routine_id: int, params_json: str) -> None:
        with lock:
            dispatched.append(routine_id)
        first.set()

    c.set_dispatcher(dispatcher)
    assert c.try_admit(kind="manual", exec_id=500) is True
    assert c.try_admit(kind="routine", routine_id=60, params_json="{}") is False
    assert c.try_admit(kind="routine", routine_id=61, params_json="{}") is False
    assert c.queue_depth() == 2

    c.note_finished(500)
    assert first.wait(timeout=2.0), "first release did not dispatch"
    # The dispatched fire never calls note_admitted here, so the active count
    # stays at zero -- exactly the state that made the second call dangerous.
    c.note_finished(500)
    c.note_finished(500)

    deadline = time.time() + 1.0
    while time.time() < deadline:
        with lock:
            if len(dispatched) > 1:
                break
        time.sleep(0.01)
    with lock:
        assert dispatched == [60], "one freed slot dispatched more than one fire"
    assert c.queue_depth() == 1
    assert c.current_active() == 0


# ---------------------------------------------------------------------------
# (h) the slot survives a worker that dies before the pipeline's ``try``
# ---------------------------------------------------------------------------
#
# The reviewer of PR #141 found this by mutation: delete the worker's outer
# release and a thread that dies between ``note_admitted`` and the pipeline's
# ``try`` holds the global slot for the life of the backend. At the shipped cap
# of 3 that is three dead threads away from every Deep Dive and Deep Sweep
# answering 429 with nothing running. Two statements sit in that window --
# ``_start_execution_heartbeat`` and ``_get_db`` -- and both are exercised here
# against the real endpoint over a real database, because the property is about
# what the *next* request is told, not about what the controller counts.

import pytest  # noqa: E402  (test-local; the module above needs no fixtures)


def _reset_admission_state() -> None:
    from implementation_scripts.admission import admission

    admission.set_max(1)
    admission.set_queue_limit(16)
    with admission._lock:
        admission._active.clear()
        admission._queue.clear()


@pytest.fixture
def slot_leak_client():
    import resmon as resmon_mod
    from fastapi.testclient import TestClient
    from implementation_scripts.admission import admission

    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    _reset_admission_state()
    with TestClient(resmon_mod.app) as tc:
        yield tc
    admission.set_max(3)
    admission.set_queue_limit(16)
    with admission._lock:
        admission._active.clear()
        admission._queue.clear()


def _await_idle(timeout: float = 5.0) -> int:
    from implementation_scripts.admission import admission

    deadline = time.time() + timeout
    while admission.current_active() > 0 and time.time() < deadline:
        time.sleep(0.02)
    return admission.current_active()


@pytest.mark.parametrize("victim", ["_start_execution_heartbeat", "_get_db"])
def test_worker_dying_before_the_pipeline_try_releases_the_slot(
    slot_leak_client, monkeypatch, victim
):
    """Both pre-``try`` statements, injected for real, leave the cap intact.

    ``_get_db`` is failed only on the execution worker's own thread: the
    request thread calls the same function, and breaking it everywhere would
    test the endpoint's error handling instead of the worker's ``finally``.
    """
    import resmon as resmon_mod
    from implementation_scripts.admission import admission

    original = getattr(resmon_mod, victim)

    def _boom(*args, **kwargs):
        if threading.current_thread().name.startswith("exec-"):
            raise RuntimeError(f"injected failure in {victim}")
        return original(*args, **kwargs)

    monkeypatch.setattr(resmon_mod, victim, _boom)

    first = slot_leak_client.post(
        "/api/search/sweep",
        json={"query": "slot leak", "repositories": ["arxiv"]},
    )
    assert first.status_code == 200, first.text

    assert _await_idle() == 0, (
        f"a worker that died in {victim} left the admission slot taken"
    )

    monkeypatch.setattr(resmon_mod, victim, original)
    second = slot_leak_client.post(
        "/api/search/sweep",
        json={"query": "after the leak", "repositories": ["arxiv"]},
    )
    assert second.status_code == 200, (
        f"the run after a worker died in {victim} was refused: {second.text}"
    )
    _await_idle()
