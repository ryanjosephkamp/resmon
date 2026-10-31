# resmon_scripts/verification_scripts/test_what_sources_were_sent.py
"""A run records what each source was sent, and its log says what each one did.

The words a person types are not the query a source receives. arXiv is sent
each word as its own ``all:`` term joined with AND, with a submission-date
clause; Crossref gets ``query`` and a ``filter``; DBLP is sent nothing at all
for a window shorter than a calendar year. The search record used to put the
typed words under "Query as sent", and the run's log said ``dblp: 0 results``
beside the sentence explaining that DBLP could not answer. These cases drive
real clients through the real ``safe_request`` over a transport that answers
locally, and hold:

  * each request that goes out is recorded as its client describes it, with no
    paging, contact address, or key in it, and pages of one query are one entry;
  * a source asked nothing is recorded as asked nothing, and a client that does
    not describe its requests is recorded as not saying, never as the words;
  * the log gives a zero the words its coverage gives it, so a source that did
    not answer is never logged as having returned 0 results.

What this does not establish: anything about a real upstream.
"""

from __future__ import annotations

import json
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
    config,
    search_record,
    sweep_engine as se,
)
from implementation_scripts.api_registry import get_client  # noqa: E402
from implementation_scripts.database import get_execution_by_id, init_db  # noqa: E402
from implementation_scripts.progress import progress_store  # noqa: E402
from implementation_scripts.sweep_engine import SweepEngine  # noqa: E402


@pytest.fixture(autouse=True)
def reports_elsewhere(monkeypatch, tmp_path):
    """Each run's log and report go to this test's own folder, not the checkout."""
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
    monkeypatch.setattr(api_crossref, "_RATE_LIMITER", api_base.RateLimiter(1000))


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


@pytest.fixture
def answers(monkeypatch):
    """Every request answered here: Crossref with one page of two records, then none."""
    requests: list[tuple[str, dict]] = []

    def request(_self, method, url, **kwargs):
        params = dict(kwargs.get("params") or {})
        requests.append((url, params))
        items = [] if int(params.get("offset") or 0) else [
            {"DOI": f"10.1000/sent.{n}", "title": [f"A record {n}"],
             "author": [{"given": "Ada", "family": "Lovelace"}],
             "issued": {"date-parts": [[2026, 10, 2]]}}
            for n in range(2)]
        return httpx.Response(200, json={"message": {"items": items}},
                              request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.Client, "request", request)
    return requests


def _sweep(conn, sources, **params) -> dict:
    engine = SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution("deep_sweep", list(sources), {
        "query": "agent", "keywords": ["agent"], "max_results": 2, **params})
    progress_store.register(exec_id)
    result = engine.run_prepared(exec_id)
    row = get_execution_by_id(conn, exec_id)
    return {"exec_id": exec_id, "result": result,
            "params": json.loads(row["parameters"]),
            "log": Path(result["log_path"]).read_text(encoding="utf-8")}


def test_each_source_is_recorded_with_the_query_its_requests_carried(conn, answers):
    run = _sweep(conn, ["crossref", "dblp"], date_from="2026-10-01", date_to="2026-10-31")

    sent = run["params"]["queries_sent"]
    # One entry for the query, however many pages it took; the address resmon
    # gives Crossref's polite pool, and the paging, are not part of it.
    assert sent["crossref"] == {
        "sent": ["query=agent & filter=from-pub-date:2026-10-01,until-pub-date:2026-10-31"]}
    assert len(answers) == 1
    assert "mailto" not in json.dumps(sent)
    # DBLP dates papers only to the year, and a window inside one year is not
    # asked at all: nothing was sent, which is a fact rather than a gap.
    assert sent["dblp"] == {"sent": []}

    record = search_record.build(conn, run["exec_id"])["search"]
    rows = {row["source"]: row for row in record["queries_as_sent"]}
    assert rows["crossref"]["sent"] == sent["crossref"]["sent"]
    assert rows["dblp"]["note"] == "Nothing was sent: could not answer this window."
    # The one-line field keeps what it always held, the terms as typed, and the
    # record's Markdown never puts them under "Query as sent".
    assert record["query_as_sent"] == "agent"
    text = search_record.to_markdown(search_record.build(conn, run["exec_id"]))
    assert "| Query as sent to CrossRef | `query=agent & filter=from-pub-date:2026-10-01," in text
    assert "| Query as sent | `agent` |" not in text


