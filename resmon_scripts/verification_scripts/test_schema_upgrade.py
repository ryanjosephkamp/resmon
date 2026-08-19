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
