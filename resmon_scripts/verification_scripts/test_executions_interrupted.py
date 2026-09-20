"""Schema 19: interrupted executions, ownership, and Restart.

The 18 -> 19 step test AGENTS.md asks of every schema bump, plus the API
properties that hang off it. The out-of-process boundary -- two real backends
over one state directory, the first killed with SIGKILL mid-sweep -- lives in
`test_executions_interrupted_boundary.py`, because it is the only thing here
that a TestClient cannot establish.

What this file cannot see: whether a *user's* corpus, with years of rows and
indexes an upgrade path never anticipated, survives the table rebuild. The
committed v2.2.0 fixture in `test_cumulative_upgrade.py` is the nearest
available thing to that, and it is a fixture, not someone's corpus.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import database as db  # noqa: E402
import resmon as resmon_mod  # noqa: E402


@pytest.fixture
def db_conn(tmp_path):
    """A real file-backed corpus that `resmon._get_db()` also opens.

    The reconciliation hook reads through resmon's own per-thread connection
    (BUG-020), so a bare `sqlite3.connect(":memory:")` would leave it looking
    at a different database entirely and every assertion here would be about
    nothing.
    """
    path = tmp_path / "corpus.db"
    resmon_mod._db_path = str(path)
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    conn = resmon_mod._get_db()
    try:
        yield conn
    finally:
        resmon_mod._close_db(conn)
        resmon_mod._db_path = None
        resmon_mod._shared_conn = None
        resmon_mod._db_initialized = False


# ---------------------------------------------------------------------------
# The 18 -> 19 step
# ---------------------------------------------------------------------------


def _schema_18_executions(path: Path) -> sqlite3.Connection:
    """A database at the shape schema 18 left, with rows in `executions`.

    Built by running `init_db` and then putting `executions` back the way 18
    had it: the narrow CHECK, and none of the schema-19 columns. Reproducing
    v2.2.0's whole file by hand is what the committed fixture is for; what this
    needs is the one table, populated, with the constraint that is about to
    move.
    """
    conn = db.get_connection(path)
    db.init_db(conn=conn)
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute("DROP TABLE executions")
    conn.execute(
        "CREATE TABLE executions ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " execution_type TEXT NOT NULL CHECK(execution_type IN ('deep_dive','deep_sweep','automated_sweep')),"
        " routine_id INTEGER,"
        " saved_configuration_id INTEGER,"
        " parameters TEXT NOT NULL,"
        " start_time TEXT NOT NULL,"
        " end_time TEXT,"
        " status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),"
        " result_count INTEGER DEFAULT 0,"
        " new_result_count INTEGER DEFAULT 0,"
        " log_path TEXT, result_path TEXT, error_message TEXT,"
        " progress_events TEXT, current_stage TEXT, cancel_reason TEXT,"
        " dedup_total INTEGER, dedup_new INTEGER, dedup_duplicates INTEGER,"
        " dedup_invalid INTEGER, dedup_cross_source INTEGER,"
        " FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE SET NULL,"
        " FOREIGN KEY (saved_configuration_id) REFERENCES saved_configurations(id) ON DELETE SET NULL)"
    )
    conn.executemany(
        "INSERT INTO executions (id, execution_type, parameters, start_time, end_time,"
        " status, result_count, cancel_reason, error_message, dedup_total) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
            (1, "deep_dive", '{"query": "diffusion"}', "2026-01-01T00:00:00+00:00",
             "2026-01-01T00:05:00+00:00", "completed", 12, None, None, 30),
            # The row every graceful shutdown before schema 19 wrote. It is
            # history, and the migration must not touch it.
            (2, "deep_sweep", '{"query": "folding"}', "2026-01-02T00:00:00+00:00",
             "2026-01-02T00:01:00+00:00", "failed", 0, "daemon_restart",
             "Execution flushed on daemon_restart", None),
            (7, "automated_sweep", '{"query": "lattice"}', "2026-01-03T00:00:00+00:00",
             None, "running", 0, None, None, None),
        ],
    )
    # An AUTOINCREMENT high-water mark ahead of the highest surviving id: the
    # user deleted their most recent run, and a rebuild that resets this would
    # hand a deleted run's id -- and its execution_documents -- to a new one.
    conn.execute("DELETE FROM sqlite_sequence WHERE name='executions'")
    conn.execute("INSERT INTO sqlite_sequence(name, seq) VALUES ('executions', 41)")
    conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash)"
        " VALUES ('arxiv','2601.00001','A paper','h1')")
    conn.execute("INSERT INTO execution_documents (execution_id, document_id, is_new) VALUES (1, 1, 1)")
    conn.execute(
        "INSERT INTO app_settings(key,value) VALUES ('schema_version','18')"
        " ON CONFLICT(key) DO UPDATE SET value='18'")
    conn.commit()
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def test_the_18_to_19_step_keeps_every_row_link_and_sequence(tmp_path):
    """The rebuild is the one migration shape that can lose data invisibly."""
    path = tmp_path / "corpus.db"
    conn = _schema_18_executions(path)
    try:
        before = [tuple(r) for r in conn.execute(
            "SELECT id, execution_type, parameters, start_time, end_time, status,"
            " result_count, cancel_reason, error_message, dedup_total FROM executions ORDER BY id")]
        db.init_db(conn=conn)

        assert db.get_schema_version(conn) == 19
        after = [tuple(r) for r in conn.execute(
            "SELECT id, execution_type, parameters, start_time, end_time, status,"
            " result_count, cancel_reason, error_message, dedup_total FROM executions ORDER BY id")]
        assert after == before, "the rebuild altered a row it was only meant to move"
        assert conn.execute(
            "SELECT seq FROM sqlite_sequence WHERE name='executions'").fetchone()[0] == 41
        # The child link, which a DROP TABLE with foreign keys on would have
        # cascaded away without a word.
        assert conn.execute("SELECT COUNT(*) FROM execution_documents").fetchone()[0] == 1
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        # And the five new columns exist, NULL on every row that predates them.
        for column in ("owner_pid", "owner_runtime_id", "last_seen_at_utc",
                       "interrupted_reason", "restarted_from"):
            assert conn.execute(
                f"SELECT COUNT(*) FROM executions WHERE {column} IS NOT NULL"
            ).fetchone()[0] == 0, f"{column} was backfilled with a guess"
    finally:
        conn.close()


def test_the_old_daemon_restart_rows_history_is_not_rewritten(tmp_path):
    """`failed` + `cancel_reason='daemon_restart'` is what happened, and stays.

    Relabelling those rows `interrupted` now would be inventing an observation
    after the fact, which is the same mistake as the overclaim the new status
    exists to end -- only pointing backwards.
    """
    path = tmp_path / "corpus.db"
    conn = _schema_18_executions(path)
    try:
        db.init_db(conn=conn)
        row = dict(conn.execute("SELECT * FROM executions WHERE id = 2").fetchone())
        assert row["status"] == "failed"
        assert row["cancel_reason"] == "daemon_restart"
        assert row["interrupted_reason"] is None
    finally:
        conn.close()


def test_the_upgraded_check_admits_interrupted_and_still_refuses_a_new_word(tmp_path):
    """A rebuilt table can lose a constraint and look identical in a row count."""
    path = tmp_path / "corpus.db"
    conn = _schema_18_executions(path)
    try:
        db.init_db(conn=conn)
        conn.execute(
            "INSERT INTO executions (execution_type, parameters, start_time, status)"
            " VALUES ('deep_dive','{}','2026-01-04T00:00:00+00:00','interrupted')")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO executions (execution_type, parameters, start_time, status)"
                " VALUES ('deep_dive','{}','2026-01-04T00:00:00+00:00','paused')")
        # And the reason vocabulary is a CHECK too, not a convention.
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO executions (execution_type, parameters, start_time, status,"
                " interrupted_reason) VALUES ('deep_dive','{}','2026-01-04T00:00:00+00:00',"
                "'interrupted','power_cut')")
        for reason in db.INTERRUPTED_REASONS:
            conn.execute(
                "INSERT INTO executions (execution_type, parameters, start_time, status,"
                " interrupted_reason) VALUES ('deep_dive','{}','2026-01-04T00:00:00+00:00',"
                "'interrupted',?)", (reason,))
        print(f"schema 19 interrupted_reason: {len(db.INTERRUPTED_REASONS)} of "
              f"{len(db.INTERRUPTED_REASONS)} values accepted, from database.INTERRUPTED_REASONS")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Ownership and the liveness stamp
# ---------------------------------------------------------------------------


def test_a_new_execution_records_the_process_and_runtime_that_owns_it(db_conn):
    from implementation_scripts import runtime_identity
    exec_id = db.insert_execution(db_conn, {
        "execution_type": "deep_dive", "parameters": "{}",
        "start_time": db.utc_now_iso()})
    row = db.get_execution_by_id(db_conn, exec_id)
    assert row["owner_pid"] == os.getpid()
    assert row["owner_runtime_id"] == runtime_identity.current_runtime_id()
    assert row["last_seen_at_utc"]


def test_the_stage_boundary_and_the_heartbeat_both_stamp_liveness(db_conn):
    exec_id = db.insert_execution(db_conn, {
        "execution_type": "deep_sweep", "parameters": "{}",
        "start_time": db.utc_now_iso()})
    db_conn.execute("UPDATE executions SET last_seen_at_utc = NULL WHERE id = ?", (exec_id,))
    db_conn.commit()

    db.update_current_stage(db_conn, exec_id, "querying")
    first = db.get_execution_by_id(db_conn, exec_id)["last_seen_at_utc"]
    assert first

    assert db.touch_execution_heartbeat(db_conn, exec_id) is True
    # A terminal row is out of the heartbeat's reach, so a late beat cannot
    # touch a row another process has already reconciled.
    db.update_execution_status(db_conn, exec_id, "completed", end_time=db.utc_now_iso())
    assert db.touch_execution_heartbeat(db_conn, exec_id) is False


# ---------------------------------------------------------------------------
# Startup reconciliation, over a real database, in this process
# ---------------------------------------------------------------------------


def _dead_pid() -> int:
    """A pid the kernel is certain is not running.

    Forked, waited on, and reaped: the id is free at the moment this returns,
    and the window in which the OS could hand it to something else is the same
    window production lives with.
    """
    pid = os.fork()
    if pid == 0:                       # pragma: no cover - the child never returns
        os._exit(0)
    os.waitpid(pid, 0)
    return pid


def test_a_running_row_whose_owner_is_gone_becomes_interrupted(db_conn):
    dead = _dead_pid()
    orphan = db.insert_execution(db_conn, {
        "execution_type": "deep_sweep", "parameters": "{}",
        "start_time": db.utc_now_iso(),
        "owner_pid": dead, "owner_runtime_id": "11111111-1111-4111-8111-111111111111"})
    mine = db.insert_execution(db_conn, {
        "execution_type": "deep_dive", "parameters": "{}",
        "start_time": db.utc_now_iso(),
        "owner_pid": os.getpid(), "owner_runtime_id": "22222222-2222-4222-8222-222222222222"})

    counts = resmon_mod._reconcile_executions_on_startup()

    adopted = db.get_execution_by_id(db_conn, orphan)
    assert adopted["status"] == "interrupted"
    assert adopted["interrupted_reason"] == "owner_dead"
    assert adopted["end_time"]
    assert adopted["progress_events"] is None, "nothing was resumed, so nothing is claimed"

    live = db.get_execution_by_id(db_conn, mine)
    assert live["status"] == "running", (
        "a row whose owning process is alive was relabelled; that is the "
        "overclaim this whole change exists to avoid")
    assert counts["interrupted"] == 1 and counts["left_running"] == 1


def test_a_row_with_an_owner_but_no_pid_is_left_running(db_conn):
    """An owner was recorded and a pid was not, so there is nothing to ask.

    This is not a pre-19 row -- it carries a runtime id, so it was written by a
    build that records ownership -- and the clock rule for pre-19 rows would
    adopt it on no evidence at all. The rule this function states is to err
    toward alive, and this is the case that tests whether it actually does.
    """
    from datetime import datetime, timedelta, timezone
    orphanish = db_conn.execute(
        "INSERT INTO executions (execution_type, parameters, start_time, status,"
        " owner_runtime_id, owner_pid, last_seen_at_utc) VALUES"
        " ('deep_dive','{}',?,'running','33333333-3333-4333-8333-333333333333',NULL,NULL)",
        ((datetime.now(timezone.utc) - timedelta(days=9)).isoformat(),)).lastrowid
    db_conn.commit()

    counts = resmon_mod._reconcile_executions_on_startup()

    assert db_conn.execute(
        "SELECT status FROM executions WHERE id=?", (orphanish,)).fetchone()[0] == "running"
    assert counts["interrupted"] == 0 and counts["left_running"] == 1


def test_a_pre_schema_19_row_is_adopted_only_once_it_is_old_enough(db_conn):
    """No owner was ever recorded, so the clock is the only evidence there is."""
    from datetime import datetime, timedelta, timezone
    recent = db.insert_execution(db_conn, {
        "execution_type": "deep_dive", "parameters": "{}",
        "start_time": db.utc_now_iso()})
    ancient = db.insert_execution(db_conn, {
        "execution_type": "deep_dive", "parameters": "{}",
        "start_time": (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()})
    db_conn.execute(
        "UPDATE executions SET owner_pid = NULL, owner_runtime_id = NULL,"
        " last_seen_at_utc = NULL WHERE id IN (?, ?)", (recent, ancient))
    db_conn.commit()

    resmon_mod._reconcile_executions_on_startup()

    assert db.get_execution_by_id(db_conn, recent)["status"] == "running"
    assert db.get_execution_by_id(db_conn, ancient)["status"] == "interrupted"
    assert db.get_execution_by_id(db_conn, ancient)["interrupted_reason"] == "owner_dead"


def test_a_pid_we_cannot_ask_about_reads_as_alive(monkeypatch):
    """PID reuse and a permission error are refusals, never proof of death."""
    assert resmon_mod._owner_process_is_alive(os.getpid()) is True
    assert resmon_mod._owner_process_is_alive(None) is False
    assert resmon_mod._owner_process_is_alive(0) is False

    def _denied(pid, sig):
        raise PermissionError("not yours")

    monkeypatch.setattr(os, "kill", _denied)
    assert resmon_mod._owner_process_is_alive(4242) is True


# ---------------------------------------------------------------------------
# Restart and cancel, over the real routes and a real database
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    """The FastAPI app over a real (file-backed) database, with the suite's token."""
    from fastapi.testclient import TestClient
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    with TestClient(resmon_mod.app) as c:
        yield c
    resmon_mod._db_path = None
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def _row(client, status, **extra):
    conn = resmon_mod._get_db()
    exec_id = db.insert_execution(conn, {
        "execution_type": "deep_sweep",
        "parameters": '{"query": "diffusion", "repositories": ["arxiv"]}',
        "start_time": db.utc_now_iso(), **extra})
    if status != "running":
        db.update_execution_status(conn, exec_id, status, end_time=db.utc_now_iso(),
                                   **({"interrupted_reason": "owner_dead"}
                                      if status == "interrupted" else {}))
    return exec_id


