"""Shared pytest configuration for the resmon verification suite.

There was no ``conftest.py`` here before, which is why two whole classes of
flakiness went unaddressed: the suite raced its own background threads, and it
reached for the developer's real OS keychain.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Import paths
# ---------------------------------------------------------------------------
#
# Three test modules import via the full package path (``from
# resmon_scripts.cloud.rate_limit import ...``), which needs the repository root
# on sys.path, and most of the rest import ``resmon`` and
# ``implementation_scripts`` directly, which needs ``resmon_scripts/``.
#
# Both used to work only by accident: ``python -m pytest`` puts the working
# directory on sys.path, the bare ``pytest`` console script does not. The suite
# therefore passed locally and failed in CI with ``No module named
# 'resmon_scripts'``. Setting both here makes the suite independent of how it
# was invoked and from which directory.
_REPO_ROOT = Path(__file__).resolve().parents[2]
for _path in (_REPO_ROOT, _REPO_ROOT / "resmon_scripts"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

# ---------------------------------------------------------------------------
# Keyring isolation
# ---------------------------------------------------------------------------
#
# Executions and cloud-status checks read credentials, and on macOS the real
# keychain backend blocks on a GUI authorisation prompt that nothing can answer
# during a test run. Before the bounded-timeout gate in credential_manager that
# hung the suite indefinitely; with it, the suite would still pay the timeout on
# every lookup. Tests must not touch the developer's keychain at all.
#
# An in-memory backend rather than ``null.Keyring``: the null backend cannot
# store anything, which breaks the tests that legitimately round-trip a
# credential. This one is a real, working keyring that simply never leaves the
# process.
os.environ.setdefault("RESMON_KEYRING_TIMEOUT", "2.0")

import keyring  # noqa: E402
from keyring.backend import KeyringBackend  # noqa: E402


class InMemoryKeyring(KeyringBackend):
    """A functional keyring that lives and dies with the test process."""

    priority = 1  # type: ignore[assignment]

    def __init__(self) -> None:
        super().__init__()
        self._store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str):
        return self._store.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self._store[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        try:
            del self._store[(service, username)]
        except KeyError:
            from keyring.errors import PasswordDeleteError
            raise PasswordDeleteError(username) from None


keyring.set_keyring(InMemoryKeyring())


# ---------------------------------------------------------------------------
# Execution-thread quiescence
# ---------------------------------------------------------------------------

_EXEC_THREAD_PREFIX = "exec-"
_JOIN_TIMEOUT_SEC = 10.0


@pytest.fixture(autouse=True)
def _join_execution_threads():
    """Wait for pipeline worker threads to finish before the next test starts.

    ``_launch_execution`` runs each execution on a daemon thread named
    ``exec-<id>`` that outlives the HTTP request. Test fixtures that close the
    shared sqlite connection on teardown were therefore closing it out from
    under a thread still in its ``finally`` block, producing
    ``ProgrammingError: Cannot operate on a closed database``.

    The interference is worse than a stray log line. Every test gets a fresh
    ``:memory:`` database, so execution ids restart at 1 each time, while
    ``progress_store`` is a module-level singleton shared across the whole
    session. A leftover worker from the previous test finishing its cleanup
    would delete the store entry for id 1 - which by then belongs to the
    *current* test's execution - and take its live progress events with it.

    Joining here makes each test start from a quiet process.
    """
    yield
    deadline_threads = [
        t for t in threading.enumerate()
        if t.name.startswith(_EXEC_THREAD_PREFIX) and t.is_alive()
    ]
    for t in deadline_threads:
        t.join(_JOIN_TIMEOUT_SEC)
