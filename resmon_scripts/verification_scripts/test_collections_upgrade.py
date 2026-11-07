"""A database the 1.0 code wrote, upgraded to collections (schema 25 -> 26) in one launch.

``fixtures/collections/schema_25.sql`` was written by the code at docs/one-oh
before collections existed: three watches and their runs, papers found twice,
a Deep Sweep, a reading queue, and a look at Today. One ``init_db`` takes it to
schema 26, and what a person saw before must be what they see after, in the
one collection the upgrade makes: every paper there, every watch pointed at
it, the same Today, the same counts, the same queue.

The "before" side of each comparison is read from the fixture as the 1.0 code
would read it: with no collection named, which is every paper stored.
"""

from __future__ import annotations

import hashlib
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import (  # noqa: E402
    analytics, collection_map, database, explorer, paper_collections as pc, reading_queue, today,
)
from implementation_scripts.database import DEFAULT_COLLECTION_ID  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "collections" / "schema_25.sql"
LOOKED = "2026-10-30 12:00:00"


def _open(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _facts(conn: sqlite3.Connection, collection_id) -> dict:
    """What the screens read, for one collection (``None``: every paper, as 1.0 read them)."""
    routines = [int(r[0]) for r in conn.execute("SELECT id FROM routines ORDER BY id")]
    page = explorer.search(conn, collection_id=collection_id, limit=200)
    return {
        "count": (page["total"], page["total_is_exact"]),
        "ids": [r["id"] for r in page["results"]],
        "words": explorer.search(conn, collection_id=collection_id, query="diffusion")["total"],
        "facets": explorer.facets(conn, collection_id=collection_id),
        "export": [d["id"] for d in explorer.iter_matching(conn, collection_id=collection_id)],
        "watch_papers": {rid: database.get_routine_document_ids(conn, rid, collection_id=collection_id)
                         for rid in routines},
        "queue": [(e["document_id"], e["status"]) for e in
                  reading_queue.list_entries(conn, collection_id=collection_id)["entries"]],
        "queue_counts": reading_queue.counts(conn, collection_id),
        "summary": {k: v for k, v in analytics.corpus_summary(conn, collection_id).items()},
        "sources": analytics.source_contribution(conn, collection_id),
        "volume": analytics.publication_volume(conn, collection_id=collection_id),
    }


def _today_before(conn: sqlite3.Connection) -> list[int]:
    """Today as 1.0 defined it: first collected after the last look, newest first."""
    return [int(r[0]) for r in conn.execute(
        "SELECT id FROM documents WHERE first_seen_at > ? ORDER BY first_seen_at DESC, id DESC", (LOOKED,))]


def _fingerprint(conn: sqlite3.Connection) -> str:
    digest = hashlib.sha256()
    for row in conn.execute("SELECT type, name, sql FROM sqlite_master ORDER BY name"):
        digest.update(repr(tuple(row)).encode())
    for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'documents_fts%' "
                                 "AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        digest.update(repr([tuple(r) for r in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]).encode())
    return digest.hexdigest()


@pytest.fixture(scope="module")
def upgraded(tmp_path_factory):
    path = tmp_path_factory.mktemp("one-oh") / "resmon.db"
    conn = _open(path)
    conn.executescript(FIXTURE.read_text(encoding="utf-8"))
    conn.commit()
    assert database.get_schema_version(conn) == 25
    assert conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'collections'").fetchone() is None
    before = _facts(conn, None)
    before_today = _today_before(conn)
    counts = {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
              for t in ("documents", "routines", "executions", "execution_documents", "reading_queue")}
    seen = dict(conn.execute("SELECT id, first_seen_at FROM documents").fetchall())
    conn.close()

    database.init_db(str(path))               # the first launch of the build with collections

    conn = _open(path)
    yield {"path": path, "conn": conn, "before": before, "today": before_today, "counts": counts, "seen": seen}
    collection_map.forget(conn, every=True)
    conn.close()


def test_the_fixture_is_a_real_one_point_oh_database_with_enough_in_it():
    conn = sqlite3.connect(":memory:")
    try:
        conn.executescript(FIXTURE.read_text(encoding="utf-8"))
        assert database.get_schema_version(conn) == 25
        assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] >= 100
        assert conn.execute("SELECT COUNT(*) FROM routines").fetchone()[0] == 3
        assert conn.execute("SELECT COUNT(*) FROM reading_queue").fetchone()[0] >= 5
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
        assert {"collections", "collection_documents"}.isdisjoint(names)
        assert "collection_id" not in {r[1] for r in conn.execute("PRAGMA table_info(routines)")}
    finally:
        conn.close()


