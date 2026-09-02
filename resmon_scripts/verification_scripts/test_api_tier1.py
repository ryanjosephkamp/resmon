# resmon_scripts/verification_scripts/test_api_tier1.py
import sys
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.api_base import NormalizedResult
from implementation_scripts.api_registry import list_repositories, get_client

# Import all client modules to trigger auto-registration
import implementation_scripts.api_arxiv          # noqa: F401
import implementation_scripts.api_crossref       # noqa: F401
import implementation_scripts.api_semantic_scholar  # noqa: F401
import implementation_scripts.api_openalex       # noqa: F401
import implementation_scripts.api_pubmed         # noqa: F401
import implementation_scripts.api_europepmc      # noqa: F401
from implementation_scripts import api_biorxiv
from implementation_scripts import api_datacite
from implementation_scripts import api_dryad
from implementation_scripts import api_eric
from implementation_scripts import api_inspire_hep
from implementation_scripts import api_nist_rmm
from implementation_scripts import api_ndl_search
from implementation_scripts import api_openlibrary
from implementation_scripts import api_openaire
from implementation_scripts import api_osti
from implementation_scripts import api_zenodo
import implementation_scripts.api_core           # noqa: F401
import implementation_scripts.api_doaj           # noqa: F401
import implementation_scripts.api_dblp           # noqa: F401
import implementation_scripts.api_nasa_ads       # noqa: F401

TIER_1_REPOS = [
    "arxiv", "crossref", "semantic_scholar", "openalex", "pubmed",
    "europepmc", "biorxiv", "core", "datacite", "doaj", "dblp", "dryad", "eric",
    "inspire_hep", "medrxiv", "nasa_ads", "ndl_search", "nist_rmm", "openlibrary", "openaire", "osti", "zenodo",
]


def test_all_tier1_registered():
    """All 22 Tier 1 repositories are registered in the client registry."""
    repos = list_repositories()
    for name in TIER_1_REPOS:
        assert name in repos, f"Missing Tier 1 client: {name}"


def test_each_client_instantiates():
    """Each Tier 1 client can be instantiated without error."""
    for name in TIER_1_REPOS:
        client = get_client(name)
        assert client.get_name() is not None


def _nist_rmm_record(
    doi="10.18434/mds2-1234",
    *,
    ediid="nist-papers-1234",
    ark=None,
    title="NIST materials measurement paper",
    authors=None,
    publication_date="2024-01-15",
    url="https://data.nist.gov/papers/nist-papers-1234",
):
    # These are provisional item aliases for unit fixtures. The current RMM
    # OpenAPI describes the response envelope, not an item-field schema.
    return {
        "doi": doi,
        "ediid": ediid,
        "ark": ark,
        "title": title,
        "authors": ["Doe, Jane", "Rao, Priya"] if authors is None else authors,
        "publication_date": publication_date,
        "url": url,
    }


def _nist_rmm_payload(records, *, total=None):
    if total is None:
        total = len(records)
    return {
        "ResultData": records,
        "ResultCount": total,
        "PageSize": len(records),
        "Metrics": {},
    }


def test_nist_rmm_search_uses_openapi_params_and_normalizes_fixture_doi_record(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return _FakeResponse(payload=_nist_rmm_payload([_nist_rmm_record()]))

    monkeypatch.setattr(api_nist_rmm, "safe_request", _request)

    results = api_nist_rmm.NistRmmClient().search(
        query="materials measurement",
        date_from="2024-01-01",
        date_to="2024-01-31",
        max_results=3,
    )

    assert calls == [(
        "GET",
        "https://data.nist.gov/rmm/papers",
        {
            "params": {
                "searchphrase": "materials measurement",
                "from_date": "2024-01-01",
                "skip": 0,
                "limit": 3,
            },
            "rate_limiter": api_nist_rmm._RATE_LIMITER,
        },
    )]
    assert api_nist_rmm._RATE_LIMITER._interval == pytest.approx(2.0)
    assert results == [NormalizedResult(
        source_repository="nist_rmm",
        external_id="10.18434/mds2-1234",
        doi="10.18434/mds2-1234",
        title="NIST materials measurement paper",
        authors=["Doe, Jane", "Rao, Priya"],
        abstract=None,
        publication_date="2024-01-15",
        url="https://doi.org/10.18434/mds2-1234",
        categories=[],
    )]


def test_nist_rmm_search_pages_by_skip_and_honors_max_results(monkeypatch):
    requested = []
    records = [
        _nist_rmm_record(
            doi=f"10.18434/mds2-{index:04d}",
            ediid=f"nist-papers-{index:04d}",
        )
        for index in range(51)
    ]

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        requested.append((params["skip"], params["limit"]))
        start = params["skip"]
        return _FakeResponse(payload=_nist_rmm_payload(
            records[start:start + params["limit"]], total=len(records),
        ))

    monkeypatch.setattr(api_nist_rmm, "safe_request", _request)

    results = api_nist_rmm.NistRmmClient().search(
        query="materials", max_results=51,
    )

    assert requested == [(0, 50), (50, 1)]
    assert [result.external_id for result in results] == [
        f"10.18434/mds2-{index:04d}" for index in range(51)
    ]


def test_nist_rmm_search_continues_after_a_full_page_of_malformed_records(monkeypatch):
    malformed = [_nist_rmm_record(title="") for _ in range(50)]
    valid = _nist_rmm_record(doi="10.18434/after-malformed-page")
    requested = []

    def _request(method, url, **kwargs):
        skip = kwargs["params"]["skip"]
        requested.append(skip)
        records = malformed if skip == 0 else [valid]
        return _FakeResponse(payload=_nist_rmm_payload(records, total=51))

    monkeypatch.setattr(api_nist_rmm, "safe_request", _request)

    results = api_nist_rmm.NistRmmClient().search(
        query="materials", max_results=51,
    )

    assert requested == [0, 50]
    assert [result.external_id for result in results] == [
        "10.18434/after-malformed-page",
    ]


def test_nist_rmm_raw_pages_do_not_consume_the_retained_result_cap(monkeypatch):
    malformed = [_nist_rmm_record(title="") for _ in range(50)]
    valid = [
        _nist_rmm_record(doi=f"10.18434/retained-after-malformed-{index:04d}")
        for index in range(51)
    ]
    records = malformed + valid
    requested = []

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        requested.append((params["skip"], params["limit"]))
        start = params["skip"]
        return _FakeResponse(payload=_nist_rmm_payload(
            records[start:start + params["limit"]], total=len(records),
        ))

    monkeypatch.setattr(api_nist_rmm, "safe_request", _request)

    results = api_nist_rmm.NistRmmClient().search(
        query="materials", max_results=51,
    )

    assert requested == [(0, 50), (50, 50), (100, 1)]
    assert [result.external_id for result in results] == [
        f"10.18434/retained-after-malformed-{index:04d}"
        for index in range(51)
    ]


def test_nist_rmm_search_fails_closed_when_result_count_page_is_short(monkeypatch):
    first = _nist_rmm_record(doi="10.18434/short-page-first")
    requested = []

    def _request(method, url, **kwargs):
        skip = kwargs["params"]["skip"]
        requested.append(skip)
        return _FakeResponse(payload=_nist_rmm_payload([first], total=2))

    monkeypatch.setattr(api_nist_rmm, "safe_request", _request)

    assert api_nist_rmm.NistRmmClient().search(
        query="materials", max_results=2,
    ) == []
    assert requested == [0]


@pytest.mark.parametrize("declared_total", [None, "unknown"])
def test_nist_rmm_search_accepts_valid_exhaustion_without_a_parseable_total(
    monkeypatch, declared_total,
):
    payload = _nist_rmm_payload([_nist_rmm_record()])
    if declared_total is None:
        payload.pop("ResultCount")
    else:
        payload["ResultCount"] = declared_total
    monkeypatch.setattr(
        api_nist_rmm,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=payload),
    )

    results = api_nist_rmm.NistRmmClient().search(
        query="materials", max_results=2,
    )

    assert [result.external_id for result in results] == ["10.18434/mds2-1234"]


def test_nist_rmm_search_returns_empty_when_a_raw_page_repeats(monkeypatch):
    records = [
        _nist_rmm_record(doi=f"10.18434/repeated-{index:04d}")
        for index in range(50)
    ]
    requested = []

    def _request(method, url, **kwargs):
        requested.append(kwargs["params"]["skip"])
        return _FakeResponse(payload=_nist_rmm_payload(records, total=100))

    monkeypatch.setattr(api_nist_rmm, "safe_request", _request)

    assert api_nist_rmm.NistRmmClient().search(
        query="materials", max_results=100,
    ) == []
    assert requested == [0, 50]


def test_nist_rmm_search_rejects_non_exact_request_date_without_network(monkeypatch):
    calls = []
    monkeypatch.setattr(
        api_nist_rmm,
        "safe_request",
        lambda *args, **kwargs: calls.append(kwargs),
    )

    assert api_nist_rmm.NistRmmClient().search(
        query="materials", date_from="2024-01-01garbage",
    ) == []
    assert calls == []


def test_nist_rmm_search_forwards_the_validated_lower_date_bound(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append(kwargs["params"])
        return _FakeResponse(payload=_nist_rmm_payload([]))

    monkeypatch.setattr(api_nist_rmm, "safe_request", _request)

    assert api_nist_rmm.NistRmmClient().search(
        query="materials", date_from="2024-02-29",
    ) == []
    assert calls == [{
        "searchphrase": "materials",
        "from_date": "2024-02-29",
        "skip": 0,
        "limit": 50,
    }]


def test_nist_rmm_search_applies_upper_date_bound_locally_and_skips_unknown_dates(monkeypatch):
    records = [
        _nist_rmm_record(doi="10.18434/inside", publication_date="2024-01-15"),
        _nist_rmm_record(doi="10.18434/after", publication_date="2024-02-01"),
        _nist_rmm_record(doi="10.18434/missing", publication_date=None),
        _nist_rmm_record(doi="10.18434/bad-date", publication_date="not-a-date"),
    ]
    calls = []

    def _request(method, url, **kwargs):
        calls.append(kwargs["params"])
        return _FakeResponse(payload=_nist_rmm_payload(records))

    monkeypatch.setattr(api_nist_rmm, "safe_request", _request)

    results = api_nist_rmm.NistRmmClient().search(
        query="materials",
        date_from="2024-01-01",
        date_to="2024-01-31",
        max_results=10,
    )

    assert calls == [{
        "searchphrase": "materials",
        "from_date": "2024-01-01",
        "skip": 0,
        "limit": 10,
    }]
    assert [result.external_id for result in results] == ["10.18434/inside"]


def test_nist_rmm_search_uses_raw_fixture_ediid_when_doi_is_not_valid(monkeypatch):
    record = _nist_rmm_record(
        doi="not a doi",
        ediid="  nist-papers-5678  ",
        url="https://data.nist.gov/papers/nist-papers-5678",
    )
    monkeypatch.setattr(
        api_nist_rmm,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=_nist_rmm_payload([record])),
    )

    results = api_nist_rmm.NistRmmClient().search(query="materials")

    assert results == [NormalizedResult(
        source_repository="nist_rmm",
        external_id="  nist-papers-5678  ",
        doi=None,
        title="NIST materials measurement paper",
        authors=["Doe, Jane", "Rao, Priya"],
        abstract=None,
        publication_date="2024-01-15",
        url="https://data.nist.gov/papers/nist-papers-5678",
        categories=[],
    )]


def test_nist_rmm_search_skips_malformed_or_unidentified_records(monkeypatch):
    valid = _nist_rmm_record(
        doi=None,
        ediid=None,
        ark="ark:/88434/nist-papers-9012",
        url="https://data.nist.gov/papers/nist-papers-9012",
    )
    records = [
        _nist_rmm_record(title="", doi="10.18434/no-title"),
        _nist_rmm_record(doi=None, ediid=None, ark=None),
        _nist_rmm_record(doi="not a doi", ediid="", ark=None),
        valid,
    ]
    monkeypatch.setattr(
        api_nist_rmm,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=_nist_rmm_payload(records)),
    )

    results = api_nist_rmm.NistRmmClient().search(query="materials")

    assert [result.external_id for result in results] == ["ark:/88434/nist-papers-9012"]


