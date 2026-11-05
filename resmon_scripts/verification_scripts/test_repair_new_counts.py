"""The one-time recount of earlier runs' new papers (``database._recount_run_new_papers``).

Before November 5, 2026, a run linked the papers it stored on the day it started
(in UTC) to itself as not new: ``documents.first_seen_at`` (SQLite's
``2026-11-05 10:00:00``) was compared with the run's start
(``2026-11-05T10:00:00Z``) as text, and the space sorts before the ``T``. The
engine compares them as times now; the first start of a build with the recount
works out once which papers were new to each earlier run. These hold it to that:

* a database written the old way gets the flags the rule gives, and so does one
  the old engine itself wrote, and no run's ``new_result_count`` changes;
* of two overlapping runs that linked a paper, the earlier-starting one gets it;
* the marker stops a second pass, and a settings reset keeps the marker;
* a run whose recounted flags disagree with its ``new_result_count`` is logged,
  one line per run up to a cap and then a count, and its count is left alone;
* a run with no end takes its last heartbeat as its end, and one with neither is
  left as it was and counted;
* a fresh install records the marker and recounts nothing;
* on an upgrade, the recount runs after the copy kept before it, and the log
  names that copy; on a database already at the current schema, or one a
  restore starts without a copy, it says none was kept.

Every database here is in the test's own temporary folder.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import database, upgrade_copy  # noqa: E402
from implementation_scripts import sweep_engine as se  # noqa: E402
from implementation_scripts.database import RUN_NEW_PAPERS_RECOUNTED_KEY, init_db  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
LOGGER = "implementation_scripts.database"


# ---------------------------------------------------------------------------
# A database written the old way
# ---------------------------------------------------------------------------


def _open(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@pytest.fixture
def db(tmp_path):
    """A database at today's schema, with the marker taken out again, as a build before the recount left it."""
    path = tmp_path / "resmon.db"
    init_db(str(path))
    conn = _open(path)
    conn.execute("DELETE FROM app_settings WHERE key = ?", (RUN_NEW_PAPERS_RECOUNTED_KEY,))
    conn.commit()
    yield path, conn
    conn.close()


def _paper(conn: sqlite3.Connection, n: int, first_seen_at: str) -> int:
    """A stored paper, first stored at *first_seen_at* in SQLite's own shape."""
    return conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash, first_seen_at) "
        "VALUES ('arxiv', ?, ?, ?, ?)",
        (f"2511.{n:05d}", f"A paper about lattice gauge theory, number {n}", f"hash-{n}", first_seen_at),
    ).lastrowid


def _run(conn: sqlite3.Connection, start: str, end: str | None, *, new_result_count: int | None = 0,
         dedup_new: int | None = None, last_seen: str | None = None, status: str = "completed") -> int:
    """A run, its times in ``now_iso()``'s shape, its counts as the old engine left them."""
    return conn.execute(
        "INSERT INTO executions (execution_type, parameters, start_time, end_time, status, "
        "new_result_count, dedup_new, last_seen_at_utc) VALUES ('deep_dive', '{}', ?, ?, ?, ?, ?, ?)",
        (start, end, status, new_result_count, dedup_new, last_seen),
    ).lastrowid


def _link(conn: sqlite3.Connection, run: int, paper: int, is_new: int = 0) -> None:
    conn.execute(
        "INSERT INTO execution_documents (execution_id, document_id, is_new) VALUES (?, ?, ?)",
        (run, paper, is_new))


def _start(path: Path, conn: sqlite3.Connection) -> None:
    """Commit what the test wrote, and start resmon on the database once."""
    conn.commit()
    init_db(str(path))


def _flags(conn: sqlite3.Connection, run: int) -> dict[int, int]:
    return {r["document_id"]: r["is_new"] for r in conn.execute(
        "SELECT document_id, is_new FROM execution_documents WHERE execution_id = ?", (run,))}


def _count(conn: sqlite3.Connection, run: int) -> int | None:
    return conn.execute("SELECT new_result_count FROM executions WHERE id = ?", (run,)).fetchone()[0]


def _recount_lines(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records
            if r.name == LOGGER and r.getMessage().startswith("Recounted which papers were new")]


# ---------------------------------------------------------------------------
# The rule
# ---------------------------------------------------------------------------


