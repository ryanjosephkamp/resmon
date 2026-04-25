# resmon_scripts/verification_scripts/test_repo_catalog.py
"""Tests for the static repository catalog (IMPL-23)."""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.repo_catalog import (
    REPOSITORY_CATALOG,
    catalog_as_dicts,
    credential_names,
    required_credential_for,
)


EXPECTED_SLUGS = {
    "arxiv", "biorxiv", "core", "crossref", "dblp", "doaj",
    "europepmc", "hal", "ieee", "nasa_ads", "openalex", "plos", "pubmed",
    "semantic_scholar", "springer",
}

EXPECTED_CREDENTIAL_NAMES = {
    "core_api_key", "ieee_api_key", "nasa_ads_api_key",
    "pubmed_api_key", "semantic_scholar_api_key", "springer_api_key",
}


def test_catalog_has_fifteen_entries():
    """The active catalog should contain exactly 15 entries."""
    # RePEc/SSRN are excluded by policy and must not appear.
    assert len(REPOSITORY_CATALOG) == 15


def test_catalog_slugs_match_expected():
    """Every expected slug must be present, and no excluded slugs."""
    slugs = {e.slug for e in REPOSITORY_CATALOG}
    assert slugs == EXPECTED_SLUGS
    assert "repec" not in slugs
    assert "ssrn" not in slugs


def test_requirement_values_are_normalized():
    """api_key_requirement is one of the 4 allowed literals."""
    allowed = {"none", "required", "optional", "recommended"}
    for e in REPOSITORY_CATALOG:
        assert e.api_key_requirement in allowed, e.slug


def test_placeholder_matches_requirement():
    """Placeholder text matches requirement tier (REQUIRED/OPTIONAL/RECOMMENDED)."""
    for e in REPOSITORY_CATALOG:
        if e.api_key_requirement == "required":
            assert e.placeholder == "Enter API key here (REQUIRED)"
            assert e.credential_name is not None
        elif e.api_key_requirement == "optional":
            assert e.placeholder == "Enter API key here (OPTIONAL)"
        elif e.api_key_requirement == "recommended":
            assert e.placeholder == "Enter API key here (RECOMMENDED)"
        else:
            assert e.placeholder == ""
            assert e.credential_name is None


def test_credential_names_helper():
    """credential_names() returns the union of non-null credential names."""
    assert credential_names() == EXPECTED_CREDENTIAL_NAMES


def test_required_credential_for():
    """required_credential_for returns the credential name for required repos only."""
    assert required_credential_for("core") == "core_api_key"
    assert required_credential_for("ieee") == "ieee_api_key"
    # "recommended" / "optional" / "none" do not count as "required"
    assert required_credential_for("semantic_scholar") is None
    assert required_credential_for("pubmed") is None
    assert required_credential_for("arxiv") is None


def test_catalog_as_dicts_shape():
    """catalog_as_dicts returns JSON-serializable dicts with expected keys."""
    dicts = catalog_as_dicts()
    assert len(dicts) == 15
    expected_keys = {
        "slug", "name", "description", "subject_coverage", "endpoint",
        "query_method", "rate_limit", "client_module", "api_key_requirement",
        "credential_name", "website", "registration_url", "placeholder",
        "upstream_policy", "parallel_safe", "notes",
        "keyword_combination", "keyword_combination_notes",
    }
    for d in dicts:
        assert set(d.keys()) == expected_keys


def test_keyword_combination_populated_for_every_active_repo():
    """Every active catalog entry has a non-empty keyword_combination label and notes."""
    for e in REPOSITORY_CATALOG:
        assert e.keyword_combination, e.slug
        assert e.keyword_combination_notes, e.slug


def test_website_urls_are_http():
    """Every entry has an http(s) website URL."""
    for e in REPOSITORY_CATALOG:
        assert e.website.startswith("http"), e.slug


def test_required_repos_have_credential_names():
    """All `required` repos have a non-null credential_name."""
    for e in REPOSITORY_CATALOG:
        if e.api_key_requirement == "required":
            assert e.credential_name, e.slug
