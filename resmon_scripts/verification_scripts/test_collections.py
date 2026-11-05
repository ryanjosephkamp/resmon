"""Several collections inside one database (schema 26).

A paper is stored once and is in one or more collections. These tests hold the
rules ``paper_collections`` states: every paper is in a collection, a move or
a copy never deletes a paper, the default collection is never deleted, and
every read of "the collection" reads the one it is asked for, with an absent
collection meaning the default one, so a client from before collections reads
what it read.

The database is a file wherever a cache is in play, because the Explorer and
the map key their caches on the file.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import (  # noqa: E402
    analytics, collection_map, explorer, map_facets, paper_collections as pc, reading_queue, today,
)
from implementation_scripts import sweep_engine as se  # noqa: E402
from implementation_scripts.admission import admission, routine_claims  # noqa: E402
from implementation_scripts.api_base import BaseAPIClient, NormalizedResult  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    DEFAULT_COLLECTION_ID, get_routine_document_ids, init_db, insert_document, insert_execution,
    insert_routine, link_execution_document,
)
from implementation_scripts.sweep_engine import SweepEngine  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "resmon.db"), check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    init_db(conn=connection)
    yield connection
    collection_map.forget(connection, every=True)
    connection.close()


def _paper(conn, key: str, *, collection_id=None, source="arxiv", title=None, abstract=None,
           categories="cs.LG", authors="Ada Lovelace", pub="2026-01-15", execution_id=None) -> int:
    doc_id = insert_document(conn, {
        "source_repository": source, "external_id": key, "title": title or f"Paper {key}",
        "authors": authors, "abstract": abstract or f"An abstract about {key} and diffusion models.",
        "publication_date": pub, "url": f"https://e.org/{key}", "categories": categories,
        "metadata_hash": f"{source}-{key}",
    }, collection_id=collection_id, execution_id=execution_id)
    assert doc_id is not None
    return int(doc_id)


def _ids_in(conn, collection_id: int) -> set[int]:
    return {int(r[0]) for r in conn.execute(
        "SELECT document_id FROM collection_documents WHERE collection_id = ?", (collection_id,))}


def _homes(conn, doc_id: int) -> dict[int, str]:
    return {int(r[0]): r[1] for r in conn.execute(
        "SELECT collection_id, added_by FROM collection_documents WHERE document_id = ?", (doc_id,))}


def _papers_stored(conn) -> int:
    return int(conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0])


def _routine(conn, name: str, collection_id=None) -> int:
    return insert_routine(conn, {
        "name": name, "schedule_cron": "0 2 * * *",
        "parameters": json.dumps({"repositories": ["arxiv"], "query": name}),
        "collection_id": collection_id,
    })


def _run(conn, papers: list[int], routine_id=None, collection_id=None, when="2026-11-01T02:00:00") -> int:
    params = {"query": "x", "repositories": ["arxiv"]}
    if collection_id is not None:
        params["collection_id"] = collection_id
    exec_id = insert_execution(conn, {"execution_type": "automated_sweep" if routine_id else "deep_dive",
                                      "parameters": json.dumps(params), "start_time": when})
    if routine_id is not None:
        conn.execute("UPDATE executions SET routine_id = ?, status = 'completed' WHERE id = ?",
                     (routine_id, exec_id))
    for doc_id in papers:
        link_execution_document(conn, exec_id, doc_id, is_new=True)
    conn.commit()
    return exec_id


# ---------------------------------------------------------------------------
# The schema and the default collection
# ---------------------------------------------------------------------------


def test_a_fresh_database_has_the_default_collection_and_every_watch_targets_it(conn):
    assert [dict(r) for r in conn.execute("SELECT id, name FROM collections")] == [
        {"id": DEFAULT_COLLECTION_ID, "name": "Your collection"}]
    rid = _routine(conn, "a watch")
    assert conn.execute("SELECT collection_id FROM routines WHERE id = ?", (rid,)).fetchone()[0] == 1
    assert pc.current(conn) == DEFAULT_COLLECTION_ID


def test_a_paper_stored_with_no_collection_is_filed_in_the_default_one(conn):
    """By the database itself: a row written with plain SQL is filed too."""
    conn.execute("INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
                 "VALUES ('arxiv', 'raw', 'Raw', 'h')")
    raw = int(conn.execute("SELECT id FROM documents WHERE external_id = 'raw'").fetchone()[0])
    stored = _paper(conn, "stored")
    assert _homes(conn, raw) == {1: "run"} and _homes(conn, stored) == {1: "run"}
    added, seen = conn.execute(
        "SELECT m.added_at, d.first_seen_at FROM collection_documents m JOIN documents d ON d.id = m.document_id "
        "WHERE d.id = ?", (stored,)).fetchone()
    assert added == seen


def test_a_paper_a_run_stores_for_another_collection_is_only_there(conn):
    physics = pc.create(conn, "Physics")["id"]
    exec_id = insert_execution(conn, {"execution_type": "deep_dive", "parameters": "{}",
                                      "start_time": "2026-11-01T00:00:00"})
    doc = _paper(conn, "p", collection_id=physics, execution_id=exec_id)
    assert _homes(conn, doc) == {physics: "run"}
    assert conn.execute("SELECT execution_id FROM collection_documents WHERE document_id = ?",
                        (doc,)).fetchone()[0] == exec_id
    # A paper stored again is not filed again: storing it was ignored.
    assert insert_document(conn, {"source_repository": "arxiv", "external_id": "p", "title": "P",
                                  "metadata_hash": "arxiv-p"}) is None
    assert _homes(conn, doc) == {physics: "run"}


# ---------------------------------------------------------------------------
# Naming, making, renaming
# ---------------------------------------------------------------------------


def test_a_collection_is_named_by_id_by_name_in_any_case_or_by_nothing(conn):
    physics = pc.create(conn, "Physics")["id"]
    year = pc.create(conn, "2026")["id"]
    assert pc.resolve(conn, None) == pc.resolve(conn, "") == DEFAULT_COLLECTION_ID
    assert pc.resolve(conn, physics) == pc.resolve(conn, str(physics)) == physics
    assert pc.resolve(conn, "physics") == pc.resolve(conn, " PHYSICS ") == physics
    assert pc.resolve(conn, "2026") == year, "a digit name with no such id is a name"
    with pytest.raises(pc.CollectionError) as missing:
        pc.resolve(conn, "Chemistry")
    assert missing.value.status == 404 and "Chemistry" in missing.value.message
    with pytest.raises(pc.CollectionError):
        pc.resolve(conn, 999)


def test_names_are_unique_without_regard_to_case_and_must_say_something(conn):
    pc.create(conn, "Physics")
    for bad, reason in (("physics", "name_taken"), ("   ", "name_empty"), ("x" * 81, "name_too_long")):
        with pytest.raises(pc.CollectionError) as refused:
            pc.create(conn, bad)
        assert refused.value.reason == reason
    assert pc.create(conn, "  Plant   biology ")["name"] == "Plant biology"
    renamed = pc.rename(conn, DEFAULT_COLLECTION_ID, "Machine learning")
    assert renamed["name"] == "Machine learning" and renamed["is_default"]
    with pytest.raises(pc.CollectionError):
        pc.rename(conn, DEFAULT_COLLECTION_ID, "PHYSICS")
    assert pc.rename(conn, DEFAULT_COLLECTION_ID, "machine LEARNING")["name"] == "machine LEARNING"


def test_the_summaries_count_papers_and_watches_and_the_detail_says_what_a_delete_would_do(conn):
    physics = pc.create(conn, "Physics")["id"]
    a, b = _paper(conn, "a"), _paper(conn, "b", collection_id=physics)
    pc.copy(conn, physics, [a])
    _routine(conn, "w1", physics)
    _routine(conn, "w2")
    rows = {s["id"]: s for s in pc.summaries(conn)}
    assert (rows[1]["papers"], rows[1]["watches"]) == (1, 1)
    assert (rows[physics]["papers"], rows[physics]["watches"]) == (2, 1)
    detail = pc.detail(conn, physics)
    assert (detail["only_here"], detail["also_elsewhere"]) == (1, 1)
    assert [w["name"] for w in detail["watch_list"]] == ["w1"]
    assert b in _ids_in(conn, physics)


# ---------------------------------------------------------------------------
# Copy, move, undo
# ---------------------------------------------------------------------------


def test_a_copy_adds_and_every_collection_keeps_its_papers(conn):
    physics = pc.create(conn, "Physics")["id"]
    a, b = _paper(conn, "a"), _paper(conn, "b")
    pc.copy(conn, physics, [b])
    answer = pc.copy(conn, physics, [a, b, a, 999_999])
    assert answer["added"] == [a] and answer["already_there"] == 1 and answer["missing"] == 1
    assert _ids_in(conn, 1) == {a, b} and _ids_in(conn, physics) == {a, b}
    assert _homes(conn, a)[physics] == "copy"
    undone = pc.undo(conn, physics, answer["added"])
    assert undone["taken_out"] == 1 and _ids_in(conn, physics) == {b} and _ids_in(conn, 1) == {a, b}


def test_a_move_takes_papers_out_of_their_collection_and_never_out_of_the_database(conn):
    physics = pc.create(conn, "Physics")["id"]
    a, b, c = _paper(conn, "a"), _paper(conn, "b"), _paper(conn, "c", collection_id=physics)
    pc.copy(conn, physics, [b])
    before = _papers_stored(conn)
    original = {r[0]: tuple(r[1:]) for r in conn.execute(
        "SELECT document_id, added_at, added_by, execution_id FROM collection_documents WHERE collection_id = 1")}
    answer = pc.move(conn, 1, physics, [a, b, c])
    assert answer["added"] == [a], "b was there already, and c was never in the default"
    assert answer["already_there"] == 1 and answer["not_in_source"] == 1
    assert [r["document_id"] for r in answer["removed"]] == [a, b]
    assert _ids_in(conn, 1) == set() and _ids_in(conn, physics) == {a, b, c}
    assert _papers_stored(conn) == before
    # Undo: b stays in Physics, where it was before; a and b go back exactly as they were.
    undone = pc.undo(conn, physics, answer["added"], 1, answer["removed"])
    assert (undone["put_back"], undone["taken_out"], undone["left_in_place"]) == (2, 1, 0)
    assert _ids_in(conn, physics) == {b, c}
    assert {r[0]: tuple(r[1:]) for r in conn.execute(
        "SELECT document_id, added_at, added_by, execution_id FROM collection_documents "
        "WHERE collection_id = 1")} == original


def test_a_move_into_the_collection_it_comes_from_is_refused(conn):
    a = _paper(conn, "a")
    with pytest.raises(pc.CollectionError) as refused:
        pc.move(conn, 1, 1, [a])
    assert refused.value.reason == "same_collection"


def test_an_undo_never_leaves_a_paper_in_no_collection(conn):
    physics = pc.create(conn, "Physics")["id"]
    a = _paper(conn, "a")
    answer = pc.move(conn, 1, physics, [a])
    # Undone without the source's memberships: taking a out of Physics would strand it.
    undone = pc.undo(conn, physics, answer["added"])
    assert undone["left_in_place"] == 1 and _homes(conn, a) == {physics: "move"}


# ---------------------------------------------------------------------------
# Deleting a collection
# ---------------------------------------------------------------------------


def test_deleting_a_collection_keeps_its_papers_and_points_its_watches_at_the_default(conn):
    physics = pc.create(conn, "Physics")["id"]
    only = _paper(conn, "only", collection_id=physics)
    both = _paper(conn, "both")
    pc.copy(conn, physics, [both])
    watch = _routine(conn, "physics watch", physics)
    pc.set_current(conn, physics)
    today.mark_looked(conn, collection_id=physics)
    before = _papers_stored(conn)
    deleted = pc.delete(conn, physics)
    assert (deleted["papers"], deleted["kept_in_default"], deleted["still_elsewhere"],
            deleted["watches_moved"]) == (2, 1, 1, 1)
    assert _papers_stored(conn) == before
    assert _homes(conn, only) == {1: "kept"} and _homes(conn, both) == {1: "run"}
    assert conn.execute("SELECT collection_id FROM routines WHERE id = ?", (watch,)).fetchone()[0] == 1
    assert pc.current(conn) == 1
    assert conn.execute("SELECT 1 FROM app_settings WHERE key = ?",
                        (today.looked_key(physics),)).fetchone() is None
    assert not pc.exists(conn, physics)


def test_the_default_collection_is_never_deleted(conn):
    with pytest.raises(pc.CollectionError) as refused:
        pc.delete(conn, DEFAULT_COLLECTION_ID)
    assert refused.value.reason == "default" and refused.value.status == 409


# ---------------------------------------------------------------------------
# Every read takes a collection
# ---------------------------------------------------------------------------


@pytest.fixture
def two(conn):
    """A default collection of three papers and Physics of two, one paper in both."""
    physics = pc.create(conn, "Physics")["id"]
    a = _paper(conn, "a", categories="cs.LG", authors="Ada Lovelace")
    b = _paper(conn, "b", categories="stat.ML", source="pubmed", authors="Alan Turing")
    shared = _paper(conn, "shared", categories="physics.optics", authors="Emmy Noether")
    p = _paper(conn, "p", collection_id=physics, categories="physics.optics", authors="Emmy Noether")
    pc.copy(conn, physics, [shared])
    return {"physics": physics, "a": a, "b": b, "shared": shared, "p": p}


def test_the_explorer_counts_lists_facets_and_exports_one_collection(conn, two):
    physics = two["physics"]
    mine = explorer.search(conn, collection_id=physics)
    assert {r["id"] for r in mine["results"]} == {two["p"], two["shared"]}
    assert (mine["total"], mine["total_is_exact"]) == (2, True)
    default = explorer.search(conn, collection_id=1, query="diffusion")
    assert default["total"] == 3
    assert explorer.search(conn)["total"] == 4, "no collection is every paper stored"
    facets = explorer.facets(conn, collection_id=physics)
    assert facets["sources"] == [{"value": "arxiv", "count": 2}]
    assert facets["authors"] == [{"value": "Emmy Noether", "count": 2}]
    assert {f["value"] for f in explorer.facets(conn, collection_id=1)["categories"]} == {
        "cs.LG", "stat.ML", "physics.optics"}
    narrowed = explorer.facets(conn, collection_id=1, sources=["pubmed"])
    assert narrowed["categories"] == [{"value": "stat.ML", "count": 1}]
    assert explorer.count_matching(conn, collection_id=physics) == 2
    assert {d["id"] for d in explorer.iter_matching(conn, collection_id=physics)} == {two["p"], two["shared"]}
    assert set(explorer.matching_ids(conn, collection_id=1, sources=["arxiv"])) == {two["a"], two["shared"]}


def test_jump_to_counts_within_the_collection(conn, two):
    pc.copy(conn, two["physics"], [_paper(conn, "old", pub="2020-02-02")])
    page = explorer.search(conn, collection_id=two["physics"], start_date="2021-01")
    assert page["newer_count"] == 2 and page["total"] == 3 and len(page["results"]) == 1


def test_a_later_pages_count_sees_a_move_made_after_the_first(conn, two):
    """The count cache keys on the collection's revision, which a move changes."""
    for n in range(4):
        _paper(conn, f"more-{n}")
    first = explorer.search(conn, collection_id=1, limit=2)
    assert first["total"] == 7
    before = explorer._documents_fingerprint(conn, 1)
    pc.move(conn, 1, two["physics"], [two["a"]])
    assert explorer._documents_fingerprint(conn, 1) != before
    later = explorer.search(conn, collection_id=1, limit=2, cursor=first["next_cursor"])
    assert later["total"] == 6


