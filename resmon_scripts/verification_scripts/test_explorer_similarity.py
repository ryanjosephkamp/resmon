"""P4 and P6 — a similarity sort re-orders, and never re-selects.

**P4 is the property that makes the sort control safe to use.** A user who
switches from Newest to Closest must be looking at the same papers in a
different order. If the two sorts could disagree about *which* papers match,
the control would silently change the result set while claiming to change the
order, and nothing would look wrong. So the assertion is set equality and total
equality, over **every field of ``ExplorerFilters``** — the denominator is the
Pydantic model's own field list, so a filter added without a case here fails.

**P6** is the neighbour endpoint: k neighbours, self excluded, each carrying its
distance and its source.

The database is real and ``vec0`` is really loaded. Vectors are written directly
rather than through a model, so a ranking is exactly predictable and the test
asserts an order rather than a plausibility.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import explorer, paper_collections, vector_index  # noqa: E402
from implementation_scripts.database import index_document_facets, init_db  # noqa: E402

pytest.importorskip("sqlite_vec")

MODEL = "test-model"
DIMS = 3


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "corpus.db"))
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


def _paper(
    conn: sqlite3.Connection,
    external_id: str,
    *,
    title: str = "A paper",
    abstract: str = "An abstract",
    source: str = "arxiv",
    authors: str = "A. Author",
    categories: str = "cs.AI",
    date: str = "2026-01-01",
    vector: list[float] | None = None,
) -> int:
    cursor = conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, abstract, authors, "
        "categories, publication_date, metadata_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (source, external_id, title, abstract, authors, categories, date, f"h-{external_id}"),
    )
    doc_id = int(cursor.lastrowid)
    index_document_facets(conn, doc_id, authors, categories)
    if vector is not None:
        conn.execute(
            "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) "
            "VALUES (?, ?, ?, ?, 'title+abstract')",
            (doc_id, MODEL, len(vector), vector_index.pack_vector(vector)),
        )
    conn.commit()
    return doc_id


def _v(*values: float) -> bytes:
    return vector_index.pack_vector(list(values))


# ---------------------------------------------------------------------------
# P4 — the same set, re-ordered
# ---------------------------------------------------------------------------


def _filter_field_names() -> list[str]:
    """The denominator: ``ExplorerFilters``'s own fields, not a hand list."""
    import resmon as resmon_mod

    return sorted(resmon_mod.ExplorerFilters.model_fields)


# One filter value per field, chosen so each actually excludes something in the
# corpus built below. ``None``/``[]`` would exercise the unfiltered path six
# times over and prove nothing about the fields.
_FILTER_CASES: dict[str, dict] = {
    "sources": {"sources": ["arxiv"]},
    "authors": {"authors": ["A. Author"]},
    "categories": {"categories": ["cs.AI"]},
    "date_from": {"date_from": "2026-02-01"},
    "date_to": {"date_to": "2026-01-31"},
    # The collection searched: ``mixed_corpus`` files three of the five papers
    # in a second collection, whose id is 2.
    "collection": {"collection_id": 2},
}

# ``query`` is deliberately **not** a P4 case.
#
# In the similarity sort the free-text phrase is the *ranking query*, not a
# filter. Requiring the two sorts to return the same set for the same ``query``
# is exactly what would make real queries answer with an empty page:
# the text filter is an AND over every word typed, so a plain-English phrase
# matched nothing and there was nothing left to rank.
#
# The invariant that remains is about the **structured** filters, and it is the
# one that protects a user: switching sort never changes which sources, authors,
# categories or dates are in scope. ``query``'s own behaviour is asserted
# positively below, in
# ``test_the_phrase_ranks_rather_than_filters_in_similarity_mode`` — so the field
# is covered by a stronger claim than the one it was removed from, not by none.
_QUERY_IS_NOT_A_FILTER = "query"


def test_the_filter_cases_cover_every_field_of_explorer_filters():
    """A filter added to the model without a case here fails, by construction."""
    assert sorted([*_FILTER_CASES, _QUERY_IS_NOT_A_FILTER]) == _filter_field_names()