@pytest.mark.parametrize("state", ["interrupted", "failed", "cancelled"])
def test_restart_makes_exactly_one_linked_run_from_a_stopped_one(client, state, monkeypatch):
    """One new execution per request, linked, and the source left alone."""
    monkeypatch.setattr(resmon_mod.SweepEngine, "run_prepared", lambda self, exec_id: None)
    source = _row(client, state)
    before = dict(resmon_mod._get_db().execute(
        "SELECT * FROM executions WHERE id = ?", (source,)).fetchone())

    resp = client.post(f"/api/executions/{source}/restart")

    assert resp.status_code == 202, resp.text
    new_id = resp.json()["execution_id"]
    assert resp.json()["restarted_from"] == source
    conn = resmon_mod._get_db()
    made = [r[0] for r in conn.execute(
        "SELECT id FROM executions WHERE restarted_from = ?", (source,))]
    assert made == [new_id], "a restart produced more or fewer than one run"
    new_row = dict(conn.execute("SELECT * FROM executions WHERE id = ?", (new_id,)).fetchone())
    # Byte-identical, not merely equivalent. This JSON is the search the user
    # asked for, and the search record and the reference exports render it as
    # such; anything the restart decides for itself belongs somewhere else.
    assert new_row["parameters"] == before["parameters"]
    assert new_row["execution_type"] == before["execution_type"]
    assert new_row["restarted_from"] == source
    after = dict(conn.execute("SELECT * FROM executions WHERE id = ?", (source,)).fetchone())
    assert after == before, "restart edited the run it was started from"
    assert client.get(f"/api/executions/{source}").json()["restarted_into"] == [new_id]