@pytest.mark.parametrize("response", [
    500,
    TimeoutError("upstream timed out"),
])
def test_nist_rmm_search_returns_empty_on_upstream_failure(monkeypatch, response):
    def _request(*args, **kwargs):
        if isinstance(response, Exception):
            raise response
        return _FakeResponse(status_code=response)

    monkeypatch.setattr(api_nist_rmm, "safe_request", _request)

    assert api_nist_rmm.NistRmmClient().search(query="materials") == []


@pytest.mark.live_network
def test_nist_rmm_live_search_degrades_when_the_public_endpoint_is_unavailable():
    """The real call may return the known 500 outage; either outcome is a list."""
    results = get_client("nist_rmm").search(query="materials", max_results=1)

    assert isinstance(results, list)
    if results:
        assert all(isinstance(result, NormalizedResult) for result in results)
        assert all(result.source_repository == "nist_rmm" for result in results)


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, headers=None, text=""):
        self.status_code = status_code
        self._payload = {} if payload is None else payload
        self.headers = headers or {}
        self.text = text

    def json(self):
        return self._payload


def _openlibrary_record(
    key="/works/OL123W",
    *,
    title="Climate history",
    first_publish_year=2024,
    include_optional=True,
):
    record = {
        "key": key,
        "title": title,
        "first_publish_year": first_publish_year,
    }
    if include_optional:
        record.update({
            "author_name": ["Doe, Jane", "Rao, Priya"],
            "subject": [f"subject-{index}" for index in range(1, 12)],
        })
    return record


def _openlibrary_payload(records, *, total=None):
    if total is None:
        total = len(records)
    return {"numFound": total, "docs": records}


def test_openlibrary_date_month_bounds_are_day_granular_without_widening():
    assert api_openlibrary._date_interval("2024-01") == (
        "2024-01-01", "2024-01-31",
    )
    assert api_openlibrary._search_year_bounds("2024-01", "2024-12") == (
        2024, 2024, "2024-01-01", "2024-12-31",
    )
    assert api_openlibrary._search_year_bounds(None, "2024-01") == (
        None, 2023, None, "2024-01-31",
    )


def test_openlibrary_search_builds_year_query_and_normalizes_metadata(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return _FakeResponse(payload=_openlibrary_payload([_openlibrary_record()]))

    monkeypatch.setattr(api_openlibrary, "safe_request", _request)

    results = api_openlibrary.OpenLibraryClient().search(
        query="climate history",
        date_from="2024-01-01",
        date_to="2024-12-31",
        max_results=5,
    )

    assert calls == [(
        "GET",
        "https://openlibrary.org/search.json",
        {
            "params": {
                "q": "(climate history) AND first_publish_year:2024",
                "page": 1,
                "limit": 5,
                "fields": "key,title,author_name,first_publish_year,subject",
            },
            "headers": {
                "User-Agent": "resmon (+https://github.com/ryanjosephkamp/resmon/issues)",
            },
            "rate_limiter": api_openlibrary._RATE_LIMITER,
        },
    )]
    assert api_openlibrary._RATE_LIMITER._interval == pytest.approx(1.0)
    assert results == [NormalizedResult(
        source_repository="openlibrary",
        external_id="/works/OL123W",
        doi=None,
        title="Climate history",
        authors=["Doe, Jane", "Rao, Priya"],
        abstract=None,
        publication_date="2024",
        url="https://openlibrary.org/works/OL123W",
        categories=[f"subject-{index}" for index in range(1, 11)],
    )]


def test_openlibrary_search_uses_a_compact_exact_range_for_broad_year_windows(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append(kwargs["params"])
        return _FakeResponse(payload=_openlibrary_payload([_openlibrary_record()]))

    monkeypatch.setattr(api_openlibrary, "safe_request", _request)

    results = api_openlibrary.OpenLibraryClient().search(
        query="climate", date_from="2020", date_to="2025",
    )

    assert [result.external_id for result in results] == ["/works/OL123W"]
    assert calls[0]["q"] == "(climate) AND first_publish_year:[2020 TO 2025]"


def test_openlibrary_search_keeps_page_size_constant_across_pages(monkeypatch):
    requested = []
    records = [
        _openlibrary_record(key=f"/works/OL{index}W", include_optional=False)
        for index in range(1, 102)
    ]

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        requested.append((params["page"], params["limit"]))
        start = (params["page"] - 1) * params["limit"]
        return _FakeResponse(payload=_openlibrary_payload(
            records[start:start + params["limit"]], total=len(records),
        ))

    monkeypatch.setattr(api_openlibrary, "safe_request", _request)

    results = api_openlibrary.OpenLibraryClient().search(
        query="history", max_results=101,
    )

    assert requested == [(1, 100), (2, 100)]
    assert [result.external_id for result in results] == [
        f"/works/OL{index}W" for index in range(1, 102)
    ]


def test_openlibrary_search_returns_empty_for_sub_year_window_without_request(monkeypatch):
    calls = []
    monkeypatch.setattr(
        api_openlibrary,
        "safe_request",
        lambda *args, **kwargs: calls.append(kwargs),
    )

    results = api_openlibrary.OpenLibraryClient().search(
        query="history",
        date_from="2024-01-01",
        date_to="2024-01-31",
    )

    assert results == []
    assert calls == []


@pytest.mark.parametrize("date_from, date_to", [
    ("0000", None),
    ("0999-12", None),
    (None, "0000-12-31"),
    (None, "0999"),
])
def test_openlibrary_search_rejects_out_of_range_input_year_without_request(
    monkeypatch, date_from, date_to,
):
    calls = []
    monkeypatch.setattr(
        api_openlibrary,
        "safe_request",
        lambda *args, **kwargs: calls.append(kwargs),
    )

    results = api_openlibrary.OpenLibraryClient().search(
        query="history", date_from=date_from, date_to=date_to,
    )

    assert results == []
    assert calls == []


def test_openlibrary_search_skips_malformed_and_yearless_filtered_records(monkeypatch):
    malformed = _openlibrary_record(key="", title="Missing key")
    yearless = _openlibrary_record(key="/works/OLYEARLESSW", first_publish_year=None)
    valid = _openlibrary_record(
        key="/works/OLVALIDW", title="A valid history", include_optional=False,
    )
    monkeypatch.setattr(
        api_openlibrary,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_openlibrary_payload([malformed, yearless, valid]),
        ),
    )

    results = api_openlibrary.OpenLibraryClient().search(
        query="history",
        date_from="2024",
        date_to="2024",
        max_results=5,
    )

    assert [result.external_id for result in results] == ["/works/OLVALIDW"]


@pytest.mark.parametrize("key", [
    "/books/OL123M",
    "/works/OL123W?edition=1",
    "/works/OL123W#details",
    "/works/OL123W/editions",
    "/works/",
    "/works/../books/OL123M",
])
def test_openlibrary_parse_record_rejects_noncanonical_work_keys(key):
    assert api_openlibrary.OpenLibraryClient._parse_record(
        _openlibrary_record(key=key),
    ) is None


@pytest.mark.parametrize("year, expected", [
    (999, None),
    (1000, "1000"),
    (9999, "9999"),
    (10000, None),
    ("0000", None),
    ("0999", None),
    ("1000", "1000"),
    ("9999", "9999"),
    ("10000", None),
])
def test_openlibrary_parse_record_accepts_only_four_digit_source_years_in_range(
    year, expected,
):
    parsed = api_openlibrary.OpenLibraryClient._parse_record(
        _openlibrary_record(first_publish_year=year),
    )

    assert parsed is not None
    assert parsed.publication_date == expected


def test_openlibrary_search_skips_invalid_source_year_under_date_constraint(monkeypatch):
    invalid = _openlibrary_record(
        key="/works/OLINVALIDYEARW", first_publish_year="0000",
    )
    valid = _openlibrary_record(key="/works/OLVALIDYEARW", first_publish_year=2024)
    monkeypatch.setattr(
        api_openlibrary,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_openlibrary_payload([invalid, valid]),
        ),
    )

    results = api_openlibrary.OpenLibraryClient().search(
        query="history",
        date_from="2024",
        date_to="2024",
    )

    assert [result.external_id for result in results] == ["/works/OLVALIDYEARW"]


@pytest.mark.parametrize("payload", [[], {}, {"docs": {}}])
def test_openlibrary_search_returns_empty_for_malformed_success_payload(
    monkeypatch, caplog, payload,
):
    monkeypatch.setattr(
        api_openlibrary,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=payload),
    )

    assert api_openlibrary.OpenLibraryClient().search(query="history") == []
    assert "response" in caplog.text.lower()


def test_openlibrary_search_returns_empty_on_non_200(monkeypatch):
    monkeypatch.setattr(
        api_openlibrary,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(status_code=503),
    )

    assert api_openlibrary.OpenLibraryClient().search(query="history") == []


def test_openlibrary_search_returns_empty_on_exception(monkeypatch):
    def _raise(*args, **kwargs):
        raise TimeoutError("upstream timed out")

    monkeypatch.setattr(api_openlibrary, "safe_request", _raise)

    assert api_openlibrary.OpenLibraryClient().search(query="history") == []


@pytest.mark.parametrize("failure", ["non_200", "malformed", "exception"])
def test_openlibrary_search_fails_closed_when_page_two_is_unusable(monkeypatch, failure):
    requested = []
    first_page = [
        _openlibrary_record(key=f"/works/OL{index}W", include_optional=False)
        for index in range(100)
    ]

    def _request(method, url, **kwargs):
        page = kwargs["params"]["page"]
        requested.append(page)
        if page == 1:
            return _FakeResponse(payload=_openlibrary_payload(first_page, total=101))
        if failure == "non_200":
            return _FakeResponse(status_code=503)
        if failure == "malformed":
            return _FakeResponse(payload={})
        raise TimeoutError("upstream timed out")

    monkeypatch.setattr(api_openlibrary, "safe_request", _request)

    assert api_openlibrary.OpenLibraryClient().search(
        query="history", max_results=101,
    ) == []
    assert requested == [1, 2]


def test_openlibrary_search_fails_closed_on_a_short_page_proven_by_num_found(monkeypatch):
    requested = []
    first_page = [
        _openlibrary_record(key=f"/works/OL{index}W", include_optional=False)
        for index in range(100)
    ]

    def _request(method, url, **kwargs):
        page = kwargs["params"]["page"]
        requested.append(page)
        records = first_page if page == 1 else [
            _openlibrary_record(key="/works/OLSHORTW", include_optional=False),
        ]
        return _FakeResponse(payload=_openlibrary_payload(records, total=102))

    monkeypatch.setattr(api_openlibrary, "safe_request", _request)

    assert api_openlibrary.OpenLibraryClient().search(
        query="history", max_results=102,
    ) == []
    assert requested == [1, 2]


def test_openlibrary_keeps_a_fixed_page_size_after_malformed_raw_records(monkeypatch):
    malformed = [_openlibrary_record(key="", include_optional=False) for _ in range(51)]
    valid = [
        _openlibrary_record(key=f"/works/OLRETAINED{index}W", include_optional=False)
        for index in range(51)
    ]
    requested = []

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        requested.append((params["page"], params["limit"]))
        records = malformed if params["page"] == 1 else valid
        return _FakeResponse(payload=_openlibrary_payload(records, total=102))

    monkeypatch.setattr(api_openlibrary, "safe_request", _request)

    results = api_openlibrary.OpenLibraryClient().search(
        query="history", max_results=51,
    )

    assert requested == [(1, 51), (2, 51)]
    assert [result.external_id for result in results] == [
        f"/works/OLRETAINED{index}W" for index in range(51)
    ]


