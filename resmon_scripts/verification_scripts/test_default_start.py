# resmon_scripts/verification_scripts/test_default_start.py
"""bioRxiv and medRxiv are never asked without a start date.

Each lists a date range oldest first and cannot be asked for words, so resmon
reads the range page by page for at most 45 seconds. Asked with no start, a
run read from the archive's first month (2013 for bioRxiv) and stopped at its
cap or its budget long before recent preprints: one term with "Any time"
failed after 45 seconds. A run that sets no start date (a watch saved with
none, MCP ``run_sweep``, the command line, the HTTP API) now asks them for the
catalog's ``default_start_days`` before the run, and these cases hold:

  * only those two sources are given a start; every other source in the same
    run is asked as before, with no dates;
  * the run's ``queries_sent`` carries the window bioRxiv was sent, its stored
    parameters keep the start and the sentence saying why under
    ``default_starts``, and its log and its report say it in the app's words;
  * a run with a start date, and a restart, record no start they did not give.

The cases drive the real client and engine over a transport that answers
locally. What this does not establish: anything about the real API. The
measurements behind the default are beside ``repo_catalog.DEFAULT_START_DAYS``.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import date
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import (  # noqa: E402
    api_base,
    api_biorxiv,
    api_crossref,
    config,
    sweep_engine as se,
)
from implementation_scripts.database import get_execution_by_id, init_db  # noqa: E402
from implementation_scripts.progress import progress_store  # noqa: E402
from implementation_scripts.repo_catalog import (  # noqa: E402
    DEFAULT_START_DAYS,
    REPOSITORY_CATALOG,
    catalog_as_dicts,
)
from implementation_scripts.sweep_engine import SweepEngine  # noqa: E402

WHY = ("because the run set no start date: resmon reads every preprint in a "
       "bioRxiv range itself, and bioRxiv's whole archive is far more than a "
       "search can read in 45 seconds.")


@pytest.fixture(autouse=True)
def quiet(monkeypatch, tmp_path):
    """Each run's log and report in this test's folder; today fixed; no waiting."""
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
    monkeypatch.setattr(api_crossref, "_RATE_LIMITER", api_base.RateLimiter(1000))
    monkeypatch.setattr(api_biorxiv, "_RATE_LIMITER", api_base.RateLimiter(1000))
    monkeypatch.setattr(api_biorxiv, "_local_today", lambda: date(2026, 10, 31))


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


@pytest.fixture
def answers(monkeypatch):
    """bioRxiv and medRxiv answer one matching preprint; Crossref one page of one record."""
    requests: list[tuple[str, dict]] = []

    def request(_self, method, url, **kwargs):
        params = dict(kwargs.get("params") or {})
        requests.append((str(url), params))
        if "api.biorxiv.org" in str(url):
            server = str(url).split("/details/", 1)[1].split("/", 1)[0]
            body = {"messages": [{"status": "ok", "total": 1, "count": 1}], "collection": [{
                "doi": f"10.1101/2026.10.29.{server}", "title": "An agent preprint",
                "authors": "Doe, Jane", "abstract": "About an agent.", "date": "2026-10-29",
                "category": "Bioinformatics"}]}
        else:
            items = [] if int(params.get("offset") or 0) else [{
                "DOI": "10.1000/start.1", "title": ["A record"],
                "author": [{"given": "Ada", "family": "Lovelace"}],
                "issued": {"date-parts": [[2026, 10, 2]]}}]
            body = {"message": {"items": items}}
        return httpx.Response(200, json=body, request=httpx.Request(method, url))

    async def request_async(self, method, url, **kwargs):
        # bioRxiv's requests carry a deadline, which ``safe_request`` keeps
        # through an async client.
        return request(self, method, url, **kwargs)

    monkeypatch.setattr(httpx.Client, "request", request)
    monkeypatch.setattr(httpx.AsyncClient, "request", request_async)
    return requests


def _sweep(conn, sources, params: dict | None = None, **dates) -> dict:
    engine = SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution("deep_sweep", list(sources), params or {
        "query": "agent", "keywords": ["agent"], "max_results": 2, **dates})
    progress_store.register(exec_id)
    result = engine.run_prepared(exec_id)
    row = get_execution_by_id(conn, exec_id)
    return {"exec_id": exec_id, "result": result,
            "params": json.loads(row["parameters"]),
            "log": Path(result["log_path"]).read_text(encoding="utf-8"),
            "report": Path(result["report_path"]).read_text(encoding="utf-8")
            if result.get("report_path") else ""}


def _said(log: str) -> list[str]:
    return [line.split("] ", 1)[-1] for line in log.splitlines()]


def test_the_catalog_gives_a_start_to_biorxiv_and_medrxiv_and_no_other_source():
    days = {entry.slug: entry.constraints.default_start_days for entry in REPOSITORY_CATALOG}
    assert {slug for slug, n in days.items() if n is not None} == {"biorxiv", "medrxiv"}
    assert days["biorxiv"] == days["medrxiv"] == DEFAULT_START_DAYS
    # Each one's notice for a blank start says what is asked in its place now.
    for slug in ("biorxiv", "medrxiv"):
        entry = next(e for e in REPOSITORY_CATALOG if e.slug == slug)
        blank = [n for n in entry.constraints.notices if n.applies_when == "without_start_date"]
        assert len(blank) == 1
        assert f"for the {DEFAULT_START_DAYS} days before the run starts" in blank[0].effect
        assert "everything since" not in blank[0].effect
    assert all("default_start_days" in row["constraints"] for row in catalog_as_dicts())


def test_the_catalog_route_carries_the_start():
    """FastAPI drops a field its response model does not declare."""
    import resmon as resmon_mod  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415

    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    rows = TestClient(resmon_mod.app).get("/api/repositories/catalog").json()
    given = {row["slug"]: row["constraints"]["default_start_days"] for row in rows}
    assert given["biorxiv"] == given["medrxiv"] == DEFAULT_START_DAYS
    assert given["arxiv"] is None and given["crossref"] is None


def test_a_run_with_no_start_asks_biorxiv_for_the_days_before_it_and_no_other_source(conn, answers):
    run = _sweep(conn, ["biorxiv", "crossref"])

    # bioRxiv is asked from three days before October 31; Crossref with no dates.
    asked = [url for url, _ in answers if "biorxiv" in url]
    assert asked == ["https://api.biorxiv.org/details/biorxiv/2026-10-28/2099-12-31/0"]
    crossref = [params for url, params in answers if "crossref" in url]
    assert crossref and not any("pub-date" in json.dumps(p) for p in crossref)
    assert get_execution_by_id(conn, run["exec_id"])["status"] == "completed"

    params = run["params"]
    # The run's own request is as it was sent: no start date.
    assert not params.get("date_from")
    assert params["queries_sent"]["biorxiv"] == {"sent": [
        "path /details/biorxiv/2026-10-28/2099-12-31 (no terms: resmon matches them in "
        "each record it reads)"]}
    sentence = f"bioRxiv was asked from October 28, 2026, 3 days before the run started, {WHY}"
    assert params["default_starts"] == {"biorxiv": {
        "date_from": "2026-10-28", "days": 3, "before": "run", "sentence": sentence}}

    said = _said(run["log"])
    line = f"  biorxiv: asked from October 28, 2026, 3 days before the run started, {WHY}"
    assert line in said
    # Said before what the source returned.
    assert said.index(line) < said.index("  biorxiv: 1 result")
    assert not any(entry.startswith("  crossref: asked from") for entry in said)
    assert f"**Start date given:** {sentence}" in run["report"]


def test_an_end_date_already_past_is_counted_back_from(conn, answers):
    run = _sweep(conn, ["medrxiv"], date_to="2026-10-01")

    assert [url for url, _ in answers] == [
        "https://api.biorxiv.org/details/medrxiv/2026-09-28/2026-10-01/0"]
    start = run["params"]["default_starts"]["medrxiv"]
    assert start["before"] == "end_date"
    assert start["sentence"].startswith(
        "medRxiv was asked from September 28, 2026, 3 days before the run's end date, "
        "because the run set no start date: resmon reads every preprint in a medRxiv range")


def test_a_run_with_a_start_date_records_no_start_it_did_not_give(conn, answers):
    run = _sweep(conn, ["biorxiv"], date_from="2026-10-20")

    assert [url for url, _ in answers] == [
        "https://api.biorxiv.org/details/biorxiv/2026-10-20/2099-12-31/0"]
    assert "default_starts" not in run["params"]
    assert not any("asked from" in line for line in _said(run["log"]))
    assert "Start date given" not in run["report"]


def test_a_restart_records_its_own_start_rather_than_its_original_runs(conn, answers):
    first = _sweep(conn, ["biorxiv"])
    stale = {"biorxiv": {"date_from": "2020-01-01", "days": 3, "before": "run", "sentence": "stale"}}

    again = _sweep(conn, ["biorxiv"], {**first["params"], "default_starts": stale})
    assert again["params"]["default_starts"]["biorxiv"]["date_from"] == "2026-10-28"

    dated = _sweep(conn, ["biorxiv"], {**first["params"], "date_from": "2026-10-25",
                                       "default_starts": stale})
    assert "default_starts" not in dated["params"]
