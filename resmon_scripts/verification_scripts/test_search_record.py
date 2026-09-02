"""The reproducible search record: the numbers, and what they do not mean.

A methods section built on a mislabelled figure is worse than no record at all,
because a reviewer will publish it. So most of this suite is about labeling
rather than arithmetic.

Three things resmon must never let the record imply:

1. That it *removed* cross-source duplicates. It flags them and keeps both.
2. That "already held from an earlier run" belongs in a PRISMA flow diagram. It
   is an artefact of monitoring over time and has no box.
3. That a figure it never measured was measured and came out zero.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import search_record  # noqa: E402
from implementation_scripts.config import APP_VERSION  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    init_db,
    insert_execution,
    insert_routine,
    record_execution_source,
    update_execution_status,
)


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_db(conn=c)
    yield c
    c.close()


def _run(
    conn,
    *,
    keywords=("cardiac", "transformer"),
    sources=None,
    dedup=None,
    routine_id=None,
    date_from="2026-01-01",
    date_to="2026-06-30",
):
    exec_id = insert_execution(conn, {
        "execution_type": "deep_sweep",
        "routine_id": routine_id,
        "parameters": json.dumps({
            "query": " ".join(keywords),
            "keywords": list(keywords),
            "date_from": date_from,
            "date_to": date_to,
            "max_results": 100,
            "repositories": list((sources or {}).keys()),
        }),
        "start_time": "2026-07-01T09:00:00Z",
        "status": "running",
    })
    for source, outcome in (sources or {}).items():
        record_execution_source(
            conn, exec_id, source, outcome.get("status", "ok"),
            result_count=outcome.get("result_count", 0),
            error_message=outcome.get("error_message"),
            credential_name=outcome.get("credential_name"),
        )
    if dedup is not None:
        conn.execute(
            """
            UPDATE executions SET dedup_total = ?, dedup_new = ?,
                dedup_duplicates = ?, dedup_invalid = ?, dedup_cross_source = ?
            WHERE id = ?
            """,
            (dedup.get("total"), dedup.get("new"), dedup.get("duplicates"),
             dedup.get("invalid"), dedup.get("cross_source"), exec_id),
        )
        conn.commit()
    update_execution_status(conn, exec_id, "completed",
                            end_time="2026-07-01T09:04:00Z")
    return exec_id


FULL_SOURCES = {
    "arxiv": {"status": "ok", "result_count": 120},
    "pubmed": {"status": "ok", "result_count": 64},
    "nasa_ads": {"status": "skipped_missing_key",
                 "credential_name": "nasa_ads_api_key"},
    "core": {"status": "error", "error_message": "HTTP 503"},
}

FULL_DEDUP = {"total": 184, "new": 150, "duplicates": 22, "invalid": 4,
              "cross_source": 8}


# ---------------------------------------------------------------------------
# Identification
# ---------------------------------------------------------------------------


def test_per_source_counts_come_straight_from_the_run(conn):
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    record = search_record.build(conn, exec_id)

    counts = {s["source"]: s["records_identified"] for s in record["sources"]}
    assert counts == {"arxiv": 120, "pubmed": 64, "nasa_ads": 0, "core": 0}
    assert record["identification"]["records_identified"] == 184
    assert record["identification"]["prisma"] == "Records identified from databases"


def test_a_source_that_contributed_nothing_is_still_in_the_record(conn):
    """A strategy listing a database as searched, when its key was missing and
    it returned nothing every time, overstates its coverage."""
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    record = search_record.build(conn, exec_id)

    ads = next(s for s in record["sources"] if s["source"] == "nasa_ads")
    assert ads["status"] == "skipped_missing_key"
    assert "did not contribute" in ads["note"]

    core = next(s for s in record["sources"] if s["source"] == "core")
    assert "HTTP 503" in core["note"]

    assert record["identification"]["sources_searched"] == 4
    assert record["identification"]["sources_that_answered"] == 2


def test_unproductive_sources_raise_a_caveat_about_overstating_coverage(conn):
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    record = search_record.build(conn, exec_id)

    assert any("overstating its coverage" in c for c in record["caveats"])


# ---------------------------------------------------------------------------
# The labeling — the part that matters
# ---------------------------------------------------------------------------


def test_duplicates_are_reported_as_found_not_as_removed(conn):
    """resmon keeps both copies. A record saying "removed" would describe an
    operation that never happened, and the reviewer would report it."""
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    block = search_record.build(conn, exec_id)["deduplication"]

    cross = block["cross_source_duplicates"]
    assert cross["count"] == 8
    assert cross["prisma"] == "Duplicate records removed before screening"
    assert "does not remove either" in cross["meaning"]
    assert "not of duplicates deleted" in cross["meaning"]


def test_already_held_records_are_given_no_prisma_box(conn):
    """PRISMA describes a single search. Re-encountering what a weekly routine
    already found is not a step in one."""
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    block = search_record.build(conn, exec_id)["deduplication"]

    assert block["already_held"]["count"] == 22
    assert block["already_held"]["prisma"] is None
    assert "no equivalent in a PRISMA flow diagram" in block["already_held"]["meaning"]


def test_discarded_records_are_a_data_quality_discard_not_a_relevance_call(conn):
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    block = search_record.build(conn, exec_id)["deduplication"]

    assert block["discarded_unusable"]["count"] == 4
    assert "not a relevance judgement" in block["discarded_unusable"]["meaning"]


def test_an_unmeasured_figure_is_reported_absent_not_zero(conn):
    """"0 duplicate records removed" reads as a measurement. On a run that
    predates the column it would be a fabricated one."""
    exec_id = _run(conn, sources=FULL_SOURCES,
                   dedup={"total": 184, "new": 150, "duplicates": 22,
                          "invalid": 4, "cross_source": None})
    record = search_record.build(conn, exec_id)
    cross = record["deduplication"]["cross_source_duplicates"]

    assert cross["count"] is None
    assert cross["recorded"] is False
    assert "Not recorded is not zero" in cross["not_recorded_reason"]
    assert any("absent, not zero" in c for c in record["caveats"])


def test_a_measured_zero_is_not_confused_with_an_absent_figure(conn):
    exec_id = _run(conn, sources=FULL_SOURCES,
                   dedup={**FULL_DEDUP, "cross_source": 0})
    cross = search_record.build(conn, exec_id)["deduplication"]["cross_source_duplicates"]

    assert cross["count"] == 0
    assert cross["recorded"] is True
    assert cross["not_recorded_reason"] is None


def test_the_record_disclaims_screening_entirely(conn):
    """Shipping the search log; not chasing Covidence. The record must not be
    mistakable for a screening outcome."""
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    caveats = search_record.build(conn, exec_id)["caveats"]

    assert any("does not record screening decisions" in c for c in caveats)


def test_the_record_says_it_covers_one_execution_only(conn):
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    caveats = search_record.build(conn, exec_id)["caveats"]
    assert any("one execution" in c for c in caveats)


# ---------------------------------------------------------------------------
# Provenance
# ---------------------------------------------------------------------------


def test_the_software_version_that_ran_the_search_is_recorded(conn):
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    record = search_record.build(conn, exec_id)

    assert record["software"]["version"] == APP_VERSION
    assert APP_VERSION in record["software"]["citation"]


def test_the_exact_query_and_window_are_preserved(conn):
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    search = search_record.build(conn, exec_id)["search"]

    assert search["keywords"] == ["cardiac", "transformer"]
    assert search["query_as_sent"] == "cardiac transformer"
    assert search["date_from"] == "2026-01-01"
    assert search["date_to"] == "2026-06-30"
    assert search["max_results_per_source"] == 100
    assert search["run_at"] == "2026-07-01T09:00:00Z"


def test_a_routine_run_names_the_routine_and_its_schedule(conn):
    routine_id = insert_routine(conn, {
        "name": "Weekly cardiac", "schedule_cron": "0 6 * * 1",
        "parameters": json.dumps({"query": "x", "repositories": ["arxiv"]}),
        "is_active": 1,
    })
    exec_id = _run(conn, sources={"arxiv": {"status": "ok", "result_count": 5}},
                   dedup=FULL_DEDUP, routine_id=routine_id)
    search = search_record.build(conn, exec_id)["search"]

    assert search["routine_name"] == "Weekly cardiac"
    assert search["routine_schedule"] == "0 6 * * 1"


def test_a_missing_execution_raises_rather_than_producing_an_empty_record(conn):
    with pytest.raises(LookupError):
        search_record.build(conn, 9999)


def test_a_run_with_no_sources_recorded_still_produces_a_record(conn):
    """History from before execution_sources existed. Zero identified is
    honest; inventing counts would not be."""
    exec_id = _run(conn, sources={}, dedup=None)
    record = search_record.build(conn, exec_id)

    assert record["identification"]["records_identified"] == 0
    assert record["sources"] == []
    assert record["deduplication"]["records_processed"] is None


# ---------------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------------


def test_the_markdown_keeps_absent_and_zero_visibly_different(conn):
    exec_id = _run(conn, sources=FULL_SOURCES,
                   dedup={**FULL_DEDUP, "cross_source": None})
    text = search_record.to_markdown(search_record.build(conn, exec_id))

    assert "not recorded" in text
    # And the reason travels with it, in the same document.
    assert "Not recorded is not zero" in text


def test_the_markdown_names_the_prisma_boxes(conn):
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    text = search_record.to_markdown(search_record.build(conn, exec_id))

    assert "Records identified from databases" in text
    assert "Duplicate records removed before screening" in text
    assert "Records marked as ineligible by automation tools" in text
    assert "*no PRISMA equivalent*" in text


def test_the_caveats_cannot_be_separated_from_the_numbers(conn):
    """They are in the same document, under a heading a reader will not skip."""
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    text = search_record.to_markdown(search_record.build(conn, exec_id))

    assert "## What these numbers do not mean" in text
    assert "keeps both" in text


def test_every_source_appears_in_the_markdown_table(conn):
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    text = search_record.to_markdown(search_record.build(conn, exec_id))

    for source in FULL_SOURCES:
        assert source in text
    assert "| **Total** | **184** |" in text


def test_the_markdown_cites_the_software_version(conn):
    exec_id = _run(conn, sources=FULL_SOURCES, dedup=FULL_DEDUP)
    text = search_record.to_markdown(search_record.build(conn, exec_id))
    assert APP_VERSION in text


# ---------------------------------------------------------------------------
# Persistence of the figures themselves
# ---------------------------------------------------------------------------


def test_a_real_sweep_records_its_deduplication_figures(monkeypatch):
    """They were computed on every run since the beginning and thrown away into
    the progress-events blob. A report format cannot be built on that."""
    from implementation_scripts import sweep_engine as se
    from implementation_scripts import credential_manager as cm
    from implementation_scripts.api_base import BaseAPIClient, NormalizedResult

    class _OneResult(BaseAPIClient):
        def get_name(self):
            return "arxiv"

        def search(self, query, date_from=None, date_to=None, max_results=100, **kw):
            return [NormalizedResult(
                source_repository="arxiv", external_id="2601.00001v1", doi=None,
                title="A paper about hearts", authors=["A. Author"],
                abstract="An abstract.", publication_date="2026-01-02",
                url="https://arxiv.org/abs/2601.00001v1", categories=["q-bio"],
            )]

    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_db(conn=c)
    monkeypatch.setattr(se, "get_client", lambda _n: _OneResult())
    monkeypatch.setattr(cm, "get_credential", lambda _n: None)

    engine = se.SweepEngine(db_conn=c, config={})
    result = engine.execute_dive("arxiv", {"query": "hearts", "max_results": 1})

    row = c.execute(
        "SELECT dedup_total, dedup_new, dedup_cross_source FROM executions "
        "WHERE id = ?", (result["execution_id"],),
    ).fetchone()
    assert row["dedup_total"] == 1
    assert row["dedup_new"] == 1
    # Measured, and now actually kept.
    assert row["dedup_cross_source"] == 0
    c.close()


def test_history_is_backfilled_from_stored_progress_events(conn):
    """Runs from before the columns existed still carry four of the five
    figures in their events blob."""
    exec_id = insert_execution(conn, {
        "execution_type": "deep_sweep", "routine_id": None,
        "parameters": "{}", "start_time": "2026-01-01T00:00:00Z",
        "status": "completed",
    })
    conn.execute(
        "UPDATE executions SET progress_events = ? WHERE id = ?",
        (json.dumps([{"type": "dedup_stats", "total": 90, "new": 70,
                      "duplicates": 15, "invalid": 5}]), exec_id),
    )
    conn.execute("DELETE FROM app_settings WHERE key = 'dedup_columns_backfilled'")
    conn.commit()

    init_db(conn=conn)

    record = search_record.build(conn, exec_id)
    dedup = record["deduplication"]
    assert dedup["records_processed"] == 90
    assert dedup["records_added"]["count"] == 70
    # The fifth was never emitted, so it stays absent rather than becoming 0.
    assert dedup["cross_source_duplicates"]["count"] is None


# ---------------------------------------------------------------------------
# The endpoint
# ---------------------------------------------------------------------------


def _client():
    import resmon as resmon_mod
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from fastapi.testclient import TestClient
    from resmon import app
    return TestClient(app), resmon_mod


def test_the_endpoint_returns_json_by_default():
    client, resmon_mod = _client()
    db = resmon_mod._get_db()
    exec_id = _run(db, sources=FULL_SOURCES, dedup=FULL_DEDUP)

    body = client.get(f"/api/executions/{exec_id}/search-record").json()
    assert body["record_type"] == "resmon_search_record"
    assert body["identification"]["records_identified"] == 184


def test_the_endpoint_serves_markdown_as_a_download():
    client, resmon_mod = _client()
    db = resmon_mod._get_db()
    exec_id = _run(db, sources=FULL_SOURCES, dedup=FULL_DEDUP)

    response = client.get(
        f"/api/executions/{exec_id}/search-record?format=markdown")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/markdown")
    assert "attachment" in response.headers["content-disposition"]
    assert "# Search record" in response.text


def test_an_unknown_format_is_rejected():
    client, _ = _client()
    assert client.get(
        "/api/executions/1/search-record?format=pdf").status_code == 400


def test_an_unknown_execution_404s():
    client, _ = _client()
    assert client.get(
        "/api/executions/424242/search-record").status_code == 404
