"""A find, end to end in the engine: recorded like a run, its copies stored and linked.

The sources are stand-ins with ``lookup`` methods returning authored records,
so every step after the request is production code: the sweep engine's
concurrency and source records, deduplication into the collection, the
per-source find record, the links between copies, the routes.
"""
from __future__ import annotations

import sqlite3

import pytest

from implementation_scripts import open_access, paper_find
from implementation_scripts import sweep_engine as se
from implementation_scripts.api_base import NormalizedResult, search_outcome
from implementation_scripts.database import init_db
from implementation_scripts.sweep_engine import SweepEngine

DOI = "10.5555/resmon.find.7"
TITLE = "An authored fixture paper found by its DOI"


def _record(source: str, external_id: str, **fields) -> NormalizedResult:
    base = dict(source_repository=source, external_id=external_id, doi=DOI, title=TITLE,
                authors=["Ada Fixture"], abstract=None, publication_date="2026-01-02",
                url=f"https://example.org/{source}/{external_id}")
    return NormalizedResult(**{**base, **fields})


class _Source:
    replies: dict[str, list] = {}
    asked: list[tuple[str, str, str]] = []

    def __init__(self, slug: str):
        self.slug = slug

    def get_name(self) -> str:
        return self.slug

    def lookup(self, kind, value, max_results=5):
        outcome = search_outcome()
        outcome.note_attempt()
        _Source.asked.append((self.slug, kind, value))
        reply = _Source.replies[self.slug]
        if reply == "fail":
            outcome.note_failure(503, "https://example.org")
            return []
        return list(reply)


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "corpus.db"), check_same_thread=False)
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


@pytest.fixture
def engine(conn, monkeypatch, tmp_path):
    _Source.asked = []
    monkeypatch.setattr(se, "get_client", lambda name, **_kw: _Source(name))
    monkeypatch.setattr(se, "required_credential_for_sweep", lambda _slug: None)
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")
    return SweepEngine(db_conn=conn, config={})


def _find(engine, typed: str, sources: list[str]) -> int:
    query = paper_find.parse(typed)
    asked, not_asked = paper_find.plan(query, sources)
    exec_id = engine.prepare_execution("find_paper", asked, {
        "query": query.typed, "find": {**query.as_params(), "not_asked": not_asked},
        "max_results": paper_find.CANDIDATES})
    engine.run_prepared(exec_id)
    return exec_id


def test_a_find_is_a_run_with_each_sources_answer_and_its_copies_linked(conn, engine):
    openalex = _record("openalex", "W7", open_access=[open_access.location(
        "openalex", pdf_url="https://repo.example.edu/7.pdf", license="cc-by", version="publishedVersion")])
    _Source.replies = {
        "crossref": [_record("crossref", DOI)],
        "openalex": [_record("openalex", "W6", doi="10.5555/a.citing.paper", title="Another paper"), openalex],
        "europepmc": [_record("europepmc", "MED:1", doi="10.5555/somebody.else")],
        "semantic_scholar": "fail",
    }
    exec_id = _find(engine, f"https://doi.org/{DOI}",
                    ["crossref", "openalex", "europepmc", "semantic_scholar", "arxiv", "core"])
    run = dict(conn.execute("SELECT * FROM executions WHERE id = ?", (exec_id,)).fetchone())
    assert (run["execution_type"], run["status"]) == ("find_paper", "completed")
    # Asked only by the kind each can be asked by; arXiv and CORE were not asked.
    assert sorted(_Source.asked) == sorted(
        (s, "doi", DOI) for s in ("crossref", "openalex", "europepmc", "semantic_scholar"))
    # Health's record: one row per source asked, with the candidates it returned.
    sources = {r["source"]: dict(r) for r in conn.execute(
        "SELECT * FROM execution_sources WHERE execution_id = ?", (exec_id,))}
    assert set(sources) == {"crossref", "openalex", "europepmc", "semantic_scholar"}
    assert sources["openalex"]["result_count"] == 2
    assert sources["semantic_scholar"]["zero_reason"] == "upstream_failure"
    # Only the copies that are the paper were stored, and linked to the run.
    stored = {(r["source_repository"], r["external_id"]) for r in conn.execute("SELECT * FROM documents")}
    assert stored == {("crossref", DOI), ("openalex", "W7")}
    linked = conn.execute("SELECT count(*) FROM execution_documents WHERE execution_id = ?", (exec_id,)).fetchone()[0]
    assert linked == 2
    assert run["result_count"] == 2 and run["new_result_count"] == 2
    # Both landed in the default collection.
    assert conn.execute("SELECT count(*) FROM collection_documents WHERE collection_id = 1").fetchone()[0] == 2
    # The shared_doi link between the two copies.
    ids = sorted(r[0] for r in conn.execute("SELECT id FROM documents"))
    links = [tuple(r) for r in conn.execute("SELECT document_a, document_b, kind, method FROM document_links")]
    assert links == [(ids[0], ids[1], "same_paper", "shared_doi")]

    result = paper_find.result(conn, exec_id)
    assert result["query"] == {"kind": "doi", "value": DOI, "typed": f"https://doi.org/{DOI}"}
    by_source = {s["source"]: s for s in result["sources"]}
    assert by_source["crossref"]["outcome"] == "found" and by_source["crossref"]["reference"]
    assert by_source["openalex"]["matched_by"] == "doi" and by_source["openalex"]["candidates"] == 2
    assert by_source["openalex"]["open_copy"]["downloadable"] is True
    assert by_source["openalex"]["open_copy"]["license"] == "cc-by"
    assert by_source["europepmc"]["outcome"] == "not_found"
    assert by_source["semantic_scholar"]["outcome"] == "did_not_answer"
    assert by_source["arxiv"]["outcome"] == "not_asked"
    assert "arXiv can be asked by arXiv id and title, not by DOI." == by_source["arxiv"]["why_not_asked"]
    assert by_source["core"]["outcome"] == "not_asked"
    assert result["counts"] == {"found": 2, "not_found": 1, "did_not_answer": 1, "not_asked": 2}
    assert result["reference_document_id"] == by_source["crossref"]["document_id"]


