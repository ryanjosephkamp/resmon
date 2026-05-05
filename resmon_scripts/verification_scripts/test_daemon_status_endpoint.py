# resmon_scripts/verification_scripts/test_daemon_status_endpoint.py
"""Verification tests for Update 4 / Fix E — GET /api/service/daemon-status.

The Advanced tab must surface the *real* daemon's identity, read from
``daemon.lock`` and verified against the daemon's actual port, rather
than echoing whichever backend the renderer happens to be attached to.
This suite exercises the three branches:

* No lock file -> ``lock_present=False, running=False``.
* Lock file present and probe succeeds -> ``running=True`` with daemon
  pid / version / started_at.
* Lock file present but probe fails (wrong / dead port) -> ``running=False``
  with an ``error`` populated.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

import resmon as resmon_mod
from implementation_scripts import daemon as daemon_mod
from implementation_scripts.config import APP_VERSION


def _reset_app_db() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


@pytest.fixture
def lock_path(tmp_path, monkeypatch):
    """Redirect the daemon lock file to a tmp path for the duration of a test."""
    p = tmp_path / "daemon.lock"
    monkeypatch.setattr(daemon_mod, "lock_path", lambda: p)
    yield p


def test_no_lock_returns_not_running(lock_path):
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())
    resp = client.get("/api/service/daemon-status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["lock_present"] is False
    assert body["running"] is False
    assert body["pid"] is None
    assert body["port"] is None
    assert body["error"] is None


def test_lock_present_probe_fails(lock_path):
    """A stale lock pointing at a closed port must report running=False with an error."""
    lock_path.write_text(
        json.dumps({"pid": 99999, "port": 1, "version": APP_VERSION}),
        encoding="utf-8",
    )
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())
    resp = client.get("/api/service/daemon-status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["lock_present"] is True
    assert body["running"] is False
    assert body["lock_pid"] == 99999
    assert body["lock_port"] == 1
    assert body["lock_version"] == APP_VERSION
    assert body["error"]  # populated


def test_lock_present_probe_succeeds(lock_path, monkeypatch):
    """When the probed port answers /api/health, surface the daemon's identity."""

    class _FakeResponse:
        status_code = 200

        def json(self):
            return {
                "status": "ok",
                "pid": 4242,
                "started_at": "2026-05-05T00:00:00+00:00",
                "version": APP_VERSION,
            }

    class _FakeClient:
        def __init__(self, *_, **__):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def get(self, _url):
            return _FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "Client", _FakeClient)

    lock_path.write_text(
        json.dumps({"pid": 4242, "port": 8742, "version": APP_VERSION}),
        encoding="utf-8",
    )
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())
    resp = client.get("/api/service/daemon-status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["lock_present"] is True
    assert body["running"] is True
    assert body["pid"] == 4242
    assert body["port"] == 8742
    assert body["version"] == APP_VERSION
    assert body["started_at"] == "2026-05-05T00:00:00+00:00"
    assert body["error"] is None
