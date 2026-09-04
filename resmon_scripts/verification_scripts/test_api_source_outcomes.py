# resmon_scripts/verification_scripts/test_api_source_outcomes.py
"""``source_outcomes`` on the executions routes.

The Results list shows "n of m sources could not answer" on the row the user
is already looking at. That summary has to come back with the executions
themselves — a second request per row for a page of fifty is not a design —
so both routes carry it, filled by one query for the whole page.

The counting rule is ``zero_reason.answered``, shared with the search record
so the row and the record cannot disagree about what "answered" means.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

import resmon as resmon_mod


@pytest.fixture
def client():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    with TestClient(resmon_mod.app) as c:
        yield c


def _seed(rows):
    conn = resmon_mod._get_db()
    conn.execute(
        """
        INSERT INTO executions (id, execution_type, status, start_time, parameters)
        VALUES (1, 'deep_dive', 'completed', '2026-09-01T00:00:00Z', '{}')
        """
    )
    for source, status, count, reason in rows:
        conn.execute(
            """
            INSERT INTO execution_sources
                (execution_id, source, status, result_count, zero_reason)
            VALUES (1, ?, ?, ?, ?)
            """,
            (source, status, count, reason),
        )
    conn.commit()


_ROWS = [
    ("arxiv", "ok", 12, None),                       # answered, with records
    ("core", "ok", 0, "answered_empty"),             # answered, nothing there
    ("crossref", "ok", 0, "upstream_failure"),       # never answered
    ("eric", "ok", 0, "window_unanswerable"),        # could not answer at all
    ("dblp", "ok", 0, "not_recorded"),               # nobody observed it
    ("springer", "skipped_missing_key", 0, "missing_key"),
]


def test_execution_route_summarises_which_sources_answered(client):
    _seed(_ROWS)

    outcomes = client.get("/api/executions/1").json()["source_outcomes"]

    assert outcomes["selected"] == 6
    # arXiv returned records; CORE answered and had nothing. Both answered.
    assert outcomes["answered"] == 2
    # CrossRef 503'd, ERIC cannot express the window, Springer had no key.
    assert outcomes["could_not_answer"] == 3
    assert outcomes["sources_that_could_not_answer"] == [
        "crossref", "eric", "springer",
    ]
    # DBLP's zero is unexplained, and that is neither of the above. Folding it
    # into either number would state something resmon did not observe.
    assert outcomes["not_recorded"] == 1


def test_the_list_route_carries_the_same_summary(client):
    _seed(_ROWS)

    row = client.get("/api/executions").json()[0]

    assert row["source_outcomes"]["could_not_answer"] == 3
    assert row["source_outcomes"]["answered"] == 2


def test_an_execution_with_no_source_rows_summarises_to_zero(client):
    _seed([])

    outcomes = client.get("/api/executions/1").json()["source_outcomes"]

    assert outcomes["selected"] == 0
    assert outcomes["could_not_answer"] == 0
