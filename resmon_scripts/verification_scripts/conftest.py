"""Shared pytest configuration for the resmon verification suite.

There was no ``conftest.py`` here before, which is why two whole classes of
flakiness went unaddressed: the suite raced its own background threads, and it
reached for the developer's real OS keychain.
"""

from __future__ import annotations

import os
import sys
import threading
import warnings
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

from resmon_scripts.verification_scripts.live_evidence import (  # noqa: E402
    LiveEvidenceWriter,
    QuarantineEntry,
    disposition_sentence,
    load_quarantine,
    quarantine_disposition,
    quarantine_line,
    utc_today,
)
from resmon_scripts.verification_scripts.deselection_report import (  # noqa: E402
    HEADING as _DESELECTION_HEADING,
    as_markdown as _deselection_markdown,
    project_marker_names as _project_marker_names,
    render as _render_deselection,
)


_LIVE_EVIDENCE: LiveEvidenceWriter | None = None

# Every case this run took out of the collection: ``(nodeid, marker names)``.
# Filled by ``pytest_deselected`` and reported by ``pytest_terminal_summary``.
# See ``deselection_report.py`` for why a green gate has to say this out loud.
_DESELECTED: list[tuple[str, list[str]]] = []

# How many cases the run did go on to select, set at collection.
_SELECTED: dict[str, int] = {"count": 0}

# The provider-outage quarantine for this session: live node id -> entry.
# Empty unless the session collected live cases. See ``live_evidence.py``.
_QUARANTINE: dict[str, QuarantineEntry] = {}
_QUARANTINE_STATE: dict = {"line": None, "today": None, "error": None, "seen": []}


def pytest_configure(config):
    """Enable durable live evidence only when the workflow supplies a directory."""
    global _LIVE_EVIDENCE
    root = os.environ.get("RESMON_LIVE_EVIDENCE_DIR")
    if not root:
        return
    identity = {
        "candidate_sha": os.environ.get("RESMON_LIVE_CANDIDATE_SHA", "unknown"),
        "checkout_sha": os.environ.get("RESMON_LIVE_CHECKOUT_SHA", "unknown"),
        "selection": os.environ.get("RESMON_LIVE_SELECTION", "unknown"),
        "github_run_id": os.environ.get("GITHUB_RUN_ID", "local"),
        "github_run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "local"),
        "github_job": os.environ.get("GITHUB_JOB", "local"),
    }
    try:
        _LIVE_EVIDENCE = LiveEvidenceWriter(Path(root), identity)
    except Exception as exc:
        config._resmon_live_evidence_error = True
        print(
            f"live evidence reporter initialization failed: {type(exc).__name__}",
            file=sys.stderr,
        )


def pytest_collection_finish(session):
    _SELECTED["count"] = len(session.items)
    records: list[dict] = []
    live = {
        item.nodeid for item in session.items
        if item.get_closest_marker("live_network") is not None
    }
    _QUARANTINE.clear()
    if live:
        # Loaded only when live cases were collected, so a hermetic run never
        # depends on it. An unreadable policy excuses nothing and fails the
        # session at the end, rather than being silently ignored.
        today = utc_today()
        try:
            entries = load_quarantine()
        except Exception as exc:
            entries = []
            _QUARANTINE_STATE["error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
        _QUARANTINE.update({entry.nodeid: entry for entry in entries if entry.nodeid in live})
        _QUARANTINE_STATE["today"] = today
        _QUARANTINE_STATE["line"] = quarantine_line(live, entries, today)
        records = [entry.record(today) for entry in _QUARANTINE.values()]
    writer = _LIVE_EVIDENCE
    if writer is not None:
        writer.safe(
            writer.collection,
            [item.nodeid for item in session.items],
            os.environ.get("RESMON_LIVE_SELECTION", "unknown"),
            records,
        )


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item, call):
    """Apply the provider-outage quarantine to one live call.

    Only the call phase of a quarantined live case is considered. A failure
    is excused only when ``quarantine_disposition`` says so, and it becomes
    an xfail: pytest's own vocabulary for "ran, failed, expected to", so the
    exit status and the evidence agree without a second mechanism. Every
    other disposition leaves the report as it was and says what happened.
    """
    report = yield
    entry = _QUARANTINE.get(item.nodeid)
    if entry is None or call.when != "call":
        return report
    today = _QUARANTINE_STATE["today"]
    disposition, history = quarantine_disposition(
        entry, today,
        call_outcome=report.outcome,
        assertion_failure=(
            call.excinfo is not None and call.excinfo.errisinstance(AssertionError)
        ),
        recorded=[value for name, value in item.user_properties if name == "source_outcome"],
    )
    if disposition is None:
        return report
    record = entry.record(today)
    if disposition == "excused":
        report.outcome = "skipped"
        report.wasxfail = disposition_sentence(item.nodeid, disposition, record, history)
    report.user_properties.append(
        ("quarantine", {"entry": record, "disposition": disposition, "history": history}))
    _QUARANTINE_STATE["seen"].append(
        disposition_sentence(item.nodeid, disposition, record, history))
    return report


