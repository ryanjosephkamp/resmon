"""What the map's filters, colors and find read, and the views it remembers.

The claims, each tested against rows written here:

- **Every paper has one entry in every column**, in id order, and each value
  is what the database holds: the source's slug, the first day the stored
  publication date names (or nothing where it names none), and when resmon
  first collected it.
- **The reading queue and Today's "new" are the queue's and Today's own**:
  saved and read by status, new by the same window Today counts from.
- **A watch's members are every paper its runs returned**, inactive watches
  included, since a filter can name one.
- **Find matches a title or the authors, literally**, newest first, and a
  query too short to mean anything finds nothing.
- **A view is stored per map and read back as stored**, and a stored value
  the interface could not read falls back to the default, field by field.
- **A run's paper ids are the papers it stored that are still here.**
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient      # noqa: E402

import resmon as resmon_mod                     # noqa: E402
from implementation_scripts import map_facets   # noqa: E402
from implementation_scripts.database import (   # noqa: E402
    insert_document, insert_execution, insert_routine, link_execution_document, set_setting,
)


@pytest.fixture
def client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    return TestClient(resmon_mod.app)


def _sqlite(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _paper(conn, key: str, *, source: str = "arxiv", title: str | None = None, authors: str = "Ada Lovelace",
           published: str | None = "2019-03-04", seen: datetime | None = None) -> int:
    doc_id = insert_document(conn, {
        "source_repository": source, "external_id": key, "title": title or f"Paper {key}",
        "authors": authors, "abstract": "A short abstract.", "publication_date": published,
        "metadata_hash": key,
    })
    if seen is not None:
        conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (_sqlite(seen), doc_id))
    conn.commit()
    return int(doc_id)


def test_published_day_counts_from_the_first_day_the_date_names():
    assert map_facets.published_day("1970-01-02") == 1
    assert map_facets.published_day("2019-03") == map_facets.published_day("2019-03-01")
    assert map_facets.published_day("2019") == map_facets.published_day("2019-01-01")
    assert map_facets.published_day("2019-02-30") is None
    assert map_facets.published_day("Spring 2019") is None
    assert map_facets.published_day(None) is None


def test_every_column_has_one_entry_per_paper_and_says_what_is_stored(client):
    now = datetime.now(timezone.utc)
    conn = resmon_mod._get_db()
    try:
        old = _paper(conn, "old", source="crossref", published="2018", seen=now - timedelta(days=40))
        fresh = _paper(conn, "fresh", published=None, seen=now - timedelta(hours=3))
        read = _paper(conn, "read", source="crossref", published="2020-06-15", seen=now - timedelta(days=2))
        set_setting(conn, "today_looked_at", _sqlite(now - timedelta(days=1)))
        conn.execute("INSERT INTO reading_queue (document_id) VALUES (?)", (fresh,))
        conn.execute("INSERT INTO reading_queue (document_id, status, read_at) VALUES (?, 'read', datetime('now'))",
                     (read,))
        active = insert_routine(conn, {"name": "Active watch", "schedule_cron": "0 2 * * *",
                                       "parameters": "{}", "is_active": 1})
        quiet = insert_routine(conn, {"name": "Paused watch", "schedule_cron": "0 2 * * *",
                                      "parameters": "{}", "is_active": 0})
        for routine, docs in ((active, (old, fresh)), (quiet, (old,))):
            run = insert_execution(conn, {"execution_type": "automated_sweep", "routine_id": routine,
                                          "parameters": "{}", "start_time": "2026-10-01 00:00:00"})
            for doc in docs:
                link_execution_document(conn, run, doc)
        conn.commit()
    finally:
        resmon_mod._close_db(conn)

    body = client.get("/api/map/facets").json()
    assert body["ids"] == [old, fresh, read]
    assert [body["sources"][i] for i in body["source"]] == ["crossref", "arxiv", "crossref"]
    assert body["published_day"] == [map_facets.published_day("2018-01-01"), None,
                                     map_facets.published_day("2020-06-15")]
    assert all(isinstance(at, int) for at in body["found_at"])
    assert body["found_at"][0] < body["found_at"][2] < body["found_at"][1]
    assert body["saved"] == [fresh] and body["read"] == [read]
    # After the look yesterday: only the paper collected three hours ago is new.
    assert body["window"] == "since_last_look" and body["new"] == [fresh]
    members = {w["name"]: (w["is_active"], w["members"]) for w in body["watches"]}
    assert members == {"Active watch": (True, sorted([old, fresh])), "Paused watch": (False, [old])}


def test_with_no_look_recorded_new_is_the_first_looks_seven_days(client):
    now = datetime.now(timezone.utc)
    conn = resmon_mod._get_db()
    try:
        _paper(conn, "month", seen=now - timedelta(days=30))
        week = _paper(conn, "week", seen=now - timedelta(days=6))
    finally:
        resmon_mod._close_db(conn)
    body = client.get("/api/map/facets").json()
    assert body["window"] == "first_look" and body["new"] == [week]


def test_find_matches_titles_and_authors_literally_newest_first(client):
    now = datetime.now(timezone.utc)
    conn = resmon_mod._get_db()
    try:
        older = _paper(conn, "a", title="Protein folding at scale", seen=now - timedelta(days=3))
        newer = _paper(conn, "b", title="Traffic flow", authors="Grace Protein-Hopper", seen=now - timedelta(days=1))
        _paper(conn, "c", title="Quantum 100% fidelity", seen=now - timedelta(days=2))
        _paper(conn, "d", title="Quantum 1000 fidelity", seen=now - timedelta(days=2))
    finally:
        resmon_mod._close_db(conn)
    assert client.get("/api/map/find", params={"q": "PROTEIN"}).json() == {"query": "PROTEIN", "ids": [newer, older]}
    # A percent sign is a character to find, not a wildcard.
    assert len(client.get("/api/map/find", params={"q": "100%"}).json()["ids"]) == 1
    assert client.get("/api/map/find", params={"q": " p "}).json()["ids"] == []


def test_a_view_is_kept_per_map_and_an_unreadable_one_reads_as_the_default(client):
    assert client.get("/api/map/views/today").json() == map_facets.DEFAULT_VIEW
    view = {"color": "watch", "watches": [3, 1], "sources": ["arxiv"], "dates": "published",
            "date_from": "2024-01-01", "date_to": "2024-12-31", "state": "new"}
    stored = client.put("/api/map/views/today", json=view).json()
    assert stored == {**view, "watches": [1, 3]}
    assert client.get("/api/map/views/today").json() == stored
    assert client.get("/api/map/views/run").json() == map_facets.DEFAULT_VIEW
    assert client.get("/api/map/views/elsewhere").status_code == 404
    assert client.put("/api/map/views/run", json={**view, "date_from": "January"}).status_code == 422

    conn = resmon_mod._get_db()
    try:
        set_setting(conn, "map_view_run", json.dumps({"color": "plaid", "state": "read", "date_to": "2024-02-30",
                                                       "watches": ["x", 2, True], "sources": "arxiv"}))
    finally:
        resmon_mod._close_db(conn)
    assert client.get("/api/map/views/run").json() == {**map_facets.DEFAULT_VIEW, "state": "read", "watches": [2]}


def test_a_runs_ids_are_the_papers_it_stored_that_are_still_here(client):
    conn = resmon_mod._get_db()
    try:
        kept = _paper(conn, "kept")
        gone = _paper(conn, "gone")
        run = insert_execution(conn, {"execution_type": "deep_dive", "parameters": "{}",
                                      "start_time": "2026-10-01 00:00:00"})
        for doc in (gone, kept):
            link_execution_document(conn, run, doc)
        conn.execute("DELETE FROM execution_documents WHERE document_id = ?", (gone,))
        conn.execute("DELETE FROM documents WHERE id = ?", (gone,))
        conn.commit()
    finally:
        resmon_mod._close_db(conn)
    assert client.get(f"/api/executions/{run}/document-ids").json() == {"ids": [kept]}
    assert client.get("/api/executions/987654/document-ids").status_code == 404