def test_a_database_written_the_old_way_gets_the_flags_the_rule_gives(db, caplog):
    path, conn = db
    # A run that stored two papers the day it started: both linked as not new.
    a = _run(conn, "2026-11-01T10:00:00Z", "2026-11-01T10:05:00Z", new_result_count=2, dedup_new=2)
    p1 = _paper(conn, 1, "2026-11-01 10:01:00")
    p2 = _paper(conn, 2, "2026-11-01 10:05:00")      # the run's last second: the window holds it
    _link(conn, a, p1)
    _link(conn, a, p2)
    # A later run that found one of them again and stored one more.
    b = _run(conn, "2026-11-02T09:00:00Z", "2026-11-02T09:03:00Z", new_result_count=1, dedup_new=1)
    p3 = _paper(conn, 3, "2026-11-02 09:01:30")
    _link(conn, b, p1)
    _link(conn, b, p3)
    # A run across midnight UTC: the paper stored after midnight was already marked new.
    c = _run(conn, "2026-11-03T23:59:00Z", "2026-11-04T00:01:00Z", new_result_count=2, dedup_new=2)
    p4 = _paper(conn, 4, "2026-11-03 23:59:30")
    p5 = _paper(conn, 5, "2026-11-04 00:00:30")
    _link(conn, c, p4)
    _link(conn, c, p5, is_new=1)

    with caplog.at_level(logging.INFO, logger=LOGGER):
        _start(path, conn)

    assert _flags(conn, a) == {p1: 1, p2: 1}
    assert _flags(conn, b) == {p1: 0, p3: 1}
    assert _flags(conn, c) == {p4: 1, p5: 1}
    # The counts were taken as the papers were stored, and are left as they were.
    assert (_count(conn, a), _count(conn, b), _count(conn, c)) == (2, 1, 2)
    assert conn.execute(
        "SELECT value FROM app_settings WHERE key = ?", (RUN_NEW_PAPERS_RECOUNTED_KEY,)).fetchone()[0] == "1"
    [line] = _recount_lines(caplog)
    assert ("3 run(s) with links corrected; 4 link(s) newly marked new, and 0 no longer new; "
            "0 run(s) with no end time left as they were; 0 run(s) whose new papers by the recount "
            "differ from their new-paper count, which was left as it was.") in line


def test_the_papers_the_old_engine_stored_are_new_to_the_run_that_stored_them(db, monkeypatch, tmp_path):
    """The old engine's own output, rather than rows written to look like it."""
    from implementation_scripts.api_base import NormalizedResult
    from implementation_scripts.progress import progress_store

    path, conn = db

    class _Stand:
        def search(self, query, date_from=None, date_to=None, max_results=100):
            return [NormalizedResult(
                source_repository="arxiv", external_id=f"2511.{n:05d}", doi=None,
                title=f"A paper about lattice gauge theory, number {n}", authors=["Ada Lovelace"],
                abstract="An abstract long enough to be kept.", publication_date="2026-11-01",
                url=f"https://arxiv.org/abs/2511.{n:05d}") for n in (1, 2)]

    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setattr(se, "get_client", lambda name, **kwargs: _Stand())
    monkeypatch.setattr(se, "_utc_clock", lambda stamp: str(stamp or ""))   # the comparison as text
    engine = se.SweepEngine(db_conn=conn, config={})
    run = engine.prepare_execution("deep_dive", ["arxiv"], {"query": "lattice", "max_results": 10})
    progress_store.register(run)
    engine.run_prepared(run)
    assert set(_flags(conn, run).values()) == {0}, "the old comparison is not what this run recorded"
    assert _count(conn, run) == 2, "the old engine's count was already right"

    _start(path, conn)
    assert set(_flags(conn, run).values()) == {1}
    assert _count(conn, run) == 2


