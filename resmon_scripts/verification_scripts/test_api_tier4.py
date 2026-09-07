"""Delegation 08: fixture contracts and scheduled public endpoint checks.

Fixtures below are minimal, synthetic projections of the live 2026-09-06
responses. Tests patch below safe_request so zero reasons and limiter use are
exercised, rather than replaced by a client-level request double.
"""

import json

import httpx
import pytest

from implementation_scripts import api_base, api_govinfo, api_oapen, api_registry, zero_reason
from implementation_scripts.repo_catalog import REPOSITORY_CATALOG


def oapen_record(handle="20.500.12657/100210", year="2024"):
    return {"handle": handle, "name": "Water & fire", "type": "item", "withdrawn": "false",
            "metadata": [{"key": "dc.date.issued", "value": year},
                         {"key": "dc.contributor.author", "value": "A. Author"},
                         {"key": "dc.contributor.author", "value": "B. Author"},
                         {"key": "dc.description.abstract", "value": "CC0 metadata abstract"},
                         {"key": "dc.subject.other", "value": "Water"}],
            "bitstreams": [{"content": "never retained"}]}


def govinfo_record(package="CFR-2024-title33-vol3", granule="CFR-2024-title33-vol3-sec203-61", date="2024-07-01"):
    return {"packageId": package, "granuleId": granule, "title": "Water supply",
            "dateIssued": date, "governmentAuthor": ["Office of the Federal Register"],
            "collectionCode": "CFR", "teaser": "unlicensed full-text excerpt",
            "abstract": "not stored", "download": {"txtLink": "https://example.org/text"}}


def page(slug, records, total=None, cursor="next"):
    return records if slug == "oapen" else {
        "results": records, "count": len(records) if total is None else total, "offsetMark": cursor,
    }


@pytest.fixture
def wire(monkeypatch):
    calls = []
    replies = []
    limiters = []
    monkeypatch.setattr(api_base.RateLimiter, "acquire", lambda self: limiters.append(self))
    monkeypatch.setattr(api_govinfo, "get_credential_for", lambda *a: "test-only-key")
    api_base.reset_search_outcome()

    def request(self, method, url, **kwargs):
        calls.append((method, url, kwargs))
        assert replies, "client requested an unexpected page"
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        status, body = reply
        return httpx.Response(status, content=body if isinstance(body, bytes) else json.dumps(body).encode(),
                              request=httpx.Request(method, url))

    monkeypatch.setattr(httpx.Client, "request", request)
    monkeypatch.setattr(api_base.config, "DEFAULT_MAX_RETRIES", 0)
    return calls, replies, limiters


def reason():
    return zero_reason.derive(api_base.search_outcome().snapshot())[0]


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
def test_registered_client_and_complete_catalog_contract(slug):
    client = api_registry.get_client(slug)
    assert client.get_name()
    entry = next(e for e in REPOSITORY_CATALOG if e.slug == slug)
    assert entry.date_granularity == ("year" if slug == "oapen" else "day")
    assert "Terms verdict: compatible" in entry.notes
    assert "https://" in entry.notes
    assert entry.attribution_requirement == "none"
    assert entry.attribution == entry.attribution_source == ""


def test_oapen_query_year_precision_pagination_and_metadata(wire, monkeypatch):
    calls, replies, limiters = wire
    monkeypatch.setattr(api_oapen, "_PAGE_SIZE", 2)
    replies.extend([(200, [oapen_record(), {"bad": True}]),
                    (200, [oapen_record("20.500.12657/85023")])])
    rows = api_oapen.OapenClient().search("water AND fire", "2023-06-01", "2024-12-31", 3)
    assert [r.external_id for r in rows] == ["20.500.12657/100210", "20.500.12657/85023"]
    assert rows[0].authors == ["A. Author", "B. Author"]
    assert rows[0].abstract == "CC0 metadata abstract"
    assert rows[0].categories == ["Water"]
    assert rows[0].publication_date == "2024"
    assert rows[0].url == "https://library.oapen.org/handle/20.500.12657/100210"
    params = [c[2]["params"] for c in calls]
    assert [p["offset"] for p in params] == [0, 2]
    assert all(p["limit"] == 2 and p["expand"] == "metadata" for p in params)
    assert params[0]["query"] == "water AND fire"
    assert params[0]["fq"] == "dc.date.issued_dt:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59.999Z]"
    assert limiters == [api_oapen._RATE_LIMITER] * 2


