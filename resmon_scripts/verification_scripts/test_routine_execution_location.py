"""IMPL-37 verification — Routine ``execution_location`` toggle and migration.

Covers ``resmon_routines_and_accounts.md`` §§12.1, 14.1 and
``resmon_implementation_guide.md`` Step 37.

Hermetic FastAPI coverage (no live cloud Postgres). Round-trip verified
through the local daemon's two new endpoints:

* ``POST /api/routines/adopt-from-cloud`` — creates a local routine from a
  cloud-routine body (name, cron, parameters preserved verbatim).
* ``POST /api/routines/{id}/released-to-cloud`` — deletes a local routine
  after the renderer has successfully mirrored it to the cloud.

Together these cover the local-only half of every "Move to Cloud" /
"Move to Local" flow. The cloud-side POST/DELETE is exercised by
``test_cloud_routines_worker.py`` and ``test_cloud_skeleton.py``.
"""

from __future__ import annotations

import json
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
# Migration: execution_location column
# ---------------------------------------------------------------------------


def test_execution_location_column_exists_with_correct_default():
    client = _client()
    client.get("/api/health")
    conn = resmon_mod._get_db()
    cols = {row[1]: row for row in conn.execute("PRAGMA table_info(routines)").fetchall()}
    assert "execution_location" in cols, "execution_location column missing"
    # Column 4 is dflt_value, column 3 is notnull.
    col = cols["execution_location"]
    assert col[3] == 1, "execution_location must be NOT NULL"
    assert "local" in str(col[4]), f"default must be 'local', got {col[4]!r}"


def test_schema_version_bumped_to_3():
    # Update 3 / 4_27_26 bumped SCHEMA_VERSION to 4 (added
    # ``executions.saved_configuration_id``). The test name is preserved
    # for git-blame stability; assertion now reads from the constant so
    # it tracks future bumps.
    client = _client()
    client.get("/api/health")
    conn = resmon_mod._get_db()
    assert database.get_schema_version(conn) == database.SCHEMA_VERSION
    assert database.SCHEMA_VERSION >= 3


def test_execution_location_check_constraint_rejects_invalid():
    client = _client()
    client.get("/api/health")
    conn = resmon_mod._get_db()
    # Insert with a valid value first to confirm the column accepts 'local'.
    conn.execute(
        "INSERT INTO routines (name, schedule_cron, parameters, execution_location) "
        "VALUES (?, ?, ?, ?)",
        ("ok", "0 8 * * *", "{}", "local"),
    )
    conn.commit()
    # Direct SQL with an out-of-domain value must fail the CHECK.
    import sqlite3 as _sqlite
    raised = False
    try:
        conn.execute(
            "INSERT INTO routines (name, schedule_cron, parameters, execution_location) "
            "VALUES (?, ?, ?, ?)",
            ("bad", "0 8 * * *", "{}", "edge"),
        )
        conn.commit()
    except _sqlite.IntegrityError:
        raised = True
    assert raised, "CHECK constraint must reject execution_location='edge'"


# ---------------------------------------------------------------------------
# /api/routines accepts and returns execution_location
# ---------------------------------------------------------------------------


def test_create_routine_defaults_to_local():
    client = _client()
    resp = client.post("/api/routines", json={
        "name": "Plain",
        "schedule_cron": "0 8 * * *",
        "parameters": {"keywords": ["x"]},
    })
    assert resp.status_code in (200, 201), resp.text
    rid = resp.json()["id"]
    listed = client.get("/api/routines").json()
    row = next(r for r in listed if r["id"] == rid)
    assert row["execution_location"] == "local"


def test_create_routine_with_explicit_cloud_location():
    client = _client()
    resp = client.post("/api/routines", json={
        "name": "Cloudy",
        "schedule_cron": "0 9 * * *",
        "parameters": {"keywords": ["y"]},
        "execution_location": "cloud",
    })
    assert resp.status_code in (200, 201), resp.text
    rid = resp.json()["id"]
    row = next(r for r in client.get("/api/routines").json() if r["id"] == rid)
    assert row["execution_location"] == "cloud"


