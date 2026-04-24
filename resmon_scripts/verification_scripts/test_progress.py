# resmon_scripts/verification_scripts/test_progress.py
"""Verification tests for IMPL-16: Backend Progress Infrastructure.

Tests cover:
  - ProgressStore thread-safety under concurrent access
  - ProgressStore event emission, retrieval, lifecycle
  - Cooperative cancellation via threading.Event
  - SweepEngine two-phase execution (prepare + run_prepared)
  - SweepEngine progress event emission (all 14 event types)
  - Database progress_events and current_stage columns
"""

import json
import sqlite3
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.progress import ProgressStore, progress_store
from implementation_scripts.database import (
    init_db,
    insert_execution,
    get_execution_by_id,
    save_progress_events,
    get_progress_events,
    update_current_stage,
)
from implementation_scripts.sweep_engine import SweepEngine


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def store():
    """Return a fresh ProgressStore instance for each test."""
    return ProgressStore()


@pytest.fixture
def db_conn(tmp_path):
    """Return an in-memory SQLite connection with schema applied."""
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    init_db(conn=conn)
    return conn


# ---------------------------------------------------------------------------
# ProgressStore — basic operations
# ---------------------------------------------------------------------------

class TestProgressStoreBasic:

    def test_register_and_is_active(self, store):
        store.register(1)
        assert store.is_active(1)
        assert store.get_active_ids() == [1]

    def test_emit_and_get_events(self, store):
        store.register(1)
        store.emit(1, {"type": "execution_start", "ts": "t0"})
        store.emit(1, {"type": "stage", "ts": "t1"})
        events = store.get_events(1)
        assert len(events) == 2
        assert events[0]["type"] == "execution_start"

    def test_get_events_since(self, store):
        store.register(1)
        for i in range(5):
            store.emit(1, {"type": "event", "index": i})
        tail = store.get_events(1, since=3)
        assert len(tail) == 2
        assert tail[0]["index"] == 3

    def test_mark_complete(self, store):
        store.register(1)
        store.emit(1, {"type": "start"})
        assert store.is_active(1)
        store.mark_complete(1)
        assert not store.is_active(1)
        assert store.get_active_ids() == []

    def test_cleanup(self, store):
        store.register(1)
        store.emit(1, {"type": "x"})
        store.mark_complete(1)
        store.cleanup(1)
        assert not store.is_active(1)
        assert store.get_events(1) == []
        assert store.get_active_ids() == []

    def test_multiple_executions(self, store):
        store.register(10)
        store.register(20)
        store.emit(10, {"type": "a"})
        store.emit(20, {"type": "b"})
        assert len(store.get_events(10)) == 1
        assert len(store.get_events(20)) == 1
        assert sorted(store.get_active_ids()) == [10, 20]


# ---------------------------------------------------------------------------
# ProgressStore — cancellation
# ---------------------------------------------------------------------------

class TestProgressStoreCancellation:

    def test_should_cancel_default_false(self, store):
        store.register(1)
        assert not store.should_cancel(1)

    def test_request_cancel_sets_flag(self, store):
        store.register(1)
        store.request_cancel(1)
        assert store.should_cancel(1)

    def test_cancel_unregistered_is_noop(self, store):
        # Should not raise
        store.request_cancel(999)
        assert not store.should_cancel(999)


# ---------------------------------------------------------------------------
# ProgressStore — thread safety
# ---------------------------------------------------------------------------

