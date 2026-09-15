"""HAL's operation budget, actual HTTPX boundary and truthful source outcomes.

Loopback cases exercise real HTTPX sockets, including a response that keeps
making progress. They cannot reproduce the historical hosted DNS/address stall
or establish a hard real-time guarantee for every OS and DNS executor.
"""
from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import threading
import time
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from implementation_scripts import api_base, api_hal, zero_reason


def document(number: int = 1) -> dict:
    return {"docid": number, "halId_s": f"hal-synthetic-{number}",
            "title_s": [f"Synthetic title {number}"], "authFullName_s": ["Synthetic Author"],
            "abstract_s": ["Synthetic fixture only"], "producedDate_tdate": "2024-04-03T12:00:00Z",
            "uri_s": f"https://hal.science/hal-synthetic-{number}", "domain_s": ["phys"],
            "doiId_s": f"10.0000/synthetic-{number}"}


@pytest.fixture(autouse=True)
def isolated_outcome(monkeypatch):
    api_base.reset_search_outcome()
    monkeypatch.setattr(api_hal, "_RATE_LIMITER", api_base.RateLimiter(1000))
    before = {t.ident for t in threading.enumerate() if t.name == "resmon-request-deadline"}
    yield
    assert {t.ident for t in threading.enumerate() if t.name == "resmon-request-deadline"} == before
    api_base.reset_search_outcome()