def test_the_whole_collection_is_counted_from_its_memberships(conn, two, monkeypatch):
    """No paper is walked to count a collection with no other filter."""
    where, params, _ = explorer._build_where(conn, query=None, sources=None, authors=None, categories=None,
                                              date_from=None, date_to=None, collection_id=two["physics"])
    assert explorer._collection_only(where)
    assert explorer.count_where(conn, where, params) == explorer.Count(2, True)


def test_a_small_collections_clause_is_tested_first_and_a_large_ones_last(conn, two):
    """SQLite tests a search's clauses in the order written: the membership clause goes first
    where it turns most papers away, and after the other filters where it does not."""
    for n in range(4):
        _paper(conn, f"more-{n}")

    def where_for(cid):
        return explorer._build_where(conn, query=None, sources=["arxiv"], authors=None, categories=None,
                                     date_from=None, date_to=None, collection_id=cid)

    large, large_params, _ = where_for(1)
    small, small_params, _ = where_for(two["physics"])
    assert large.endswith(pc.member_clause()) and large_params == ["arxiv", 1]
    assert small.startswith(f" WHERE {pc.member_clause()} AND ") and small_params == [two["physics"], "arxiv"]
    assert explorer.search(conn, collection_id=1, sources=["arxiv"])["total"] == 6
    assert explorer.search(conn, collection_id=two["physics"], sources=["arxiv"])["total"] == 2


