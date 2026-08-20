# resmon_scripts/verification_scripts/test_api_credentials_presence.py
"""Tests for GET /api/credentials (status-only; no raw values) — IMPL-23.

The response gained a ``status`` per credential and a top-level
``keyring_responsive`` in 1.7, so that an unreadable keyring is never reported
as "no key set" (see test_keyring_honesty.py). The contract these tests exist
to protect is unchanged and is the important one: the endpoint reports
*whether* a credential exists and never what it is.
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

import resmon as resmon_mod
from implementation_scripts.repo_catalog import credential_names
from implementation_scripts.credential_manager import (
    ABSENT,
    AI_CREDENTIAL_NAMES,
    PRESENT,
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

    # Stub the probe so the test never reads the real OS keyring.
    monkeypatch.setattr(resmon_mod, "probe_credential", lambda _name: ABSENT)

    client = TestClient(app)
    resp = client.get("/api/credentials")
    assert resp.status_code == 200
    data = resp.json()
    expected = credential_names() | AI_CREDENTIAL_NAMES | SMTP_CREDENTIAL_NAMES
    assert set(data["credentials"].keys()) == expected
    assert data["keyring_responsive"] is True


def test_credentials_presence_returns_only_status_never_values(monkeypatch):
    """Entries carry presence and status only — never the credential itself."""
    _reset_db()
    from resmon import app

    monkeypatch.setattr(
        resmon_mod, "probe_credential",
        lambda name: PRESENT if name == "core_api_key" else ABSENT,
    )

    client = TestClient(app)
    resp = client.get("/api/credentials")
    data = resp.json()
    for name, entry in data["credentials"].items():
        assert set(entry.keys()) == {"present", "status"}
        assert isinstance(entry["present"], bool)
        assert entry["status"] in {"present", "absent", "unreadable"}

    assert data["credentials"]["core_api_key"] == {"present": True, "status": "present"}
    assert data["credentials"]["ieee_api_key"] == {"present": False, "status": "absent"}
    # No raw value anywhere in the response.
    assert "secret-value" not in resp.text