# ---------------------------------------------------------------------------
# Test ids a log reader can actually receive
# ---------------------------------------------------------------------------
#
# Every Backend job log in this repository has been silently cut in half, on
# passing runs as well as failing ones, and the cause is a test id.
#
# ``ci.yml`` runs ``pytest -v`` so that the last line printed names the last
# test that finished — pytest-timeout's dump does not say which item it killed,
# and in quiet mode a hang leaves a row of dots to count. With ``-v`` every
# parametrised case prints its id, and
# ``test_evidence_reader.py``'s bounds case carries ``b"a" * 262144`` as a
# parameter, which pytest renders *into the id*. The collected line is 262,284
# bytes. ``gh run view --log`` reads with Go's ``bufio.Scanner`` at its default
# 64 KiB limit and stops, unchecked, at the first line over it — measured at
# 1,872 of 3,740 lines on three jobs, including a passing one, the cut always
# landing at (first over-long line − 1).
#
# So the flag chosen to make the log name the culprit is the flag that stops
# anyone reading as far as it. Capping the id fixes it once, for every
# oversized parameter anybody adds later, rather than per test.
#
# The cap keeps ids distinguishing: the two byte cases that mattered become
# ``raw-bytes262144`` and ``raw-bytes262145``, which differ exactly where the
# test does. Returning ``None`` hands the value back to pytest's own
# generation, so every short parameter is untouched.
#
# 512, not 64. The first version used 64 and a reviewer measured what that
# cost: 20 of 3,562 ids changed, no collisions, but five of them lost readable
# content while sitting nowhere near any limit -- ``[raw-bytes74]`` at 74
# bytes, and, pointedly, this branch's own new gate rendered as
# ``[test_evidence_reader.py-case-str66]``. A cap is meant to stop a line that
# breaks a reader, not to shorten ids for its own sake. At 512 those five
# stay legible at roughly 600 bytes, which is a hundredfold under the 64 KiB
# scanner limit, and the 256 KiB parameters are still described rather than
# printed.
#
# Until a run predates this, the whole log is still available through
#   gh api --allow-escape-sequences /repos/<owner>/<repo>/actions/jobs/<id>/logs
_MAX_PARAMETRIZE_ID = 512


def pytest_make_parametrize_id(config, val, argname):
    """Describe a large parameter instead of printing it into the test id."""
    try:
        size = len(val)
    except TypeError:                                # not sized: pytest's problem
        return None
    if isinstance(val, (bytes, bytearray, str, list, tuple, dict, set, frozenset)):
        if size > _MAX_PARAMETRIZE_ID:
            return f"{argname}-{type(val).__name__}{size}"
    return None


def pytest_deselected(items):
    """Remember what was taken out of the collection, and why.

    The markers are read off the items here rather than recomputed later: once
    the session is over these objects are the only place that says whether a
    deselected case needed a network, a signed-in CLI, or neither.
    """
    if not items:
        return
    declared = _project_marker_names(items[0].config.inipath)
    for item in items:
        _DESELECTED.append((
            item.nodeid,
            sorted({mark.name for mark in item.iter_markers()} & declared),
        ))


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    """Print the quarantine's denominator, and what this run never selected."""
    if _QUARANTINE_STATE["line"] is not None:
        terminalreporter.write_sep("-", "live quarantine")
        terminalreporter.write_line(_QUARANTINE_STATE["line"])
        for sentence in _QUARANTINE_STATE["seen"]:
            terminalreporter.write_line(sentence)
        if _QUARANTINE_STATE["error"]:
            terminalreporter.write_line(
                "QUARANTINE UNREADABLE — nothing was excused: " + _QUARANTINE_STATE["error"])

    lines = _render_deselection(
        _DESELECTED,
        collected=_SELECTED["count"],
        markexpr=getattr(config.option, "markexpr", "") or "",
        keyword=getattr(config.option, "keyword", "") or "",
    )
    if not lines:
        return
    terminalreporter.write_sep("-", _DESELECTION_HEADING)
    for line in lines:
        terminalreporter.write_line(line)

    # The same statement where the person reading a green CI run is actually
    # looking. $GITHUB_STEP_SUMMARY is set for every step of every job, so no
    # workflow needs a line added to it, and the weekly live job gets this
    # beside the summary it already writes. A failure here must never fail the
    # run: this is reporting, not a gate.
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        try:
            with open(summary, "a", encoding="utf-8") as handle:
                handle.write(_deselection_markdown(lines))
        except OSError as exc:                       # pragma: no cover - CI only
            terminalreporter.write_line(
                f"could not write the deselection report to GITHUB_STEP_SUMMARY: "
                f"{type(exc).__name__}")


