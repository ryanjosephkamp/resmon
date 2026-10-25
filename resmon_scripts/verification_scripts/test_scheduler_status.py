"""Whether a routine shown as Active will fire -- ``GET /api/scheduler/status``.

The Routines page used to show **Active** for a routine that nothing would ever
fire, and the two looked identical. The packaged app always starts its own
backend with ``RESMON_DISABLE_SCHEDULER=1``: firing belongs to the background
service, and the app attaches to that service only when its lock names one that
is live, has a token file and runs the same version. Otherwise the app's own
backend has ``scheduler = None``, so no routine fires, and
``_record_missed_fires`` -- which only runs in a process that starts a
scheduler -- never runs either. The missed-fire count stays at zero however
many fires were missed.

That was measured on a copy of the owner's corpus: a routine on ``*/5`` Active
for nearly six minutes with zero executions, and a daily routine Active for
48 days with one execution and zero recorded misses, while the lock named a
1.2.1 service the 2.3.0 app would not attach to.

These tests hold the route that says which of those situations a window is in.
The fake daemons below answer the health probe the way a real one does --
including the ``ConnectError`` of a port nothing listens on, which is produced
by a real socket rather than imitated -- because the classification is the
thing under test.
"""

from __future__ import annotations

import contextlib
import json
import os
import socket
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Iterator, Optional

import httpx
import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import daemon as daemon_mod  # noqa: E402
from implementation_scripts import scheduler as scheduler_mod  # noqa: E402
from implementation_scripts.config import APP_VERSION  # noqa: E402
from implementation_scripts.scheduler import ResmonScheduler  # noqa: E402

#: A version this app is not. The owner's service is 1.2.1.
OTHER_VERSION = "1.2.1"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _reset() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod.scheduler = None
    scheduler_mod._dispatcher = None


@pytest.fixture
def isolated(tmp_path, monkeypatch) -> SimpleNamespace:
    """A lock path and a unit directory of this test's own.

    Without ``RESMON_SERVICE_UNIT_DIR`` the "is the service installed" half
    would read the real ``~/Library/LaunchAgents`` of whoever runs the suite,
    and on a machine that runs resmon the answer would be yes.
    """
    lock = tmp_path / "daemon.lock"
    monkeypatch.setattr(daemon_mod, "lock_path", lambda: lock)
    units = tmp_path / "units"
    monkeypatch.setenv("RESMON_SERVICE_UNIT_DIR", str(units))
    return SimpleNamespace(lock=lock, units=units, tmp=tmp_path)


@contextlib.contextmanager
def _backend(monkeypatch, *, scheduler_on: bool) -> Iterator[TestClient]:
    """A backend started the way one of the two real launchers starts it.

    ``scheduler_on=False`` is the Electron-spawned backend
    (``RESMON_DISABLE_SCHEDULER=1``); ``True`` is the daemon, or a backend
    launched directly. The startup hook runs, so ``scheduler`` is whatever
    that hook decided rather than a value this test assigned.
    """
    if scheduler_on:
        monkeypatch.delenv("RESMON_DISABLE_SCHEDULER", raising=False)
    else:
        monkeypatch.setenv("RESMON_DISABLE_SCHEDULER", "1")
    _reset()
    with TestClient(resmon_mod.create_app()) as client:
        yield client


def _install_unit(isolated: SimpleNamespace) -> None:
    from implementation_scripts import service_manager  # noqa: PLC0415

    path = service_manager.unit_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("<unit/>", encoding="utf-8")


def _write_lock(isolated: SimpleNamespace, port: Optional[int], version: str) -> None:
    payload: dict = {"pid": 4242, "version": version}
    if port is not None:
        payload["port"] = port
    isolated.lock.write_text(json.dumps(payload), encoding="utf-8")


def _fake_daemon(monkeypatch, *, version: Optional[str] = APP_VERSION, pid: int = 4242,
                 status: int = 200, raises: Optional[Exception] = None) -> list[str]:
    """Answer the daemon-status probe as a running service would.

    Installed **after** the test client has started, so nothing the startup
    hook does over HTTP is answered by this fake. Returns the list of URLs it
    was asked for, so a test can show the probe really ran.
    """
    asked: list[str] = []

    class _Response:
        status_code = status

        def json(self) -> dict:
            body = {"status": "ok", "pid": pid, "started_at": "2026-09-02T00:00:00+00:00"}
            if version is not None:
                body["version"] = version
            return body

    class _Client:
        def __init__(self, *_, **__) -> None:
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_) -> bool:
            return False

        def get(self, url, headers=None):
            asked.append(url)
            if raises is not None:
                raise raises
            return _Response()

    monkeypatch.setattr(httpx, "Client", _Client)
    return asked


