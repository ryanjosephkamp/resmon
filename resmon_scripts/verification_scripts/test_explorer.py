"""Corpus-wide explorer (Phase 2b).

The cases that matter here are pagination correctness -- especially that no
paper can fall out of the sequence -- and that filters actually narrow rather
than appearing to.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import explorer  # noqa: E402
from implementation_scripts.database import init_db, insert_document  # noqa: E402


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_db(conn=c)
    yield c
    c.close()


def _doc(conn, *, source="arxiv", ext="1", title="A paper", authors="Ada Lovelace",
         abstract="An abstract about diffusion models.", pub="2026-01-15",
         categories="cs.LG", doi=None):
    return insert_document(conn, {
        "source_repository": source, "external_id": ext, "doi": doi,
        "title": title, "authors": authors, "abstract": abstract,
        "publication_date": pub, "url": "https://e.org/x",
        "categories": categories, "metadata_hash": f"{source}-{ext}",
    })


# ---------------------------------------------------------------------------
# Empty and trivial
# ---------------------------------------------------------------------------

def test_empty_corpus_returns_an_empty_page_not_an_error(conn):
    r = explorer.search(conn)
    assert r["results"] == []
    assert r["total"] == 0
    assert r["has_more"] is False
    assert r["next_cursor"] is None

    f = explorer.facets(conn)
    assert f["sources"] == [] and f["authors"] == [] and f["categories"] == []


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

def test_each_filter_narrows(conn):
    _doc(conn, source="arxiv", ext="1", title="Diffusion models",
         authors="Ada Lovelace", categories="cs.LG", pub="2026-01-01")
    _doc(conn, source="pubmed", ext="2", title="Protein folding",
         authors="Alan Turing", categories="q-bio", pub="2025-06-01")

    assert len(explorer.search(conn)["results"]) == 2
    assert len(explorer.search(conn, sources=["arxiv"])["results"]) == 1
    assert len(explorer.search(conn, authors=["Alan Turing"])["results"]) == 1
    assert len(explorer.search(conn, categories=["q-bio"])["results"]) == 1
    assert len(explorer.search(conn, date_from="2026-01-01")["results"]) == 1
    assert len(explorer.search(conn, date_to="2025-12-31")["results"]) == 1


def test_filters_combine_as_and_not_or(conn):
    _doc(conn, source="arxiv", ext="1", authors="Ada Lovelace", categories="cs.LG")
    _doc(conn, source="pubmed", ext="2", authors="Ada Lovelace", categories="q-bio")

    r = explorer.search(conn, sources=["arxiv"], authors=["Ada Lovelace"])
    assert len(r["results"]) == 1
    r = explorer.search(conn, sources=["arxiv"], categories=["q-bio"])
    assert r["results"] == [], "a paper must satisfy every filter, not any"


def test_free_text_searches_title_and_abstract(conn):
    _doc(conn, ext="1", title="Diffusion models", abstract="Nothing relevant here.")
    _doc(conn, ext="2", title="Unrelated", abstract="A study of protein folding.")

    titles = [d["title"] for d in explorer.search(conn, query="diffusion")["results"]]
    assert titles == ["Diffusion models"]
    titles = [d["title"] for d in explorer.search(conn, query="folding")["results"]]
    assert titles == ["Unrelated"], "the abstract should be searched too"


def test_free_text_uses_the_full_text_index(conn):
    _doc(conn, ext="1", title="Diffusion models")
    r = explorer.search(conn, query="diffusion")
    assert r["used_full_text_index"] is True, (
        "FTS5 is available here; falling back to LIKE would be a scan"
    )


def test_punctuation_in_a_query_cannot_break_it(conn):
    """User input must never reach FTS5 as syntax."""
    _doc(conn, ext="1", title="Diffusion models")
    for hostile in ['"', 'NEAR(', 'a OR b', '*', '-diffusion', 'a"b', '()']:
        r = explorer.search(conn, query=hostile)
        assert isinstance(r["results"], list), f"query {hostile!r} raised"


# ---------------------------------------------------------------------------
# Pagination — the part where papers go missing
# ---------------------------------------------------------------------------

def test_pagination_walks_every_paper_exactly_once(conn):
    for i in range(25):
        _doc(conn, ext=str(i), title=f"Paper {i}", pub=f"2026-01-{(i % 28) + 1:02d}")

    seen, cursor, pages = [], None, 0
    while pages < 50:
        page = explorer.search(conn, cursor=cursor, limit=7)
        seen.extend(d["id"] for d in page["results"])
        cursor = page["next_cursor"]
        pages += 1
        if not cursor:
            break

    assert len(seen) == 25, f"expected 25 papers across pages, saw {len(seen)}"
    assert len(set(seen)) == 25, "a paper appeared on more than one page"


def test_undated_papers_are_not_lost_in_pagination(conn):
    """The failure this guards against is silent.

    The sort key is COALESCE(publication_date, ''). Compared as a real NULL, a
    row-value cursor comparison yields NULL and every undated paper drops out of
    the sequence without any error.
    """
    for i in range(5):
        _doc(conn, ext=f"dated{i}", title=f"Dated {i}", pub=f"2026-01-0{i + 1}")
    for i in range(4):
        _doc(conn, ext=f"undated{i}", title=f"Undated {i}", pub=None)

    seen, cursor = [], None
    for _ in range(20):
        page = explorer.search(conn, cursor=cursor, limit=2)
        seen.extend(d["title"] for d in page["results"])
        cursor = page["next_cursor"]
        if not cursor:
            break

    assert len(seen) == 9, f"expected all 9 papers, walked {len(seen)}"
    assert sum(1 for s in seen if s.startswith("Undated")) == 4


def test_undated_papers_sort_last(conn):
    _doc(conn, ext="undated", title="Undated", pub=None)
    _doc(conn, ext="dated", title="Dated", pub="2020-01-01")
    titles = [d["title"] for d in explorer.search(conn)["results"]]
    assert titles == ["Dated", "Undated"]


def test_a_malformed_cursor_is_rejected_not_ignored(conn):
    _doc(conn, ext="1")
    with pytest.raises(ValueError):
        explorer.search(conn, cursor="not-a-cursor")


def test_page_size_is_clamped(conn):
    for i in range(5):
        _doc(conn, ext=str(i))
    assert explorer.search(conn, limit=10_000)["page_size"] == explorer.MAX_PAGE_SIZE
    assert explorer.search(conn, limit=0)["page_size"] == 1


# ---------------------------------------------------------------------------
# Facets
# ---------------------------------------------------------------------------

def test_facets_count_documents_not_rows(conn):
    _doc(conn, ext="1", authors="Ada Lovelace, Alan Turing", categories="cs.LG, stat.ML")
    _doc(conn, ext="2", authors="Ada Lovelace", categories="cs.LG")

    f = explorer.facets(conn)
    authors = {a["value"]: a["count"] for a in f["authors"]}
    assert authors["Ada Lovelace"] == 2
    assert authors["Alan Turing"] == 1
    categories = {c["value"]: c["count"] for c in f["categories"]}
    assert categories["cs.LG"] == 2
    assert categories["stat.ML"] == 1


def test_a_facet_does_not_count_against_itself(conn):
    """Ticking one source must not make the other sources vanish from the list.

    Otherwise the filter becomes one-way: once a source is selected there is no
    longer anything in the interface to select instead.
    """
    _doc(conn, source="arxiv", ext="1")
    _doc(conn, source="pubmed", ext="2")

    f = explorer.facets(conn, sources=["arxiv"])
    values = {s["value"] for s in f["sources"]}
    assert values == {"arxiv", "pubmed"}, (
        "the source facet should ignore the source filter so alternatives stay visible"
    )

    # But it must still constrain the other facets.
    _doc(conn, source="pubmed", ext="3", categories="q-bio")
    cats = {c["value"] for c in explorer.facets(conn, sources=["arxiv"])["categories"]}
    assert "q-bio" not in cats


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def test_matching_ids_respects_filters_and_order(conn):
    a = _doc(conn, source="arxiv", ext="1", pub="2026-05-01")
    _doc(conn, source="pubmed", ext="2", pub="2026-06-01")
    c = _doc(conn, source="arxiv", ext="3", pub="2026-07-01")

    ids = explorer.matching_ids(conn, sources=["arxiv"])
    assert ids == [c, a], "newest publication first"


def test_matching_ids_is_bounded(conn):
    for i in range(10):
        _doc(conn, ext=str(i))
    assert len(explorer.matching_ids(conn, limit=3)) == 3


def test_total_is_capped_rather_than_counted_without_limit(conn):
    for i in range(5):
        _doc(conn, ext=str(i))
    r = explorer.search(conn)
    assert r["total"] == 5
    assert r["total_is_capped"] is False
    assert r["count_cap"] == explorer.COUNT_CAP