def test_a_title_find_says_what_differs_between_copies(conn, engine):
    long_title = "An authored fixture paper on finding one paper across many scholarly sources at once"
    _Source.replies = {
        "crossref": [_record("crossref", DOI, title=long_title + ".")],
        "arxiv": [_record("arxiv", "2601.00007v1", doi=None, title=long_title + ": a preprint",
                          publication_date="2025-12-30")],
    }
    exec_id = _find(engine, long_title, ["crossref", "arxiv"])
    by_source = {s["source"]: s for s in paper_find.result(conn, exec_id)["sources"]}
    assert by_source["crossref"]["matched_by"] == "exact_title"
    arxiv = by_source["arxiv"]
    assert arxiv["matched_by"] == "close_title" and arxiv["title_similarity"] >= paper_find.CLOSE_TITLE
    assert {d["field"] for d in arxiv["differences"]} == {"title", "year", "doi"}


def test_a_find_every_source_failed_is_a_failed_run(conn, engine):
    _Source.replies = {"crossref": "fail", "openalex": "fail"}
    exec_id = _find(engine, DOI, ["crossref", "openalex"])
    run = dict(conn.execute("SELECT status FROM executions WHERE id = ?", (exec_id,)).fetchone())
    assert run["status"] == "failed"
    assert {s["outcome"] for s in paper_find.result(conn, exec_id)["sources"]} == {"did_not_answer"}


def test_a_later_find_links_a_new_copy_to_one_already_held(conn, engine):
    _Source.replies = {"crossref": [_record("crossref", DOI)]}
    _find(engine, DOI, ["crossref"])
    _Source.replies = {"zenodo": [_record("zenodo", "77")]}
    _find(engine, DOI, ["zenodo"])
    assert conn.execute("SELECT count(*) FROM document_links WHERE kind = 'same_paper'").fetchone()[0] == 1


def test_a_found_papers_account_says_a_find_kept_it_and_checks_no_keywords(conn, engine):
    """What was typed into a find is an identifier, not keywords: its account says so."""
    from implementation_scripts import match_explain

    _Source.replies = {"crossref": [_record("crossref", DOI)]}
    _find(engine, f"https://doi.org/{DOI}", ["crossref"])
    document_id = conn.execute("SELECT id FROM documents").fetchone()[0]
    said = match_explain.explain_document(conn, document_id)
    assert said["verdict"] == "found_by_find" and said["keywords"] == []
    assert "Crossref answered with this record, which carries the DOI asked for" in said["headline"]
    assert match_explain.keyword_contribution(conn)["keywords"] == []


def test_a_find_that_names_its_sources_accounts_for_every_other():
    """Every source in the catalog is accounted for: asked, left out, or unable to look it up."""
    import resmon as resmon_mod

    _query, asked, not_asked = resmon_mod._find_plan(DOI, ["openalex", "crossref"])
    assert asked == ["openalex", "crossref"]   # in the order they were named
    why = {item["source"]: item["why"] for item in not_asked}
    assert why["zenodo"] == "Left out of this find."
    assert why["arxiv"] == "arXiv can be asked by arXiv id and title, not by DOI."
    from implementation_scripts.repo_catalog import REPOSITORY_CATALOG
    assert set(asked) | set(why) == {entry.slug for entry in REPOSITORY_CATALOG}


@pytest.fixture
def http(tmp_path):
    import resmon as resmon_mod
    from fastapi.testclient import TestClient

    resmon_mod._db_path = str(tmp_path / "routes.db")
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    yield TestClient(resmon_mod.app)
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def test_a_find_no_named_source_can_answer_is_refused_with_why(http):
    refused = http.post("/api/find", json={"query": "arXiv:2601.00001", "repositories": ["crossref"]})
    assert refused.status_code == 400
    assert refused.json()["detail"].startswith(
        "No source named can look up an arXiv id. Crossref can be asked by DOI and title, not by arXiv id.")
    assert http.get("/api/executions/1/find").status_code == 404
    unknown = http.post("/api/documents/999/full-text")
    assert unknown.status_code == 404