def test_the_only_collection_holds_every_paper_and_is_read_without_a_clause(conn):
    """While there is one collection every paper is in it, so a read of it costs what a read of
    the whole database does; the second collection made brings the clause back."""
    a = _paper(conn, "a")
    _paper(conn, "b", source="pubmed")

    def where_for(cid):
        return explorer._build_where(conn, query=None, sources=["arxiv", "pubmed"], authors=None,
                                     categories=None, date_from=None, date_to=None, collection_id=cid)[0]

    assert pc.holds_every_paper(conn, 1) and not pc.holds_every_paper(conn, None)
    assert "collection_documents" not in where_for(1)
    assert collection_map._in_collection(conn, 1) == (" WHERE 1", ())
    assert explorer.search(conn, collection_id=1)["total"] == 2
    physics = pc.create(conn, "Physics")["id"]
    assert not pc.holds_every_paper(conn, 1) and not pc.holds_every_paper(conn, physics)
    assert "collection_documents" in where_for(1)
    pc.move(conn, 1, physics, [a])
    assert explorer.search(conn, collection_id=1)["total"] == 1
    assert explorer.search(conn, collection_id=physics)["total"] == 1
    pc.delete(conn, physics)
    assert pc.holds_every_paper(conn, 1)
    assert explorer.search(conn, collection_id=1)["total"] == 2


