"""What a second launch must not do: re-index the corpus, or undo the user.

``init_db`` runs on every start of the backend, and every step in it is meant
to be safe to re-run. Two were not, and neither failure is visible from a fresh
database -- the only place they show is the *second* launch of a database that
has rows in it, which is every launch a real user makes.

* **The facet backfill re-indexed the whole corpus, every time.** It decided
  whether it had work to do by comparing
  ``COUNT(DISTINCT document_id) FROM document_authors`` against
  ``COUNT(*) FROM documents``. A document with no authors -- OSTI, GovInfo and
  dataset records produce them, and the shipped v2.1.0 fixture already has one
  -- contributes no author rows, so the two counts can never converge. Every
  launch then re-read every document and re-ran ``index_document_facets`` over
  all of them inside a write transaction, repairing nothing: every insert is an
  ``INSERT OR IGNORE`` that conflicts. Measured on synthetic corpora differing
  only in whether one document has an empty author string, ``init_db`` went
  from 6 ms to 291 ms at 50,000 documents and to 1,176 ms at 200,000, on every
  launch, with peak RSS rising from 58 MB to 188 MB.

* **The schema-21 email-target seed re-created a target the user had
  deleted.** The seed was guarded only by "does this routine already have an
  email target", not by whether the upgrade that introduced it had already
  run, so ``delivery.delete_target`` held until the next launch and no longer.

Both are exercised on a fresh database *and* on the released v2.1.0 fixture
walked to today's schema by one ``init_db``, because a migration that has only
ever been run against a fresh database is a migration nobody has tested -- the
lesson schema 13 taught, where an index over a new column aborted ``init_db``
on every existing corpus while passing on every fresh one.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "resmon_scripts"))

from implementation_scripts import database as db  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures/v2.1.0/corpus_schema_13.sql"


# ---------------------------------------------------------------------------
# Two databases: one fresh, one a released corpus walked up to today
# ---------------------------------------------------------------------------


def _fresh(path: Path) -> Path:
    db.init_db(str(path))
    return path


def _upgraded(path: Path) -> Path:
    """A v2.1.0 (schema 13) corpus, taken to today's schema by one ``init_db``.

    The same fixture ``test_cumulative_upgrade.py`` walks, and it is the fixture
    that matters here: it was written by v2.1.0's own code and it already
    contains a document with no author rows, which is the shape that made the
    count comparison permanently unequal.
    """
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(FIXTURE.read_text(encoding="utf-8"))
    conn.commit()
    assert db.get_schema_version(conn) == 13
    conn.close()
    db.init_db(str(path))
    return path


@pytest.fixture(params=["fresh", "upgraded"])
def corpus_path(request, tmp_path) -> Path:
    path = tmp_path / "corpus.db"
    return _fresh(path) if request.param == "fresh" else _upgraded(path)


def _seed_authorless_document(path: Path) -> None:
    """One paper whose source returned no authors. OSTI and GovInfo produce them."""
    conn = db.get_connection(path)
    try:
        db.insert_document(conn, {
            "source_repository": "osti", "external_id": "no-authors-1", "doi": None,
            "title": "A dataset record with no named authors", "authors": "",
            "abstract": "", "publication_date": "2026-01-01", "url": "u",
            "categories": "", "metadata_hash": "authorless-1",
        })
        conn.commit()
    finally:
        conn.close()


def _count_facet_indexing(monkeypatch) -> list:
    """Record every ``index_document_facets`` call the next ``init_db`` makes."""
    calls: list = []
    real = db.index_document_facets

    def counted(conn, document_id, *args, **kwargs):
        calls.append(document_id)
        return real(conn, document_id, *args, **kwargs)

    monkeypatch.setattr(db, "index_document_facets", counted)
    return calls


# ---------------------------------------------------------------------------
# The facet backfill
# ---------------------------------------------------------------------------


def test_a_launch_does_not_reindex_a_corpus_that_holds_an_authorless_document(
        corpus_path, monkeypatch):
    """One document with no authors must not cost a full re-index on every start.

    The assertion is zero rather than "fewer than before": there is nothing for
    the backfill to repair on a corpus it has already walked, and any number
    above zero is the whole corpus being re-read on the next launch too.
    """
    _seed_authorless_document(corpus_path)
    db.init_db(str(corpus_path))          # the launch that first sees the new row

    calls = _count_facet_indexing(monkeypatch)
    db.init_db(str(corpus_path))          # the launch after it

    conn = db.get_connection(corpus_path)
    try:
        documents = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        faceted = conn.execute(
            "SELECT COUNT(DISTINCT document_id) FROM document_authors").fetchone()[0]
    finally:
        conn.close()
    print(f"re-indexed {len(calls)} of {documents} documents on the second launch "
          f"({faceted} of {documents} have author rows at all)")
    assert faceted < documents, "the fixture must hold an authorless document"
    assert calls == []


def test_the_backfill_fills_a_gap_once_and_records_that_it_did(corpus_path, monkeypatch):
    """The backfill still does its job: documents with no facet rows get them.

    Built by writing rows straight into ``documents`` without the facet tables,
    which is what every pre-schema-10 corpus looks like on the launch that
    upgrades it. The second launch must then do nothing at all.
    """
    conn = db.get_connection(corpus_path)
    try:
        conn.execute("DELETE FROM app_settings WHERE key = ?", (db._FACETS_BACKFILL_KEY,))
        for index in range(3):
            conn.execute(
                "INSERT INTO documents (source_repository, external_id, title, "
                "authors, categories, metadata_hash) VALUES ('arxiv', ?, ?, ?, ?, ?)",
                (f"gap-{index}", f"Paper {index}", "G. Ap; H. Elper",
                 "cond-mat.supr-con", f"gap-hash-{index}"))
        conn.execute("DELETE FROM document_authors")
        conn.execute("DELETE FROM document_categories")
        conn.commit()
        gaps = [r[0] for r in conn.execute(
            "SELECT id FROM documents d WHERE NOT EXISTS "
            "(SELECT 1 FROM document_authors a WHERE a.document_id = d.id)")]
    finally:
        conn.close()
    assert gaps, "nothing to backfill; the test would prove nothing"

    first = _count_facet_indexing(monkeypatch)
    db.init_db(str(corpus_path))
    print(f"backfilled {len(first)} of {len(gaps)} documents with no facet rows")
    assert set(first) >= {g for g in gaps}

    conn = db.get_connection(corpus_path)
    try:
        authors = conn.execute(
            "SELECT COUNT(*) FROM document_authors WHERE document_id = ?",
            (gaps[0],)).fetchone()[0]
    finally:
        conn.close()
    assert authors == 2, "the gap was walked but nothing was written"

    second = _count_facet_indexing(monkeypatch)
    db.init_db(str(corpus_path))
    assert second == [], "the backfill ran a second time over work it had finished"


def test_the_backfill_is_bounded_in_memory_rather_than_materialized(corpus_path):
    """It iterates a cursor; it does not fetchall the whole projection.

    ``.fetchall()`` on ``SELECT id, authors, categories FROM documents`` put the
    whole corpus in Python at once -- peak RSS rose from 58 MB to 188 MB on the
    200,000-document measurement. A cursor is the difference, and the only way
    to assert on it from outside is to watch what the step asks the database
    for: a bounded gap query rather than every row of ``documents``.
    """
    conn = db.get_connection(corpus_path)
    try:
        conn.execute("DELETE FROM app_settings WHERE key = ?", (db._FACETS_BACKFILL_KEY,))
        conn.commit()
    finally:
        conn.close()

    statements: list[str] = []
    conn = db.get_connection(corpus_path)
    try:
        conn.set_trace_callback(statements.append)
        db._migrate_search_index(conn)
    finally:
        conn.set_trace_callback(None)
        conn.close()

    unbounded = [s for s in statements
                 if "FROM documents" in s and "NOT EXISTS" not in s
                 and "COUNT" not in s and "documents_fts" not in s]
    print(f"{len(unbounded)} of {len(statements)} statements read documents unfiltered")
    assert unbounded == [], unbounded


# ---------------------------------------------------------------------------
# The schema-21 email-target seed
# ---------------------------------------------------------------------------


def _routine_with_email(path: Path) -> int:
    conn = db.get_connection(path)
    try:
        cursor = conn.execute(
            "INSERT INTO routines (name, schedule_cron, parameters, is_active, "
            "email_enabled, created_at) VALUES ('nightly', '0 3 * * *', '{}', 0, 1, ?)",
            ("2026-01-01T00:00:00Z",))
        conn.commit()
        return int(cursor.lastrowid)
    finally:
        conn.close()


def _email_targets(path: Path, routine_id: int) -> list:
    conn = db.get_connection(path)
    try:
        return [dict(r) for r in conn.execute(
            "SELECT id, channel, target, mode FROM routine_delivery_targets "
            "WHERE routine_id = ? AND channel = 'email' ORDER BY id", (routine_id,))]
    finally:
        conn.close()


def test_a_deleted_email_target_stays_deleted_across_a_launch(corpus_path):
    """A destination the user removed is not a destination the app puts back.

    ``delivery.delete_target`` removed the row and the next ``init_db`` seeded a
    fresh one, so the only way to stop email was the separate ``email_enabled``
    toggle, which is a different control in a different place. Deleting a thing
    twice and having it come back twice is not a control.
    """
    from implementation_scripts import delivery

    routine_id = _routine_with_email(corpus_path)
    db.init_db(str(corpus_path))          # the launch that seeds the target

    seeded = _email_targets(corpus_path, routine_id)
    assert len(seeded) == 1, seeded
    assert seeded[0]["mode"] == "automatic"

    conn = db.get_connection(corpus_path)
    try:
        assert delivery.delete_target(conn, seeded[0]["id"]) is True
    finally:
        conn.close()
    assert _email_targets(corpus_path, routine_id) == []

    db.init_db(str(corpus_path))          # the next launch
    remaining = _email_targets(corpus_path, routine_id)
    print(f"{len(remaining)} of 0 expected email targets after the next launch")
    assert remaining == []


def test_the_upgrade_that_introduced_the_seed_still_seeds(corpus_path):
    """R3: the routine that had completion emails before schema 21 still has them.

    The seed is what kept that promise, so gating it must not switch it off.
    This rewinds the stored schema version to 20 -- which is what the launch
    performing the 20 -> 21 upgrade sees -- and asserts the target appears.
    """
    routine_id = _routine_with_email(corpus_path)
    conn = db.get_connection(corpus_path)
    try:
        conn.execute("UPDATE app_settings SET value = '20' WHERE key = 'schema_version'")
        conn.execute("DELETE FROM routine_delivery_targets WHERE routine_id = ?",
                     (routine_id,))
        conn.commit()
    finally:
        conn.close()

    db.init_db(str(corpus_path))
    seeded = _email_targets(corpus_path, routine_id)
    assert len(seeded) == 1, seeded
    assert seeded[0]["target"] == "", (
        "an empty target means the address configured in Settings -> Email, "
        "which is where it came from before schema 21")
