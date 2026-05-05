"""Update 4 / Batch 1 regression tests — Fix A (cascade + reconcile)
and Fix B (misfire_grace_time=3600).

Covers:
* ``database.delete_routine`` cascades to ``apscheduler_jobs``.
* ``ResmonScheduler.reconcile_jobstore`` removes orphan jobs whose id
  is not in the active-routine set, and is idempotent.
* New routine jobs are added with ``misfire_grace_time=3600``.
"""

from __future__ import annotations

import sys
import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.database import (
    init_db,
    insert_routine,
    delete_routine,
)
from implementation_scripts.scheduler import ResmonScheduler


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_db(tmp_path: Path) -> sqlite3.Connection:
    db = tmp_path / "resmon.db"
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    init_db(conn=conn)
    return conn


def _make_scheduler(tmp_path: Path) -> ResmonScheduler:
    # Point the APScheduler jobstore at the same SQLite file the app
    # uses, mirroring production wiring.
    db = tmp_path / "resmon.db"
    sched = ResmonScheduler(db_url=f"sqlite:///{db}")
    sched.start()
    return sched


def _routine_dict(name: str = "r") -> dict:
    return {
        "name": name,
        "schedule_cron": "0 8 * * *",
        "parameters": '{"query": "x"}',
        "is_active": 1,
        "email_enabled": 0,
        "email_ai_summary_enabled": 0,
        "ai_enabled": 0,
        "notify_on_complete": 0,
        "ai_settings": None,
        "storage_settings": None,
        "execution_location": "local",
    }


# ---------------------------------------------------------------------------
# Fix A — delete_routine cascades to apscheduler_jobs
# ---------------------------------------------------------------------------

def test_delete_routine_cascades_apscheduler_jobs(tmp_path: Path):
    conn = _make_db(tmp_path)
    sched = _make_scheduler(tmp_path)
    try:
        rid = insert_routine(conn, _routine_dict("r-cascade"))
        sched.add_routine({"id": rid, **_routine_dict("r-cascade")})
        # Confirm jobstore row present.
        rows = conn.execute(
            "SELECT id FROM apscheduler_jobs WHERE id = ?", (str(rid),)
        ).fetchall()
        assert len(rows) == 1

        delete_routine(conn, rid)

        rows = conn.execute(
            "SELECT id FROM apscheduler_jobs WHERE id = ?", (str(rid),)
        ).fetchall()
        assert rows == [], "delete_routine must cascade to apscheduler_jobs"
    finally:
        sched.shutdown()
        conn.close()


def test_delete_routine_tolerates_missing_jobstore_table(tmp_path: Path):
    """When no scheduler has ever started against the DB file, the
    apscheduler_jobs table does not exist; delete_routine must still
    succeed."""
    conn = _make_db(tmp_path)
    try:
        rid = insert_routine(conn, _routine_dict("r-no-jobstore"))
        # Sanity: no apscheduler_jobs table.
        tbls = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        ]
        assert "apscheduler_jobs" not in tbls

        delete_routine(conn, rid)  # must not raise

        rows = conn.execute(
            "SELECT id FROM routines WHERE id = ?", (rid,)
        ).fetchall()
        assert rows == []
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Fix A — startup reconciliation removes orphan jobs
# ---------------------------------------------------------------------------

def test_reconcile_jobstore_removes_orphans(tmp_path: Path):
    conn = _make_db(tmp_path)
    sched = _make_scheduler(tmp_path)
    try:
        rid_keep = insert_routine(conn, _routine_dict("r-keep"))
        rid_orphan_a = insert_routine(conn, _routine_dict("r-orphan-a"))
        rid_orphan_b = insert_routine(conn, _routine_dict("r-orphan-b"))
        for rid, name in (
            (rid_keep, "r-keep"),
            (rid_orphan_a, "r-orphan-a"),
            (rid_orphan_b, "r-orphan-b"),
        ):
            sched.add_routine({"id": rid, **_routine_dict(name)})

        # Simulate the deletion having happened via a process that did
        # NOT own the scheduler (so the apscheduler_jobs row survives).
        # We mimic that by raw-SQL deleting the routines row only.
        conn.execute(
            "DELETE FROM routines WHERE id IN (?, ?)",
            (rid_orphan_a, rid_orphan_b),
        )
        conn.commit()

        active_ids = {str(rid_keep)}
        removed = sched.reconcile_jobstore(active_ids)

        assert set(removed) == {str(rid_orphan_a), str(rid_orphan_b)}
        remaining = {j["id"] for j in sched.get_active_jobs()}
        assert remaining == {str(rid_keep)}

        # Idempotent: a second call removes nothing.
        assert sched.reconcile_jobstore(active_ids) == []
    finally:
        sched.shutdown()
        conn.close()


def test_reconcile_jobstore_keeps_all_when_all_active(tmp_path: Path):
    conn = _make_db(tmp_path)
    sched = _make_scheduler(tmp_path)
    try:
        rid_a = insert_routine(conn, _routine_dict("r-a"))
        rid_b = insert_routine(conn, _routine_dict("r-b"))
        for rid, name in ((rid_a, "r-a"), (rid_b, "r-b")):
            sched.add_routine({"id": rid, **_routine_dict(name)})

        removed = sched.reconcile_jobstore({str(rid_a), str(rid_b)})
        assert removed == []
        assert {j["id"] for j in sched.get_active_jobs()} == {
            str(rid_a),
            str(rid_b),
        }
    finally:
        sched.shutdown()
        conn.close()


# ---------------------------------------------------------------------------
# Fix B — misfire_grace_time=3600 on routine jobs
# ---------------------------------------------------------------------------

def test_routine_jobs_use_one_hour_misfire_grace(tmp_path: Path):
    conn = _make_db(tmp_path)
    sched = _make_scheduler(tmp_path)
    try:
        rid = insert_routine(conn, _routine_dict("r-grace"))
        sched.add_routine({"id": rid, **_routine_dict("r-grace")})

        job = sched._scheduler.get_job(str(rid))
        assert job is not None
        assert job.misfire_grace_time == 3600, (
            "Routine jobs must be added with misfire_grace_time=3600 "
            "so brief daemon restart / scheduler-reattach windows do "
            "not silently drop the next fire."
        )
    finally:
        sched.shutdown()
        conn.close()