def test_of_two_overlapping_runs_that_linked_a_paper_the_earlier_starting_one_gets_it(db):
    path, conn = db
    early = _run(conn, "2026-11-05T10:00:00Z", "2026-11-05T10:10:00Z", new_result_count=None)
    late = _run(conn, "2026-11-05T10:05:00Z", "2026-11-05T10:15:00Z", new_result_count=None)
    both = _paper(conn, 1, "2026-11-05 10:07:00")          # while both were going
    after_early = _paper(conn, 2, "2026-11-05 10:12:00")   # once only the later one was
    for run in (late, early):                              # recorded in either order
        _link(conn, run, both, is_new=1)
        _link(conn, run, after_early, is_new=1)
    # Two runs that started in the same second: the one recorded first gets it.
    first = _run(conn, "2026-11-06T08:00:00Z", "2026-11-06T08:05:00Z", new_result_count=None)
    second = _run(conn, "2026-11-06T08:00:00Z", "2026-11-06T08:06:00Z", new_result_count=None)
    tied = _paper(conn, 3, "2026-11-06 08:01:00")
    _link(conn, second, tied)
    _link(conn, first, tied)

    _start(path, conn)

    assert _flags(conn, early) == {both: 1, after_early: 0}
    assert _flags(conn, late) == {both: 0, after_early: 1}
    assert (_count(conn, early), _count(conn, late)) == (None, None), "a count is never written"
    assert (_flags(conn, first), _flags(conn, second)) == ({tied: 1}, {tied: 0})
    assert [tuple(r) for r in conn.execute(
        "SELECT document_id, SUM(is_new) FROM execution_documents GROUP BY document_id ORDER BY 1")] == [
        (both, 1), (after_early, 1), (tied, 1)], "a paper is new to one run at most"


def test_the_marker_stops_a_second_pass(db, caplog):
    path, conn = db
    run = _run(conn, "2026-11-01T10:00:00Z", "2026-11-01T10:05:00Z")
    paper = _paper(conn, 1, "2026-11-01 10:01:00")
    _link(conn, run, paper)
    _start(path, conn)
    assert _flags(conn, run) == {paper: 1}

    conn.execute("UPDATE execution_documents SET is_new = 0")
    with caplog.at_level(logging.INFO, logger=LOGGER):
        _start(path, conn)
    assert _flags(conn, run) == {paper: 0}
    assert not _recount_lines(caplog)


def test_a_settings_reset_keeps_the_marker(db):
    import resmon as resmon_mod

    path, conn = db
    _start(path, conn)
    conn.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('theme', 'dark')")
    cleared = resmon_mod._reset_settings(conn)
    conn.commit()
    assert cleared >= 1
    assert {r[0] for r in conn.execute("SELECT key FROM app_settings")} == set(
        database.KEPT_THROUGH_SETTINGS_RESET)


def _disagreement_lines(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records
            if r.name == LOGGER and (r.getMessage().startswith("Run ") or " more run(s) " in r.getMessage())]


def test_a_count_the_recounted_flags_disagree_with_is_logged_and_left_alone(db, caplog):
    path, conn = db
    # Three papers counted as new when the run stored them, and two of its links
    # that the recount finds new.
    run = _run(conn, "2026-11-01T10:00:00Z", "2026-11-01T10:05:00Z", new_result_count=3, dedup_new=3)
    for n in (1, 2):
        _link(conn, run, _paper(conn, n, "2026-11-01 10:02:00"))
    # A run whose count agrees with its flags, and one with no count at all, say nothing.
    agrees = _run(conn, "2026-11-02T10:00:00Z", "2026-11-02T10:05:00Z", new_result_count=1)
    _link(conn, agrees, _paper(conn, 3, "2026-11-02 10:01:00"))
    uncounted = _run(conn, "2026-11-03T10:00:00Z", "2026-11-03T10:05:00Z", new_result_count=None)
    _link(conn, uncounted, _paper(conn, 4, "2026-11-03 10:01:00"))
    with caplog.at_level(logging.INFO, logger=LOGGER):
        _start(path, conn)

    assert set(_flags(conn, run).values()) == {1}
    assert (_count(conn, run), _count(conn, agrees), _count(conn, uncounted)) == (3, 1, None)
    assert _disagreement_lines(caplog) == [
        f"Run {run}: 2 of its papers are new to it by the recount, and its new-paper count, "
        "left as it was, is 3."]
    [line] = _recount_lines(caplog)
    assert ("1 run(s) whose new papers by the recount differ from their new-paper count, "
            "which was left as it was.") in line


