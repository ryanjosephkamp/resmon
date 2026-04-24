# resmon_scripts/verification_scripts/test_api_tier2_3.py
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

# Explicit imports to trigger auto-registration for all clients
import implementation_scripts.api_arxiv
import implementation_scripts.api_crossref
import implementation_scripts.api_semantic_scholar
import implementation_scripts.api_openalex
import implementation_scripts.api_pubmed
import implementation_scripts.api_europepmc
import implementation_scripts.api_biorxiv
import implementation_scripts.api_core
import implementation_scripts.api_doaj
import implementation_scripts.api_dblp
import implementation_scripts.api_nasa_ads
import implementation_scripts.api_hal
import implementation_scripts.api_plos
import implementation_scripts.api_springer
import implementation_scripts.api_ieee

from implementation_scripts.api_base import NormalizedResult
from implementation_scripts.api_registry import list_repositories, get_client

# NOTE: SSRN and RePEc were removed from the active registry on 2026-04-18
# because both sources block programmatic access (SSRN: Cloudflare 403; RePEc:
# htsearch CGI no longer publicly reachable). See .ai/prep/repos.md.
TIER_2_3_REPOS = ["hal", "plos", "springer", "ieee"]


def test_all_tier2_3_registered():
    """All Tier 2/3 repositories are registered."""
    repos = list_repositories()
    for name in TIER_2_3_REPOS:
        assert name in repos, f"Missing Tier 2/3 client: {name}"


def test_each_client_instantiates():
    """Each Tier 2/3 client can be instantiated without error."""
    for name in TIER_2_3_REPOS:
        client = get_client(name)
        assert client.get_name() is not None


def test_hal_search():
    """HAL client returns results."""
    client = get_client("hal")
    results = client.search(query="physics", max_results=3)
    assert isinstance(results, list)
    if results:
        assert isinstance(results[0], NormalizedResult)


def test_tier3_graceful_failure():
    """Tier 3 clients return empty list on scraping failure (no crash)."""
    for name in ["ieee"]:
        client = get_client(name)
        results = client.search(query="nonexistent_test_query_xyz_12345", max_results=1)
        assert isinstance(results, list)  # may be empty, must not raise