@pytest.fixture
def mixed_corpus(conn):
    """Papers varied along every filter axis, some embedded and some not."""
    ids = {
        "q1": _paper(conn, "q1", title="Quantum gravity", source="arxiv",
                     authors="A. Author", categories="cs.AI", date="2026-01-10",
                     vector=[1.0, 0.0, 0.0]),
        "q2": _paper(conn, "q2", title="Quantum optics", source="pubmed",
                     authors="B. Other", categories="physics", date="2026-02-10",
                     vector=[0.9, 0.1, 0.0]),
        "q3": _paper(conn, "q3", title="Quantum chemistry", source="arxiv",
                     authors="A. Author", categories="cs.AI", date="2026-03-10",
                     vector=[0.0, 1.0, 0.0]),
        # Deliberately unembedded: the one that must be appended, never dropped.
        "q4": _paper(conn, "q4", title="Quantum biology", source="arxiv",
                     authors="A. Author", categories="cs.AI", date="2026-01-20",
                     vector=None),
        "other": _paper(conn, "other", title="Classical mechanics", source="pubmed",
                        authors="C. Third", categories="physics", date="2026-02-20",
                        vector=[0.0, 0.0, 1.0]),
    }
    quantum = paper_collections.create(conn, "Quantum")["id"]
    assert quantum == 2
    paper_collections.copy(conn, quantum, [ids["q1"], ids["q3"], ids["q4"]])
    vector_index.rebuild(conn, MODEL)
    return ids


@pytest.mark.parametrize("field", sorted(_FILTER_CASES))
def test_similarity_returns_the_same_total_and_id_set_as_newest(field, conn, mixed_corpus):
    """P4. 6 of 6 **structured** filter fields; ``query`` is not one.

    The denominator is still ``ExplorerFilters.model_fields`` — the test above
    asserts that these six plus ``query`` account for all of it.
    """
    filters = _FILTER_CASES[field]

    newest = explorer.search(conn, limit=200, **filters)
    ranked = explorer.search(
        conn, limit=200, sort="similarity", query_vector=_v(1.0, 0.0, 0.0),
        model=MODEL, **filters,
    )

    assert ranked["total"] == newest["total"], f"{field}: totals disagree"
    assert {r["id"] for r in ranked["results"]} == {r["id"] for r in newest["results"]}, (
        f"{field}: the similarity sort changed which papers match"
    )
    assert ranked["total_is_exact"] is newest["total_is_exact"] is True
    assert ranked["sort"] == "similarity" and newest["sort"] == "newest"


def test_the_phrase_ranks_rather_than_filters_in_similarity_mode(conn, mixed_corpus):
    """The positive claim for ``query``, in place of a P4 case.

    A phrase no paper contains returns the **whole** structured-filter scope,
    ranked — where the newest sort correctly returns nothing, because there it
    *is* a filter. This is the case a plain-English query hits.
    """
    phrase = "a phrase no paper in this corpus contains anywhere"

    keyword = explorer.search(conn, limit=200, query=phrase)
    assert keyword["total"] == 0, "the phrase must match nothing as a text filter"

    ranked = explorer.search(
        conn, limit=200, query=phrase, sort="similarity",
        query_vector=_v(1.0, 0.0, 0.0), model=MODEL,
    )
    assert ranked["sort"] == "similarity"
    assert ranked["total"] == 5, "the ranking covers the corpus, not the keyword slice"
    assert ranked["ranked_count"] == 4 and ranked["unranked_count"] == 1
    # And it is not claiming the text index shaped this.
    assert ranked["used_full_text_index"] is False


def test_the_structured_filters_still_bind_when_the_phrase_does_not(conn, mixed_corpus):
    """The other half of R1: dropping the text filter drops *only* the text filter."""
    ranked = explorer.search(
        conn, limit=200, query="a phrase no paper contains", sort="similarity",
        query_vector=_v(1.0, 0.0, 0.0), model=MODEL, sources=["pubmed"],
    )
    assert {r["source_repository"] for r in ranked["results"]} == {"pubmed"}
    assert ranked["total"] == 2


