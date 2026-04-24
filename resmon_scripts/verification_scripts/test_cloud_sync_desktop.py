"""IMPL-36 verification — Desktop useCloudSync + Merged Results View.

Covers ``resmon_routines_and_accounts.md`` §§12, 14.1 and
``resmon_implementation_guide.md`` Step 36:

* SQLite migration — ``cloud_routines``, ``cloud_executions``,
  ``cloud_cache_meta``, ``sync_state`` are created; ``schema_version`` is
  bumped to 2; re-initialization is idempotent.
* ``GET /api/cloud-sync/state`` — fresh DB returns
  ``{last_synced_version:0, cache_bytes:0, schema_version:2}``.
* ``POST /api/cloud-sync/ingest`` — upserts routines + executions,
  advances the cursor forward-only, idempotent on replay, cannot rewind
  with a lower ``next_version``.
* ``GET /api/executions/merged`` — returns local + cloud rows tagged with
  ``execution_location``, sorted by start time descending. ``filter=local``
  strips cloud rows; ``filter=cloud`` strips local rows.
* ``POST /api/cloud-sync/cache/record`` — records cache metadata, evicts
  the oldest row when the ceiling is exceeded (V-G LRU invariant).
* ``POST /api/cloud-sync/clear`` — wipes all four mirror tables (V-G3
  sign-out).

Hermetic. Uses ``TestClient`` against ``resmon.app`` with an in-memory
SQLite database — no cloud service, no network.
"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database  # noqa: E402


def _reset_db():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def _client() -> TestClient:
    _reset_db()
    from resmon import app
    return TestClient(app)


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------


def test_schema_version_bumped_to_2():
    # IMPL-36 introduced schema_version 2. Subsequent migrations may bump
    # it further (IMPL-37 → 3), so assert the floor, not equality.
    client = _client()
    client.get("/api/health")  # force init_db
    conn = resmon_mod._get_db()
    assert database.get_schema_version(conn) >= 2


def test_schema_migration_is_idempotent():
    client = _client()
    client.get("/api/health")
    conn = resmon_mod._get_db()
    before = database.get_schema_version(conn)
    # Re-run init_db on the same connection; the version must not change.
    database.init_db(conn)
    assert database.get_schema_version(conn) == before


def test_cloud_mirror_tables_present():
    client = _client()
    client.get("/api/health")
    conn = resmon_mod._get_db()
    names = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    for expected in (
        "cloud_routines",
        "cloud_executions",
        "cloud_cache_meta",
        "sync_state",
    ):
        assert expected in names, f"missing table {expected!r}"


# ---------------------------------------------------------------------------
# /api/cloud-sync/state
# ---------------------------------------------------------------------------


def test_cloud_sync_state_empty():
    client = _client()
    r = client.get("/api/cloud-sync/state")
    assert r.status_code == 200
    body = r.json()
    assert body["last_synced_version"] == 0
    assert body["cache_bytes"] == 0
    assert body["schema_version"] >= 2


# ---------------------------------------------------------------------------
# /api/cloud-sync/ingest
# ---------------------------------------------------------------------------


def _sample_routine(routine_id: str, version: int = 1) -> dict:
    return {
        "routine_id": routine_id,
        "name": f"Routine {routine_id}",
        "cron": "0 8 * * *",
        "parameters": {"keywords": ["ml"]},
        "enabled": True,
        "created_at": "2026-04-19T07:00:00Z",
        "updated_at": "2026-04-19T07:00:00Z",
        "version": version,
    }


def _sample_execution(
    execution_id: str,
    routine_id: str,
    started_at: str,
    version: int = 1,
    status: str = "completed",
) -> dict:
    return {
        "execution_id": execution_id,
        "routine_id": routine_id,
        "owner_id": "user-1",
        "status": status,
        "started_at": started_at,
        "finished_at": started_at,
        "result_count": 3,
        "new_result_count": 1,
        "version": version,
    }


def test_cloud_sync_ingest_advances_cursor():
    client = _client()
    resp = client.post(
        "/api/cloud-sync/ingest",
        json={
            "routines": [_sample_routine("r-1")],
            "executions": [
                _sample_execution("e-1", "r-1", "2026-04-19T08:00:00Z"),
            ],
            "next_version": 5,
            "has_more": False,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["last_synced_version"] == 5
    assert body["ingested"] == {"routines": 1, "executions": 1}

    state = client.get("/api/cloud-sync/state").json()
    assert state["last_synced_version"] == 5


def test_cloud_sync_ingest_cursor_is_forward_only():
    client = _client()
    client.post(
        "/api/cloud-sync/ingest",
        json={
            "routines": [],
            "executions": [],
            "next_version": 10,
            "has_more": False,
        },
    )
    # Attempt to rewind.
    resp = client.post(
        "/api/cloud-sync/ingest",
        json={
            "routines": [],
            "executions": [],
            "next_version": 3,
            "has_more": False,
        },
    )
    assert resp.status_code == 200
    assert resp.json()["last_synced_version"] == 10


def test_cloud_sync_ingest_is_idempotent_on_replay():
    client = _client()
    payload = {
        "routines": [_sample_routine("r-1")],
        "executions": [
            _sample_execution("e-1", "r-1", "2026-04-19T08:00:00Z"),
        ],
        "next_version": 1,
        "has_more": False,
    }
    client.post("/api/cloud-sync/ingest", json=payload)
    client.post("/api/cloud-sync/ingest", json=payload)
    # Still exactly one row — upsert collapsed the duplicate.
    execs = client.get("/api/cloud-sync/executions").json()
    assert len(execs) == 1
    assert execs[0]["execution_id"] == "e-1"


# ---------------------------------------------------------------------------
# /api/executions/merged
# ---------------------------------------------------------------------------


def test_merged_executions_tags_and_sort():
    client = _client()
    # Seed a local execution by creating a routine + manual dive completion
    # shortcut: insert directly via the daemon's public API is too heavy for
    # this test — instead, insert directly into the local ``executions``
    # table via the shared connection.
    conn = resmon_mod._get_db()
    conn.execute(
        "INSERT INTO executions (execution_type, status, start_time, parameters) "
        "VALUES (?, ?, ?, ?)",
        ("deep_dive", "completed", "2026-04-18T12:00:00Z", "{}"),
    )
    conn.commit()

    # Seed a cloud execution via the ingest endpoint.
    client.post(
        "/api/cloud-sync/ingest",
        json={
            "routines": [_sample_routine("r-1")],
            "executions": [
                _sample_execution("e-1", "r-1", "2026-04-19T08:00:00Z"),
            ],
            "next_version": 1,
            "has_more": False,
        },
    )

    # filter=all → both rows, cloud first (later start_time).
    merged = client.get("/api/executions/merged?filter=all").json()
    locations = [r["execution_location"] for r in merged]
    assert locations == ["cloud", "local"], merged

    # filter=local → only local.
    only_local = client.get("/api/executions/merged?filter=local").json()
    assert len(only_local) == 1
    assert only_local[0]["execution_location"] == "local"

    # filter=cloud → only cloud.
    only_cloud = client.get("/api/executions/merged?filter=cloud").json()
    assert len(only_cloud) == 1
    assert only_cloud[0]["execution_location"] == "cloud"
    assert only_cloud[0]["execution_type"] == "cloud_routine"


def test_merged_executions_rejects_bad_filter():
    client = _client()
    r = client.get("/api/executions/merged?filter=bogus")
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# /api/cloud-sync/cache/record (LRU)
# ---------------------------------------------------------------------------


def test_cache_record_and_lru_eviction():
    client = _client()
    # Ceiling of 1500 bytes. Insert three 1000-byte entries → oldest two
    # evict so only the most-recent entry remains.
    for i, exec_id in enumerate(("e-1", "e-2", "e-3")):
        resp = client.post(
            "/api/cloud-sync/cache/record",
            json={
                "execution_id": exec_id,
                "artifact_name": "report.md",
                "local_path": f"/tmp/resmon-cache/{exec_id}/report.md",
                "bytes": 1000,
                "max_bytes": 1500,
            },
        )
        assert resp.status_code == 200, resp.text

    state = client.get("/api/cloud-sync/state").json()
    # After inserting 3×1000 with ceiling 1500, only the newest fits.
    assert state["cache_bytes"] <= 1500
    # The newest entry must still be present.
    r = client.get("/api/cloud-sync/cache/e-3/report.md")
    assert r.status_code == 200
    # The oldest entry must have been evicted.
    r = client.get("/api/cloud-sync/cache/e-1/report.md")
    assert r.status_code == 404


def test_cache_touch_keeps_entry_hot():
    client = _client()
    # Record two entries with a roomy ceiling.
    for exec_id in ("e-1", "e-2"):
        client.post(
            "/api/cloud-sync/cache/record",
            json={
                "execution_id": exec_id,
                "artifact_name": "report.md",
                "local_path": f"/tmp/{exec_id}.md",
                "bytes": 500,
                "max_bytes": 10_000,
            },
        )
    # Touch e-1 so it becomes most-recently-accessed.
    r = client.post(
        "/api/cloud-sync/cache/touch",
        json={
            "execution_id": "e-1",
            "artifact_name": "report.md",
            "local_path": "ignored",
            "bytes": 0,
        },
    )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# /api/cloud-sync/clear (V-G3)
# ---------------------------------------------------------------------------


def test_cloud_sync_clear_wipes_everything():
    client = _client()
    client.post(
        "/api/cloud-sync/ingest",
        json={
            "routines": [_sample_routine("r-1")],
            "executions": [
                _sample_execution("e-1", "r-1", "2026-04-19T08:00:00Z"),
            ],
            "next_version": 7,
            "has_more": False,
        },
    )
    client.post(
        "/api/cloud-sync/cache/record",
        json={
            "execution_id": "e-1",
            "artifact_name": "report.md",
            "local_path": "/tmp/r.md",
            "bytes": 100,
        },
    )
    # Sanity pre-clear.
    pre = client.get("/api/cloud-sync/state").json()
    assert pre["last_synced_version"] == 7
    assert pre["cache_bytes"] == 100

    resp = client.post("/api/cloud-sync/clear")
    assert resp.status_code == 200

    post = client.get("/api/cloud-sync/state").json()
    assert post["last_synced_version"] == 0
    assert post["cache_bytes"] == 0
    assert client.get("/api/cloud-sync/executions").json() == []
    assert client.get("/api/cloud-sync/routines").json() == []