@pytest.mark.parametrize("state", ["running", "completed"])
def test_restart_refuses_a_live_or_finished_run_and_names_the_state(client, state):
    source = _row(client, state)
    resp = client.post(f"/api/executions/{source}/restart")
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    # A string, not an object: a renderer that renders `detail` straight into
    # the DOM would otherwise show `[object Object]`.
    assert isinstance(detail, str)
    assert state in detail and str(source) in detail


def test_restart_goes_through_the_manual_admission_cap(client, monkeypatch):
    """A restart cannot get resmon past the cap a manual run respects."""
    monkeypatch.setattr(resmon_mod.admission, "try_admit", lambda **kw: False)
    source = _row(client, "interrupted")
    resp = client.post(f"/api/executions/{source}/restart")
    assert resp.status_code == 429
    assert resmon_mod._get_db().execute(
        "SELECT COUNT(*) FROM executions WHERE restarted_from = ?", (source,)).fetchone()[0] == 0


def test_cancelling_an_interrupted_row_answers_with_its_state(client):
    source = _row(client, "interrupted")
    resp = client.post(f"/api/executions/{source}/cancel")
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert isinstance(detail, str), "detail is rendered straight into the DOM"
    assert "interrupted" in detail and str(source) in detail
    # Anything that needs the state structurally reads it off the row.
    assert client.get(f"/api/executions/{source}").json()["status"] == "interrupted"


