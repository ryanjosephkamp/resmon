# resmon_scripts/verification_scripts/test_live_progress.py
"""A running run says what each source is doing, every heartbeat.

The sweep engine's heartbeat (``query_progress``, phase ``searching``) used to
carry only the time a source had been asked. A source waiting for its own
pace, retrying after a 503, or held by a Retry-After looked the same as one
that had hung. These cases hold what the heartbeat now carries, and where it
comes from:

  * ``requests`` and ``retries``, counted on the search's own outcome channel
    as ``safe_request`` and the clients' own ladders work;
  * ``waiting``, the kind of wait (``pace``, ``cooldown``, ``retry``) and the
    seconds left, set by the rate limiter, ``safe_request``'s pause, and
    arXiv's and INSPIRE's own ladders, and cleared when the wait ends;
  * none of it reaches the run's record: ``snapshot()`` is unchanged;
  * the progress route reads from an index, so a running run's page reads
    only the events it has not seen.

What this does not establish: the timing of any real upstream. The waits here
are short and local.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import api_arxiv, api_base, config, sweep_engine as se  # noqa: E402
from implementation_scripts.api_base import (  # noqa: E402
    NormalizedResult,
    RateLimiter,
    reset_search_outcome,
    search_outcome,
)
from implementation_scripts.database import init_db  # noqa: E402
from implementation_scripts.progress import progress_store  # noqa: E402
from implementation_scripts.sweep_engine import SweepEngine  # noqa: E402


@pytest.fixture(autouse=True)
def reports_elsewhere(monkeypatch, tmp_path):
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")


@pytest.fixture
def client():
    """The app over a fresh database, without its startup (no scheduler)."""
    import resmon
    from fastapi.testclient import TestClient

    resmon._db_path = ":memory:"
    resmon._shared_conn = None
    resmon._db_initialized = False
    yield TestClient(resmon.app)
    resmon._db_path = None
    resmon._shared_conn = None
    resmon._db_initialized = False


def _paper(slug: str) -> NormalizedResult:
    return NormalizedResult(
        source_repository=slug, external_id=f"{slug}-1", doi=None,
        title=f"A paper from {slug}", authors=["Ada Lovelace"], abstract="An abstract.",
        publication_date="2025-03-01", url=f"https://example.org/{slug}/1",
    )


class _Stand:
    def __init__(self, slug: str, script):
        self.slug = slug
        self.script = script

    def search(self, query, date_from=None, date_to=None, max_results=100):
        return self.script(self.slug)


def _run(monkeypatch, sources, script, config: dict | None = None) -> list[dict]:
    monkeypatch.setattr(se, "get_client", lambda name, **kwargs: _Stand(name, script))
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    engine = SweepEngine(db_conn=conn, config=config or {})
    exec_id = engine.prepare_execution("deep_sweep", list(sources), {"query": "graphs", "max_results": 10})
    progress_store.register(exec_id)
    engine.run_prepared(exec_id)
    events = progress_store.get_events(exec_id)
    conn.close()
    return events


def _beats(events: list[dict], slug: str) -> list[dict]:
    return [e for e in events if e.get("type") == "query_progress"
            and e.get("phase") == "searching" and e.get("repository") == slug]


# ---------------------------------------------------------------------------
# The heartbeat
# ---------------------------------------------------------------------------


def test_the_heartbeat_says_requests_retries_and_the_wait(monkeypatch):
    monkeypatch.setattr(se, "_HEARTBEAT_SECONDS", 0.05)

    def script(slug: str) -> list:
        outcome = search_outcome()
        # Three requests, the first answered 503 and asked again.
        outcome.note_attempt()
        outcome.note_retried_failure(503)
        outcome.note_attempt()
        outcome.note_attempt()
        with api_base.waiting("pace", 0.6):
            time.sleep(0.4)
        time.sleep(0.2)
        return [_paper(slug)]

    beats = _beats(_run(monkeypatch, ["zenodo"], script), "zenodo")
    assert beats, "a source asked for 0.6 s sent no heartbeat"
    waits = [b for b in beats if "waiting" in b]
    assert waits, "no heartbeat said the source was waiting for its pace"
    assert all(b["waiting"]["kind"] == "pace" for b in waits)
    assert all(0 < b["waiting"]["seconds"] <= 0.6 for b in waits)
    # The wait's seconds count down.
    seconds = [b["waiting"]["seconds"] for b in waits]
    assert seconds == sorted(seconds, reverse=True)
    assert {(b["requests"], b["retries"]) for b in beats} == {(3, 1)}
    # Once the wait ended, the heartbeat stopped saying it.
    assert "waiting" not in beats[-1]
    # Its fields in a fixed order, the time last, as every event has it.
    assert list(beats[-1]) == ["type", "repository", "phase", "message", "elapsed", "requests", "retries", "timestamp"]
    assert list(waits[0]) == ["type", "repository", "phase", "message", "elapsed", "requests", "retries", "waiting",
                              "timestamp"]


def test_a_watchs_scheduled_run_says_its_five_minute_wait_for_arxiv(monkeypatch):
    """A scheduled run's arXiv search may wait five minutes at once; the heartbeat says so, counting down."""
    monkeypatch.setattr(se, "_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(api_arxiv, "_wait", lambda seconds: time.sleep(0.4))
    monkeypatch.delenv("RESMON_ARXIV_UNATTENDED_PATIENCE_SECONDS", raising=False)
    seen: dict = {}

    def script(slug: str) -> list:
        patience = api_arxiv._Patience()       # as ArxivClient.search makes it
        seen["patience"] = (patience.unattended, patience.allows(300.0), patience.allows(301.0))
        patience.spend(300.0, "answered 429")
        return [_paper(slug)]

    beats = _beats(_run(monkeypatch, ["arxiv"], script, config={"unattended": True}), "arxiv")
    assert seen["patience"] == (True, True, False)
    waits = [b["waiting"] for b in beats if "waiting" in b]
    assert waits, "no heartbeat said the search was waiting"
    assert all(w["kind"] == "retry" and 299 <= w["seconds"] <= 300 for w in waits), waits
    assert {b["retries"] for b in beats if "waiting" in b} == {1}


def test_canceling_a_run_ends_its_searches_long_waits(monkeypatch):
    """A canceled run tells each search still under way, so a long wait (arXiv's) ends rather than running on."""
    monkeypatch.setattr(se, "_HEARTBEAT_SECONDS", 0.05)
    seen: dict = {}

    def script(slug: str) -> list:
        seen["outcome"] = search_outcome()
        started = time.monotonic()
        api_arxiv._wait(300.0)                 # the real wait: five minutes unless the run stops it
        seen["stopped"] = api_arxiv._stopped()
        seen["waited"] = time.monotonic() - started
        return [_paper(slug)]

    monkeypatch.setattr(se, "get_client", lambda name, **kwargs: _Stand(name, script))
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    engine = SweepEngine(db_conn=conn, config={"unattended": True})
    exec_id = engine.prepare_execution("deep_sweep", ["arxiv"], {"query": "graphs", "max_results": 10})
    progress_store.register(exec_id)

    def cancel_once_waiting() -> None:
        until = time.monotonic() + 5
        while "outcome" not in seen and time.monotonic() < until:
            time.sleep(0.01)
        time.sleep(0.1)
        progress_store.request_cancel(exec_id)

    threading.Thread(target=cancel_once_waiting, daemon=True).start()
    began = time.monotonic()
    engine.run_prepared(exec_id)
    ran = time.monotonic() - began
    until = time.monotonic() + 5
    while "waited" not in seen and time.monotonic() < until:
        time.sleep(0.01)
    conn.close()

    assert ran < 5
    assert seen.get("stopped") is True
    assert seen["waited"] < 5


def test_the_run_record_is_what_it_was(monkeypatch):
    """Retries and waits are said live and kept nowhere: the outcome's snapshot has neither."""
    reset_search_outcome()
    outcome = search_outcome()
    outcome.note_retried_failure(503)
    api_base.note_retry()
    api_base.note_retry_wait(2.0)
    with api_base.waiting("retry", 1.0):
        assert outcome.live()["waiting"]["kind"] == "retry"
        snapshot = outcome.snapshot()
    assert "retries" not in snapshot and "waiting" not in snapshot
    assert outcome.retries == 2
    assert outcome.waited_seconds == 2.0
    reset_search_outcome()
    assert outcome.retries == 0 and outcome.waiting is None


# ---------------------------------------------------------------------------
# Where the waits are said
# ---------------------------------------------------------------------------


def test_the_rate_limiter_says_the_pace_while_a_search_waits_for_it():
    limiter = RateLimiter(requests_per_second=2.0)   # one request every 0.5 s
    seen: dict = {}
    entered = threading.Event()

    def search() -> None:
        reset_search_outcome()
        seen["outcome"] = search_outcome()
        limiter.acquire()
        entered.set()
        limiter.acquire()            # waits about half a second for the pace

    thread = threading.Thread(target=search)
    thread.start()
    assert entered.wait(2)
    time.sleep(0.15)
    waiting = seen["outcome"].live().get("waiting")
    thread.join(3)
    assert waiting is not None and waiting["kind"] == "pace"
    assert 0 < waiting["seconds"] <= 0.5
    assert seen["outcome"].waiting is None, "the wait was still said after it ended"


def test_a_cooldown_the_source_asked_for_is_said_as_one():
    limiter = RateLimiter(requests_per_second=100.0)
    limiter.defer(0.4)
    seen: dict = {}

    def search() -> None:
        reset_search_outcome()
        seen["outcome"] = search_outcome()
        limiter.acquire(deadline=time.monotonic() + 5)

    thread = threading.Thread(target=search)
    thread.start()
    time.sleep(0.15)
    waiting = seen["outcome"].live().get("waiting")
    thread.join(3)
    assert waiting is not None and waiting["kind"] == "cooldown"
    assert seen["outcome"].waiting is None


def test_safe_requests_pause_before_a_retry_is_said(monkeypatch):
    replies = iter([httpx.Response(503), httpx.Response(200, text="ok")])
    seen: list = []
    monkeypatch.setattr(config, "DEFAULT_BACKOFF_BASE", 0.01)
    real_sleep = time.sleep

    def sleep(seconds: float) -> None:
        seen.append(search_outcome().waiting)
        real_sleep(0)

    monkeypatch.setattr(api_base.time, "sleep", sleep)

    class Transport(httpx.BaseTransport):
        def handle_request(self, request):
            return next(replies)

    real_client = httpx.Client
    monkeypatch.setattr(api_base.httpx, "Client",
                        lambda **kwargs: real_client(transport=Transport(), **kwargs))
    reset_search_outcome()
    response = api_base.safe_request("GET", "http://127.0.0.1:9/x", max_retries=1)
    assert response.status_code == 200
    assert [w[0] if w else None for w in seen] == ["retry"]
    outcome = search_outcome()
    assert (outcome.attempts, outcome.retries, outcome.waiting) == (2, 1, None)


def test_arxivs_own_ladder_says_its_waits_and_counts_its_retries(monkeypatch):
    seen: list = []
    monkeypatch.setattr(api_arxiv, "_wait", lambda seconds: seen.append(search_outcome().waiting))
    reset_search_outcome()
    patience = api_arxiv._Patience()
    patience.spend(5.0, "answered 503")
    patience.spend(3.0, "is cooling down after an earlier 429", "cooldown")
    assert [w[0] for w in seen] == ["retry", "cooldown"]
    assert search_outcome().retries == 2
    assert search_outcome().waiting is None


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------


def test_the_progress_route_reads_from_an_index(client):
    import resmon

    conn = resmon._get_db()
    engine = SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution("deep_dive", ["arxiv"], {"query": "graphs"})
    progress_store.register(exec_id)
    for n in range(5):
        progress_store.emit(exec_id, {"type": "log_entry", "message": f"line {n}"})
    every = client.get(f"/api/executions/{exec_id}/progress/events").json()
    assert [e["message"] for e in every] == [f"line {n}" for n in range(5)]
    tail = client.get(f"/api/executions/{exec_id}/progress/events", params={"since": 3}).json()
    assert [e["message"] for e in tail] == ["line 3", "line 4"]
    assert client.get(f"/api/executions/{exec_id}/progress/events", params={"since": 9}).json() == []
    assert client.get(f"/api/executions/{exec_id}/progress/events", params={"since": -1}).status_code == 422

    # Once the run has ended and its events are persisted, the same index reads the same events.
    from implementation_scripts.database import save_progress_events
    save_progress_events(conn, exec_id, progress_store.get_events(exec_id))
    progress_store.cleanup(exec_id)
    tail = client.get(f"/api/executions/{exec_id}/progress/events", params={"since": 3}).json()
    assert [e["message"] for e in tail] == ["line 3", "line 4"]
