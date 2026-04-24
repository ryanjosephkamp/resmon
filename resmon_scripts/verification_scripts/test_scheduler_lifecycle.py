"""IMPL-R4 — Scheduler lifecycle + ``GET /api/scheduler/jobs`` smoke test."""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database  # noqa: E402


def _fresh_client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod.scheduler = None
    from resmon import app
    return TestClient(app)


def test_scheduler_jobs_reflects_active_routine():
    with _fresh_client() as client:
        # Confirm lifecycle hooks wired the module-level scheduler.
        assert resmon_mod.scheduler is not None

        # Create an active routine via the REST API and verify the scheduler
        # picked it up (routine create path calls ``_sync_routine_to_scheduler``
        # in IMPL-R5; for R4 we assert the startup-hydration path by inserting
        # directly through the DB and restarting via a fresh client).
        body = {
            "name": "r4-smoke",
            "schedule_cron": "0 9 * * *",
            "parameters": {"query": "test", "repositories": ["arxiv"]},
            "is_active": True,
            "notify_on_completion": False,
        }
        resp = client.post("/api/routines", json=body)
        assert resp.status_code == 201, resp.text
        routine_id = resp.json()["id"]

        # Register the routine with the scheduler explicitly — IMPL-R4 only
        # guarantees startup registration + the ``/api/scheduler/jobs`` view.
        resmon_mod.scheduler.add_routine({
            "id": routine_id,
            "name": body["name"],
            "schedule_cron": body["schedule_cron"],
            "parameters": body["parameters"],
        })

        jobs_resp = client.get("/api/scheduler/jobs")
        assert jobs_resp.status_code == 200
        jobs = jobs_resp.json()
        assert isinstance(jobs, list)
        ids = [j["id"] for j in jobs]
        assert str(routine_id) in ids

        match = next(j for j in jobs if j["id"] == str(routine_id))
        assert "next_run_time" in match
        assert "trigger" in match
        assert "cron" in match["trigger"].lower()


def test_scheduler_jobs_empty_when_no_routines():
    with _fresh_client() as client:
        resp = client.get("/api/scheduler/jobs")
        assert resp.status_code == 200
        assert resp.json() == []


def test_startup_registers_preexisting_active_routines():
    # Pre-seed the DB before TestClient triggers the startup hook, then
    # confirm the scheduler picks up the active routine on startup.
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod.scheduler = None

    conn = resmon_mod._get_db()
    rid = database.insert_routine(conn, {
        "name": "preseed",
        "schedule_cron": "30 7 * * *",
        "parameters": '{"query":"x"}',
        "is_active": True,
        "notify_on_completion": False,
    })

    from resmon import app
    with TestClient(app) as client:
        resp = client.get("/api/scheduler/jobs")
        assert resp.status_code == 200
        ids = [j["id"] for j in resp.json()]
        assert str(rid) in ids
