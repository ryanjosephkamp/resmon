"""IMPL-30 verification — local daemon's ``/api/cloud-auth/*`` endpoints.

Hermetic: monkeypatches ``store_credential``/``get_credential``/
``delete_credential`` inside ``resmon`` so no real OS keyring is touched,
and monkeypatches ``httpx.post`` for the refresh exchange so no network
call is attempted. A fresh in-memory SQLite connection is wired per test
via the module-level ``_db_path = ':memory:'`` trick used by the other
``test_*`` modules.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402


def _reset_db() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


class _FakeKeyring:
    """Pure-Python stand-in for the three credential_manager helpers."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    def get(self, name: str) -> str | None:
        return self.store.get(name)

    def put(self, name: str, value: str) -> None:
        self.store[name] = value

    def delete(self, name: str) -> None:
        self.store.pop(name, None)


@pytest.fixture
def kr(monkeypatch) -> _FakeKeyring:
    _reset_db()
    fake = _FakeKeyring()
    monkeypatch.setattr(resmon_mod, "store_credential", fake.put)
    monkeypatch.setattr(resmon_mod, "get_credential", fake.get)
    monkeypatch.setattr(resmon_mod, "delete_credential", fake.delete)
    return fake


@pytest.fixture
def client() -> TestClient:
    return TestClient(resmon_mod.app)


# ---------------------------------------------------------------------------
# POST /api/cloud-auth/session
# ---------------------------------------------------------------------------


def test_post_session_stores_refresh_under_expected_key(kr, client):
    resp = client.post(
        "/api/cloud-auth/session",
        json={"refresh_token": "rt-abc-123", "email": "u@example.test"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["signed_in"] is True
    assert body["email"] == "u@example.test"
    # This is the critical IMPL-30 contract: exact keyring account name.
    assert kr.store == {"cloud_refresh_token": "rt-abc-123"}


def test_post_session_rejects_empty_refresh(kr, client):
    resp = client.post("/api/cloud-auth/session", json={"refresh_token": ""})
    assert resp.status_code == 400
    assert kr.store == {}


# ---------------------------------------------------------------------------
# GET /api/cloud-auth/status
# ---------------------------------------------------------------------------


def test_status_reflects_signed_out_then_signed_in(kr, client):
    out = client.get("/api/cloud-auth/status").json()
    assert out["signed_in"] is False
    assert out["email"] == ""
    assert out["sync_state"] == "off"

    client.post(
        "/api/cloud-auth/session",
        json={"refresh_token": "rt-xyz", "email": "a@b.test"},
    )
    after = client.get("/api/cloud-auth/status").json()
    assert after["signed_in"] is True
    assert after["email"] == "a@b.test"


# ---------------------------------------------------------------------------
# DELETE /api/cloud-auth/session
# ---------------------------------------------------------------------------


def test_delete_session_clears_keyring_and_email(kr, client):
    client.post(
        "/api/cloud-auth/session",
        json={"refresh_token": "rt-to-wipe", "email": "e@e.test"},
    )
    assert "cloud_refresh_token" in kr.store

    resp = client.delete("/api/cloud-auth/session")
    assert resp.status_code == 200
    assert resp.json() == {"signed_in": False}
    assert "cloud_refresh_token" not in kr.store

    after = client.get("/api/cloud-auth/status").json()
    assert after["signed_in"] is False
    assert after["email"] == ""


# ---------------------------------------------------------------------------
# POST /api/cloud-auth/refresh
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict[str, Any] | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict[str, Any]:
        return self._payload


def _patch_httpx(monkeypatch, handler: Callable[..., _FakeResponse]) -> list:
    calls: list = []

    def _post(url, *args, **kwargs):
        calls.append((url, kwargs.get("json")))
        return handler(url, *args, **kwargs)

    monkeypatch.setattr(resmon_mod.httpx, "post", _post)
    return calls


def test_refresh_returns_501_when_url_not_configured(kr, client, monkeypatch):
    monkeypatch.delenv("CLOUD_IDP_REFRESH_URL", raising=False)
    kr.put("cloud_refresh_token", "rt-present")
    resp = client.post("/api/cloud-auth/refresh")
    assert resp.status_code == 501


def test_refresh_returns_401_when_not_signed_in(kr, client, monkeypatch):
    monkeypatch.setenv("CLOUD_IDP_REFRESH_URL", "https://idp.invalid/refresh")
    resp = client.post("/api/cloud-auth/refresh")
    assert resp.status_code == 401


def test_refresh_exchanges_and_rotates(kr, client, monkeypatch):
    monkeypatch.setenv("CLOUD_IDP_REFRESH_URL", "https://idp.invalid/refresh")
    kr.put("cloud_refresh_token", "rt-old")

    def _ok(url, *args, **kwargs):
        return _FakeResponse(
            200,
            {
                "access_token": "at-new",
                "expires_in": 1200,
                "refresh_token": "rt-new",
            },
        )

    calls = _patch_httpx(monkeypatch, _ok)

    resp = client.post("/api/cloud-auth/refresh")
    assert resp.status_code == 200
    body = resp.json()
    assert body["access_token"] == "at-new"
    assert body["expires_in"] == 1200

    # IdP was called with the OLD refresh token…
    assert calls[0][0] == "https://idp.invalid/refresh"
    assert calls[0][1] == {"refresh_token": "rt-old"}
    # …and the rotated refresh landed in the keyring.
    assert kr.store["cloud_refresh_token"] == "rt-new"


def test_refresh_without_rotation_keeps_existing(kr, client, monkeypatch):
    monkeypatch.setenv("CLOUD_IDP_REFRESH_URL", "https://idp.invalid/refresh")
    kr.put("cloud_refresh_token", "rt-stable")

    _patch_httpx(
        monkeypatch,
        lambda *a, **kw: _FakeResponse(200, {"access_token": "at-1", "expires_in": 900}),
    )

    resp = client.post("/api/cloud-auth/refresh")
    assert resp.status_code == 200
    assert resp.json()["access_token"] == "at-1"
    assert kr.store["cloud_refresh_token"] == "rt-stable"


def test_refresh_upstream_401_clears_stored_refresh(kr, client, monkeypatch):
    monkeypatch.setenv("CLOUD_IDP_REFRESH_URL", "https://idp.invalid/refresh")
    kr.put("cloud_refresh_token", "rt-rejected")

    _patch_httpx(monkeypatch, lambda *a, **kw: _FakeResponse(401))

    resp = client.post("/api/cloud-auth/refresh")
    assert resp.status_code == 401
    # The rejected refresh must be purged so the UI forces re-sign-in.
    assert "cloud_refresh_token" not in kr.store


# ---------------------------------------------------------------------------
# PUT /api/cloud-auth/sync
# ---------------------------------------------------------------------------


def test_sync_toggle_updates_setting(kr, client):
    assert client.get("/api/cloud-auth/status").json()["sync_state"] == "off"

    on = client.put("/api/cloud-auth/sync", json={"enabled": True})
    assert on.status_code == 200
    assert on.json() == {"sync_state": "on"}
    assert client.get("/api/cloud-auth/status").json()["sync_state"] == "on"

    off = client.put("/api/cloud-auth/sync", json={"enabled": False})
    assert off.status_code == 200
    assert off.json() == {"sync_state": "off"}
    assert client.get("/api/cloud-auth/status").json()["sync_state"] == "off"