def test_a_client_that_does_not_describe_its_requests_is_recorded_as_not_saying(
        conn, answers, monkeypatch):
    real = get_client

    def undescribed(name, **kwargs):
        client = real(name, **kwargs)
        client.describe_request = None
        return client

    monkeypatch.setattr(se, "get_client", undescribed)
    run = _sweep(conn, ["crossref"], date_from="2026-10-01", date_to="2026-10-31")

    assert run["params"]["queries_sent"] == {"crossref": None}
    row = search_record.build(conn, run["exec_id"])["search"]["queries_as_sent"][0]
    assert row["sent"] == []
    assert row["note"] == "Not recorded: this source's client does not say what its requests carry."


def test_a_restart_records_its_own_queries_rather_than_its_original_runs(conn, answers):
    first = _sweep(conn, ["crossref"], date_from="2026-10-01", date_to="2026-10-31")
    copied = dict(first["params"])
    copied["queries_sent"] = {"crossref": {"sent": ["query=stale"]}}
    engine = SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution("deep_sweep", ["crossref"], copied)
    progress_store.register(exec_id)
    engine.run_prepared(exec_id)

    params = json.loads(get_execution_by_id(conn, exec_id)["parameters"])
    assert params["queries_sent"]["crossref"]["sent"] != ["query=stale"]


def test_the_log_gives_a_zero_the_words_its_coverage_gives_it(conn, answers, monkeypatch):
    """``dblp: 0 results`` stood beside "cannot be answered"; a source that did
    not answer is never logged with a count it did not return."""
    run = _sweep(conn, ["crossref", "dblp"], date_from="2026-10-01", date_to="2026-10-31")
    lines = [line.split("] ", 1)[-1] for line in run["log"].splitlines()]

    assert "  crossref: 2 results" in lines
    assert "  dblp: could not answer this window" in lines
    assert "  dblp: 0 results" not in lines
    # The sentence that explains it still follows.
    explained = lines.index("  dblp: could not answer this window") + 1
    assert lines[explained].startswith("    DBLP filters by publication year only")

    def nothing(_self, method, url, **kwargs):
        return httpx.Response(200, json={"message": {"items": []}},
                              request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.Client, "request", nothing)
    empty = _sweep(conn, ["crossref"], date_from="2026-10-01", date_to="2026-10-31")
    lines = [line.split("] ", 1)[-1] for line in empty["log"].splitlines()]
    assert "  crossref: answered, zero" in lines


def test_every_source_resmon_asks_describes_its_requests_without_keys_or_addresses():
    """Every client a run can ask says what its requests carry, and nothing it
    says can hold a key or the contact address some sources are sent."""
    from implementation_scripts.api_registry import _REGISTRY, RETIRED_REPOSITORIES

    secrets = {"api_key": "SECRET", "apiKey": "SECRET", "key": "SECRET", "token": "SECRET",
               "access_token": "SECRET", "mailto": "me@example.org", "email": "me@example.org"}
    asked = {"q": "agent", "query": "agent", "search": "agent", "term": "agent",
             "search_query": "all:agent", "keywords": "agent", "searchphrase": "agent"}
    for slug, cls in sorted(_REGISTRY.items()):
        if slug in RETIRED_REPOSITORIES:
            continue
        describe = cls.describe_request
        assert callable(describe), f"{slug} does not describe its requests"
        module = sys.modules[cls.__module__]
        urls = [value for name, value in vars(module).items()
                if isinstance(value, str) and value.startswith("https://")
                and (name.endswith("_URL") or name.endswith("_BASE"))]
        said = [describe(f"{url}/{slug}/2026-01-01/2026-02-01/0", {**secrets, **asked}, None)
                for url in urls]
        said += [describe(url, {**secrets, **asked}, None) for url in urls]
        said += [describe(url, None, {**secrets, **asked}) for url in urls]
        said = [text for text in said if text]
        assert said, f"{slug} described none of its requests"
        for text in said:
            assert "SECRET" not in text and "example.org" not in text, (slug, text)
