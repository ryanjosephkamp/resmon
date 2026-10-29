"""DOAJ dates already stored with the month as a name are rewritten, and nothing else is.

#259 made the DOAJ client store ``2025-01-01`` where it used to store
``2025-January-01``, and left the rows already stored as they were. This is the
repair of those rows: ``database._repair_doaj_month_names``, which ``init_db``
runs on every launch and which finds nothing after the first.

The standard every case is held to is a record fetched today. A repaired row
must carry the date and the ``metadata_hash`` the fixed client and the
normalizer would give the same record now, so cross-source dedup treats it
exactly as it would a fresh one -- or, where the stored hash cannot be
reproduced, exactly as it did before.
"""

from __future__ import annotations

import dataclasses
import logging
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "resmon_scripts"))

from implementation_scripts import database  # noqa: E402
from implementation_scripts.api_doaj import DoajClient  # noqa: E402
from implementation_scripts.normalizer import deduplicate_batch, normalize_result  # noqa: E402
from implementation_scripts.utils import compute_metadata_hash  # noqa: E402

RELEASED_CORPUS = Path(__file__).parent / "fixtures/v2.3.0/corpus_schema_21.sql"


def _record(external_id: str, month: object, authors: list[str], title: str = "Owls of the northern coast"):
    """What the DOAJ client returns today for a record with this month."""
    result = DoajClient._parse_article({"id": external_id, "bibjson": {
        "title": title, "year": 2025, "month": month,
        "author": [{"name": name} for name in authors],
    }})
    assert result is not None
    return result


def _store_as_before_259(conn: sqlite3.Connection, external_id: str, month: str,
                         authors: list[str], title: str = "Owls of the northern coast") -> None:
    """Store a record exactly as resmon did before #259.

    The client is the only thing #259 changed: it used to zero-pad the month as
    it came. Everything after it -- the normalizer, which keeps a date it cannot
    parse as it is, the hash over that date, and the insert -- is today's code.
    """
    record = dataclasses.replace(_record(external_id, month, authors, title),
                                 publication_date=f"2025-{month.zfill(2)}-01")
    assert deduplicate_batch(conn, [record])["new"] == 1


def _row(conn: sqlite3.Connection, external_id: str, source: str = "doaj") -> dict:
    return dict(conn.execute(
        "SELECT publication_date, metadata_hash FROM documents "
        "WHERE source_repository = ? AND external_id = ?", (source, external_id)).fetchone())


@pytest.fixture()
def conn(tmp_path: Path):
    path = tmp_path / "corpus.db"
    database.init_db(str(path))
    connection = database.get_connection(str(path))
    yield connection
    connection.close()


@pytest.mark.parametrize("month, number", [
    ("January", "01"), ("Jul", "07"), ("Sept.", "09"), ("SEPTEMBER", "09"), ("may", "05"), ("dec", "12"),
])
def test_a_stored_month_name_becomes_what_a_record_fetched_today_stores(conn, month: str, number: str):
    authors = ["Ada Okafor", "Lin Wei"]
    _store_as_before_259(conn, "doaj-1", month, authors)
    assert _row(conn, "doaj-1")["publication_date"] == f"2025-{month}-01"

    assert database._repair_doaj_month_names(conn) == 1

    today = normalize_result(_record("doaj-1", month, authors))
    assert _row(conn, "doaj-1") == {
        "publication_date": f"2025-{number}-01",
        "metadata_hash": today._metadata_hash,  # type: ignore[attr-defined]
    }
    assert today.publication_date == f"2025-{number}-01"


def test_the_repaired_date_is_one_analytics_and_sorting_can_read(conn):
    _store_as_before_259(conn, "doaj-1", "January", ["Ada Okafor"])
    _store_as_before_259(conn, "doaj-2", "December", ["Ada Okafor"], title="A second paper")
    database._repair_doaj_month_names(conn)
    rows = conn.execute(
        "SELECT external_id, substr(publication_date, 1, 7), julianday(publication_date) "
        "FROM documents WHERE source_repository = 'doaj' ORDER BY publication_date").fetchall()
    assert [(r[0], r[1]) for r in rows] == [("doaj-1", "2025-01"), ("doaj-2", "2025-12")]
    assert all(r[2] is not None for r in rows)


def test_only_doaj_rows_with_a_month_the_client_knows_are_rewritten(conn):
    _store_as_before_259(conn, "named", "July", ["Ada Okafor"])
    # The client's year-alone fallback is a guess about a new record; a kept
    # row whose month it cannot read stays as it was stored.
    _store_as_before_259(conn, "season", "Spring", ["Ada Okafor"], title="Spring")
    _store_as_before_259(conn, "out-of-range", "13", ["Ada Okafor"], title="Thirteen")
    _store_as_before_259(conn, "numbered", "7", ["Ada Okafor"], title="Numbered")
    conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, publication_date, metadata_hash) "
        "VALUES ('doaj', 'undated', 'Undated', NULL, 'h-undated'), "
        "('crossref', 'other-source', 'Another source', '2025-January-01', 'h-other')")
    before = {r[0]: dict(r) for r in conn.execute(
        "SELECT external_id, source_repository, publication_date, metadata_hash FROM documents")}

    assert database._repair_doaj_month_names(conn) == 1

    after = {r[0]: dict(r) for r in conn.execute(
        "SELECT external_id, source_repository, publication_date, metadata_hash FROM documents")}
    assert {k for k in before if before[k] != after[k]} == {"named"}
    assert after["named"]["publication_date"] == "2025-07-01"
    assert after["season"]["publication_date"] == "2025-Spring-01"
    assert after["out-of-range"]["publication_date"] == "2025-13-01"
    assert after["numbered"]["publication_date"] == "2025-07-01"
    assert after["other-source"]["publication_date"] == "2025-January-01"


