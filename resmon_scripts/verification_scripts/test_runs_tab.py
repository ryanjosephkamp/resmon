# resmon_scripts/verification_scripts/test_runs_tab.py
"""What the Runs tab reads: the run log filtered and counted, and the runs going now.

``GET /api/executions`` once answered with a page of runs and nothing else: no
way to ask for the failed ones, or for a watch's, or for a run by its words,
and no way to know how many there were short of reading them all. These cases
hold the filters (``type`` and ``status``, each one value or several), the
search (``q``), the count (the ``X-Resmon-Total`` header, so the body stays the
list the command line and the MCP server already read), and ``omit_events``.

``GET /api/executions/active`` said only which ids were running. It now says,
for each, its search and its events with the repeating ones folded to their
newest, and what waits in the queue.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database as db  # noqa: E402
from implementation_scripts.progress import progress_store  # noqa: E402


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    yield TestClient(resmon_mod.app)
    resmon_mod._db_path = None
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def _run(kind: str, status: str, words: list[str], *, day: int, routine_id=None, events=None) -> int:
    conn = resmon_mod._get_db()
    exec_id = db.insert_execution(conn, {
        "execution_type": kind,
        "parameters": json.dumps({"query": " ".join(words), "keywords": words, "repositories": ["arxiv"]}),
        "start_time": f"2026-10-{day:02d}T09:00:00Z",
        "routine_id": routine_id,
    })
    if status != "running":
        db.update_execution_status(conn, exec_id, status, end_time=f"2026-10-{day:02d}T09:05:00Z")
    if events is not None:
        db.save_progress_events(conn, exec_id, events)
    return exec_id


@pytest.fixture
def runs(client):
    conn = resmon_mod._get_db()
    watch = db.insert_routine(conn, {
        "name": "Midnight agents", "schedule_cron": "0 0 * * *", "parameters": "{}", "is_active": 0,
    })
    return {
        "graphs": _run("deep_dive", "completed", ["graph neural networks"], day=1,
                       events=[{"type": "execution_start"}] * 40),
        "failed": _run("deep_sweep", "failed", ["perovskite"], day=2),
        "watch": _run("automated_sweep", "completed", ["agents"], day=3, routine_id=watch),
        "watch_failed": _run("automated_sweep", "failed", ["agents"], day=4, routine_id=watch),
        "cafe": _run("deep_dive", "cancelled", ["café"], day=5),
    }


def _ids(response) -> list[int]:
    return [row["id"] for row in response.json()]


def test_every_run_newest_first_and_the_count_in_a_header(client, runs):
    resp = client.get("/api/executions", params={"limit": 2})
    assert resp.status_code == 200
    assert _ids(resp) == [runs["cafe"], runs["watch_failed"]]
    assert resp.headers["x-resmon-total"] == "5"
    # The renderer is another origin, and reads the count only if it is exposed.
    assert resp.headers["access-control-expose-headers"] == "X-Resmon-Total"


def test_searches_watches_and_failed_runs(client, runs):
    searches = client.get("/api/executions", params={"type": "deep_dive,deep_sweep"})
    assert _ids(searches) == [runs["cafe"], runs["failed"], runs["graphs"]]
    assert searches.headers["x-resmon-total"] == "3"
    watches = client.get("/api/executions", params={"type": "automated_sweep"})
    assert _ids(watches) == [runs["watch_failed"], runs["watch"]]
    failed = client.get("/api/executions", params={"status": "failed"})
    assert _ids(failed) == [runs["watch_failed"], runs["failed"]]
    both = client.get("/api/executions", params={"status": "failed", "type": "automated_sweep"})
    assert _ids(both) == [runs["watch_failed"]] and both.headers["x-resmon-total"] == "1"
    several = client.get("/api/executions", params={"status": "failed,cancelled"})
    assert _ids(several) == [runs["cafe"], runs["watch_failed"], runs["failed"]]


def test_a_run_found_by_its_words_its_watch_or_its_number(client, runs):
    def found(q: str) -> list[int]:
        resp = client.get("/api/executions", params={"q": q})
        assert resp.headers["x-resmon-total"] == str(len(resp.json()))
        return _ids(resp)

    assert found("NEURAL") == [runs["graphs"]]
    assert found("midnight") == [runs["watch_failed"], runs["watch"]]
    # Stored as JSON, escaped; found as typed.
    assert found("café") == [runs["cafe"]]
    assert found(str(runs["failed"])) == [runs["failed"]]
    # LIKE's own characters are words here, not patterns.
    assert found("%") == [] and found("_") == []
    assert found("nothing like this") == []


def test_omit_events_leaves_the_stored_events_out(client, runs):
    full = client.get("/api/executions", params={"q": "graph"}).json()[0]
    assert len(json.loads(full["progress_events"])) == 40
    lean = client.get("/api/executions", params={"q": "graph", "omit_events": True}).json()[0]
    assert lean["progress_events"] is None
    # Everything else is the same row.
    assert {k: v for k, v in lean.items() if k != "progress_events"} == {
        k: v for k, v in full.items() if k != "progress_events"}


def test_the_runs_going_now_with_their_events_folded_and_the_queue(client):
    running = _run("deep_sweep", "running", ["slow light"], day=6)
    progress_store.register(running)
    try:
        for event in [
            {"type": "execution_start"},
            {"type": "stage", "stage": "querying"},
            {"type": "repo_start", "repository": "arxiv"},
            {"type": "query_progress", "repository": "arxiv", "phase": "search_start"},
            {"type": "query_progress", "repository": "arxiv", "phase": "searching", "elapsed": 2.0},
            {"type": "log_entry", "message": "a line"},
            {"type": "repo_start", "repository": "hal"},
            {"type": "query_progress", "repository": "arxiv", "phase": "searching", "elapsed": 4.0, "requests": 2},
            {"type": "query_progress", "repository": "hal", "phase": "searching", "elapsed": 2.0},
            {"type": "repo_done", "repository": "hal", "result_count": 3},
            {"type": "query_progress", "repository": "arxiv", "phase": "searching", "elapsed": 6.0, "requests": 3},
        ]:
            progress_store.emit(running, event)
        body = client.get("/api/executions/active").json()
        assert list(body) == ["active_ids", "running", "waiting", "max_concurrent", "queue_limit"]
        assert body["active_ids"] == [running]
        assert body["waiting"] == [] and body["max_concurrent"] == resmon_mod.admission.max()
        [run] = body["running"]
        assert run["id"] == running and run["execution_type"] == "deep_sweep"
        assert run["keywords"] == ["slow light"] and run["repositories"] == ["arxiv"]
        assert [(e["type"], e.get("repository"), e.get("elapsed")) for e in run["events"]] == [
            ("execution_start", None, None),
            ("stage", None, None),
            ("repo_start", "arxiv", None),
            ("repo_start", "hal", None),
            ("query_progress", "hal", 2.0),
            ("repo_done", "hal", None),
            ("query_progress", "arxiv", 6.0),
        ]
    finally:
        progress_store.mark_complete(running)
        progress_store.cleanup(running)
    assert client.get("/api/executions/active").json()["running"] == []