@pytest.mark.parametrize("start,end", [("2024-02-01", "2024-11-30"), ("2025", "2024")])
def test_oapen_unanswerable_window_is_recorded_without_request(wire, start, end):
    assert api_oapen.OapenClient().search("water", start, end) == []
    assert not wire[0]
    assert reason() == "window_unanswerable"


@pytest.mark.parametrize("year,expected", [("2024-03-19", "2024"), ("2024-99-01", None), ("unknown", None)])
def test_oapen_does_not_invent_date_precision(year, expected):
    assert api_oapen.OapenClient._parse_record(oapen_record(year=year)).publication_date == expected


@pytest.mark.parametrize("changes", [{"handle": "../escape"}, {"withdrawn": "true"}, {"metadata": {}}, {"name": []}])
def test_oapen_skips_malformed_or_withdrawn_records(changes):
    record = oapen_record()
    record.update(changes)
    assert api_oapen.OapenClient._parse_record(record) is None


def test_govinfo_query_scoped_key_cursor_and_granule_identity(wire, monkeypatch):
    calls, replies, limiters = wire
    scopes = []
    monkeypatch.setattr(api_govinfo, "get_credential_for", lambda *args: scopes.append(args) or "test-only-key")
    monkeypatch.setattr(api_govinfo, "_PAGE_SIZE", 2)
    first = govinfo_record()
    second = govinfo_record(granule="CFR-2024-title33-vol3-sec203-62")
    third = govinfo_record(granule=None)
    replies.extend([(200, page("govinfo", [first, second], 3, "opaque+/=")),
                    (200, page("govinfo", [third], 3))])
    client = api_govinfo.GovinfoClient()
    client._exec_id = 42
    rows = client.search("water OR fire", "2024-02", "2024-12", 3)
    assert len({r.external_id for r in rows}) == 3
    assert rows[0].external_id == "CFR-2024-title33-vol3/CFR-2024-title33-vol3-sec203-61"
    assert rows[2].external_id == "CFR-2024-title33-vol3"
    assert rows[0].authors == ["Office of the Federal Register"]
    assert rows[0].publication_date == "2024-07-01"
    assert rows[0].categories == ["CFR"]
    assert rows[0].url == "https://www.govinfo.gov/app/details/CFR-2024-title33-vol3/CFR-2024-title33-vol3-sec203-61"
    assert all(r.abstract is None for r in rows)
    assert scopes == [(42, "govinfo_api_key")]
    bodies = [c[2]["json"] for c in calls]
    assert bodies[0]["query"] == "(water OR fire) AND publishdate:range(2024-02-01,2024-12-31)"
    assert [b["offsetMark"] for b in bodies] == ["*", "opaque+/="]
    assert all(b["pageSize"] == 2 for b in bodies)
    assert all(c[0] == "POST" and c[2]["headers"]["X-Api-Key"] == "test-only-key" for c in calls)
    assert limiters == [api_govinfo._RATE_LIMITER] * 2


