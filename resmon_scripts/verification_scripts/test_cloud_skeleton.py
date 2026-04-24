# resmon_scripts/verification_scripts/test_cloud_skeleton.py
"""IMPL-27 — Cloud service skeleton verification.

Covers:
* No ``import keyring`` anywhere under ``resmon_scripts/cloud/`` (V-B2).
* ``create_app`` wires ``GET /api/v2/health`` and returns 200 (V-B1 offline).
* ``load_config`` raises when required env vars are missing.
* ``load_config`` parses ``ALLOWED_ORIGINS`` into a tuple.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

from cloud import __version__ as cloud_version
from cloud.app import create_app
from cloud.config import ConfigError, load_config


CLOUD_DIR = PROJECT_ROOT / "resmon_scripts" / "cloud"


FAKE_ENV: dict[str, str] = {
    "DATABASE_URL": "postgresql+psycopg://resmon:resmon_dev@127.0.0.1:5432/resmon",
    "OBJECT_STORE_ENDPOINT": "http://127.0.0.1:9000",
    "OBJECT_STORE_BUCKET": "resmon-artifacts",
    "JWT_ISSUER": "https://example.clerk.accounts.dev",
    "JWT_AUDIENCE": "resmon-cloud",
    "JWKS_URL": "https://example.clerk.accounts.dev/.well-known/jwks.json",
    "ALLOWED_ORIGINS": "http://localhost:5173,app://resmon",
    "LOG_LEVEL": "INFO",
}


# ---------------------------------------------------------------------------
# V-B2 — no keyring on the server
# ---------------------------------------------------------------------------


def test_no_keyring_import_under_cloud_package():
    """CI-enforced: ``import keyring`` must not appear under cloud/."""
    pattern = re.compile(r"^\s*(?:from|import)\s+keyring\b")
    offenders: list[Path] = []
    for py in CLOUD_DIR.rglob("*.py"):
        text = py.read_text(encoding="utf-8")
        for line in text.splitlines():
            if pattern.match(line):
                offenders.append(py)
                break
    assert offenders == [], (
        f"keyring import is forbidden under resmon_scripts/cloud/ "
        f"(see §7.2 of resmon_routines_and_accounts.md): {offenders}"
    )


# ---------------------------------------------------------------------------
# Config loader
# ---------------------------------------------------------------------------


def test_load_config_requires_all_vars():
    with pytest.raises(ConfigError):
        load_config(env={})


def test_load_config_parses_fake_env():
    cfg = load_config(env=FAKE_ENV)
    assert cfg.database_url == FAKE_ENV["DATABASE_URL"]
    assert cfg.object_store_bucket == "resmon-artifacts"
    assert cfg.allowed_origins == ("http://localhost:5173", "app://resmon")
    assert cfg.log_level == "INFO"
    # Optional variables fall back to None / default.
    assert cfg.redis_url is None
    assert cfg.kms_key_id is None


def test_load_config_log_level_defaults_to_info():
    env = dict(FAKE_ENV)
    env.pop("LOG_LEVEL")
    cfg = load_config(env=env)
    assert cfg.log_level == "INFO"


# ---------------------------------------------------------------------------
# V-B1 (offline variant) — /api/v2/health
# ---------------------------------------------------------------------------


def test_health_endpoint_returns_ok_with_fake_config():
    cfg = load_config(env=FAKE_ENV)
    client = TestClient(create_app(config=cfg))
    resp = client.get("/api/v2/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"status": "ok", "version": cloud_version}


def test_health_endpoint_works_without_allowed_origins():
    env = dict(FAKE_ENV)
    env.pop("ALLOWED_ORIGINS")
    client = TestClient(create_app(config=load_config(env=env)))
    assert client.get("/api/v2/health").status_code == 200