@pytest.mark.parametrize("second_page", [[], [
    _openlibrary_record(key="/works/OLPARTIALW", include_optional=False),
]])
def test_openlibrary_fails_closed_when_declared_total_page_cannot_reach_cap(
    monkeypatch, second_page,
):
    malformed = [_openlibrary_record(key="", include_optional=False) for _ in range(51)]
    requested = []

    def _request(method, url, **kwargs):
        page = kwargs["params"]["page"]
        requested.append(page)
        records = malformed if page == 1 else second_page
        return _FakeResponse(payload=_openlibrary_payload(records, total=102))

    monkeypatch.setattr(api_openlibrary, "safe_request", _request)

    assert api_openlibrary.OpenLibraryClient().search(
        query="history", max_results=51,
    ) == []
    assert requested == [1, 2]


@pytest.mark.parametrize("declared_total", [None, "unknown"])
def test_openlibrary_accepts_valid_exhaustion_without_a_declared_total(
    monkeypatch, declared_total,
):
    first_page = [_openlibrary_record(include_optional=False)] + [
        _openlibrary_record(key="", include_optional=False) for _ in range(50)
    ]
    requested = []

    def _request(method, url, **kwargs):
        page = kwargs["params"]["page"]
        requested.append(page)
        payload = _openlibrary_payload(first_page if page == 1 else [])
        if declared_total is None:
            payload.pop("numFound")
        else:
            payload["numFound"] = declared_total
        return _FakeResponse(payload=payload)

    monkeypatch.setattr(api_openlibrary, "safe_request", _request)

    results = api_openlibrary.OpenLibraryClient().search(
        query="history", max_results=51,
    )

    assert requested == [1, 2]
    assert [result.external_id for result in results] == ["/works/OL123W"]


@pytest.mark.live_network
def test_openlibrary_live_search_returns_normalized_results():
    results = api_openlibrary.OpenLibraryClient().search(
        query="history", max_results=1,
    )

    assert results
    assert all(isinstance(result, NormalizedResult) for result in results)


_SRU = "http://www.loc.gov/zing/srw/"
_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
_DC_TERMS = "http://purl.org/dc/terms/"
_DCNDL = "http://ndl.go.jp/dcndl/terms/"
_FOAF = "http://xmlns.com/foaf/0.1/"


def _ndl_record(
    token,
    *,
    rights=("https://creativecommons.org/publicdomain/zero/1.0/",),
    provider="R100000002",
    title="NDL record",
    issued="2024-03-15",
    include_link=True,
    resource_token=None,
    abstract=None,
    description=None,
    doi=None,
):
    books_url = f"https://ndlsearch.ndl.go.jp/books/{token}"
    resource_books_url = (
        f"https://ndlsearch.ndl.go.jp/books/{resource_token}"
        if resource_token else books_url
    )
    material_url = f"{resource_books_url}#material"
    rights_xml = "".join(
        f'<dcndl:rights rdf:resource="{value}"/>' for value in rights
    )
    provider_xml = (
        f"<dcndl:bibRecordCategory>{provider}</dcndl:bibRecordCategory>"
        if provider is not None else ""
    )
    link_xml = f'<dcndl:record rdf:resource="{material_url}"/>' if include_link else ""
    abstract_xml = f"<dcterms:abstract>{abstract}</dcterms:abstract>" if abstract else ""
    description_xml = f"<dcterms:description>{description}</dcterms:description>" if description else ""
    doi_xml = (
        '<dcterms:identifier rdf:datatype="http://ndl.go.jp/dcndl/terms/DOI">'
        f"{doi}</dcterms:identifier>"
        if doi else ""
    )
    return f'''<record><recordData><rdf:RDF xmlns:rdf="{_RDF}" xmlns:dcterms="{_DC_TERMS}" xmlns:dcndl="{_DCNDL}" xmlns:foaf="{_FOAF}">
      <dcndl:BibResource rdf:about="{material_url}">
        <dcterms:title>{title}</dcterms:title>
        <dcterms:creator><foaf:Agent><foaf:name>Ada Lovelace</foaf:name></foaf:Agent></dcterms:creator>
        <dcterms:creator><foaf:Agent><foaf:name>Ada Lovelace</foaf:name></foaf:Agent></dcterms:creator>
        <dcterms:creator><foaf:Agent><foaf:name>Grace Hopper</foaf:name></foaf:Agent></dcterms:creator>
        <dcterms:issued>{issued}</dcterms:issued>{abstract_xml}{description_xml}{doi_xml}
      </dcndl:BibResource>
      <dcndl:BibAdminResource rdf:about="{books_url}">{provider_xml}{rights_xml}{link_xml}</dcndl:BibAdminResource>
    </rdf:RDF></recordData></record>'''


def _ndl_response(records, *, total=None):
    if total is None:
        total = len(records)
    return f'''<searchRetrieveResponse xmlns="{_SRU}">
      <numberOfRecords>{total}</numberOfRecords><records>{''.join(records)}</records>
    </searchRetrieveResponse>'''


def _ndl_xml_response(records, *, total=None, status_code=200):
    return _FakeResponse(status_code=status_code, payload=None, text=_ndl_response(records, total=total))