class TestProgressStoreThreadSafety:

    def test_concurrent_emit(self, store):
        """Multiple threads emit events concurrently; all events are recorded."""
        store.register(1)
        n_threads = 10
        events_per_thread = 100
        barrier = threading.Barrier(n_threads)

        def writer(thread_id):
            barrier.wait()
            for i in range(events_per_thread):
                store.emit(1, {"thread": thread_id, "seq": i})

        threads = [threading.Thread(target=writer, args=(t,)) for t in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        all_events = store.get_events(1)
        assert len(all_events) == n_threads * events_per_thread

    def test_concurrent_emit_and_read(self, store):
        """One thread writes while another reads; no race conditions."""
        store.register(1)
        stop = threading.Event()
        read_counts = []

        def writer():
            for i in range(200):
                store.emit(1, {"seq": i})
                time.sleep(0.0001)
            stop.set()

        def reader():
            cursor = 0
            while not stop.is_set():
                events = store.get_events(1, since=cursor)
                cursor += len(events)
                read_counts.append(cursor)
                time.sleep(0.0005)
            # Final read
            events = store.get_events(1, since=cursor)
            read_counts.append(cursor + len(events))

        w = threading.Thread(target=writer)
        r = threading.Thread(target=reader)
        w.start()
        r.start()
        w.join()
        r.join()

        assert store.get_events(1).__len__() == 200
        # Reader should have caught up
        assert read_counts[-1] == 200


# ---------------------------------------------------------------------------
# Database — progress columns and CRUD
# ---------------------------------------------------------------------------

class TestDatabaseProgress:

    def test_progress_events_column_exists(self, db_conn):
        exec_id = insert_execution(db_conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2026-04-16T12:00:00Z",
        })
        row = get_execution_by_id(db_conn, exec_id)
        assert "progress_events" in row
        assert row["progress_events"] is None

    def test_current_stage_column_exists(self, db_conn):
        exec_id = insert_execution(db_conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2026-04-16T12:00:00Z",
        })
        row = get_execution_by_id(db_conn, exec_id)
        assert "current_stage" in row
        assert row["current_stage"] is None

    def test_save_and_get_progress_events(self, db_conn):
        exec_id = insert_execution(db_conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2026-04-16T12:00:00Z",
        })
        events = [
            {"type": "execution_start", "timestamp": "t0"},
            {"type": "complete", "status": "completed", "timestamp": "t1"},
        ]
        save_progress_events(db_conn, exec_id, events)
        loaded = get_progress_events(db_conn, exec_id)
        assert len(loaded) == 2
        assert loaded[0]["type"] == "execution_start"
        assert loaded[1]["status"] == "completed"

    def test_get_progress_events_empty(self, db_conn):
        exec_id = insert_execution(db_conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2026-04-16T12:00:00Z",
        })
        assert get_progress_events(db_conn, exec_id) == []

    def test_update_current_stage(self, db_conn):
        exec_id = insert_execution(db_conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2026-04-16T12:00:00Z",
        })
        update_current_stage(db_conn, exec_id, "querying")
        row = get_execution_by_id(db_conn, exec_id)
        assert row["current_stage"] == "querying"

        update_current_stage(db_conn, exec_id, "dedup")
        row = get_execution_by_id(db_conn, exec_id)
        assert row["current_stage"] == "dedup"

    def test_migration_idempotent(self, db_conn):
        """Calling init_db twice does not raise even though columns already exist."""
        init_db(conn=db_conn)  # second call
        exec_id = insert_execution(db_conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2026-04-16T12:00:00Z",
        })
        row = get_execution_by_id(db_conn, exec_id)
        assert "progress_events" in row


# ---------------------------------------------------------------------------
# SweepEngine — two-phase execution
# ---------------------------------------------------------------------------

