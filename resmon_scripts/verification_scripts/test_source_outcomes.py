"""Why a search came back empty — the outcome channel, at its real boundary.

The failure this file exists to catch is one a mock cannot produce. A source
that 503s and a source with nothing to say are the same thing to every caller
in resmon: ``search()`` returns ``[]``. Patching ``safe_request`` to return a
fake 503 proves that the *test double* behaves as written; it says nothing
about whether ``safe_request`` itself records the outcome, because that is the
function the double replaced. So the HTTP tests here stand up **a real HTTP
server on loopback** and let the real ``safe_request`` talk to it over a real
socket, retries and all.

That is only affordable because ``safe_request`` now reads its timeout, retry
count and backoff base from ``config`` at call time: with the shipped values an
exhausted 503 sleeps 1 + 2 + 4 = 7 s and an exhausted timeout ~127 s, on every
Python in CI's matrix.
"""

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from resmon_scripts.implementation_scripts import api_base, config, zero_reason


# ---------------------------------------------------------------------------
# A real HTTP server, on loopback
# ---------------------------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    """Answers however the server it belongs to was told to."""

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's spelling
        self.server.hits.append(self.path)
        behaviour = self.server.behaviour
        if behaviour == "sleep":
            time.sleep(self.server.sleep_for)
        status, body = self.server.reply
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", self.server.content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # keep pytest output readable
        pass


class _Server(ThreadingHTTPServer):
    daemon_threads = True


@pytest.fixture
def http_server():
    """A real loopback HTTP server whose answer each test chooses."""
    server = _Server(("127.0.0.1", 0), _Handler)
    server.hits = []
    server.behaviour = "reply"
    server.sleep_for = 0.0
    server.reply = (200, "{}")
    server.content_type = "application/json"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    server.url = f"http://127.0.0.1:{server.server_address[1]}/records"
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def fast_retries(monkeypatch):
    """Shrink the retry knobs, which safe_request now reads at call time."""
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 2)
    monkeypatch.setattr(config, "DEFAULT_BACKOFF_BASE", 0.001)
    monkeypatch.setattr(config, "DEFAULT_REQUEST_TIMEOUT", 0.25)


@pytest.fixture(autouse=True)
def clean_channel():
    api_base.reset_search_outcome()
    yield
    api_base.reset_search_outcome()


# ---------------------------------------------------------------------------
# P1 — an upstream that answers 503
# ---------------------------------------------------------------------------


def test_exhausted_503_records_upstream_failure_with_attempt_count(
    http_server, fast_retries,
):
    http_server.reply = (503, "service unavailable")

    response = api_base.safe_request("GET", http_server.url)

    assert response.status_code == 503
    snapshot = api_base.search_outcome().snapshot()
    reason, detail = zero_reason.derive(snapshot)
    assert reason == "upstream_failure"
    assert detail["detail"] == "http_503"
    assert detail["status"] == 503
    # 2 retries plus the first call. Never a fixed number in the sentence:
    # 401 and 403 come back on the first attempt, not the third.
    assert detail["attempts"] == 3 == len(http_server.hits)
    assert zero_reason.sentence("Test Source", reason, detail) == (
        "Test Source could not be queried: HTTP 503 after 3 attempts. This is "
        "not a zero — the source did not answer."
    )


def test_a_401_is_recorded_on_its_first_attempt(http_server, fast_retries):
    """A non-transient status is not retried, and the count says so."""
    http_server.reply = (401, "unauthorized")

    api_base.safe_request("GET", http_server.url)

    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert reason == "upstream_failure"
    assert detail["attempts"] == 1 == len(http_server.hits)
    assert "after 1 attempt." in zero_reason.sentence("S", reason, detail)


def test_a_429_is_recorded_as_rate_limited(http_server, fast_retries):
    http_server.reply = (429, "slow down")

    api_base.safe_request("GET", http_server.url)

    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert reason == "upstream_failure"
    assert detail["detail"] == "rate_limited"
    assert detail["status"] == 429


def test_a_200_records_no_failure(http_server, fast_retries):
    http_server.reply = (200, '{"results": []}')

    api_base.safe_request("GET", http_server.url)

    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["failures"] == 0
    reason, detail = zero_reason.derive(snapshot)
    assert reason == "answered_empty"
    assert zero_reason.sentence("Test Source", reason, detail) == (
        "Test Source answered (HTTP 200) and resmon found no records in the "
        "reply."
    )


