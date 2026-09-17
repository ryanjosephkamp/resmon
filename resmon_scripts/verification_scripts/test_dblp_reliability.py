"""Hermetic and owned-loopback checks for DBLP's supported request contract."""

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

from implementation_scripts import api_base, api_dblp  # noqa: E402


class FakeResponse:
    def __init__(self, payload=None, *, status_code=200, headers=None, text=""):
        self.payload = payload
        self.status_code = status_code
        self.headers = headers or {"content-type": "application/json"}
        self.text = text

    def json(self):
        return self.payload


@pytest.fixture(autouse=True)
def _fresh_outcome():
    api_base.reset_search_outcome()


def _binding(
    key="conf/test/Paper24",
    *,
    title="Reliable Scholarly Search.",
    year="2024",
    author="56/953",
    author_name="Yoshua Bengio",
    venue="Test Journal",
    doi="10.1000/test.24",
):
    row = {
        "person": {"type": "uri", "value": "https://dblp.org/pid/56/953"},
        "publication": {"type": "uri", "value": f"https://dblp.org/rec/{key}"},
        "title": {"type": "literal", "value": title},
        "year": {
            "type": "literal",
            "datatype": "http://www.w3.org/2001/XMLSchema#gYear",
            "value": year,
        },
        "author": {"type": "uri", "value": f"https://dblp.org/pid/{author}"},
        "authorName": {"type": "literal", "value": author_name},
    }
    if venue:
        row["venue"] = {"type": "literal", "value": venue}
    if doi:
        row["doi"] = {
            "type": "uri",
            "value": f"https://doi.org/{doi}",
        }
    return row


def _sparql_payload(*bindings):
    return {"head": {"vars": []}, "results": {"bindings": list(bindings)}}