def test_today_is_one_collections_and_each_has_its_own_last_look(conn):
    physics = pc.create(conn, "Physics")["id"]
    now = datetime.now(timezone.utc)
    old = _paper(conn, "old")
    month_ago = (now - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (month_ago, old))
    conn.execute("UPDATE collection_documents SET added_at = ? WHERE document_id = ?", (month_ago, old))
    conn.commit()
    fresh = _paper(conn, "fresh")
    found = _paper(conn, "found", collection_id=physics)
    watch = _routine(conn, "physics watch", physics)
    exec_id = _run(conn, [found], routine_id=watch, collection_id=physics)
    # A watch for Physics found a paper resmon already had in the default collection.
    pc.file_papers(conn, physics, [old], how="run", execution_id=exec_id)
    link_execution_document(conn, exec_id, old, is_new=False)
    conn.commit()
    # Moved and copied papers are the person's own doing, and not news.
    pc.copy(conn, physics, [fresh])

    default = today.build(conn, {}, collection_id=1)
    assert [p["id"] for p in default["papers"]] == [fresh] and default["total"] == 1
    assert default["watches"] == [], "the Physics watch found nothing new here"
    mine = today.build(conn, {}, collection_id=physics)
    assert {p["id"] for p in mine["papers"]} == {found, old} and mine["total"] == 2
    assert [w["name"] for w in mine["watches"]] == ["physics watch"]
    assert mine["watches"][0]["new_count"] == 2
    arrived = {p["id"]: p for p in mine["papers"]}[old]
    assert arrived["arrived_at"] != arrived["first_seen_at"]

    today.mark_looked(conn, now + timedelta(seconds=5), collection_id=physics)
    assert today.build(conn, {}, collection_id=physics)["total"] == 0
    assert today.build(conn, {}, collection_id=1)["total"] == 1, "a look at Physics is not a look here"
    assert today.build(conn, {})["total"] == 1, "no collection is the default one"


