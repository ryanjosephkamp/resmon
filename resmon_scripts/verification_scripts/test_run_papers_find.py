"""Finding in a run's papers: ``q`` on ``GET /api/executions/{id}/documents``.

The run's Papers tab has the Library's find. Both go through
``database.paper_find_clause``, so a find means the same thing in each: the
words, ignoring case, in a paper's title, its authors, or its source. The page
says how many match and how many the find looked through, which is the
"12 of 275 papers match" the tab says.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import pytest  # noqa: E402

import resmon as resmon_mod  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    insert_execution, link_execution_document, paper_find_clause, update_execution_status,
)

PAPERS = (
    ("arxiv", "Gaussian Splatting for Ultrasound", "Yue Wang, Haoxin Chen", 1),
    ("crossref", "Voxel-first reconstruction", "Ada Splatter", 1),
    ("biorxiv", "Mitochondrial signaling", "P. R. Castello", 0),
    ("crossref", "A review of 3D content", "Xianghao Bai", 0),
)


@pytest.fixture
def run():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    conn = resmon_mod._get_db()
    run_id = insert_execution(conn, {
        "execution_type": "deep_sweep", "start_time": "2026-11-10T12:00:00Z",
        "parameters": json.dumps({"query": "splats", "repositories": ["arxiv", "crossref", "biorxiv"]}),
    })
    for n, (source, title, authors, new) in enumerate(PAPERS):
        doc = conn.execute(
            "INSERT INTO documents (source_repository, external_id, title, authors, publication_date, metadata_hash) "
            "VALUES (?, ?, ?, ?, ?, ?)", (source, f"find-{n}", title, authors, f"2026-11-0{n + 1}", f"find-{n}")).lastrowid
        link_execution_document(conn, run_id, doc, is_new=bool(new))
    update_execution_status(conn, run_id, "completed", end_time="2026-11-10T12:01:00Z", result_count=4, new_result_count=2)
    conn.commit()
    return run_id


def _page(run_id: int, **params) -> dict:
    answer = TestClient(resmon_mod.app).get(f"/api/executions/{run_id}/documents", params=params)
    assert answer.status_code == 200, answer.text
    return answer.json()


def test_a_find_matches_title_authors_or_source_and_counts_what_it_searched(run):
    every = _page(run)
    assert (every["total"], every["searched"], every["q"]) == (4, 4, "")
    by_title = _page(run, q="GAUSSIAN splat")
    assert [p["title"] for p in by_title["papers"]] == ["Gaussian Splatting for Ultrasound"]
    assert (by_title["total"], by_title["searched"]) == (1, 4)
    # "splat" is in one title and one author's name: both are found, newest first.
    assert [p["title"] for p in _page(run, q="splat")["papers"]] == ["Voxel-first reconstruction", "Gaussian Splatting for Ultrasound"]
    assert _page(run, q="biorxiv")["total"] == 1
    nothing = _page(run, q="no such words")
    assert (nothing["papers"], nothing["total"], nothing["searched"]) == ([], 0, 4)


def test_a_find_narrows_within_new_papers_and_pages(run):
    fresh = _page(run, q="crossref", only_new=True)
    assert (fresh["total"], fresh["searched"]) == (1, 2)
    first = _page(run, q="a", limit=1)
    second = _page(run, q="a", limit=1, offset=1)
    assert first["total"] == second["total"] >= 2
    assert first["papers"][0]["id"] != second["papers"][0]["id"]


def test_the_find_is_the_librarys(run):
    assert paper_find_clause("   ") == ("", [])
    clause, params = paper_find_clause(" Wang ")
    assert params == ["Wang"] * 3 and "documents.title" in clause and "documents.authors" in clause
    client = TestClient(resmon_mod.app)
    for paper in _page(run)["papers"]:
        assert client.post("/api/reading-queue", json={"document_id": paper["id"]}).status_code == 201
    for words in ("splat", "CROSSREF", "castello", "nothing like this"):
        in_run = {p["id"] for p in _page(run, q=words)["papers"]}
        in_library = {e["document_id"] for e in client.get("/api/reading-queue", params={"q": words}).json()["entries"]}
        assert in_run == in_library, words
    assert client.get(f"/api/executions/{run}/documents", params={"q": "x" * 201}).status_code == 400
