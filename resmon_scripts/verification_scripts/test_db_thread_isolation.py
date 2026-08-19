"""BUG-020 — database connections must not be shared across threads.

resmon kept one process-wide ``sqlite3.Connection`` and used it from FastAPI
request threads and from every execution worker thread with no serialisation.
sqlite3 connections are not safe for concurrent use, so this was a race. Python
3.10 and 3.11 mostly hid it because their sqlite3 module holds the GIL across
most operations; 3.12 releases it far more aggressively, so the race is lost
reliably there and only occasionally on 3.10/3.11.

It surfaced in CI as, variously:

    sqlite3.InterfaceError: bad parameter or other API misuse
    sqlite3.ProgrammingError: Cannot operate on a closed database
    sqlite3.OperationalError: cannot start a transaction within a transaction

These tests exercise the concurrency head-on rather than waiting for it to
show up by luck.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db():
    """Give each test a clean database, and hand the module back as it was.

    One test in here repoints ``_db_path`` at a temp file, so the previous value
    is restored on the way out -- otherwise later test modules inherit a path
    into a directory pytest has already deleted.
    """
    previous_path = resmon_mod._db_path
    resmon_mod.close_db()
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod._get_db()
    yield
    resmon_mod.close_db()
    resmon_mod._db_path = previous_path


def test_each_thread_gets_its_own_connection():
    """_get_db() must never hand the same object to two threads."""
    seen: dict[str, int] = {}
    lock = threading.Lock()

    def worker(name: str) -> None:
        conn = resmon_mod._get_db()
        with lock:
            seen[name] = id(conn)

    threads = [threading.Thread(target=worker, args=(f"t{i}",)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(seen) == 8
    assert len(set(seen.values())) == 8, (
        f"threads shared connection objects: {seen}"
    )


def test_same_thread_reuses_its_connection():
    """A thread should not open a new connection on every call."""
    first = resmon_mod._get_db()
    for _ in range(20):
        assert resmon_mod._get_db() is first


def test_threads_see_each_others_committed_rows():
    """Per-thread connections must still address one shared database.

    An in-memory database is private to its connection unless opened through a
    shared-cache URI, so this is the property that makes per-thread connections
    viable at all: isolation of the *handle*, not of the data.
    """
    written: list[int] = []

    def writer() -> None:
        conn = resmon_mod._get_db()
        exec_id = database.insert_execution(conn, {
            "execution_type": "deep_dive",
            "parameters": "{}",
            "start_time": "2026-01-01T00:00:00",
        })
        conn.commit()
        written.append(exec_id)

    t = threading.Thread(target=writer)
    t.start()
    t.join()

    assert written, "writer thread did not insert"
    row = database.get_execution_by_id(resmon_mod._get_db(), written[0])
    assert row is not None, "row written on one thread is invisible on another"
    assert row["execution_type"] == "deep_dive"


def test_concurrent_writes_do_not_corrupt_the_connection(tmp_path):
    """The regression proper: hammer the database from many threads at once.

    Against the old single shared connection this raised
    ``cannot start a transaction within a transaction`` and friends. Each thread
    holding its own connection makes the pattern legal, with SQLite's own
    locking arbitrating between them.

    Deliberately run against a **file** database rather than the in-memory one
    the other tests use. Production is always a file, and ``_open_connection``
    gives file databases WAL plus a busy timeout -- one writer and many readers
    concurrently. The shared-cache in-memory database used elsewhere in this
    module takes coarser table-level locks that no busy timeout applies to, so
    stressing it would be testing a configuration resmon never ships.
    """
    resmon_mod.close_db()
    resmon_mod._db_path = str(tmp_path / "resmon.db")
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod._get_db()

    errors: list[BaseException] = []
    n_threads, per_thread = 12, 15
    barrier = threading.Barrier(n_threads)

    def worker(n: int) -> None:
        try:
            barrier.wait(timeout=30)  # maximise overlap
            conn = resmon_mod._get_db()
            for i in range(per_thread):
                database.insert_execution(conn, {
                    "execution_type": "deep_dive",
                    "parameters": f'{{"n": {n}, "i": {i}}}',
                    "start_time": "2026-01-01T00:00:00",
                })
                conn.commit()
                database.get_executions(conn)
        except BaseException as exc:  # noqa: BLE001 - reported on the main thread
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=120)

    assert not errors, f"concurrent database access raised: {errors[:3]}"
    # get_executions paginates at 50 by default, so count directly.
    total = resmon_mod._get_db().execute(
        "SELECT COUNT(*) FROM executions"
    ).fetchone()[0]
    assert total == n_threads * per_thread, (
        f"expected {n_threads * per_thread} rows, found {total} -- "
        "writes were lost under concurrency"
    )


def test_close_db_closes_every_connection():
    """close_db() must not leave per-thread connections open.

    An in-memory database survives while any connection to it is open, so
    closing only the anchor would leak one test's rows into the next.
    """
    opened: list[sqlite3.Connection] = []

    def worker() -> None:
        opened.append(resmon_mod._get_db())

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(opened) == 4
    resmon_mod.close_db()

    for conn in opened:
        with pytest.raises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")


def test_worker_thread_does_not_reuse_the_request_connection():
    """_launch_execution's worker must rebind to its own connection.

    The endpoint returns as soon as the worker thread starts, so the request
    thread and the worker overlap by construction. If the worker kept the
    connection it was handed, the fix would not apply on the path that
    originally exposed the bug.
    """
    from implementation_scripts.progress import progress_store

    request_conn = resmon_mod._get_db()
    exec_id = database.insert_execution(request_conn, {
        "execution_type": "deep_dive",
        "parameters": "{}",
        "start_time": "2026-01-01T00:00:00",
    })
    request_conn.commit()
    progress_store.register(exec_id)

    observed: dict = {}
    done = threading.Event()

    class _Engine:
        db = request_conn

        def run_prepared(self, _exec_id):
            observed["worker_conn_id"] = id(resmon_mod._get_db())
            observed["engine_db_id"] = id(self.db)
            done.set()

    # _apply_ai_settings_to_engine expects a real SweepEngine; neutralise it so
    # this test is about connection ownership and nothing else.
    import unittest.mock as _mock
    with _mock.patch.object(resmon_mod, "_apply_ai_settings_to_engine", lambda *a, **k: None):
        resmon_mod._launch_execution(_Engine(), exec_id, request_conn)
        done.wait(timeout=30)

    assert observed, "worker never ran"
    assert observed["worker_conn_id"] != id(request_conn), (
        "worker thread reused the request thread's connection"
    )
    assert observed["engine_db_id"] == observed["worker_conn_id"], (
        "engine.db was not rebound to the worker's own connection"
    )