def test_the_map_is_fitted_per_collection_and_kept_in_a_file_per_collection(conn, tmp_path):
    physics = pc.create(conn, "Physics")["id"]
    words = ["graphene", "superconductor", "photon", "laser", "quantum", "lattice"]
    for n in range(24):
        _paper(conn, f"d{n}", title=f"Diffusion models for images {n}",
               abstract="Diffusion models denoise images with neural networks.")
        _paper(conn, f"p{n}", collection_id=physics, title=f"{words[n % 6].title()} measurements {n}",
               abstract=f"We measure {words[n % 6]} and {words[(n + 1) % 6]} in thin films.")
    open_conn = lambda: conn  # noqa: E731
    for cid in (1, physics):
        assert collection_map.snapshot(conn, None, open_conn, collection_id=cid)["state"] == "fitting"
        collection_map.wait(conn, collection_id=cid)
    default = collection_map.snapshot(conn, None, open_conn, collection_id=1)
    mine = collection_map.snapshot(conn, None, open_conn, collection_id=physics)
    assert default["state"] == mine["state"] == "ready"
    assert set(mine["points"]["id"]) == _ids_in(conn, physics)
    assert set(default["points"]["id"]) == _ids_in(conn, 1)
    assert collection_map.cache_path(conn, 1) == tmp_path / "resmon.db-map.npz"
    assert collection_map.cache_path(conn, physics) == tmp_path / f"resmon.db-map-{physics}.npz"
    assert collection_map.cache_path(conn, 1).exists() and collection_map.cache_path(conn, physics).exists()
    labels = " ".join(r["label"] for r in mine["regions"]).lower()
    assert "diffusion" not in labels, "a collection's regions are named by its own words"

    collection_map.forget(conn, physics)
    assert not collection_map.cache_path(conn, physics).exists()
    assert collection_map.cache_path(conn, 1).exists()
    collection_map.snapshot(conn, None, open_conn, collection_id=physics)
    collection_map.wait(conn, collection_id=physics)
    collection_map.forget(conn, every=True)
    assert sorted(p.name for p in tmp_path.glob("resmon.db-map*")) == []