def test_govinfo_missing_key_does_not_use_demo_key(wire, monkeypatch):
    monkeypatch.setattr(api_govinfo, "get_credential_for", lambda *a: None)
    assert api_govinfo.GovinfoClient().search("water") == []
    assert wire[0] == []


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
def test_empty_response_records_answered_empty(wire, slug):
    wire[1].append((200, page(slug, [])))
    assert api_registry.get_client(slug).search("unlikely query", "2024", "2024") == []
    assert reason() == "answered_empty"


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
@pytest.mark.parametrize("body", [b"not-json", {}, None])
def test_unreadable_reply_is_not_empty_answer(wire, slug, body):
    wire[1].append((200, body))
    assert api_registry.get_client(slug).search("water") == []
    assert reason() == "parse_failure"


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
@pytest.mark.parametrize("failure", [(503, {}), httpx.ConnectError("unreachable")])
def test_transport_failure_is_not_parse_failure(wire, slug, failure):
    wire[1].append(failure)
    assert api_registry.get_client(slug).search("water") == []
    assert reason() == "upstream_failure"


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
def test_second_page_outage_discards_partial_results(wire, monkeypatch, slug):
    module = api_oapen if slug == "oapen" else api_govinfo
    monkeypatch.setattr(module, "_PAGE_SIZE", 1)
    record = oapen_record() if slug == "oapen" else govinfo_record()
    wire[1].extend([(200, page(slug, [record], 2)), (503, {})])
    assert api_registry.get_client(slug).search("water", max_results=2) == []
    assert reason() == "upstream_failure"


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
def test_repeated_page_fails_closed(wire, monkeypatch, slug):
    module = api_oapen if slug == "oapen" else api_govinfo
    monkeypatch.setattr(module, "_PAGE_SIZE", 1)
    record = oapen_record() if slug == "oapen" else govinfo_record()
    wire[1].extend([(200, page(slug, [record], 3, "cursor1")),
                    (200, page(slug, [record], 3, "cursor2"))])
    assert api_registry.get_client(slug).search("water", max_results=3) == []
    assert len(wire[0]) == 2
    assert reason() == "parse_failure"


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
def test_records_missing_required_fields_get_real_zero_reason(wire, slug):
    wire[1].append((200, page(slug, [{"bad": True}])))
    assert api_registry.get_client(slug).search("water", max_results=5) == []
    assert reason() == "records_unusable"
    detail = api_base.search_outcome().snapshot()["explicit_detail"]
    assert detail["incomplete"] == 1 and detail["rights"] == 0


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
def test_source_date_filter_is_rechecked(wire, slug):
    record = oapen_record(year="2023") if slug == "oapen" else govinfo_record(date="2023-12-31")
    wire[1].append((200, page(slug, [record])))
    assert api_registry.get_client(slug).search("water", "2024", "2024") == []
    assert reason() == "parse_failure"


@pytest.mark.parametrize("count", [True, -1, "2", None])
def test_govinfo_rejects_invalid_total(wire, count):
    wire[1].append((200, {"results": [], "count": count}))
    assert api_govinfo.GovinfoClient().search("water") == []
    assert reason() == "parse_failure"


def test_govinfo_missing_cursor_before_total_fails(wire):
    wire[1].append((200, page("govinfo", [govinfo_record()], 5, None)))
    assert api_govinfo.GovinfoClient().search("water") == []
    assert reason() == "parse_failure"


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
def test_result_cap_stops_without_an_extra_request(wire, slug):
    record = oapen_record() if slug == "oapen" else govinfo_record()
    wire[1].append((200, page(slug, [record], 100)))
    assert len(api_registry.get_client(slug).search("water", max_results=1)) == 1
    assert len(wire[0]) == 1


# Explicit cases are used by the completeness guard; a newly registered source
# must add a real scheduled test, not merely update a catalog-length assertion.
BATCH_LIVE_CASES = {"oapen": "test_oapen_live_search", "govinfo": "test_govinfo_live_search"}


@pytest.mark.live_network
def test_oapen_live_search():
    api_base.reset_search_outcome()
    rows = api_registry.get_client("oapen").search("water AND fire", "2020", "2024", 2)
    assert len(rows) == 2, api_base.search_outcome().snapshot()
    assert all(r.source_repository == "oapen" and "2020" <= r.publication_date <= "2024" for r in rows)
    assert all(r.title and r.external_id and r.url.startswith("https://library.oapen.org/handle/") for r in rows)
    api_base.reset_search_outcome()
    assert api_registry.get_client("oapen").search("water", "2024-02-01", "2024-02-02") == []
    assert reason() == "window_unanswerable"