def test_ndl_search_sends_open_cql_query_and_normalizes_validated_record(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return _ndl_xml_response([_ndl_record("R100000002-I000000001")])

    monkeypatch.setattr(api_ndl_search, "safe_request", _request)

    results = api_ndl_search.NDLSearchClient().search(
        query='AI "systems" \\ biology', max_results=5,
    )

    assert calls == [(
        "GET",
        "https://ndlsearch.ndl.go.jp/api/sru",
        {
            "params": {
                "operation": "searchRetrieve",
                "version": "1.2",
                "query": 'dpid = "open" AND anywhere = "AI \\"systems\\" \\\\ biology"',
                "startRecord": 1,
                "maximumRecords": 5,
                "recordPacking": "xml",
                "recordSchema": "dcndl_v3",
            },
            "headers": {
                "User-Agent": "resmon (+https://github.com/ryanjosephkamp/resmon/issues)",
            },
            "rate_limiter": api_ndl_search._RATE_LIMITER,
        },
    )]
    assert api_ndl_search._RATE_LIMITER._interval == pytest.approx(2.0)
    assert results == [NormalizedResult(
        source_repository="ndl_search",
        external_id="R100000002-I000000001",
        doi=None,
        title="NDL record",
        authors=["Ada Lovelace", "Grace Hopper"],
        abstract=None,
        publication_date="2024-03-15",
        url="https://ndlsearch.ndl.go.jp/books/R100000002-I000000001",
        categories=[],
    )]


def test_ndl_search_keeps_only_records_with_one_recognized_metadata_right(monkeypatch):
    records = [
        _ndl_record("R100000002-I000000001", rights=("http://creativecommons.org/publicdomain/mark/1.0/",)),
        _ndl_record("R100000002-I000000002", rights=("https://creativecommons.org/publicdomain/zero/1.0",)),
        _ndl_record("R100000002-I000000003", rights=("http://creativecommons.org/licenses/by/4.0",)),
        _ndl_record("R100000002-I000000004", rights=("https://creativecommons.org/licenses/by-nc/4.0/",)),
        _ndl_record("R100000002-I000000005", rights=("https://creativecommons.org/licenses/by/4.0/", "https://example.invalid/unknown")),
        _ndl_record("R100000002-I000000006", rights=(), provider=""),
        _ndl_record("R100000002-I000000007", rights=()),
        _ndl_record("R100000002-I000000008", include_link=False),
        _ndl_record(
            "R100000002-I000000009",
            resource_token="R100000002-I000000099",
        ),
        _ndl_record(
            "R100000002-I000000010",
            rights=(" https://creativecommons.org/licenses/by/4.0/ ",),
        ),
    ]
    monkeypatch.setattr(
        api_ndl_search, "safe_request", lambda *args, **kwargs: _ndl_xml_response(records),
    )

    results = api_ndl_search.NDLSearchClient().search(query="history", max_results=10)

    assert [result.external_id for result in results] == [
        "R100000002-I000000001", "R100000002-I000000002", "R100000002-I000000003",
    ]


def test_ndl_search_fails_closed_on_a_short_raw_sru_page(monkeypatch, caplog):
    monkeypatch.setattr(
        api_ndl_search,
        "safe_request",
        lambda *args, **kwargs: _ndl_xml_response(
            [_ndl_record("R100000002-I000000011")], total=2,
        ),
    )

    assert api_ndl_search.NDLSearchClient().search(query="history", max_results=2) == []
    assert "incomplete" in caplog.text.lower()


def test_ndl_search_counts_legally_rejected_records_toward_raw_page_completeness(monkeypatch, caplog):
    allowed = _ndl_record("R100000002-I000000012")
    rejected = _ndl_record(
        "R100000002-I000000013",
        rights=("https://creativecommons.org/licenses/by-nc/4.0/",),
    )
    monkeypatch.setattr(
        api_ndl_search,
        "safe_request",
        lambda *args, **kwargs: _ndl_xml_response([allowed, rejected], total=2),
    )

    results = api_ndl_search.NDLSearchClient().search(query="history", max_results=2)

    assert [result.external_id for result in results] == ["R100000002-I000000012"]
    assert "incomplete" not in caplog.text.lower()


def test_ndl_search_uses_only_explicit_fields_and_linked_bibliographic_resource(monkeypatch):
    record = _ndl_record(
        "R100000002-I000000008",
        abstract="An explicit abstract",
        description="This description must not become an abstract",
        doi="10.1000/ndl.8",
    )
    monkeypatch.setattr(
        api_ndl_search, "safe_request", lambda *args, **kwargs: _ndl_xml_response([record]),
    )

    result = api_ndl_search.NDLSearchClient().search(query="history", max_results=1)[0]

    assert result.abstract == "An explicit abstract"
    assert result.doi == "10.1000/ndl.8"
    assert result.url == "https://ndlsearch.ndl.go.jp/books/R100000002-I000000008"


@pytest.mark.parametrize(("date_from", "date_to", "clauses"), [
    ("2024-03-04", "2024-03-05", ('from = "2024-03-04"', 'until = "2024-03-05"')),
    ("2024-03", "2024-04", ('from = "2024-03"', 'until = "2024-04"')),
    ("2024", "2025", ('from = "2024"', 'until = "2025"')),
    ("2024", "2024-03-05", ('from = "2024-01-01"', 'until = "2024-03-05"')),
])
def test_ndl_search_preserves_or_safely_aligns_documented_date_precision(
    monkeypatch, date_from, date_to, clauses,
):
    calls = []

    def _request(*args, **kwargs):
        calls.append(kwargs["params"]["query"])
        return _ndl_xml_response([])

    monkeypatch.setattr(api_ndl_search, "safe_request", _request)

    assert api_ndl_search.NDLSearchClient().search(
        query="history", date_from=date_from, date_to=date_to,
    ) == []
    assert len(calls) == 1
    assert all(clause in calls[0] for clause in clauses)


@pytest.mark.parametrize("date_from,date_to", [
    ("2024-02-30", None), (None, "2024-13"), ("2025-01-01", "2024-12-31"),
])
def test_ndl_search_rejects_invalid_or_inverted_dates_without_request(
    monkeypatch, date_from, date_to,
):
    calls = []
    monkeypatch.setattr(api_ndl_search, "safe_request", lambda *args, **kwargs: calls.append(kwargs))

    assert api_ndl_search.NDLSearchClient().search(
        query="history", date_from=date_from, date_to=date_to,
    ) == []
    assert calls == []


def test_ndl_search_partitions_large_bounded_result_sets_without_overlap_and_deduplicates(monkeypatch):
    calls = []
    first = _ndl_record("R100000002-I000000010")
    duplicate = _ndl_record("R100000002-I000000010")
    second = _ndl_record("R100000002-I000000011")

    def _request(*args, **kwargs):
        cql = kwargs["params"]["query"]
        calls.append((cql, kwargs["params"]["startRecord"], kwargs["params"]["maximumRecords"]))
        if 'from = "2024-01-01" AND until = "2024-01-02"' in cql:
            return _ndl_xml_response(["<record/>" for _ in range(500)], total=501)
        if 'from = "2024-01-01" AND until = "2024-01-01"' in cql:
            return _ndl_xml_response([first], total=1)
        if 'from = "2024-01-02" AND until = "2024-01-02"' in cql:
            return _ndl_xml_response([duplicate, second], total=2)
        raise AssertionError(cql)

    monkeypatch.setattr(api_ndl_search, "safe_request", _request)

    results = api_ndl_search.NDLSearchClient().search(
        query="history", date_from="2024-01-01", date_to="2024-01-02", max_results=501,
    )

    assert [result.external_id for result in results] == [
        "R100000002-I000000010", "R100000002-I000000011",
    ]
    assert calls == [
        (calls[0][0], 1, 500), (calls[1][0], 1, 500), (calls[2][0], 1, 500),
    ]
    assert 'from = "2024-01-01" AND until = "2024-01-02"' in calls[0][0]
    assert 'from = "2024-01-01" AND until = "2024-01-01"' in calls[1][0]
    assert 'from = "2024-01-02" AND until = "2024-01-02"' in calls[2][0]


def test_ndl_search_refuses_unbounded_large_request_without_calling_upstream(monkeypatch):
    calls = []
    monkeypatch.setattr(api_ndl_search, "safe_request", lambda *args, **kwargs: calls.append(kwargs))

    assert api_ndl_search.NDLSearchClient().search(query="history", max_results=501) == []
    assert calls == []


def test_ndl_search_fails_closed_when_one_day_still_exceeds_retrieval_ceiling(monkeypatch, caplog):
    monkeypatch.setattr(
        api_ndl_search,
        "safe_request",
        lambda *args, **kwargs: _ndl_xml_response(
            ["<record/>" for _ in range(500)], total=501,
        ),
    )

    assert api_ndl_search.NDLSearchClient().search(
        query="history", date_from="2024-01-01", date_to="2024-01-01", max_results=501,
    ) == []
    assert "exceeding the documented 500-record ceiling" in caplog.text


def test_ndl_search_honors_small_requested_cap_without_partitioning(monkeypatch):
    calls = []

    def _request(*args, **kwargs):
        calls.append(kwargs["params"])
        return _ndl_xml_response([_ndl_record("R100000002-I000000012")], total=900)

    monkeypatch.setattr(api_ndl_search, "safe_request", _request)

    results = api_ndl_search.NDLSearchClient().search(query="history", max_results=1)

    assert len(results) == 1
    assert calls[0]["maximumRecords"] == 1
    assert calls[0]["startRecord"] == 1


@pytest.mark.parametrize("response", [
    _FakeResponse(status_code=503, text=""),
    _FakeResponse(status_code=200, text="not xml"),
])
def test_ndl_search_returns_empty_with_diagnostic_on_bad_response(monkeypatch, caplog, response):
    monkeypatch.setattr(api_ndl_search, "safe_request", lambda *args, **kwargs: response)

    assert api_ndl_search.NDLSearchClient().search(query="history") == []
    assert "ndl" in caplog.text.lower()


def test_ndl_search_returns_empty_on_request_exception(monkeypatch, caplog):
    monkeypatch.setattr(
        api_ndl_search, "safe_request", lambda *args, **kwargs: (_ for _ in ()).throw(TimeoutError()),
    )

    assert api_ndl_search.NDLSearchClient().search(query="history") == []
    assert "ndl" in caplog.text.lower()


@pytest.mark.live_network
def test_ndl_search_live_search_returns_open_normalized_result():
    results = api_ndl_search.NDLSearchClient().search(query="人工知能", max_results=1)

    assert results
    assert all(isinstance(result, NormalizedResult) for result in results)
    assert all(result.source_repository == "ndl_search" for result in results)


def _datacite_record(
    doi="10.1234/data.1",
    *,
    title="Climate observations",
    publication_year=2024,
    issued="2024-03-15",
    include_optional=True,
):
    attributes = {
        "doi": doi,
        "titles": [
            {"title": "A subtitle", "titleType": "Subtitle"},
            {"title": title},
        ],
        "creators": [
            {"name": "Doe, Jane"},
            {"name": "Rao, Priya"},
        ],
        "publicationYear": publication_year,
        "dates": (
            [{"date": issued, "dateType": "Issued"}]
            if issued is not None else []
        ),
        "descriptions": [],
        "subjects": [],
    }
    if include_optional:
        attributes["descriptions"] = [
            {"descriptionType": "Methods", "description": "Not an abstract."},
            {"descriptionType": "Abstract", "description": "Measured observations."},
        ]
        attributes["subjects"] = [
            {"subject": f"subject-{index}"} for index in range(1, 12)
        ]
    return {"id": doi, "type": "dois", "attributes": attributes}


def _datacite_payload(records, *, total=None, page=1, total_pages=1):
    if total is None:
        total = len(records)
    return {
        "data": records,
        "meta": {"total": total, "totalPages": total_pages, "page": page},
        "links": {"next": None},
    }


def test_datacite_search_uses_year_filter_and_normalizes_metadata(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return _FakeResponse(payload=_datacite_payload([_datacite_record()]))

    monkeypatch.setattr(api_datacite, "safe_request", _request)

    results = api_datacite.DataCiteClient().search(
        query="climate data",
        date_from="2024-01-01",
        date_to="2024-12-31",
        max_results=5,
    )

    assert calls == [(
        "GET",
        "https://api.datacite.org/dois",
        {
            "params": {
                "query": "climate data",
                "published": "2024",
                "page[size]": 5,
                "page[number]": 1,
                "sort": "relevance",
            },
            "rate_limiter": api_datacite._RATE_LIMITER,
        },
    )]
    assert api_datacite._RATE_LIMITER._interval == pytest.approx(2.0 / 3.0)
    assert results == [NormalizedResult(
        source_repository="datacite",
        external_id="10.1234/data.1",
        doi="10.1234/data.1",
        title="Climate observations",
        authors=["Doe, Jane", "Rao, Priya"],
        abstract="Measured observations.",
        publication_date="2024-03-15",
        url="https://doi.org/10.1234/data.1",
        categories=[f"subject-{index}" for index in range(1, 11)],
    )]


def test_datacite_search_keeps_page_size_constant(monkeypatch):
    requested = []
    records = [
        _datacite_record(doi=f"10.1234/data.{index}", include_optional=False)
        for index in range(1, 1002)
    ]

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        page = params["page[number]"]
        size = params["page[size]"]
        requested.append((page, size))
        start = (page - 1) * size
        page_records = records[start:start + size]
        return _FakeResponse(payload=_datacite_payload(
            page_records,
            total=len(records),
            page=page,
            total_pages=2,
        ))

    monkeypatch.setattr(api_datacite, "safe_request", _request)

    results = api_datacite.DataCiteClient().search(
        query="climate", max_results=1001,
    )

    assert requested == [(1, 1000), (2, 1000)]
    assert [result.external_id for result in results] == [
        f"10.1234/data.{index}" for index in range(1, 1002)
    ]


def test_datacite_search_enforces_exact_window_only_for_precise_dates(monkeypatch):
    records = [
        _datacite_record(doi="10.1234/january", issued="2024-01-15"),
        _datacite_record(doi="10.1234/february", issued="2024-02-15"),
        _datacite_record(doi="10.1234/year-only", issued=None),
    ]
    monkeypatch.setattr(
        api_datacite,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_datacite_payload(records),
        ),
    )

    results = api_datacite.DataCiteClient().search(
        query="climate",
        date_from="2024-01-01",
        date_to="2024-01-31",
        max_results=5,
    )

    assert [result.external_id for result in results] == ["10.1234/january"]


def test_datacite_search_skips_malformed_and_preserves_year_precision(monkeypatch):
    valid = _datacite_record(
        doi="10.1234/year-only",
        title="Year-only record",
        issued=None,
        include_optional=False,
    )
    malformed = _datacite_record(doi="10.1234/no-title")
    malformed["attributes"]["titles"] = []
    monkeypatch.setattr(
        api_datacite,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_datacite_payload([malformed, valid]),
        ),
    )

    results = api_datacite.DataCiteClient().search(
        query="climate", max_results=5,
    )

    assert results == [NormalizedResult(
        source_repository="datacite",
        external_id="10.1234/year-only",
        doi="10.1234/year-only",
        title="Year-only record",
        authors=["Doe, Jane", "Rao, Priya"],
        abstract=None,
        publication_date="2024",
        url="https://doi.org/10.1234/year-only",
        categories=[],
    )]


def test_datacite_search_returns_empty_when_upstream_has_no_hits(monkeypatch):
    monkeypatch.setattr(
        api_datacite,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_datacite_payload([], total=0, total_pages=0),
        ),
    )

    assert api_datacite.DataCiteClient().search(query="no-such-result") == []


@pytest.mark.parametrize("payload", [[], {}, {"data": {"unexpected": "object"}}])
def test_datacite_search_logs_malformed_success_payload(monkeypatch, caplog, payload):
    monkeypatch.setattr(
        api_datacite,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=payload),
    )

    assert api_datacite.DataCiteClient().search(query="climate") == []
    assert "response" in caplog.text.lower()


def test_datacite_search_returns_empty_on_non_200(monkeypatch):
    monkeypatch.setattr(
        api_datacite,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(status_code=503),
    )

    assert api_datacite.DataCiteClient().search(query="climate") == []


def test_datacite_search_returns_empty_on_timeout(monkeypatch):
    def _timeout(*args, **kwargs):
        raise TimeoutError("upstream timed out")

    monkeypatch.setattr(api_datacite, "safe_request", _timeout)

    assert api_datacite.DataCiteClient().search(query="climate") == []


def _eric_doc(
    eric_id="EJ1234567",
    *,
    title="Teachers&apos; climate learning",
    publication_date=2024,
    include_optional=True,
):
    doc = {
        "id": eric_id,
        "title": title,
        "publicationdateyear": publication_date,
    }
    if include_optional:
        doc.update({
            "author": ["Doe, Jane", "Rao, Priya"],
            "description": "An &amp; abstract.",
            "subject": [f"subject-{index}" for index in range(1, 12)],
            "publicationtype": ["Journal Articles", "Reports - Research"],
            "url": "http://dx.doi.org/10.1000/eric.1",
        })
    return doc


def _eric_payload(docs, *, total=None, start=0):
    if total is None:
        total = len(docs)
    return {
        "response": {
            "numFound": total,
            "start": start,
            "numFoundExact": True,
            "docs": docs,
        },
    }


def test_eric_search_builds_year_query_and_normalizes_text_plain_json(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return _FakeResponse(payload=_eric_payload([_eric_doc()]))

    monkeypatch.setattr(api_eric, "safe_request", _request)

    results = api_eric.EricClient().search(
        query="climate education",
        date_from="2024-01-01",
        date_to="2024-12-31",
        max_results=5,
    )

    assert calls == [(
        "GET",
        "https://api.ies.ed.gov/eric/",
        {
            "params": {
                "search": "(climate education) AND publicationdateyear:2024",
                "format": "json",
                "start": 0,
                "rows": 5,
                "fields": (
                    "id,title,author,description,publicationdateyear,subject,"
                    "url"
                ),
            },
            "rate_limiter": api_eric._RATE_LIMITER,
        },
    )]
    assert api_eric._RATE_LIMITER._interval == pytest.approx(2.0)
    assert results == [NormalizedResult(
        source_repository="eric",
        external_id="EJ1234567",
        doi="10.1000/eric.1",
        title="Teachers' climate learning",
        authors=["Doe, Jane", "Rao, Priya"],
        abstract="An & abstract.",
        publication_date="2024",
        url="https://eric.ed.gov/?id=EJ1234567",
        categories=[f"subject-{index}" for index in range(1, 11)],
    )]


def test_eric_search_keeps_rows_constant_across_offsets(monkeypatch):
    requested = []
    docs = [
        _eric_doc(eric_id=f"EJ{index:07d}", include_optional=False)
        for index in range(1, 2002)
    ]

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        start = params["start"]
        rows = params["rows"]
        requested.append((start, rows))
        page_docs = docs[start:start + rows]
        return _FakeResponse(payload=_eric_payload(
            page_docs, total=len(docs), start=start,
        ))

    monkeypatch.setattr(api_eric, "safe_request", _request)

    results = api_eric.EricClient().search(
        query="education", max_results=2001,
    )

    assert requested == [(0, 2000), (2000, 2000)]
    assert [result.external_id for result in results] == [
        f"EJ{index:07d}" for index in range(1, 2002)
    ]


def test_eric_search_does_not_claim_year_only_date_fits_partial_window(monkeypatch):
    calls = []

    def _request(*args, **kwargs):
        calls.append(kwargs["params"]["start"])
        return _FakeResponse(payload=_eric_payload(
            [_eric_doc(publication_date=2024)], total=3,
            start=kwargs["params"]["start"],
        ))

    monkeypatch.setattr(
        api_eric,
        "safe_request",
        _request,
    )

    results = api_eric.EricClient().search(
        query="education",
        date_from="2024-01-01",
        date_to="2024-01-31",
        max_results=5,
    )

    assert results == []
    assert calls == []


def test_eric_search_rejects_reversed_date_window_without_request(monkeypatch):
    calls = []
    monkeypatch.setattr(
        api_eric,
        "safe_request",
        lambda *args, **kwargs: calls.append(kwargs),
    )

    results = api_eric.EricClient().search(
        query="education",
        date_from="2025-01-01",
        date_to="2024-12-31",
        max_results=5,
    )

    assert results == []
    assert calls == []


def test_eric_search_expands_year_only_request_bounds(monkeypatch):
    monkeypatch.setattr(
        api_eric,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_eric_payload([_eric_doc(publication_date=2024)]),
        ),
    )

    results = api_eric.EricClient().search(
        query="education",
        date_from="2024",
        date_to="2024",
        max_results=5,
    )

    assert [result.publication_date for result in results] == ["2024"]


