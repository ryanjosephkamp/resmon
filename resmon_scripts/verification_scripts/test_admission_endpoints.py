"""Tests for IMPL-R2: manual 429 guard on dive/sweep endpoints.

Covers the at-cap rejection path introduced in resmon.py:

    if not admission.try_admit(kind="manual"):
        raise HTTPException(429, ..., headers={"Retry-After": "5"})

and confirms that _launch_execution wraps the pipeline with
``note_admitted`` / ``note_finished`` so the slot releases after completion.
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


class TestManual429:
    """Second dive while at cap returns 429 with Retry-After and correct detail."""

    @patch("resmon.SweepEngine.run_prepared", _slow_run_prepared)
    def test_second_dive_rejected_at_cap(self, client):
        _fresh_admission(max_concurrent=1)
        _started.clear()

        resp1 = client.post(
            "/api/search/dive",
            json={"query": "test", "repository": "arxiv"},
        )
        assert resp1.status_code == 200

        # Wait until the background thread has called note_admitted so the
        # admission slot is observably taken before the second request.
        assert _started.wait(timeout=5.0), "pipeline thread did not start"
        # note_admitted runs at the top of _run(), before the progress emit
        # inside the patched pipeline, so it has definitely executed here.
        deadline = time.time() + 2.0
        while admission.current_active() < 1 and time.time() < deadline:
            time.sleep(0.01)
        assert admission.current_active() == 1

        resp2 = client.post(
            "/api/search/dive",
            json={"query": "other", "repository": "arxiv"},
        )
        assert resp2.status_code == HTTPStatus.TOO_MANY_REQUESTS
        assert resp2.headers.get("retry-after") == "5"
        body = resp2.json()
        assert "maximum of 1" in body["detail"]

        # Let the first execution finish and release the slot.
        deadline = time.time() + 5.0
        while admission.current_active() > 0 and time.time() < deadline:
            time.sleep(0.05)
        assert admission.current_active() == 0

    @patch("resmon.SweepEngine.run_prepared", _slow_run_prepared)
    def test_second_sweep_rejected_at_cap(self, client):
        _fresh_admission(max_concurrent=1)
        _started.clear()

        resp1 = client.post(
            "/api/search/sweep",
            json={"query": "test", "repositories": ["arxiv"]},
        )
        assert resp1.status_code == 200
        assert _started.wait(timeout=5.0)
        deadline = time.time() + 2.0
        while admission.current_active() < 1 and time.time() < deadline:
            time.sleep(0.01)

        resp2 = client.post(
            "/api/search/sweep",
            json={"query": "other", "repositories": ["arxiv"]},
        )
        assert resp2.status_code == HTTPStatus.TOO_MANY_REQUESTS
        assert resp2.headers.get("retry-after") == "5"
        assert "maximum of 1" in resp2.json()["detail"]

        deadline = time.time() + 5.0
        while admission.current_active() > 0 and time.time() < deadline:
            time.sleep(0.05)


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
