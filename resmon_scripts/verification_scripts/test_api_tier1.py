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
import implementation_scripts.api_biorxiv        # noqa: F401
import implementation_scripts.api_core           # noqa: F401
import implementation_scripts.api_doaj           # noqa: F401
import implementation_scripts.api_dblp           # noqa: F401
import implementation_scripts.api_nasa_ads       # noqa: F401

TIER_1_REPOS = [
    "arxiv", "crossref", "semantic_scholar", "openalex", "pubmed",
    "europepmc", "biorxiv", "core", "doaj", "dblp", "nasa_ads",
]


def test_all_tier1_registered():
    """All 11 Tier 1 repositories are registered in the client registry."""
    repos = list_repositories()
    for name in TIER_1_REPOS:
        assert name in repos, f"Missing Tier 1 client: {name}"


def test_each_client_instantiates():
    """Each Tier 1 client can be instantiated without error."""
    for name in TIER_1_REPOS:
        client = get_client(name)
        assert client.get_name() is not None


def test_openalex_search():
    """OpenAlex client returns results for a simple query."""
    client = get_client("openalex")
    results = client.search(query="climate change", max_results=3)
    assert isinstance(results, list)
    if results:
        assert isinstance(results[0], NormalizedResult)


def test_pubmed_search():
    """PubMed client returns results using two-step esearch/efetch."""
    client = get_client("pubmed")
    results = client.search(query="CRISPR", max_results=3)
    assert isinstance(results, list)
    if results:
        assert isinstance(results[0], NormalizedResult)
        assert results[0].source_repository == "pubmed"


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
