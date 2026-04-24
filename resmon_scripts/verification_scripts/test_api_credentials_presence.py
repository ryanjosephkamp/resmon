# resmon_scripts/verification_scripts/test_api_credentials_presence.py
"""Tests for GET /api/credentials (presence-only; no raw values) — IMPL-23."""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

import resmon as resmon_mod
from implementation_scripts.repo_catalog import credential_names
from implementation_scripts.credential_manager import (
    AI_CREDENTIAL_NAMES,
    SMTP_CREDENTIAL_NAMES,
)


def _reset_db():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def test_credentials_presence_lists_all_expected_names(monkeypatch):
    """All catalog credential names plus the two LLM keys must appear."""
    _reset_db()
    from resmon import app

    # Stub get_credential so the test never reads the real OS keyring.
    monkeypatch.setattr(resmon_mod, "get_credential", lambda _name: None)

    client = TestClient(app)
    resp = client.get("/api/credentials")
    assert resp.status_code == 200
    data = resp.json()
    expected = credential_names() | AI_CREDENTIAL_NAMES | SMTP_CREDENTIAL_NAMES
    assert set(data.keys()) == expected


def test_credentials_presence_returns_only_presence_flag(monkeypatch):
    """Response values are dicts with exactly {'present': bool}, no secrets."""
    _reset_db()
    from resmon import app

    monkeypatch.setattr(
        resmon_mod, "get_credential",
        lambda name: "secret-value" if name == "core_api_key" else None,
    )

    client = TestClient(app)
    resp = client.get("/api/credentials")
    data = resp.json()
    for name, entry in data.items():
        assert set(entry.keys()) == {"present"}
        assert isinstance(entry["present"], bool)

    assert data["core_api_key"]["present"] is True
    assert data["ieee_api_key"]["present"] is False
    # No raw value anywhere in the response.
    assert "secret-value" not in resp.text