def pytest_runtest_logstart(nodeid, location):
    writer = _LIVE_EVIDENCE
    if writer is not None:
        writer.safe(writer.start, nodeid)


def pytest_runtest_logreport(report):
    writer = _LIVE_EVIDENCE
    if writer is not None:
        writer.safe(writer.report, report)


def pytest_sessionfinish(session, exitstatus):
    writer = _LIVE_EVIDENCE
    initialization_failed = getattr(session.config, "_resmon_live_evidence_error", False)
    if writer is not None:
        try:
            reduction = writer.finish(int(exitstatus))
            if reduction["unfinished"]:
                writer.integrity_error = True
        except Exception as exc:
            writer.integrity_error = True
            print(
                f"live evidence reporter finalization failed: {type(exc).__name__}",
                file=sys.stderr,
            )
    if (
        (
            initialization_failed
            or (writer is not None and writer.integrity_error)
            or _QUARANTINE_STATE["error"] is not None
        )
        and int(session.exitstatus) == int(pytest.ExitCode.OK)
    ):
        session.exitstatus = pytest.ExitCode.TESTS_FAILED

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
# The local API token (2.2 lock-down)
# ---------------------------------------------------------------------------
#
# The backend refuses every request that does not carry its token, name a
# loopback Host on its own port, and — when it has an Origin — come from its
# renderer. The suite drives ``resmon.app`` in-process through ``TestClient``
# fifty-odd times, so rather than edit each one, this is the one helper that
# supplies what a real client supplies:
#
# * ``api_auth.configure`` installs a real, freshly minted token and one
#   renderer origin for this process. Nothing is switched off: there is no
#   environment variable or flag that disables the guard, in tests or anywhere.
# * ``TestClient`` is replaced by a subclass that addresses
#   ``http://127.0.0.1:<TEST_API_PORT>`` (so Host and the ASGI ``server`` agree,
#   exactly as they do under uvicorn — ``Host: testserver`` is *not* accepted by
#   production code) and sends ``Authorization: Bearer <token>`` by default.
#
# A test that needs an unauthenticated or foreign request passes its own
# headers (``headers={"Authorization": ""}``), uses ``RawTestClient``, or talks
# to a real server — ``test_local_api_auth.py`` does all three.
from implementation_scripts import api_auth  # noqa: E402

# Token files live in the state directory, and discovery code (the MCP server,
# the daemon-status probe) reads them. Without this, a test exercising
# discovery would read the developer's real Application Support directory —
# and, on a machine running resmon, find a real daemon's token there. The suite
# gets a state directory of its own; a test that needs another sets its own.
import tempfile  # noqa: E402

os.environ["RESMON_STATE_DIR"] = tempfile.mkdtemp(prefix="resmon-test-state-")

TEST_API_TOKEN = api_auth.mint_token()
TEST_API_PORT = 18743
TEST_RENDERER_ORIGIN = "http://127.0.0.1:12345"
api_auth.configure(TEST_API_TOKEN, [TEST_RENDERER_ORIGIN])

import fastapi.testclient  # noqa: E402
import starlette.testclient  # noqa: E402

RawTestClient = starlette.testclient.TestClient


class AuthedTestClient(RawTestClient):
    """``TestClient`` as the app's own renderer-less clients would call it."""

    def __init__(self, app, base_url: str = f"http://127.0.0.1:{TEST_API_PORT}",
                 headers=None, **kwargs) -> None:
        merged = {**api_auth.bearer(TEST_API_TOKEN), **dict(headers or {})}
        super().__init__(app, base_url=base_url, headers=merged, **kwargs)


fastapi.testclient.TestClient = AuthedTestClient  # type: ignore[misc]
starlette.testclient.TestClient = AuthedTestClient  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Execution-thread quiescence
# ---------------------------------------------------------------------------

_EXEC_THREAD_PREFIX = "exec-"
_JOIN_TIMEOUT_SEC = 10.0


