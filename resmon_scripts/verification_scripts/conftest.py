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


def _join_execution_threads() -> None:
    """Block until every pipeline worker thread has finished."""
    for thread in list(threading.enumerate()):
        if thread.name.startswith(_EXEC_THREAD_PREFIX) and thread.is_alive():
            thread.join(_JOIN_TIMEOUT_SEC)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    """Wait for pipeline worker threads before any fixture teardown runs.

    ``_launch_execution`` runs each execution on a daemon thread named
    ``exec-<id>`` that outlives the HTTP request, and several modules define a
    ``_fresh_db`` fixture that closes the shared sqlite connection on teardown.
    Closing it out from under a thread still in its ``finally`` block produced
    ``ProgrammingError: Cannot operate on a closed database`` on Python 3.10 and
    3.11, and the blunter ``InterfaceError: bad parameter or other API misuse``
    on 3.12 - which is how CI caught it while a local 3.11 run stayed green.

    This has to be a hook rather than an autouse fixture. Fixtures finalise in
    reverse order of setup, and a conftest fixture is set up before a module's
    own - so it would tear down *after* ``_fresh_db`` had already closed the
    connection, which is exactly the window being closed here. ``pytest_runtest_call``
    wraps the test body itself, so the join lands before any teardown at all.

    The interference is worse than a stray log line: every test gets a fresh
    ``:memory:`` database so execution ids restart at 1, while ``progress_store``
    is a process-wide singleton. A leftover worker's cleanup would delete the
    store entry for id 1 belonging to the *next* test, taking its live progress
    events with it.
    """
    yield
    _join_execution_threads()