def test_create_routine_rejects_unknown_location():
    client = _client()
    resp = client.post("/api/routines", json={
        "name": "Bad",
        "schedule_cron": "0 9 * * *",
        "parameters": {},
        "execution_location": "edge",
    })
    assert resp.status_code == 400


def test_update_routine_can_flip_location():
    client = _client()
    rid = client.post("/api/routines", json={
        "name": "Flip",
        "schedule_cron": "0 7 * * *",
        "parameters": {},
    }).json()["id"]
    resp = client.put(f"/api/routines/{rid}", json={"execution_location": "cloud"})
    assert resp.status_code == 200, resp.text
    row = next(r for r in client.get("/api/routines").json() if r["id"] == rid)
    assert row["execution_location"] == "cloud"


# ---------------------------------------------------------------------------
# Migration endpoints
# ---------------------------------------------------------------------------


def test_released_to_cloud_deletes_local_routine():
    client = _client()
    rid = client.post("/api/routines", json={
        "name": "ToBeReleased",
        "schedule_cron": "0 8 * * *",
        "parameters": {"keywords": ["z"]},
    }).json()["id"]
    resp = client.post(f"/api/routines/{rid}/released-to-cloud")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"released": True, "id": rid}
    assert all(r["id"] != rid for r in client.get("/api/routines").json())


def test_released_to_cloud_404_for_unknown():
    client = _client()
    resp = client.post("/api/routines/9999/released-to-cloud")
    assert resp.status_code == 404


def test_adopt_from_cloud_preserves_name_cron_parameters_exactly():
    client = _client()
    cloud_body = {
        "name": "Cloud routine α",
        "schedule_cron": "*/15 8-18 * * 1-5",
        "parameters": {
            "repositories": ["arxiv", "openalex"],
            "keywords": ["graph neural network", "diffusion"],
            "max_results": 250,
            "date_from": "2026-01-01",
            "nested": {"k": [1, 2, 3]},
        },
        "email_enabled": True,
        "ai_enabled": True,
        "notify_on_complete": True,
    }
    resp = client.post("/api/routines/adopt-from-cloud", json=cloud_body)
    assert resp.status_code == 201, resp.text
    rid = resp.json()["id"]
    assert resp.json()["execution_location"] == "local"

    row = next(r for r in client.get("/api/routines").json() if r["id"] == rid)
    assert row["name"] == cloud_body["name"]
    assert row["schedule_cron"] == cloud_body["schedule_cron"]
    assert json.loads(row["parameters"]) == cloud_body["parameters"]
    assert row["execution_location"] == "local"
    assert row["email_enabled"] == 1
    assert row["ai_enabled"] == 1
    assert row["notify_on_complete"] == 1


def test_round_trip_local_to_cloud_to_local_preserves_everything():
    """Simulate the full round-trip: create local → release-to-cloud →
    adopt-from-cloud (with cloud-shaped body) → assert lossless preservation
    of name, cron, parameters."""
    client = _client()
    original_params = {
        "repositories": ["arxiv"],
        "keywords": ["protein folding"],
        "max_results": 100,
        "date_from": "2026-04-01",
        "date_to": "2026-04-30",
        "query": "protein folding",
    }
    original_name = "Round Trip"
    original_cron = "0 9 * * MON"
    rid = client.post("/api/routines", json={
        "name": original_name,
        "schedule_cron": original_cron,
        "parameters": original_params,
    }).json()["id"]

    # Stage 1: release the local copy (simulates cloud POST having succeeded).
    client.post(f"/api/routines/{rid}/released-to-cloud")
    assert all(r["id"] != rid for r in client.get("/api/routines").json())

    # Stage 2: adopt back from a cloud-shaped body.
    resp = client.post("/api/routines/adopt-from-cloud", json={
        "name": original_name,
        "schedule_cron": original_cron,
        "parameters": original_params,
    })
    assert resp.status_code == 201, resp.text
    new_rid = resp.json()["id"]
    row = next(r for r in client.get("/api/routines").json() if r["id"] == new_rid)
    assert row["name"] == original_name
    assert row["schedule_cron"] == original_cron
    assert json.loads(row["parameters"]) == original_params
    assert row["execution_location"] == "local"
