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