def test_one_launch_takes_it_to_schema_26_with_one_collection(upgraded):
    conn = upgraded["conn"]
    assert database.get_schema_version(conn) == database.SCHEMA_VERSION == 27
    assert [tuple(r) for r in conn.execute("SELECT id, name, revision FROM collections")] == [
        (DEFAULT_COLLECTION_ID, "Your collection", 0)]
    assert pc.current(conn) == DEFAULT_COLLECTION_ID
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_every_paper_is_in_the_default_collection_once_arriving_when_it_was_first_seen(upgraded):
    conn = upgraded["conn"]
    rows = conn.execute(
        "SELECT document_id, collection_id, added_at, added_by, execution_id FROM collection_documents "
        "ORDER BY document_id").fetchall()
    assert [r["document_id"] for r in rows] == sorted(upgraded["seen"])
    assert {(r["collection_id"], r["added_by"], r["execution_id"]) for r in rows} == {
        (DEFAULT_COLLECTION_ID, "upgrade", None)}
    assert {r["document_id"]: r["added_at"] for r in rows} == upgraded["seen"]


def test_every_watch_targets_the_default_collection(upgraded):
    conn = upgraded["conn"]
    assert [r[0] for r in conn.execute("SELECT collection_id FROM routines")] == [DEFAULT_COLLECTION_ID] * 3
    assert pc.summaries(conn)[0]["watches"] == 3


def test_nothing_the_one_point_oh_database_held_is_lost(upgraded):
    conn = upgraded["conn"]
    for table, count in upgraded["counts"].items():
        assert conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] == count, table
    assert dict(conn.execute("SELECT id, first_seen_at FROM documents").fetchall()) == upgraded["seen"]


def test_what_the_screens_read_is_what_they_read_before(upgraded):
    """Search › Your collection, its facets and export, a watch's papers, the queue, and Analytics."""
    after = _facts(upgraded["conn"], DEFAULT_COLLECTION_ID)
    before = upgraded["before"]
    assert after["count"] == before["count"] and after["count"][0] >= 100
    for key in before:
        assert after[key] == before[key], key


def test_today_is_the_same_papers_and_its_look_is_kept(upgraded):
    conn = upgraded["conn"]
    built = today.build(conn, {}, collection_id=DEFAULT_COLLECTION_ID)
    assert built["window"] == "since_last_look"
    assert [p["id"] for p in built["papers"]] == upgraded["today"]
    assert built["total"] == len(upgraded["today"]) and 0 < built["total"] < len(upgraded["seen"])
    assert all(p["arrived_at"] == p["first_seen_at"] for p in built["papers"])
    assert today.looked_at(conn) == LOOKED


def test_the_maps_file_keeps_the_name_it_had(upgraded):
    """1.0 kept the map as ``<db>-map.npz``; it is the default collection's map now."""
    conn = upgraded["conn"]
    assert collection_map.cache_path(conn, DEFAULT_COLLECTION_ID) == Path(f"{upgraded['path']}-map.npz")


def test_a_second_launch_changes_nothing(upgraded):
    before = _fingerprint(upgraded["conn"])
    database.init_db(str(upgraded["path"]))
    database.init_db(str(upgraded["path"]))
    again = _open(upgraded["path"])
    try:
        assert _fingerprint(again) == before
    finally:
        again.close()


def test_the_engine_serves_the_upgraded_database(upgraded):
    import resmon as resmon_mod  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415

    resmon_mod._db_path = str(upgraded["path"])
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    try:
        client = TestClient(resmon_mod.app)
        listed = client.get("/api/collections").json()
        assert [(c["name"], c["papers"], c["watches"]) for c in listed["collections"]] == [
            ("Your collection", len(upgraded["seen"]), 3)]
        assert client.post("/api/explorer/search", json={}).json()["total"] == len(upgraded["seen"])
        assert [p["id"] for p in client.get("/api/today").json()["papers"]] == upgraded["today"]
    finally:
        resmon_mod._shared_conn = None
        resmon_mod._db_initialized = False
