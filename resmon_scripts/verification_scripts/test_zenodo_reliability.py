"""Zenodo's shared search budget and truthful synthetic HTTP outcomes.

Owned loopback cases exercise HTTPX cancellation and joined transport threads.
They do not establish upstream availability or hard DNS/CPU/OS timing bounds.
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from implementation_scripts import api_base, api_zenodo, zero_reason


def record(number: int = 1) -> dict:
    return {
        "id": number, "doi": f"10.0000/synthetic-{number}",
        "metadata": {
            "title": f" Synthetic title {number} ",
            "creators": [{"name": " Synthetic Author "}],
            "description": "<p>Synthetic <b>fixture</b> &amp; text.</p>",
            "publication_date": "2024-04-03",
            "keywords": [" climate "], "resource_type": {"title": "Dataset"},
        },
        "links": {"self_html": f"https://zenodo.org/records/{number}"},
    }


def page(records: list, total: object = 100) -> dict:
    return {"hits": {"hits": records, "total": total}}


@pytest.fixture(autouse=True)
def isolated_outcome(monkeypatch):
    api_base.reset_search_outcome()
    monkeypatch.setattr(api_zenodo, "_RATE_LIMITER", api_base.RateLimiter(1000))
    before = {t.ident for t in threading.enumerate() if t.name == "resmon-request-deadline"}
    yield
    assert {t.ident for t in threading.enumerate() if t.name == "resmon-request-deadline"} == before
    api_base.reset_search_outcome()


@pytest.fixture
def wire(monkeypatch):
    calls: list[dict] = []
    replies: list = [page([], 0)]

    async def request(self, method, url, **kwargs):
        calls.append({"method": method, "url": url, "timeout": self.timeout, **kwargs})
        reply = replies.pop(0) if len(replies) > 1 else replies[0]
        if isinstance(reply, BaseException):
            raise reply
        status, body = reply if isinstance(reply, tuple) else (200, reply)
        if isinstance(body, bytes):
            return httpx.Response(status, content=body, request=httpx.Request(method, url))
        return httpx.Response(status, json=body, request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.AsyncClient, "request", request)
    return calls, replies


def test_normalization_and_field_query_survive(wire):
    wire[1][:] = [page([record()], {"value": 1})]
    results = api_zenodo.ZenodoClient().search('creators.name:"Synthetic Person"', "2024-01-01", "2024-12-31", 3)
    assert len(results) == 1
    item = results[0]
    assert (item.source_repository, item.external_id, item.title, item.author_names) == (
        "zenodo", "1", "Synthetic title 1", ["Synthetic Author"])
    assert item.doi == "10.0000/synthetic-1"
    assert item.abstract == "Synthetic fixture & text."
    assert item.publication_date == "2024-04-03"
    assert item.categories == ["climate", "Dataset"]
    assert item.url == "https://zenodo.org/records/1"
    assert wire[0][0]["params"] == {
        "q": '(creators.name:"Synthetic Person") AND publication_date:[2024-01-01 TO 2024-12-31]',
        "size": 3, "page": 1, "sort": "bestmatch",
    }
    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == 1 and not outcome["last_call_failed"]
    assert outcome["explicit_reason"] is None


@pytest.mark.parametrize("query,start,end,expected", [
    (" ", "2024-01-01", None, "publication_date:[2024-01-01 TO *]"),
    ("climate", None, "2024-12-31", "(climate) AND publication_date:[* TO 2024-12-31]"),
    (" climate ", None, None, "climate"),
])
def test_open_date_bounds_and_trimmed_query(wire, query, start, end, expected):
    api_zenodo.ZenodoClient().search(query, start, end, 3)
    assert wire[0][0]["params"]["q"] == expected


def test_every_page_uses_one_deadline_and_fixed_page_size(wire, monkeypatch):
    wire[1][:] = [page([record(i) for i in range(25)]), page([record(i) for i in range(25, 50)])]
    options = []
    original = api_zenodo.safe_request

    def observed(*args, **kwargs):
        options.append(kwargs.copy())
        return original(*args, **kwargs)

    monkeypatch.setattr(api_zenodo, "safe_request", observed)
    began = time.monotonic()
    results = api_zenodo.ZenodoClient().search("synthetic", max_results=30)
    assert [r.external_id for r in results] == [str(i) for i in range(30)]
    assert [c["params"]["page"] for c in wire[0]] == [1, 2]
    assert [c["params"]["size"] for c in wire[0]] == [25, 25]
    assert len(options) == 2 and options[0]["deadline"] == options[1]["deadline"]
    assert 44.9 <= options[0]["deadline"] - began <= 45.1
    assert all(o["timeout"] == 10.0 and o["max_retries"] == 1 for o in options)
    assert all(o["rate_limiter"] is api_zenodo._RATE_LIMITER for o in options)
    assert all(c["timeout"].read == 10.0 for c in wire[0])


@pytest.mark.parametrize("maximum", [0, -1])
def test_nonpositive_maximum_makes_no_attempt(wire, maximum):
    assert api_zenodo.ZenodoClient().search("synthetic", max_results=maximum) == []
    assert wire[0] == [] and api_base.search_outcome().snapshot()["attempts"] == 0


def test_valid_empty_is_distinct_from_failure(wire):
    assert api_zenodo.ZenodoClient().search("synthetic") == []
    assert zero_reason.derive(api_base.search_outcome().snapshot()) == ("answered_empty", {"attempts": 1})


@pytest.mark.parametrize("body", [[], {}, {"hits": []}, {"hits": {}}, {"hits": {"hits": {}}}, b"not JSON"])
def test_malformed_response_is_not_answered_empty(wire, body):
    wire[1][:] = [body]
    assert api_zenodo.ZenodoClient().search("synthetic") == []
    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == 1 and outcome["last_call_failed"] is False
    assert zero_reason.derive(outcome)[0] == "parse_failure"


@pytest.mark.parametrize("reply,reason", [( (503, {}), "upstream_failure"), ({}, "parse_failure")])
def test_partial_results_keep_the_later_failure(wire, reply, reason):
    # A full raw page containing skipped records still advances the page index.
    wire[1][:] = [page([record()] + [{}] * 24), reply]
    results = api_zenodo.ZenodoClient().search("synthetic", max_results=30)
    assert [r.external_id for r in results] == ["1"]
    outcome = api_base.search_outcome().snapshot()
    assert zero_reason.derive(outcome)[0] == reason
    assert outcome["attempts"] == (3 if reason == "upstream_failure" else 2)
    if reason == "upstream_failure":
        assert outcome["last_call_failed"] is True and outcome["last_status"] == 503


@pytest.mark.parametrize("reply,reason", [
    ((429, {}), "upstream_failure"), ((503, {}), "upstream_failure"),
    (httpx.ReadTimeout("synthetic"), "upstream_failure"),
    (httpx.ConnectError("synthetic"), "upstream_failure"),
])
def test_one_retry_exhaustion_is_truthful(wire, reply, reason):
    wire[1][:] = [reply]
    assert api_zenodo.ZenodoClient().search("synthetic") == []
    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == len(wire[0]) == 2
    assert outcome["failures"] == 1 and outcome["last_call_failed"] is True
    assert zero_reason.derive(outcome)[0] == reason


def test_retry_recovery_retains_actual_success(wire):
    wire[1][:] = [(503, {}), page([record()], 1)]
    assert len(api_zenodo.ZenodoClient().search("synthetic")) == 1
    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == 2 and outcome["last_call_failed"] is False
    assert outcome["explicit_reason"] is None


def test_backoff_expiry_does_not_start_a_second_attempt(wire, monkeypatch):
    monkeypatch.setattr(api_zenodo, "_SEARCH_BUDGET_SECONDS", 0.15)
    wire[1][:] = [(503, {})]
    began = time.monotonic()
    assert api_zenodo.ZenodoClient().search("synthetic") == []
    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == len(wire[0]) == 1
    assert outcome["last_detail"] == "operation_deadline" and outcome["failures"] == 1
    assert time.monotonic() - began < 0.9


@pytest.mark.parametrize("busy", ["lock", "slot"])
def test_limiter_budget_does_not_invent_an_attempt(wire, monkeypatch, busy):
    limiter = api_base.RateLimiter(0.1)
    monkeypatch.setattr(api_zenodo, "_RATE_LIMITER", limiter)
    monkeypatch.setattr(api_zenodo, "_SEARCH_BUDGET_SECONDS", 0.1)
    if busy == "lock":
        limiter._lock.acquire()
    else:
        limiter._last_call = time.monotonic()
    try:
        assert api_zenodo.ZenodoClient().search("synthetic") == []
    finally:
        if busy == "lock":
            limiter._lock.release()
    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == 0 and wire[0] == []
    assert outcome["last_detail"] == "operation_deadline"
    assert zero_reason.derive(outcome)[0] == "upstream_failure"


def test_later_page_cannot_reset_budget(wire, monkeypatch):
    monkeypatch.setattr(api_zenodo, "_SEARCH_BUDGET_SECONDS", 0.15)
    monkeypatch.setattr(api_zenodo, "_RATE_LIMITER", api_base.RateLimiter(1))
    wire[1][:] = [page([record(i) for i in range(25)])]
    began = time.monotonic()
    results = api_zenodo.ZenodoClient().search("synthetic", max_results=30)
    assert len(results) == 25 and len(wire[0]) == 1
    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == 1 and outcome["last_detail"] == "operation_deadline"
    assert time.monotonic() - began < 0.9


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.server.hits.append(parse_qs(urlsplit(self.path).query))
        if self.server.mode == "stall":
            self.connection.settimeout(3)
            try:
                if self.connection.recv(1) == b"":
                    self.server.closed.set()
            except OSError:
                pass
            return
        if self.server.mode == "trickle":
            self.send_response(200)
            self.send_header("Content-Length", "10000")
            self.end_headers()
            until = time.monotonic() + 3
            while time.monotonic() < until and not self.server.stop.is_set():
                try:
                    self.wfile.write(b" ")
                    self.wfile.flush()
                    self.server.chunks += 1
                except OSError:
                    self.server.closed.set()
                    return
                time.sleep(0.02)
            return
        status = 503 if self.server.mode == "failure" else 200
        body = b"not JSON" if self.server.mode == "malformed" else json.dumps(page([record()], 1)).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


@pytest.fixture
def server(monkeypatch):
    owned = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    owned.hits = []
    owned.closed = threading.Event()
    owned.stop = threading.Event()
    owned.mode = "success"
    owned.chunks = 0
    assert owned.server_address[1] != 8742
    thread = threading.Thread(target=lambda: owned.serve_forever(poll_interval=0.01), name="zenodo-loopback-fixture")
    thread.start()
    monkeypatch.setattr(api_zenodo, "_ZENODO_API_URL", f"http://127.0.0.1:{owned.server_address[1]}/records")
    try:
        yield owned
    finally:
        owned.stop.set()
        owned.shutdown()
        owned.server_close()
        thread.join()
        assert not thread.is_alive() and owned.socket.fileno() == -1


def test_real_httpx_loopback_success(server):
    results = api_zenodo.ZenodoClient().search("synthetic", max_results=1)
    assert len(results) == len(server.hits) == 1 and results[0].external_id == "1"
    assert server.hits[0]["size"] == ["1"]


@pytest.mark.parametrize("mode", ["stall", "trickle"])
def test_real_httpx_deadline_cancels_and_closes_transport(server, monkeypatch, mode):
    server.mode = mode
    monkeypatch.setattr(api_zenodo, "_SEARCH_BUDGET_SECONDS", 0.35)
    monkeypatch.setattr(api_zenodo, "_REQUEST_TIMEOUT_SECONDS", 1.0)
    began = time.monotonic()
    assert api_zenodo.ZenodoClient().search("synthetic", max_results=3) == []
    elapsed = time.monotonic() - began
    assert 0.25 <= elapsed < 1.1
    assert server.closed.wait(0.6), "owned server did not observe transport closure"
    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == len(server.hits) == 1
    assert outcome["last_detail"] == "operation_deadline" and outcome["failures"] == 1
    assert zero_reason.derive(outcome)[0] == "upstream_failure"
    if mode == "trickle":
        assert server.chunks >= 3, "fixture did not challenge a progressing response"


@pytest.mark.parametrize("mode,reason,attempts", [("failure", "upstream_failure", 2), ("malformed", "parse_failure", 1)])
def test_real_httpx_failure_is_not_an_empty_answer(server, mode, reason, attempts):
    server.mode = mode
    assert api_zenodo.ZenodoClient().search("synthetic") == []
    outcome = api_base.search_outcome().snapshot()
    assert len(server.hits) == outcome["attempts"] == attempts
    assert zero_reason.derive(outcome)[0] == reason
