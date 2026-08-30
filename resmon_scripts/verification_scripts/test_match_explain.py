"""Match transparency: what resmon can verify, and what it must not claim.

The risk this feature carries is over-claiming. resmon cannot know why a
relevance-ranked source returned a paper, and a transparency feature that
implies otherwise is worse than none — it manufactures confidence in an answer
that is not there.

So the assertions here fall into two groups. One group checks the arithmetic:
word-boundary matching that does not fire on "AI" inside "said", per-keyword
unique contribution, quoted phrases. The other checks the *language*: that every
explanation carries what resmon cannot see, that a match is described as making
a paper "plausible" rather than as the reason it was returned, and that resmon
speaks with certainty only for sources whose results it filters itself.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import match_explain  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    init_db,
    insert_document,
    insert_execution,
    link_execution_document,
    update_execution_status,
)


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_db(conn=c)
    yield c
    c.close()


def _doc(conn, *, source="arxiv", ext="1", title="A paper", abstract="",
         categories="cs.LG", authors="Ada Lovelace", doi=None):
    return insert_document(conn, {
        "source_repository": source, "external_id": ext, "doi": doi,
        "title": title, "authors": authors, "abstract": abstract,
        "publication_date": "2026-01-15", "url": "https://example.org",
        "categories": categories, "metadata_hash": f"h-{source}-{ext}",
    })


def _run(conn, *, keywords=None, query=None, doc_ids=(), name=None):
    params = {}
    if keywords is not None:
        params["keywords"] = keywords
    if query is not None:
        params["query"] = query
    exec_id = insert_execution(conn, {
        "execution_type": "deep_sweep",
        "routine_id": None,
        "parameters": json.dumps(params),
        "start_time": "2026-01-20T10:00:00Z",
        "status": "running",
    })
    for doc_id in doc_ids:
        link_execution_document(conn, exec_id, doc_id, is_new=True)
    update_execution_status(conn, exec_id, "completed",
                            end_time="2026-01-20T10:05:00Z")
    return exec_id


def _kw(result, keyword):
    return next(k for k in result["keywords"] if k["keyword"] == keyword)


# ---------------------------------------------------------------------------
# Matching arithmetic
# ---------------------------------------------------------------------------


def test_a_keyword_is_matched_on_word_boundaries_not_substrings(conn):
    """"AI" appears inside "said". A transparency feature reporting that as a
    match would be reporting a falsehood."""
    doc_id = _doc(conn, title="He said nothing", abstract="Chains and plains.")
    exec_id = _run(conn, keywords=["AI"], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert _kw(result, "AI")["matched"] is False
    assert result["verdict"] == "no_local_evidence"


def test_a_real_word_match_is_found(conn):
    doc_id = _doc(conn, title="AI systems", abstract="On AI.")
    exec_id = _run(conn, keywords=["AI"], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert _kw(result, "AI")["matched"] is True
    assert _kw(result, "AI")["fields"] == ["title", "abstract"]


def test_each_field_is_reported_separately(conn):
    doc_id = _doc(
        conn,
        title="Transformer architectures",
        abstract="We study cardiac imaging.",
        categories="eess.IV",
        authors="Rosalind Franklin",
    )
    exec_id = _run(
        conn,
        keywords=["transformer", "cardiac", "eess.IV", "Franklin", "quantum"],
        doc_ids=[doc_id],
    )

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert _kw(result, "transformer")["fields"] == ["title"]
    assert _kw(result, "cardiac")["fields"] == ["abstract"]
    assert _kw(result, "eess.IV")["fields"] == ["categories"]
    assert _kw(result, "Franklin")["fields"] == ["authors"]
    assert _kw(result, "quantum")["fields"] == []
    assert _kw(result, "quantum")["where"] == "nowhere resmon can check"


def test_a_keyword_ending_in_punctuation_still_matches(conn):
    """A \\b anchor after "C++" never fires. Category codes and versioned terms
    are common enough keywords that getting this wrong is not academic."""
    doc_id = _doc(conn, title="Fast C++ kernels", abstract="COVID-19 modelling.")
    exec_id = _run(conn, keywords=["C++", "COVID-19"], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert _kw(result, "C++")["matched"] is True
    assert _kw(result, "COVID-19")["matched"] is True


def test_a_quoted_phrase_is_matched_as_a_phrase(conn):
    doc_id = _doc(conn, title="On machine   learning", abstract="")
    exec_id = _run(conn, keywords=['"machine learning"'], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    # The quotes are query syntax, and the phrase matches across any whitespace.
    assert _kw(result, '"machine learning"')["matched"] is True


def test_a_phrase_does_not_match_its_words_scattered(conn):
    doc_id = _doc(conn, title="Learning about the machine", abstract="")
    exec_id = _run(conn, keywords=['"machine learning"'], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)
    assert _kw(result, '"machine learning"')["matched"] is False


def test_an_empty_keyword_does_not_match_everything(conn):
    """A stray empty chip compiled to an empty pattern would match every
    paper in the corpus and quietly poison every number downstream."""
    doc_id = _doc(conn, title="Anything", abstract="")
    exec_id = _run(conn, keywords=["", "   ", '""'], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)
    assert all(k["matched"] is False for k in result["keywords"])


def test_a_keyword_carrying_boolean_operators_is_flagged_not_parsed(conn):
    """Several upstreams forward operators verbatim. resmon checks the literal
    text and says so, rather than implementing a boolean engine whose semantics
    would differ from the upstream's anyway."""
    doc_id = _doc(conn, title="Neural methods", abstract="")
    exec_id = _run(conn, keywords=['neural OR "deep learning"'], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)
    assert _kw(result, 'neural OR "deep learning"')["contains_operators"] is True


