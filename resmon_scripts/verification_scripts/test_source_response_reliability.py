"""Response-contract regressions for bioRxiv/medRxiv, ERIC and DBLP.

Owned loopback cases use the production HTTPX path. Deterministic cases cover
provider shapes and pagination without claiming that a public provider is up.
"""

from __future__ import annotations

import email.utils
import json
import math
import sys
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import (  # noqa: E402
    api_base, api_biorxiv, api_dblp, api_eric, api_oapen,
)


class FakeResponse:
    def __init__(self, payload=None, *, status_code=200, json_error=None,
                 text="", content_type="application/json"):
        self._payload = payload
        self._json_error = json_error
        self.status_code = status_code
        self.text = text
        self.headers = {"content-type": content_type}

    def json(self):
        if self._json_error is not None:
            raise self._json_error
        return self._payload


def _recording_sequence(monkeypatch, module, replies):
    queue = list(replies)
    calls = []

    def request(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        outcome = api_base.search_outcome()
        outcome.note_attempt()
        reply = queue.pop(0)
        if isinstance(reply, BaseException):
            outcome.note_failure(reply, url)
            raise reply
        if not 200 <= reply.status_code < 300:
            outcome.note_failure(reply.status_code, url)
        return reply

    monkeypatch.setattr(module, "safe_request", request)
    return calls


def _preprint_payload(server="biorxiv", *, count=1, total=None, start=0):
    if total is None:
        total = count
    records = []
    for index in range(start, start + count):
        records.append({
            "doi": f"10.1101/2024.01.01.{index:06d}",
            "title": f"Climate record {index}",
            "authors": "Doe, Jane; Rao, Priya",
            "abstract": "Climate observations",
            "date": "2024-01-02",
            "category": "Scientific Communication",
            "server": server,
        })
    return {
        "messages": [{"status": "ok", "total": total}],
        "collection": records,
    }


def _eric_payload():
    return {"response": {"numFound": 1, "docs": [{
        "id": "EJ1234567",
        "title": "Climate education",
        "author": ["Doe, Jane"],
        "description": "A study",
        "publicationdateyear": 2024,
        "subject": ["Climate"],
        "url": "https://doi.org/10.1000/eric.1",
    }]}}


def _dblp_payload():
    return {"result": {"hits": {"@total": "1", "hit": [{"info": {
        "key": "journals/test/Record24",
        "title": "Climate Computing.",
        "year": "2024",
        "authors": {"author": [{"text": "Yoshua Bengio"}]},
        "url": "https://dblp.org/rec/journals/test/Record24",
        "venue": "Test Journal",
    }}]}}}


def _oapen_record(handle="20.500.12657/100210", year="2024"):
    return {
        "handle": handle,
        "name": "Water and fire",
        "type": "item",
        "withdrawn": "false",
        "metadata": [
            {"key": "dc.date.issued", "value": year},
            {"key": "dc.contributor.author", "value": "A. Author"},
        ],
    }


def test_retry_after_parser_accepts_rfc_forms_and_refuses_unsafe_values():
    now = datetime(2026, 9, 18, tzinfo=timezone.utc)
    response = lambda value: SimpleNamespace(headers={"Retry-After": value})

    assert api_base._retry_after_seconds(response("3"), now=now) == 3.0
    assert api_base._retry_after_seconds(
        response("0" * 5000 + "3"), now=now) == 3.0
    assert api_base._retry_after_seconds(
        response(email.utils.format_datetime(now + timedelta(seconds=5), usegmt=True)),
        now=now,
    ) == 5.0
    for value in ("-1", "1.5", "nan", "not-a-date"):
        assert api_base._retry_after_seconds(response(value), now=now) is None
    assert math.isinf(api_base._retry_after_seconds(response("9" * 80), now=now))


def test_safe_request_without_limiter_refuses_unbounded_retry_after(monkeypatch):
    response = FakeResponse(status_code=503)
    response.headers["Retry-After"] = "9" * 80
    calls = []

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def request(self, method, url, **kwargs):
            calls.append((method, url, kwargs))
            return response

    monkeypatch.setattr(api_base.httpx, "Client", Client)
    began = time.monotonic()
    with pytest.raises(api_base.ServerCooldownActive):
        api_base.safe_request(
            "GET", "https://example.test/records", max_retries=1,
            backoff_base=0.01,
        )

    snapshot = api_base.search_outcome().snapshot()
    assert time.monotonic() - began < 0.5
    assert len(calls) == snapshot["attempts"] == 1
    assert snapshot["failures"] == 1
    assert snapshot["last_status"] == 503
    assert snapshot["retained_cooldown_status"] is None


def test_rate_limiter_keeps_longest_cooldown_and_refuses_over_budget():
    limiter = api_base.RateLimiter(1000)
    limiter.defer(0.2, status_code=503)
    limiter.defer(0.05, status_code=429)

    with pytest.raises(api_base.ServerCooldownActive) as blocked:
        limiter.acquire(deadline=time.monotonic() + 0.05)
    assert blocked.value.status_code == 503

    began = time.monotonic()
    limiter.acquire(deadline=began + 0.5)
    assert time.monotonic() - began >= 0.14


def test_rate_limiter_waiter_observes_concurrent_longer_cooldown(monkeypatch):
    limiter = api_base.RateLimiter(20)
    limiter._last_call = time.monotonic()
    admitted = []
    entered_wait = threading.Event()
    original_wait = limiter._condition.wait

    def observed_wait(timeout=None):
        entered_wait.set()
        return original_wait(timeout)

    monkeypatch.setattr(limiter._condition, "wait", observed_wait)

    def acquire():
        limiter.acquire(deadline=time.monotonic() + 1.0)
        admitted.append(time.monotonic())

    began = time.monotonic()
    thread = threading.Thread(target=acquire)
    thread.start()
    assert entered_wait.wait(timeout=0.5), "waiter never entered Condition.wait"
    limiter.defer(0.2, status_code=503)
    limiter.defer(0.05, status_code=429)
    thread.join(timeout=1.0)

    assert not thread.is_alive()
    assert len(admitted) == 1
    assert admitted[0] - began >= 0.18


def test_retained_retry_after_blocks_a_new_search_without_new_attempt(monkeypatch):
    limiter = api_base.RateLimiter(1000)
    limiter.defer(5.0, status_code=429)
    calls = []

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def request(self, *args, **kwargs):
            calls.append((args, kwargs))
            raise AssertionError("cooldown must stop transport")

    monkeypatch.setattr(api_base.httpx, "Client", Client)
    with pytest.raises(api_base.ServerCooldownActive):
        api_base.safe_request(
            "GET", "https://example.test/records", rate_limiter=limiter,
            deadline=time.monotonic() + 0.05,
        )

    snapshot = api_base.search_outcome().snapshot()
    assert calls == []
    assert snapshot["attempts"] == 0
    assert snapshot["failures"] == 0
    assert snapshot["last_call_failed"] is False
    assert snapshot["retained_cooldown_status"] == 429


def test_new_retry_attempt_clears_stale_pending_response_status(monkeypatch):
    limiter = api_base.RateLimiter(1000)
    replies = [FakeResponse(status_code=503), "timeout"]

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def request(self, method, url, **_kwargs):
            reply = replies.pop(0)
            if reply == "timeout":
                # A concurrent response publishes a cooldown while this newer
                # transport fails. The earlier 503 no longer represents the
                # pending attempt when the following admission is blocked.
                limiter.defer(5.0, status_code=429)
                raise api_base.httpx.ReadTimeout(
                    "synthetic", request=api_base.httpx.Request(method, url))
            return reply

    monkeypatch.setattr(api_base.httpx, "Client", Client)
    monkeypatch.setattr(api_base.time, "sleep", lambda _seconds: None)

    with pytest.raises(api_base.ServerCooldownActive):
        api_base.safe_request(
            "GET", "https://example.test/records", rate_limiter=limiter,
            max_retries=2,
        )

    snapshot = api_base.search_outcome().snapshot()
    assert replies == []
    assert snapshot["attempts"] == 2
    assert snapshot["failures"] == 0
    assert snapshot["last_status"] is None
    assert snapshot["retained_cooldown_status"] == 429


@pytest.fixture(autouse=True)
def _fresh_outcome():
    api_base.reset_search_outcome()


@pytest.mark.parametrize("slug", ["biorxiv", "medrxiv", "eric", "dblp"])
def test_unreadable_reply_retries_once_then_keeps_success(monkeypatch, slug):
    bad = FakeResponse(json_error=json.JSONDecodeError("empty", "", 0))
    if slug in {"biorxiv", "medrxiv"}:
        module = api_biorxiv
        payload = _preprint_payload(slug)
        client = api_biorxiv.BiorxivClient(slug)
        kwargs = {"query": "climate", "date_from": "2024-01-01",
                  "date_to": "2024-01-07", "max_results": 1}
    elif slug == "eric":
        module = api_eric
        payload = _eric_payload()
        client = api_eric.EricClient()
        kwargs = {"query": "climate", "date_from": "2024-01-01",
                  "date_to": "2024-12-31", "max_results": 1}
    else:
        module = api_dblp
        payload = _dblp_payload()
        client = api_dblp.DblpClient()
        kwargs = {"query": 'author:"Yoshua Bengio"', "max_results": 1}

    calls = _recording_sequence(
        monkeypatch, module, [bad, FakeResponse(payload)],
    )
    results = client.search(**kwargs)
    outcome = api_base.search_outcome().snapshot()

    assert len(calls) == 2
    assert len(results) == 1 and results[0].source_repository == slug
    assert outcome["attempts"] == 2
    assert outcome["last_call_failed"] is False
    assert outcome["explicit_reason"] is None


def test_biorxiv_uses_documented_thirty_record_cursor_pages(monkeypatch):
    calls = _recording_sequence(monkeypatch, api_biorxiv, [
        FakeResponse(_preprint_payload(count=30, total=60, start=0)),
        FakeResponse(_preprint_payload(count=30, total=60, start=30)),
    ])

    results = api_biorxiv.BiorxivClient().search(
        query="climate", date_from="2024-01-01", date_to="2024-01-07",
        max_results=31,
    )

    assert len(results) == 31
    assert [call["url"].rsplit("/", 1)[-1] for call in calls] == ["0", "30"]
    assert calls[0]["deadline"] == calls[1]["deadline"]
    assert all(call["timeout"] == 10.0 and call["max_retries"] == 0
               for call in calls)


def test_partial_preprint_results_retain_later_parse_failure(monkeypatch):
    unreadable = FakeResponse(json_error=json.JSONDecodeError("empty", "", 0))
    _recording_sequence(monkeypatch, api_biorxiv, [
        FakeResponse(_preprint_payload(count=30, total=60)),
        unreadable,
        unreadable,
    ])

    results = api_biorxiv.BiorxivClient().search(
        query="climate", max_results=60,
        date_from="2024-01-01", date_to="2024-01-07",
    )
    outcome = api_base.search_outcome().snapshot()

    assert len(results) == 30
    assert outcome["attempts"] == 3
    assert outcome["explicit_reason"] == "parse_failure"
    assert outcome["explicit_detail"] == {"detail": "empty_or_invalid_json"}


def test_oapen_uses_json_negotiation_and_one_deadline_across_pages(monkeypatch):
    monkeypatch.setattr(api_oapen, "_PAGE_SIZE", 1)
    calls = _recording_sequence(monkeypatch, api_oapen, [
        FakeResponse([_oapen_record()]),
        FakeResponse([_oapen_record("20.500.12657/85023")]),
    ])

    rows = api_oapen.OapenClient().search("water", max_results=2)

    assert len(rows) == 2
    assert [call["params"]["offset"] for call in calls] == [0, 1]
    assert calls[0]["deadline"] == calls[1]["deadline"]
    assert all(call["headers"] == {"Accept": "application/json"} for call in calls)
    assert all(call["timeout"] == 20.0 and call["max_retries"] == 1 for call in calls)


@pytest.mark.parametrize("module,client,payload", [
    (api_biorxiv, api_biorxiv.BiorxivClient(), {"messages": {}, "collection": []}),
    (api_eric, api_eric.EricClient(), {"response": {"docs": {}}}),
    (api_dblp, api_dblp.DblpClient(), {"result": {"hits": {}}}),
    (api_dblp, api_dblp.DblpClient(), {
        "result": {"hits": {"@total": "1"}},
    }),
])
def test_malformed_nested_shape_is_not_answered_empty(
    monkeypatch, module, client, payload,
):
    _recording_sequence(monkeypatch, module, [FakeResponse(payload)])

    assert client.search(query="climate", max_results=1) == []
    outcome = api_base.search_outcome().snapshot()
    assert outcome["explicit_reason"] == "parse_failure"
    assert outcome["explicit_detail"] == {"detail": "malformed_json_shape"}


@pytest.mark.parametrize("module,client,payload", [
    (api_biorxiv, api_biorxiv.BiorxivClient(), {
        "messages": [{"status": "ok", "total": 1}],
        "collection": [{"title": {"unexpected": "object"}}],
    }),
    (api_eric, api_eric.EricClient(), {
        "response": {"numFound": 1, "docs": [{"id": ["bad"], "title": "x"}]},
    }),
    (api_dblp, api_dblp.DblpClient(), {
        "result": {"hits": {"@total": "1", "hit": [{"info": {
            "title": ["bad"],
        }}]}},
    }),
])
def test_malformed_nested_record_types_are_truthful(
    monkeypatch, module, client, payload,
):
    _recording_sequence(monkeypatch, module, [FakeResponse(payload)])

    assert client.search(query="climate", max_results=1) == []
    outcome = api_base.search_outcome().snapshot()
    assert outcome["explicit_reason"] == "parse_failure"
    assert outcome["explicit_detail"] == {"detail": "malformed_json_shape"}


def test_valid_partial_records_survive_a_malformed_nested_record(monkeypatch):
    payload = _preprint_payload(count=1, total=2)
    payload["collection"].append({"title": ["bad"]})
    _recording_sequence(monkeypatch, api_biorxiv, [FakeResponse(payload)])

    results = api_biorxiv.BiorxivClient().search(
        query="climate", max_results=2,
        date_from="2024-01-01", date_to="2024-01-07",
    )
    outcome = api_base.search_outcome().snapshot()

    assert len(results) == 1
    assert outcome["explicit_reason"] == "parse_failure"
    assert outcome["explicit_detail"] == {"detail": "malformed_json_shape"}


def test_biorxiv_body_status_is_a_failed_answer(monkeypatch):
    _recording_sequence(monkeypatch, api_biorxiv, [FakeResponse({
        "messages": [{"status": "Not available at this time", "total": 0}],
        "collection": [],
    })])

    assert api_biorxiv.BiorxivClient().search(query="climate") == []
    outcome = api_base.search_outcome().snapshot()
    assert outcome["last_call_failed"] is True
    assert outcome["last_detail"] == "request_error"


def test_later_preprint_unavailable_status_keeps_partial_results_truthful(
    monkeypatch,
):
    _recording_sequence(monkeypatch, api_biorxiv, [
        FakeResponse(_preprint_payload(count=30, total=60)),
        FakeResponse({
            "messages": [{"status": "Not available at this time", "total": 60}],
            "collection": [],
        }),
    ])

    results = api_biorxiv.BiorxivClient().search(
        query="climate", max_results=60,
        date_from="2024-01-01", date_to="2024-01-07",
    )
    outcome = api_base.search_outcome().snapshot()

    assert len(results) == 30
    assert outcome["attempts"] == 2
    assert outcome["last_call_failed"] is True
    assert outcome["last_detail"] == "request_error"


def test_eric_retries_one_504_then_preserves_query_and_success(monkeypatch):
    calls = _recording_sequence(monkeypatch, api_eric, [
        FakeResponse(status_code=504), FakeResponse(_eric_payload()),
    ])

    results = api_eric.EricClient().search(
        query="climate", date_from="2024-01-01", date_to="2024-12-31",
        max_results=3,
    )
    outcome = api_base.search_outcome().snapshot()

    assert len(results) == 1
    assert len(calls) == 2
    assert calls[0]["params"] == calls[1]["params"]
    assert calls[0]["params"]["search"] == (
        "(climate) AND publicationdateyear:2024"
    )
    assert calls[0]["deadline"] == calls[1]["deadline"]
    assert outcome["attempts"] == 2
    assert outcome["last_call_failed"] is False


def test_dblp_challenge_is_recorded_without_retry(monkeypatch):
    challenge = FakeResponse(
        json_error=json.JSONDecodeError("html", "<html>", 0),
        text="<title>Making sure you are not a bot</title>Anubis 1.27.0",
        content_type="text/html; charset=utf-8",
    )
    calls = _recording_sequence(monkeypatch, api_dblp, [challenge])

    assert api_dblp.DblpClient().search(
        query='author:"Yoshua Bengio"', max_results=10,
    ) == []
    outcome = api_base.search_outcome().snapshot()

    assert len(calls) == 1
    assert calls[0]["params"]["q"] == 'author:"Yoshua Bengio"'
    assert outcome["explicit_reason"] == "parse_failure"
    assert outcome["explicit_detail"] == {"detail": "access_challenge"}


def test_dblp_zero_count_without_hit_is_clean_empty(monkeypatch):
    _recording_sequence(monkeypatch, api_dblp, [FakeResponse({
        "result": {"hits": {"@total": "0"}},
    })])

    assert api_dblp.DblpClient().search(query="no such publication") == []
    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == 1
    assert outcome["last_call_failed"] is False
    assert outcome["explicit_reason"] is None


class _OwnedServer(ThreadingHTTPServer):
    daemon_threads = True


@contextmanager
def _server(handler):
    server = _OwnedServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize("module,client,url_name", [
    (api_biorxiv, api_biorxiv.BiorxivClient(), "_BIORXIV_API_BASE"),
    (api_eric, api_eric.EricClient(), "_ERIC_API_URL"),
    (api_dblp, api_dblp.DblpClient(), "_DBLP_API_URL"),
])
def test_real_httpx_empty_body_is_bounded_and_truthful(
    monkeypatch, module, client, url_name,
):
    class EmptyHandler(BaseHTTPRequestHandler):
        count = 0

        def do_GET(self):
            type(self).count += 1
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass

    with _server(EmptyHandler) as base:
        endpoint = f"{base}/details" if module is api_biorxiv else base
        monkeypatch.setattr(module, url_name, endpoint)
        monkeypatch.setattr(module, "_RATE_LIMITER", api_base.RateLimiter(1000))
        monkeypatch.setattr(module, "_SEARCH_BUDGET_SECONDS", 1.0)
        monkeypatch.setattr(module, "_REQUEST_TIMEOUT_SECONDS", 0.5)
        assert client.search(query="climate", max_results=1) == []

    outcome = api_base.search_outcome().snapshot()
    assert EmptyHandler.count == 2
    assert outcome["attempts"] == 2
    assert outcome["explicit_reason"] == "parse_failure"
    assert outcome["explicit_detail"] == {"detail": "empty_or_invalid_json"}


def test_eric_real_httpx_retry_and_successive_clients_share_production_pacing(
    monkeypatch,
):
    """The first admission is immediate; every later ERIC wire arrival is spaced."""
    class RecordingLimiter(api_base.RateLimiter):
        def __init__(self):
            super().__init__(requests_per_second=0.5)
            self.admissions = []
            self.waits = []

        def acquire(self, *, deadline=None):
            began = time.monotonic()
            super().acquire(deadline=deadline)
            self.waits.append(time.monotonic() - began)
            self.admissions.append(self._last_call)

    class EricHandler(BaseHTTPRequestHandler):
        arrivals = []

        def do_GET(self):
            type(self).arrivals.append(time.monotonic())
            if len(type(self).arrivals) == 1:
                body = b'{"message":"temporary upstream failure"}'
                self.send_response(504)
            else:
                body = json.dumps(_eric_payload()).encode()
                self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with _server(EricHandler) as base:
        limiter = RecordingLimiter()
        monkeypatch.setattr(api_eric, "_ERIC_API_URL", base)
        monkeypatch.setattr(api_eric, "_RATE_LIMITER", limiter)
        monkeypatch.setattr(api_eric, "_SEARCH_BUDGET_SECONDS", 10.0)
        monkeypatch.setattr(api_eric, "_REQUEST_TIMEOUT_SECONDS", 1.0)
        began = time.monotonic()
        first = api_eric.EricClient().search(query="climate", max_results=1)
        second = api_eric.EricClient().search(query="climate", max_results=1)
        elapsed = time.monotonic() - began

    assert len(first) == len(second) == 1
    assert len(EricHandler.arrivals) == 3
    spacings = [
        later - earlier
        for earlier, later in zip(EricHandler.arrivals, EricHandler.arrivals[1:])
    ]
    admission_spacings = [
        later - earlier
        for earlier, later in zip(limiter.admissions, limiter.admissions[1:])
    ]
    assert len(limiter.admissions) == 3
    assert all(spacing >= 2.0 for spacing in admission_spacings), admission_spacings
    assert limiter.waits[0] < 0.25
    assert all(wait >= 0.0 for wait in limiter.waits), limiter.waits
    # Allow only local scheduling jitter; the configured two-second intervals
    # are exact at limiter admission and remain visible at the owned server.
    assert all(spacing >= 1.8 for spacing in spacings), spacings
    assert elapsed >= 3.6
    print(json.dumps({
        "admission_spacings": admission_spacings,
        "acquire_waits": limiter.waits,
        "wire_arrival_spacings": spacings,
        "first_call_wait_is_zero_eligible": True,
    }, sort_keys=True))


def test_safe_request_real_503_retry_after_waits_and_keeps_attempt_evidence():
    class Handler(BaseHTTPRequestHandler):
        arrivals = []
        statuses = []
        user_agents = []

        def do_GET(self):
            type(self).arrivals.append(time.monotonic())
            type(self).user_agents.append(self.headers.get("User-Agent"))
            if len(type(self).arrivals) == 1:
                type(self).statuses.append(503)
                self.send_response(503)
                # The ordinary first backoff is 1 second (base ** 0), so two
                # seconds proves that the provider cooldown sets the boundary.
                self.send_header("Retry-After", "2")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            type(self).statuses.append(200)
            body = b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with _server(Handler) as base:
        began = time.monotonic()
        response = api_base.safe_request(
            "GET", base,
            rate_limiter=api_base.RateLimiter(1000),
            timeout=1.0,
            max_retries=1,
            backoff_base=0.01,
            deadline=began + 4.0,
        )

    outcome = api_base.search_outcome().snapshot()
    assert response.status_code == 200
    assert len(Handler.arrivals) == 2
    assert Handler.statuses == [503, 200]
    assert Handler.arrivals[1] - Handler.arrivals[0] >= 1.8
    assert Handler.user_agents == [
        "resmon/1.0 (+https://github.com/ryanjosephkamp/resmon)",
    ] * 2
    assert outcome["attempts"] == 2
    assert outcome["failures"] == 0
    assert outcome["last_call_failed"] is False


def test_eric_retry_after_is_shared_across_client_instances(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        arrivals = []

        def do_GET(self):
            type(self).arrivals.append(time.monotonic())
            if len(type(self).arrivals) == 1:
                body = b'{"message":"deferred"}'
                self.send_response(429)
                self.send_header("Retry-After", "1")
            else:
                body = json.dumps(_eric_payload()).encode()
                self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with _server(Handler) as base:
        monkeypatch.setattr(api_eric, "_ERIC_API_URL", base)
        monkeypatch.setattr(api_eric, "_RATE_LIMITER", api_base.RateLimiter(1000))
        monkeypatch.setattr(api_eric, "_MAX_RESPONSE_ATTEMPTS", 1)
        monkeypatch.setattr(api_eric, "_SEARCH_BUDGET_SECONDS", 3.0)
        assert api_eric.EricClient().search("climate", max_results=1) == []
        rows = api_eric.EricClient().search("climate", max_results=1)

    assert len(rows) == 1
    assert len(Handler.arrivals) == 2
    assert Handler.arrivals[1] - Handler.arrivals[0] >= 0.9


def test_eric_retry_after_beyond_budget_sends_no_second_request(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        count = 0

        def do_GET(self):
            type(self).count += 1
            body = b'{"message":"deferred"}'
            self.send_response(429)
            self.send_header("Retry-After", "5")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with _server(Handler) as base:
        monkeypatch.setattr(api_eric, "_ERIC_API_URL", base)
        monkeypatch.setattr(api_eric, "_RATE_LIMITER", api_base.RateLimiter(1000))
        monkeypatch.setattr(api_eric, "_SEARCH_BUDGET_SECONDS", 0.2)
        began = time.monotonic()
        assert api_eric.EricClient().search("climate", max_results=1) == []
        elapsed = time.monotonic() - began

    outcome = api_base.search_outcome().snapshot()
    assert Handler.count == 1
    assert elapsed < 1.0
    assert outcome["attempts"] == 1
    assert outcome["last_status"] == 429
    assert outcome["last_detail"] == "rate_limited"


def test_progressing_body_cannot_outlive_shared_deadline(monkeypatch):
    class TrickleHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            for byte in b'{"result":{"hits":{"@total":"1","hit":[]}}}':
                try:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
                time.sleep(0.05)

        def log_message(self, *_args):
            pass

    with _server(TrickleHandler) as base:
        monkeypatch.setattr(api_dblp, "_DBLP_API_URL", base)
        monkeypatch.setattr(api_dblp, "_RATE_LIMITER", api_base.RateLimiter(1000))
        monkeypatch.setattr(api_dblp, "_SEARCH_BUDGET_SECONDS", 0.2)
        monkeypatch.setattr(api_dblp, "_REQUEST_TIMEOUT_SECONDS", 1.0)
        monkeypatch.setattr(api_dblp, "_MAX_RESPONSE_ATTEMPTS", 1)
        began = time.monotonic()
        assert api_dblp.DblpClient().search(query="climate", max_results=1) == []
        elapsed = time.monotonic() - began

    outcome = api_base.search_outcome().snapshot()
    assert elapsed < 1.5
    assert outcome["attempts"] == 1
    assert outcome["last_call_failed"] is True
    assert outcome["last_detail"] == "operation_deadline"


def test_oapen_real_httpx_retry_pagination_and_json_negotiation(monkeypatch):
    class OapenHandler(BaseHTTPRequestHandler):
        requests = []

        def do_GET(self):
            from urllib.parse import parse_qs, urlsplit

            query = parse_qs(urlsplit(self.path).query)
            type(self).requests.append({
                "offset": query.get("offset", [None])[0],
                "accept": self.headers.get("Accept"),
            })
            if len(type(self).requests) == 1:
                body = b"{}"
                self.send_response(503)
            else:
                offset = query.get("offset", ["0"])[0]
                handle = (
                    "20.500.12657/100210"
                    if offset == "0" else "20.500.12657/85023"
                )
                body = json.dumps([_oapen_record(handle)]).encode()
                self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with _server(OapenHandler) as base:
        monkeypatch.setattr(api_oapen, "_URL", base)
        monkeypatch.setattr(api_oapen, "_PAGE_SIZE", 1)
        monkeypatch.setattr(api_oapen, "_RATE_LIMITER", api_base.RateLimiter(1000))
        rows = api_oapen.OapenClient().search("water", max_results=2)

    assert [row.external_id for row in rows] == [
        "20.500.12657/100210", "20.500.12657/85023",
    ]
    assert [request["offset"] for request in OapenHandler.requests] == ["0", "0", "1"]
    assert all(request["accept"] == "application/json" for request in OapenHandler.requests)
    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == 3
    assert outcome["last_call_failed"] is False


def test_oapen_progressing_body_cannot_outlive_shared_deadline(monkeypatch):
    class TrickleHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            body = json.dumps([_oapen_record()]).encode()
            for byte in body:
                try:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
                time.sleep(0.05)

        def log_message(self, *_args):
            pass

    with _server(TrickleHandler) as base:
        monkeypatch.setattr(api_oapen, "_URL", base)
        monkeypatch.setattr(api_oapen, "_RATE_LIMITER", api_base.RateLimiter(1000))
        monkeypatch.setattr(api_oapen, "_SEARCH_BUDGET_SECONDS", 0.2)
        monkeypatch.setattr(api_oapen, "_REQUEST_TIMEOUT_SECONDS", 1.0)
        monkeypatch.setattr(api_oapen, "_MAX_REQUEST_RETRIES", 0)
        began = time.monotonic()
        assert api_oapen.OapenClient().search("water", max_results=1) == []
        elapsed = time.monotonic() - began

    outcome = api_base.search_outcome().snapshot()
    assert elapsed < 1.5
    assert outcome["attempts"] == 1
    assert outcome["last_call_failed"] is True
    assert outcome["last_detail"] == "operation_deadline"


# ---------------------------------------------------------------------------
# OAPEN's slow replies and its intermittent HTTP 500, at a real socket
# ---------------------------------------------------------------------------
#
# The live OAPEN case failed because two facts were hidden. First, a 10 s
# timeout was shorter than the provider's replies. Second, "HTTP 500, then a
# timeout on the retry" was recorded as just ``timeout``. These cases put both
# behind a real loopback socket and the production ``safe_request`` path.


def _oapen_page_server(plan):
    """A loopback OAPEN whose replies follow *plan*, one entry per request.

    Each entry is ``(delay_seconds, status, body_bytes)``. The delay comes
    before the status line, so it is the time to first byte that the client's
    timeout measures. A reply the client stopped waiting for is written into
    a closed socket, and that write is allowed to fail.
    """
    class Handler(BaseHTTPRequestHandler):
        requests = []

        def do_GET(self):
            from urllib.parse import parse_qs, urlsplit

            type(self).requests.append(parse_qs(urlsplit(self.path).query))
            index = len(type(self).requests) - 1
            delay, status, body = plan[min(index, len(plan) - 1)]
            time.sleep(delay)
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_args):
            pass

    return Handler


def _oapen_rows(*handles, year="2024"):
    return json.dumps([_oapen_record(handle, year) for handle in handles]).encode()


def test_oapen_dated_reply_arriving_after_ten_seconds_returns_rows(monkeypatch):
    """P1 at the shipped constants. The reply arrives after 10.5 s.

    That is after the old 10 s timeout and before the new 20 s one. Nothing
    about the timeout or the budget is patched. Only the limiter is replaced,
    so another test's use of the shared one cannot add a wait. With the old
    constant this search came back empty with a recorded timeout.
    """
    handler = _oapen_page_server([(10.5, 200, _oapen_rows("20.500.12657/100210"))])
    with _server(handler) as base:
        monkeypatch.setattr(api_oapen, "_URL", base)
        monkeypatch.setattr(api_oapen, "_RATE_LIMITER", api_base.RateLimiter(1000))
        api_base.reset_search_outcome()
        began = time.monotonic()
        rows = api_oapen.OapenClient().search("water AND fire", "2020", "2024", 1)
        elapsed = time.monotonic() - began

    outcome = api_base.search_outcome().snapshot()
    assert api_oapen._REQUEST_TIMEOUT_SECONDS == 20.0
    assert elapsed >= 10.5
    assert [row.external_id for row in rows] == ["20.500.12657/100210"]
    assert handler.requests[0]["fq"] == [
        "dc.date.issued_dt:[2020-01-01T00:00:00Z TO 2024-12-31T23:59:59.999Z]"
    ]
    assert outcome["attempts"] == 1
    assert outcome["failures"] == 0
    assert outcome["last_call_failed"] is False
    assert outcome["failure_history"] == []


def test_oapen_worst_case_fits_its_budget_and_the_pytest_watchdog():
    """P2's arithmetic, on the shipped constants.

    Two full timeouts plus the first backoff (``base ** 0`` is 1 s whatever
    the base) must end before the search budget. The budget must end before
    pytest's 120 s watchdog, or a provider outage would be reported as a hung
    test instead of as a recorded failure.
    """
    first_backoff = api_base.config.DEFAULT_BACKOFF_BASE ** 0
    worst = (
        (api_oapen._MAX_REQUEST_RETRIES + 1) * api_oapen._REQUEST_TIMEOUT_SECONDS
        + api_oapen._MAX_REQUEST_RETRIES * first_backoff
    )
    assert api_oapen._MAX_REQUEST_RETRIES == 1
    assert worst == 41.0
    assert worst < api_oapen._SEARCH_BUDGET_SECONDS == 45.0 < 120


def test_oapen_two_timeouts_return_retained_rows_and_a_recorded_failure(monkeypatch):
    """P2 at a real socket, with the timeout scaled from 20 s to 0.4 s.

    The first page answers at once. The second page stalls past the timeout
    on both attempts. The search must return, not raise, before its budget.
    It must keep the first page's row and record both timeouts in order.
    """
    handler = _oapen_page_server([
        (0.0, 200, _oapen_rows("20.500.12657/100210")),
        (1.2, 200, _oapen_rows("20.500.12657/85023")),
        (1.2, 200, _oapen_rows("20.500.12657/85023")),
    ])
    with _server(handler) as base:
        monkeypatch.setattr(api_oapen, "_URL", base)
        monkeypatch.setattr(api_oapen, "_PAGE_SIZE", 1)
        monkeypatch.setattr(api_oapen, "_RATE_LIMITER", api_base.RateLimiter(1000))
        monkeypatch.setattr(api_oapen, "_REQUEST_TIMEOUT_SECONDS", 0.4)
        monkeypatch.setattr(api_oapen, "_SEARCH_BUDGET_SECONDS", 4.0)
        api_base.reset_search_outcome()
        began = time.monotonic()
        rows = api_oapen.OapenClient().search("water", "2020", "2024", 2)
        elapsed = time.monotonic() - began

    outcome = api_base.search_outcome().snapshot()
    assert [row.external_id for row in rows] == ["20.500.12657/100210"]
    assert elapsed < 4.0
    assert [request["offset"] for request in handler.requests] == [["0"], ["1"], ["1"]]
    assert outcome["attempts"] == 3
    assert outcome["failures"] == 1
    assert outcome["last_call_failed"] is True
    assert outcome["last_detail"] == "timeout"
    assert outcome["failure_history"] == ["timeout", "timeout"]


def test_oapen_500_then_timeout_keeps_both_in_order(monkeypatch):
    """P3, first half: the shape of the 2026-09-18 live failure.

    Before the history existed this snapshot read only ``timeout``, and
    the 500 survived only as a warning line in the log.
    """
    handler = _oapen_page_server([
        (0.0, 500, b'{"error":"GenericJDBCException"}'),
        (1.2, 200, _oapen_rows("20.500.12657/100210")),
    ])
    with _server(handler) as base:
        monkeypatch.setattr(api_oapen, "_URL", base)
        monkeypatch.setattr(api_oapen, "_RATE_LIMITER", api_base.RateLimiter(1000))
        monkeypatch.setattr(api_oapen, "_REQUEST_TIMEOUT_SECONDS", 0.4)
        monkeypatch.setattr(api_oapen, "_SEARCH_BUDGET_SECONDS", 4.0)
        api_base.reset_search_outcome()
        rows = api_oapen.OapenClient().search("water AND fire", "2020", "2024", 2)

    outcome = api_base.search_outcome().snapshot()
    assert rows == []
    assert len(handler.requests) == 2
    assert outcome["failure_history"] == ["http_500", "timeout"]
    assert outcome["failure_history_omitted"] == 0
    assert outcome["last_call_failed"] is True
    assert outcome["last_detail"] == "timeout"
    assert outcome["failures"] == 1


@pytest.mark.parametrize("bounded", [True, False], ids=["deadline", "no-deadline"])
def test_500_then_success_keeps_the_500_in_history_only(monkeypatch, bounded):
    """P3, second half, on both transports ``safe_request`` has.

    A successful retry is still a successful invocation, so ``last_call_failed``
    stays false and no partial-result issue is derived. The 500 is still
    history: it is what a quarantine signature is matched against.
    """
    from implementation_scripts import zero_reason

    handler = _oapen_page_server([
        (0.0, 500, b"{}"),
        (0.0, 200, _oapen_rows("20.500.12657/100210")),
    ])
    with _server(handler) as base:
        api_base.reset_search_outcome()
        response = api_base.safe_request(
            "GET", base,
            rate_limiter=api_base.RateLimiter(1000),
            timeout=1.0, max_retries=1, backoff_base=0.01,
            deadline=(time.monotonic() + 4.0) if bounded else None,
        )

    outcome = api_base.search_outcome().snapshot()
    assert response.status_code == 200
    assert len(handler.requests) == 2
    assert outcome["attempts"] == 2
    assert outcome["failures"] == 0
    assert outcome["last_call_failed"] is False
    assert outcome["last_detail"] is None
    assert outcome["failure_history"] == ["http_500"]
    assert zero_reason.terminal_issue(outcome) is None


def test_a_cooldown_stopped_retry_records_its_status_once():
    """The one terminal failure first seen as a retryable attempt.

    A 503 asks for a 30 s cooldown and the budget is 2 s, so the retry is
    refused before transport. The status becomes terminal, and the history
    must still hold it once: counting it twice would invent an attempt.
    """
    class Handler(BaseHTTPRequestHandler):
        count = 0

        def do_GET(self):
            type(self).count += 1
            self.send_response(503)
            self.send_header("Retry-After", "30")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass

    with _server(Handler) as base:
        api_base.reset_search_outcome()
        with pytest.raises(api_base.ServerCooldownActive):
            api_base.safe_request(
                "GET", base,
                rate_limiter=api_base.RateLimiter(1000),
                timeout=1.0, max_retries=1, backoff_base=0.01,
                deadline=time.monotonic() + 2.0,
            )

    outcome = api_base.search_outcome().snapshot()
    assert Handler.count == 1
    assert outcome["attempts"] == 1
    assert outcome["failures"] == 1
    assert outcome["last_detail"] == "http_503"
    assert outcome["failure_history"] == ["http_503"]


def test_failure_history_is_bounded_ordered_and_cleared_only_by_reset():
    outcome = api_base.SearchOutcome()
    statuses = [500, 502, 503, 504, 429, 500, 502, 503, 504, 500]
    for status in statuses:
        outcome.note_attempt()
        outcome.note_retried_failure(status)
    outcome.note_attempt()
    snapshot = outcome.snapshot()
    expected = [
        "rate_limited" if status == 429 else f"http_{status}" for status in statuses
    ]
    assert snapshot["failure_history"] == expected[-api_base._FAILURE_HISTORY_LIMIT:]
    assert snapshot["failure_history_omitted"] == (
        len(statuses) - api_base._FAILURE_HISTORY_LIMIT
    )
    # A snapshot is a copy: a later failure cannot rewrite what was handed out.
    outcome.note_failure(httpx.ReadTimeout("slow"))
    assert snapshot["failure_history"][-1] == "http_500"
    assert outcome.snapshot()["failure_history"][-1] == "timeout"
    outcome.reset()
    assert outcome.snapshot()["failure_history"] == []
    assert outcome.snapshot()["failure_history_omitted"] == 0


def test_failure_history_holds_categories_never_text():
    """The words in the history are resmon's own vocabulary, never the source's."""
    canary = "CANARY-7f3a-body-text"
    outcome = api_base.SearchOutcome()
    outcome.note_failure(RuntimeError(canary), f"https://example.invalid/?api_key={canary}")
    outcome.note_failure(httpx.ConnectError(canary))
    outcome.note_failure(api_base.RequestDeadlineExceeded(canary))
    outcome.note_retried_failure(httpx.ReadTimeout(canary))
    snapshot = outcome.snapshot()
    assert snapshot["failure_history"] == [
        "request_error", "connect", "operation_deadline", "timeout",
    ]
    assert canary not in json.dumps(snapshot)


@pytest.mark.parametrize("first_page", ["empty", "partial"])
def test_oapen_failure_text_never_reaches_the_row_record_log_or_report(
    monkeypatch, tmp_path, first_page,
):
    """P4 through the sweep engine, the SQLite row and the search record.

    The canaries are an API-key-shaped parameter in the request's query
    string and a sentence in the 500 body. That is where a keyed source's
    credential and a provider's untrusted text would be. The server confirms
    it received the URL canary, so the test is not vacuous. Then every table,
    the exported search record (JSON and Markdown), the task log and the
    report are searched for both canaries.
    """
    import sqlite3

    from implementation_scripts import credential_manager as cm
    from implementation_scripts import search_record
    from implementation_scripts import sweep_engine as se
    from implementation_scripts.database import get_execution_sources, init_db

    url_canary = "URLCANARY9c1e"
    body_canary = "BODYCANARY4d2b"
    error_body = (
        '{"error":"org.hibernate.exception.GenericJDBCException: '
        f'Could not open connection {body_canary}"}}'
    ).encode()
    plan = [(0.0, 500, error_body), (0.0, 500, error_body)]
    if first_page == "partial":
        plan.insert(0, (0.0, 200, _oapen_rows("20.500.12657/100210")))
    handler = _oapen_page_server(plan)

    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    for exec_id in list(se.progress_store._events):
        se.progress_store.cleanup(exec_id)
    real_request = api_base.safe_request

    def keyed_request(method, url, *, params=None, **kwargs):
        # A keyed source sends its credential as one more query parameter.
        # The production safe_request still makes the call.
        return real_request(
            method, url, params={**(params or {}), "api_key": url_canary}, **kwargs)

    with _server(handler) as base:
        monkeypatch.setattr(api_oapen, "_URL", f"{base}/rest/search")
        monkeypatch.setattr(api_oapen, "safe_request", keyed_request)
        monkeypatch.setattr(api_oapen, "_PAGE_SIZE", 1)
        monkeypatch.setattr(api_oapen, "_RATE_LIMITER", api_base.RateLimiter(1000))
        monkeypatch.setattr(api_oapen, "_REQUEST_TIMEOUT_SECONDS", 1.0)
        monkeypatch.setattr(api_oapen, "_SEARCH_BUDGET_SECONDS", 5.0)
        monkeypatch.setattr(se, "REPORTS_DIR", tmp_path)
        monkeypatch.setattr(se, "get_client", lambda _name: api_oapen.OapenClient())
        monkeypatch.setattr(cm, "get_credential", lambda _name: None)
        engine = se.SweepEngine(db_conn=conn, config={})
        result = engine.execute_dive("oapen", {
            "query": "water", "date_from": "2020", "date_to": "2024",
            "max_results": 2,
        })

    try:
        assert all(request["api_key"] == [url_canary] for request in handler.requests)
        row = get_execution_sources(conn, result["execution_id"])[0]
        assert row["zero_reason"] == "upstream_failure"
        detail = json.loads(row["zero_detail"])
        assert detail["detail"] == "http_500" and detail["status"] == 500
        assert row["result_count"] == (1 if first_page == "partial" else 0)

        stored = []
        tables = [
            name for (name,) in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")
        ]
        for table in tables:
            for values in conn.execute(f'SELECT * FROM "{table}"'):
                stored.append(repr(values))
        record = search_record.build(conn, result["execution_id"])
        surfaces = {
            "database": "\n".join(stored),
            "search-record.json": json.dumps(record),
            "search-record.md": search_record.to_markdown(record),
            "task log": Path(result["log_path"]).read_text(encoding="utf-8"),
            "report": Path(result["report_path"]).read_text(encoding="utf-8"),
        }
        assert len(tables) > 10 and stored
        for name, text in surfaces.items():
            for canary in (url_canary, body_canary):
                assert canary not in text, f"{canary} reached the {name}"
            assert "GenericJDBCException" not in text, f"body text reached the {name}"
    finally:
        conn.close()