@contextlib.contextmanager
def _a_port_nothing_listens_on() -> Iterator[int]:
    """A loopback port nothing is bound to, so a connect is refused.

    That is the real ``ConnectError`` a stale lock produces -- a dead service
    leaves its port free -- rather than one raised by a fake.

    The port is found by binding and then closing, not held for the test. A
    socket held bound but not listening is refused on Linux and **times out
    on macOS**, which the probe rightly reports as a service that did not
    answer; this test then failed on a Mac for a reason no user meets. The
    cost is a window in which another process could take the port, which on a
    loopback ephemeral port for a few milliseconds is not a real one.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    assert port != 8742
    yield port


def _create(client: TestClient, name: str, *, cron: str = "0 8 * * *",
            active: bool = True) -> int:
    resp = client.post("/api/routines", json={
        "name": name,
        "schedule_cron": cron,
        "parameters": {"query": "x", "repositories": ["arxiv"]},
        "is_active": active,
    })
    assert resp.status_code == 201, resp.text
    return int(resp.json()["id"])


def _status(client: TestClient) -> dict:
    resp = client.get("/api/scheduler/status")
    assert resp.status_code == 200, f"{resp.status_code}: {resp.text}"
    return resp.json()


def _verdicts(body: dict) -> dict[int, tuple[Optional[bool], str]]:
    return {r["id"]: (r["will_fire"], r["reason"]) for r in body["routines"]}


def _corpus_path() -> str:
    """The file this backend's corpus connection is open on."""
    conn = resmon_mod._get_db()
    try:
        return conn.execute("PRAGMA database_list").fetchone()[2]
    finally:
        resmon_mod._close_db(conn)


def _leave_a_job_in_this_database(routine_id: int) -> None:
    """Have a real APScheduler write this routine's job into this corpus's store.

    The situation is a scheduler that once ran over this database -- a daemon
    since stopped, or one of another version over the same file -- and left its
    job store behind. ``ResmonScheduler`` writes the row exactly as it would in
    production, because every released resmon keeps the job store in the
    corpus file (``scheduler._DEFAULT_DB_URL``).
    """
    path = _corpus_path()
    conn = resmon_mod._get_db()
    try:
        row = dict(conn.execute("SELECT * FROM routines WHERE id = ?",
                                (routine_id,)).fetchone())
    finally:
        resmon_mod._close_db(conn)
    other = ResmonScheduler(db_url=f"sqlite:///{path}")
    other.start()
    try:
        other.add_routine(row)
    finally:
        other.shutdown()
    with sqlite3.connect(path) as raw:
        found = raw.execute("SELECT next_run_time FROM apscheduler_jobs WHERE id = ?",
                            (str(routine_id),)).fetchone()
    assert found is not None and found[0] is not None, "the fixture left no job behind"


# ---------------------------------------------------------------------------
# The owner's case
# ---------------------------------------------------------------------------

def test_the_owners_case_an_active_routine_nothing_will_fire_says_so(isolated, monkeypatch):
    """The window the owner was looking at, and what it now says.

    A 2.3.0 backend with its scheduler off, a lock naming a running 1.2.1
    service, and a routine on ``*/5`` activated in this window. Nothing has
    that routine scheduled -- activating it here reached no scheduler, because
    there is none in this process -- so it will not fire, whatever database the
    old service serves.
    """
    with _backend(monkeypatch, scheduler_on=False) as client:
        rid = _create(client, "every five minutes", cron="*/5 * * * *")

        # What the page had to go on before this route: Active, and no misses.
        listed = {r["id"]: r for r in client.get("/api/routines").json()}
        assert listed[rid]["is_active"]
        assert listed[rid]["missed_fires"]["count"] == 0

        _write_lock(isolated, 8742, OTHER_VERSION)
        asked = _fake_daemon(monkeypatch, version=OTHER_VERSION)
        body = _status(client)

    assert asked, "the service's health was never probed"
    assert body["state"] == "service_other_version"
    assert body["service_version"] == OTHER_VERSION
    assert body["app_version"] == APP_VERSION
    assert _verdicts(body) == {rid: (False, "not_scheduled")}