def test_eric_search_skips_malformed_and_allows_optional_fields(monkeypatch):
    malformed = _eric_doc(eric_id="EJ0000001")
    malformed["title"] = ""
    valid = _eric_doc(
        eric_id="ED7654321",
        title="A government report",
        publication_date="2023",
        include_optional=False,
    )
    monkeypatch.setattr(
        api_eric,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_eric_payload([malformed, valid]),
        ),
    )

    results = api_eric.EricClient().search(query="education", max_results=5)

    assert results == [NormalizedResult(
        source_repository="eric",
        external_id="ED7654321",
        doi=None,
        title="A government report",
        authors=[],
        abstract=None,
        publication_date="2023",
        url="https://eric.ed.gov/?id=ED7654321",
        categories=[],
    )]


def test_eric_search_returns_empty_when_upstream_has_no_hits(monkeypatch):
    monkeypatch.setattr(
        api_eric,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_eric_payload([], total=0),
        ),
    )

    assert api_eric.EricClient().search(query="no-such-result") == []


@pytest.mark.parametrize("payload", [[], {}, {"response": {"docs": {}}}])
def test_eric_search_logs_malformed_success_payload(monkeypatch, caplog, payload):
    monkeypatch.setattr(
        api_eric,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=payload),
    )

    assert api_eric.EricClient().search(query="education") == []
    assert "response" in caplog.text.lower()


def test_eric_search_returns_empty_on_non_200(monkeypatch):
    monkeypatch.setattr(
        api_eric,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(status_code=503),
    )

    assert api_eric.EricClient().search(query="education") == []


def test_eric_search_returns_empty_on_timeout(monkeypatch):
    def _timeout(*args, **kwargs):
        raise TimeoutError("upstream timed out")

    monkeypatch.setattr(api_eric, "safe_request", _timeout)

    assert api_eric.EricClient().search(query="education") == []


def _medrxiv_payload(*, title="Cardiac outcomes", abstract="Cardiac health"):
    return {
        "messages": [{"status": "ok", "total": 1}],
        "collection": [{
            "doi": "10.1101/2024.01.01.123456",
            "title": title,
            "authors": "Rao, Priya; Smith, Alex",
            "abstract": abstract,
            "date": "2024-01-02",
            "category": "Cardiovascular Medicine",
        }],
    }


def test_medrxiv_registry_uses_medrxiv_default():
    client = get_client("medrxiv")

    assert client.get_name() == "medRxiv"


def test_medrxiv_search_returns_normalized_medrxiv_results(monkeypatch):
    monkeypatch.setattr(
        api_biorxiv,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=_medrxiv_payload()),
    )

    results = get_client("medrxiv").search(
        query="cardiac",
        date_from="2024-01-01",
        date_to="2024-01-07",
        max_results=1,
    )

    assert results == [NormalizedResult(
        source_repository="medrxiv",
        external_id="10.1101/2024.01.01.123456",
        doi="10.1101/2024.01.01.123456",
        title="Cardiac outcomes",
        authors=["Rao, Priya", "Smith, Alex"],
        abstract="Cardiac health",
        publication_date="2024-01-02",
        url="https://doi.org/10.1101/2024.01.01.123456",
        categories=["Cardiovascular Medicine"],
    )]


def test_medrxiv_search_returns_empty_for_no_keyword_match(monkeypatch):
    monkeypatch.setattr(
        api_biorxiv,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=_medrxiv_payload()),
    )

    assert get_client("medrxiv").search(query="quantum", max_results=1) == []


def test_medrxiv_search_returns_empty_on_non_200(monkeypatch):
    monkeypatch.setattr(
        api_biorxiv,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(status_code=503),
    )

    assert get_client("medrxiv").search(query="cardiac", max_results=1) == []


def test_medrxiv_search_returns_empty_on_timeout(monkeypatch):
    def _timeout(*args, **kwargs):
        raise TimeoutError("upstream timed out")

    monkeypatch.setattr(api_biorxiv, "safe_request", _timeout)

    assert get_client("medrxiv").search(query="cardiac", max_results=1) == []


def _dryad_record(
    dataset_id=12345,
    *,
    title="Climate observations dataset",
):
    return {
        "id": dataset_id,
        "identifier": "doi:10.5061/dryad.ab12cd34",
        "title": title,
        "authors": [
            {
                "firstName": "Jane",
                "lastName": "Doe",
                "email": "jane@example.edu",
            },
            {"firstName": "Priya", "lastName": "Rao"},
        ],
        "abstract": "<p>Measurements &amp; observations from <strong>field stations</strong>.</p>",
        "publicationDate": "2024-01-15",
        "keywords": ["climate", "observations"],
    }


def _dryad_payload(records, *, total=None):
    if total is None:
        total = len(records)
    return {
        "_embedded": {"stash:datasets": records},
        "total": total,
    }


def test_dryad_search_sends_date_params_and_normalizes_without_emails(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return _FakeResponse(payload=_dryad_payload([_dryad_record()]))

    monkeypatch.setattr(api_dryad, "safe_request", _request)

    results = get_client("dryad").search(
        query="climate data",
        date_from="2024-01-01",
        date_to="2024-01-31",
        max_results=5,
    )

    assert calls == [(
        "GET",
        "https://datadryad.org/api/v2/search",
        {
            "params": {
                "q": "climate data",
                "publishedSince": "2024-01-01",
                "publishedBefore": "2024-01-31",
                "page": 1,
                "per_page": 5,
            },
            "rate_limiter": api_dryad._RATE_LIMITER,
        },
    )]
    assert results == [NormalizedResult(
        source_repository="dryad",
        external_id="doi:10.5061/dryad.ab12cd34",
        doi="10.5061/dryad.ab12cd34",
        title="Climate observations dataset",
        authors=["Jane Doe", "Priya Rao"],
        abstract="Measurements & observations from field stations.",
        publication_date="2024-01-15",
        url="https://doi.org/10.5061/dryad.ab12cd34",
        categories=["climate", "observations"],
    )]


def test_dryad_search_pages_at_documented_limit(monkeypatch):
    requested = []
    records = [
        {
            **_dryad_record(dataset_id=index),
            "identifier": f"doi:10.5061/dryad.{index:08d}",
        }
        for index in range(101)
    ]

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        requested.append((params["page"], params["per_page"]))
        start = (params["page"] - 1) * params["per_page"]
        return _FakeResponse(payload=_dryad_payload(
            records[start:start + params["per_page"]], total=len(records),
        ))

    monkeypatch.setattr(api_dryad, "safe_request", _request)

    results = get_client("dryad").search(query="climate", max_results=101)

    assert requested == [(1, 100), (2, 100)]
    assert [result.external_id for result in results] == [
        f"doi:10.5061/dryad.{index:08d}" for index in range(101)
    ]


def test_dryad_search_skips_malformed_records(monkeypatch):
    valid = {
        **_dryad_record(dataset_id=12346),
        "identifier": "doi:10.5061/dryad.valid",
    }
    monkeypatch.setattr(
        api_dryad,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=_dryad_payload([
            {"id": "doi:10.5061/dryad.no-title"},
            {"title": "No stable identifier"},
            {"id": 12347, "title": "Internal identifier only"},
            valid,
        ])),
    )

    results = get_client("dryad").search(query="climate", max_results=5)

    assert [result.external_id for result in results] == ["doi:10.5061/dryad.valid"]


@pytest.mark.parametrize("response", [
    _FakeResponse(status_code=503),
    TimeoutError("upstream timed out"),
])
def test_dryad_search_returns_empty_on_upstream_failure(monkeypatch, response):
    def _request(*args, **kwargs):
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(api_dryad, "safe_request", _request)

    assert get_client("dryad").search(query="climate") == []


@pytest.mark.parametrize("failure", ["non_200", "malformed", "exception"])
def test_dryad_search_fails_closed_when_page_two_is_unusable(monkeypatch, failure):
    requested = []
    first_page = [
        {
            **_dryad_record(dataset_id=index),
            "identifier": f"doi:10.5061/dryad.page-two-{index:04d}",
        }
        for index in range(100)
    ]

    def _request(method, url, **kwargs):
        page = kwargs["params"]["page"]
        requested.append(page)
        if page == 1:
            return _FakeResponse(payload=_dryad_payload(first_page, total=101))
        if failure == "non_200":
            return _FakeResponse(status_code=503)
        if failure == "malformed":
            return _FakeResponse(payload={})
        raise TimeoutError("upstream timed out")

    monkeypatch.setattr(api_dryad, "safe_request", _request)

    assert get_client("dryad").search(query="climate", max_results=101) == []
    assert requested == [1, 2]


def test_dryad_search_fails_closed_on_a_short_page_proven_by_total(monkeypatch):
    requested = []
    first_page = [
        {
            **_dryad_record(dataset_id=index),
            "identifier": f"doi:10.5061/dryad.short-page-{index:04d}",
        }
        for index in range(100)
    ]

    def _request(method, url, **kwargs):
        page = kwargs["params"]["page"]
        requested.append(page)
        records = first_page if page == 1 else [{
            **_dryad_record(dataset_id=101),
            "identifier": "doi:10.5061/dryad.short-page-0101",
        }]
        return _FakeResponse(payload=_dryad_payload(records, total=102))

    monkeypatch.setattr(api_dryad, "safe_request", _request)

    assert get_client("dryad").search(query="climate", max_results=102) == []
    assert requested == [1, 2]


def test_dryad_keeps_a_fixed_page_size_after_malformed_raw_records(monkeypatch):
    malformed = [{"title": "Missing identifier"} for _ in range(51)]
    valid = [
        {
            **_dryad_record(dataset_id=index),
            "identifier": f"doi:10.5061/dryad.retained-{index:04d}",
        }
        for index in range(51)
    ]
    requested = []

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        requested.append((params["page"], params["per_page"]))
        records = malformed if params["page"] == 1 else valid
        return _FakeResponse(payload=_dryad_payload(records, total=102))

    monkeypatch.setattr(api_dryad, "safe_request", _request)

    results = get_client("dryad").search(query="climate", max_results=51)

    assert requested == [(1, 51), (2, 51)]
    assert [result.external_id for result in results] == [
        f"doi:10.5061/dryad.retained-{index:04d}" for index in range(51)
    ]


