"""Tests for the ExecutionAdmissionController (IMPL-R1).

Covers:
    (a) manual admit under cap
    (b) manual reject at cap
    (c) routine enqueue when full
    (d) queue drain on note_finished
    (e) queue overflow drops with a log
    (f) set_max applies mid-flight
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
