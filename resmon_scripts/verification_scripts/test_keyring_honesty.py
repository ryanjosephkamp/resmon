"""A keyring that will not answer must not be reported as "no key set".

Found on a real install, 2026-08-20: macOS binds keychain access to an app's
code signature, so an unsigned build is denied items an earlier build stored.
The denial arrives as a prompt no background process can answer, the call
times out, and the app told the user their keys were absent — while they sat
in the keychain untouched. Silently behaving as unconfigured is exactly the
class of lie phase 1.7 exists to remove.

Two behaviours are pinned here:

1.  ``probe_credential`` distinguishes present / absent / unreadable, and the
    presence endpoint reports it plus a top-level responsiveness flag.
2.  A stalled keyring costs ONE timeout per sweep, not one per stored key.
    Fifteen credential names at five seconds each is over a minute of stall.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import credential_manager as cm  # noqa: E402


@pytest.fixture(autouse=True)
def _fast_and_clean(monkeypatch):
    """Short timeout so a 'hang' costs milliseconds, and a reset breaker."""
    monkeypatch.setattr(cm, "_KEYRING_TIMEOUT_SEC", 0.05)
    monkeypatch.setattr(cm, "_KEYRING_COOLDOWN_SEC", 30.0)
    cm._reset_breaker()
    yield
    cm._reset_breaker()


def _client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app
    return TestClient(app)


class _Hanging:
    """A keyring backend that never returns, like a keychain awaiting consent."""

    def __init__(self):
        self.calls = 0

    def get_password(self, service, name):
        self.calls += 1
        time.sleep(30)  # daemon thread; abandoned by the timeout


def test_probe_distinguishes_absent_from_unreadable(monkeypatch):
    monkeypatch.setattr(cm.keyring, "get_password", lambda s, n: None)
    assert cm.probe_credential("openai_api_key") == cm.ABSENT

    monkeypatch.setattr(cm.keyring, "get_password", lambda s, n: "sk-live")
    assert cm.probe_credential("openai_api_key") == cm.PRESENT

    hanging = _Hanging()
    monkeypatch.setattr(cm.keyring, "get_password", hanging.get_password)
    cm._reset_breaker()
    assert cm.probe_credential("openai_api_key") == cm.UNREADABLE


def test_a_stalled_keyring_costs_one_timeout_not_fifteen(monkeypatch):
    hanging = _Hanging()
    monkeypatch.setattr(cm.keyring, "get_password", hanging.get_password)

    for name in [f"key_{i}" for i in range(15)]:
        assert cm.probe_credential(name) == cm.UNREADABLE

    assert hanging.calls == 1, (
        f"the breaker should short-circuit after the first timeout, "
        f"but the backend was called {hanging.calls} times"
    )


def test_breaker_reopens_after_the_cooldown(monkeypatch):
    hanging = _Hanging()
    monkeypatch.setattr(cm.keyring, "get_password", hanging.get_password)
    assert cm.probe_credential("openai_api_key") == cm.UNREADABLE
    assert not cm.keyring_is_responsive()

    monkeypatch.setattr(cm, "_KEYRING_COOLDOWN_SEC", 0.0)
    cm._trip_breaker()
    assert cm.keyring_is_responsive(), "a lapsed cooldown must allow a retry"

    monkeypatch.setattr(cm.keyring, "get_password", lambda s, n: "sk-live")
    assert cm.probe_credential("openai_api_key") == cm.PRESENT
    assert cm.keyring_is_responsive(), "a success must close the breaker"


def test_writes_ignore_the_breaker(monkeypatch):
    """A user-initiated save always gets a real attempt; a prompt may surface."""
    cm._trip_breaker()
    stored = {}
    monkeypatch.setattr(cm.keyring, "set_password",
                        lambda s, n, v: stored.__setitem__(n, v))
    cm.store_credential("openai_api_key", "sk-live")
    assert stored == {"openai_api_key": "sk-live"}


def test_endpoint_reports_unreadable_and_flags_the_keyring(monkeypatch):
    client = _client()
    hanging = _Hanging()
    monkeypatch.setattr(cm.keyring, "get_password", hanging.get_password)
    cm._reset_breaker()

    body = client.get("/api/credentials").json()

    assert body["keyring_responsive"] is False
    creds = body["credentials"]
    assert creds, "every known credential name should still be listed"
    for name, entry in creds.items():
        assert entry["status"] == "unreadable", name
        assert entry["present"] is False, f"{name} must not claim to be present"


def test_endpoint_reports_present_and_absent_normally(monkeypatch):
    client = _client()
    monkeypatch.setattr(
        cm.keyring, "get_password",
        lambda s, n: "sk-live" if n == "openai_api_key" else None,
    )

    body = client.get("/api/credentials").json()

    assert body["keyring_responsive"] is True
    creds = body["credentials"]
    assert creds["openai_api_key"] == {"present": True, "status": "present"}
    assert creds["core_api_key"] == {"present": False, "status": "absent"}