def test_a_success_after_a_transient_failure_is_not_a_failure(
    http_server, fast_retries,
):
    """The *last* call is the one that explains the result."""
    http_server.reply = (503, "unavailable")

    def flip_after_first():
        while not http_server.hits:
            time.sleep(0.005)
        http_server.reply = (200, "{}")

    flipper = threading.Thread(target=flip_after_first, daemon=True)
    flipper.start()
    api_base.safe_request("GET", http_server.url)
    flipper.join(timeout=5)

    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["last_call_failed"] is False
    assert zero_reason.derive(snapshot)[0] == "answered_empty"


# ---------------------------------------------------------------------------
# P2 — an exhausted timeout
# ---------------------------------------------------------------------------


def test_exhausted_timeout_records_upstream_failure(http_server, fast_retries):
    http_server.behaviour = "sleep"
    http_server.sleep_for = 5.0

    with pytest.raises(Exception):
        api_base.safe_request("GET", http_server.url)

    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert reason == "upstream_failure"
    assert detail["detail"] == "timeout"
    assert detail["status"] is None
    assert detail["attempts"] == 3
    assert zero_reason.sentence("Test Source", reason, detail) == (
        "Test Source could not be queried: the request timed out after 3 "
        "attempts. This is not a zero — the source did not answer."
    )


def test_a_refused_connection_records_connect(fast_retries):
    """A port nothing is listening on, over a real socket."""
    import socket

    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    dead_port = probe.getsockname()[1]
    probe.close()

    with pytest.raises(Exception):
        api_base.safe_request("GET", f"http://127.0.0.1:{dead_port}/records")

    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert reason == "upstream_failure"
    assert detail["detail"] == "connect"


# ---------------------------------------------------------------------------
# P5 — not_recorded is the floor
# ---------------------------------------------------------------------------


def test_a_search_that_made_no_call_reads_not_recorded():
    """The default must never be answered_empty.

    Mutation performed while writing this: defaulting ``derive`` to
    ``answered_empty`` makes this test fail, and only this one.
    """
    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert reason == "not_recorded"
    assert detail == {}
    assert zero_reason.sentence("Open Library", reason, detail) == (
        "resmon did not record whether Open Library answered on this run."
    )


def test_an_absent_snapshot_reads_not_recorded():
    assert zero_reason.derive(None) == ("not_recorded", {})


# ---------------------------------------------------------------------------
# P10 — two searches on two threads do not cross
# ---------------------------------------------------------------------------


def test_two_threads_do_not_share_an_outcome(http_server, fast_retries):
    """The engine runs one search per thread; the channel is per-thread."""
    results: dict[str, tuple] = {}
    started = threading.Barrier(2)

    # Each thread gets its own server so the two cannot race on one reply, and
    # a barrier so both are inside safe_request at the same time. If the
    # channel were process-wide rather than per-thread, the 404 would be the
    # last writer and both threads would report upstream_failure.
    threads = []
    for name, status in (("failing", 404), ("ok", 200)):
        server = _Server(("127.0.0.1", 0), _Handler)
        server.hits = []
        server.behaviour = "reply"
        server.sleep_for = 0.0
        server.reply = (status, "{}")
        server.content_type = "application/json"
        thread_server = threading.Thread(target=server.serve_forever, daemon=True)
        thread_server.start()
        url = f"http://127.0.0.1:{server.server_address[1]}/x"

        def run_one(name=name, url=url):
            api_base.reset_search_outcome()
            started.wait(timeout=5)
            api_base.safe_request("GET", url)
            time.sleep(0.05)
            results[name] = zero_reason.derive(
                api_base.search_outcome().snapshot())

        t = threading.Thread(target=run_one, daemon=True)
        threads.append((t, server, thread_server))
        t.start()

    for t, server, thread_server in threads:
        t.join(timeout=10)
        server.shutdown()
        server.server_close()
        thread_server.join(timeout=5)

    assert results["failing"][0] == "upstream_failure"
    assert results["failing"][1]["status"] == 404
    assert results["ok"][0] == "answered_empty"


def test_the_channel_is_empty_on_a_fresh_thread(http_server, fast_retries):
    """A stale value from lifecycle.py must not leak into a search."""
    http_server.reply = (500, "boom")
    api_base.safe_request("GET", http_server.url)
    assert api_base.search_outcome().snapshot()["failures"] > 0

    seen = {}

    def fresh():
        seen["snapshot"] = api_base.search_outcome().snapshot()

    t = threading.Thread(target=fresh)
    t.start()
    t.join(timeout=5)
    assert seen["snapshot"]["failures"] == 0
    assert zero_reason.derive(seen["snapshot"])[0] == "not_recorded"


