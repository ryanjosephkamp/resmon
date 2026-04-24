# resmon_scripts/verification_scripts/test_put_credential_validation.py
"""Tests for PUT /api/credentials/{key_name} whitelist enforcement (IMPL-23)."""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

import resmon as resmon_mod


def _reset_db():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def test_put_unknown_key_name_returns_400(monkeypatch):
    _reset_db()
    from resmon import app

    called: dict = {}

    def _store(name, value):
        called["name"] = name

    monkeypatch.setattr(resmon_mod, "store_credential", _store)

    client = TestClient(app)
    resp = client.put("/api/credentials/bogus_key_name", json={"value": "xyz"})
    assert resp.status_code == 400
    assert "called" not in {"called": "name"} or "name" not in called


def test_put_known_catalog_credential_is_accepted(monkeypatch):
    _reset_db()
    from resmon import app

    captured: dict = {}
    monkeypatch.setattr(
        resmon_mod, "store_credential",
        lambda name, value: captured.setdefault("name", name),
    )

    client = TestClient(app)
    resp = client.put("/api/credentials/core_api_key", json={"value": "abc"})
    assert resp.status_code == 200
    assert captured["name"] == "core_api_key"


def test_put_llm_credentials_are_accepted(monkeypatch):
    _reset_db()
    from resmon import app

    captured: list = []
    monkeypatch.setattr(
        resmon_mod, "store_credential",
        lambda name, value: captured.append(name),
    )

    client = TestClient(app)
    for name in ("openai_api_key", "anthropic_api_key"):
        resp = client.put(f"/api/credentials/{name}", json={"value": "abc"})
        assert resp.status_code == 200
    assert set(captured) == {"openai_api_key", "anthropic_api_key"}
