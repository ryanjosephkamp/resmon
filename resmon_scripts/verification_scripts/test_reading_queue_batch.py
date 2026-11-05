"""Saving many papers to the reading queue at once, and its Undo.

What a save of many promises: a paper already in the queue stays exactly as it
was and is counted as such; the entries it adds share one moment, which is what
its Undo names; an Undo takes back only what is still as the save left it; a
search's matches, a run's papers, and Today's new papers are read by the engine
rather than listed; and a set larger than the limit, or larger than the number
the person was asked about, saves nothing.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient  # noqa: E402

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database as db, reading_queue as rq, today  # noqa: E402


def _paper(conn, n: int, title: str, source: str = "arxiv", seen: str | None = None) -> int:
    doc = db.insert_document(conn, {
        "source_repository": source, "external_id": f"batch-{n}", "title": title,
        "authors": json.dumps(["Ada Fixture"]), "abstract": f"An authored abstract about {title.lower()}.",
        "publication_date": f"2026-{(n % 9) + 1:02d}-01", "metadata_hash": f"batch-{n}",
    })
    if seen:
        conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (seen, doc))
        # Today reads a paper's arrival in its collection, which is the same moment.
        conn.execute("UPDATE collection_documents SET added_at = ? WHERE document_id = ?", (seen, doc))
    return doc


@pytest.fixture
def conn(tmp_path):
    c = db.get_connection(tmp_path / "batch.db")
    db.init_db(conn=c)
    yield c
    c.close()


def test_a_save_of_many_adds_the_new_and_leaves_the_saved_as_they_were(conn):
    ids = [_paper(conn, n, f"Paper {n}") for n in range(5)]
    conn.commit()
    rq.save(conn, ids[0])
    rq.save(conn, ids[1])
    rq.set_status(conn, ids[1], "read")
    before = {i: rq.get_entry(conn, i) for i in ids[:2]}

    out = rq.save_many(conn, ids + [ids[2], 999_999])
    assert out["asked"] == 6, "the same id named twice is one paper"
    assert (out["saved"], out["already"], out["missing"]) == (3, 2, 1)
    assert sorted(out["saved_ids"]) == sorted(ids[2:])
    assert out["counts"] == {"to_read": 4, "read": 1, "all": 5}
    for i in ids[:2]:
        assert rq.get_entry(conn, i) == before[i], "a paper already saved keeps its state and dates"
    stamps = {rq.get_entry(conn, i)["saved_at"] for i in ids[2:]}
    assert stamps == {out["saved_at"]}, "every entry one save adds carries that save's moment"

    again = rq.save_many(conn, ids)
    assert (again["saved"], again["already"], again["missing"]) == (0, 5, 0)
    assert again["saved_at"] is None and again["saved_ids"] == []


def test_undo_takes_back_only_what_is_still_as_the_save_left_it(conn):
    ids = [_paper(conn, n, f"Paper {n}") for n in range(4)]
    conn.commit()
    rq.save(conn, ids[0])
    conn.execute("UPDATE reading_queue SET saved_at='2026-01-01 00:00:00', updated_at='2026-01-01 00:00:00'")
    conn.commit()
    out = rq.save_many(conn, ids)
    assert sorted(out["saved_ids"]) == sorted(ids[1:])
    rq.set_status(conn, ids[1], "read")  # changed since: the Undo leaves it

    undone = rq.unsave_many(conn, out["saved_ids"] + [ids[0]], out["saved_at"])
    assert undone["removed"] == 2
    assert undone["kept"] == 2, "the one marked read since, and the one saved before, stay"
    assert rq.get_entry(conn, ids[0])["saved_at"] == "2026-01-01 00:00:00"
    assert rq.get_entry(conn, ids[1])["status"] == "read"
    assert rq.get_entry(conn, ids[2]) is None and rq.get_entry(conn, ids[3]) is None
    assert rq.unsave_many(conn, out["saved_ids"], out["saved_at"])["removed"] == 0, "an Undo twice removes nothing more"
    with pytest.raises(ValueError):
        rq.unsave_many(conn, ids, "")


def test_the_limit_refuses_before_writing(conn, monkeypatch):
    ids = [_paper(conn, n, f"Paper {n}") for n in range(4)]
    conn.commit()
    monkeypatch.setattr(rq, "BATCH_MOST", 3)
    with pytest.raises(rq.TooMany):
        rq.save_many(conn, ids)
    assert rq.counts(conn)["all"] == 0
    with pytest.raises(rq.TooMany):
        rq.unsave_many(conn, ids, "2026-01-01 00:00:00")


def test_the_largest_save_is_one_quick_transaction(conn):
    """The limit is what one save and its Undo can carry; measured here at the limit itself."""
    conn.executemany(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash) VALUES ('arxiv', ?, ?, ?)",
        [(f"big-{n}", f"Big {n}", f"big-{n}") for n in range(rq.BATCH_MOST)])
    conn.commit()
    ids = [r[0] for r in conn.execute("SELECT id FROM documents")]
    started = time.monotonic()
    out = rq.save_many(conn, ids)
    took = time.monotonic() - started
    assert out["saved"] == rq.BATCH_MOST
    assert len(json.dumps(out["saved_ids"])) < 160_000
    assert took < 5, f"saving {rq.BATCH_MOST:,} took {took:.2f} s"
    started = time.monotonic()
    assert rq.unsave_many(conn, out["saved_ids"], out["saved_at"])["removed"] == rq.BATCH_MOST
    assert time.monotonic() - started < 5


# ---------------------------------------------------------------------------
# Over HTTP
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    return TestClient(resmon_mod.app)


@pytest.fixture
def seeded(client):
    conn = resmon_mod._get_db()
    sqlite_now = lambda delta: (datetime.now(timezone.utc) - delta).strftime("%Y-%m-%d %H:%M:%S")
    old = sqlite_now(timedelta(days=30))
    graphs = [_paper(conn, n, f"Graph networks study {n}", "arxiv", seen=old) for n in range(6)]
    fluids = [_paper(conn, 10 + n, f"Turbulent fluids study {n}", "crossref", seen=sqlite_now(timedelta(hours=1)))
              for n in range(3)]
    run = db.insert_execution(conn, {"execution_type": "deep_dive", "parameters": "{}", "start_time": "2026-11-01T09:00:00"})
    for doc in graphs:
        db.link_execution_document(conn, run, doc)
    conn.execute("UPDATE execution_documents SET is_new = 0 WHERE execution_id = ? AND document_id IN (?, ?)",
                 (run, graphs[0], graphs[1]))
    db.set_setting(conn, today.LOOKED_KEY, sqlite_now(timedelta(days=1)))
    conn.commit()
    return {"graphs": graphs, "fluids": fluids, "run": run}


def test_the_listed_route_saves_and_counts(client, seeded):
    graphs = seeded["graphs"]
    assert client.post("/api/reading-queue", json={"document_id": graphs[0]}).status_code == 201
    saved = client.post("/api/reading-queue/batch", json={"document_ids": graphs[:4] + [999_999]})
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert (body["asked"], body["saved"], body["already"], body["missing"]) == (5, 3, 1, 1)
    assert list(body) == ["asked", "saved", "already", "missing", "saved_at", "saved_ids", "counts"]
    assert client.post("/api/reading-queue/batch", json={"document_ids": []}).status_code == 422
    too_many = client.post("/api/reading-queue/batch", json={"document_ids": list(range(1, rq.BATCH_MOST + 2))})
    assert too_many.status_code == 422, "the listed route is bounded by its body"

    undone = client.post("/api/reading-queue/batch/undo", json={"document_ids": body["saved_ids"], "saved_at": body["saved_at"]})
    assert undone.status_code == 200 and undone.json()["removed"] == 3
    assert undone.json()["counts"]["all"] == 1, "the paper saved before the batch stays"


def test_a_searchs_every_match_is_saved_without_listing_them(client, seeded):
    graphs, fluids = seeded["graphs"], seeded["fluids"]
    client.post("/api/reading-queue", json={"document_id": graphs[0]})
    body = {"scope": "search", "search": {"query": "graph"}, "at_most": 6}
    out = client.post("/api/reading-queue/batch/all", json=body)
    assert out.status_code == 200, out.text
    assert (out.json()["asked"], out.json()["saved"], out.json()["already"]) == (6, 5, 1)
    saved = {e["document_id"] for e in client.get("/api/reading-queue?limit=200").json()["entries"]}
    assert saved == set(graphs), "every match, and nothing the search does not match"

    by_source = client.post("/api/reading-queue/batch/all", json={
        "scope": "search", "search": {"sources": ["crossref"]}, "except_ids": [fluids[0]], "at_most": 2})
    assert by_source.json()["saved"] == 2 and fluids[0] not in by_source.json()["saved_ids"]


def test_more_than_the_person_was_asked_about_saves_nothing(client, seeded):
    refused = client.post("/api/reading-queue/batch/all", json={"scope": "search", "search": {}, "at_most": 3})
    assert refused.status_code == 409
    assert "9 papers now, more than the 3 you were asked about" in refused.json()["detail"]
    assert client.get("/api/reading-queue?limit=1").json()["counts"]["all"] == 0
    assert client.post("/api/reading-queue/batch/all", json={"scope": "search", "at_most": 3}).status_code == 400


def test_a_set_past_the_limit_is_refused_with_its_size(client, seeded, monkeypatch):
    monkeypatch.setattr(rq, "BATCH_MOST", 4)
    refused = client.post("/api/reading-queue/batch/all", json={"scope": "search", "search": {}, "at_most": 100})
    assert refused.status_code == 400
    assert "at most 4 papers at once" in refused.json()["detail"] and "Nothing was saved" in refused.json()["detail"]
    assert client.get("/api/reading-queue?limit=1").json()["counts"]["all"] == 0
    # Left out, the rest fit.
    fits = client.post("/api/reading-queue/batch/all", json={
        "scope": "search", "search": {"sources": ["arxiv"]}, "except_ids": seeded["graphs"][:2], "at_most": 4})
    assert fits.status_code == 200 and fits.json()["saved"] == 4


def test_a_runs_papers_and_its_new_ones(client, seeded):
    run, graphs = seeded["run"], seeded["graphs"]
    new = client.post("/api/reading-queue/batch/all", json={"scope": "run", "execution_id": run, "only_new": True, "at_most": 4})
    assert new.status_code == 200 and sorted(new.json()["saved_ids"]) == sorted(graphs[2:])
    every = client.post("/api/reading-queue/batch/all", json={"scope": "run", "execution_id": run, "at_most": 6})
    assert (every.json()["saved"], every.json()["already"]) == (2, 4)
    assert client.post("/api/reading-queue/batch/all", json={"scope": "run", "execution_id": 9_999, "at_most": 1}).status_code == 404
    assert client.post("/api/reading-queue/batch/all", json={"scope": "run", "at_most": 1}).status_code == 400


def test_todays_new_papers(client, seeded):
    out = client.post("/api/reading-queue/batch/all", json={"scope": "today", "at_most": 3})
    assert out.status_code == 200 and sorted(out.json()["saved_ids"]) == sorted(seeded["fluids"])
    assert client.get("/api/today").json()["total"] == 3, "the count Today shows is the set this saves"


def test_the_body_is_checked(client, seeded):
    assert client.post("/api/reading-queue/batch/all", json={"scope": "everything", "at_most": 1}).status_code == 422
    assert client.post("/api/reading-queue/batch/all", json={"scope": "today", "at_most": 0}).status_code == 422
    assert client.post("/api/reading-queue/batch/all", json={"scope": "today"}).status_code == 422
    assert client.post("/api/reading-queue/batch/undo", json={"document_ids": [1], "saved_at": ""}).status_code == 422
