# resmon_scripts/verification_scripts/test_metadata_hash_index.py
"""Schema 22: the cross-source duplicate check no longer reads the whole corpus.

``normalizer.deduplicate_batch`` calls ``find_duplicates_by_hash`` once for
every result a sweep stores, and ``documents.metadata_hash`` had no index, so
every one of those calls was a full scan of ``documents``. The performance
baseline of 628d1b5 found it: the storing stage took 6.9 s of a 28.2 s
ten-source sweep over 10,000 papers, and the cost grows with the corpus.

Two kinds of evidence, because each alone can be argued with:

  * the query plan SQLite chooses for the exact statement
    ``find_duplicates_by_hash`` runs -- captured from the connection, not
    copied into this file -- names the index; and
  * the work SQLite does for one lookup, counted in virtual-machine steps,
    stays flat when the corpus grows tenfold. The same count is taken with the
    index dropped, and there it grows with the corpus, which is what shows the
    measure can see a scan at all.

The 21 -> 22 step is checked from the corpus v2.3.0's own code wrote: one
``init_db`` adds the index and moves the marker, and nothing else.

What this does not establish: how much faster a sweep is. That is a
wall-clock question and is answered by the harness in ``perf/``, against the
recorded replies; the numbers are in the pull request that added this.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import database  # noqa: E402

INDEX = "idx_documents_metadata_hash"
V230_FIXTURE = Path(__file__).parent / "fixtures/v2.3.0/corpus_schema_21.sql"


def _open(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _lookup_sql(conn: sqlite3.Connection) -> list[str]:
    """The statements ``find_duplicates_by_hash`` sends, as SQLite received them."""
    seen: list[str] = []
    conn.set_trace_callback(seen.append)
    try:
        database.find_duplicates_by_hash(conn, "0" * 64)
    finally:
        conn.set_trace_callback(None)
    return [s for s in seen if s.lstrip().upper().startswith("SELECT")]


def _plan(conn: sqlite3.Connection) -> list[str]:
    """The query plan of the lookup's own statement, one detail line per step."""
    statements = _lookup_sql(conn)
    assert len(statements) == 1, statements
    sql = statements[0]
    # Python 3.10's trace callback hands over the statement as written, with
    # its placeholder; later versions may expand it. Bind only if it is there.
    params = ("0" * 64,) if "?" in sql else ()
    return [row[3] for row in conn.execute("EXPLAIN QUERY PLAN " + sql, params)]


def _steps_per_lookup(conn: sqlite3.Connection, metadata_hash: str) -> int:
    """SQLite virtual-machine instructions spent on one real lookup."""
    count = 0

    def tick() -> int:
        nonlocal count
        count += 1
        return 0

    conn.set_progress_handler(tick, 1)
    try:
        found = database.find_duplicates_by_hash(conn, metadata_hash)
    finally:
        conn.set_progress_handler(None, 0)
    assert len(found) == 1, "the lookup must find the one paper with that hash"
    return count


def _corpus(path: Path, papers: int) -> sqlite3.Connection:
    database.init_db(str(path))
    conn = _open(path)
    conn.executemany(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
        "VALUES (?, ?, ?, ?)",
        [("arxiv", f"id-{i}", f"Paper {i}", f"{i:064x}") for i in range(papers)],
    )
    conn.commit()
    return conn


def test_a_fresh_database_answers_the_duplicate_check_from_the_index(tmp_path):
    database.init_db(str(tmp_path / "fresh.db"))
    conn = _open(tmp_path / "fresh.db")
    try:
        assert database.get_schema_version(conn) == database.SCHEMA_VERSION == 24
        plan = _plan(conn)
        assert any(INDEX in step for step in plan), plan
        assert not any(step.startswith("SCAN") for step in plan), plan
    finally:
        conn.close()


