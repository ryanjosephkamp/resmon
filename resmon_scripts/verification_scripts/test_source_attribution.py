"""Sources whose credit is a license condition must actually be credited.

Four sources make attribution a condition of reuse — OpenAIRE's Graph metadata
is CC BY, PLOS's API display policy names an exact phrase, CORE asks discovery
products to carry its snippet, and the Semantic Scholar API license requires
its credit. The obligations are real, so the catalog has to record them and
something has to render them.

These tests pin the two things that make that real rather than cosmetic: the
obligation is recorded with the clause that imposes it, and a *required* credit
is held apart from one the upstream merely asks for.
"""

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.repo_catalog import (  # noqa: E402
    REPOSITORY_CATALOG,
    catalog_as_dicts,
)

_BY_SLUG = {e.slug: e for e in REPOSITORY_CATALOG}

# Established from each provider's own terms clause.
# A source is listed here only where the credit is a *condition*, not a request.
REQUIRED = {
    "core": "Powered by CORE",
    "ndl_search": "NDL Search API",
    "openaire": "OpenAIRE",
    "plos": "Data Provided by PLOS",
    "semantic_scholar": "Semantic Scholar",
}


@pytest.mark.parametrize("slug,fragment", sorted(REQUIRED.items()))
def test_required_attribution_is_recorded(slug, fragment):
    entry = _BY_SLUG[slug]
    assert entry.attribution_requirement == "required", (
        f"{slug} makes attribution a license condition; recording it as "
        f"{entry.attribution_requirement!r} understates the obligation"
    )
    assert fragment in entry.attribution


@pytest.mark.parametrize("slug", sorted(REQUIRED))
def test_required_attribution_cites_the_clause(slug):
    """A credit without its source cannot be checked by anyone later."""
    entry = _BY_SLUG[slug]
    assert entry.attribution_source.startswith("http")


def test_plos_wording_is_verbatim():
    """PLOS's display policy names the exact phrase; paraphrasing misses it."""
    assert _BY_SLUG["plos"].attribution == "Data Provided by PLOS"


def test_requested_attribution_is_not_labeled_required():
    """arXiv asks; it does not require. Conflating the two overclaims its terms."""
    arxiv = _BY_SLUG["arxiv"]
    assert arxiv.attribution_requirement == "requested"
    assert arxiv.attribution


def test_every_graded_entry_carries_text_and_a_source():
    """A grade with nothing to show, or no clause behind it, is not usable."""
    for entry in REPOSITORY_CATALOG:
        if entry.attribution_requirement == "none":
            continue
        assert entry.attribution, f"{entry.slug} is graded but has no credit text"
        assert entry.attribution_source, f"{entry.slug} has no clause URL"


def test_ungraded_entries_claim_no_attribution():
    """The default must be silence, not an invented credit."""
    for entry in REPOSITORY_CATALOG:
        if entry.attribution_requirement == "none":
            assert entry.attribution == ""
            assert entry.attribution_source == ""


def test_attribution_reaches_the_api_payload():
    """The renderer can only display what the endpoint actually serves."""
    payload = {d["slug"]: d for d in catalog_as_dicts()}
    for slug in REQUIRED:
        assert payload[slug]["attribution_requirement"] == "required"
        assert payload[slug]["attribution"]
        assert payload[slug]["attribution_source"]


# ---------------------------------------------------------------------------
# NDL Search
# ---------------------------------------------------------------------------
#
# NDL Search makes a credit a condition of reuse. A catalog note does not
# discharge an obligation, so this pins the credits into the attribution
# fields, where they actually render rather than sitting in prose nobody is
# shown. NIST RMM made its acknowledgment a condition too; it was withdrawn in
# November 2026 and has no catalog entry to carry one.

def test_ndl_credits_both_the_api_and_the_contributing_institution():
    """NDL asks for two credits, not one: the API and the metadata provider."""
    entry = _BY_SLUG["ndl_search"]
    assert "NDL Search API" in entry.attribution
    assert "National Diet Library" in entry.attribution
    assert entry.attribution_requirement == "required"