# ---------------------------------------------------------------------------
# This process holds the scheduler
# ---------------------------------------------------------------------------

def test_a_backend_holding_the_scheduler_says_its_routines_fire(isolated, monkeypatch):
    with _backend(monkeypatch, scheduler_on=True) as client:
        active = _create(client, "active")
        _create(client, "paused", active=False)
        body = _status(client)

    assert body["state"] == "fires_here"
    # Only active routines are judged: an inactive routine is not expected to
    # fire, and listing it would invite a sentence about it.
    assert _verdicts(body) == {active: (True, "scheduled")}


def test_an_active_routine_the_running_scheduler_does_not_hold_will_not_fire(
        isolated, monkeypatch):
    """Active in the table, absent from the scheduler.

    ``_sched_add_routine`` logs and swallows a scheduler fault so the database
    write still lands, which is the right trade -- and it means **Active**
    alone cannot say the job exists. This process can, so it does.
    """
    with _backend(monkeypatch, scheduler_on=True) as client:
        rid = _create(client, "lost its job")
        resmon_mod.scheduler.remove_routine(rid)
        body = _status(client)

    assert body["state"] == "fires_here"
    assert _verdicts(body) == {rid: (False, "not_scheduled")}


# ---------------------------------------------------------------------------
# No scheduler here: what the background service's evidence says
# ---------------------------------------------------------------------------

def test_no_service_installed_and_none_running(isolated, monkeypatch):
    with _backend(monkeypatch, scheduler_on=False) as client:
        rid = _create(client, "r")
        body = _status(client)

    assert body["state"] == "no_service"
    assert body["service_installed"] is False
    assert body["service_version"] is None
    assert _verdicts(body) == {rid: (False, "not_scheduled")}


def test_a_service_installed_but_with_no_lock_is_not_running(isolated, monkeypatch):
    _install_unit(isolated)
    with _backend(monkeypatch, scheduler_on=False) as client:
        _create(client, "r")
        body = _status(client)

    assert body["state"] == "service_stopped"
    assert body["service_installed"] is True


def test_a_lock_naming_a_port_nothing_listens_on_is_not_running(isolated, monkeypatch):
    """A stale lock: the service died and left its file behind.

    Classified from the real refusal, not from a fake. Installed or not decides
    which of the two "not running" states it is.
    """
    with _a_port_nothing_listens_on() as port:
        _write_lock(isolated, port, APP_VERSION)
        with _backend(monkeypatch, scheduler_on=False) as client:
            _create(client, "r")
            uninstalled = _status(client)
            _install_unit(isolated)
            installed = _status(client)

    assert uninstalled["state"] == "no_service"
    assert installed["state"] == "service_stopped"


@pytest.mark.parametrize(
    ("daemon", "expected"),
    [
        pytest.param({"version": APP_VERSION, "pid": 4242}, "service_elsewhere",
                     id="same-version-another-process"),
        pytest.param({"version": OTHER_VERSION}, "service_other_version",
                     id="another-version"),
        pytest.param({"version": None}, "service_other_version",
                     id="no-version-reported-and-none-in-the-lock"),
        pytest.param({"status": 401}, "service_unreachable", id="refused-the-token"),
        pytest.param({"status": 500}, "service_unreachable", id="http-error"),
        pytest.param({"raises": httpx.ReadTimeout("slow")}, "service_unreachable",
                     id="did-not-answer-in-time"),
    ],
)
def test_what_the_running_service_answers_decides_the_state(isolated, monkeypatch,
                                                              daemon, expected):
    # The lock carries no version for the "no version" case, so neither source
    # Electron consults can say what the service is.
    lock_version = "" if daemon.get("version", "x") is None else APP_VERSION
    with _backend(monkeypatch, scheduler_on=False) as client:
        _create(client, "r")
        payload = {"pid": 4242, "port": 8742}
        if lock_version:
            payload["version"] = lock_version
        isolated.lock.write_text(json.dumps(payload), encoding="utf-8")
        _fake_daemon(monkeypatch, **daemon)
        body = _status(client)

    assert body["state"] == expected


def test_a_lock_with_no_port_cannot_be_checked(isolated, monkeypatch):
    with _backend(monkeypatch, scheduler_on=False) as client:
        _create(client, "r")
        _write_lock(isolated, None, APP_VERSION)
        body = _status(client)

    assert body["state"] == "service_unreachable"


