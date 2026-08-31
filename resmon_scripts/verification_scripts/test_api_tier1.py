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
from implementation_scripts import api_eric
from implementation_scripts import api_inspire_hep
from implementation_scripts import api_openaire
from implementation_scripts import api_osti
from implementation_scripts import api_zenodo
import implementation_scripts.api_core           # noqa: F401
import implementation_scripts.api_doaj           # noqa: F401
import implementation_scripts.api_dblp           # noqa: F401
import implementation_scripts.api_nasa_ads       # noqa: F401

TIER_1_REPOS = [
    "arxiv", "crossref", "semantic_scholar", "openalex", "pubmed",
    "europepmc", "biorxiv", "core", "datacite", "doaj", "dblp", "eric",
    "inspire_hep", "medrxiv", "nasa_ads", "openaire", "osti", "zenodo",
]


def test_all_tier1_registered():
    """All 18 Tier 1 repositories are registered in the client registry."""
    repos = list_repositories()
    for name in TIER_1_REPOS:
        assert name in repos, f"Missing Tier 1 client: {name}"


def test_each_client_instantiates():
    """Each Tier 1 client can be instantiated without error."""
    for name in TIER_1_REPOS:
        client = get_client(name)
        assert client.get_name() is not None


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, headers=None):
        self.status_code = status_code
        self._payload = {} if payload is None else payload
        self.headers = headers or {}

    def json(self):
        return self._payload


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
        metadata["abstracts"] = [{"value": "An upstream abstract."}]
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
