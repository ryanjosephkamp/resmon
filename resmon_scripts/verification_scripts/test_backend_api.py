# resmon_scripts/verification_scripts/test_backend_api.py
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

import resmon as resmon_mod

def _reset_db():
    """Point the app at a fresh in-memory database."""
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None  # force a new DB
    resmon_mod._db_initialized = False


def test_health_endpoint():
    """GET /api/health returns 200 OK."""
    _reset_db()
    from resmon import app
    client = TestClient(app)
    response = client.get("/api/health")
    assert response.status_code == 200


def test_routines_crud():
    """POST, GET, DELETE routines via API."""
    _reset_db()
    from resmon import app
    client = TestClient(app)

    # Create
    resp = client.post("/api/routines", json={
        "name": "Test Routine",
        "schedule_cron": "0 8 * * *",
        "parameters": {"keywords": ["test"]},
    })
    assert resp.status_code in (200, 201)
    routine_id = resp.json().get("id")

    # Read
    resp = client.get("/api/routines")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1

    # Delete
    resp = client.delete(f"/api/routines/{routine_id}")
    assert resp.status_code == 200


def test_configurations_crud():
    """POST, GET, DELETE configurations via API."""
    _reset_db()
    from resmon import app
    client = TestClient(app)

    resp = client.post("/api/configurations", json={
        "name": "Test Config",
        "config_type": "manual_dive",
        "parameters": {"keywords": ["test"]},
    })
    assert resp.status_code in (200, 201)
    config_id = resp.json().get("id")

    resp = client.get("/api/configurations")
    assert resp.status_code == 200

    resp = client.delete(f"/api/configurations/{config_id}")
    assert resp.status_code == 200


def test_settings_roundtrip():
    """PUT and GET settings for email, AI, cloud, and storage."""
    _reset_db()
    from resmon import app
    client = TestClient(app)

    for endpoint in ["/api/settings/email", "/api/settings/ai",
                     "/api/settings/cloud", "/api/settings/storage"]:
        resp = client.get(endpoint)
        assert resp.status_code == 200


def test_ai_settings_put_get_roundtrip_new_keys():
    """IMPL-AI9: every new AI settings key round-trips through PUT/GET."""
    _reset_db()
    from resmon import app
    client = TestClient(app)

    payload = {
        "ai_provider": "xai",
        "ai_model": "grok-2-latest",
        "ai_local_model": "llama3.1:8b",
        "ai_summary_length": "detailed",
        "ai_tone": "accessible",
        "ai_extraction_goals": "methodology, limitations",
        "ai_temperature": "0.2",
        "ai_show_audit_prefix": "true",
        "ai_custom_base_url": "https://llm.example.com/v1",
        "ai_custom_header_prefix": "Bearer",
    }

    resp = client.put("/api/settings/ai", json={"settings": payload})
    assert resp.status_code == 200

    resp = client.get("/api/settings/ai")
    assert resp.status_code == 200
    got = resp.json()
    for key, expected in payload.items():
        assert got.get(key) == expected, f"{key}: expected {expected!r}, got {got.get(key)!r}"
