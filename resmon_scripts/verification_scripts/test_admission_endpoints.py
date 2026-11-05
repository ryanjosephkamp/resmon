"""Manual runs past the run limit: queued in turn, refused only when the queue is full.

A Deep Dive or a Deep Sweep asked for while resmon runs as many runs as it
allows used to be refused with 429 and a sentence telling the person to try
again later. It now waits in the queue a watch's fire waits in, and starts on
its own when a slot frees: the answer is 202 with no execution id, ``queued``,
its place and a ticket. Only a full queue refuses it, with 429.

Also confirms that _launch_execution wraps the pipeline with
``note_admitted`` / ``note_finished`` so the slot releases after completion,
and that a queued run's slot is reserved for it while it starts.
"""

import sys
import threading
import time
from http import HTTPStatus
from pathlib import Path
from unittest.mock import patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod
from fastapi.testclient import TestClient
from implementation_scripts.admission import admission


def _reset_db():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def _fresh_admission(max_concurrent: int = 1, queue_limit: int = 16) -> None:
    admission.set_max(max_concurrent)
    admission.set_queue_limit(queue_limit)
    # Drain any leftover state from previous tests in the session.
    with admission._lock:
        admission._active.clear()
        admission._queue.clear()


@pytest.fixture
def client():
    _reset_db()
    from resmon import app
    tc = TestClient(app)
    yield tc
    # Restore defaults so later tests see a clean admission controller.
    _fresh_admission(max_concurrent=3, queue_limit=16)


# A pipeline stand-in that holds the slot for long enough that a second
# request arrives while the first is still "running".
_HOLD_SECONDS = 1.0
_started = threading.Event()


def _slow_run_prepared(self, exec_id: int) -> None:
    from implementation_scripts.progress import progress_store

    progress_store.emit(exec_id, {"type": "execution_start", "exec_id": exec_id})
    _started.set()
    time.sleep(_HOLD_SECONDS)
    progress_store.emit(exec_id, {"type": "complete", "exec_id": exec_id})
    progress_store.mark_complete(exec_id)