def test_the_disagreements_are_named_up_to_a_cap_and_the_rest_counted(db, caplog):
    path, conn = db
    cap = database._DISAGREEMENTS_LOGGED
    runs = []
    for n in range(cap + 5):
        run = _run(conn, f"2026-11-01T10:{n:02d}:00Z", f"2026-11-01T10:{n:02d}:30Z", new_result_count=0)
        _link(conn, run, _paper(conn, n, f"2026-11-01 10:{n:02d}:10"))
        runs.append(run)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        _start(path, conn)

    lines = _disagreement_lines(caplog)
    assert lines[:cap] == [
        f"Run {run}: 1 of its papers are new to it by the recount, and its new-paper count, "
        "left as it was, is 0." for run in runs[:cap]]
    assert lines[cap:] == ["5 more run(s) whose new papers by the recount differ from their new-paper count."]
    assert {_count(conn, run) for run in runs} == {0}
    [line] = _recount_lines(caplog)
    assert f"{cap + 5} run(s) whose new papers by the recount differ" in line


def test_a_run_with_no_end_takes_its_last_heartbeat_or_is_left_as_it_was(db, caplog):
    path, conn = db
    heard = _run(conn, "2026-11-05T10:00:00Z", None, new_result_count=None, status="interrupted",
                 last_seen="2026-11-05T10:10:00.123456+00:00")
    in_time = _paper(conn, 1, "2026-11-05 10:09:00")
    _link(conn, heard, in_time)
    silent = _run(conn, "2026-11-05T11:00:00Z", None, new_result_count=None, status="running")
    left = _paper(conn, 2, "2026-11-05 11:01:00")
    _link(conn, silent, left)
    # The silent run takes no part in deciding which run a paper was new to.
    later = _run(conn, "2026-11-05T11:00:30Z", "2026-11-05T11:02:00Z", new_result_count=None)
    _link(conn, later, left)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        _start(path, conn)

    assert _flags(conn, heard) == {in_time: 1}
    assert _flags(conn, silent) == {left: 0}
    assert {_count(conn, r) for r in (heard, silent, later)} == {None}
    assert _flags(conn, later) == {left: 1}
    [line] = _recount_lines(caplog)
    assert "1 run(s) with no end time left as they were" in line


def test_a_fresh_install_records_the_marker_and_recounts_nothing(tmp_path, caplog):
    path = tmp_path / "resmon.db"
    with caplog.at_level(logging.INFO, logger=LOGGER):
        init_db(str(path))
    conn = _open(path)
    try:
        assert conn.execute(
            "SELECT value FROM app_settings WHERE key = ?", (RUN_NEW_PAPERS_RECOUNTED_KEY,)).fetchone()[0] == "1"
    finally:
        conn.close()
    assert not _recount_lines(caplog)


@pytest.mark.parametrize("seed", range(5))
def test_the_recount_agrees_with_the_rule_restated_on_random_runs(db, seed):
    """Overlapping windows, shared starts, runs without an end, with and without a dedup_new.

    ``_as_recounted`` (in ``test_cumulative_upgrade.py``) restates the rule in
    Python, apart from the SQL; the two must give the same rows.
    """
    import random
    from datetime import datetime, timedelta, timezone

    from verification_scripts.test_cumulative_upgrade import _as_recounted

    rng = random.Random(seed)
    path, conn = db
    base = datetime(2026, 11, 1, 6, 0, tzinfo=timezone.utc)
    papers = [_paper(conn, n, (base + timedelta(seconds=rng.randrange(0, 4 * 3600))).strftime("%Y-%m-%d %H:%M:%S"))
              for n in range(80)]
    for _ in range(40):
        start = base + timedelta(minutes=rng.choice(range(0, 240, 5)))    # shared starts happen
        end = start + timedelta(seconds=rng.randrange(0, 1800))
        ended = rng.random() > 0.15
        run = _run(
            conn, start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            end.strftime("%Y-%m-%dT%H:%M:%SZ") if ended else None,
            new_result_count=rng.choice([0, None, 3]),
            dedup_new=rng.choice([None, None, rng.randrange(0, 6)]),
            last_seen=None if ended or rng.random() < 0.5 else end.isoformat(timespec="microseconds"),
            status="completed" if ended else "interrupted")
        for paper in rng.sample(papers, rng.randrange(0, 12)):
            _link(conn, run, paper, is_new=rng.randrange(0, 2))
    conn.commit()
    counts_before = [tuple(r) for r in conn.execute("SELECT id, new_result_count FROM executions ORDER BY id")]
    expected = _as_recounted(conn)
    try:
        want = (expected.execute("SELECT * FROM execution_documents ORDER BY 1, 2").fetchall(),
                expected.execute("SELECT id, new_result_count FROM executions ORDER BY id").fetchall())
        want = [[tuple(r) for r in rows] for rows in want]
    finally:
        expected.close()
    assert want[1] == counts_before

    _start(path, conn)
    got = [[tuple(r) for r in conn.execute("SELECT * FROM execution_documents ORDER BY 1, 2")],
           [tuple(r) for r in conn.execute("SELECT id, new_result_count FROM executions ORDER BY id")]]
    assert got == want
    assert sum(1 for row in got[0] if row[2]) > 0


