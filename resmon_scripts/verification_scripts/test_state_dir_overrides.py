"""Packaged-app state must not live inside the app bundle.

When Electron spawns the bundled backend, ``PROJECT_ROOT`` resolves to
``Contents/Resources/backend`` — inside the .app. State written there is lost
on every update, and under Gatekeeper's app translocation the path may not be
writable at all. Electron main therefore passes ``RESMON_DB_PATH`` and
``RESMON_REPORTS_DIR`` pointing at the per-user state directory, and
``config.py`` must honour both.

The overrides are read at import time, so each case runs in a fresh
interpreter rather than reloading modules under the test runner's feet.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS = PROJECT_ROOT / "resmon_scripts"

_PROBE = (
    "from implementation_scripts.config import DEFAULT_DB_PATH, REPORTS_DIR;"
    "print(DEFAULT_DB_PATH);"
    "print(REPORTS_DIR)"
)


def _resolved_paths(extra_env: dict[str, str]) -> tuple[str, str]:
    env = {**os.environ, **extra_env}
    for key in ("RESMON_DB_PATH", "RESMON_REPORTS_DIR"):
        if key not in extra_env:
            env.pop(key, None)
    out = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=SCRIPTS, env=env, capture_output=True, text=True, timeout=60,
    )
    assert out.returncode == 0, out.stderr
    db, reports = out.stdout.strip().splitlines()
    return db, reports


def test_defaults_are_checkout_relative():
    db, reports = _resolved_paths({})
    assert db == str(PROJECT_ROOT / "resmon.db")
    assert reports == str(PROJECT_ROOT / "resmon_reports")


def test_env_overrides_win(tmp_path):
    db_target = tmp_path / "state" / "resmon.db"
    reports_target = tmp_path / "state" / "resmon_reports"
    db, reports = _resolved_paths({
        "RESMON_DB_PATH": str(db_target),
        "RESMON_REPORTS_DIR": str(reports_target),
    })
    assert db == str(db_target)
    assert reports == str(reports_target)


def test_empty_env_falls_back_to_defaults():
    """An empty string must not become a relative-path database in the cwd."""
    db, reports = _resolved_paths({"RESMON_DB_PATH": "", "RESMON_REPORTS_DIR": ""})
    assert db == str(PROJECT_ROOT / "resmon.db")
    assert reports == str(PROJECT_ROOT / "resmon_reports")
