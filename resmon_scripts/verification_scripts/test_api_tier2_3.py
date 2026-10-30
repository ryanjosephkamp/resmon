# resmon_scripts/verification_scripts/test_api_tier2_3.py
import httpx
import pytest
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

from implementation_scripts.api_base import NormalizedResult, reset_search_outcome, search_outcome
from implementation_scripts.api_registry import list_repositories, get_client

# NOTE: SSRN and RePEc were removed from the active registry on 2026-04-18
# because both sources block programmatic access (SSRN: Cloudflare 403; RePEc:
# htsearch CGI no longer publicly reachable). See .ai/prep/repos.md.
TIER_2_3_REPOS = ["hal", "plos", "springer"]


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


@pytest.mark.live_network
def test_hal_search():
    """A live HAL search retrieves usable records; graceful failure is not success."""
    client = get_client("hal")
    reset_search_outcome()
    results = client.search(query="physics", max_results=3)
    snapshot = search_outcome().snapshot()
    assert 1 <= len(results) <= 3, "HAL did not return usable records"
    assert snapshot["attempts"] >= 1
    assert not snapshot["last_call_failed"] and snapshot["explicit_reason"] is None
    assert snapshot["retained_cooldown_status"] is None
    for result in results:
        assert isinstance(result, NormalizedResult)
        assert result.source_repository == "hal"
        assert result.external_id and result.title and result.url


@pytest.mark.live_network
def test_tier3_graceful_failure():
    """A keyed Tier 2/3 client returns an empty list rather than raising.

    Covered IEEE Xplore until v1.8.1 retired that source on its terms; Springer
    is the remaining keyed client with the same degrade-don't-raise contract,
    and without a stored key it exercises exactly that path.
    """
    client = get_client("springer")
    results = client.search(query="nonexistent_test_query_xyz_12345", max_results=1)
    assert isinstance(results, list)  # may be empty, must not raise


# ---------------------------------------------------------------------------
# PLOS: the date window it is sent
# ---------------------------------------------------------------------------

def _capture_plos_queries(monkeypatch) -> list[dict]:
    """Answer every PLOS request with an empty result and keep the params it was sent."""
    sent: list[dict] = []

    def fake_request(method, url, **kwargs):
        sent.append(kwargs["params"])
        return httpx.Response(200, json={"response": {"docs": []}}, request=httpx.Request(method, url))

    monkeypatch.setattr(implementation_scripts.api_plos, "safe_request", fake_request)
    return sent


@pytest.mark.parametrize(("date_from", "date_to", "window"), [
    ("2026-10-23", None, "publication_date:[2026-10-23T00:00:00Z TO *]"),
    (None, "2026-10-30", "publication_date:[* TO 2026-10-30T23:59:59Z]"),
    ("2026-10-23", "2026-10-30", "publication_date:[2026-10-23T00:00:00Z TO 2026-10-30T23:59:59Z]"),
])
def test_plos_writes_an_open_side_of_the_window_as_a_bare_star(monkeypatch, date_from, date_to, window):
    """A time suffix on ``*`` is a range PLOS refuses with HTTP 400, and a watch since its previous run has no end."""
    sent = _capture_plos_queries(monkeypatch)
    assert get_client("plos").search("crispr", date_from, date_to, 3) == []
    assert sent[0]["q"] == f"crispr AND {window}"


def test_plos_with_no_window_sends_no_date_clause(monkeypatch):
    sent = _capture_plos_queries(monkeypatch)
    get_client("plos").search("crispr", max_results=3)
    assert sent[0]["q"] == "crispr"