def test_the_map_facets_and_find_read_one_collection(conn, two):
    facets = map_facets.facets(conn, collection_id=two["physics"])
    assert facets["ids"] == sorted([two["shared"], two["p"]])
    assert map_facets.find(conn, "Paper", collection_id=two["physics"]) == [two["p"], two["shared"]]
    assert set(map_facets.find(conn, "Paper")) == {two["a"], two["b"], two["shared"]}


def test_analytics_reads_one_collection_and_its_watches(conn, two):
    physics = two["physics"]
    _routine(conn, "physics watch", physics)
    _routine(conn, "ml watch")
    summary = analytics.corpus_summary(conn, physics)
    assert summary["documents"] == 2 and summary["sources"] == 1
    assert analytics.corpus_summary(conn)["documents"] == 4
    assert [s["source"] for s in analytics.source_contribution(conn, physics)["sources"]] == ["arxiv"]
    assert [r["name"] for r in analytics.routine_health(conn, physics)["routines"]] == ["physics watch"]
    assert analytics.publication_volume(conn, collection_id=physics)["sample_size"] == 2


def test_a_watchs_papers_people_and_the_reading_queue_read_one_collection(conn, two):
    physics = two["physics"]
    watch = _routine(conn, "w")
    _run(conn, [two["a"], two["shared"], two["p"]], routine_id=watch)
    ids, total = get_routine_document_ids(conn, watch, collection_id=physics)
    assert set(ids) == {two["shared"], two["p"]} and total == 2
    assert get_routine_document_ids(conn, watch)[1] == 3
    for doc in (two["a"], two["p"]):
        reading_queue.save(conn, doc)
    page = reading_queue.list_entries(conn, collection_id=physics)
    assert [e["document_id"] for e in page["entries"]] == [two["p"]]
    assert page["counts"]["all"] == 1 and page["total"] == 1
    assert reading_queue.list_entries(conn)["total"] == 2


# ---------------------------------------------------------------------------
# A run's papers land in its collection
# ---------------------------------------------------------------------------


class _Fixed(BaseAPIClient):
    """A source that returns the papers it was made with, whatever it is asked."""

    def __init__(self, keys):
        super().__init__()
        self.keys = keys

    def get_name(self) -> str:
        return "fixture"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        return [NormalizedResult(source_repository="fixture", external_id=k, title=f"About {k}",
                                 abstract=f"This abstract concerns {k}.", authors="A. Author",
                                 publication_date="2026-01-02", url=f"https://example.invalid/{k}",
                                 doi=None, categories="cs.AI") for k in self.keys]


def _sweep(conn, monkeypatch, tmp_path, keys, collection_id=None) -> int:
    monkeypatch.setattr(se, "get_client", lambda _name: _Fixed(keys))
    monkeypatch.setattr(se, "required_credential_for_sweep", lambda _slug: None)
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")
    params = {"query": "x"} if collection_id is None else {"query": "x", "collection_id": collection_id}
    return SweepEngine(db_conn=conn, config={}).execute_sweep(["fixture"], params)["execution_id"]


def test_a_runs_papers_land_in_its_collection_and_a_paper_it_finds_again_joins_it(conn, monkeypatch, tmp_path):
    physics = pc.create(conn, "Physics")["id"]
    first = _sweep(conn, monkeypatch, tmp_path, ["one", "two"])
    second = _sweep(conn, monkeypatch, tmp_path, ["two", "three"], collection_id=physics)
    ids = {r["external_id"]: int(r["id"]) for r in conn.execute("SELECT id, external_id FROM documents")}
    assert _ids_in(conn, 1) == {ids["one"], ids["two"]}
    assert _ids_in(conn, physics) == {ids["two"], ids["three"]}
    runs = {r[0]: r[1] for r in conn.execute(
        "SELECT document_id, execution_id FROM collection_documents WHERE collection_id = ?", (physics,))}
    assert runs == {ids["two"]: second, ids["three"]: second}
    assert conn.execute("SELECT execution_id FROM collection_documents WHERE collection_id = 1 "
                        "AND document_id = ?", (ids["one"],)).fetchone()[0] == first
    assert _papers_stored(conn) == 3


