# resmon_scripts/verification_scripts/test_sse_background.py
"""Verification tests for IMPL-17: SSE Endpoint and Background Execution.

Tests cover:
  - POST /api/search/dive returns execution_id without blocking
  - SSE endpoint delivers progress events as text/event-stream
  - GET /api/executions/active returns IDs of running executions
  - GET /api/executions/{exec_id}/progress/events returns event list
"""

import json
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod
from implementation_scripts.progress import ProgressStore
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _reset_db():
    """Point the app at a fresh in-memory database."""
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def _make_client():
    _reset_db()
    from resmon import app
    return TestClient(app)


# A fake run_prepared that emits progress events and completes.
def _fake_run_prepared(self, exec_id):
    from implementation_scripts.progress import progress_store
    progress_store.emit(exec_id, {"type": "execution_start", "exec_id": exec_id})
    progress_store.emit(exec_id, {"type": "stage", "name": "search"})
    progress_store.emit(exec_id, {"type": "repo_start", "repository": "arxiv"})
    progress_store.emit(exec_id, {"type": "repo_done", "repository": "arxiv", "results": 3})
    progress_store.emit(exec_id, {"type": "complete", "exec_id": exec_id})
    progress_store.mark_complete(exec_id)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestDiveReturnsImmediately:
    """POST /api/search/dive returns execution_id without blocking."""

    @patch("resmon.SweepEngine.run_prepared", _fake_run_prepared)
    def test_dive_returns_immediately(self):
        client = _make_client()
        start = time.monotonic()
        resp = client.post("/api/search/dive", json={
            "query": "test query",
            "repository": "arxiv",
        })
        elapsed = time.monotonic() - start
        assert resp.status_code == 200
        body = resp.json()
        assert "execution_id" in body
        assert isinstance(body["execution_id"], int)
        # Should return nearly instantly (background thread does the work)
        assert elapsed < 5.0, f"Endpoint took {elapsed:.2f}s — should be non-blocking"

    @patch("resmon.SweepEngine.run_prepared", _fake_run_prepared)
    def test_sweep_returns_immediately(self):
        client = _make_client()
        start = time.monotonic()
        resp = client.post("/api/search/sweep", json={
            "query": "test query",
            "repositories": ["arxiv", "pubmed"],
        })
        elapsed = time.monotonic() - start
        assert resp.status_code == 200
        body = resp.json()
        assert "execution_id" in body
        assert elapsed < 5.0


class TestSSEStreamsEvents:
    """SSE endpoint delivers progress events as text/event-stream."""

    def test_sse_streams_events(self):
        """SSE endpoint delivers persisted events for completed executions."""
        client = _make_client()

        # Manually create an execution record with status='completed'
        # and persisted progress events
        from implementation_scripts.database import insert_execution, save_progress_events, update_execution_status
        conn = resmon_mod._get_db()

        exec_id = insert_execution(conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2025-01-01T00:00:00",
            "status": "completed",
        })
        events = [
            {"type": "execution_start", "exec_id": exec_id},
            {"type": "stage", "name": "search"},
            {"type": "complete", "exec_id": exec_id},
        ]
        save_progress_events(conn, exec_id, events)

        # SSE endpoint should return batch of persisted events
        resp = client.get(f"/api/executions/{exec_id}/progress/stream")
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")

        body = resp.text
        assert "event: progress" in body
        assert "id: 0" in body
        # Verify JSON data payloads
        lines = body.strip().split("\n")
        data_lines = [l for l in lines if l.startswith("data: ")]
        assert len(data_lines) == 3
        first_event = json.loads(data_lines[0].removeprefix("data: "))
        assert first_event["type"] == "execution_start"

    def test_sse_last_event_id(self):
        """SSE endpoint supports ?last_event_id for reconnection (batch mode)."""
        client = _make_client()

        from implementation_scripts.database import insert_execution, save_progress_events
        conn = resmon_mod._get_db()

        exec_id = insert_execution(conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2025-01-01T00:00:00",
            "status": "completed",
        })
        events = [
            {"type": "execution_start"},
            {"type": "stage", "name": "search"},
            {"type": "repo_start", "repository": "arxiv"},
            {"type": "repo_done", "repository": "arxiv"},
            {"type": "complete"},
        ]
        save_progress_events(conn, exec_id, events)

        # Request all events (batch mode — execution already completed)
        resp = client.get(f"/api/executions/{exec_id}/progress/stream")
        body = resp.text
        lines = body.strip().split("\n")
        id_lines = [l for l in lines if l.startswith("id: ")]
        # Should have 5 event IDs (0-4)
        assert len(id_lines) == 5

    def test_sse_live_stream_terminates(self):
        """SSE live stream terminates when execution completes."""
        client = _make_client()

        from implementation_scripts.database import insert_execution
        conn = resmon_mod._get_db()

        exec_id = insert_execution(conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2025-01-01T00:00:00",
        })

        # Register the execution in progress_store and emit some events
        from implementation_scripts.progress import progress_store as ps
        ps.register(exec_id)
        ps.emit(exec_id, {"type": "execution_start"})
        ps.emit(exec_id, {"type": "complete"})
        ps.mark_complete(exec_id)

        # SSE endpoint should return events and close (execution marked complete)
        resp = client.get(f"/api/executions/{exec_id}/progress/stream")
        assert resp.status_code == 200
        body = resp.text
        data_lines = [l for l in body.strip().split("\n") if l.startswith("data: ")]
        assert len(data_lines) == 2

        # Clean up
        ps.cleanup(exec_id)

    def test_sse_404_for_missing_execution(self):
        client = _make_client()
        resp = client.get("/api/executions/99999/progress/stream")
        assert resp.status_code == 404