def test_the_service_named_by_the_lock_is_this_process_with_its_scheduler_off(
        isolated, monkeypatch):
    with _backend(monkeypatch, scheduler_on=False) as client:
        _create(client, "r")
        _write_lock(isolated, 8742, APP_VERSION)
        _fake_daemon(monkeypatch, version=APP_VERSION, pid=os.getpid())
        body = _status(client)

    assert body["state"] == "scheduler_off"


def test_the_version_reported_by_the_service_wins_over_the_lock(isolated, monkeypatch):
    """Electron trusts the live process over the lock file, and so does this."""
    with _backend(monkeypatch, scheduler_on=False) as client:
        _create(client, "r")
        _write_lock(isolated, 8742, APP_VERSION)
        _fake_daemon(monkeypatch, version=OTHER_VERSION)
        body = _status(client)

    assert body["state"] == "service_other_version"
    assert body["service_version"] == OTHER_VERSION


# ---------------------------------------------------------------------------
# A job in this database's store: certain only when nothing could be running it
# ---------------------------------------------------------------------------

def test_a_job_left_in_this_database_with_no_scheduler_running_will_not_fire(
        isolated, monkeypatch):
    with _backend(monkeypatch, scheduler_on=False) as client:
        rid = _create(client, "left behind")
        _leave_a_job_in_this_database(rid)
        body = _status(client)

    assert body["state"] == "no_service"
    assert _verdicts(body) == {rid: (False, "no_scheduler_running")}


@pytest.mark.parametrize(
    ("daemon", "state"),
    [
        pytest.param({"version": OTHER_VERSION}, "service_other_version", id="another-version"),
        pytest.param({"version": APP_VERSION}, "service_elsewhere", id="same-version"),
        pytest.param({"status": 401}, "service_unreachable", id="unreachable"),
    ],
)
def test_a_job_in_this_database_with_a_service_resmon_cannot_see_into_is_unconfirmed(
        isolated, monkeypatch, daemon, state):
    """The one case this route answers with ``None``.

    The routine has a job in this database's store, and a service is running
    -- or may be -- whose database resmon cannot identify: ``/api/health``
    carries ``identity.corpus_id``, and it is ``null`` on every version so far.
    If that service serves this file it will fire the job; if not, nothing
    will. Saying either would be a guess.
    """
    with _backend(monkeypatch, scheduler_on=False) as client:
        rid = _create(client, "maybe")
        _leave_a_job_in_this_database(rid)
        _write_lock(isolated, 8742, APP_VERSION)
        _fake_daemon(monkeypatch, **daemon)
        body = _status(client)

    assert body["state"] == state
    assert _verdicts(body) == {rid: (None, "unconfirmed")}


def test_a_paused_job_is_not_a_scheduled_one(isolated, monkeypatch):
    """APScheduler pauses by nulling ``next_run_time``; such a job never fires."""
    with _backend(monkeypatch, scheduler_on=False) as client:
        rid = _create(client, "paused job")
        _leave_a_job_in_this_database(rid)
        with sqlite3.connect(_corpus_path()) as raw:
            raw.execute("UPDATE apscheduler_jobs SET next_run_time = NULL WHERE id = ?",
                        (str(rid),))
        _write_lock(isolated, 8742, APP_VERSION)
        _fake_daemon(monkeypatch, version=OTHER_VERSION)
        body = _status(client)

    assert _verdicts(body) == {rid: (False, "not_scheduled")}


# ---------------------------------------------------------------------------
# The shared probe did not change the route it was taken from
# ---------------------------------------------------------------------------

def test_daemon_status_answers_the_same_body_through_the_shared_probe(isolated, monkeypatch):
    """``/api/service/daemon-status`` and this route ask the service once each,
    through one function. Its body is the Advanced tab's, and it must not grow
    the classification this route uses."""
    with _backend(monkeypatch, scheduler_on=False) as client:
        _write_lock(isolated, 8742, OTHER_VERSION)
        _fake_daemon(monkeypatch, version=OTHER_VERSION, pid=777)
        body = client.get("/api/service/daemon-status").json()

    assert body == {
        "lock_present": True, "running": True, "pid": 777, "port": 8742,
        "version": OTHER_VERSION, "started_at": "2026-09-02T00:00:00+00:00",
        "lock_pid": 4242, "lock_port": 8742, "lock_version": OTHER_VERSION,
        "error": None, "is_self": False,
    }
