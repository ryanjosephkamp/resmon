"""Deciding whether a paper is *this person's*, and saying which kind of yes.

Phase 2.1's whole rule lives here: **an author match is a string match unless
the source gave an identifier, and the product says so.** So this module never
answers "yes"; it answers with a ``Match`` carrying a ``basis``, and the basis is
what the interface prints beside the paper.

Three bases, strongest first:

``identifier``
    The record's author carried an ORCID equal to the profile's. This is the
    only one that is about a *person*. Everything else is about a string.
``name+affiliation``
    A name matched **and** an affiliation on that author's record matched one of
    the profile's. Better than a bare name and still not identity: two
    researchers with the same name at the same institution both match, and the
    warning at profile creation says exactly that.
``name_only``
    A name matched. resmon can tell you a paper has this name on it and nothing
    more, and the interface never presents this as the person.

## The source's answer is a candidate, never the verdict

Decision 6, and it is the reason ``match`` takes a record rather than a search
result. A source's author search is a *generator*: arXiv's ``au:`` is a text
match over a field, Crossref's ``query.author`` is relevance-ranked, and neither
is a claim about identity. **Every candidate is re-checked here**, including the
ones a source volunteered, so a routine's results contain only what resmon can
evidence itself.

## Names, and why the initials rule is a caveat rather than a feature

Folding reuses ``near_duplicates.normalise_title`` — the same accent, case and
punctuation handling the corpus already trusts for titles, and the same refusal
to discard non-Latin scripts.

``J. Smith`` and ``John Smith`` are treated as a match **and recorded as a
weaker one**, in the evidence, because that equivalence is a guess: initials
collapse a large population onto a small one, and "J. Smith" is compatible with
every John, Jane, Jamal and Jia Smith who ever published. It is enabled because
refusing it would miss most of the real matches in a corpus where a majority of
sources abbreviate given names — and it is the single largest contributor to
false positives on the ``name_only`` basis, which is why the field test grades
that basis separately.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

from .near_duplicates import normalise_title
from .normalizer import normalize_author_name

__all__ = ["BASES", "Match", "fold_name", "match", "match_all", "name_matches"]

# In the order the interface ranks them. `watch_profile_matches.basis` carries
# the same three and enforces them with a CHECK.
BASES = ("identifier", "name+affiliation", "name_only")

_INITIAL = re.compile(r"^[a-z]$")


@dataclass(frozen=True)
class Match:
    """One verified match, and why resmon believes it."""

    basis: str
    matched_author: str
    evidence: str

    @property
    def rank(self) -> int:
        return BASES.index(self.basis)


def fold_name(name: str) -> list[str]:
    """A name as comparable tokens, surname last.

    ``normalise_title`` does the folding, unchanged and imported rather than
    copied: accents decomposed, case and punctuation dropped, non-Latin scripts
    kept. Two things are added.

    **"Last, First" is reordered first.** INSPIRE returns ``Witten, Edward``,
    Crossref splits into given and family, and a user typing a profile may write
    either. Without this the surname test below compares "witten" against
    "edward" and a whole source's records stop matching — silently, because a
    non-match is what "this is not that person" also looks like.

    **Tokens are not stop-worded away.** ``normalise_title`` drops English stop
    words, and "van", "de" and "der" matter in a surname.
    """
    name = normalize_author_name(name)
    tokens = normalise_title(name)
    if tokens:
        return tokens
    # Every token was a stop word — "De La" and the like. Fall back to the
    # unfiltered split rather than returning nothing, because a name that folds
    # to zero tokens would match everything or nothing depending on the caller.
    return [t for t in re.findall(r"\w+", (name or "").casefold()) if t]


def _surname(tokens: Sequence[str]) -> str:
    return tokens[-1] if tokens else ""


def name_matches(candidate: str, target: str) -> tuple[bool, str]:
    """Whether two written names are the same person's, and how confidently.

    Returns ``(matched, note)``; the note goes into a match's evidence so the
    weaker kinds of yes are visible rather than averaged away.

    The rule, in order:

    1. Identical after folding — the ordinary case.
    2. Same surname, and every given-name token on one side is either equal to
       or an **initial of** the corresponding token on the other. This is the
       ``J. Smith`` ↔ ``John Smith`` rule and it is recorded as weaker.
    3. Otherwise no. A shared surname alone is not a match: "Smith" and "Smith"
       is a coincidence in any corpus large enough to be worth watching.
    """
    left, right = fold_name(candidate), fold_name(target)
    if not left or not right:
        return False, ""
    if left == right:
        return True, "exact name"
    if _surname(left) != _surname(right):
        return False, ""

    given_left, given_right = left[:-1], right[:-1]
    if not given_left or not given_right:
        # "Smith" against "John Smith": a surname on its own is not a person.
        return False, ""
    if len(given_left) != len(given_right):
        return False, ""

    for a, b in zip(given_left, given_right):
        if a == b:
            continue
        if _INITIAL.match(a) and b.startswith(a):
            continue
        if _INITIAL.match(b) and a.startswith(b):
            continue
        return False, ""
    return True, ("initials only — an initial matches every given name that "
                  "starts with it")


def _affiliation_hit(author_affiliations: Iterable[str],
                     profile_affiliations: Iterable[str]) -> Optional[tuple[str, str]]:
    """The first affiliation pair that shares a distinctive token run.

    Substring containment either way, on folded text: an author record says
    "Dept. of Physics, University of Somewhere, 12345 City" and a profile says
    "University of Somewhere". Requiring equality would match almost nothing;
    requiring a single shared word would match on "university".
    """
    profiles = [(a, " ".join(fold_name(a))) for a in profile_affiliations if a]
    authors = [(a, " ".join(fold_name(a))) for a in author_affiliations if a]
    for raw_profile, folded_profile in profiles:
        if len(folded_profile) < 4:
            continue
        for raw_author, folded_author in authors:
            if folded_profile in folded_author or folded_author in folded_profile:
                return raw_author, raw_profile
    return None


def match(authors, profile: dict) -> Optional[Match]:
    """The strongest basis on which this record belongs to this profile.

    ``authors`` is a record's ``list[Author]``. ``profile`` is a stored watch
    profile. Returns ``None`` when nothing matches — which is the answer for
    most candidates a source volunteers, and the reason local verification is
    not a formality.
    """
    profile_orcid = ((profile.get("identifiers") or {}).get("orcid") or {}).get("value")
    profile_names = [n.get("value", "") for n in (profile.get("names") or [])]
    if not profile_names and profile.get("display_name"):
        profile_names = [profile["display_name"]]
    profile_affiliations = profile.get("affiliations") or []

    best: Optional[Match] = None
    for author in authors or []:
        name = getattr(author, "name", "") or ""
        orcid = getattr(author, "orcid", None)
        affiliations = list(getattr(author, "affiliations", ()) or ())

        # 1. Identity. The only basis that is about a person, and it does not
        #    require the names to agree: a person who publishes under two
        #    spellings is one person, and the ORCID is what says so.
        if profile_orcid and orcid and orcid.upper() == profile_orcid.upper():
            return Match("identifier", name,
                         f"ORCID {profile_orcid} on the record equals the profile's")

        matched_name, note = next(
            ((candidate, note) for candidate in profile_names
             for matched, note in [name_matches(name, candidate)] if matched),
            (None, ""))
        if not matched_name:
            continue

        # 2. Name and affiliation.
        hit = _affiliation_hit(affiliations, profile_affiliations)
        if hit:
            author_affiliation, profile_affiliation = hit
            candidate = Match(
                "name+affiliation", name,
                f"name matched '{matched_name}' ({note}); affiliation "
                f"'{author_affiliation}' matched the profile's "
                f"'{profile_affiliation}'")
        else:
            # 3. A name, and resmon says only that.
            candidate = Match("name_only", name,
                              f"name matched '{matched_name}' ({note})")

        if best is None or candidate.rank < best.rank:
            best = candidate
    return best


def match_all(records, profile: dict) -> list[tuple[object, Match]]:
    """Every record that matches, with its basis. Order preserved."""
    out = []
    for record in records or []:
        found = match(getattr(record, "authors", []), profile)
        if found is not None:
            out.append((record, found))
    return out
