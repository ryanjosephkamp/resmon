"""One run per routine, one run per submission, and the fires nobody was up for.

Three mechanisms that all answer the same complaint -- resmon did the same work
twice, or did not do it at all and said nothing:

  * **The per-routine claim** (``admission.RoutineClaimRegistry``). Three doors
    lead into ``_dispatch_routine_fire`` -- the scheduler's callback, ``POST
    /api/routines/{id}/run`` and the admission queue's drain -- and until now
    none of them knew about the others. The claim is taken under a lock before
    the worker thread starts, which is the only ordering that closes the window;
    a guard that read ``executions.status`` instead would be both too late (the
    row does not exist when the second fire arrives) and, after a SIGKILL, far
    too long (rows nobody owns would refuse the routine for ever).
  * **The client request id.** A double-clicked Deep Sweep was two sweeps.
  * **Missed-fire accounting.** A fire that came due while resmon was closed was
    not skipped loudly; it was skipped invisibly, because re-adding the routine
    on startup recomputes ``next_run_time`` from now before anything can read
    what it was.

What this file cannot see is written on each test that has a boundary. The
in-process ones drive the real routes over a real SQLite file through
``TestClient``; ``_fast_run_prepared`` replaces the pipeline, so nothing here
says anything about what a *search* does -- only about which runs start.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database  # noqa: E402
from implementation_scripts.admission import (  # noqa: E402
    admission,
    routine_claims,
    RoutineAlreadyRunning,
)
from implementation_scripts.progress import progress_store  # noqa: E402


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

def _reset_state() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod._get_db()
    with admission._lock:
        admission._active.clear()
        admission._queue.clear()
    admission.set_max(3)
    admission.set_queue_limit(16)
    for rid in list(routine_claims.claimed_routines()):
        routine_claims.release(rid)


def _fast_run_prepared(self, exec_id: int) -> dict:
    progress_store.emit(exec_id, {"type": "execution_start", "execution_id": exec_id})
    progress_store.mark_complete(exec_id)
    database.update_execution_status(self.db, exec_id, "completed")
    return {"execution_id": exec_id, "status": "completed"}


class _Gate:
    """A pipeline that blocks until released, so a run can be caught mid-flight.

    The claim exists for exactly the interval this class creates: one execution
    in progress while a second fire arrives. A test that let the first run
    finish first would pass whether the claim existed or not.
    """

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def run_prepared(self, engine, exec_id: int) -> dict:
        self.started.set()
        # A bounded wait, and never an unbounded one: a gate that is never
        # released must fail this test rather than hang the suite.
        self.release.wait(timeout=20)
        progress_store.mark_complete(exec_id)
        database.update_execution_status(engine.db, exec_id, "completed")
        return {"execution_id": exec_id, "status": "completed"}


def _make_routine(name: str = "dup-test", is_active: int = 1) -> int:
    conn = resmon_mod._get_db()
    return database.insert_routine(conn, {
        "name": name,
        "schedule_cron": "0 8 * * *",
        "parameters": '{"query":"neural","repositories":[]}',
        "is_active": is_active,
        "email_enabled": 0,
        "email_ai_summary_enabled": 0,
        "ai_enabled": 0,
        "ai_settings": None,
        "storage_settings": None,
        "notify_on_complete": 0,
        "execution_location": "local",
    })


@pytest.fixture(autouse=True)
def _fresh():
    _reset_state()
    yield
    for rid in list(routine_claims.claimed_routines()):
        routine_claims.release(rid)
    resmon_mod.close_db()


@pytest.fixture
def client():
    return TestClient(resmon_mod.app)


# ---------------------------------------------------------------------------
# P1 -- two fires of one routine produce exactly one execution
# ---------------------------------------------------------------------------


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_a_second_run_while_one_is_going_is_refused_with_the_first_ones_id(client):
    """Denominator: 2 of 2 doors exercised here, the run route and the scheduler
    callback. The drain is the third and has its own test below.

    Cannot see: whether a *second backend process* would be refused. It would
    not -- the claim is this process's memory, which the registry's docstring
    says in as many words -- and the durable half of that question is schema
    19's reconciliation of the rows a dead backend leaves.
    """
    gate = _Gate()
    rid = _make_routine()
    with patch("resmon.SweepEngine.run_prepared",
               lambda self, exec_id: gate.run_prepared(self, exec_id)):
        first = client.post(f"/api/routines/{rid}/run")
        assert first.status_code == 200
        running_id = first.json()["execution_id"]
        assert gate.started.wait(timeout=20), "the first run never started"

        second = client.post(f"/api/routines/{rid}/run")
        assert second.status_code == 409
        assert str(running_id) in second.json()["detail"]
        assert second.headers["X-Resmon-Conflict"] == "routine_already_running"
        assert second.headers["X-Resmon-Execution-Id"] == str(running_id)

        # The scheduler's own door, while the same claim is held.
        assert resmon_mod._dispatch_routine_fire(rid, "{}") is None

        gate.release.set()

    _wait_for_claim_release(rid)
    conn = resmon_mod._get_db()
    rows = conn.execute(
        "SELECT id FROM executions WHERE routine_id = ?", (rid,)).fetchall()
    assert len(rows) == 1, "a refused fire still wrote an execution row"


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_two_threads_firing_the_same_routine_at_once_start_one_run(client):
    """The race itself, not a sequence dressed as one.

    Both threads are held at a barrier and released together, and the assertion
    is on the *rows*: whatever the two calls each believed, one execution exists.
    """
    gate = _Gate()
    rid = _make_routine()
    barrier = threading.Barrier(2)
    outcomes: list[object] = []
    lock = threading.Lock()

    def fire() -> None:
        barrier.wait(timeout=20)
        try:
            result = resmon_mod._dispatch_routine_fire(
                rid, "{}", allow_inactive=True, raise_on_conflict=True)
        except RoutineAlreadyRunning as exc:
            result = exc
        with lock:
            outcomes.append(result)

    with patch("resmon.SweepEngine.run_prepared",
               lambda self, exec_id: gate.run_prepared(self, exec_id)):
        threads = [threading.Thread(target=fire) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)
        assert gate.started.wait(timeout=20)
        gate.release.set()

    _wait_for_claim_release(rid)
    started = [o for o in outcomes if isinstance(o, int)]
    refused = [o for o in outcomes if isinstance(o, RoutineAlreadyRunning)]
    assert len(started) == 1 and len(refused) == 1, outcomes
    conn = resmon_mod._get_db()
    assert conn.execute(
        "SELECT count(*) FROM executions WHERE routine_id = ?", (rid,)
    ).fetchone()[0] == 1


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_the_claim_is_released_when_the_run_ends_so_the_next_fire_is_admitted(client):
    """A guard that never lets go is a routine that never runs again."""
    rid = _make_routine()
    first = client.post(f"/api/routines/{rid}/run")
    assert first.status_code == 200
    _wait_for_claim_release(rid)
    second = client.post(f"/api/routines/{rid}/run")
    assert second.status_code == 200
    assert second.json()["execution_id"] != first.json()["execution_id"]


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_a_fire_the_queue_took_releases_the_claim_it_could_not_use(client):
    """An enqueued fire is not a running one, and must not hold the routine.

    The admission controller is filled to its cap first, so the fire is queued
    rather than started. If the claim survived that, the routine would be
    permanently unrunnable the first time resmon was busy.
    """
    rid = _make_routine()
    admission.set_max(1)
    with admission._lock:
        admission._active.add(999999)  # a slot held by an execution not in this test
    try:
        assert resmon_mod._dispatch_routine_fire(rid, "{}") is None
        assert not routine_claims.is_claimed(rid), (
            "a queued fire kept the routine claimed")
        assert admission.queue_depth() == 1
    finally:
        with admission._lock:
            admission._active.discard(999999)
            admission._queue.clear()
        admission.set_max(3)


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_two_different_routines_do_not_block_each_other(client):
    """The claim is keyed on the routine, not on 'a routine is running'."""
    gate = _Gate()
    first_id = _make_routine("routine-one")
    second_id = _make_routine("routine-two")
    with patch("resmon.SweepEngine.run_prepared",
               lambda self, exec_id: gate.run_prepared(self, exec_id)):
        a = client.post(f"/api/routines/{first_id}/run")
        assert gate.started.wait(timeout=20)
        b = client.post(f"/api/routines/{second_id}/run")
        gate.release.set()
    assert a.status_code == 200 and b.status_code == 200


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_a_worker_that_dies_before_its_try_still_releases_the_routine(client):
    """The claim outlives the pipeline's ``finally`` if the thread never gets there.

    ``_launch_execution``'s worker does three things before the ``try`` that
    releases the claim: it records the admission slot, starts the heartbeat, and
    opens its own database connection. An exception in any of them -- a database
    that will not open is the realistic one -- used to leave the routine claimed
    for the life of the backend, and every later fire of it answered 409 naming
    a run that had never started. Found by the reviewer of this change as a
    mutation; kept as a test, because the release it checks is a second, outer
    ``finally`` that nothing else exercises.
    """
    rid = _make_routine("dies-early")
    boom = RuntimeError("no database today")
    with patch.object(resmon_mod, "_start_execution_heartbeat",
                      side_effect=boom):
        exec_id = resmon_mod._dispatch_routine_fire(rid, "{}", allow_inactive=True)
        assert exec_id is not None, "the fire was refused before it could fail"
        _wait_for_claim_release(rid)

    # And the routine is runnable again, which is the fact a user meets.
    resp = client.post(f"/api/routines/{rid}/run")
    assert resp.status_code == 200
    assert resp.json()["execution_id"] != exec_id


def _wait_for_claim_release(routine_id: int, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not routine_claims.is_claimed(routine_id):
            return
        time.sleep(0.01)
    raise AssertionError(f"routine {routine_id} stayed claimed for {timeout}s")


# ---------------------------------------------------------------------------
# P3 -- one submission, one execution
# ---------------------------------------------------------------------------

_SWEEP = {"repositories": ["arxiv"], "query": "diffusion", "max_results": 5}
_DIVE = {"repository": "arxiv", "query": "diffusion", "max_results": 5}


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_the_same_request_id_twice_yields_one_execution(client):
    """Denominator: 3 of 3 routes that accept ``request_id``.

    Cannot see: whether the *renderer* sends a fresh id per click. That is a
    renderer property and it is asserted in the renderer's own suite; what this
    establishes is that the backend honours whatever it is sent.
    """
    cases = [
        ("/api/search/sweep", dict(_SWEEP, request_id="11111111-1111-1111-1111-111111111111")),
        ("/api/search/dive", dict(_DIVE, request_id="22222222-2222-2222-2222-222222222222")),
    ]
    for path, body in cases:
        first = client.post(path, json=body)
        second = client.post(path, json=body)
        assert first.status_code == 200 and second.status_code == 200, path
        assert first.json().get("duplicate") is None, path
        assert second.json() == {"execution_id": first.json()["execution_id"],
                                 "duplicate": True}, path

    conn = resmon_mod._get_db()
    assert conn.execute("SELECT count(*) FROM executions").fetchone()[0] == 2

    # The third route: restart, whose body is optional and whose success code
    # is 202 rather than 200 -- it was 202 before this change and it stays 202.
    target = conn.execute("SELECT id FROM executions ORDER BY id LIMIT 1").fetchone()[0]
    database.update_execution_status(conn, target, "failed")
    body = {"request_id": "33333333-3333-3333-3333-333333333333"}
    first = client.post(f"/api/executions/{target}/restart", json=body)
    second = client.post(f"/api/executions/{target}/restart", json=body)
    assert first.status_code == 202 and second.status_code == 202
    assert second.json()["duplicate"] is True
    assert second.json()["execution_id"] == first.json()["execution_id"]
    assert conn.execute("SELECT count(*) FROM executions").fetchone()[0] == 3


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_different_request_ids_yield_different_executions(client):
    """The other half, and the one a too-eager guard would break: a user who
    genuinely searches twice gets two runs."""
    ids = []
    for n in (1, 2):
        resp = client.post("/api/search/sweep",
                           json=dict(_SWEEP, request_id=f"4444444{n}-4444-4444-4444-444444444444"))
        assert resp.status_code == 200
        assert resp.json().get("duplicate") is None
        ids.append(resp.json()["execution_id"])
    assert ids[0] != ids[1]


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_a_request_without_an_id_is_never_answered_with_someone_elses_run(client):
    """No id means no duplicate protection, not "match the last one"."""
    first = client.post("/api/search/sweep", json=_SWEEP)
    second = client.post("/api/search/sweep", json=_SWEEP)
    assert first.json()["execution_id"] != second.json()["execution_id"]
    assert "duplicate" not in second.json()


def test_the_database_refuses_a_second_row_with_the_same_request_id(tmp_path):
    """The partial UNIQUE index, on a real file, without the application.

    The application checks first and the check is what a user meets; this is
    the fact underneath it, and the reason the check being wrong would be a
    duplicate reply rather than a duplicate run.
    """
    path = tmp_path / "corpus.db"
    database.init_db(str(path))
    conn = database.get_connection(str(path))
    try:
        rows = []
        for _ in range(2):
            rows.append(database.insert_execution(conn, {
                "execution_type": "deep_sweep",
                "parameters": "{}",
                "start_time": database.utc_now_iso(),
            }))
        conn.execute("UPDATE executions SET request_id = 'same' WHERE id = ?", (rows[0],))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE executions SET request_id = 'same' WHERE id = ?", (rows[1],))
        conn.rollback()
        # NULL is not a value the index constrains: every run that sends no id
        # must still be insertable, for ever.
        assert conn.execute(
            "SELECT count(*) FROM executions WHERE request_id IS NULL").fetchone()[0] >= 1
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# P4 -- a fire that came due while resmon was closed is recorded
# ---------------------------------------------------------------------------


def _jobstore_scheduler(tmp_path):
    from implementation_scripts.scheduler import ResmonScheduler
    return ResmonScheduler(db_url=f"sqlite:///{tmp_path / 'jobs.sqlite'}")


def _persist_job(tmp_path, routine_id: int, next_run_time: datetime) -> None:
    """Leave a job in the jobstore file with a given next fire time.

    Written through APScheduler's own ``SQLAlchemyJobStore`` rather than by
    hand-pickling a row, because what is being tested is that resmon can read
    what the real jobstore holds.

    The scheduler that builds the ``Job`` is deliberately never *started*. A
    started scheduler processes due jobs -- on its wakeup, and again on
    ``shutdown`` -- so planting an overdue fire with one runs the job and
    advances the very ``next_run_time`` this fixture exists to leave in the
    past. ``add_job`` on an unstarted scheduler only builds the object; the
    store is then written to directly. ``coalesce`` and ``max_instances`` are
    passed explicitly for the same reason: an unstarted scheduler has not
    applied its defaults to the job yet, and the store pickles every field.

    An interval trigger, not a one-shot date one: a date job removes itself
    from the store as soon as it fires.
    """
    from apscheduler.triggers.interval import IntervalTrigger

    writer = _jobstore_scheduler(tmp_path)
    job = writer._scheduler.add_job(
        "implementation_scripts.scheduler:_routine_callback",
        trigger=IntervalTrigger(hours=24),
        id=str(routine_id),
        kwargs={"routine_id": routine_id, "parameters": "{}"},
        replace_existing=True,
        misfire_grace_time=3600,
        coalesce=True,
        max_instances=1,
        next_run_time=next_run_time,
    )
    writer._jobstore.start(writer._scheduler, "default")
    writer._jobstore.add_job(job)


def test_a_fire_due_while_resmon_was_closed_is_recorded_once(tmp_path, monkeypatch):
    """A real APScheduler SQLAlchemy jobstore on a real file.

    **How the clock is controlled:** it is not. Nothing here freezes time or
    patches ``datetime``; the job is given a trigger whose next fire is a fixed
    date two hours in the *past*, written into the jobstore exactly as a real
    overdue job's would be, and the code under test compares it against the
    real now. A frozen clock would have proved that the comparison runs, not
    that it reads the jobstore's own record.

    Cannot see: whether the fire would *also* have run. APScheduler's one-hour
    misfire grace means a fire found a few minutes in the past can still fire
    once the scheduler starts; this run is two hours late, outside that window,
    and the disposition written is ``recorded`` either way because "overdue when
    we looked" is all that was observed.
    """
    resmon_mod._db_path = str(tmp_path / "corpus.db")
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    conn = resmon_mod._get_db()
    rid = _make_routine("overdue")

    due = datetime.now(timezone.utc) - timedelta(hours=2)
    _persist_job(tmp_path, rid, due)

    # A second process's scheduler, over the same jobstore file: what resmon
    # builds on the next launch, before it starts anything.
    reader = _jobstore_scheduler(tmp_path)
    persisted = reader.persisted_next_run_times()
    assert str(rid) in persisted, "the jobstore did not hold the overdue fire"

    written = resmon_mod._record_missed_fires(reader)
    assert written == 1
    rows = database.get_missed_fires(conn, rid)
    assert len(rows) == 1
    assert rows[0]["disposition"] == "recorded"
    assert rows[0]["due_at_utc"].startswith(due.strftime("%Y-%m-%dT%H:%M"))

    # Launching again without the routine firing counts the same miss once.
    assert resmon_mod._record_missed_fires(reader) == 0
    assert len(database.get_missed_fires(conn, rid)) == 1

    resmon_mod.close_db()


def test_a_future_fire_is_not_a_missed_one(tmp_path):
    """The other side of the comparison, which a sign error would invert."""
    resmon_mod._db_path = str(tmp_path / "corpus.db")
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    conn = resmon_mod._get_db()
    rid = _make_routine("upcoming")

    _persist_job(tmp_path, rid, datetime.now(timezone.utc) + timedelta(hours=2))

    reader = _jobstore_scheduler(tmp_path)
    assert resmon_mod._record_missed_fires(reader) == 0
    assert database.get_missed_fires(conn, rid) == []
    resmon_mod.close_db()


def test_the_startup_path_records_the_miss_and_leaves_the_next_fire_in_the_future(
        tmp_path, monkeypatch):
    """The whole of ``_init_scheduler_on_startup``, not just the recorder.

    This is the ordering claim: reading has to happen before ``start()`` and
    before the re-add, because both rewrite the persisted ``next_run_time``.
    After startup the routine's next fire is in the future -- resmon is running
    on its schedule again -- *and* the miss is on the record, which is the pair
    of facts a user needs.
    """
    resmon_mod._db_path = str(tmp_path / "corpus.db")
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    conn = resmon_mod._get_db()
    rid = _make_routine("startup")

    jobs_url = f"sqlite:///{tmp_path / 'jobs.sqlite'}"
    from implementation_scripts.scheduler import ResmonScheduler
    _persist_job(tmp_path, rid, datetime.now(timezone.utc) - timedelta(hours=6))

    monkeypatch.delenv("RESMON_DISABLE_SCHEDULER", raising=False)
    monkeypatch.setattr(resmon_mod, "ResmonScheduler",
                        lambda *a, **k: ResmonScheduler(db_url=jobs_url))
    with patch("resmon.SweepEngine.run_prepared", _fast_run_prepared):
        resmon_mod._init_scheduler_on_startup()
        try:
            assert len(database.get_missed_fires(conn, rid)) == 1
            jobs = {j["id"]: j for j in resmon_mod.scheduler.get_active_jobs()}
            assert str(rid) in jobs
            next_run = jobs[str(rid)]["next_run_time"]
            assert next_run is not None
            assert datetime.fromisoformat(next_run) > datetime.now(
                next_run and datetime.fromisoformat(next_run).tzinfo)
        finally:
            resmon_mod._shutdown_scheduler()
    resmon_mod.close_db()


def test_the_api_and_the_analytics_report_the_missed_fires(tmp_path, client):
    """What a screen and an assistant read, from the same rows.

    Denominator: 3 of 3 surfaces named in the brief -- the routine, the routine
    list, and routine-health analytics.
    """
    conn = resmon_mod._get_db()
    rid = _make_routine("reported")
    database.record_missed_fire(conn, rid, "2026-09-18T07:00:00+00:00")
    database.record_missed_fire(conn, rid, "2026-09-19T07:00:00+00:00")

    one = client.get(f"/api/routines/{rid}").json()
    assert one["missed_fires"] == {"count": 2,
                                   "last_due_at_utc": "2026-09-19T07:00:00+00:00"}
    assert [r["due_at_utc"] for r in one["missed_fire_details"]] == [
        "2026-09-18T07:00:00+00:00", "2026-09-19T07:00:00+00:00"]

    listed = {r["id"]: r for r in client.get("/api/routines").json()}
    assert listed[rid]["missed_fires"]["count"] == 2

    health = client.get("/api/analytics/routine-health").json()
    row = next(r for r in health["routines"] if r["routine_id"] == rid)
    assert row["missed_fires"] == 2
    assert row["last_missed_fire_at"] == "2026-09-19T07:00:00+00:00"


def test_a_routine_with_no_missed_fires_says_zero_rather_than_nothing(client):
    rid = _make_routine("clean")
    assert client.get(f"/api/routines/{rid}").json()["missed_fires"] == {
        "count": 0, "last_due_at_utc": None}


# ---------------------------------------------------------------------------
# P5 -- the 19 -> 20 step
# ---------------------------------------------------------------------------


def _schema_19_database(path: Path) -> sqlite3.Connection:
    """A database at 19, built by running the real migrations and undoing 20.

    Dropping schema 20's objects from a current database is not the same thing
    as a database a released resmon wrote, and this test says only what it can:
    the step is additive and loses nothing. The journey a user takes is
    ``test_cumulative_upgrade.py``'s, from a fixture the old code produced.
    """
    database.init_db(str(path))
    conn = database.get_connection(str(path))
    for rid in (1, 2):
        database.insert_routine(conn, {
            "name": f"r{rid}", "schedule_cron": "0 8 * * *",
            "parameters": "{}", "is_active": 1, "email_enabled": 0,
            "email_ai_summary_enabled": 0, "ai_enabled": 0, "ai_settings": None,
            "storage_settings": None, "notify_on_complete": 0,
            "execution_location": "local"})
    for _ in range(3):
        database.insert_execution(conn, {
            "execution_type": "deep_sweep", "parameters": '{"query":"x"}',
            "start_time": database.utc_now_iso()})
    conn.commit()
    conn.execute("DROP INDEX idx_routine_missed_fires_routine")
    conn.execute("DROP TABLE routine_missed_fires")
    conn.execute("DROP INDEX idx_executions_request_id")
    conn.execute("UPDATE app_settings SET value = '19' WHERE key = 'schema_version'")
    conn.commit()
    return conn


def test_the_19_to_20_step_is_additive_and_keeps_every_row(tmp_path):
    conn = _schema_19_database(tmp_path / "corpus.db")
    try:
        assert database.get_schema_version(conn) == 19
        before = [tuple(r) for r in conn.execute(
            "SELECT id, execution_type, parameters, start_time, status FROM executions "
            "ORDER BY id")]
        routines_before = [tuple(r) for r in conn.execute(
            "SELECT id, name FROM routines ORDER BY id")]

        database.init_db(conn=conn)

        assert database.get_schema_version(conn) == 20
        after = [tuple(r) for r in conn.execute(
            "SELECT id, execution_type, parameters, start_time, status FROM executions "
            "ORDER BY id")]
        assert after == before
        assert [tuple(r) for r in conn.execute(
            "SELECT id, name FROM routines ORDER BY id")] == routines_before
        # The new column arrives NULL on every existing row: no run that
        # predates this was sent a request id, and writing one now would be
        # inventing a submission.
        assert conn.execute(
            "SELECT count(*) FROM executions WHERE request_id IS NOT NULL"
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT count(*) FROM routine_missed_fires").fetchone()[0] == 0
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        conn.close()


def test_the_step_refuses_a_conflicting_object_rather_than_adopting_it(tmp_path):
    """A table of the same name with a different shape is a conflict.

    Adopting it would leave a database that says it is at schema 20 and has a
    table the code cannot use -- the failure mode every migration in this file
    is written to avoid.
    """
    conn = _schema_19_database(tmp_path / "corpus.db")
    try:
        conn.execute("CREATE TABLE routine_missed_fires (wrong INTEGER)")
        conn.commit()
        with pytest.raises(sqlite3.DatabaseError):
            database.init_db(conn=conn)
        assert database.get_schema_version(conn) == 19
    finally:
        conn.close()


def test_the_disposition_vocabulary_is_enforced_on_the_upgraded_database(tmp_path):
    """B10: the CHECK is exercised where a rebuild could have lost it."""
    conn = _schema_19_database(tmp_path / "corpus.db")
    try:
        database.init_db(conn=conn)
        rid = conn.execute("SELECT id FROM routines ORDER BY id LIMIT 1").fetchone()[0]
        for value in database.MISSED_FIRE_DISPOSITIONS:
            conn.execute(
                "INSERT INTO routine_missed_fires"
                "(routine_id, due_at_utc, observed_at_utc, disposition) "
                "VALUES (?, ?, ?, ?)",
                (rid, f"2026-01-01T0{database.MISSED_FIRE_DISPOSITIONS.index(value)}"
                      ":00:00+00:00", "2026-01-02T00:00:00+00:00", value))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO routine_missed_fires"
                "(routine_id, due_at_utc, observed_at_utc, disposition) "
                "VALUES (?, ?, ?, ?)",
                (rid, "2026-02-01T00:00:00+00:00", "2026-02-01T00:00:00+00:00",
                 "caught_up"))
        conn.rollback()
    finally:
        conn.close()
