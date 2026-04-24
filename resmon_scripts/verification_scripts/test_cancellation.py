# resmon_scripts/verification_scripts/test_cancellation.py
"""Verification tests for IMPL-18: Execution Cancellation.

Tests cover:
  - POST /api/executions/{exec_id}/cancel returns 200 for active, 409 for inactive
  - Cooperative cancellation: pipeline stops at next checkpoint after cancel
"""

import json
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod
from implementation_scripts.progress import progress_store as _global_ps
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _reset_db():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def _make_client():
    _reset_db()
    from resmon import app
    return TestClient(app)


# ---------------------------------------------------------------------------
# Tests — Cancel Endpoint
# ---------------------------------------------------------------------------

class TestCancelEndpoint:
    """POST /api/executions/{exec_id}/cancel returns 200 or 409."""

    def test_cancel_active_execution(self):
        """Cancel returns 200 with cancellation_requested for active execution."""
        barrier = threading.Event()

        def _blocking_run(self_engine, exec_id):
            from implementation_scripts.progress import progress_store as ps
            ps.emit(exec_id, {"type": "execution_start"})
            barrier.wait(timeout=10.0)
            ps.emit(exec_id, {"type": "complete"})
            ps.mark_complete(exec_id)

        with patch("resmon.SweepEngine.run_prepared", _blocking_run):
            client = _make_client()
            resp = client.post("/api/search/dive", json={
                "query": "cancel test",
                "repository": "arxiv",
            })
            exec_id = resp.json()["execution_id"]

            # Give background thread time to start
            time.sleep(0.3)

            # Cancel should succeed
            cancel_resp = client.post(f"/api/executions/{exec_id}/cancel")
            assert cancel_resp.status_code == 200
            assert cancel_resp.json() == {"status": "cancellation_requested"}

            # Release the blocking run
            barrier.set()
            time.sleep(0.5)

    def test_cancel_inactive_execution(self):
        """Cancel returns 409 for execution that is not running."""
        client = _make_client()

        # Create a completed execution directly
        from implementation_scripts.database import insert_execution
        conn = resmon_mod._get_db()
        exec_id = insert_execution(conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2025-01-01T00:00:00",
            "status": "completed",
        })

        cancel_resp = client.post(f"/api/executions/{exec_id}/cancel")
        assert cancel_resp.status_code == 409

    def test_cancel_nonexistent_execution(self):
        """Cancel returns 409 for execution ID that doesn't exist in progress store."""
        client = _make_client()
        cancel_resp = client.post("/api/executions/99999/cancel")
        assert cancel_resp.status_code == 409


# ---------------------------------------------------------------------------
# Tests — Cooperative Cancellation
# ---------------------------------------------------------------------------

class TestCooperativeCancellation:
    """Pipeline stops at next checkpoint after cancel is requested."""

    def test_cooperative_cancellation(self):
        """Engine checks should_cancel and stops mid-pipeline."""
        cancel_after_start = threading.Event()
        run_finished = threading.Event()
        result_holder = {}

        def _slow_run(self_engine, exec_id):
            from implementation_scripts.progress import progress_store as ps
            ps.emit(exec_id, {"type": "execution_start"})
            # Signal that execution has started
            cancel_after_start.set()
            # Wait a bit for the cancel request to arrive
            time.sleep(0.5)
            # Now check cancellation (simulating a checkpoint)
            if ps.should_cancel(exec_id):
                ps.emit(exec_id, {"type": "cancelled"})
                ps.emit(exec_id, {"type": "complete", "status": "cancelled"})
                ps.mark_complete(exec_id)
                result_holder["cancelled"] = True
            else:
                ps.emit(exec_id, {"type": "complete", "status": "completed"})
                ps.mark_complete(exec_id)
                result_holder["cancelled"] = False
            run_finished.set()

        with patch("resmon.SweepEngine.run_prepared", _slow_run):
            client = _make_client()
            resp = client.post("/api/search/dive", json={
                "query": "coop cancel test",
                "repository": "arxiv",
            })
            exec_id = resp.json()["execution_id"]

            # Wait for execution to start
            cancel_after_start.wait(timeout=5.0)

            # Request cancellation
            cancel_resp = client.post(f"/api/executions/{exec_id}/cancel")
            assert cancel_resp.status_code == 200

            # Wait for the run to finish
            run_finished.wait(timeout=5.0)

            # Verify pipeline detected the cancellation
            assert result_holder.get("cancelled") is True

    def test_cancellation_flag_set_in_store(self):
        """request_cancel sets the flag that should_cancel reads."""
        from implementation_scripts.progress import ProgressStore
        store = ProgressStore()
        store.register(42)
        assert not store.should_cancel(42)
        store.request_cancel(42)
        assert store.should_cancel(42)
        store.cleanup(42)