def test_a_year_and_a_month_name_alone_is_the_first_of_that_month(conn):
    conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, authors, publication_date, metadata_hash) "
        "VALUES ('doaj', 'bare', 'Bare', 'Ada Okafor', '2025-July', ?)",
        (compute_metadata_hash("Bare", ["Ada Okafor"], "2025-July"),))
    assert database._repair_doaj_month_names(conn) == 1
    assert _row(conn, "bare") == {
        "publication_date": "2025-07-01",
        "metadata_hash": compute_metadata_hash("Bare", ["Ada Okafor"], "2025-07-01"),
    }


def test_a_hash_that_cannot_be_reproduced_is_kept_and_the_date_still_repaired(conn):
    # "Smith, John, Jr." normalizes to "John, Jr. Smith", which the joined
    # authors column cannot give back as one name. Recomputing from the split
    # would hash a paper with three authors that has two.
    authors = ["Ada Okafor", "Smith, John, Jr."]
    _store_as_before_259(conn, "doaj-1", "March", authors)
    stored = _row(conn, "doaj-1")

    assert database._repair_doaj_month_names(conn) == 1

    assert _row(conn, "doaj-1") == {"publication_date": "2025-03-01", "metadata_hash": stored["metadata_hash"]}


def test_the_repair_says_what_it_did_and_a_second_launch_changes_nothing(tmp_path: Path, caplog):
    path = tmp_path / "corpus.db"
    database.init_db(str(path))
    conn = database.get_connection(str(path))
    try:
        _store_as_before_259(conn, "doaj-1", "January", ["Ada Okafor"])
        _store_as_before_259(conn, "doaj-2", "Feb", ["Smith, John, Jr."], title="Kept hash")
        conn.commit()
    finally:
        conn.close()

    with caplog.at_level(logging.INFO, logger=database.logger.name):
        database.init_db(str(path))
    assert ("Rewrote 2 DOAJ publication date(s) stored with the month as a name; "
            "1 hash(es) recomputed, 1 kept because they could not be reproduced") in caplog.text

    conn = database.get_connection(str(path))
    try:
        first = conn.execute("SELECT * FROM documents ORDER BY id").fetchall()
        assert database._repair_doaj_month_names(conn) == 0
    finally:
        conn.close()
    caplog.clear()
    with caplog.at_level(logging.INFO, logger=database.logger.name):
        database.init_db(str(path))
    assert "DOAJ" not in caplog.text
    conn = database.get_connection(str(path))
    try:
        assert [tuple(r) for r in conn.execute("SELECT * FROM documents ORDER BY id")] == [tuple(r) for r in first]
    finally:
        conn.close()


def _rows(conn: sqlite3.Connection) -> dict[str, list[tuple]]:
    """Every row of every ordinary table, fts5's own shadow tables aside."""
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' "
        "AND name NOT LIKE 'documents_fts%' AND name NOT LIKE '%_vec%' ORDER BY name")]
    return {t: sorted(map(tuple, conn.execute(f'SELECT * FROM "{t}"')), key=repr) for t in tables}


def test_over_a_released_corpus_only_the_named_months_move(tmp_path: Path):
    """The launch a 2.3.0 user's corpus takes: that release's database, plus two rows its
    DOAJ client stored with a month's name, through one ``init_db``."""
    path = tmp_path / "corpus.db"
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(RELEASED_CORPUS.read_text(encoding="utf-8"))
    titles = {"named-1": "Comets over the delta", "named-2": "Tidal owls"}
    for external_id, month in (("named-1", "January"), ("named-2", "Oct")):
        _store_as_before_259(conn, external_id, month, ["Ada Okafor"], title=titles[external_id])
    conn.commit()
    before = _rows(conn)
    conn.close()

    database.init_db(str(path))

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        after = _rows(conn)
        assert set(after) >= set(before)
        changed = {t: (set(before[t]) - set(after[t]), set(after[t]) - set(before[t]))
                   for t in before if before[t] != after[t]}
        # The schema marker is the walk's own rewrite (21 -> 22), not this one.
        assert set(changed) == {"documents", "app_settings"}
        assert {r[0] for r in changed["app_settings"][0]} == {"schema_version"}
        gone, came = changed["documents"]
        # ``SELECT *``'s own columns: ``table_info`` leaves out the generated ``pub_sort``.
        columns = [d[0] for d in conn.execute("SELECT * FROM documents LIMIT 0").description]
        index = {name: columns.index(name) for name in ("external_id", "publication_date", "metadata_hash")}
        assert {r[index["external_id"]] for r in gone} == {r[index["external_id"]] for r in came} == set(titles)
        for old in gone:
            new = next(r for r in came if r[0] == old[0])
            moved = {columns[i] for i, (a, b) in enumerate(zip(old, new)) if a != b}
            # ``pub_sort`` is generated from the date; it moving is the point.
            assert moved == {"publication_date", "metadata_hash", "pub_sort"}
        assert sorted(r[index["publication_date"]] for r in came) == ["2025-01-01", "2025-10-01"]
        # The search index still answers for both: the update trigger
        # re-indexed them with the text they already had.
        found = {r[0] for r in conn.execute(
            "SELECT d.external_id FROM documents_fts f JOIN documents d ON d.id = f.rowid "
            "WHERE documents_fts MATCH 'comets OR owls'")}
        assert found >= set(titles)
    finally:
        conn.close()