def test_one_lookup_costs_the_same_at_ten_times_the_corpus(tmp_path):
    small = _corpus(tmp_path / "small.db", 500)
    large = _corpus(tmp_path / "large.db", 5_000)
    try:
        # A hash near the end, so a scan in insertion order cannot stop early.
        indexed_small = _steps_per_lookup(small, f"{499:064x}")
        indexed_large = _steps_per_lookup(large, f"{4_999:064x}")
        # One more level of the B-tree is allowed; a scan would be ~10x.
        assert indexed_large <= indexed_small * 1.5, (indexed_small, indexed_large)

        # The same measure without the index, to show it sees a scan when
        # there is one. Without this half, "flat" could mean "blind".
        for conn in (small, large):
            conn.execute(f"DROP INDEX {INDEX}")
        scanned_small = _steps_per_lookup(small, f"{499:064x}")
        scanned_large = _steps_per_lookup(large, f"{4_999:064x}")
        assert scanned_large >= scanned_small * 5, (scanned_small, scanned_large)
        assert scanned_large >= indexed_large * 50, (indexed_large, scanned_large)
    finally:
        small.close()
        large.close()


def _objects(conn: sqlite3.Connection) -> dict[str, str]:
    return {r[0]: r[1] for r in conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL")}


def _rows(conn: sqlite3.Connection) -> dict[str, list[tuple]]:
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND sql IS NOT NULL "
        "AND name NOT LIKE 'documents_fts%' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    return {t: [tuple(r) for r in conn.execute(f'SELECT * FROM "{t}" ORDER BY rowid')]
            for t in tables}


def test_the_v230_corpus_gains_the_index_and_nothing_else(tmp_path):
    """21 -> 22 over a database a released resmon wrote, as its next launch does.

    The launch also takes the steps past 22: schema 23 adds two tables, schema
    24 rebuilds ``assistant_session_choices`` with its rows, and the marker
    moves to 24. Those are those steps', and are named here so that nothing
    else can arrive or change unnoticed.
    """
    path = tmp_path / "v230.db"
    conn = _open(path)
    conn.executescript(V230_FIXTURE.read_text(encoding="utf-8"))
    conn.commit()
    assert database.get_schema_version(conn) == 21
    plan = _plan(conn)
    assert any(step.startswith("SCAN") for step in plan), (
        f"the v2.3.0 corpus should scan for a hash; its plan was {plan}")
    objects_before, rows_before = _objects(conn), _rows(conn)
    conn.close()

    database.init_db(str(path))            # the launch

    conn = _open(path)
    try:
        objects_after, rows_after = _objects(conn), _rows(conn)
        assert set(objects_after) - set(objects_before) == {INDEX} | set(database._ANSWER_RECORDS_V23_DDL)
        assert set(objects_before) - set(objects_after) == set()
        assert all(objects_after[n] == objects_before[n] for n in objects_before
                   if n != "assistant_session_choices")
        assert "'codex_cli'" in objects_after["assistant_session_choices"]
        assert objects_after[INDEX] == (
            "CREATE INDEX idx_documents_metadata_hash ON documents(metadata_hash)")

        settings_before = dict(rows_before.pop("app_settings"))
        settings_after = dict(rows_after.pop("app_settings"))
        assert settings_before.pop("schema_version") == "21"
        assert settings_after.pop("schema_version") == "24"
        # One-shot backfill markers this build writes on any launch, which the
        # cumulative-upgrade test names; they are not this step's doing.
        settings_after.pop("document_facets_backfilled", None)
        assert settings_after == settings_before
        # Schema 23's tables arrive empty; they are that step's, not this one's.
        assert rows_after.pop("assistant_turn_failures") == []
        assert rows_after.pop("execution_ai_models") == []
        assert rows_after == rows_before

        assert any(INDEX in step for step in _plan(conn))
    finally:
        conn.close()

    database.init_db(str(path))            # the launch after that
    conn = _open(path)
    try:
        assert _objects(conn) == objects_after
        assert database.get_schema_version(conn) == 24
    finally:
        conn.close()


def test_an_index_of_that_name_with_other_sql_is_a_conflict_not_accepted(tmp_path):
    path = tmp_path / "conflict.db"
    database.init_db(str(path))
    conn = _open(path)
    conn.execute(f"DROP INDEX {INDEX}")
    conn.execute(f"CREATE INDEX {INDEX} ON documents(title)")
    conn.execute("UPDATE app_settings SET value = '21' WHERE key = 'schema_version'")
    conn.commit()
    conn.close()

    with pytest.raises(sqlite3.DatabaseError, match="schema-22"):
        database.init_db(str(path))

    conn = _open(path)
    try:
        # The savepoint rolled back: the marker did not move past a refusal.
        assert database.get_schema_version(conn) == 21
    finally:
        conn.close()