@pytest.mark.parametrize("second_page", [[], [{
    **_dryad_record(dataset_id=999),
    "identifier": "doi:10.5061/dryad.partial",
}]])
def test_dryad_fails_closed_when_declared_total_page_cannot_reach_cap(
    monkeypatch, second_page,
):
    malformed = [{"title": "Missing identifier"} for _ in range(51)]
    requested = []

    def _request(method, url, **kwargs):
        page = kwargs["params"]["page"]
        requested.append(page)
        records = malformed if page == 1 else second_page
        return _FakeResponse(payload=_dryad_payload(records, total=102))

    monkeypatch.setattr(api_dryad, "safe_request", _request)

    assert get_client("dryad").search(query="climate", max_results=51) == []
    assert requested == [1, 2]


@pytest.mark.parametrize("declared_total", [None, "unknown"])
def test_dryad_accepts_valid_exhaustion_without_a_declared_total(
    monkeypatch, declared_total,
):
    first_page = [_dryad_record()] + [
        {"title": "Missing identifier"} for _ in range(50)
    ]
    requested = []

    def _request(method, url, **kwargs):
        page = kwargs["params"]["page"]
        requested.append(page)
        payload = _dryad_payload(first_page if page == 1 else [])
        if declared_total is None:
            payload.pop("total")
        else:
            payload["total"] = declared_total
        return _FakeResponse(payload=payload)

    monkeypatch.setattr(api_dryad, "safe_request", _request)

    results = get_client("dryad").search(query="climate", max_results=51)

    assert requested == [1, 2]
    assert [result.external_id for result in results] == [
        "doi:10.5061/dryad.ab12cd34",
    ]


def _zenodo_record(
    record_id=101,
    *,
    title="Climate data",
    doi="10.5281/zenodo.101",
    links=None,
):
    return {
        "id": record_id,
        "doi": doi,
        "metadata": {
            "title": title,
            "creators": [
                {"name": "Doe, Jane"},
                {"name": "Rao, Priya"},
            ],
            "description": "<p>A <strong>bold</strong> abstract &amp; details.</p>",
            "publication_date": "2024-01-15",
            "keywords": [f"Keyword {index}" for index in range(1, 10)],
            "resource_type": {"title": "Dataset"},
        },
        "links": links if links is not None else {
            "self_html": f"https://zenodo.org/records/{record_id}",
        },
    }


def test_zenodo_search_builds_date_query_and_normalizes_results(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return _FakeResponse(payload={
            "hits": {"total": 1, "hits": [_zenodo_record()]},
        })

    monkeypatch.setattr(api_zenodo, "safe_request", _request)

    results = get_client("zenodo").search(
        query="climate data",
        date_from="2024-01-01",
        date_to="2024-01-31",
        max_results=5,
    )

    assert calls[0][0:2] == ("GET", "https://zenodo.org/api/records")
    assert calls[0][2]["params"] == {
        "q": "(climate data) AND publication_date:[2024-01-01 TO 2024-01-31]",
        "size": 5,
        "page": 1,
        "sort": "bestmatch",
    }
    assert calls[0][2]["rate_limiter"] is api_zenodo._RATE_LIMITER
    assert results == [NormalizedResult(
        source_repository="zenodo",
        external_id="101",
        doi="10.5281/zenodo.101",
        title="Climate data",
        authors=["Doe, Jane", "Rao, Priya"],
        abstract="A bold abstract & details.",
        publication_date="2024-01-15",
        url="https://zenodo.org/records/101",
        categories=[
            "Keyword 1", "Keyword 2", "Keyword 3", "Keyword 4", "Keyword 5",
            "Keyword 6", "Keyword 7", "Keyword 8", "Keyword 9", "Dataset",
        ],
    )]


def test_zenodo_search_pages_at_anonymous_limit(monkeypatch):
    requested = []
    records = [_zenodo_record(record_id=index) for index in range(1, 51)]

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        requested.append((params["page"], params["size"]))
        start = (params["page"] - 1) * params["size"]
        page_records = records[start:start + params["size"]]
        return _FakeResponse(payload={
            "hits": {"total": len(records), "hits": page_records},
        })

    monkeypatch.setattr(api_zenodo, "safe_request", _request)

    results = get_client("zenodo").search(query="climate", max_results=30)

    assert requested == [(1, 25), (2, 25)]
    assert [result.external_id for result in results] == [
        str(index) for index in range(1, 31)
    ]


def test_zenodo_search_skips_malformed_records_and_uses_doi_url(monkeypatch):
    valid = _zenodo_record(
        record_id=202,
        doi="10.5281/zenodo.202",
        links={},
    )
    payload = {
        "hits": {
            "total": 2,
            "hits": [{"id": 201, "metadata": {}}, valid],
        },
    }
    monkeypatch.setattr(
        api_zenodo,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=payload),
    )

    results = get_client("zenodo").search(query="climate", max_results=5)

    assert [result.external_id for result in results] == ["202"]
    assert results[0].url == "https://doi.org/10.5281/zenodo.202"


def test_zenodo_search_returns_empty_when_upstream_has_no_hits(monkeypatch):
    monkeypatch.setattr(
        api_zenodo,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload={"hits": {"total": 0, "hits": []}},
        ),
    )

    assert get_client("zenodo").search(query="no-such-result") == []


@pytest.mark.parametrize("payload", [
    {},
    {"hits": {"total": 1, "hits": {"unexpected": "object"}}},
])
def test_zenodo_search_logs_malformed_success_payload(monkeypatch, caplog, payload):
    monkeypatch.setattr(
        api_zenodo,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=payload),
    )

    assert get_client("zenodo").search(query="climate") == []
    assert "response" in caplog.text.lower()


def test_zenodo_search_returns_empty_on_non_200(monkeypatch):
    monkeypatch.setattr(
        api_zenodo,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(status_code=503),
    )

    assert get_client("zenodo").search(query="climate") == []


def test_zenodo_search_returns_empty_on_timeout(monkeypatch):
    def _timeout(*args, **kwargs):
        raise TimeoutError("upstream timed out")

    monkeypatch.setattr(api_zenodo, "safe_request", _timeout)

    assert get_client("zenodo").search(query="climate") == []


def _inspire_record(
    control_number=301,
    *,
    title="Quantum gravity amplitudes",
    include_optional=True,
):
    metadata = {
        "control_number": control_number,
        "titles": [{"title": title}],
        "authors": [
            {"full_name": "Einstein, Albert"},
            {"full_name": "Noether, Emmy"},
        ],
        "earliest_date": "2024-04-15",
        "arxiv_eprints": [{"value": "2404.01234"}],
        "inspire_categories": [
            {"term": "Theory-HEP"},
            {"term": "Gravitation and Cosmology"},
        ],
    }
    if include_optional:
        metadata["dois"] = [{"value": "10.1000/inspire.301"}]
        metadata["abstracts"] = [{"value": "An upstream abstract.", "source": "arXiv"}]
    return {"metadata": metadata}


def test_inspire_search_builds_projected_date_query_and_normalizes(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return _FakeResponse(payload={
            "hits": {"total": 1, "hits": [_inspire_record()]},
        })

    monkeypatch.setattr(api_inspire_hep, "safe_request", _request)

    results = get_client("inspire_hep").search(
        query="quantum gravity",
        date_from="2024-04-01",
        date_to="2024-04-30",
        max_results=5,
    )

    assert calls[0][0:2] == (
        "GET",
        "https://inspirehep.net/api/literature",
    )
    assert calls[0][2]["params"] == {
        "q": "(quantum gravity) and de>2024-04-01 and de<2024-04-30",
        "size": 5,
        "page": 1,
        "sort": "mostrecent",
        "fields": (
            "titles,dois,authors,abstracts,earliest_date,control_number,"
            "arxiv_eprints,inspire_categories"
        ),
    }
    assert calls[0][2]["rate_limiter"] is api_inspire_hep._RATE_LIMITER
    assert calls[0][2]["max_retries"] == 0
    assert results == [NormalizedResult(
        source_repository="inspire_hep",
        external_id="301",
        doi="10.1000/inspire.301",
        title="Quantum gravity amplitudes",
        authors=["Einstein, Albert", "Noether, Emmy"],
        abstract="An upstream abstract.",
        publication_date="2024-04-15",
        url="https://inspirehep.net/literature/301",
        categories=["Theory-HEP", "Gravitation and Cosmology"],
    )]


def test_inspire_search_keeps_page_size_constant(monkeypatch):
    requested = []
    records = [_inspire_record(control_number=index) for index in range(1, 151)]

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        requested.append((params["page"], params["size"]))
        start = (params["page"] - 1) * params["size"]
        page_records = records[start:start + params["size"]]
        return _FakeResponse(payload={
            "hits": {"total": len(records), "hits": page_records},
        })

    monkeypatch.setattr(api_inspire_hep, "safe_request", _request)

    results = get_client("inspire_hep").search(query="quantum", max_results=125)

    assert requested == [(1, 100), (2, 100)]
    assert [result.external_id for result in results] == [
        str(index) for index in range(1, 126)
    ]


def test_inspire_search_skips_malformed_and_allows_optional_fields(monkeypatch):
    valid = _inspire_record(
        control_number=302,
        title="Field theory",
        include_optional=False,
    )
    payload = {
        "hits": {
            "total": 2,
            "hits": [{"metadata": {"control_number": 999}}, valid],
        },
    }
    monkeypatch.setattr(
        api_inspire_hep,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=payload),
    )

    results = get_client("inspire_hep").search(query="theory", max_results=5)

    assert [result.external_id for result in results] == ["302"]
    assert results[0].doi is None
    assert results[0].abstract is None


def test_inspire_search_returns_empty_when_upstream_has_no_hits(monkeypatch):
    monkeypatch.setattr(
        api_inspire_hep,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload={"hits": {"total": 0, "hits": []}},
        ),
    )

    assert get_client("inspire_hep").search(query="no-such-result") == []


def test_inspire_search_returns_empty_on_non_200(monkeypatch):
    calls = []
    waits = []

    def _unavailable(*args, **kwargs):
        calls.append(kwargs)
        return _FakeResponse(status_code=503)

    monkeypatch.setattr(
        api_inspire_hep,
        "safe_request",
        _unavailable,
    )
    monkeypatch.setattr(api_inspire_hep.time, "sleep", waits.append)

    assert get_client("inspire_hep").search(query="quantum") == []
    assert len(calls) == 4
    assert waits == [1, 2, 4]


def test_inspire_search_does_not_retry_rate_limit_response(monkeypatch):
    calls = []
    waits = []

    def _rate_limited(*args, **kwargs):
        calls.append(kwargs)
        return _FakeResponse(status_code=429)

    monkeypatch.setattr(api_inspire_hep, "safe_request", _rate_limited)
    monkeypatch.setattr(api_inspire_hep.time, "sleep", waits.append)
    monkeypatch.setattr(api_inspire_hep, "_cooldown_until", 0.0, raising=False)

    assert get_client("inspire_hep").search(query="quantum") == []
    assert len(calls) == 1
    assert waits == []


