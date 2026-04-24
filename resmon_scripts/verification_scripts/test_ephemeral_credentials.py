# resmon_scripts/verification_scripts/test_ephemeral_credentials.py
"""Tests for per-execution ephemeral credential store (IMPL-23)."""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import credential_manager as cm
from implementation_scripts.credential_manager import (
    push_ephemeral,
    pop_ephemeral,
    get_credential_for,
)


def _isolate(monkeypatch):
    """Force keyring fallback to always return None so tests are deterministic."""
    monkeypatch.setattr(cm, "get_credential", lambda _name: None)


def test_push_pop_roundtrip(monkeypatch):
    _isolate(monkeypatch)
    push_ephemeral(42, {"core_api_key": "eph-value"})
    assert get_credential_for(42, "core_api_key") == "eph-value"
    pop_ephemeral(42)
    assert get_credential_for(42, "core_api_key") is None


def test_ephemeral_isolated_between_exec_ids(monkeypatch):
    _isolate(monkeypatch)
    push_ephemeral(1, {"core_api_key": "one"})
    push_ephemeral(2, {"core_api_key": "two"})
    assert get_credential_for(1, "core_api_key") == "one"
    assert get_credential_for(2, "core_api_key") == "two"
    pop_ephemeral(1)
    pop_ephemeral(2)


def test_ephemeral_does_not_affect_get_credential(monkeypatch):
    """Raw get_credential (persisted path) must not see ephemeral values."""
    captured: dict[str, object] = {}

    def _fake_keyring(name):
        captured["calls"] = captured.get("calls", 0) + 1
        return None

    monkeypatch.setattr(cm, "get_credential", _fake_keyring)
    push_ephemeral(99, {"core_api_key": "ephemeral-only"})
    try:
        # get_credential_for with matching exec_id → ephemeral hit.
        assert get_credential_for(99, "core_api_key") == "ephemeral-only"
        # get_credential_for with a different exec_id → keyring fallback.
        assert get_credential_for(100, "core_api_key") is None
        # exec_id=None → always keyring fallback.
        assert get_credential_for(None, "core_api_key") is None
    finally:
        pop_ephemeral(99)


def test_empty_push_does_not_create_scope(monkeypatch):
    _isolate(monkeypatch)
    push_ephemeral(7, {})
    push_ephemeral(8, None)
    push_ephemeral(9, {"core_api_key": "   "})  # whitespace-only is dropped
    for exec_id in (7, 8, 9):
        assert get_credential_for(exec_id, "core_api_key") is None


def test_pop_noop_on_unknown_exec_id(monkeypatch):
    _isolate(monkeypatch)
    # Should not raise.
    pop_ephemeral(12345)


def test_push_replaces_existing_scope(monkeypatch):
    _isolate(monkeypatch)
    push_ephemeral(5, {"core_api_key": "old"})
    push_ephemeral(5, {"core_api_key": "new"})
    assert get_credential_for(5, "core_api_key") == "new"
    pop_ephemeral(5)


def test_ephemeral_value_not_logged(monkeypatch, caplog):
    _isolate(monkeypatch)
    with caplog.at_level("DEBUG", logger="implementation_scripts.credential_manager"):
        push_ephemeral(11, {"core_api_key": "super-secret-value"})
        get_credential_for(11, "core_api_key")
        pop_ephemeral(11)
    for record in caplog.records:
        assert "super-secret-value" not in record.getMessage()