def test_the_order_actually_changes_or_the_test_above_proves_nothing(conn, mixed_corpus):
    """A guard on the guard: identical sets are only interesting if the order differs."""
    newest = explorer.search(conn, limit=200)
    ranked = explorer.search(
        conn, limit=200, sort="similarity", query_vector=_v(1.0, 0.0, 0.0), model=MODEL
    )
    assert [r["id"] for r in newest["results"]] != [r["id"] for r in ranked["results"]]


def test_the_ranking_is_by_distance_and_the_distances_are_reported(conn, mixed_corpus):
    ranked = explorer.search(
        conn, limit=200, sort="similarity", query_vector=_v(1.0, 0.0, 0.0), model=MODEL
    )
    ids = [r["id"] for r in ranked["results"]]
    assert ids[0] == mixed_corpus["q1"]  # exact match, distance 0
    assert ids[1] == mixed_corpus["q2"]  # nearest
    distances = [r["distance"] for r in ranked["results"] if r["distance"] is not None]
    assert distances == sorted(distances)
    assert distances[0] == pytest.approx(0.0)


def test_unembedded_papers_are_appended_last_and_counted_not_dropped(conn, mixed_corpus):
    """A corpus mid-backfill must not lose rows when somebody changes the sort."""
    ranked = explorer.search(
        conn, limit=200, sort="similarity", query_vector=_v(1.0, 0.0, 0.0), model=MODEL
    )
    ids = [r["id"] for r in ranked["results"]]
    assert ids[-1] == mixed_corpus["q4"]
    assert ranked["unranked_count"] == 1
    assert ranked["ranked_count"] == 4
    # ``distance: None`` rather than a large number: this paper has not been
    # judged distant, it has not been judged.
    unranked = next(r for r in ranked["results"] if r["id"] == mixed_corpus["q4"])
    assert unranked["distance"] is None


def test_paging_through_a_ranking_visits_every_row_once(conn, mixed_corpus):
    """The cursor is an offset here, and the caller does not have to know that."""
    seen: list[int] = []
    cursor = None
    for _ in range(10):
        page = explorer.search(
            conn, limit=2, cursor=cursor, sort="similarity",
            query_vector=_v(1.0, 0.0, 0.0), model=MODEL,
        )
        seen.extend(r["id"] for r in page["results"])
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)) == 5
    whole = explorer.search(
        conn, limit=200, sort="similarity", query_vector=_v(1.0, 0.0, 0.0), model=MODEL
    )
    assert seen == [r["id"] for r in whole["results"]]


def test_a_keyset_cursor_handed_to_a_similarity_sort_starts_over_rather_than_erroring(
    conn, mixed_corpus
):
    """Switching sort mid-list should show papers, not a 400."""
    page = explorer.search(
        conn, limit=2, cursor="2026-01-10|1", sort="similarity",
        query_vector=_v(1.0, 0.0, 0.0), model=MODEL,
    )
    assert len(page["results"]) == 2
    assert page["results"][0]["id"] == mixed_corpus["q1"]


def test_a_similarity_sort_with_nothing_to_rank_against_says_so(conn, mixed_corpus):
    """Never a silent fallback: the list is labelled by the sort it is actually in."""
    page = explorer.search(conn, limit=200, sort="similarity")
    assert page["sort"] == "newest"
    assert "needs a search phrase and an embedding model" in page["similarity_unavailable"]
    assert len(page["results"]) == 5  # and no papers were lost saying so


def test_a_filter_that_matches_nothing_ranks_nothing(conn, mixed_corpus):
    page = explorer.search(
        conn, limit=200, sort="similarity", query_vector=_v(1.0, 0.0, 0.0),
        model=MODEL, sources=["nowhere"],
    )
    assert page["results"] == [] and page["total"] == 0


def test_a_narrow_filter_still_gets_a_full_ranking_of_what_it_matched(conn, mixed_corpus):
    """The trap a post-filter falls into: ``k`` applied before the restriction.

    ``pubmed`` holds the two papers *furthest* from the query, so a ranking that
    took the global top-k and then filtered would return nothing here.
    """
    page = explorer.search(
        conn, limit=200, sort="similarity", query_vector=_v(1.0, 0.0, 0.0),
        model=MODEL, sources=["pubmed"],
    )
    assert len(page["results"]) == 2
    assert page["ranked_count"] == 2