def test_inspire_rate_limit_cooldown_is_shared_between_clients(monkeypatch):
    responses = iter([
        _FakeResponse(status_code=429),
        _FakeResponse(payload={"hits": {"total": 0, "hits": []}}),
    ])
    now = [100.0]
    waits = []

    def _request(*args, **kwargs):
        return next(responses)

    def _sleep(seconds):
        waits.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(api_inspire_hep, "safe_request", _request)
    monkeypatch.setattr(api_inspire_hep.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(api_inspire_hep.time, "sleep", _sleep)
    monkeypatch.setattr(api_inspire_hep, "_cooldown_until", 0.0, raising=False)

    assert get_client("inspire_hep").search(query="first") == []
    assert get_client("inspire_hep").search(query="second") == []
    assert waits == [5.0]


def test_inspire_search_returns_empty_on_timeout(monkeypatch):
    calls = []
    waits = []

    def _timeout(*args, **kwargs):
        calls.append(kwargs)
        raise httpx.ReadTimeout("upstream timed out")

    monkeypatch.setattr(api_inspire_hep, "safe_request", _timeout)
    monkeypatch.setattr(api_inspire_hep.time, "sleep", waits.append)

    assert get_client("inspire_hep").search(query="quantum") == []
    assert len(calls) == 4
    assert waits == [1, 2, 4]


def _openaire_record(
    external_id="openaire::record-1",
    *,
    doi="10.1000/openaire.1",
    title="Open science infrastructures",
    authors=None,
    categories=None,
    list_fields=False,
):
    pid_nodes = [{"@classid": "handle", "$": "12345/example"}]
    if doi is not None:
        pid_nodes.append({"@classid": "doi", "$": doi})

    title_nodes = []
    if list_fields:
        title_nodes.append({"@classid": "subtitle", "$": "A subtitle"})
    title_nodes.append({"@classid": "main title", "$": title})

    if authors is None:
        creator_node = None
    else:
        creator_nodes = [{"$": author} for author in authors]
        creator_node = creator_nodes if list_fields else creator_nodes[0]

    subject_nodes = [{"$": category} for category in (categories or [])]
    subject_node = (
        subject_nodes
        if list_fields or len(subject_nodes) != 1
        else subject_nodes[0]
    )

    result = {
        "pid": pid_nodes if list_fields else pid_nodes[-1],
        "title": title_nodes if list_fields else title_nodes[0],
        "creator": creator_node,
        "description": {"$": "An OpenAIRE abstract."},
        "dateofacceptance": {"$": "2024-02-15"},
        "subject": subject_node or None,
    }
    return {
        "header": {"dri:objIdentifier": {"$": external_id}},
        "metadata": {"oaf:entity": {"oaf:result": result}},
    }


def _openaire_payload(records, *, total=None):
    if total is None:
        total = len(records) if isinstance(records, list) else 1
    return {
        "response": {
            "header": {"total": {"$": total}},
            "results": {"result": records},
        },
    }


def test_openaire_as_list_normalizes_cardinality():
    node = {"$": "value"}
    nodes = [node]

    assert api_openaire._as_list(None) == []
    assert api_openaire._as_list(node) == [node]
    assert api_openaire._as_list(nodes) is nodes


def test_openaire_search_builds_date_query_and_normalizes_singletons(monkeypatch):
    calls = []
    record = _openaire_record(
        external_id="50|record/1",
        authors=None,
        categories=[f"subject-{index}" for index in range(12)],
    )

    def _request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return _FakeResponse(payload=_openaire_payload(record))

    monkeypatch.setattr(api_openaire, "safe_request", _request)

    results = get_client("openaire").search(
        query="open science",
        date_from="2024-02-01",
        date_to="2024-02-29",
        max_results=5,
    )

    assert calls == [(
        "GET",
        "https://api.openaire.eu/search/publications",
        {
            "params": {
                "keywords": "open science",
                "size": 5,
                "page": 1,
                "format": "json",
                "fromDateAccepted": "2024-02-01",
                "toDateAccepted": "2024-02-29",
            },
            "rate_limiter": api_openaire._RATE_LIMITER,
        },
    )]
    assert api_openaire._RATE_LIMITER._interval == pytest.approx(60.0)
    assert results == [NormalizedResult(
        source_repository="openaire",
        external_id="50|record/1",
        doi="10.1000/openaire.1",
        title="Open science infrastructures",
        authors=[],
        abstract="An OpenAIRE abstract.",
        publication_date="2024-02-15",
        url="https://doi.org/10.1000/openaire.1",
        categories=[f"subject-{index}" for index in range(10)],
    )]


def test_openaire_search_handles_list_fields_and_doi_fallback(monkeypatch):
    record = _openaire_record(
        external_id="openaire::record/2",
        doi=None,
        title="Cardinality-safe parsing",
        authors=["Curie, Marie", "Meitner, Lise"],
        categories=["Open science"],
        list_fields=True,
    )
    monkeypatch.setattr(
        api_openaire,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_openaire_payload([record]),
        ),
    )

    results = get_client("openaire").search(query="cardinality", max_results=5)

    assert results == [NormalizedResult(
        source_repository="openaire",
        external_id="openaire::record/2",
        doi=None,
        title="Cardinality-safe parsing",
        authors=["Curie, Marie", "Meitner, Lise"],
        abstract="An OpenAIRE abstract.",
        publication_date="2024-02-15",
        url=(
            "https://explore.openaire.eu/search/publication?articleId="
            "openaire%3A%3Arecord%2F2"
        ),
        categories=["Open science"],
    )]


def test_openaire_search_keeps_page_size_constant(monkeypatch):
    requested = []
    records = [
        _openaire_record(
            external_id=f"openaire::record-{index}",
            doi=f"10.1000/openaire.{index}",
        )
        for index in range(1, 151)
    ]

    def _request(method, url, **kwargs):
        params = kwargs["params"]
        requested.append((params["page"], params["size"]))
        start = (params["page"] - 1) * params["size"]
        page_records = records[start:start + params["size"]]
        return _FakeResponse(
            payload=_openaire_payload(page_records, total=len(records)),
        )

    monkeypatch.setattr(api_openaire, "safe_request", _request)

    results = get_client("openaire").search(query="science", max_results=125)

    assert requested == [(1, 100), (2, 100)]
    assert [result.external_id for result in results] == [
        f"openaire::record-{index}" for index in range(1, 126)
    ]


def test_openaire_search_skips_malformed_records(monkeypatch):
    valid = _openaire_record(external_id="openaire::valid")
    malformed = {
        "header": {"dri:objIdentifier": {"$": "openaire::bad"}},
        "metadata": {"oaf:entity": {"oaf:result": {"title": None}}},
    }
    monkeypatch.setattr(
        api_openaire,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_openaire_payload([malformed, valid]),
        ),
    )

    results = get_client("openaire").search(query="science", max_results=5)

    assert [result.external_id for result in results] == ["openaire::valid"]


def test_openaire_search_returns_empty_when_upstream_has_no_hits(monkeypatch):
    monkeypatch.setattr(
        api_openaire,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(
            payload=_openaire_payload(None, total=0),
        ),
    )

    assert get_client("openaire").search(query="no-such-result") == []


def test_openaire_search_returns_empty_on_non_200(monkeypatch):
    monkeypatch.setattr(
        api_openaire,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(status_code=503),
    )

    assert get_client("openaire").search(query="science") == []


def test_openaire_search_returns_empty_on_timeout(monkeypatch):
    def _timeout(*args, **kwargs):
        raise TimeoutError("upstream timed out")

    monkeypatch.setattr(api_openaire, "safe_request", _timeout)

    assert get_client("openaire").search(query="science") == []


def _osti_record(
    osti_id="12345",
    *,
    title="Fusion &amp; climate research",
    publication_date="2024-02-29T00:00:00Z",
    include_optional=True,
):
    record = {
        "osti_id": osti_id,
        "title": title,
        "publication_date": publication_date,
    }
    if include_optional:
        record.update({
            "authors": ["Curie, Marie", "Fermi, Enrico"],
            "description": "An &amp; abstract.",
            "doi": "https://doi.org/10.2172/12345",
            "subjects": [f"subject-{index}" for index in range(1, 12)],
            "links": [
                {"rel": "citation", "href": "https://www.osti.gov/biblio/12345"},
                {"rel": "fulltext", "href": "https://www.osti.gov/servlets/purl/12345"},
            ],
        })
    return record


def test_osti_search_builds_date_query_and_normalizes_json(monkeypatch):
    calls = []

    def _request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return _FakeResponse(payload=[_osti_record()])

    monkeypatch.setattr(api_osti, "safe_request", _request)

    results = api_osti.OstiClient().search(
        query="fusion climate",
        date_from="2024-02-01",
        date_to="2024-02-29",
        max_results=5,
    )

    assert calls == [(
        "GET",
        "https://www.osti.gov/api/v1/records",
        {
            "params": {
                "q": "fusion climate",
                "page": 1,
                "rows": 5,
                "publication_date_start": "02/01/2024",
                "publication_date_end": "02/29/2024",
            },
            "headers": {"Accept": "application/json"},
            "rate_limiter": api_osti._RATE_LIMITER,
        },
    )]
    assert api_osti._RATE_LIMITER._interval == pytest.approx(2.0)
    assert results == [NormalizedResult(
        source_repository="osti",
        external_id="12345",
        doi="10.2172/12345",
        title="Fusion & climate research",
        authors=["Curie, Marie", "Fermi, Enrico"],
        abstract="An & abstract.",
        publication_date="2024-02-29",
        url="https://www.osti.gov/biblio/12345",
        categories=[f"subject-{index}" for index in range(1, 11)],
    )]


def test_osti_search_follows_documented_next_link_with_constant_rows(monkeypatch):
    requested = []
    records = [
        _osti_record(osti_id=str(index), include_optional=False)
        for index in range(1, 151)
    ]

    def _request(method, url, **kwargs):
        page = kwargs["params"]["page"]
        rows = kwargs["params"]["rows"]
        requested.append((page, rows))
        start = (page - 1) * rows
        headers = {}
        if page == 1:
            headers["Link"] = (
                '<https://www.osti.gov/api/v1/records?page=2&rows=100>; '
                'rel="next"'
            )
        return _FakeResponse(
            payload=records[start:start + rows], headers=headers,
        )

    monkeypatch.setattr(api_osti, "safe_request", _request)

    results = api_osti.OstiClient().search(query="energy", max_results=125)

    assert requested == [(1, 100), (2, 100)]
    assert [result.external_id for result in results] == [
        str(index) for index in range(1, 126)
    ]


def test_osti_search_caps_pages_when_records_are_unusable(monkeypatch):
    requested = []

    def _request(method, url, **kwargs):
        page = kwargs["params"]["page"]
        requested.append(page)
        headers = {}
        if page < 4:
            headers["Link"] = (
                f'<https://www.osti.gov/api/v1/records?page={page + 1}>; '
                'rel="next"'
            )
        return _FakeResponse(
            payload=[{"osti_id": str(page), "title": ""}],
            headers=headers,
        )

    monkeypatch.setattr(api_osti, "safe_request", _request)

    results = api_osti.OstiClient().search(query="energy", max_results=125)

    assert results == []
    assert requested == [1, 2]


def test_osti_search_rejects_invalid_date_window_without_request(monkeypatch):
    calls = []
    monkeypatch.setattr(
        api_osti,
        "safe_request",
        lambda *args, **kwargs: calls.append(kwargs),
    )

    results = api_osti.OstiClient().search(
        query="energy",
        date_from="2025-01-01",
        date_to="2024-12-31",
    )

    assert results == []
    assert calls == []


def test_osti_search_rechecks_returned_publication_date(monkeypatch):
    monkeypatch.setattr(
        api_osti,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=[
            _osti_record(publication_date="2024-03-01T00:00:00Z"),
        ]),
    )

    results = api_osti.OstiClient().search(
        query="energy",
        date_from="2024-02-01",
        date_to="2024-02-29",
    )

    assert results == []


def test_osti_search_skips_malformed_and_allows_optional_fields(monkeypatch):
    valid = _osti_record(
        osti_id=54321,
        title="Technical report",
        publication_date="2023-07-04",
        include_optional=False,
    )
    monkeypatch.setattr(
        api_osti,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=[
            {"osti_id": "999", "title": ""}, valid,
        ]),
    )

    results = api_osti.OstiClient().search(query="energy", max_results=5)

    assert results == [NormalizedResult(
        source_repository="osti",
        external_id="54321",
        doi=None,
        title="Technical report",
        authors=[],
        abstract=None,
        publication_date="2023-07-04",
        url="https://www.osti.gov/biblio/54321",
        categories=[],
    )]


def test_osti_search_returns_empty_when_upstream_has_no_hits(monkeypatch):
    monkeypatch.setattr(
        api_osti,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=[]),
    )

    assert api_osti.OstiClient().search(query="no-such-result") == []


@pytest.mark.parametrize("payload", [{}, {"records": []}])
def test_osti_search_logs_malformed_success_payload(monkeypatch, caplog, payload):
    monkeypatch.setattr(
        api_osti,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(payload=payload),
    )

    assert api_osti.OstiClient().search(query="energy") == []
    assert "response" in caplog.text.lower()


def test_osti_search_returns_empty_on_non_200(monkeypatch):
    monkeypatch.setattr(
        api_osti,
        "safe_request",
        lambda *args, **kwargs: _FakeResponse(status_code=503),
    )

    assert api_osti.OstiClient().search(query="energy") == []


