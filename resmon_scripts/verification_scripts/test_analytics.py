"""Analytics queries and reference exports (Phase 2a).

The empty- and thin-corpus cases are first-class here, not an afterthought: a
user with two executions is the common case for a new install, and the failure
mode this suite exists to prevent is an interface that divides by zero or
presents a median of three numbers as a finding.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import analytics, reference_export  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    get_documents_by_ids,
    get_execution_documents,
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


def _doc(conn, *, source, ext, title, doi=None, authors="Ada Lovelace",
         pub="2026-01-15", seen="2026-01-20 12:00:00", categories="cs.LG"):
    doc_id = insert_document(conn, {
        "source_repository": source, "external_id": ext, "doi": doi,
        "title": title, "authors": authors, "abstract": "An abstract.",
        "publication_date": pub, "url": f"https://example.org/{ext}",
        "categories": categories, "metadata_hash": f"h-{source}-{ext}",
    })
    if seen:
        conn.execute("UPDATE documents SET first_seen_at = ? WHERE id = ?", (seen, doc_id))
    return doc_id


# ---------------------------------------------------------------------------
# Empty corpus — the state every new install starts in
# ---------------------------------------------------------------------------

def test_every_analytic_survives_an_empty_corpus(conn):
    """Nothing may raise, and no rate may be invented, on an empty database."""
    result = analytics.overview(conn)

    assert result["summary"]["documents"] == 0
    # A percentage of nothing is undefined, not zero.
    assert result["summary"]["doi_coverage"] is None
    assert result["summary"]["sufficient"] is False

    for section in ("source_contribution", "discovery_lag", "routine_health",
                    "publication_volume"):
        payload = result[section]
        assert payload["sufficient"] is False, section
        assert payload["sample_size"] == 0, section
        assert payload["insufficient_reason"], f"{section} must explain itself"


def test_empty_corpus_exports_are_valid_and_empty(conn):
    assert reference_export.to_bibtex([]) == ""
    assert reference_export.to_ris([]) == ""
    # CSV still carries its header, so a spreadsheet opens with named columns.
    assert reference_export.to_csv([]).strip() == ",".join(reference_export.CSV_COLUMNS)


# ---------------------------------------------------------------------------
# Thin corpus — enough to count, not enough to generalise
# ---------------------------------------------------------------------------

def test_discovery_lag_withholds_a_median_below_the_threshold(conn):
    """Three papers must not produce a confident median."""
    for i in range(3):
        _doc(conn, source="arxiv", ext=f"a{i}", title=f"Paper {i}",
             pub="2026-01-01", seen="2026-01-03 00:00:00")

    result = analytics.discovery_lag(conn)
    arxiv = next(s for s in result["sources"] if s["source"] == "arxiv")

    assert arxiv["sample_size"] == 3
    assert arxiv["sufficient"] is False
    assert arxiv["median_days"] is None, "a median of three points is not a finding"
    assert result["minimum_sample"] == analytics.MIN_SAMPLE_FOR_LAG
    assert result["insufficient_reason"]


def test_discovery_lag_reports_once_there_is_enough_data(conn):
    for i in range(analytics.MIN_SAMPLE_FOR_LAG):
        _doc(conn, source="arxiv", ext=f"a{i}", title=f"Paper {i}",
             pub="2026-01-01", seen="2026-01-03 00:00:00")

    result = analytics.discovery_lag(conn)
    arxiv = next(s for s in result["sources"] if s["source"] == "arxiv")

    assert arxiv["sufficient"] is True
    assert arxiv["median_days"] == pytest.approx(2.0, abs=0.1)
    assert result["sufficient"] is True


def test_source_contribution_needs_two_sources_to_mean_anything(conn):
    _doc(conn, source="arxiv", ext="only", title="Sole paper")
    result = analytics.source_contribution(conn)

    # The count is still reported...
    assert result["sources"][0]["total"] == 1
    # ...but "overlap" with nothing to overlap is not a claim worth making.
    assert result["sufficient"] is False
    assert "two sources" in result["insufficient_reason"]


# ---------------------------------------------------------------------------
# The real questions
# ---------------------------------------------------------------------------

def test_source_contribution_separates_unique_from_duplicated(conn):
    """A paper arriving from two sources is unique to neither."""
    _doc(conn, source="arxiv", ext="1", title="Shared paper", doi="10.1/shared")
    _doc(conn, source="openalex", ext="9", title="Shared paper", doi="10.1/shared")
    _doc(conn, source="arxiv", ext="2", title="Only on arXiv", doi="10.1/solo")

    by_source = {s["source"]: s for s in analytics.source_contribution(conn)["sources"]}

    assert by_source["arxiv"]["total"] == 2
    assert by_source["arxiv"]["unique_papers"] == 1
    assert by_source["arxiv"]["duplicated"] == 1
    assert by_source["openalex"]["total"] == 1
    assert by_source["openalex"]["unique_papers"] == 0, (
        "openalex supplied nothing arxiv had not already delivered"
    )


def test_papers_without_a_doi_are_matched_on_title(conn):
    _doc(conn, source="arxiv", ext="1", title="  Same Title  ", doi=None)
    _doc(conn, source="biorxiv", ext="2", title="same title", doi=None)

    by_source = {s["source"]: s for s in analytics.source_contribution(conn)["sources"]}
    assert by_source["arxiv"]["unique_papers"] == 0
    assert by_source["biorxiv"]["unique_papers"] == 0


def test_routine_health_flags_a_routine_that_has_gone_quiet(conn):
    conn.execute(
        "INSERT INTO routines (name, schedule_cron, parameters, is_active) "
        "VALUES ('Quiet routine', '0 8 * * *', '{}', 1)"
    )
    routine_id = conn.execute("SELECT id FROM routines").fetchone()["id"]

    # One productive run, then four that found nothing.
    for i, new_count in enumerate([7, 0, 0, 0, 0]):
        exec_id = insert_execution(conn, {
            "execution_type": "automated_sweep", "routine_id": routine_id,
            "parameters": "{}", "start_time": f"2026-02-0{i + 1}T08:00:00",
        })
        update_execution_status(conn, exec_id, "completed",
                                result_count=10, new_result_count=new_count)

    routine = analytics.routine_health(conn)["routines"][0]

    assert routine["runs"] == 5
    assert routine["runs_since_new"] == 4
    assert routine["status"] == "stale"
    assert routine["total_new"] == 7
    assert routine["last_new_result_at"] == "2026-02-01T08:00:00"


def test_routine_health_will_not_judge_a_routine_with_too_few_runs(conn):
    conn.execute(
        "INSERT INTO routines (name, schedule_cron, parameters, is_active) "
        "VALUES ('New routine', '0 8 * * *', '{}', 1)"
    )
    routine_id = conn.execute("SELECT id FROM routines").fetchone()["id"]

    exec_id = insert_execution(conn, {
        "execution_type": "automated_sweep", "routine_id": routine_id,
        "parameters": "{}", "start_time": "2026-02-01T08:00:00",
    })
    update_execution_status(conn, exec_id, "completed", result_count=3, new_result_count=0)

    routine = analytics.routine_health(conn)["routines"][0]
    assert routine["runs"] == 1
    assert routine["status"] == "insufficient_data", (
        "one barren run is not evidence a routine is finished"
    )
    assert routine["sufficient"] is False


def test_publication_volume_groups_by_source_and_by_category(conn):
    _doc(conn, source="arxiv", ext="1", title="A", pub="2026-01-05", categories="cs.LG, stat.ML")
    _doc(conn, source="arxiv", ext="2", title="B", pub="2026-01-20", categories="cs.LG")
    _doc(conn, source="pubmed", ext="3", title="C", pub="2026-02-11", categories="q-bio")

    by_source = analytics.publication_volume(conn, group_by="source")
    months = {b["month"]: b for b in by_source["series"]}
    assert months["2026-01"]["groups"]["arxiv"] == 2
    assert months["2026-02"]["groups"]["pubmed"] == 1

    by_category = analytics.publication_volume(conn, group_by="category")
    jan = next(b for b in by_category["series"] if b["month"] == "2026-01")
    # A paper in two categories counts once in each -- that is the point.
    assert jan["groups"]["cs.LG"] == 2
    assert jan["groups"]["stat.ML"] == 1


def test_publication_volume_rejects_an_unknown_grouping(conn):
    with pytest.raises(ValueError):
        analytics.publication_volume(conn, group_by="nonsense")


def test_documents_without_a_publication_date_are_excluded_not_guessed(conn):
    _doc(conn, source="arxiv", ext="1", title="Dated", pub="2026-01-05")
    _doc(conn, source="arxiv", ext="2", title="Undated", pub=None)

    volume = analytics.publication_volume(conn, group_by="source")
    assert volume["sample_size"] == 1, "an undated paper must not be placed on the timeline"
    assert analytics.corpus_summary(conn)["documents"] == 2, "but it is still in the corpus"


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------

def test_bibtex_escapes_and_keys(conn):
    text = reference_export.to_bibtex([{
        "title": "Costs & Benefits_Revisited", "authors": "Ada Lovelace, Alan Turing",
        "publication_date": "2026-03-14", "doi": "10.1/x", "url": "https://e.org/a_b",
        "source_repository": "arxiv", "categories": "cs.LG", "abstract": "One\ntwo.",
    }])
    assert text.startswith("@article{lovelace2026costs,")
    assert r"Costs \& Benefits\_Revisited" in text
    assert r"https://e.org/a\_b" in text
    assert "author = {Ada Lovelace and Alan Turing}" in text
    assert "One two." in text, "the abstract should be collapsed to one line"


def test_bibtex_keys_are_unique_within_a_file(conn):
    doc = {"title": "Same Paper Title", "authors": "Ada Lovelace",
           "publication_date": "2026-01-01"}
    text = reference_export.to_bibtex([dict(doc), dict(doc), dict(doc)])
    keys = [line.split("{")[1].rstrip(",") for line in text.splitlines() if line.startswith("@")]
    assert len(keys) == len(set(keys)) == 3, f"duplicate cite keys: {keys}"


def test_entry_type_reflects_whether_a_doi_exists(conn):
    with_doi = reference_export.to_bibtex([{"title": "T", "doi": "10.1/x"}])
    without = reference_export.to_bibtex([{"title": "T"}])
    assert with_doi.startswith("@article")
    assert without.startswith("@misc")


def test_ris_is_line_oriented_and_terminated(conn):
    text = reference_export.to_ris([{
        "title": "T", "authors": "Ada Lovelace, Alan Turing",
        "publication_date": "2026-03-14", "doi": "10.1/x", "categories": "cs.LG, stat.ML",
        "abstract": "Wrapped\nabstract.", "source_repository": "arxiv",
    }])
    assert text.startswith("TY  - JOUR")
    assert text.count("AU  - ") == 2
    assert text.count("KW  - ") == 2
    assert "DA  - 2026/03/14" in text
    assert "AB  - Wrapped abstract." in text, "newlines would break RIS parsers"
    assert "ER  - " in text


def test_csv_collapses_whitespace_so_rows_do_not_split(conn):
    text = reference_export.to_csv([{"title": "T", "abstract": "line\nbreak\there"}])
    assert "line break here" in text
    assert len([ln for ln in text.strip().splitlines()]) == 2


def test_render_rejects_an_unknown_format(conn):
    with pytest.raises(ValueError) as exc:
        reference_export.render([], "endnote")
    assert "bibtex" in str(exc.value), "the error should name the valid formats"


def test_execution_document_helpers(conn):
    exec_id = insert_execution(conn, {
        "execution_type": "deep_dive", "parameters": "{}",
        "start_time": "2026-02-01T08:00:00",
    })
    new_id = _doc(conn, source="arxiv", ext="1", title="Fresh")
    old_id = _doc(conn, source="arxiv", ext="2", title="Already known")
    link_execution_document(conn, exec_id, new_id, is_new=True)
    link_execution_document(conn, exec_id, old_id, is_new=False)

    assert len(get_execution_documents(conn, exec_id)) == 2
    only_new = get_execution_documents(conn, exec_id, only_new=True)
    assert [d["title"] for d in only_new] == ["Fresh"]

    assert [d["id"] for d in get_documents_by_ids(conn, [new_id])] == [new_id]
    assert get_documents_by_ids(conn, []) == []