def test_cancelling_an_id_that_never_existed_still_answers_409(client):
    """The shipped contract, kept: 409, and a sentence that says why."""
    resp = client.post("/api/executions/99999/cancel")
    assert resp.status_code == 409
    assert isinstance(resp.json()["detail"], str)
    assert "no record" in resp.json()["detail"]


def test_restart_reproduces_the_ai_choice_the_source_row_records(client, monkeypatch):
    """`execution_ai` is the only record of whether AI ran; it is the only claim made.

    Not the provider, the model or the credential: `parameters` never held
    those, and reconstructing them from a lane record would be a guess wearing
    the original run's clothes. The restart records the choice it made in its
    own `parameters`, so the next reader does not have to infer it again.
    """
    seen: list = []
    monkeypatch.setattr(resmon_mod.SweepEngine, "run_prepared",
                        lambda self, exec_id: seen.append(self.config.get("ai_enabled")))
    conn = resmon_mod._get_db()

    plain = _row(client, "interrupted")
    resp = client.post(f"/api/executions/{plain}/restart")
    assert resp.status_code == 202 and resp.json()["ai_enabled"] is False

    with_ai = _row(client, "interrupted")
    db.start_ai_lane(conn, with_ai, 0, lane_label="Lane 1", lane_kind="api_key",
                     provider="anthropic", model="a-model")
    resp = client.post(f"/api/executions/{with_ai}/restart")
    assert resp.status_code == 202 and resp.json()["ai_enabled"] is True
    # And it stays out of the stored search. The durable record of the choice
    # is the new run's own ``execution_ai`` rows, which is where this decision
    # was read from in the first place.
    for restarted in (plain, with_ai):
        stored = dict(conn.execute(
            "SELECT parameters FROM executions WHERE restarted_from=?",
            (restarted,)).fetchone())["parameters"]
        assert "ai_enabled" not in json.loads(stored)
    deadline = time.monotonic() + 10
    while len(seen) < 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert seen == [False, True], "the engine was not handed the recorded choice"


