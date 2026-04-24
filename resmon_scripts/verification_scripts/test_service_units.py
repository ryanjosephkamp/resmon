# resmon_scripts/verification_scripts/test_service_units.py
"""Verification tests for IMPL-26 — OS service units + Advanced toggle.

Covers:
* Template rendering resolves every ``{{PLACEHOLDER}}`` for the current OS.
* ``install()`` writes the unit file to the override path.
* ``uninstall()`` removes it.
* ``POST /api/service/install`` and ``/api/service/uninstall`` endpoints
  return the documented shape and flip ``is_installed()``.
* ``GET /api/service/status`` reflects state transitions.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

import resmon as resmon_mod
from implementation_scripts import service_manager


def _reset_app_db() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


@pytest.fixture
def unit_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("RESMON_SERVICE_UNIT_DIR", str(tmp_path / "units"))
    yield tmp_path / "units"


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------


def test_template_exists_for_each_platform():
    """All three template files exist in resmon_scripts/service_units/."""
    base = service_manager.TEMPLATES_DIR
    assert (base / "com.resmon.daemon.plist").exists()
    assert (base / "resmon-daemon.service").exists()
    assert (base / "resmon-daemon.task.xml").exists()


def test_render_resolves_all_placeholders_current_platform():
    rendered = service_manager.render_template(
        python="/opt/resmon/venv/bin/python",
        port=8742,
        workdir=Path("/opt/resmon/resmon_scripts"),
        log_dir=Path("/opt/resmon/logs"),
    )
    for placeholder in service_manager.REQUIRED_PLACEHOLDERS:
        assert placeholder not in rendered
    assert "/opt/resmon/venv/bin/python" in rendered
    assert "8742" in rendered
    assert "/opt/resmon/resmon_scripts" in rendered


@pytest.mark.parametrize("template_name,expected_markers", [
    ("com.resmon.daemon.plist", ["com.resmon.daemon", "RunAtLoad"]),
    ("resmon-daemon.service", ["[Service]", "ExecStart=", "WantedBy="]),
    ("resmon-daemon.task.xml", ["<Task", "implementation_scripts.daemon"]),
])
def test_render_each_template(template_name, expected_markers):
    tpl = service_manager.TEMPLATES_DIR / template_name
    rendered = service_manager.render_template(
        python="/usr/bin/python3",
        port=9000,
        workdir=Path("/tmp/resmon"),
        log_dir=Path("/tmp/resmon/logs"),
        template=tpl,
    )
    for marker in expected_markers:
        assert marker in rendered
    # Every required placeholder resolved (LOG_DIR may legitimately be unused
    # by the Windows XML template, and that's fine because render_template
    # already asserts nothing leaks through).
    for placeholder in service_manager.REQUIRED_PLACEHOLDERS:
        assert placeholder not in rendered


# ---------------------------------------------------------------------------
# install / uninstall on the filesystem
# ---------------------------------------------------------------------------


def test_install_writes_unit_file(unit_dir):
    assert not service_manager.is_installed()
    path = service_manager.install(port=8742, register=False)
    assert path.exists()
    assert service_manager.is_installed()
    assert path.read_text(encoding="utf-8").strip() != ""


def test_uninstall_removes_unit_file(unit_dir):
    service_manager.install(port=8742, register=False)
    assert service_manager.is_installed()
    removed = service_manager.uninstall(deregister=False)
    assert removed is True
    assert not service_manager.is_installed()


def test_uninstall_when_absent_returns_false(unit_dir):
    assert service_manager.uninstall(deregister=False) is False


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------


def test_service_status_endpoint(unit_dir):
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())
    resp = client.get("/api/service/status")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) >= {"installed", "unit_path", "platform"}
    assert body["installed"] is False


def test_service_install_uninstall_endpoints(unit_dir):
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())

    resp = client.post("/api/service/install", json={"register": False, "port": 8742})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"installed": True, "unit_path": str(service_manager.unit_path())}
    assert Path(body["unit_path"]).exists()

    # Status reflects installation
    status = client.get("/api/service/status").json()
    assert status["installed"] is True

    resp = client.post("/api/service/uninstall", json={"register": False})
    assert resp.status_code == 200
    body = resp.json()
    assert body["installed"] is False
    assert body["removed"] is True
    assert not Path(body["unit_path"]).exists()

    status = client.get("/api/service/status").json()
    assert status["installed"] is False


def test_install_endpoint_default_body(unit_dir):
    """POST with no body should still succeed (register defaults to False)."""
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())
    resp = client.post("/api/service/install")
    assert resp.status_code == 200
    assert resp.json()["installed"] is True
    # Cleanup
    client.post("/api/service/uninstall")
