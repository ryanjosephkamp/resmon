"""Schema 26 -> 27: ``executions`` rebuilt so a run can be a find, without losing a run's records.

The rebuild drops and renames ``executions`` with foreign keys off, as schemas
19 and 25 rebuild theirs, so nothing at the database's level would notice a
row a child table points at going missing. Every table that references
``executions`` is checked before the step is released (``foreign_key_check``),
against what already dangled before it. The schema-26 database is the
committed corpus resmon's own code wrote (``fixtures/schema-26/corpus.sql``).
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from implementation_scripts import database

CORPUS_26 = Path(__file__).parent / "fixtures" / "schema-26" / "corpus.sql"


def _schema_26(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(CORPUS_26.read_text(encoding="utf-8"))
        conn.commit()
        assert database.get_schema_version(conn) == 26
    finally:
        conn.close()


def _state(path: Path) -> dict:
    conn = sqlite3.connect(path)
    try:
        return {
            "version": database.get_schema_version(conn),
            "executions_sql": conn.execute("SELECT sql FROM sqlite_master WHERE name = 'executions'").fetchone()[0],
            "executions": conn.execute("SELECT * FROM executions ORDER BY id").fetchall(),
            "execution_documents": conn.execute("SELECT * FROM execution_documents ORDER BY rowid").fetchall(),
            "execution_sources": conn.execute("SELECT * FROM execution_sources ORDER BY rowid").fetchall(),
        }
    finally:
        conn.close()


def _links(state: dict) -> list[tuple[int, int]]:
    return [(r[0], r[1]) for r in state["execution_documents"]]


def test_the_rebuild_keeps_every_run_and_every_runs_record(tmp_path):
    path = tmp_path / "corpus.db"
    _schema_26(path)
    before = _state(path)
    assert before["execution_documents"], "the fixture's runs have papers linked"
    database.init_db(str(path), keep_upgrade_copy=False)
    after = _state(path)
    assert after["version"] == 27 and "'find_paper'" in after["executions_sql"]
    assert (after["executions"], after["execution_sources"]) == (before["executions"], before["execution_sources"])
    # Every link kept; whether each paper was new to its run is the one-time
    # recount's to rewrite (``database._recount_run_new_papers``), not this step's.
    assert _links(after) == _links(before)


def test_a_rebuild_that_would_leave_a_runs_record_without_its_run_is_undone(tmp_path, monkeypatch):
    """A copy that lost a run went unnoticed: foreign keys are off around the rebuild."""
    path = tmp_path / "corpus.db"
    _schema_26(path)
    before = _state(path)
    linked = sqlite3.connect(path).execute("SELECT max(execution_id) FROM execution_documents").fetchone()[0]
    # A copy that loses one run whose papers are linked to it.
    monkeypatch.setattr(database, "_EXECUTIONS_V27_COPY",
                        database._EXECUTIONS_V27_COPY + f" WHERE id <> {int(linked)}")
    with pytest.raises(sqlite3.DatabaseError, match="without its run"):
        database.init_db(str(path), keep_upgrade_copy=False)
    after = _state(path)
    assert after == before, "the step was not undone"


def test_a_reference_that_already_dangled_is_carried_not_judged(tmp_path):
    # A backup can carry such a row; the upgrade keeps it rather than refuse the database.
    path = tmp_path / "corpus.db"
    _schema_26(path)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys=OFF")
    document = conn.execute("SELECT min(id) FROM documents").fetchone()[0]
    conn.execute("INSERT INTO execution_documents (execution_id, document_id, is_new) VALUES (9999, ?, 0)",
                 (document,))
    conn.commit()
    conn.close()
    before = _state(path)
    database.init_db(str(path), keep_upgrade_copy=False)
    after = _state(path)
    assert after["version"] == 27
    assert (9999, document) in _links(after) and _links(after) == _links(before)