@pytest.fixture
def wire(monkeypatch):
    calls = []
    replies = [{"response": {"docs": []}}]

    async def request(self, method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        reply = replies.pop(0) if len(replies) > 1 else replies[0]
        if isinstance(reply, BaseException):
            raise reply
        status, body = reply if isinstance(reply, tuple) else (200, reply)
        return httpx.Response(status, json=body, request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", request)
    return calls, replies


def test_hal_normalizes_real_response_shape_and_preserves_query_window(wire):
    calls, replies = wire
    replies[:] = [{"response": {"docs": [document()]}}]
    results = api_hal.HalClient().search('authFullName_t:"Synthetic Person"', "2024-01-01", "2024-12-31", 3)
    assert len(results) == 1
    item = results[0]
    assert (item.source_repository, item.external_id, item.title, item.author_names) == (
        "hal", "hal-synthetic-1", "Synthetic title 1", ["Synthetic Author"])
    assert item.doi == "10.0000/synthetic-1"
    assert item.publication_date == "2024-04-03"
    assert item.abstract == "Synthetic fixture only" and item.categories == ["phys"]
    assert item.url == "https://hal.science/hal-synthetic-1"
    params = calls[0]["params"]
    assert params["q"] == 'authFullName_t:"Synthetic Person"'
    assert params["rows"] == 3 and params["start"] == 0
    assert params["fq"] == "producedDate_tdate:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59Z]"
    assert api_base.search_outcome().snapshot()["attempts"] == 1
    assert api_base.search_outcome().snapshot()["last_call_failed"] is False


def test_valid_empty_is_an_answer(wire):
    assert api_hal.HalClient().search("synthetic", max_results=3) == []
    assert zero_reason.derive(api_base.search_outcome().snapshot()) == ("answered_empty", {"attempts": 1})


@pytest.mark.parametrize("body", [{}, [], {"response": []}, {"response": {"docs": {}}}, {"response": None}])
def test_malformed_response_is_not_answered_empty(wire, body):
    wire[1][:] = [body]
    assert api_hal.HalClient().search("synthetic", max_results=3) == []
    assert zero_reason.derive(api_base.search_outcome().snapshot())[0] == "parse_failure"


def test_pagination_keeps_a_single_budget_and_exact_maximum(wire, monkeypatch):
    calls, replies = wire
    replies[:] = [{"response": {"docs": [document(i) for i in range(100)]}},
                  {"response": {"docs": [document(100)]}}]
    deadlines = []
    original = api_hal.safe_request

    def observed(*args, **kwargs):
        deadlines.append(kwargs["deadline"])
        return original(*args, **kwargs)

    monkeypatch.setattr(api_hal, "safe_request", observed)
    results = api_hal.HalClient().search("synthetic", max_results=101)
    assert len(results) == 101 and len(calls) == 2
    assert [c["params"]["start"] for c in calls] == [0, 100]
    assert [c["params"]["rows"] for c in calls] == [100, 1]
    assert deadlines[0] == deadlines[1]


def test_partial_page_results_survive_later_failure_without_empty_success(wire, monkeypatch):
    monkeypatch.setattr(api_hal, "_MAX_RETRIES", 0)
    wire[1][:] = [{"response": {"docs": [document(), {}]}}, (503, {})]
    results = api_hal.HalClient().search("synthetic", max_results=2)
    assert [r.external_id for r in results] == ["hal-synthetic-1"]
    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["attempts"] == 2 and snapshot["failures"] == 1
    assert snapshot["last_call_failed"] is True and snapshot["last_status"] == 503


@pytest.mark.parametrize("error", [httpx.ConnectTimeout, httpx.ReadTimeout, httpx.ConnectError])
def test_controlled_retry_exhaustion_is_bounded_and_truthful(wire, error):
    wire[1][:] = [error("synthetic controlled failure")]
    began = time.monotonic()
    assert api_hal.HalClient().search("synthetic", max_results=3) == []
    elapsed = time.monotonic() - began
    snapshot = api_base.search_outcome().snapshot()
    assert len(wire[0]) == snapshot["attempts"] == 2
    assert snapshot["failures"] == 1 and snapshot["last_call_failed"] is True
    assert zero_reason.derive(snapshot)[0] == "upstream_failure"
    assert elapsed < 4


def test_backoff_cannot_start_an_attempt_after_budget(wire, monkeypatch):
    monkeypatch.setattr(api_hal, "_SEARCH_BUDGET_SECONDS", 0.2)
    wire[1][:] = [(503, {})]
    began = time.monotonic()
    assert api_hal.HalClient().search("synthetic", max_results=3) == []
    snapshot = api_base.search_outcome().snapshot()
    assert len(wire[0]) == snapshot["attempts"] == 1
    assert snapshot["last_detail"] == "operation_deadline" and snapshot["failures"] == 1
    assert time.monotonic() - began < 1


@pytest.mark.parametrize("busy", ["lock", "slot"])
def test_limiter_expiry_does_not_invent_http_attempt(wire, monkeypatch, busy):
    limiter = api_base.RateLimiter(0.1)
    monkeypatch.setattr(api_hal, "_RATE_LIMITER", limiter)
    monkeypatch.setattr(api_hal, "_SEARCH_BUDGET_SECONDS", 0.1)
    if busy == "lock":
        limiter._lock.acquire()
    else:
        limiter._last_call = time.monotonic()
    try:
        began = time.monotonic()
        assert api_hal.HalClient().search("synthetic", max_results=3) == []
        assert time.monotonic() - began < 0.8
    finally:
        if busy == "lock":
            limiter._lock.release()
    snapshot = api_base.search_outcome().snapshot()
    assert wire[0] == [] and snapshot["attempts"] == 0
    assert snapshot["last_call_failed"] is True and snapshot["failures"] == 1
    assert zero_reason.derive(snapshot)[0] == "upstream_failure"


def test_expiry_after_success_keeps_real_attempt_count(wire):
    api_base.safe_request("GET", api_hal._HAL_API_URL, deadline=time.monotonic() + 2)
    with pytest.raises(api_base.RequestDeadlineExceeded):
        api_base.safe_request("GET", api_hal._HAL_API_URL, deadline=time.monotonic() - 1)
    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["attempts"] == len(wire[0]) == 1
    assert snapshot["failures"] == 1 and snapshot["last_call_failed"] is True


def test_sync_client_works_inside_an_existing_event_loop(wire):
    wire[1][:] = [{"response": {"docs": [document()]}}]
    async def call():
        return api_hal.HalClient().search("synthetic", max_results=1)
    assert len(asyncio.run(call())) == 1


def test_legacy_request_keeps_sync_transport_and_defaults(monkeypatch):
    calls = []
    def request(self, method, url, **kwargs):
        calls.append((self.timeout, kwargs))
        return httpx.Response(200, json={}, request=httpx.Request(method, url))
    async def unexpected(*args, **kwargs):
        raise AssertionError("Non-opt-in caller changed transport")
    monkeypatch.setattr(httpx.Client, "request", request)
    monkeypatch.setattr(httpx.AsyncClient, "request", unexpected)
    assert api_base.safe_request("GET", "https://synthetic.invalid/").status_code == 200
    assert len(calls) == 1
    assert calls[0][0].connect == api_base.config.DEFAULT_REQUEST_TIMEOUT
    assert api_base.search_outcome().snapshot()["attempts"] == 1


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.server.hits.append({"query": parse_qs(urlsplit(self.path).query), "at": time.monotonic()})
        if self.server.mode == "stall":
            self.connection.settimeout(2)
            try:
                if self.connection.recv(1) == b"":
                    self.server.closed.set()
            except (OSError, TimeoutError):
                pass
            return
        if self.server.mode == "trickle":
            self.send_response(200)
            self.send_header("Content-Length", "10000")
            self.end_headers()
            until = time.monotonic() + 2
            while time.monotonic() < until and not self.server.stop.is_set():
                try:
                    self.wfile.write(b" "); self.wfile.flush()
                    self.server.chunks += 1
                except OSError:
                    self.server.closed.set()
                    return
                time.sleep(0.02)
            return
        body = json.dumps({"response": {"docs": [document()]}}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "application/json")
        self.end_headers(); self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


@pytest.fixture
def server(monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.hits = []; server.closed = threading.Event(); server.stop = threading.Event()
    server.mode = "success"; server.chunks = 0
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), name="hal-loopback-fixture")
    thread.start()
    monkeypatch.setattr(api_hal, "_HAL_API_URL", f"http://127.0.0.1:{server.server_address[1]}/search/")
    try:
        yield server
    finally:
        server.stop.set(); server.shutdown(); server.server_close(); thread.join()


def test_real_httpx_loopback_success(server):
    results = api_hal.HalClient().search("synthetic", max_results=1)
    assert len(results) == len(server.hits) == 1
    assert results[0].external_id == "hal-synthetic-1"


@pytest.mark.parametrize("mode", ["stall", "trickle"])
def test_real_httpx_operation_deadline_closes_transport(server, monkeypatch, mode):
    server.mode = mode
    monkeypatch.setattr(api_hal, "_SEARCH_BUDGET_SECONDS", 0.35)
    monkeypatch.setattr(api_hal, "_REQUEST_TIMEOUT_SECONDS", 1.0)
    began = time.monotonic()
    assert api_hal.HalClient().search("synthetic", max_results=3) == []
    elapsed = time.monotonic() - began
    assert 0.25 <= elapsed < 1.1
    assert server.closed.wait(0.6), "remote end did not observe the cancelled transport closing"
    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["attempts"] == len(server.hits) == 1
    assert snapshot["failures"] == 1 and snapshot["last_detail"] == "operation_deadline"
    if mode == "trickle":
        assert server.chunks >= 3, "fixture did not challenge a progressing response"


def test_real_httpx_read_timeout_exhausts_retry_before_watchdog(server, monkeypatch):
    server.mode = "stall"
    monkeypatch.setattr(api_hal, "_REQUEST_TIMEOUT_SECONDS", 0.08)
    began = time.monotonic()
    assert api_hal.HalClient().search("synthetic", max_results=3) == []
    elapsed = time.monotonic() - began
    snapshot = api_base.search_outcome().snapshot()
    assert len(server.hits) == snapshot["attempts"] == 2
    assert snapshot["last_detail"] == "timeout" and snapshot["failures"] == 1
    assert server.closed.is_set() and elapsed < 4


def test_real_owned_connect_failure_is_bounded_and_truthful(monkeypatch):
    with socket.socket() as bound:
        bound.bind(("127.0.0.1", 0))
        monkeypatch.setattr(api_hal, "_HAL_API_URL", f"http://127.0.0.1:{bound.getsockname()[1]}/search/")
        monkeypatch.setattr(api_hal, "_MAX_RETRIES", 0)
        monkeypatch.setattr(api_hal, "_REQUEST_TIMEOUT_SECONDS", 0.1)
        began = time.monotonic()
        assert api_hal.HalClient().search("synthetic", max_results=3) == []
        assert time.monotonic() - began < 1.5
    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["attempts"] == 1 and snapshot["last_detail"] in {"connect", "timeout"}
    assert zero_reason.derive(snapshot)[0] == "upstream_failure"


def test_operation_expiry_sentence_does_not_invent_a_network_request(wire):
    with pytest.raises(api_base.RequestDeadlineExceeded):
        api_base.safe_request("GET", api_hal._HAL_API_URL, deadline=time.monotonic() - 1)
    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert detail["attempts"] == 0 and wire[0] == []
    assert detail["detail"] == "operation_deadline"
    sentence = zero_reason.sentence("HAL", reason, detail)
    assert "search operation budget expired after 0 attempts" in sentence
    assert "request timed out" not in sentence


def test_full_unusable_pages_stop_at_the_shared_operation_budget(wire, monkeypatch):
    monkeypatch.setattr(api_hal, "_SEARCH_BUDGET_SECONDS", 0.3)
    wire[1][:] = [{"response": {"docs": [{}]}}]
    began = time.monotonic()
    assert api_hal.HalClient().search("synthetic", max_results=1) == []
    assert time.monotonic() - began < 1.5
    assert wire[0]
    assert [c["params"]["start"] for c in wire[0]] == list(range(len(wire[0])))
    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["last_detail"] == "operation_deadline"
    assert snapshot["attempts"] == len(wire[0])


@pytest.mark.parametrize("error", [httpx.ReadError, httpx.RemoteProtocolError, httpx.ProxyError])
def test_nonretryable_transport_failure_stays_truthful(wire, error):
    wire[1][:] = [error("synthetic controlled failure")]
    assert api_hal.HalClient().search("synthetic", max_results=3) == []
    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["attempts"] == len(wire[0]) == 1
    assert snapshot["last_detail"] == "request_error" and snapshot["last_call_failed"]
    assert zero_reason.derive(snapshot)[0] == "upstream_failure"


def test_live_success_assertion_rejects_an_empty_list(monkeypatch):
    from resmon_scripts.verification_scripts import test_api_tier2_3 as live_checks
    class EmptyClient:
        def search(self, **kwargs):
            return []
    monkeypatch.setattr(live_checks, "get_client", lambda slug: EmptyClient())
    with pytest.raises(AssertionError, match="HAL did not return usable records"):
        live_checks.test_hal_search()


def test_expiry_during_client_setup_does_not_count_an_http_request(wire, monkeypatch):
    entered = threading.Event()

    async def slow_setup(self):
        entered.set()
        await asyncio.sleep(1)
        return self

    monkeypatch.setattr(httpx.AsyncClient, "__aenter__", slow_setup)
    with pytest.raises(api_base.RequestDeadlineExceeded):
        api_base.safe_request("GET", api_hal._HAL_API_URL,
                              deadline=time.monotonic() + 0.1)
    assert entered.is_set() and wire[0] == []
    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["attempts"] == 0 and snapshot["failures"] == 1
    assert snapshot["last_detail"] == "operation_deadline"
    assert zero_reason.derive(snapshot)[0] == "upstream_failure"