def _sequence(monkeypatch, replies):
    queue = list(replies)
    calls = []

    def request(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        api_base.search_outcome().note_attempt()
        response = queue.pop(0)
        if not 200 <= response.status_code < 300:
            api_base.search_outcome().note_failure(response.status_code, url)
        return response

    monkeypatch.setattr(api_dblp, "safe_request", request)
    return calls


def test_keyword_rest_preserves_query_and_uses_truthful_identity(monkeypatch):
    calls = _sequence(monkeypatch, [FakeResponse({
        "result": {"hits": {"@total": "0"}},
    })])

    assert api_dblp.DblpClient().search(query='graph "neural nets"') == []

    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "https://dblp.org/search/publ/api"
    assert calls[0]["params"]["q"] == 'graph "neural nets"'
    assert calls[0]["headers"] == {
        "User-Agent": "resmon-scholar-monitor (+https://github.com/ryanjosephkamp/resmon)",
    }
    assert api_dblp._RATE_LIMITER._interval == 2.0


def test_retry_after_waits_only_inside_shared_deadline(monkeypatch):
    slept = []
    monkeypatch.setattr(api_dblp.time, "monotonic", lambda: 100.0)
    monkeypatch.setattr(api_dblp.time, "sleep", slept.append)

    response = FakeResponse(status_code=429, headers={"Retry-After": "3"})
    assert api_dblp._wait_for_retry(response, 110.0) is True
    assert slept == [3.0]

    slept.clear()
    assert api_dblp._wait_for_retry(response, 102.0) is False
    assert slept == []


def test_transient_retry_reuses_identity_headers_and_honors_retry_after(monkeypatch):
    slept = []
    monkeypatch.setattr(api_dblp.time, "sleep", slept.append)
    calls = _sequence(monkeypatch, [
        FakeResponse(status_code=429, headers={"Retry-After": "1"}),
        FakeResponse({"result": {"hits": {"@total": "0"}}}),
    ])

    assert api_dblp._request_json({}, time.monotonic() + 30) is not None
    assert len(calls) == 2
    assert calls[0]["headers"] == calls[1]["headers"]
    assert slept == [1.0]


def test_author_query_is_escaped_and_normalizes_existing_identities(monkeypatch):
    calls = _sequence(monkeypatch, [FakeResponse(_sparql_payload(
        _binding(),
        _binding(author="h/GeoffreyEHinton", author_name="Geoffrey Hinton"),
    ))])

    records = api_dblp.DblpClient().search_entity(
        {"names": [{"value": 'Yoshua "Bengio"\n\\Lab'}]},
        date_from="2024-01-01",
        date_to="2024-12-31",
        max_results=10,
    )

    assert len(records) == 1
    record = records[0]
    assert record.external_id == "conf/test/Paper24"
    assert record.url == "https://dblp.org/rec/conf/test/Paper24"
    assert record.doi == "10.1000/test.24"
    assert record.publication_date == "2024-01-01"
    assert record.categories == ["Test Journal"]
    assert [author.name for author in record.authors] == [
        "Yoshua Bengio", "Geoffrey Hinton",
    ]
    assert record.authors[0].source_ids == (("dblp", "56/953"),)

    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "https://sparql.dblp.org/sparql"
    query = calls[0]["content"].decode()
    assert 'rdfs:label "Yoshua \\"Bengio\\"\\n\\\\Lab"' in query
    assert "dblp:authoredBy" in query
    assert "dblp:editedBy" not in query
    assert "dblp:publishedIn" in query
    assert "SELECT DISTINCT ?publication ?title ?year" in query
    assert "SELECT DISTINCT ?person ?publication" not in query
    assert "LIMIT 10" in query and "OFFSET 0" in query
    assert '?year >= "2024"^^xsd:gYear' in query
    assert '?year <= "2024"^^xsd:gYear' in query


def test_same_label_people_and_author_rows_deduplicate_by_publication_key(monkeypatch):
    calls = _sequence(monkeypatch, [FakeResponse(_sparql_payload(
        _binding(),
        _binding(),
        _binding(key="journals/test/Other25", year="2025"),
    ))])

    records = api_dblp.DblpClient().search_entity(
        {"display_name": "Yoshua Bengio"}, max_results=10,
    )

    assert [record.external_id for record in records] == [
        "conf/test/Paper24", "journals/test/Other25",
    ]
    assert len(calls) == 1


def test_partial_year_window_is_not_claimed_as_a_known_day(monkeypatch):
    calls = _sequence(monkeypatch, [])

    assert api_dblp.DblpClient().search_entity(
        {"display_name": "Yoshua Bengio"},
        date_from="2024-06-01",
        date_to="2025-06-01",
    ) == []

    assert calls == []
    outcome = api_base.search_outcome().snapshot()
    assert outcome["explicit_reason"] == "window_unanswerable"
    assert outcome["explicit_detail"] == {"detail": "no_complete_calendar_year"}


def test_partial_malformed_sparql_page_keeps_valid_records(monkeypatch):
    _sequence(monkeypatch, [FakeResponse(_sparql_payload(
        _binding(),
        {"publication": {"type": "uri", "value": "https://example.com/not-dblp"}},
    ))])

    records = api_dblp.DblpClient().search_entity(
        {"display_name": "Yoshua Bengio"}, max_results=10,
    )

    assert [record.external_id for record in records] == ["conf/test/Paper24"]
    outcome = api_base.search_outcome().snapshot()
    assert outcome["explicit_reason"] == "parse_failure"
    assert outcome["explicit_detail"] == {"detail": "malformed_sparql_binding"}


@pytest.mark.parametrize(
    ("field", "bad_value"),
    [
        (
            "publication",
            {"type": "literal", "value": "https://dblp.org/rec/conf/test/Bad"},
        ),
        ("author", {"type": "literal", "value": "https://dblp.org/pid/56/953"}),
        ("author", {"type": "uri", "value": "https://example.com/person/56/953"}),
        ("year", {"type": "literal", "value": "2024"}),
    ],
)
def test_binding_types_and_year_datatype_are_enforced(monkeypatch, field, bad_value):
    bad = _binding(key="conf/test/Bad")
    bad[field] = bad_value
    _sequence(monkeypatch, [FakeResponse(_sparql_payload(_binding(), bad))])

    records = api_dblp.DblpClient().search_entity(
        {"display_name": "Yoshua Bengio"}, max_results=10,
    )

    assert [record.external_id for record in records] == ["conf/test/Paper24"]
    assert api_base.search_outcome().snapshot()["explicit_reason"] == "parse_failure"


def test_malformed_optional_fields_keep_the_publication(monkeypatch):
    bad_optional = _binding(key="conf/test/Optional")
    bad_optional["doi"] = {
        "type": "literal",
        "datatype": "http://www.w3.org/2001/XMLSchema#anyURI",
        "value": "https://doi.org/10.1000/bad",
    }
    bad_optional["venue"] = {"type": "uri", "value": "https://example.com/venue"}
    _sequence(monkeypatch, [FakeResponse(_sparql_payload(bad_optional))])

    records = api_dblp.DblpClient().search_entity(
        {"display_name": "Yoshua Bengio"}, max_results=10,
    )

    assert [record.external_id for record in records] == ["conf/test/Optional"]
    assert records[0].doi is None
    assert records[0].categories == []
    assert api_base.search_outcome().snapshot()["explicit_reason"] == "parse_failure"


def test_missing_optional_fields_are_a_clean_success(monkeypatch):
    _sequence(monkeypatch, [FakeResponse(_sparql_payload(
        _binding(key="conf/test/Minimal", doi=None, venue=None),
    ))])

    records = api_dblp.DblpClient().search_entity(
        {"display_name": "Yoshua Bengio"}, max_results=10,
    )

    assert [record.external_id for record in records] == ["conf/test/Minimal"]
    assert records[0].doi is None
    assert records[0].categories == []
    assert api_base.search_outcome().snapshot()["explicit_reason"] is None


def test_explicit_empty_sparql_bindings_are_clean_empty(monkeypatch):
    _sequence(monkeypatch, [FakeResponse(_sparql_payload())])

    assert api_dblp.DblpClient().search_entity(
        {"display_name": "No Such Person"}, max_results=10,
    ) == []

    outcome = api_base.search_outcome().snapshot()
    assert outcome["attempts"] == 1
    assert outcome["last_call_failed"] is False
    assert outcome["explicit_reason"] is None


def test_sparql_pagination_is_bounded_and_uses_stable_offsets(monkeypatch):
    monkeypatch.setattr(api_dblp, "_SPARQL_PAGE_SIZE", 1)
    calls = _sequence(monkeypatch, [
        FakeResponse(_sparql_payload(_binding())),
        FakeResponse(_sparql_payload(_binding(key="journals/test/Other25", year="2025"))),
    ])

    records = api_dblp.DblpClient().search_entity(
        {"display_name": "Yoshua Bengio"}, max_results=2,
    )

    assert len(records) == 2
    assert "LIMIT 1\n    OFFSET 0" in calls[0]["content"].decode()
    assert "LIMIT 1\n    OFFSET 1" in calls[1]["content"].decode()
    assert calls[0]["deadline"] == calls[1]["deadline"]


def test_pagination_uses_selected_publications_not_normalized_survivors(monkeypatch):
    monkeypatch.setattr(api_dblp, "_SPARQL_PAGE_SIZE", 2)
    malformed_selected = _binding(key="conf/test/Malformed")
    malformed_selected["year"] = {"type": "literal", "value": "2024"}
    calls = _sequence(monkeypatch, [
        FakeResponse(_sparql_payload(_binding(), malformed_selected)),
        FakeResponse(_sparql_payload(
            _binding(key="journals/test/Other25", year="2025"),
        )),
    ])

    records = api_dblp.DblpClient().search_entity(
        {"display_name": "Yoshua Bengio"}, max_results=3,
    )

    assert [record.external_id for record in records] == [
        "conf/test/Paper24", "journals/test/Other25",
    ]
    assert len(calls) == 2
    assert "LIMIT 2\n    OFFSET 0" in calls[0]["content"].decode()
    assert "LIMIT 2\n    OFFSET 2" in calls[1]["content"].decode()


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


def test_real_loopback_requests_share_two_second_pacing(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        starts = []

        def do_GET(self):
            type(self).starts.append(time.monotonic())
            body = json.dumps({"result": {"hits": {"@total": "0"}}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with _server(Handler) as base:
        monkeypatch.setattr(api_dblp, "_DBLP_API_URL", base)
        monkeypatch.setattr(api_dblp, "_RATE_LIMITER", api_base.RateLimiter(0.5))
        deadline = time.monotonic() + 5
        assert api_dblp._request_json({}, deadline) is not None
        assert api_dblp._request_json({}, deadline) is not None

    assert len(Handler.starts) == 2
    assert Handler.starts[1] - Handler.starts[0] >= 1.9


def test_real_loopback_retry_after_waits_and_retries_once(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        count = 0

        def do_GET(self):
            type(self).count += 1
            if type(self).count == 1:
                self.send_response(429)
                self.send_header("Retry-After", "1")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = json.dumps({"result": {"hits": {"@total": "0"}}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with _server(Handler) as base:
        monkeypatch.setattr(api_dblp, "_DBLP_API_URL", base)
        monkeypatch.setattr(api_dblp, "_RATE_LIMITER", api_base.RateLimiter(1000))
        began = time.monotonic()
        assert api_dblp._request_json({}, began + 5) is not None
        elapsed = time.monotonic() - began

    assert Handler.count == 2
    assert elapsed >= 1.0


def test_rest_year_filter_requires_a_complete_calendar_year():
    info = {
        "key": "conf/test/Paper24",
        "title": "Reliable Scholarly Search.",
        "year": "2024",
        "authors": {"author": [{"text": "Yoshua Bengio"}]},
        "url": "https://dblp.org/rec/conf/test/Paper24",
    }

    assert api_dblp.DblpClient._parse_info(
        info, date_from="2024-06-01", date_to="2025-12-31",
    ) is None
    assert api_dblp.DblpClient._parse_info(
        info, date_from="2024-01-01", date_to="2024-12-31",
    ) is not None