# ---------------------------------------------------------------------------
# P6 — every registered client puts an attempt on the channel
# ---------------------------------------------------------------------------
#
# The denominator is ``api_registry.list_repositories()``: the slugs a sweep
# can actually reach. The brief named ``_CLIENT_MODULES``, which is a local
# inside ``_ensure_loaded`` and so not importable, and is also one short of the
# truth -- medRxiv and bioRxiv share ``api_biorxiv.py``, so a module list would
# leave medRxiv unexercised. Parametrising over the registry means a source
# cannot be added without appearing here.


def _fake_response(request, status=200, body=b"{}"):
    import httpx

    return httpx.Response(status, content=body, request=request)


@pytest.fixture
def no_rate_limit(monkeypatch):
    """arXiv alone waits 3 s between calls; 25 clients would be a minute."""
    monkeypatch.setattr(api_base.RateLimiter, "acquire", lambda self: None)


@pytest.fixture
def every_credential(monkeypatch):
    """Answer every credential lookup, so a key check never short-circuits."""
    from resmon_scripts.implementation_scripts import api_registry

    api_registry._ensure_loaded()
    import sys

    for name, module in list(sys.modules.items()):
        if not name.startswith("resmon_scripts.implementation_scripts.api_"):
            continue
        if hasattr(module, "get_credential_for"):
            monkeypatch.setattr(
                module, "get_credential_for", lambda *a, **k: "test-key",
            )


@pytest.mark.parametrize("slug", sorted(
    __import__(
        "resmon_scripts.implementation_scripts.api_registry",
        fromlist=["list_repositories"],
    ).list_repositories()
))
def test_every_client_records_an_attempt(
    slug, monkeypatch, no_rate_limit, every_credential,
):
    """``search()`` on any registered source leaves an attempt on the channel.

    Not a grep for ``safe_request``: a client that imported it and then used
    ``httpx`` directly would pass a grep and fail this. The patch is at
    ``httpx.Client.request`` -- below every client and below ``safe_request``
    -- so the only way to satisfy it is to actually make the call through the
    instrumented path.

    The reply is an empty JSON object, which most of these clients cannot
    parse. That is deliberate and harmless: the property is that the attempt
    was recorded, not that the search succeeded.
    """
    import httpx

    from resmon_scripts.implementation_scripts import api_registry

    calls = []

    def _request(self, method, url, **kwargs):
        calls.append(url)
        return _fake_response(httpx.Request(method, url))

    monkeypatch.setattr(httpx.Client, "request", _request)

    api_base.reset_search_outcome()
    client = api_registry.get_client(slug)
    try:
        client.search(
            query="alpha",
            date_from="2024-01-01",
            date_to="2024-12-31",
            max_results=5,
        )
    except Exception:
        # A client that cannot parse "{}" is free to raise; the attempt has
        # already been recorded by then, and that is what is under test.
        pass

    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["attempts"] >= 1, (
        f"{slug} made no recorded HTTP attempt (httpx saw {len(calls)} calls)"
    )


# ---------------------------------------------------------------------------
# P11 — a 200 with an unreadable body is not an empty answer
# ---------------------------------------------------------------------------


def test_arxiv_unparseable_body_records_parse_failure(monkeypatch, no_rate_limit):
    import httpx

    from resmon_scripts.implementation_scripts import api_arxiv

    monkeypatch.setattr(
        httpx.Client, "request",
        lambda self, method, url, **kw: _fake_response(
            httpx.Request(method, url), body=b"<feed><entry>truncated",
        ),
    )

    api_base.reset_search_outcome()
    results = api_arxiv.ArxivClient().search(query="alpha", max_results=5)

    assert results == []
    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert reason == "parse_failure"
    assert zero_reason.sentence("arXiv", reason, detail) == (
        "arXiv answered (HTTP 200), and resmon could not read the reply."
    )


def test_a_json_client_with_an_unreadable_body_records_parse_failure(
    monkeypatch, no_rate_limit,
):
    """The shared try/except sites, where the same block also catches a 503."""
    import httpx

    from resmon_scripts.implementation_scripts import api_zenodo

    monkeypatch.setattr(
        httpx.Client, "request",
        lambda self, method, url, **kw: _fake_response(
            httpx.Request(method, url), body=b"not json at all",
        ),
    )

    api_base.reset_search_outcome()
    results = api_zenodo.ZenodoClient().search(query="alpha", max_results=5)

    assert results == []
    assert zero_reason.derive(
        api_base.search_outcome().snapshot())[0] == "parse_failure"