def test_osti_search_returns_empty_on_timeout(monkeypatch):
    def _timeout(*args, **kwargs):
        raise TimeoutError("upstream timed out")

    monkeypatch.setattr(api_osti, "safe_request", _timeout)

    assert api_osti.OstiClient().search(query="energy") == []


@pytest.mark.live_network
def test_openalex_search():
    """OpenAlex client returns results for a simple query."""
    client = get_client("openalex")
    results = client.search(query="climate change", max_results=3)
    assert isinstance(results, list)
    if results:
        assert isinstance(results[0], NormalizedResult)


@pytest.mark.live_network
def test_pubmed_search():
    """PubMed client returns results using two-step esearch/efetch."""
    client = get_client("pubmed")
    results = client.search(query="CRISPR", max_results=3)
    assert isinstance(results, list)
    if results:
        assert isinstance(results[0], NormalizedResult)
        assert results[0].source_repository == "pubmed"


@pytest.mark.live_network
def test_biorxiv_search():
    """bioRxiv client returns results for a date-range query."""
    client = get_client("biorxiv")
    try:
        results = client.search(query="neuroscience", max_results=3,
                                date_from="2026-04-01", date_to="2026-04-15")
    except RuntimeError as exc:
        # The bioRxiv /details endpoint reports upstream unavailability via a
        # sentinel status message. Surface this as a skip rather than a
        # failure so transient outages don't turn the whole suite red.
        if "unavailable" in str(exc).lower():
            pytest.skip(f"bioRxiv /details endpoint unavailable: {exc}")
        raise
    assert isinstance(results, list)
    if results:
        assert isinstance(results[0], NormalizedResult)


@pytest.mark.live_network
def test_medrxiv_search_respects_date_window():
    """medRxiv returns normalized records inside the requested date range."""
    date_from = "2024-01-01"
    date_to = "2024-01-07"
    results = get_client("medrxiv").search(
        query="the",
        max_results=3,
        date_from=date_from,
        date_to=date_to,
    )

    assert results
    assert all(isinstance(result, NormalizedResult) for result in results)
    assert all(result.source_repository == "medrxiv" for result in results)
    assert all(
        result.publication_date is not None
        and date_from <= result.publication_date <= date_to
        for result in results
    )


@pytest.mark.live_network
def test_datacite_search_respects_publication_year_window():
    """DataCite returns publication metadata inside the requested full year."""
    results = get_client("datacite").search(
        query="climate",
        max_results=3,
        date_from="2024-01-01",
        date_to="2024-12-31",
    )

    assert results
    assert all(isinstance(result, NormalizedResult) for result in results)
    assert all(result.source_repository == "datacite" for result in results)
    assert all(
        result.publication_date is not None
        and result.publication_date[:4] == "2024"
        for result in results
    )


@pytest.mark.live_network
def test_eric_search_respects_publication_year_window():
    """ERIC returns publication metadata inside the requested full year."""
    results = get_client("eric").search(
        query="climate",
        max_results=3,
        date_from="2024-01-01",
        date_to="2024-12-31",
    )

    assert results
    assert all(isinstance(result, NormalizedResult) for result in results)
    assert all(result.source_repository == "eric" for result in results)
    assert all(result.publication_date == "2024" for result in results)


@pytest.mark.live_network
def test_osti_search_respects_publication_date_window():
    """OSTI returns publication metadata inside the requested date range."""
    date_from = "2024-01-01"
    date_to = "2024-12-31"
    results = get_client("osti").search(
        query="climate",
        max_results=3,
        date_from=date_from,
        date_to=date_to,
    )

    assert results
    assert all(isinstance(result, NormalizedResult) for result in results)
    assert all(result.source_repository == "osti" for result in results)
    assert all(
        result.publication_date is not None
        and date_from <= result.publication_date <= date_to
        for result in results
    )


@pytest.mark.live_network
def test_dryad_search_returns_normalized_results_when_available():
    """Dryad search returns normalized records when the public API has matches."""
    results = get_client("dryad").search(query="climate", max_results=3)

    assert isinstance(results, list)
    assert results
    assert all(isinstance(result, NormalizedResult) for result in results)
    assert all(result.source_repository == "dryad" for result in results)


@pytest.mark.live_network
def test_zenodo_search_respects_date_window():
    """Zenodo returns normalized records inside the requested date range."""
    date_from = "2024-01-01"
    date_to = "2024-12-31"
    results = get_client("zenodo").search(
        query="climate",
        max_results=3,
        date_from=date_from,
        date_to=date_to,
    )

    assert results
    assert all(isinstance(result, NormalizedResult) for result in results)
    assert all(result.source_repository == "zenodo" for result in results)
    assert all(
        result.publication_date is not None
        and date_from <= result.publication_date <= date_to
        for result in results
    )


@pytest.mark.live_network
def test_inspire_search_respects_date_window():
    """INSPIRE returns normalized records inside the requested date range."""
    date_from = "2024-01-01"
    date_to = "2024-01-31"
    results = get_client("inspire_hep").search(
        query="quantum",
        max_results=3,
        date_from=date_from,
        date_to=date_to,
    )

    assert results
    assert all(isinstance(result, NormalizedResult) for result in results)
    assert all(result.source_repository == "inspire_hep" for result in results)
    assert all(
        result.publication_date is not None
        and date_from <= result.publication_date <= date_to
        for result in results
    )


@pytest.mark.live_network
def test_openaire_search_respects_date_window():
    """OpenAIRE returns normalized records inside the requested date range."""
    date_from = "2024-01-01"
    date_to = "2024-01-31"
    results = get_client("openaire").search(
        query="climate",
        max_results=3,
        date_from=date_from,
        date_to=date_to,
    )

    assert results
    assert all(isinstance(result, NormalizedResult) for result in results)
    assert all(result.source_repository == "openaire" for result in results)
    assert all(
        result.publication_date is not None
        and date_from <= result.publication_date <= date_to
        for result in results
    )


# ---------------------------------------------------------------------------
# INSPIRE abstract licensing (v1.8.1)
# ---------------------------------------------------------------------------
#
# INSPIRE's Terms of Use §5(ii) permit reuse of an abstract only where that
# abstract's own ``source`` is arXiv or CERN. The client honours that at parse
# time; these pin it, because the failure mode is silent — a stored abstract we
# have no licence for looks exactly like one we do.

def _inspire_record_with_abstracts(abstracts):
    record = _inspire_record(include_optional=False)
    record["metadata"]["abstracts"] = abstracts
    return record


def _inspire_search_with(monkeypatch, abstracts):
    monkeypatch.setattr(
        api_inspire_hep, "safe_request",
        lambda method, url, **kwargs: _FakeResponse(payload={
            "hits": {"total": 1, "hits": [_inspire_record_with_abstracts(abstracts)]},
        }),
    )
    return get_client("inspire_hep").search(query="q", max_results=1)


@pytest.mark.parametrize("source", ["arXiv", "CERN", "arxiv", "cern"])
def test_inspire_keeps_abstract_from_licensed_source(monkeypatch, source):
    """An arXiv- or CERN-sourced abstract is stored, whatever its casing."""
    results = _inspire_search_with(
        monkeypatch, [{"value": "Licensed text.", "source": source}]
    )
    assert results[0].abstract == "Licensed text."


@pytest.mark.parametrize("source", ["Elsevier B.V.", "Springer", "IOP", "submitter"])
def test_inspire_drops_abstract_from_unlicensed_source(monkeypatch, source):
    """A publisher-sourced abstract is dropped; the record is still returned."""
    results = _inspire_search_with(
        monkeypatch, [{"value": "Publisher text.", "source": source}]
    )
    assert len(results) == 1
    assert results[0].title == "Quantum gravity amplitudes"
    assert results[0].abstract is None


def test_inspire_takes_the_licensed_abstract_from_further_down_the_list(monkeypatch):
    """Ordering is not guaranteed upstream, so the whole list is scanned."""
    results = _inspire_search_with(monkeypatch, [
        {"value": "Publisher text.", "source": "Elsevier B.V."},
        {"value": "arXiv text.", "source": "arXiv"},
    ])
    assert results[0].abstract == "arXiv text."


def test_inspire_drops_abstract_with_no_source_field(monkeypatch):
    """No source means no evidence of a licence, so nothing is stored.

    An abstract whose provenance INSPIRE does not state is exactly the case
    §5(ii) does not cover. Storing it would be assuming permission.
    """
    results = _inspire_search_with(monkeypatch, [{"value": "Unattributed text."}])
    assert results[0].abstract is None


def test_inspire_ignores_malformed_abstract_entries(monkeypatch):
    """A malformed entry is skipped rather than aborting the record."""
    results = _inspire_search_with(monkeypatch, [
        "not-a-dict",
        {"source": "arXiv"},                      # no value
        {"value": "   ", "source": "arXiv"},      # blank value
        {"value": "Real text.", "source": "arXiv"},
    ])
    assert results[0].abstract == "Real text."


# ---------------------------------------------------------------------------
# NDL: a zero-match query is not a malformed response
# ---------------------------------------------------------------------------
#
# Found 2026-09-02 chasing Ryan's report that NDL "returned nothing". NDL
# answers a query matching no records with an SRU *diagnostic* -- no
# numberOfRecords element and "Record does not exist" -- which the client
# treated as malformed XML. The user-visible count was right either way, but
# the app reported an upstream fault that had not happened, and the watchdog
# reads a source error differently from a legitimate zero.

_NDL_NO_RECORDS = (
    '<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/">'
    '<diagnostics>'
    '<diagnostic xmlns="http://www.loc.gov/zing/srw/diagnostic/">'
    '<uri>info:srw/diagnostic/1/1</uri>'
    '<details>An error occurred</details>'
    '<message>Record does not exist</message>'
    '</diagnostic></diagnostics></searchRetrieveResponse>'
)

_NDL_REAL_DIAGNOSTIC = (
    '<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/">'
    '<diagnostics>'
    '<diagnostic xmlns="http://www.loc.gov/zing/srw/diagnostic/">'
    '<uri>info:srw/diagnostic/1/7</uri>'
    '<details>query</details>'
    '<message>Mandatory parameter not supplied</message>'
    '</diagnostic></diagnostics></searchRetrieveResponse>'
)


def test_ndl_zero_match_is_reported_as_zero_not_as_malformed(monkeypatch, caplog):
    monkeypatch.setattr(
        api_ndl_search, "safe_request",
        lambda *a, **k: _FakeResponse(text=_NDL_NO_RECORDS),
    )
    with caplog.at_level("INFO"):
        results = api_ndl_search.NDLSearchClient().search(query="LLM", max_results=5)

    assert results == []
    assert "malformed" not in caplog.text.lower()
    assert "no records" in caplog.text.lower()


def test_ndl_a_real_diagnostic_is_still_an_error(monkeypatch, caplog):
    """Only 'does not exist' means zero. Other diagnostics are real failures.

    Flattening every diagnostic into "no results" would hide a broken query
    behind an empty page, which is the opposite mistake.
    """
    monkeypatch.setattr(
        api_ndl_search, "safe_request",
        lambda *a, **k: _FakeResponse(text=_NDL_REAL_DIAGNOSTIC),
    )
    results = api_ndl_search.NDLSearchClient().search(query="x", max_results=5)

    assert results == []
    assert "malformed" in caplog.text.lower()


def test_ndl_genuinely_malformed_xml_is_still_malformed(monkeypatch, caplog):
    monkeypatch.setattr(
        api_ndl_search, "safe_request",
        lambda *a, **k: _FakeResponse(text="<searchRetrieveResponse><oops"),
    )
    assert api_ndl_search.NDLSearchClient().search(query="x", max_results=5) == []
    assert "malformed" in caplog.text.lower()


@pytest.mark.live_network
def test_ndl_live_zero_match_query_reports_zero_cleanly(caplog):
    """Against the real API: a query with no matches must not look like a fault."""
    with caplog.at_level("INFO"):
        results = api_ndl_search.NDLSearchClient().search(
            query="zzzqqxnomatchhere", max_results=5,
        )
    assert results == []
    assert "malformed" not in caplog.text.lower()
