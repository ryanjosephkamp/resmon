"""A sweep that no source answered is a failure, even though nothing raised.

From the 2026-10-18 engine audit. ``final_status`` was ``failed`` only when
every repository raised an exception -- and almost no client raises. A source
that answers 4xx or 5xx is logged and broken out of, so it never reaches
``repo_errors``: a sweep in which **every** source answered 503 had
``repo_errors == []`` and finished ``completed`` with ``result_count = 0``.
The monitor was broken and the top line said it was fine.

The question "did any source answer?" belongs to ``source_coverage``, which
already answers it carefully, so the engine asks it there rather than counting
exceptions a second time. These cases are about the boundaries of that
question, because most of them are places where ``failed`` would be the *other*
overclaim:

* a source whose outcome resmon never recorded is **unknown**, and unknown is
  not evidence that anything failed;
* a source resmon never asked -- no API key, retired, no author query, a window
  it filters too coarsely -- did not fail either, and the missing-key case is
  already a settled contract (``test_missing_required_key_report.py``);
* a run that selected no sources at all is a real, reachable case: a
  ``retractions`` watch routine reads the corpus and queries nothing
  (``resmon.py:5272``). Nothing failed there, because nothing was asked.

Only a source that was asked and did not answer counts, and this PR only
decides the all-or-nothing case. A run where 26 of 27 failed is still
``completed``; grading that is the ``partial`` status, which needs a CHECK
migration and is not here.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import (  # noqa: E402
    api_base,
    api_crossref,
    api_doaj,
    api_openalex,
    config,
    credential_manager as cm,
    sweep_engine as se,
)
from implementation_scripts.api_base import BaseAPIClient  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    get_execution_by_id,
    get_execution_sources,
    init_db,
)
from implementation_scripts.sweep_engine import SweepEngine  # noqa: E402

#: Three real clients that need no credential and use the synchronous
#: transport. Driving the real ones is the point: a stub that returns ``[]``
#: never touches ``safe_request``, so it records "not recorded" and exercises
#: the unknown branch rather than the failure branch.
_SOURCES = ["crossref", "doaj", "openalex"]


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    init_db(conn=connection)
    yield connection
    connection.close()


@pytest.fixture(autouse=True)
def fast_and_isolated(monkeypatch):
    api_base.reset_search_outcome()
    for module in (api_crossref, api_doaj, api_openalex):
        monkeypatch.setattr(module, "_RATE_LIMITER", api_base.RateLimiter(1000))
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
    yield
    api_base.reset_search_outcome()


@pytest.fixture
def transport(monkeypatch):
    """Answer every request with a status the client will not raise on."""
    seen: list[str] = []
    reply = {"status": 503, "body": b""}

    def request(_self, method, url, **kwargs):
        seen.append(url)
        built = httpx.Request(method, url)
        body = reply["body"]
        if isinstance(body, (bytes, str)):
            return httpx.Response(reply["status"], content=body, request=built)
        return httpx.Response(reply["status"], json=body, request=built)

    monkeypatch.setattr(httpx.Client, "request", request)
    return seen, reply


def _sweep(conn, sources, **params):
    engine = SweepEngine(db_conn=conn, config={})
    merged = {"query": "cancer", "max_results": 5, **params}
    return engine.execute_sweep(list(sources), merged)


def _row(conn, result) -> dict:
    return get_execution_by_id(conn, result["execution_id"])


def test_a_sweep_every_source_answered_503_is_failed(conn, transport):
    """The audit's worst example, driven end to end.

    Nothing raises -- each client logs the status and breaks -- so
    ``repo_errors`` is empty and the old rule could never fire. The recorded
    per-source rows say what actually happened, and that is what decides the
    status now.
    """
    seen, _ = transport
    result = _sweep(conn, _SOURCES)
    row = _row(conn, result)

    assert seen, "the clients must actually have issued requests"
    assert row["status"] == "failed"
    assert row["result_count"] == 0

    sources = get_execution_sources(conn, result["execution_id"])
    assert len(sources) == len(_SOURCES)
    # The distinguishing fact: not one source raised, so the pre-existing
    # all-repos-errored route is not what produced this verdict.
    assert [s["status"] for s in sources] == ["ok"] * len(_SOURCES)
    assert {s["zero_reason"] for s in sources} == {"upstream_failure"}
    assert row["error_message"], "a failed run has to say why"


def test_one_source_answering_keeps_the_run_completed(conn, monkeypatch):
    """This PR decides the all-or-nothing case and nothing finer.

    Two of three failing is the graded case, and grading it is the ``partial``
    status, which needs a CHECK migration the schema does not have yet.
    """
    def respond(_self, method, url, **kwargs):
        built = httpx.Request(method, url)
        if "openalex" in url:
            return httpx.Response(200, request=built, json={"results": [{
                "id": "https://openalex.org/W1", "display_name": "A paper",
                "authorships": [], "publication_date": "2024-01-02", "doi": None}]})
        return httpx.Response(503, content=b"", request=built)

    monkeypatch.setattr(httpx.Client, "request", respond)
    result = _sweep(conn, _SOURCES)
    row = _row(conn, result)

    assert row["status"] == "completed"
    assert row["result_count"] == 1


def test_a_run_that_selected_no_sources_is_not_a_failure(conn, transport):
    """A ``retractions`` watch routine queries nothing, on purpose.

    ``resmon.py:5272`` empties the repository list for that mode so the
    Monitor does not announce sources it never touches. Zero sources answered
    because zero were asked, and reading that as a broken monitor would be a
    fresh false alarm rather than a repaired one.
    """
    result = _sweep(conn, [])
    row = _row(conn, result)

    assert get_execution_sources(conn, result["execution_id"]) == []
    assert row["status"] == "completed"
    assert row["error_message"] is None


class _SilentClient(BaseAPIClient):
    """Returns nothing and never reaches the transport, so nothing is observed."""

    def get_name(self) -> str:
        return "doaj"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        return []


def test_an_unrecorded_zero_is_not_read_as_a_failure(conn, monkeypatch):
    """Unknown is not evidence. It is the floor this vocabulary exists to hold.

    ``zero_reason`` refuses to call an unexplained zero an answer; it must
    equally refuse to call it a failure. Turning "resmon did not observe this"
    into "the monitor is broken" is the same fabrication pointing the other
    way.
    """
    monkeypatch.setattr(se, "get_client", lambda _name: _SilentClient())
    result = _sweep(conn, ["doaj"])
    row = _row(conn, result)

    sources = get_execution_sources(conn, result["execution_id"])
    assert [s["zero_reason"] for s in sources] == ["not_recorded"]
    assert row["status"] == "completed"


def test_a_source_that_was_never_asked_is_not_a_failure(conn, monkeypatch):
    """A missing API key is a configuration fact, not a broken source.

    ``test_missing_required_key_report.py`` settled this in 1.8.6 -- "never
    fail, solely because of a missing key" -- and the new route has to leave
    that contract alone. The same reading covers a retired source, a source
    with no author query, and a window the source filters too coarsely to
    answer: in none of them did resmon ask.
    """
    monkeypatch.setattr(cm, "get_credential", lambda _name: None)
    monkeypatch.setattr(se, "get_client", lambda _name: _SilentClient())
    result = _sweep(conn, ["core"])
    row = _row(conn, result)

    sources = get_execution_sources(conn, result["execution_id"])
    assert [s["status"] for s in sources] == ["skipped_missing_key"]
    assert row["status"] == "completed"


class _RaisingClient(BaseAPIClient):
    def get_name(self) -> str:
        return "doaj"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        raise RuntimeError("the client itself fell over")


def test_when_both_routes_fire_the_exception_text_is_what_is_kept(conn, monkeypatch):
    """Every source raised: both rules agree, and the older one is louder.

    The exception messages name what went wrong per source; the coverage
    summary only counts. When both hold, the more specific record wins and the
    verdict is the same either way.
    """
    monkeypatch.setattr(se, "get_client", lambda _name: _RaisingClient())
    result = _sweep(conn, ["doaj"])
    row = _row(conn, result)

    assert row["status"] == "failed"
    assert "the client itself fell over" in row["error_message"]