def test_a_transport_failure_is_not_reported_as_an_unreadable_body(
    monkeypatch, no_rate_limit, fast_retries,
):
    """The discrimination the shared except block exists to make.

    Zenodo wraps the request and ``response.json()`` in one ``try``. Calling
    every exception there a parse failure would tell the user the source
    answered when it never did.
    """
    import httpx

    from resmon_scripts.implementation_scripts import api_zenodo

    def _boom(self, method, url, **kw):
        raise httpx.ConnectError("no route", request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.Client, "request", _boom)

    api_base.reset_search_outcome()
    results = api_zenodo.ZenodoClient().search(query="alpha", max_results=5)

    assert results == []
    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert reason == "upstream_failure"
    assert detail["detail"] == "connect"


# P4 (NDL's rights gate) and P3 (ERIC and Open Library refusing a sub-year
# window) live in ``test_api_tier1.py``, beside those clients' own fixtures.


# ---------------------------------------------------------------------------
# The engine, the row, the record and the report
# ---------------------------------------------------------------------------
#
# From here down the boundary is the sweep engine driving a real client
# against a real loopback server, and the row it writes being read back out
# through the search record and the report. Nothing between the HTTP call and
# the rendered sentence is stubbed.


import json
import sqlite3

from resmon_scripts.implementation_scripts import (
    credential_manager as cm,
    search_record,
    sweep_engine as se,
)
from resmon_scripts.implementation_scripts.api_base import BaseAPIClient
from resmon_scripts.implementation_scripts.database import (
    get_execution_sources,
    init_db,
)


class _RealHTTPClient(BaseAPIClient):
    """A client that actually goes through safe_request, like every real one."""

    def __init__(self, url):
        self._url = url

    def get_name(self) -> str:
        return "arxiv"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        try:
            response = api_base.safe_request("GET", self._url)
        except Exception:
            return []
        if response.status_code != 200:
            return []
        return []


class _SilentClient(BaseAPIClient):
    """A client that never makes an HTTP call — the not_recorded path."""

    def get_name(self) -> str:
        return "arxiv"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        return []


def _run_dive(monkeypatch, client):
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    monkeypatch.setattr(se, "get_client", lambda _name: client)
    monkeypatch.setattr(cm, "get_credential", lambda _name: "a-key")
    engine = se.SweepEngine(db_conn=conn, config={})
    result = engine.execute_dive("arxiv", {"query": "x", "max_results": 1})
    return conn, result


def test_engine_records_an_outage_as_upstream_failure(
    monkeypatch, http_server, fast_retries,
):
    """P1, through the whole product: 503 → row, task log, record, report.

    Status stays ``ok`` and the result stays ``[]`` — resmon's degrade-don't-
    raise contract is unchanged — but the row now says why.
    """
    http_server.reply = (503, "unavailable")
    conn, result = _run_dive(monkeypatch, _RealHTTPClient(http_server.url))

    row = get_execution_sources(conn, result["execution_id"])[0]
    assert row["status"] == "ok"
    assert row["result_count"] == 0
    assert row["zero_reason"] == "upstream_failure"
    detail = json.loads(row["zero_detail"])
    assert detail["status"] == 503
    assert detail["attempts"] == 3

    expected = (
        "arXiv could not be queried: HTTP 503 after 3 attempts. This is not a "
        "zero — the source did not answer."
    )
    from pathlib import Path

    assert expected in Path(result["log_path"]).read_text(encoding="utf-8")
    assert expected in Path(result["report_path"]).read_text(encoding="utf-8")

    record = search_record.build(conn, result["execution_id"])
    assert record["sources"][0]["note"] == expected
    assert record["identification"]["sources_that_answered"] == 0
    assert any("could not answer" in c for c in record["caveats"])
    conn.close()


def test_engine_records_an_unobserved_zero_as_not_recorded(monkeypatch):
    """P5, through the engine. Mutation: default the reason to answered_empty.

    A client that never called safe_request leaves nothing on the channel, and
    resmon says exactly that rather than inventing an answer for it.
    """
    conn, result = _run_dive(monkeypatch, _SilentClient())

    row = get_execution_sources(conn, result["execution_id"])[0]
    assert row["zero_reason"] == "not_recorded"
    assert row["zero_detail"] is None

    record = search_record.build(conn, result["execution_id"])
    assert record["sources"][0]["note"] == (
        "resmon did not record whether arXiv answered on this run."
    )
    assert record["identification"]["sources_that_answered"] == 0
    assert any("unexplained, not measured" in c for c in record["caveats"])
    conn.close()