def _wait_for(condition, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(0.02)
    return condition()


class TestManualQueue:
    """A run asked for at the cap waits its turn, and starts on its own."""

    @patch("resmon.SweepEngine.run_prepared", _slow_run_prepared)
    def test_a_dive_at_the_cap_is_queued_and_starts_when_the_slot_frees(self, client):
        _fresh_admission(max_concurrent=1)
        _started.clear()

        resp1 = client.post(
            "/api/search/dive",
            json={"query": "test", "repository": "arxiv"},
        )
        assert resp1.status_code == 200
        first = resp1.json()["execution_id"]

        # Wait until the background thread has called note_admitted so the
        # admission slot is observably taken before the second request.
        assert _started.wait(timeout=5.0), "pipeline thread did not start"
        assert _wait_for(lambda: admission.current_active() == 1)

        resp2 = client.post(
            "/api/search/dive",
            json={"query": "other", "repository": "arxiv", "request_id": "second-dive"},
        )
        assert resp2.status_code == HTTPStatus.ACCEPTED
        body = resp2.json()
        assert list(body) == ["execution_id", "queued", "queue_position", "ticket", "detail"]
        assert body["execution_id"] is None
        assert body["queued"] is True and body["queue_position"] == 1
        # The ticket is the submission's own id, which the run's row carries once it starts.
        assert body["ticket"] == "second-dive"
        assert body["detail"] == (
            "resmon is already running 1 run, as many as it allows at once, so this Deep Dive waits. "
            "It starts on its own when a run finishes; there is nothing more to do.")

        # Asked again with the same id while it waits: the same entry, not a second one.
        again = client.post(
            "/api/search/dive",
            json={"query": "other", "repository": "arxiv", "request_id": "second-dive"},
        )
        assert again.status_code == HTTPStatus.ACCEPTED
        assert again.json()["duplicate"] is True and again.json()["ticket"] == "second-dive"
        assert admission.queue_depth() == 1

        # The queue, as the Runs tab reads it.
        waiting = client.get("/api/executions/active").json()["waiting"]
        assert [(w["kind"], w["ticket"], w["position"], w["execution_type"], w["query"], w["repositories"])
                for w in waiting] == [("manual", "second-dive", 1, "deep_dive", "other", ["arxiv"])]

        # The first run ends; the queued one starts on its own, as a row carrying its ticket.
        assert _wait_for(lambda: admission.queue_depth() == 0, 10.0)
        conn = resmon_mod._get_db()
        assert _wait_for(lambda: conn.execute(
            "SELECT COUNT(*) FROM executions WHERE request_id = 'second-dive'").fetchone()[0] == 1, 10.0)
        second = conn.execute("SELECT id FROM executions WHERE request_id = 'second-dive'").fetchone()[0]
        assert second > first
        # The same submission once more: it is the run it became.
        later = client.post(
            "/api/search/dive",
            json={"query": "other", "repository": "arxiv", "request_id": "second-dive"},
        )
        assert later.status_code == 200 and later.json() == {"execution_id": second, "duplicate": True}
        assert _wait_for(lambda: admission.current_active() == 0, 10.0)

    @patch("resmon.SweepEngine.run_prepared", _slow_run_prepared)
    def test_a_sweep_is_refused_only_when_the_queue_is_full(self, client):
        _fresh_admission(max_concurrent=1, queue_limit=1)
        _started.clear()

        resp1 = client.post(
            "/api/search/sweep",
            json={"query": "test", "repositories": ["arxiv"]},
        )
        assert resp1.status_code == 200
        assert _started.wait(timeout=5.0)
        assert _wait_for(lambda: admission.current_active() == 1)

        queued = client.post(
            "/api/search/sweep",
            json={"query": "second", "repositories": ["arxiv"]},
        )
        assert queued.status_code == HTTPStatus.ACCEPTED
        # No request id was sent: the engine names it.
        assert len(queued.json()["ticket"]) == 32

        refused = client.post(
            "/api/search/sweep",
            json={"query": "third", "repositories": ["arxiv"]},
        )
        assert refused.status_code == HTTPStatus.TOO_MANY_REQUESTS
        assert refused.headers.get("retry-after") == "5"
        assert refused.headers.get("x-resmon-conflict") == "admission_queue_full"
        assert refused.json()["detail"] == (
            "resmon is already running 1 run, as many as it allows at once, and 1 more are waiting, "
            "as many as it queues. This Deep Sweep was not queued; ask again once one of them has finished.")
        assert _wait_for(lambda: admission.current_active() == 0 and admission.queue_depth() == 0, 15.0)

    @patch("resmon.SweepEngine.run_prepared", _slow_run_prepared)
    def test_a_waiting_run_can_be_withdrawn_before_it_starts(self, client):
        _fresh_admission(max_concurrent=1)
        _started.clear()
        assert client.post("/api/search/dive", json={"query": "a", "repository": "arxiv"}).status_code == 200
        assert _started.wait(timeout=5.0)
        assert _wait_for(lambda: admission.current_active() == 1)
        ticket = client.post("/api/search/dive", json={"query": "b", "repository": "arxiv"}).json()["ticket"]

        withdrawn = client.delete(f"/api/executions/waiting/{ticket}")
        assert withdrawn.status_code == 200
        assert withdrawn.json() == {"withdrawn": True, "ticket": ticket}
        assert admission.queue_depth() == 0
        assert client.delete(f"/api/executions/waiting/{ticket}").status_code == 404
        assert _wait_for(lambda: admission.current_active() == 0, 10.0)
        conn = resmon_mod._get_db()
        assert conn.execute("SELECT COUNT(*) FROM executions").fetchone()[0] == 1, "the withdrawn run started"

    def test_a_watchs_fire_is_not_withdrawn_here(self, client):
        _fresh_admission(max_concurrent=1)
        with admission._lock:
            admission._active.add(999_999)
        try:
            assert admission.admit_routine(7, "{}") == "queued"
            ticket = admission.waiting()[0]["ticket"]
            refused = client.delete(f"/api/executions/waiting/{ticket}")
            assert refused.status_code == 409
            assert "Pause the watch" in refused.json()["detail"]
            assert admission.queue_depth() == 1
        finally:
            _fresh_admission(max_concurrent=3)


class TestSlotReleased:
    """After a run completes, the slot is released so the next dive admits."""

    @patch("resmon.SweepEngine.run_prepared", _slow_run_prepared)
    def test_sequential_dives_both_admit(self, client):
        _fresh_admission(max_concurrent=1)
        _started.clear()

        r1 = client.post(
            "/api/search/dive",
            json={"query": "first", "repository": "arxiv"},
        )
        assert r1.status_code == 200

        # Wait for the first run to complete and the slot to free.
        deadline = time.time() + 5.0
        while admission.current_active() > 0 and time.time() < deadline:
            time.sleep(0.05)
        assert admission.current_active() == 0

        _started.clear()
        r2 = client.post(
            "/api/search/dive",
            json={"query": "second", "repository": "arxiv"},
        )
        assert r2.status_code == 200
        assert _started.wait(timeout=5.0)

        deadline = time.time() + 5.0
        while admission.current_active() > 0 and time.time() < deadline:
            time.sleep(0.05)
        assert admission.current_active() == 0
