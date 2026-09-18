"""Response-contract regressions for bioRxiv/medRxiv, ERIC and DBLP.

Owned loopback cases use the production HTTPX path. Deterministic cases cover
provider shapes and pagination without claiming that a public provider is up.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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
    assert all(call["timeout"] == 10.0 and call["max_retries"] == 1 for call in calls)


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