class TestSweepEngineTwoPhase:

    def _make_mock_client(self, results=None):
        mock = MagicMock()
        mock.search.return_value = results or []
        return mock

    def test_prepare_execution_creates_record(self, db_conn, tmp_path):
        with patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_path):
            engine = SweepEngine(db_conn, config={})
            exec_id = engine.prepare_execution(
                "deep_dive", ["arxiv"], {"query": "test"}
            )
            assert isinstance(exec_id, int)
            row = get_execution_by_id(db_conn, exec_id)
            assert row is not None
            assert row["status"] == "running"
            assert row["execution_type"] == "deep_dive"

    def test_run_prepared_completes(self, db_conn, tmp_path):
        with patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_path), \
             patch("implementation_scripts.sweep_engine.get_client") as mock_get:
            mock_client = self._make_mock_client()
            mock_get.return_value = mock_client

            engine = SweepEngine(db_conn, config={})
            exec_id = engine.prepare_execution(
                "deep_dive", ["arxiv"], {"query": "test"}
            )
            progress_store.register(exec_id)

            result = engine.run_prepared(exec_id)
            assert result["execution_id"] == exec_id
            row = get_execution_by_id(db_conn, exec_id)
            assert row["status"] == "completed"

            # Verify progress events were emitted
            events = progress_store.get_events(exec_id)
            event_types = [e["type"] for e in events]
            assert "execution_start" in event_types
            assert "stage" in event_types
            assert "repo_start" in event_types
            assert "repo_done" in event_types
            assert "complete" in event_types

            # Cleanup
            progress_store.cleanup(exec_id)

    def test_run_prepared_emits_all_stage_types(self, db_conn, tmp_path):
        """Verify progress events cover querying, dedup, linking, reporting, finalizing stages."""
        from implementation_scripts.api_base import NormalizedResult

        mock_result = NormalizedResult(
            source_repository="arxiv",
            external_id="2026.12345",
            title="Test Paper",
            authors=["Author A"],
            abstract="An abstract.",
            publication_date="2026-04-16",
            url="https://arxiv.org/abs/2026.12345",
            doi=None,
            categories="cs.AI",
        )

        with patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_path), \
             patch("implementation_scripts.sweep_engine.get_client") as mock_get:
            mock_client = self._make_mock_client([mock_result])
            mock_get.return_value = mock_client

            engine = SweepEngine(db_conn, config={})
            exec_id = engine.prepare_execution(
                "deep_dive", ["arxiv"], {"query": "test"}
            )
            progress_store.register(exec_id)
            engine.run_prepared(exec_id)

            events = progress_store.get_events(exec_id)
            stages = [e["stage"] for e in events if e["type"] == "stage"]
            assert "querying" in stages
            assert "dedup" in stages
            assert "linking" in stages
            assert "reporting" in stages
            assert "finalizing" in stages

            progress_store.cleanup(exec_id)

    def test_repo_error_emits_repo_error_event(self, db_conn, tmp_path):
        with patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_path), \
             patch("implementation_scripts.sweep_engine.get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.search.side_effect = RuntimeError("API timeout")
            mock_get.return_value = mock_client

            engine = SweepEngine(db_conn, config={})
            exec_id = engine.prepare_execution(
                "deep_dive", ["arxiv"], {"query": "test"}
            )
            progress_store.register(exec_id)
            engine.run_prepared(exec_id)

            events = progress_store.get_events(exec_id)
            error_events = [e for e in events if e["type"] == "repo_error"]
            assert len(error_events) == 1
            assert error_events[0]["repository"] == "arxiv"
            assert "API timeout" in error_events[0]["error"]

            progress_store.cleanup(exec_id)


# ---------------------------------------------------------------------------
# SweepEngine — cancellation
# ---------------------------------------------------------------------------

class TestSweepEngineCancellation:

    def test_cancellation_before_first_repo(self, db_conn, tmp_path):
        with patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_path), \
             patch("implementation_scripts.sweep_engine.get_client") as mock_get:
            mock_get.return_value = MagicMock()

            engine = SweepEngine(db_conn, config={})
            exec_id = engine.prepare_execution(
                "deep_sweep", ["arxiv", "crossref"], {"query": "test"}
            )
            progress_store.register(exec_id)

            # Request cancellation before running
            progress_store.request_cancel(exec_id)

            result = engine.run_prepared(exec_id)
            assert result["status"] == "cancelled"

            row = get_execution_by_id(db_conn, exec_id)
            assert row["status"] == "cancelled"

            events = progress_store.get_events(exec_id)
            event_types = [e["type"] for e in events]
            assert "cancelled" in event_types

            # The client.search should NOT have been called (cancelled before first repo)
            mock_get.return_value.search.assert_not_called()

            progress_store.cleanup(exec_id)

    def test_cancellation_mid_execution(self, db_conn, tmp_path):
        """Cancel after the first repo finishes but before the second starts."""
        call_count = 0

        def cancel_after_first(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # After first repo returns, request cancel
                progress_store.request_cancel(exec_id)
            return []

        with patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_path), \
             patch("implementation_scripts.sweep_engine.get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.search.side_effect = cancel_after_first
            mock_get.return_value = mock_client

            engine = SweepEngine(db_conn, config={})
            exec_id = engine.prepare_execution(
                "deep_sweep", ["arxiv", "crossref", "pubmed"], {"query": "test"}
            )
            progress_store.register(exec_id)

            result = engine.run_prepared(exec_id)
            assert result["status"] == "cancelled"

            # Only the first repo should have been queried
            assert call_count == 1

            progress_store.cleanup(exec_id)


# ---------------------------------------------------------------------------
# SweepEngine — backwards compatibility
# ---------------------------------------------------------------------------

class TestSweepEngineBackwardsCompat:

    def test_execute_dive_still_works(self, db_conn, tmp_path):
        """The original execute_dive API still returns correct results."""
        with patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_path), \
             patch("implementation_scripts.sweep_engine.get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.search.return_value = []
            mock_get.return_value = mock_client

            engine = SweepEngine(db_conn, config={})
            result = engine.execute_dive("arxiv", {"query": "test"})
            assert "execution_id" in result
            assert "result_count" in result

            row = get_execution_by_id(db_conn, result["execution_id"])
            assert row["status"] == "completed"

    def test_execute_sweep_still_works(self, db_conn, tmp_path):
        """The original execute_sweep API still returns correct results."""
        with patch("implementation_scripts.sweep_engine.REPORTS_DIR", tmp_path), \
             patch("implementation_scripts.sweep_engine.get_client") as mock_get:
            mock_client = MagicMock()
            mock_client.search.return_value = []
            mock_get.return_value = mock_client

            engine = SweepEngine(db_conn, config={})
            result = engine.execute_sweep(["arxiv", "crossref"], {"query": "test"})
            assert "execution_id" in result
            assert result["result_count"] == 0
