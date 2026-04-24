"""IMPL-R5 — Routine CRUD ↔ scheduler synchronization."""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402


def _fresh_client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod.scheduler = None
    from resmon import app
    return TestClient(app)


def _job_ids() -> list[str]:
    assert resmon_mod.scheduler is not None
    return [j["id"] for j in resmon_mod.scheduler.get_active_jobs()]


def _routine_body(name: str, *, is_active: bool = True, execution_location: str = "local") -> dict:
    return {
        "name": name,
        "schedule_cron": "0 8 * * *",
        "parameters": {"query": "x", "repositories": ["arxiv"]},
        "is_active": is_active,
        "execution_location": execution_location,
    }


def test_create_active_routine_registers_job():
    with _fresh_client() as client:
        resp = client.post("/api/routines", json=_routine_body("r-create"))
        assert resp.status_code == 201
        rid = resp.json()["id"]
        assert str(rid) in _job_ids()


def test_create_inactive_routine_does_not_register():
    with _fresh_client() as client:
        resp = client.post("/api/routines", json=_routine_body("r-inactive", is_active=False))
        assert resp.status_code == 201
        rid = resp.json()["id"]
        assert str(rid) not in _job_ids()


def test_create_cloud_routine_does_not_register_locally():
    with _fresh_client() as client:
        resp = client.post(
            "/api/routines",
            json=_routine_body("r-cloud", execution_location="cloud"),
        )
        assert resp.status_code == 201
        rid = resp.json()["id"]
        assert str(rid) not in _job_ids()


def test_put_activates_registers_and_deactivates_removes():
    with _fresh_client() as client:
        resp = client.post("/api/routines", json=_routine_body("r-put", is_active=False))
        rid = resp.json()["id"]
        assert str(rid) not in _job_ids()

        client.put(f"/api/routines/{rid}", json={"is_active": True})
        assert str(rid) in _job_ids()

        client.put(f"/api/routines/{rid}", json={"is_active": False})
        assert str(rid) not in _job_ids()


def test_put_updates_cron_keeps_job():
    with _fresh_client() as client:
        rid = client.post("/api/routines", json=_routine_body("r-cron")).json()["id"]
        assert str(rid) in _job_ids()
        client.put(f"/api/routines/{rid}", json={"schedule_cron": "30 9 * * *"})
        jobs = resmon_mod.scheduler.get_active_jobs()
        match = next(j for j in jobs if j["id"] == str(rid))
        assert "30" in match["trigger"] or "9" in match["trigger"]


def test_activate_endpoint_registers_job():
    with _fresh_client() as client:
        rid = client.post(
            "/api/routines", json=_routine_body("r-act", is_active=False),
        ).json()["id"]
        assert str(rid) not in _job_ids()
        resp = client.post(f"/api/routines/{rid}/activate")
        assert resp.status_code == 200
        assert str(rid) in _job_ids()


def test_deactivate_endpoint_removes_job():
    with _fresh_client() as client:
        rid = client.post("/api/routines", json=_routine_body("r-deact")).json()["id"]
        assert str(rid) in _job_ids()
        resp = client.post(f"/api/routines/{rid}/deactivate")
        assert resp.status_code == 200
        assert str(rid) not in _job_ids()


def test_delete_routine_removes_job_before_row():
    with _fresh_client() as client:
        rid = client.post("/api/routines", json=_routine_body("r-del")).json()["id"]
        assert str(rid) in _job_ids()
        resp = client.delete(f"/api/routines/{rid}")
        assert resp.status_code == 200
        assert str(rid) not in _job_ids()


def test_released_to_cloud_removes_job():
    with _fresh_client() as client:
        rid = client.post("/api/routines", json=_routine_body("r-rel")).json()["id"]
        assert str(rid) in _job_ids()
        resp = client.post(f"/api/routines/{rid}/released-to-cloud")
        assert resp.status_code == 200
        assert str(rid) not in _job_ids()


def test_adopt_from_cloud_registers_job():
    with _fresh_client() as client:
        body = {
            "name": "r-adopt",
            "schedule_cron": "15 10 * * *",
            "parameters": {"query": "y"},
            "email_enabled": False,
            "email_ai_summary_enabled": False,
            "ai_enabled": False,
            "notify_on_complete": False,
        }
        resp = client.post("/api/routines/adopt-from-cloud", json=body)
        assert resp.status_code == 201
        rid = resp.json()["id"]
        assert str(rid) in _job_ids()