def test_a_source_that_answered_with_records_carries_no_reason(
    monkeypatch, http_server, fast_retries,
):
    """The reason is derived only when there is a zero to explain."""

    class _ProductiveClient(BaseAPIClient):
        def get_name(self):
            return "arxiv"

        def search(self, query, date_from=None, date_to=None, max_results=100, **kw):
            api_base.safe_request("GET", self._url)
            from resmon_scripts.implementation_scripts.api_base import (
                NormalizedResult,
            )
            return [NormalizedResult(
                source_repository="arxiv", external_id="1", doi=None,
                title="A paper", authors=["A"], abstract=None,
                publication_date="2024-01-01", url="https://example.org/1",
            )]

    client = _ProductiveClient()
    client._url = http_server.url
    conn, result = _run_dive(monkeypatch, client)

    row = get_execution_sources(conn, result["execution_id"])[0]
    assert row["result_count"] == 1
    assert row["zero_reason"] is None

    record = search_record.build(conn, result["execution_id"])
    assert record["sources"][0]["note"] is None
    assert record["identification"]["sources_that_answered"] == 1
    conn.close()


# ---------------------------------------------------------------------------
# P7 — rows written before the migration
# ---------------------------------------------------------------------------


def test_rows_written_at_schema_9_read_as_not_recorded(tmp_path):
    """A database that predates the columns, migrated, then read.

    The columns are added and the historical rows stay NULL. Nothing is
    backfilled: a reason invented now for a run nobody observed would be the
    exact fabrication this phase exists to prevent.
    """
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    # The schema-9 shape of the two tables this test touches.
    conn.executescript(
        """
        CREATE TABLE executions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_type TEXT NOT NULL,
            status TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT,
            parameters TEXT,
            result_count INTEGER DEFAULT 0,
            new_result_count INTEGER DEFAULT 0,
            result_path TEXT,
            log_path TEXT,
            routine_id INTEGER
        );
        CREATE TABLE execution_sources (
            execution_id INTEGER NOT NULL,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            result_count INTEGER NOT NULL DEFAULT 0,
            error_message TEXT,
            credential_name TEXT,
            recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (execution_id, source)
        );
        INSERT INTO executions (id, execution_type, status, start_time, parameters)
            VALUES (7, 'deep_dive', 'completed', '2026-01-01T00:00:00Z', '{}');
        INSERT INTO execution_sources (execution_id, source, status, result_count)
            VALUES (7, 'arxiv', 'ok', 0);
        """
    )
    conn.commit()

    columns = {r[1] for r in conn.execute("PRAGMA table_info(execution_sources)")}
    assert "zero_reason" not in columns

    init_db(conn=conn)

    row = get_execution_sources(conn, 7)[0]
    assert row["zero_reason"] is None

    record = search_record.build(conn, 7)
    assert record["sources"][0]["zero_reason"] == "not_recorded"
    assert record["sources"][0]["note"] == (
        "resmon did not record whether arXiv answered on this run."
    )
    assert record["identification"]["sources_that_answered"] == 0
    conn.close()


def test_the_search_worker_clears_the_channel_before_it_starts(
    monkeypatch, http_server, fast_retries,
):
    """The reset at the top of the worker, pinned rather than assumed.

    Today the engine gives every search its own fresh thread, so a thread-local
    channel is empty when the worker starts and the reset changes nothing —
    which means removing it fails no other test in this file. That was found by
    mutating it and watching everything stay green.

    The reset is not decoration: ``lifecycle.py`` calls ``safe_request``
    outside any search, and a pooled or reused thread would carry that call's
    outcome into the next source's answer. So the worker is made to run on a
    thread that already has state, which is the only condition under which the
    reset is observable, and asserted to start clean.
    """
    class _InlineThread:
        """Runs the worker on *this* thread, which the test has dirtied."""

        def __init__(self, target, **kwargs):
            self._target = target

        def start(self):
            self._target()

        def is_alive(self):
            return False

        def join(self, timeout=None):
            return None

    # Dirty the current thread's channel the way lifecycle.py would.
    http_server.reply = (503, "unavailable")
    api_base.safe_request("GET", http_server.url)
    assert api_base.search_outcome().snapshot()["failures"] > 0

    monkeypatch.setattr(se.threading, "Thread", _InlineThread)

    results, outcome = se.SweepEngine(
        db_conn=None, config={},
    )._search_with_heartbeat(
        client=_SilentClient(), repo_name="arxiv", exec_id=1, query_params={},
    )

    assert results == []
    assert outcome["failures"] == 0
    assert zero_reason.derive(outcome) == ("not_recorded", {})
