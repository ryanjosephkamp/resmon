"""Upgrading a database created by an earlier resmon.

CI builds every database from scratch, so it can only ever prove that a *fresh*
install works. It cannot catch a migration that breaks an existing one -- and
that is exactly what happened: 1.5.0 shipped an index on a column that the
migration had not added yet, so ``CREATE TABLE IF NOT EXISTS`` left the old
table alone, the index referenced a column that was not there, and the whole
schema script failed with ``no such column: pub_sort``. Every existing user's
backend refused to start.

These tests build databases with older schemas and then upgrade them.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import explorer  # noqa: E402
from implementation_scripts.database import init_db  # noqa: E402

# The documents table as it stood before Phase 2b: no pub_sort, no facet
# tables, no indexes. Anything created by resmon 1.4.0 or earlier looks like
# this.
PRE_2B_SCHEMA = """
CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_repository TEXT NOT NULL,
    external_id TEXT NOT NULL,
    doi TEXT,
    title TEXT NOT NULL,
    authors TEXT,
    abstract TEXT,
    publication_date TEXT,
    url TEXT,
    categories TEXT,
    metadata_hash TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_repository, external_id)
);
"""


@pytest.fixture
def legacy_conn():
    """A database as an earlier resmon would have left it, with real rows."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.executescript(PRE_2B_SCHEMA)
    c.executemany(
        "INSERT INTO documents (source_repository, external_id, doi, title, "
        "authors, abstract, publication_date, url, categories, metadata_hash) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
            ("arxiv", "1", "10.1/a", "Diffusion models", "Ada Lovelace, Alan Turing",
             "About diffusion.", "2026-01-15", "https://e.org/1", "cs.LG, stat.ML", "h1"),
            ("pubmed", "2", None, "Protein folding", "Grace Hopper",
             "About folding.", None, "https://e.org/2", "q-bio", "h2"),
        ],
    )
    c.commit()
    yield c
    c.close()


def test_an_existing_database_still_opens(legacy_conn):
    """The regression itself: this raised OperationalError and killed startup."""
    init_db(conn=legacy_conn)  # must not raise

    columns = [r[1] for r in legacy_conn.execute("PRAGMA table_xinfo(documents)")]
    assert "pub_sort" in columns, "the sort column should have been added"

    index = legacy_conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_documents_pubsort'"
    ).fetchone()
    assert index, "the sort index should have been created after the column"


def test_upgrading_is_idempotent(legacy_conn):
    """Every launch runs init_db; the second must be a no-op, not an error."""
    init_db(conn=legacy_conn)
    init_db(conn=legacy_conn)
    init_db(conn=legacy_conn)


def test_existing_rows_are_backfilled_into_the_search_index(legacy_conn):
    """Papers collected before the upgrade must become searchable."""
    init_db(conn=legacy_conn)

    r = explorer.search(legacy_conn, query="diffusion")
    assert [d["title"] for d in r["results"]] == ["Diffusion models"]
    assert r["used_full_text_index"] is True


def test_existing_rows_are_backfilled_into_the_facet_tables(legacy_conn):
    """Authors and categories from before the upgrade must be filterable."""
    init_db(conn=legacy_conn)

    f = explorer.facets(legacy_conn)
    assert {a["value"] for a in f["authors"]} >= {"Ada Lovelace", "Alan Turing", "Grace Hopper"}
    assert {c["value"] for c in f["categories"]} >= {"cs.LG", "stat.ML", "q-bio"}

    assert len(explorer.search(legacy_conn, authors=["Grace Hopper"])["results"]) == 1
    assert len(explorer.search(legacy_conn, categories=["stat.ML"])["results"]) == 1


def test_an_undated_legacy_paper_is_still_reachable(legacy_conn):
    """The pre-existing undated row must not vanish from pagination."""
    init_db(conn=legacy_conn)

    seen, cursor = [], None
    for _ in range(10):
        page = explorer.search(legacy_conn, cursor=cursor, limit=1)
        seen.extend(d["title"] for d in page["results"])
        cursor = page["next_cursor"]
        if not cursor:
            break

    assert sorted(seen) == ["Diffusion models", "Protein folding"]

# R04c: real baseline schema 14, not current DDL with a renamed marker.
CHOICES_SCHEMA_14 = Path(__file__).parent / 'fixtures/assistant_choices/schema_14.sql'


def choices_legacy(path):
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    c.executescript(CHOICES_SCHEMA_14.read_text())
    return c


