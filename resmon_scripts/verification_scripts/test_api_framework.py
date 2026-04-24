# resmon_scripts/verification_scripts/test_api_framework.py
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.api_base import NormalizedResult, BaseAPIClient, RateLimiter


def test_normalized_result_instantiation():
    """NormalizedResult can be instantiated with all required fields."""
    result = NormalizedResult(
        source_repository="arxiv",
        external_id="2604.12345",
        doi="10.1234/test",
        title="Test Paper",
        authors=["Author A"],
        abstract="Test abstract.",
        publication_date="2026-04-15",
        url="https://arxiv.org/abs/2604.12345",
        categories=["cs.LG"],
    )
    assert result.title == "Test Paper"
    assert result.source_repository == "arxiv"


def test_rate_limiter_enforces_rate():
    """RateLimiter delays calls beyond the configured rate."""
    import time
    limiter = RateLimiter(requests_per_second=10.0)
    start = time.monotonic()
    for _ in range(5):
        limiter.acquire()
    elapsed = time.monotonic() - start
    # 5 calls at 10 req/s should take at least ~0.4 seconds
    assert elapsed >= 0.3, f"Rate limiter too fast: {elapsed:.2f}s for 5 calls at 10 req/s"


def test_base_client_is_abstract():
    """BaseAPIClient cannot be instantiated directly."""
    import pytest
    with pytest.raises(TypeError):
        BaseAPIClient()


def test_arxiv_client_search():
    """arXiv client returns NormalizedResult objects for a known query."""
    from implementation_scripts.api_arxiv import ArxivClient
    client = ArxivClient()
    results = client.search(query="quantum computing", max_results=3)
    assert isinstance(results, list)
    assert len(results) <= 3
    if results:  # may be empty if network is unavailable
        assert isinstance(results[0], NormalizedResult)
        assert results[0].source_repository == "arxiv"


def test_crossref_client_search():
    """CrossRef client returns NormalizedResult objects for a known query."""
    from implementation_scripts.api_crossref import CrossrefClient
    client = CrossrefClient()
    results = client.search(query="machine learning", max_results=3)
    assert isinstance(results, list)
    assert len(results) <= 3
    if results:
        assert isinstance(results[0], NormalizedResult)
        assert results[0].source_repository == "crossref"


def test_semantic_scholar_client_search():
    """Semantic Scholar client returns NormalizedResult objects."""
    from implementation_scripts.api_semantic_scholar import SemanticScholarClient
    client = SemanticScholarClient()
    results = client.search(query="neural networks", max_results=3)
    assert isinstance(results, list)
    assert len(results) <= 3
    if results:
        assert isinstance(results[0], NormalizedResult)
        assert results[0].source_repository == "semantic_scholar"


def test_registry_lists_clients():
    """Registry contains the first three Tier 1 clients."""
    from implementation_scripts.api_registry import list_repositories
    repos = list_repositories()
    assert "arxiv" in repos
    assert "crossref" in repos
    assert "semantic_scholar" in repos