def test_a_run_whose_collection_was_deleted_lands_in_the_default(conn, monkeypatch, tmp_path):
    _sweep(conn, monkeypatch, tmp_path, ["orphan"], collection_id=4242)
    doc = int(conn.execute("SELECT id FROM documents").fetchone()[0])
    assert _homes(conn, doc) == {1: "run"}


# ---------------------------------------------------------------------------
# Through the routes
# ---------------------------------------------------------------------------


@pytest.fixture
def http(tmp_path):
    import resmon as resmon_mod  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415

    resmon_mod._db_path = str(tmp_path / "routes.db")
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    yield resmon_mod, TestClient(resmon_mod.app)
    collection_map.forget(resmon_mod._get_db(), every=True)
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def test_collections_are_made_listed_renamed_switched_and_deleted_through_the_routes(http):
    resmon_mod, client = http
    listed = client.get("/api/collections").json()
    assert listed["current_id"] == listed["default_id"] == 1
    assert [c["name"] for c in listed["collections"]] == ["Your collection"]

    made = client.post("/api/collections", json={"name": "Physics"})
    assert made.status_code == 201 and made.json()["papers"] == 0
    physics = made.json()["id"]
    taken = client.post("/api/collections", json={"name": "physics"})
    assert taken.status_code == 409 and "already a collection" in taken.json()["detail"]
    assert client.put(f"/api/collections/{physics}", json={"name": "Optics"}).json()["name"] == "Optics"

    assert client.put("/api/collections/current", json={"collection": "optics"}).json() == {"current_id": physics}
    assert client.get("/api/collections").json()["current_id"] == physics
    assert client.put("/api/collections/current", json={"collection": "Nowhere"}).status_code == 404

    detail = client.get(f"/api/collections/{physics}").json()
    assert (detail["only_here"], detail["also_elsewhere"], detail["watch_list"]) == (0, 0, [])
    gone = client.delete(f"/api/collections/{physics}")
    assert gone.status_code == 200 and gone.json()["kept_in_default"] == 0
    assert client.get("/api/collections").json()["current_id"] == 1
    assert client.delete("/api/collections/1").status_code == 409
    assert client.get(f"/api/collections/{physics}").status_code == 404


def test_papers_are_moved_copied_and_put_back_by_id_and_by_search(http):
    resmon_mod, client = http
    conn = resmon_mod._get_db()
    physics = client.post("/api/collections", json={"name": "Physics"}).json()["id"]
    a = _paper(conn, "a", source="arxiv")
    b = _paper(conn, "b", source="pubmed")
    c = _paper(conn, "c", source="pubmed")

    copied = client.post(f"/api/collections/{physics}/papers", json={"mode": "copy", "document_ids": [a]})
    assert copied.status_code == 200, copied.text
    assert copied.json()["added"] == [a] and copied.json()["from_collection_id"] is None

    moved = client.post(f"/api/collections/{physics}/papers", json={
        "mode": "move", "matching": {"sources": ["pubmed"], "collection": 1}}).json()
    assert sorted(moved["added"]) == sorted([b, c]) and moved["from_collection_id"] == 1
    page = client.post("/api/explorer/search", json={"collection": physics}).json()
    assert page["total"] == 3
    assert client.post("/api/explorer/search", json={}).json()["total"] == 1, "absent is the default"

    undone = client.post(f"/api/collections/{physics}/papers/undo", json={
        "added": moved["added"], "from_collection": moved["from_collection_id"], "removed": moved["removed"]})
    assert undone.json()["put_back"] == 2 and undone.json()["taken_out"] == 2
    assert client.post("/api/explorer/search", json={"collection": 1}).json()["total"] == 3
    paper = client.get(f"/api/documents/{a}").json()
    assert [(c["name"], c["added_by"]) for c in paper["collections"]] == [("Your collection", "run"),
                                                                          ("Physics", "copy")]
    both = client.post(f"/api/collections/{physics}/papers", json={
        "mode": "copy", "document_ids": [a], "matching": {}})
    assert both.status_code == 400


