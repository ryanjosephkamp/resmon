# resmon_scripts/verification_scripts/test_api_tier1.py
import sys
from pathlib import Path

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
import implementation_scripts.api_core           # noqa: F401
import implementation_scripts.api_doaj           # noqa: F401
import implementation_scripts.api_dblp           # noqa: F401
import implementation_scripts.api_nasa_ads       # noqa: F401

TIER_1_REPOS = [
    "arxiv", "crossref", "semantic_scholar", "openalex", "pubmed",
    "europepmc", "biorxiv", "core", "doaj", "dblp", "medrxiv", "nasa_ads",
]


def test_all_tier1_registered():
    """All 12 Tier 1 repositories are registered in the client registry."""
    repos = list_repositories()
    for name in TIER_1_REPOS:
        assert name in repos, f"Missing Tier 1 client: {name}"


def test_each_client_instantiates():
    """Each Tier 1 client can be instantiated without error."""
    for name in TIER_1_REPOS:
        client = get_client(name)
        assert client.get_name() is not None


class _FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


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
