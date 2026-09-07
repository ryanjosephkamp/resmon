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

Name folding preserves every token, including initials and surname particles.
It folds case and accents without discarding non-Latin scripts. Title stop words
are not a name policy.

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
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Optional, Sequence

from .normalizer import normalize_author_name

__all__ = ["BASES", "Match", "fold_name", "match", "match_all", "name_matches"]

# In the order the interface ranks them. `watch_profile_matches.basis` carries
# the same three and enforces them with a CHECK.
BASES = ("identifier", "name+affiliation", "name_only")

_INITIAL = re.compile(r"^[^\W\d_]$", re.UNICODE)

# Existing evidence is never rewritten. This prefix identifies newly evaluated
# evidence without a schema migration or guessing from a timestamp.
EVIDENCE_PREFIX = "Matching policy 2026-09-07: "


@dataclass(frozen=True)
class Match:
    """One candidate match with the evidence and its evaluation policy."""

    basis: str
    matched_author: str
    evidence: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "evidence", EVIDENCE_PREFIX + self.evidence)

    @property
    def rank(self) -> int:
        return BASES.index(self.basis)


def _fold_tokens(text: str) -> list[str]:
    """Case/accent folding with punctuation as boundaries and no stop words."""
    folded = unicodedata.normalize("NFKD", (text or "").casefold())
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    return re.findall(r"[^\W_]+", folded, re.UNICODE)


def fold_name(name: str) -> list[str]:
    """Comparable name tokens, preserving initials and surname particles.

    Reorder ``Last, First`` before folding. Never reuse title normalization:
    removing "A", "Will", "de" or "van" changes the written person's name.
    """
    return _fold_tokens(normalize_author_name(name))


def _surname(tokens: Sequence[str]) -> str:
    return tokens[-1] if tokens else ""


def name_matches(candidate: str, target: str) -> tuple[bool, str]:
    """Whether two written names are compatible, with an explicit caveat.

    Returns ``(matched, note)``; the note goes into a match's evidence so the
    weaker kinds of yes are visible rather than averaged away.

    The rule, in order:

    1. Identical after folding — the ordinary case.
    2. Same surname, and every given-name token on one side is either equal to
       or an **initial of** the corresponding token on the other. This is the
       ``J. Smith`` ↔ ``John Smith`` rule and it is recorded as weaker.
    3. Identical single-token names are ambiguous candidates, never identity.
       A surname alone against a multi-token name is not a match.
    """
    left, right = fold_name(candidate), fold_name(target)
    if not left or not right:
        return False, ""
    if left == right:
        if len(left) == 1:
            return True, "ambiguous single-token name — may be a mononym or shared surname; not identity"
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
    """The first nonempty affiliation pair sharing a complete token run.

    A department can contain an institution's name, but MIT is not SUMMIT.
    Generic institution words alone and a one-character token are insufficient.
    Acronyms and non-Latin names can match as whole tokens, never substrings.
    """
    generic = {"university", "college", "institute", "institution", "department",
               "dept", "school", "research", "center", "centre", "of", "the", "and"}
    profiles = [(a, _fold_tokens(a)) for a in profile_affiliations if a]
    authors = [(a, _fold_tokens(a)) for a in author_affiliations if a]
    for raw_profile, profile_tokens in profiles:
        for raw_author, author_tokens in authors:
            shorter, longer = sorted((profile_tokens, author_tokens), key=len)
            if not shorter or not any(len(t) >= 2 and t not in generic for t in shorter):
                continue
            if any(longer[i:i + len(shorter)] == shorter
                   for i in range(len(longer) - len(shorter) + 1)):
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
    conflicts: list[tuple[str, str]] = []
    for author in authors or []:
        name = getattr(author, "name", "") or ""
        orcid = getattr(author, "orcid", None)
        affiliations = list(getattr(author, "affiliations", ()) or ())

        # 1. Identity. The only basis that is about a person, and it does not
        #    require the names to agree: a person who publishes under two
        #    spellings is one person, and the ORCID is what says so.
        if profile_orcid and orcid and orcid.upper() == profile_orcid.upper():
            if best is None or best.basis != "identifier":
                best = Match("identifier", name,
                             f"ORCID {profile_orcid} on the record equals the profile's")
            continue

        matched_name, note = next(
            ((candidate, note) for candidate in profile_names
             for matched, note in [name_matches(name, candidate)] if matched),
            (None, ""))
        if not matched_name:
            continue

        # A conflicting supplied identifier is counterevidence, never a reason
        # to upgrade a name match. A single token remains ambiguous even when
        # an institution string agrees. Keep these candidates visible to review.
        conflict = bool(profile_orcid and orcid and orcid.upper() != profile_orcid.upper())
        ambiguous = len(fold_name(name)) == 1
        if conflict:
            counterevidence = (f"conflicting ORCID: record {orcid} differs from profile "
                               f"{profile_orcid}; counterevidence, not identity")
            conflicts.append((name, counterevidence))
            note += "; " + counterevidence
        hit = None if conflict or ambiguous else _affiliation_hit(affiliations, profile_affiliations)
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
    if best is not None:
        # Selecting the strongest author must not hide a different compatible
        # name carrying a conflicting identifier. Keep the positive basis tied
        # to its selected author; other authors' conflicts do not support it.
        other_conflicts = [f"'{name}': {detail}" for name, detail in conflicts
                           if detail not in best.evidence]
        if other_conflicts:
            best = Match(best.basis, best.matched_author,
                         best.evidence[len(EVIDENCE_PREFIX):]
                         + "; other compatible-name author counterevidence: "
                         + "; ".join(other_conflicts))
    return best


def match_all(records, profile: dict) -> list[tuple[object, Match]]:
    """Every record that matches, with its basis. Order preserved."""
    out = []
    for record in records or []:
        found = match(getattr(record, "authors", []), profile)
        if found is not None:
            out.append((record, found))
    return out
