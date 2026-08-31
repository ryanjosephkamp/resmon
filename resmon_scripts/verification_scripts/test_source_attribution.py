"""Sources whose credit is a licence condition must actually be credited.

Delegation 03's terms survey found that four shipped sources make attribution a
condition of reuse — OpenAIRE's Graph metadata is CC BY, PLOS's API display
policy names an exact phrase, CORE asks discovery products to carry its
snippet, and the Semantic Scholar API licence requires its credit — and that
resmon met **none** of them. The obligations were real, the catalog had nowhere
to record them, and nothing rendered them.

These tests pin the two things that make the fix real rather than cosmetic: the
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

# Established from each provider's own clause during the v1.8.1 terms review.
# A source is listed here only where the credit is a *condition*, not a request.
REQUIRED = {
    "core": "Powered by CORE",
    "openaire": "OpenAIRE",
    "plos": "Data Provided by PLOS",
    "semantic_scholar": "Semantic Scholar",
}


@pytest.mark.parametrize("slug,fragment", sorted(REQUIRED.items()))
def test_required_attribution_is_recorded(slug, fragment):
    entry = _BY_SLUG[slug]
    assert entry.attribution_requirement == "required", (
        f"{slug} makes attribution a licence condition; recording it as "
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


def test_requested_attribution_is_not_labelled_required():
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