# ---------------------------------------------------------------------------
# P6 — more like this
# ---------------------------------------------------------------------------


def test_similar_returns_k_neighbours_with_distances_and_sources_self_excluded(
    conn, mixed_corpus
):
    """P6."""
    result = explorer.similar_to(conn, mixed_corpus["q1"], MODEL, k=2)
    assert result["reason"] is None
    neighbours = result["neighbours"]
    assert len(neighbours) == 2
    assert mixed_corpus["q1"] not in [n["id"] for n in neighbours]
    assert neighbours[0]["id"] == mixed_corpus["q2"]
    assert all(isinstance(n["distance"], float) for n in neighbours)
    assert all(n["source_repository"] for n in neighbours)
    assert [n["distance"] for n in neighbours] == sorted(n["distance"] for n in neighbours)


def test_asking_for_k_neighbours_returns_k_not_k_minus_the_paper_itself(conn, mixed_corpus):
    """A document is its own nearest neighbour; dropping it after the fact would
    quietly return one fewer every time."""
    assert len(explorer.similar_to(conn, mixed_corpus["q1"], MODEL, k=3)["neighbours"]) == 3


def test_an_unembedded_paper_says_why_it_has_no_neighbours(conn, mixed_corpus):
    result = explorer.similar_to(conn, mixed_corpus["q4"], MODEL, k=5)
    assert result["neighbours"] == []
    assert "no vector for the current model" in result["reason"]
    assert "backfill" in result["reason"]


def test_a_corpus_with_one_embedded_paper_says_why_rather_than_returning_nothing(conn):
    only = _paper(conn, "solo", vector=[1.0, 0.0, 0.0])
    vector_index.rebuild(conn, MODEL)
    result = explorer.similar_to(conn, only, MODEL, k=5)
    assert result["neighbours"] == []
    assert result["reason"]


def test_neighbours_are_never_drawn_from_another_model(conn):
    """The same-model rule, through the neighbour path rather than through ``nearest``."""
    a = _paper(conn, "a", vector=[1.0, 0.0, 0.0])
    b = _paper(conn, "b", vector=[0.9, 0.1, 0.0])
    conn.execute(
        "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) "
        "VALUES (?, 'other-model', 3, ?, 'title')",
        (_paper(conn, "c"), _v(1.0, 0.0, 0.0)),
    )
    conn.commit()
    vector_index.rebuild(conn, MODEL)
    result = explorer.similar_to(conn, a, MODEL, k=5)
    assert [n["id"] for n in result["neighbours"]] == [b]


# ---------------------------------------------------------------------------
# Every match ranked, however many
# ---------------------------------------------------------------------------


def _embedded_many(conn: sqlite3.Connection, n: int) -> list[int]:
    """*n* papers, each with a distinct 3-dimension vector, written at once."""
    conn.executemany(
        "INSERT INTO documents (source_repository, external_id, title, publication_date, metadata_hash) "
        "VALUES ('arxiv', ?, ?, '2026-01-01', ?)",
        [(f"m{i}", f"Paper {i}", f"m{i}") for i in range(n)],
    )
    ids = [int(r[0]) for r in conn.execute("SELECT id FROM documents ORDER BY id")]
    # Paper k sits at angle k on a circle, so its distance from (1, 0, 0) grows with k.
    import math  # noqa: PLC0415
    conn.executemany(
        "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) VALUES (?, ?, 3, ?, 'title')",
        [(doc_id, MODEL, vector_index.pack_vector([math.cos(k / n), math.sin(k / n), 0.0]))
         for k, doc_id in enumerate(ids)],
    )
    conn.commit()
    return ids


