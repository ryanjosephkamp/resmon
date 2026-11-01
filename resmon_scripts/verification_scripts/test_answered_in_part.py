# resmon_scripts/verification_scripts/test_answered_in_part.py
"""A search resmon itself stopped, after a stated stretch, is answered in part.

bioRxiv and medRxiv are read newest first, page by page, for at most 45
seconds, and the client records what it read (``api_base.note_read``). A
search that resmon's own time budget or the run's cap stops there has read a
definite, dated stretch of the window: the source answered every page it was
asked for. These cases drive the real client and engine, with the client's
requests answered here, and hold that such a search:

  * is answered, and in part: never an answered zero for the window, never a
    non-answer, so a run whose only shortfall it is completes;
  * says what it read, in the run's coverage, its log, its report, and its
    search record, and the run list counts it apart;
  * draws its own state on the Source wall and is counted as answering there;
  * is not a failure to the Watchdog, which says so in its own words after
    three runs in a row;

and that a provider's failure part-way is still a non-answer.

What this does not establish: anything about the real API.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import (  # noqa: E402
    api_base,
    api_biorxiv,
    search_record,
    source_coverage,
    source_wall,
    sweep_engine as se,
    watchdog,
    zero_reason,
)
from implementation_scripts.database import (  # noqa: E402
    get_execution_by_id,
    get_execution_sources,
    init_db,
)
from implementation_scripts.progress import progress_store  # noqa: E402

COVERED = ("resmon read the newest 30 of the 3,000 records bioRxiv lists for the window, "
           "posted between October 30, 2026 and October 31, 2026, and stopped when its own "
           "time budget for the search ran out")


class _Reply:
    def __init__(self, payload: dict | None = None, status_code: int = 200) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload or {}


def _page(start: int, count: int, total: int, day: str) -> dict:
    return {"messages": [{"status": "ok", "total": total}], "collection": [
        {"doi": f"10.1101/2026.10.30.{i:06d}", "version": "1", "title": f"A preprint {i}",
         "authors": "Doe, Jane", "abstract": "Cells.", "date": day, "category": "Cell Biology"}
        for i in range(start, start + count)]}


@pytest.fixture(autouse=True)
def quiet(monkeypatch, tmp_path):
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setattr(api_biorxiv, "_RATE_LIMITER", api_base.RateLimiter(1000))


@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


def _replies(monkeypatch, replies: list) -> None:
    """Every bioRxiv request answered from *replies*, in order, as ``safe_request`` would record it."""
    queue = list(replies)

    def request(method, url, **kwargs):
        outcome = api_base.search_outcome()
        outcome.note_attempt()
        outcome.note_sent(url, None, None)
        reply = queue.pop(0) if queue else api_base.RequestDeadlineExceeded("budget")
        if isinstance(reply, BaseException):
            outcome.note_failure(reply, url)
            raise reply
        if reply.status_code != 200:
            outcome.note_failure(reply.status_code, url)
        return reply

    monkeypatch.setattr(api_biorxiv, "safe_request", request)


def _budget_runs_out(monkeypatch) -> None:
    """A week of 3,000 records, the newest page read, and then the budget gone."""
    expired = api_base.RequestDeadlineExceeded("The source operation deadline expired")
    newest = _page(2970, 30, 3000, "2026-10-30")
    newest["collection"][-1]["date"] = "2026-10-31"
    _replies(monkeypatch, [_Reply(_page(0, 30, 3000, "2026-10-24")), _Reply(newest), expired, expired])


def _sweep(conn, sources=("biorxiv",), query="nowhereword") -> dict:
    engine = se.SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution("deep_sweep", list(sources), {
        "query": query, "keywords": [query], "max_results": 10,
        "date_from": "2026-10-24", "date_to": "2026-10-31"})
    progress_store.register(exec_id)
    result = engine.run_prepared(exec_id)
    execution = dict(get_execution_by_id(conn, exec_id))
    rows = [dict(r) for r in get_execution_sources(conn, exec_id)]
    return {"exec_id": exec_id, "execution": execution, "rows": rows,
            "coverage": source_coverage.build(execution, rows),
            "log": Path(result["log_path"]).read_text(encoding="utf-8"),
            "report": Path(result["report_path"]).read_text(encoding="utf-8")
            if result.get("report_path") else ""}


def test_the_reason_is_neither_a_non_answer_nor_an_answered_zero():
    assert "answered_in_part" in zero_reason.ZERO_REASONS
    assert "answered_in_part" not in zero_reason.DID_NOT_ANSWER
    assert zero_reason.ANSWERED_IN_PART == frozenset({"answered_in_part"})
    assert zero_reason.answered("ok", 0, "answered_in_part") is True
    assert zero_reason.in_part("ok", "answered_in_part") is True
    assert zero_reason.in_part("ok", "answered_empty") is False
    # Nothing is inferred for a client that does not say what it read.
    assert zero_reason.terminal_issue({
        "attempts": 3, "failures": 1, "last_call_failed": True,
        "last_detail": "operation_deadline"}) == ("upstream_failure", {
            "detail": "operation_deadline", "status": None, "attempts": 3})
    assert source_wall.mapped_reasons()["answered_in_part"] == "answered_in_part"


def test_a_run_whose_only_shortfall_is_a_partial_read_completes_and_says_what_it_read(conn, monkeypatch):
    _budget_runs_out(monkeypatch)
    run = _sweep(conn)

    assert run["execution"]["status"] == "completed"
    [row] = run["rows"]
    assert (row["status"], row["result_count"], row["zero_reason"]) == ("ok", 0, "answered_in_part")
    coverage = run["coverage"]
    assert coverage["counts"]["answered"] == 1 and coverage["counts"]["in_part"] == 1
    assert coverage["counts"]["non_answer"] == 0 and coverage["counts"]["genuine_empty"] == 0
    assert coverage["summary"] == (
        "1 selected source: 1 answered (1 in part), 0 recorded non-answers, 0 unknown. "
        f"bioRxiv answered in part: {COVERED}; the older ones were not read.")
    [source] = coverage["sources"]
    assert (source["category"], source["label"], source["in_part"]) == ("answered", "answered in part", True)

    said = [line.split("] ", 1)[-1] for line in run["log"].splitlines()]
    assert "  biorxiv: answered in part" in said
    assert any(line.strip().startswith(f"bioRxiv answered in part: {COVERED}.") for line in said)
    assert "## Sources answered in part" in run["report"]
    assert f"- **bioRxiv**: bioRxiv answered in part: {COVERED}." in run["report"]
    assert "## Sources that did not answer" not in run["report"]

    markdown = search_record.to_markdown(search_record.build(conn, run["exec_id"]))
    assert "| biorxiv | 0 | answered in part |" in markdown
    assert "| biorxiv | answered, in part | 0 |" in markdown
    assert "1 of 1 recorded sources answered (1 in part)" in markdown

    import resmon as resmon_mod  # noqa: PLC0415
    listed = resmon_mod._source_outcomes(conn, [run["exec_id"]])[run["exec_id"]]
    assert (listed["answered"], listed["in_part"], listed["could_not_answer"]) == (1, 1, 0)


def test_a_read_the_cap_stopped_is_answered_in_part_not_retained_partial(conn, monkeypatch):
    _budget_runs_out(monkeypatch)
    run = _sweep(conn, query="preprint")

    assert run["execution"]["status"] == "completed"
    [source] = run["coverage"]["sources"]
    assert (source["label"], source["in_part"], source["partial"]) == ("answered in part", True, False)
    assert source["note"] == (
        "bioRxiv answered in part: it returned 10 usable records, and resmon read the newest 10 of "
        "the 3,000 records bioRxiv lists for the window, posted between October 30, 2026 and "
        "October 31, 2026, and stopped when the run had the 10 papers it asked for. The older ones "
        "were not read.")


def test_a_provider_failure_is_still_a_non_answer_and_fails_the_run(conn, monkeypatch):
    _replies(monkeypatch, [_Reply(_page(0, 30, 3000, "2026-10-24")), _Reply(status_code=500),
                           _Reply(status_code=500)])
    run = _sweep(conn)

    assert run["execution"]["status"] == "failed"
    assert run["rows"][0]["zero_reason"] == "upstream_failure"
    assert run["coverage"]["counts"]["in_part"] == 0
    assert run["coverage"]["sources"][0]["category"] == "non_answer"


def test_the_wall_draws_it_apart_and_counts_it_as_answering(conn, monkeypatch):
    _budget_runs_out(monkeypatch)
    _sweep(conn)

    wall = source_wall.build(conn)
    [source] = wall["sources"]
    assert source["cells"][-1]["state"] == "answered_in_part"
    assert source["cells"][-1]["label"] == "answered in part"
    assert source["counts"]["answered_in_part"] == 1 and wall["totals"]["answered_in_part"] == 1
    assert source["latest_known_state"] == "answered_in_part"
    # Answering, so not a source that stopped; said apart in the detail.
    assert wall["verdict"]["level"] == "ok"
    assert wall["verdict"]["headline"] == "All 1 of 1 sources answered the last time resmon asked them."
    assert wall["verdict"]["detail"] == [
        "bioRxiv answered in part the last time resmon asked it: resmon stopped at its own time "
        "budget or the run's cap, after the part of the window its cell states."]
    legend = {entry["state"]: entry["label"] for entry in wall["state_legend"]}
    assert legend["answered_in_part"] == "answered in part"


def test_the_watchdog_is_not_alarmed_and_says_it_after_three_runs(conn, monkeypatch):
    now = datetime(2026, 11, 2, tzinfo=timezone.utc)
    for _ in range(2):
        _budget_runs_out(monkeypatch)
        _sweep(conn)
    report = watchdog.report(conn, now=now)
    assert report["counts"]["alarms"] == 0
    assert not [f for f in report["findings"] if f["scope"].get("id") == "biorxiv"]

    _budget_runs_out(monkeypatch)
    _sweep(conn)
    report = watchdog.report(conn, now=now)
    assert report["counts"]["alarms"] == 0
    [finding] = [f for f in report["findings"] if f["scope"].get("id") == "biorxiv"]
    assert (finding["key"], finding["severity"], finding["kind"]) == (
        "source_in_part:biorxiv", "advice", "source_in_part")
    assert finding["title"] == "bioRxiv was answered in part on its last 3 runs"
    assert finding["detail"] == (
        "Each time, bioRxiv answered every page resmon asked for, and resmon stopped before it "
        f"reached the start of the window. Most recently, {COVERED}. This is not a failure, and "
        "the older part of each window was not searched.")
    assert finding["evidence"]["runs_in_part"] == 3
    assert finding["evidence"]["stopped_by"] == "time_budget"
    # Not a measurement of what the source returns: no baseline is built on it.
    assert all(not watchdog._is_a_measurement(r) for r in watchdog._source_history(conn)["biorxiv"])


def test_a_stored_detail_says_the_same_words_on_every_surface(conn, monkeypatch):
    """The coverage note is the sentence the engine stored, so the run page,
    the wall's cell, and the search record cannot word it differently."""
    _budget_runs_out(monkeypatch)
    run = _sweep(conn)
    stored = json.loads(run["rows"][0]["zero_detail"])
    note = run["coverage"]["sources"][0]["note"]
    assert note == zero_reason.sentence("bioRxiv", "answered_in_part", stored)
    assert source_wall.build(conn)["sources"][0]["cells"][-1]["note"] == note