def test_a_legacy_run_with_only_a_query_string_is_still_explained(conn):
    """Older executions carry no keywords list. Splitting the query the way a
    user reads it beats explaining one long string."""
    doc_id = _doc(conn, title="Solid-state battery cathodes", abstract="")
    exec_id = _run(conn, query='"solid-state battery" cathodes', doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert {k["keyword"] for k in result["keywords"]} == {
        "solid-state battery", "cathodes",
    }
    assert all(k["matched"] for k in result["keywords"])


def test_matches_are_ordered_strongest_evidence_first(conn):
    doc_id = _doc(conn, title="Cardiac imaging", abstract="Using transformers.",
                  categories="eess.IV", authors="A. Author")
    exec_id = _run(conn, keywords=["quantum", "transformers", "cardiac"],
                   doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert [k["keyword"] for k in result["keywords"]] == [
        "cardiac",      # title
        "transformers",  # abstract
        "quantum",      # missed
    ]


# ---------------------------------------------------------------------------
# The language — what resmon may and may not claim
# ---------------------------------------------------------------------------


def test_the_full_text_limit_is_stated_even_when_keywords_matched(conn):
    """A title match explains why the paper is plausible. It is still not the
    upstream's reasoning, and the difference matters to anyone defending a
    search strategy."""
    doc_id = _doc(conn, title="Transformer architectures")
    exec_id = _run(conn, keywords=["transformer"], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert result["verdict"] == "local_evidence"
    assert any("not its full text" in limit
               for limit in result["what_resmon_cannot_see"])


def test_a_relevance_ranked_source_is_named_as_such(conn):
    """Semantic Scholar scores against the whole query. A paper with no literal
    match is expected behaviour there, not an anomaly."""
    doc_id = _doc(conn, source="semantic_scholar", title="Something else")
    exec_id = _run(conn, keywords=["transformer"], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert result["source"]["keyword_combination"] == "Relevance-ranked"
    assert any("relevance-ranked" in limit.lower()
               for limit in result["what_resmon_cannot_see"])
    # And it must not read as a fault.
    assert "does not mean the paper is irrelevant" in result["headline"]


def test_a_match_is_called_plausible_not_the_reason(conn):
    doc_id = _doc(conn, source="openalex", title="Transformer architectures")
    exec_id = _run(conn, keywords=["transformer"], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert "plausible match" in result["headline"]
    assert "which resmon cannot see" in result["headline"]


@pytest.mark.parametrize("source", ["biorxiv", "medrxiv"])
def test_locally_filtered_sources_are_answered_with_certainty(conn, source):
    """The /details clients are filtered locally, so their explanation is complete."""
    doc_id = _doc(conn, source=source, title="Cardiac organoids")
    exec_id = _run(conn, keywords=["cardiac"], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert result["verdict"] == "resmon_filtered"
    assert result["source"]["resmon_filtered_locally"] is True
    assert "complete reason, not a partial one" in result["headline"]


def test_a_run_with_no_keywords_says_so_rather_than_guessing(conn):
    doc_id = _doc(conn, title="A paper")
    exec_id = _run(conn, doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    assert result["verdict"] == "no_keywords_recorded"
    assert result["keywords"] == []


def test_a_paper_found_by_several_runs_is_not_attributed_to_one(conn):
    doc_id = _doc(conn, title="Cardiac transformers")
    _run(conn, keywords=["cardiac"], doc_ids=[doc_id])
    _run(conn, keywords=["transformer"], doc_ids=[doc_id])

    result = match_explain.explain_document(conn, doc_id)

    assert len(result["runs"]) == 2
    assert {k["keyword"] for k in result["keywords"]} == {"cardiac", "transformer"}


def test_a_missing_document_raises_rather_than_inventing_an_answer(conn):
    with pytest.raises(LookupError):
        match_explain.explain_document(conn, 9999)


# ---------------------------------------------------------------------------
# Per-keyword marginal contribution
# ---------------------------------------------------------------------------


def test_a_keyword_contributing_nothing_unique_is_visible_as_such(conn):
    """The actionable finding: this term is costing a slot in every query and
    buying nothing, because everything it finds another term finds too."""
    a = _doc(conn, ext="1", title="Transformer models for cardiac imaging")
    b = _doc(conn, ext="2", title="Cardiac imaging advances")
    exec_id = _run(conn, keywords=["transformer", "cardiac"], doc_ids=[a, b])

    result = match_explain.keyword_contribution(conn, execution_id=exec_id)
    by_keyword = {r["keyword"]: r for r in result["keywords"]}

    assert by_keyword["cardiac"]["matched"] == 2
    assert by_keyword["cardiac"]["unique"] == 1
    assert by_keyword["transformer"]["matched"] == 1
    assert by_keyword["transformer"]["unique"] == 0
    assert by_keyword["transformer"]["shared"] == 1


def test_keywords_are_ranked_by_what_they_uniquely_contribute(conn):
    a = _doc(conn, ext="1", title="Cardiac one")
    b = _doc(conn, ext="2", title="Cardiac two")
    c = _doc(conn, ext="3", title="Cardiac three with transformer")
    exec_id = _run(conn, keywords=["transformer", "cardiac"], doc_ids=[a, b, c])

    result = match_explain.keyword_contribution(conn, execution_id=exec_id)
    assert [r["keyword"] for r in result["keywords"]] == ["cardiac", "transformer"]


def test_papers_no_keyword_accounts_for_are_counted(conn):
    """On a relevance-ranked source this is entirely normal. A large share of
    them is still worth knowing about."""
    a = _doc(conn, ext="1", title="Cardiac imaging")
    b = _doc(conn, ext="2", title="Entirely unrelated work")
    exec_id = _run(conn, keywords=["cardiac"], doc_ids=[a, b])

    result = match_explain.keyword_contribution(conn, execution_id=exec_id)

    assert result["documents_considered"] == 2
    assert result["documents_matched"] == 1
    assert result["documents_unexplained"] == 1


def test_a_unique_share_is_withheld_until_it_would_mean_something(conn):
    """A percentage of nine papers swings on one paper. Counts are always
    reported; the proportion waits."""
    docs = [_doc(conn, ext=str(i), title=f"Cardiac study {i}") for i in range(3)]
    exec_id = _run(conn, keywords=["cardiac"], doc_ids=docs)

    result = match_explain.keyword_contribution(conn, execution_id=exec_id)
    row = result["keywords"][0]

    assert row["matched"] == 3
    assert row["unique"] == 3
    assert row["unique_share"] is None
    assert result["minimum_sample_for_share"] == match_explain.MIN_SAMPLE_FOR_SHARE


def test_a_unique_share_is_reported_once_the_sample_supports_it(conn):
    docs = [_doc(conn, ext=str(i), title=f"Cardiac study {i}") for i in range(12)]
    exec_id = _run(conn, keywords=["cardiac"], doc_ids=docs)

    row = match_explain.keyword_contribution(
        conn, execution_id=exec_id)["keywords"][0]
    assert row["unique_share"] == 1.0


def test_corpus_scope_pools_every_keyword_ever_searched(conn):
    a = _doc(conn, ext="1", title="Cardiac imaging")
    b = _doc(conn, ext="2", title="Transformer models")
    _run(conn, keywords=["cardiac"], doc_ids=[a])
    _run(conn, keywords=["transformer"], doc_ids=[b])

    result = match_explain.keyword_contribution(conn)

    assert result["scope"] == {"type": "corpus"}
    assert {r["keyword"] for r in result["keywords"]} == {"cardiac", "transformer"}
    assert result["documents_considered"] == 2


def test_an_empty_corpus_reports_insufficient_rather_than_zeroes(conn):
    result = match_explain.keyword_contribution(conn)

    assert result["sufficient"] is False
    assert result["insufficient_reason"]
    assert result["keywords"] == []


def test_a_corpus_with_no_recorded_keywords_says_which_is_missing(conn):
    _doc(conn, title="A paper")
    result = match_explain.keyword_contribution(conn)

    assert result["sufficient"] is False
    assert "keywords" in result["insufficient_reason"]


def test_contribution_and_explanation_agree(conn):
    """A paper counted under a keyword here must say so when opened. The two
    views use one matcher precisely so they cannot drift apart."""
    doc_id = _doc(conn, title="Cardiac imaging with transformers")
    exec_id = _run(conn, keywords=["cardiac", "quantum"], doc_ids=[doc_id])

    contribution = match_explain.keyword_contribution(conn, execution_id=exec_id)
    explanation = match_explain.explain_document(conn, doc_id, execution_id=exec_id)

    counted = {r["keyword"] for r in contribution["keywords"] if r["matched"]}
    explained = {k["keyword"] for k in explanation["keywords"] if k["matched"]}
    assert counted == explained == {"cardiac"}


def test_a_missing_execution_raises(conn):
    with pytest.raises(LookupError):
        match_explain.keyword_contribution(conn, execution_id=9999)


# ---------------------------------------------------------------------------
# The endpoints
# ---------------------------------------------------------------------------


def _client():
    import resmon as resmon_mod
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from fastapi.testclient import TestClient
    from resmon import app
    return TestClient(app), resmon_mod


def test_the_why_endpoint_answers():
    client, resmon_mod = _client()
    db = resmon_mod._get_db()
    doc_id = _doc(db, title="Cardiac imaging")
    exec_id = _run(db, keywords=["cardiac"], doc_ids=[doc_id])

    body = client.get(f"/api/documents/{doc_id}/why?execution_id={exec_id}").json()

    assert body["verdict"] == "local_evidence"
    assert body["what_resmon_cannot_see"]


def test_the_why_endpoint_404s_on_an_unknown_paper():
    client, _ = _client()
    assert client.get("/api/documents/424242/why").status_code == 404


def test_the_keyword_contribution_endpoint_answers():
    client, resmon_mod = _client()
    db = resmon_mod._get_db()
    doc_id = _doc(db, title="Cardiac imaging")
    _run(db, keywords=["cardiac"], doc_ids=[doc_id])

    body = client.get("/api/analytics/keyword-contribution").json()

    assert body["sufficient"] is True
    assert body["keywords"][0]["keyword"] == "cardiac"