# ---------------------------------------------------------------------------
# Where it runs in a start
# ---------------------------------------------------------------------------


def test_on_an_upgrade_it_runs_after_the_copy_and_names_it(tmp_path, caplog):
    path = tmp_path / "resmon.db"
    conn = _open(path)
    conn.executescript((FIXTURES / "schema-21" / "corpus.sql").read_text(encoding="utf-8"))
    conn.commit()
    before = conn.execute(
        "SELECT execution_id, document_id, is_new FROM execution_documents ORDER BY 1, 2").fetchall()
    conn.close()
    with caplog.at_level(logging.INFO, logger=LOGGER):
        init_db(str(path))

    copy = upgrade_copy.copy_path(path, 21)
    held = _open(copy)
    try:
        assert held.execute(
            "SELECT execution_id, document_id, is_new FROM execution_documents ORDER BY 1, 2"
        ).fetchall() == before, "the copy was taken after the recount changed the runs"
        assert held.execute(
            "SELECT 1 FROM app_settings WHERE key = ?", (RUN_NEW_PAPERS_RECOUNTED_KEY,)).fetchone() is None
    finally:
        held.close()
    upgraded = _open(path)
    try:
        # The fixture's links are hand-set; none of its papers was first stored inside its run.
        assert [tuple(r) for r in upgraded.execute(
            "SELECT execution_id, document_id, is_new FROM execution_documents ORDER BY 1, 2")] == [
            (1, 1, 0), (1, 2, 0), (1, 8, 0), (3, 7, 0)]
    finally:
        upgraded.close()
    [line] = _recount_lines(caplog)
    assert "The copy of the database kept before this start's upgrade is " in line
    assert line.endswith(f"{copy.name}.")


def test_a_copy_an_earlier_upgrade_left_is_not_named_as_this_starts(tmp_path, caplog):
    """A restore starts the restored database without keeping a copy of it first."""
    path = tmp_path / "resmon.db"
    conn = _open(path)
    conn.executescript((FIXTURES / "schema-21" / "corpus.sql").read_text(encoding="utf-8"))
    conn.commit()
    conn.close()
    stale = upgrade_copy.copy_path(path, 21)
    stale.write_bytes(b"")
    a_day_ago = time.time() - 86400
    os.utime(stale, (a_day_ago, a_day_ago))
    with caplog.at_level(logging.INFO, logger=LOGGER):
        init_db(str(path), keep_upgrade_copy=False)
    [line] = _recount_lines(caplog)
    assert line.endswith("No copy of the database was kept before this start's upgrade.")
    assert str(stale) not in line


def test_on_a_database_at_the_current_schema_it_says_no_copy_was_kept(db, caplog):
    path, conn = db
    with caplog.at_level(logging.INFO, logger=LOGGER):
        _start(path, conn)
    [line] = _recount_lines(caplog)
    assert line.endswith(
        f"No copy of the database was kept this start: it was already at schema {database.SCHEMA_VERSION}.")
    assert upgrade_copy.copies(path) == []


@pytest.mark.parametrize("stamp", [
    "2026-11-05T10:00:00Z", "2026-11-05 10:00:00", "2026-11-05T10:00:00.123456+00:00",
    "2026-11-05T23:59:59Z", "2026-11-05", "", None,
])
def test_the_sql_clock_reads_a_time_as_the_engine_does(stamp):
    conn = sqlite3.connect(":memory:")
    try:
        [read] = conn.execute(f"SELECT {database._UTC_CLOCK_SQL.format('?')}", (stamp,)).fetchone()
    finally:
        conn.close()
    assert read == se._utc_clock(stamp)