@pytest.mark.live_network
def test_govinfo_live_search(monkeypatch):
    # GPO explicitly documents DEMO_KEY for API evaluation. CI needs no secret.
    # https://www.govinfo.gov/features/search-service-overview
    monkeypatch.setattr(api_govinfo, "get_credential_for", lambda *a: "DEMO_KEY")
    api_base.reset_search_outcome()
    rows = api_registry.get_client("govinfo").search("water", "2024-01-01", "2024-12-31", 2)
    assert len(rows) == 2, api_base.search_outcome().snapshot()
    assert all(r.source_repository == "govinfo" and "2024-01-01" <= r.publication_date <= "2024-12-31" for r in rows)
    assert all(r.title and r.external_id and r.abstract is None for r in rows)
    api_base.reset_search_outcome()
    assert api_registry.get_client("govinfo").search("resmonzzqvabsentx20260906", "2024", "2024", 1) == []
    assert reason() == "answered_empty"


# Baseline policies and older live cases are outside this batch's re-audit.
# Freeze the baseline rather than exempting every future catalog entry. Adding
# a source now requires a callable scheduled live case, explicit granularity,
# and a cited terms verdict. The old catalog had no terms-verdict field and
# no such completeness guard, contrary to the brief.
_BASELINE_SLUGS = frozenset({
    "arxiv", "biorxiv", "core", "crossref", "datacite", "dblp", "doaj", "dryad",
    "eric", "europepmc", "hal", "inspire_hep", "medrxiv", "nasa_ads", "ndl_search",
    "nist_rmm", "openaire", "openalex", "openlibrary", "osti", "plos", "pubmed",
    "semantic_scholar", "springer", "zenodo",
})


def test_every_new_registered_source_has_a_scheduled_live_contract():
    import ast
    import inspect
    from implementation_scripts import repo_catalog

    registered = set(api_registry.list_repositories())
    assert registered == {e.slug for e in REPOSITORY_CATALOG}
    assert registered - _BASELINE_SLUGS == set(BATCH_LIVE_CASES)
    entries = {}
    for call in ast.walk(ast.parse(inspect.getsource(repo_catalog))):
        if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "_entry":
            keywords = {k.arg: k.value for k in call.keywords}
            entries[ast.literal_eval(keywords["slug"])] = keywords
    for entry in REPOSITORY_CATALOG:
        assert entry.date_granularity in {"day", "month", "year"}
        if entry.slug in _BASELINE_SLUGS:
            continue
        assert "date_granularity" in entries[entry.slug], entry.slug
        assert "Terms verdict:" in entry.notes and "https://" in entry.notes, entry.slug
        case = globals()[BATCH_LIVE_CASES[entry.slug]]
        assert callable(case)
        markers = {m.name for m in case.pytestmark}
        assert "live_network" in markers and "needs_agent_cli" not in markers


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
def test_distinct_records_missing_dates_cannot_cause_an_unbounded_scan(wire, monkeypatch, slug):
    module = api_oapen if slug == "oapen" else api_govinfo
    monkeypatch.setattr(module, "_MIN_SCAN_BUDGET", 2)
    if slug == "oapen":
        records = [oapen_record(f"20.500.12657/{i}", "unknown") for i in (1, 2)]
    else:
        records = [govinfo_record(granule=f"granule-{i}", date="unknown") for i in (1, 2)]
    wire[1].extend((200, page(slug, [record], 100, f"cursor-{i}")) for i, record in enumerate(records))
    assert api_registry.get_client(slug).search("water", "2024", "2024", 1) == []
    assert len(wire[0]) == 2
    assert reason() == "records_unusable"
    assert api_base.search_outcome().snapshot()["explicit_detail"]["incomplete"] == 2


@pytest.mark.parametrize("slug", ["oapen", "govinfo"])
def test_an_entire_malformed_page_does_not_abort_the_next_page(wire, monkeypatch, slug):
    module = api_oapen if slug == "oapen" else api_govinfo
    monkeypatch.setattr(module, "_PAGE_SIZE", 1)
    record = oapen_record() if slug == "oapen" else govinfo_record()
    wire[1].extend([(200, page(slug, [{"bad": True}], 2, "next")),
                    (200, page(slug, [record], 2, "end"))])
    rows = api_registry.get_client(slug).search("water", "2024", "2024", 1)
    assert len(rows) == 1
    assert len(wire[0]) == 2