def test_a_ranking_past_vec0s_largest_k_ranks_every_paper(conn):
    """vec0 refuses k > 4,096, and a ranking that asked for more came back empty:
    every paper listed as "not embedded yet" in the newest order."""
    n = vector_index.KNN_K_MAX + 104
    ids = _embedded_many(conn, n)
    page = explorer.search(conn, limit=200, sort="similarity", query_vector=_v(1.0, 0.0, 0.0), model=MODEL)
    assert (page["ranked_count"], page["unranked_count"]) == (n, 0)
    assert [r["id"] for r in page["results"]] == ids[:200], "closest first"
    distances = [r["distance"] for r in page["results"]]
    assert all(d is not None for d in distances) and distances == sorted(distances)


def test_a_ranking_past_ten_thousand_ranks_and_counts_every_paper(conn):
    """The ranking read the newest 10,000 matches and no others."""
    ids = _embedded_many(conn, 10_050)
    last = explorer.search(conn, limit=50, cursor="10000", sort="similarity",
                           query_vector=_v(1.0, 0.0, 0.0), model=MODEL)
    assert (last["total"], last["total_is_exact"], last["ranked_count"]) == (10_050, True, 10_050)
    assert [r["id"] for r in last["results"]] == ids[10_000:], "the furthest are ranked too, last"
    assert last["has_more"] is False


def test_the_distances_of_the_full_ranking_are_the_indexs(conn, mixed_corpus):
    """The same paper is the same distance from a phrase whichever way it is ranked."""
    query = _v(0.6, 0.8, 0.0)
    whole = dict(vector_index.rank_all(conn, MODEL, query))
    nearest = dict(vector_index.nearest(conn, MODEL, query, k=10))
    assert set(whole) == set(nearest)
    for doc_id, distance in nearest.items():
        assert whole[doc_id] == pytest.approx(distance, abs=1e-6)


def test_a_later_page_of_a_ranking_reuses_it(conn, monkeypatch):
    ids = _embedded_many(conn, 120)
    calls: list[int] = []
    real = vector_index.rank_all

    def ranking(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(vector_index, "rank_all", ranking)
    first = explorer.search(conn, limit=50, sort="similarity", query_vector=_v(1.0, 0.0, 0.0), model=MODEL)
    second = explorer.search(conn, limit=50, cursor=first["next_cursor"], sort="similarity",
                             query_vector=_v(1.0, 0.0, 0.0), model=MODEL)
    assert len(calls) == 1, "Show more slices the first page's ranking"
    assert [r["id"] for r in first["results"] + second["results"]] == ids[:100]
    other = explorer.search(conn, limit=50, cursor=first["next_cursor"], sort="similarity",
                            query_vector=_v(0.0, 1.0, 0.0), model=MODEL)
    assert len(calls) == 2 and other["results"], "another phrase is another ranking"


def test_a_watch_past_vec0s_largest_k_is_audited_over_every_paper(conn):
    """The coverage audit asked vec0 for k = the watch's paper count, and past 4,096
    it read as "none of this watch's papers are embedded yet"."""
    from implementation_scripts import coverage_audit  # noqa: PLC0415

    n = vector_index.KNN_K_MAX + 104
    ids = _embedded_many(conn, n)
    cursor = conn.execute(
        "INSERT INTO routines (name, schedule_cron, parameters) VALUES ('Big', '0 0 * * *', '{\"query\": \"x\"}')")
    routine_id = int(cursor.lastrowid)
    run = int(conn.execute(
        "INSERT INTO executions (execution_type, routine_id, status, start_time, parameters) "
        "VALUES ('automated_sweep', ?, 'completed', '2026-01-01T00:00:00Z', '{}')", (routine_id,)).lastrowid)
    conn.executemany("INSERT INTO execution_documents (execution_id, document_id) VALUES (?, ?)",
                     [(run, doc_id) for doc_id in ids])
    conn.commit()
    routine = dict(conn.execute("SELECT * FROM routines WHERE id = ?", (routine_id,)).fetchone())
    audit = coverage_audit.audit_routine(conn, routine, MODEL, _v(1.0, 0.0, 0.0))
    assert audit["results"] == n
    assert audit["results_embedded"] == n
    assert audit["distribution"]["count"] == n
