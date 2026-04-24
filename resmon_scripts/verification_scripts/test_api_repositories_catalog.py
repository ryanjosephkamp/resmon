# resmon_scripts/verification_scripts/test_api_repositories_catalog.py
"""Tests for GET /api/repositories/catalog (IMPL-23)."""

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


def test_catalog_endpoint_returns_fifteen_entries():
    _reset_db()
    from resmon import app
    client = TestClient(app)

    resp = client.get("/api/repositories/catalog")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 15


def test_catalog_entries_have_expected_keys():
    _reset_db()
    from resmon import app
    client = TestClient(app)

    resp = client.get("/api/repositories/catalog")
    entry = resp.json()[0]
    for key in (
        "slug", "name", "description", "subject_coverage", "endpoint",
        "query_method", "rate_limit", "client_module",
        "api_key_requirement", "credential_name",
        "website", "registration_url", "placeholder",
    ):
        assert key in entry, key


def test_catalog_contains_no_secrets():
    """Catalog must not leak raw credential values even by accident."""
    _reset_db()
    from resmon import app
    client = TestClient(app)

    resp = client.get("/api/repositories/catalog")
    body = resp.text
    # Secrets would typically surface as long high-entropy strings; we
    # restrict ourselves to checking that no field named suspiciously is
    # present in any entry.
    for entry in resp.json():
        assert "value" not in entry
        assert "api_key" not in entry
        assert "secret" not in entry