def test_every_read_takes_a_collection_and_an_absent_one_is_the_default(http):
    resmon_mod, client = http
    conn = resmon_mod._get_db()
    physics = client.post("/api/collections", json={"name": "Physics"}).json()["id"]
    _paper(conn, "z", source="pubmed")
    a = _paper(conn, "a")
    p = _paper(conn, "p", collection_id=physics)
    for path in ("/api/today", "/api/map/facets", "/api/analytics/overview"):
        mine, absent, by_name = (client.get(path, params={"collection": str(physics)}).json(),
                                 client.get(path).json(), client.get(path, params={"collection": "Physics"}).json())
        assert mine == by_name, path
        assert mine != absent, path
    assert client.get("/api/today", params={"collection": "Physics"}).json()["papers"][0]["id"] == p
    assert client.get("/api/today").json()["papers"][0]["id"] == a
    assert client.get("/api/map/find", params={"q": "Paper", "collection": physics}).json()["ids"] == [p]
    assert client.get("/api/analytics/summary", params={"collection": physics}).json()["documents"] == 1
    assert client.get("/api/today", params={"collection": "Nowhere"}).status_code == 404
    looked = client.post("/api/today/looked", params={"collection": physics})
    assert looked.status_code == 200
    assert client.get("/api/today", params={"collection": physics}).json()["window"] == "since_last_look"
    assert client.get("/api/today").json()["window"] == "first_look"


def test_a_watch_chooses_its_collection_and_a_search_lands_in_the_one_it_names(http, monkeypatch):
    resmon_mod, client = http
    physics = client.post("/api/collections", json={"name": "Physics"}).json()["id"]
    made = client.post("/api/routines", json={
        "name": "optics", "schedule_cron": "0 2 * * *", "is_active": False, "collection": "Physics",
        "parameters": {"repositories": ["arxiv"], "query": "optics", "keywords": ["optics"]}})
    assert made.status_code == 201, made.text
    rid = made.json()["id"]
    assert client.get(f"/api/routines/{rid}").json()["collection_id"] == physics
    assert client.get("/api/routines").json()[0]["collection_id"] == physics
    moved = client.put(f"/api/routines/{rid}", json={"collection": 1})
    assert moved.json()["collection_id"] == 1
    client.put(f"/api/routines/{rid}", json={"collection": physics})
    assert client.put(f"/api/routines/{rid}", json={"collection": "Nowhere"}).status_code == 404

    launched: list[dict] = []

    def record(engine, exec_id, conn, claimed_routine_id=None, reservation=None, **_):
        launched.append(json.loads(resmon_mod._get_db().execute(
            "SELECT parameters FROM executions WHERE id = ?", (exec_id,)).fetchone()[0]))
        # What the real launcher gives back when its run ends: the routine's
        # claim and the run's slot, or the next test's fire of routine 1 is
        # refused as a duplicate.
        if claimed_routine_id is not None:
            routine_claims.release(claimed_routine_id)
        admission.note_finished(exec_id)
        if reservation is not None:
            admission.note_finished(reservation)

    monkeypatch.setattr(resmon_mod, "_launch_execution", record)
    fired = client.post(f"/api/routines/{rid}/run")
    assert fired.status_code in (200, 202), fired.text
    dive = client.post("/api/search/dive", json={"repository": "arxiv", "query": "q", "collection": physics})
    assert dive.status_code in (200, 202), dive.text
    sweep = client.post("/api/search/sweep", json={"repositories": ["arxiv"], "query": "q"})
    assert sweep.status_code in (200, 202), sweep.text
    assert [run["collection_id"] for run in launched] == [physics, physics, 1]


def test_erasing_the_papers_keeps_the_collections_and_a_factory_reset_leaves_the_default_alone(http):
    resmon_mod, client = http
    conn = resmon_mod._get_db()
    physics = client.post("/api/collections", json={"name": "Physics"}).json()["id"]
    client.put("/api/collections/1", json={"name": "Machine learning"})
    _paper(conn, "a")
    _paper(conn, "p", collection_id=physics)
    assert client.post("/api/admin/erase-corpus", json={"confirm": "CONFIRM"}).status_code == 200
    rows = client.get("/api/collections").json()["collections"]
    assert [(c["name"], c["papers"]) for c in rows] == [("Machine learning", 0), ("Physics", 0)]
    reset = client.post("/api/admin/factory-reset", json={"confirm": "CONFIRM"})
    assert reset.status_code == 200 and reset.json()["collections_removed"] == 1
    listed = client.get("/api/collections").json()
    assert [(c["id"], c["name"]) for c in listed["collections"]] == [(1, "Your collection")]
    assert listed["current_id"] == 1
