"""P4 — the basis rule, and the ways a name can lie.

Hermetic and deliberately so: the matcher is a pure function over a record and a
profile, and every interesting case is a *pair of strings*. What it cannot see
is whether real corpora look like these strings, which is what the field test on
the real corpus is for — and why precision is a measured number in the handback
rather than an assertion here.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.api_base import Author  # noqa: E402
from implementation_scripts.entity_matching import (  # noqa: E402
    BASES, fold_name, match, match_all, name_matches,
)

ORCID = "0000-0002-1825-0097"


def profile(**overrides) -> dict:
    base = {
        "display_name": "Jane Doe",
        "names": [{"value": "Jane Doe"}],
        "identifiers": {},
        "affiliations": [],
    }
    base.update(overrides)
    return base


WITH_ORCID = profile(identifiers={"orcid": {"value": ORCID}})
WITH_AFFILIATION = profile(affiliations=["University of Somewhere"])


# ---------------------------------------------------------------------------
# P4 — the three bases, and the ladder between them
# ---------------------------------------------------------------------------

def test_an_orcid_on_the_record_is_an_identifier_match():
    found = match([Author("Jane Doe", orcid=ORCID)], WITH_ORCID)
    assert found.basis == "identifier"
    assert ORCID in found.evidence


def test_the_same_record_without_the_orcid_but_with_the_affiliation():
    found = match([Author("Jane Doe", affiliations=("University of Somewhere",))],
                  WITH_AFFILIATION)
    assert found.basis == "name+affiliation"
    assert "University of Somewhere" in found.evidence


def test_the_same_record_with_neither_is_name_only():
    found = match([Author("Jane Doe")], profile())
    assert found.basis == "name_only"


def test_a_non_matching_name_never_matches():
    assert match([Author("John Smith")], profile()) is None
    assert match([Author("John Smith")], WITH_AFFILIATION) is None
    assert match([Author("John Smith", affiliations=("University of Somewhere",))],
                 WITH_AFFILIATION) is None, (
        "an affiliation is not a person; matching on it alone would return every "
        "paper from the institution")


def test_an_orcid_match_does_not_need_the_names_to_agree():
    """A person who publishes under two spellings is one person.

    The identifier is what says so, and requiring the name to agree as well
    would throw away the only basis that is actually about identity.
    """
    found = match([Author("J. A. Doe-Smith", orcid=ORCID)], WITH_ORCID)
    assert found.basis == "identifier"


def test_the_strongest_basis_wins_when_several_authors_match():
    authors = [Author("Jane Doe"),
               Author("Jane Doe", orcid=ORCID, affiliations=("Somewhere",))]
    assert match(authors, WITH_ORCID).basis == "identifier"


def test_the_bases_are_ranked_strongest_first():
    assert BASES == ("identifier", "name+affiliation", "name_only")


def test_every_match_carries_evidence():
    """No basis the code cannot evidence — a phase constraint, asserted."""
    for authors, prof in (
        ([Author("Jane Doe", orcid=ORCID)], WITH_ORCID),
        ([Author("Jane Doe", affiliations=("University of Somewhere",))], WITH_AFFILIATION),
        ([Author("Jane Doe")], profile()),
    ):
        found = match(authors, prof)
        assert found.evidence.strip(), found
        assert found.matched_author


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("candidate,target", [
    ("Jane Doe", "Jane Doe"),
    ("jane doe", "Jane Doe"),
    ("Jane  Doe", "Jane Doe"),
    ("Vincent Lariviere", "Vincent Larivière"),
    ("Müller, Hans", "Hans Muller"),
])
def test_the_same_name_written_differently_still_matches(candidate, target):
    """Accent, case and punctuation folding, reused from the title matcher."""
    matched, _note = name_matches(candidate, target)
    assert matched


@pytest.mark.parametrize("candidate,target", [
    ("John Smith", "Jane Doe"),
    ("Smith", "John Smith"),
    ("John Smith", "Smith"),
    ("Jane Doe", "Jane Roe"),
    ("Jan Doe", "Jane Doe"),
])
def test_names_that_are_not_the_same_person(candidate, target):
    matched, _note = name_matches(candidate, target)
    assert not matched


def test_a_surname_on_its_own_is_not_a_person():
    """"Smith" against "John Smith" is a coincidence in any corpus worth watching."""
    assert name_matches("Smith", "John Smith") == (False, "")


def test_initials_match_and_say_that_they_are_initials():
    """The caveat is in the evidence, not averaged away.

    `J. Smith` is compatible with every John, Jane, Jamal and Jia Smith who ever
    published. The rule is on because refusing it misses most real matches in a
    corpus where most sources abbreviate; the evidence is where that cost is
    recorded, and the field test grades this basis separately because of it.
    """
    matched, note = name_matches("J. Doe", "Jane Doe")
    assert matched
    assert "initial" in note

    found = match([Author("J. Doe")], profile())
    assert found.basis == "name_only"
    assert "initial" in found.evidence


def test_an_initial_that_does_not_start_the_name_does_not_match():
    assert not name_matches("X. Doe", "Jane Doe")[0]


def test_a_different_number_of_given_names_does_not_match():
    """"Jane Doe" and "Jane Alice Doe" are not established to be one person."""
    assert not name_matches("Jane Doe", "Jane Alice Doe")[0]


def test_a_name_of_only_stop_words_still_folds_to_something():
    """`normalise_title` drops English stop words, and surnames contain them.

    "De La" folding to zero tokens would make it match everything or nothing
    depending on which side it landed on.
    """
    assert fold_name("De La") == ["de", "la"]


def test_a_non_latin_name_is_not_folded_away():
    """The title matcher's rule, and the reason it exists: an earlier draft of
    that one encoded to ASCII and turned every Japanese title into zero words."""
    assert fold_name("村上春樹")


def test_an_alias_matches_as_well_as_the_canonical_name():
    prof = profile(names=[{"value": "Vincent Lariviere"},
                          {"value": "Vincent Larivière"}])
    assert match([Author("Vincent Larivière")], prof).basis == "name_only"


# ---------------------------------------------------------------------------
# Affiliations
# ---------------------------------------------------------------------------

def test_an_affiliation_matches_inside_a_longer_department_string():
    found = match(
        [Author("Jane Doe",
                affiliations=("Dept. of Physics, University of Somewhere, 12345 City",))],
        WITH_AFFILIATION)
    assert found.basis == "name+affiliation"


def test_a_short_profile_affiliation_is_not_used():
    """"MIT" as a substring matches "SUMMIT", "COMMITTEE" and much else.

    Under four folded characters an affiliation is dropped from the comparison
    rather than allowed to produce a `name+affiliation` basis it has not earned.
    """
    prof = profile(affiliations=["MIT"])
    found = match([Author("Jane Doe", affiliations=("Summit Research Institute",))],
                  prof)
    assert found.basis == "name_only"


def test_a_different_institution_stays_name_only():
    found = match([Author("Jane Doe", affiliations=("University of Elsewhere",))],
                  WITH_AFFILIATION)
    assert found.basis == "name_only"


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------

class _Record:
    def __init__(self, authors):
        self.authors = authors


def test_match_all_keeps_order_and_drops_what_does_not_match():
    records = [_Record([Author("John Smith")]),
               _Record([Author("Jane Doe")]),
               _Record([Author("Someone", orcid=ORCID)])]
    found = match_all(records, WITH_ORCID)
    assert [m.basis for _r, m in found] == ["name_only", "identifier"]


def test_a_record_with_no_authors_matches_nothing():
    assert match([], profile()) is None
    assert match(None, profile()) is None


def test_last_comma_first_is_reordered_before_matching():
    """INSPIRE returns `Witten, Edward`; a user may type either order.

    Without the reorder the surname test compares "witten" against "edward" and
    a whole source's records stop matching — **silently**, because a non-match
    is what "this is not that person" also looks like.
    """
    assert name_matches("Witten, Edward", "Edward Witten")[0]
    assert name_matches("Doe, J.", "Jane Doe")[0]
    assert fold_name("Müller, Hans") == fold_name("Hans Muller")