def test_the_terminal_state_list_the_progress_stream_reads_is_complete():
    """`stream_progress` branches on this tuple; it must hold every ended state.

    Structural, and deliberately so. The behaviour — that an interrupted run
    takes the persisted-batch path rather than the live generator — cannot be
    checked through `TestClient`: an SSE endpoint that never yields blocks
    inside the in-process portal, so the regression hangs the worker instead of
    failing, and no httpx timeout reaches it. The real-socket version of this
    check is in `test_executions_interrupted_boundary.py`, where a read timeout
    is a read timeout.

    What this one does see is the case that will actually happen: a sixth
    status arrives and one of the places that enumerates them is missed. The
    denominator is the CHECK in the shipped DDL, not a list retyped here.
    """
    import re
    ddl = db._EXECUTIONS_V19_DDL
    declared = set(re.search(r"status TEXT NOT NULL DEFAULT 'running' CHECK\(status IN \(([^)]*)\)\)",
                             ddl).group(1).replace("'", "").replace(" ", "").split(","))
    assert declared - {"running"} == set(resmon_mod._TERMINAL_EXECUTION_STATES), (
        "the progress stream's terminal list and the status CHECK disagree")
    assert set(resmon_mod._RESTARTABLE_STATES) < declared
    print(f"terminal states: {len(resmon_mod._TERMINAL_EXECUTION_STATES)} of "
          f"{len(declared)} statuses, M from database._EXECUTIONS_V19_DDL")


# There is deliberately no test that the startup hook closes its connection.
# `_close_db` is a no-op -- "a thread keeps its connection for its lifetime" --
# so any such assertion passes whether or not the call is there, and a check
# that cannot fail is worse than none: it reads like evidence. The `finally` in
# `_reconcile_executions_on_startup` is a shape the file keeps, not a leak it
# fixes, and its comment says so.