def choices_rows(c):
    tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")
              if not r[0].startswith(('sqlite_', 'documents_fts', 'assistant_session_choices', 'assistant_turn_choices'))
              and r[0] not in ('library_vault', 'library_files', 'library_file_documents')]
    result = {}
    for name in tables:
        result[name] = sorted([tuple(r) for r in c.execute('SELECT * FROM "' + name + '"')], key=repr)
    return result


def choices_objects(c):
    return {r[0]: r[1] for r in c.execute("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL")}


def test_choices_upgrade_preserves_every_baseline_row_and_fts(tmp_path):
    from implementation_scripts import database
    c = choices_legacy(tmp_path / 'legacy.db')
    before = choices_rows(c)
    old_objects = choices_objects(c)
    fts = [tuple(r) for r in c.execute("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'diffusion'")]
    assert fts == [(1,)]  # Exercise the populated index, not two empty answers.
    assert len(before) == 22 and all(before.values())
    database.init_db(conn=c)
    assert database.get_schema_version(c) == 16
    after = choices_rows(c)
    after['app_settings'] = [(k, '14' if k == 'schema_version' else v) for k, v in after['app_settings']]
    assert after == before
    assert [tuple(r) for r in c.execute("SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'diffusion'")] == fts
    assert set(choices_objects(c)) - set(old_objects) == set(database._ASSISTANT_CHOICES_DDL) | set(database._LIBRARY_DDL)
    for name, ddl in old_objects.items():
        assert choices_objects(c)[name] == ddl
    for name in ('assistant_session_choices', 'assistant_turn_choices'):
        assert c.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] == 0
    fresh = sqlite3.connect(tmp_path / 'fresh.db')
    database.init_db(conn=fresh)
    assert choices_objects(fresh) == choices_objects(c)
    database.init_db(conn=c)
    database.init_db(conn=c)
    c.close()
    c = sqlite3.connect(tmp_path / 'legacy.db')
    database.init_db(conn=c)
    assert database.get_schema_version(c) == 16
    assert c.execute('SELECT COUNT(*) FROM assistant_session_choices').fetchone()[0] == 0
    c.close(); fresh.close()


@pytest.mark.parametrize('blocker', [
    'CREATE VIEW assistant_session_choices AS SELECT 1',
    'CREATE TABLE assistant_session_choices(wrong TEXT)',
    'CREATE VIEW assistant_turn_choices AS SELECT 1',
    'CREATE TABLE idx_assistant_turn_choices_assistant_message(wrong TEXT)',
    'CREATE INDEX idx_assistant_turn_choices_assistant_message ON assistant_messages(content)',
])
def test_choices_blocking_objects_roll_back_partial_upgrade(tmp_path, blocker):
    from implementation_scripts import database
    c = choices_legacy(tmp_path / 'blocked.db')
    c.execute(blocker); c.commit()
    before = choices_objects(c)
    rows = choices_rows(c)
    with pytest.raises(sqlite3.DatabaseError, match='Conflicting schema-15 object'):
        database.init_db(conn=c)
    assert database.get_schema_version(c) == 14
    assert choices_objects(c) == before
    assert choices_rows(c) == rows
    c.close()


@pytest.mark.parametrize('stage', ['second_table', 'index', 'marker'])
def test_choices_actual_sql_authorizer_failure_rolls_back(tmp_path, stage):
    from implementation_scripts import database
    c = choices_legacy(tmp_path / 'failed.db')
    before = choices_objects(c)
    rows = choices_rows(c)
    denied = []
    def reject(action, arg1, arg2, dbname, trigger):
        if ((stage == 'second_table' and action == sqlite3.SQLITE_CREATE_TABLE and arg1 == 'assistant_turn_choices')
                or (stage == 'index' and action == sqlite3.SQLITE_CREATE_INDEX and arg1 == 'idx_assistant_turn_choices_assistant_message')
                or (stage == 'marker' and action == sqlite3.SQLITE_UPDATE and arg1 == 'app_settings' and arg2 == 'value')):
            denied.append((action, arg1, arg2))
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    c.set_authorizer(reject)
    with pytest.raises(sqlite3.DatabaseError):
        database.init_db(conn=c)
    # Python 3.10 requires a callable here; None disables it only on 3.11+.
    c.set_authorizer(lambda *_: sqlite3.SQLITE_OK)
    assert denied, 'The intended DDL/marker operation must actually be denied'
    assert database.get_schema_version(c) == 14
    assert choices_objects(c) == before
    assert choices_rows(c) == rows
    database.init_db(conn=c)
    assert database.get_schema_version(c) == 16
    c.close()