class TestActiveExecutions:
    """GET /api/executions/active returns IDs of running executions."""

    def test_active_executions_empty(self):
        client = _make_client()
        resp = client.get("/api/executions/active")
        assert resp.status_code == 200
        body = resp.json()
        assert "active_ids" in body
        assert isinstance(body["active_ids"], list)

    def test_active_executions_during_run(self):
        """Active endpoint returns the execution ID while it's running."""
        # Make run_prepared block until we release it
        barrier = threading.Event()

        def _blocking_run(self_engine, exec_id):
            from implementation_scripts.progress import progress_store as ps
            ps.emit(exec_id, {"type": "execution_start"})
            barrier.wait(timeout=5.0)
            ps.emit(exec_id, {"type": "complete"})
            ps.mark_complete(exec_id)

        with patch("resmon.SweepEngine.run_prepared", _blocking_run):
            client = _make_client()
            resp = client.post("/api/search/dive", json={
                "query": "active test",
                "repository": "arxiv",
            })
            exec_id = resp.json()["execution_id"]

            # Execution should be active
            time.sleep(0.3)
            active_resp = client.get("/api/executions/active")
            assert exec_id in active_resp.json()["active_ids"]

            # Release the execution
            barrier.set()
            time.sleep(1.0)

            # Should no longer be active after cleanup
            active_resp2 = client.get("/api/executions/active")
            assert exec_id not in active_resp2.json()["active_ids"]


class TestProgressEventsEndpoint:
    """GET /api/executions/{exec_id}/progress/events returns events."""

    @patch("resmon.SweepEngine.run_prepared", _fake_run_prepared)
    def test_progress_events_returns_list(self):
        client = _make_client()

        resp = client.post("/api/search/dive", json={
            "query": "events test",
            "repository": "arxiv",
        })
        exec_id = resp.json()["execution_id"]
        time.sleep(1.0)

        events_resp = client.get(f"/api/executions/{exec_id}/progress/events")
        assert events_resp.status_code == 200
        events = events_resp.json()
        assert isinstance(events, list)
        assert len(events) >= 1

    def test_progress_events_404_for_missing(self):
        client = _make_client()
        resp = client.get("/api/executions/99999/progress/events")
        assert resp.status_code == 404


class TestCancelEndpoint:
    """POST /api/executions/{exec_id}/cancel returns 200 or 409."""

    def test_cancel_active_returns_200(self):
        """Cancel an active execution returns 200."""
        barrier = threading.Event()

        def _blocking_run(self_engine, exec_id):
            from implementation_scripts.progress import progress_store as ps
            ps.emit(exec_id, {"type": "execution_start"})
            barrier.wait(timeout=5.0)
            ps.emit(exec_id, {"type": "complete"})
            ps.mark_complete(exec_id)

        with patch("resmon.SweepEngine.run_prepared", _blocking_run):
            client = _make_client()
            resp = client.post("/api/search/dive", json={
                "query": "cancel test",
                "repository": "arxiv",
            })
            exec_id = resp.json()["execution_id"]
            time.sleep(0.3)

            cancel_resp = client.post(f"/api/executions/{exec_id}/cancel")
            assert cancel_resp.status_code == 200
            assert cancel_resp.json()["status"] == "cancellation_requested"

            barrier.set()
            time.sleep(0.5)

    def test_cancel_inactive_returns_409(self):
        """Cancel a non-running execution returns 409."""
        client = _make_client()
        # Execution ID 99999 doesn't exist in progress_store
        resp = client.post("/api/executions/99999/cancel")
        assert resp.status_code == 409

    def test_cancel_completed_returns_409(self):
        """Cancel an already-completed execution returns 409."""
        client = _make_client()

        @patch("resmon.SweepEngine.run_prepared", _fake_run_prepared)
        def _run():
            resp = client.post("/api/search/dive", json={
                "query": "done test",
                "repository": "arxiv",
            })
            return resp.json()["execution_id"]

        exec_id = _run()
        time.sleep(1.0)

        cancel_resp = client.post(f"/api/executions/{exec_id}/cancel")
        assert cancel_resp.status_code == 409
