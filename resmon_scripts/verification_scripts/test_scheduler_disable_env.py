"""Update 4 / Batch 2 / Fix D — RESMON_DISABLE_SCHEDULER env-var gate.

When the Electron main process spawns the backend as a fallback (because
no live daemon was found), it sets ``RESMON_DISABLE_SCHEDULER=1`` so the
spawned backend does not register a second APScheduler against the
shared SQLite jobstore. This test asserts that the FastAPI startup hook
honors the env var and that the default behavior (var unset) still
starts the scheduler.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import scheduler as scheduler_mod  # noqa: E402


def _reset() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod.scheduler = None
    scheduler_mod._dispatcher = None


def test_disable_scheduler_env_var_skips_scheduler(monkeypatch):
    monkeypatch.setenv("RESMON_DISABLE_SCHEDULER", "1")
    _reset()
    with TestClient(resmon_mod.create_app()):
        assert resmon_mod.scheduler is None, (
            "RESMON_DISABLE_SCHEDULER=1 must prevent ResmonScheduler "
            "instantiation in the renderer-spawned fallback backend."
        )
        assert scheduler_mod._dispatcher is None, (
            "Dispatcher must not be installed when the scheduler is disabled."
        )


def test_default_starts_scheduler(monkeypatch):
    monkeypatch.delenv("RESMON_DISABLE_SCHEDULER", raising=False)
    _reset()
    with TestClient(resmon_mod.create_app()):
        assert resmon_mod.scheduler is not None, (
            "Without RESMON_DISABLE_SCHEDULER, the daemon / direct-launch "
            "path must continue to start the scheduler."
        )
        assert scheduler_mod._dispatcher is not None


def test_disable_scheduler_env_var_value_other_than_one(monkeypatch):
    """Only the literal string '1' disables the scheduler; '0', 'false',
    and the empty string must leave it enabled."""
    for val in ("0", "false", "", "true"):
        monkeypatch.setenv("RESMON_DISABLE_SCHEDULER", val)
        _reset()
        with TestClient(resmon_mod.create_app()):
            assert resmon_mod.scheduler is not None, (
                f"RESMON_DISABLE_SCHEDULER={val!r} must NOT disable the scheduler "
                f"(only the literal '1' is the off-switch)."
            )


def test_routine_crud_no_ops_when_scheduler_disabled(monkeypatch):
    """With the scheduler disabled, routine CRUD endpoints must still
    succeed (they no-op the scheduler-sync helpers when ``scheduler is
    None``)."""
    monkeypatch.setenv("RESMON_DISABLE_SCHEDULER", "1")
    _reset()
    with TestClient(resmon_mod.create_app()) as client:
        body = {
            "name": "r-no-sched",
            "schedule_cron": "0 8 * * *",
            "parameters": {"query": "x", "repositories": ["arxiv"]},
            "is_active": True,
            "execution_location": "local",
        }
        resp = client.post("/api/routines", json=body)
        assert resp.status_code == 201
        rid = resp.json()["id"]

        resp = client.delete(f"/api/routines/{rid}")
        assert resp.status_code == 200
        assert resmon_mod.scheduler is None