def _join_execution_threads() -> None:
    """Block until every pipeline worker thread has finished.

    ``Thread.join(timeout)`` returns nothing and raises nothing when it gives
    up, so a worker that outlives the timeout used to sail past this silently
    and teardown closed its connection underneath it. ``close_db`` now refuses
    that close outright, which is what actually prevents the crash -- but a
    straggler still means the next test starts with a live worker from the last
    one, so it is worth being told about rather than left to be inferred.
    """
    stragglers: list[str] = []
    for thread in list(threading.enumerate()):
        if thread.name.startswith(_EXEC_THREAD_PREFIX) and thread.is_alive():
            thread.join(_JOIN_TIMEOUT_SEC)
            if thread.is_alive():
                stragglers.append(thread.name)
    if stragglers:
        warnings.warn(
            f"execution worker(s) still running after {_JOIN_TIMEOUT_SEC}s: "
            f"{', '.join(stragglers)}. The next test starts with them live.",
            stacklevel=1,
        )


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
    _reset_progress_store()


def _reset_progress_store() -> None:
    """Empty the process-wide ProgressStore between tests.

    ``progress_store`` is a module-level singleton, but every test gets a fresh
    ``:memory:`` database, so execution ids restart at 1 each time. An entry left
    behind by one test therefore collides with a *different* execution that
    happens to get the same id in the next one.

    That is not theoretical. It made the SSE tests hang intermittently on CI:
    ``GET /api/executions/{id}/progress/stream`` streams with heartbeats and
    never terminates while the store still considers that id live, so a stale
    registration from an earlier test turned a batch read into an infinite
    stream and pytest-timeout eventually killed the whole run. The same
    collision is what BUG-018 fixed inside ``register()``; clearing here removes
    the rest of the class rather than the one instance.
    """
    from implementation_scripts.progress import progress_store as _ps
    for attr in ("_events", "_locks", "_cancel_flags", "_completed"):
        container = getattr(_ps, attr, None)
        if container is not None:
            container.clear()


# ---------------------------------------------------------------------------
# Hermeticity guard
# ---------------------------------------------------------------------------
#
# Marking the live-network tests by hand is not enough on its own: two of them
# were missed in the first pass and only surfaced when arXiv rate-limited a CI
# runner and pytest-timeout killed the whole job. Both tests swallow their own
# network errors, so locally they simply passed and nothing indicated that the
# "hermetic" suite was reaching the internet.
#
# So the property is now checked rather than assumed. Any test without the
# live_network marker that opens a non-loopback socket fails immediately, and
# names itself while doing it.

import socket  # noqa: E402

_REAL_CONNECT = socket.socket.connect
_REAL_CONNECT_EX = socket.socket.connect_ex
_LOOPBACK = {"127.0.0.1", "::1", "localhost", ""}
_allow_network = {"value": False}


def _host_of(address):
    return address[0] if isinstance(address, tuple) else str(address)


def _blocked(host: str) -> OSError:
    return OSError(
        f"Blocked outbound connection to {host}. This test is not marked "
        "@pytest.mark.live_network, so it must not touch the network. Either "
        "mock the call, or mark the test live_network so it is excluded from "
        "the default run."
    )


def _guarded_connect(self, address, *args, **kwargs):
    host = _host_of(address)
    if _allow_network["value"] or host in _LOOPBACK:
        return _REAL_CONNECT(self, address, *args, **kwargs)
    raise _blocked(host)


def _guarded_connect_ex(self, address, *args, **kwargs):
    host = _host_of(address)
    if _allow_network["value"] or host in _LOOPBACK:
        return _REAL_CONNECT_EX(self, address, *args, **kwargs)
    raise _blocked(host)


socket.socket.connect = _guarded_connect
socket.socket.connect_ex = _guarded_connect_ex


# The measurement instrument behind the deselection report.
#
# 110 cases are deselected from every green merge, and the obvious question is
# how many of them a hermetic runner could actually run — the marker says
# "reaches the network, **or** binds a real socket", and the second half does
# not need an internet connection at all. Guessing at that from the names is
# the mistake this project keeps re-learning: reasoning from what a thing is
# *for* loses to driving the real code and recording what it did.
#
# With RESMON_FORCE_HERMETIC=1 the guard stays closed for live cases too, so
#
#     RESMON_FORCE_HERMETIC=1 pytest -m "live_network and not needs_agent_cli"
#
# answers the question by running it. A case that passes there reached nothing
# outside loopback. It is an instrument, not a mode: nothing in CI sets it, and
# a pass under it is evidence about reachability, not a promise that the case
# is meaningful without a network — a test that swallows its own connection
# error passes here and asserts nothing. Read the ones it names before
# believing them.
_FORCE_HERMETIC = os.environ.get("RESMON_FORCE_HERMETIC") == "1"


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    """Open the network only for tests that declare they need it."""
    _allow_network["value"] = (
        item.get_closest_marker("live_network") is not None and not _FORCE_HERMETIC
    )
