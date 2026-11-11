# resmon_scripts/implementation_scripts/search_terms.py
"""How a list of search terms becomes each source's query.

A search is a list of **terms** and a **match**: ``any`` (a paper with any one
term is kept, the default) or ``all`` (a paper must have every term). The
terms are the chips a person adds one at a time, and each is one term:

- a single word is a word;
- several words are a phrase, wherever the source can search for one;
- the text is literal. Quotes, AND, OR, NOT, or a field prefix such as
  ``ti:`` typed inside a term are part of the term, never query syntax.
  Quote marks are dropped (they carry nothing a source indexes, and left in
  they would end a phrase early), and anything else that a source would read
  as syntax is put inside a phrase, where it is text.

This module is the one place that decides what each source is sent for those
terms. Sources fall into four groups (``PLANS`` names each source's):

``boolean``
    The source reads OR, AND, and quoted phrases, so the terms become one
    query in its own dialect: ``splats OR "gaussian splatting"``.
``per_term``
    The source is not asked for OR (it ignores or refuses one, or resmon has
    not established that it reads one). For Any, each term is asked on its own,
    paced by the source's own rate limiter, and the answers are merged,
    deduplicated, and capped at the run's most papers per source. For All,
    every word of every term goes into one query; each source's catalog notes
    say what is known of how it reads several words. A phrase is sent as its
    words.
``ranked``
    The source ranks by relevance and has no OR or AND (Crossref, Semantic
    Scholar). For Any, one query of all the words is sent, and the ranking
    decides. For All, the same query is sent, and resmon keeps only the
    papers whose title or abstract has every term (``matches``).
``local``
    The source cannot be asked for words at all (bioRxiv, medRxiv). resmon
    reads the papers in the window and keeps those whose title or abstract
    has the terms, as whole words and phrases (``matches``).

A run's terms come from its stored parameters (``from_params``): the
``keywords`` list where there is one, which every editor writes. A run, a
watch, or a saved search that stored only a ``query`` string reads that string
the way a search box does, a quoted phrase as one term and every other word as
a term of its own, and with no stored match requires all of them, which is
what such a query asked of most sources before the terms were kept apart.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Callable, Iterable, Literal, Mapping, Optional, Sequence

logger = logging.getLogger(__name__)

Match = Literal["any", "all"]
MATCH_ANY: Match = "any"
MATCH_ALL: Match = "all"
MATCHES: tuple[Match, ...] = (MATCH_ANY, MATCH_ALL)

#: The words for each match, as a record, a report and a screen say them.
MATCH_WORDS: dict[str, str] = {
    MATCH_ANY: "any term",
    MATCH_ALL: "all terms",
}

# Quote marks of every kind a keyboard or a paste produces. None is searchable
# text, and a straight one inside a phrase would end it early.
_QUOTES = re.compile(r"[\"“”„‟«»″]")

# A term a Lucene-family parser reads as one plain word: letters, digits and
# underscores only. Anything else (a hyphen, a colon, a bracket, a slash, a
# plus) is syntax to at least one of them, so such a term is sent as a
# phrase, where it is text.
_PLAIN_WORD = re.compile(r"^\w+$")

# Words that are operators to some source when they stand alone. In a phrase
# they are text; alone, they are sent as a quoted phrase of one word.
_OPERATOR_WORDS = frozenset({"and", "or", "not", "andnot", "to", "near"})

# The English stop words of Lucene's default list. Search indexes leave them
# out, so requiring one can empty a search: on arXiv, measured October 30,
# 2026, `all:theory AND all:of AND all:mind` matched 0 papers where
# `all:theory AND all:mind` matched 2,013. A typed query's stop words are
# dropped when it has other words (``split_query``), and arXiv is not sent a
# term that is one stop word alone when there are other terms (``arxiv``).
# Inside a phrase they stay: a source matches a phrase as written.
STOP_WORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
    "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
    "their", "then", "there", "these", "they", "this", "to", "was", "will",
    "with",
})


@dataclass(frozen=True)
class Terms:
    """The terms a search asks for, and whether any or all must match."""

    terms: tuple[str, ...]
    match: Match = MATCH_ANY

    def __post_init__(self) -> None:
        if self.match not in MATCHES:
            raise ValueError(f"match must be 'any' or 'all', not {self.match!r}")

    def __bool__(self) -> bool:
        return bool(self.terms)

    @property
    def joined(self) -> str:
        """The terms as one line, the way a run's ``query`` field keeps them."""
        return " ".join(self.terms)

    @property
    def words(self) -> list[str]:
        """Every word of every term, in order, each once (case-insensitively)."""
        seen: set[str] = set()
        out: list[str] = []
        for term in self.terms:
            for word in term.split():
                if word.lower() not in seen:
                    seen.add(word.lower())
                    out.append(word)
        return out

    def each(self) -> list["Terms"]:
        """One search for each term, as a source that cannot be asked for OR is asked."""
        return [Terms((term,), MATCH_ALL) for term in self.terms]


def clean_term(text: object) -> str:
    """One term as it is searched: quote marks dropped, spaces collapsed."""
    return " ".join(_QUOTES.sub(" ", str(text or "")).split())


def normalize_match(value: object, default: Match = MATCH_ANY) -> Match:
    """A stored or requested match, checked. ``None`` or empty is the default."""
    if value is None or value == "":
        return default
    text = str(value).strip().lower()
    if text not in MATCHES:
        raise ValueError("match must be 'any' or 'all'")
    return text  # type: ignore[return-value]


def make(terms: Iterable[object], match: object = None) -> Terms:
    """Terms from a list of chips: cleaned, empty ones dropped, each once.

    Two chips that differ only in case are one term, because every source
    resmon asks matches without regard to case.
    """
    seen: set[str] = set()
    kept: list[str] = []
    for raw in terms:
        term = clean_term(raw)
        if term and term.lower() not in seen:
            seen.add(term.lower())
            kept.append(term)
    return Terms(tuple(kept), normalize_match(match))


def split_query(query: str) -> list[str]:
    """A typed query's terms: a quoted phrase is one term, every other word its own.

    A stop word typed between other words is left out (see ``STOP_WORDS``):
    "theory of mind" asks for "theory" and "mind". A query of nothing but
    stop words keeps them.
    """
    found: list[tuple[bool, str]] = []
    for each in re.finditer(r'"([^"]*)"|“([^”]*)”|(\S+)', query or ""):
        quoted = each.group(3) is None
        term = clean_term(each.group(1) or each.group(2) or each.group(3) or "")
        if term:
            found.append((quoted, term))
    kept = [term for quoted, term in found if quoted or term.lower() not in STOP_WORDS]
    return kept or [term for _, term in found]


def from_params(params: Mapping | None) -> Terms | None:
    """The terms a run, a watch, or a saved search asks for, from its parameters.

    ``None`` where it asks for no words: a person watch, a find, or nothing
    stored. A stored match that is not ``any`` or ``all`` is read as the
    default rather than refused here, because a run must still say what it
    did; the routes refuse one before it is stored.
    """
    if not isinstance(params, Mapping):
        return None
    if params.get("find") or params.get("entity_profile") is not None or params.get("entity") is not None:
        return None
    raw_match = params.get("match")
    keywords = params.get("keywords")
    if isinstance(keywords, list):
        terms = make(keywords)
        if terms:
            return Terms(terms.terms, _stored_match(raw_match, MATCH_ANY))
    query = params.get("query")
    if isinstance(query, str) and query.strip():
        terms = make(split_query(query))
        if terms:
            return Terms(terms.terms, _stored_match(raw_match, MATCH_ALL))
    return None


def _stored_match(value: object, default: Match) -> Match:
    try:
        return normalize_match(value, default)
    except ValueError:
        logger.warning("A stored match of %r is not 'any' or 'all'; read as %r", value, default)
        return default


# ---------------------------------------------------------------------------
# Each source's query
# ---------------------------------------------------------------------------

def _needs_phrase(term: str) -> bool:
    """Whether a term must be sent quoted: several words, a non-word character, or an operator word."""
    return (" " in term or not _PLAIN_WORD.match(term)
            or term.lower() in _OPERATOR_WORDS)


def boolean(terms: Terms, *, or_: str = "OR", and_: str = "AND",
            word: Callable[[str], str] = lambda t: t,
            phrase: Callable[[str], str] = lambda t: f'"{t}"') -> str:
    """The terms as one Boolean query: each term a word or a quoted phrase, joined by OR or AND.

    With more than one term the query is not put in parentheses here; a
    client that adds a date clause after it puts the whole query in
    parentheses first, so the dates bind every term.
    """
    parts = [phrase(t) if _needs_phrase(t) else word(t) for t in terms.terms]
    joiner = f" {or_} " if terms.match == MATCH_ANY else f" {and_} "
    return joiner.join(parts)


def arxiv(terms: Terms) -> str:
    """arXiv's ``search_query``: ``all:splats OR all:"gaussian splatting"``.

    arXiv reads AND, OR, and ANDNOT only in capitals, and a quoted phrase as
    the words in that order. A term that is one stop word alone is left out
    when there are other terms, because arXiv's index has none of them and
    requiring one empties the search (``STOP_WORDS``).
    """
    kept = tuple(t for t in terms.terms if t.lower() not in STOP_WORDS) or terms.terms
    return boolean(Terms(kept, terms.match), word=lambda t: f"all:{t}", phrase=lambda t: f'all:"{t}"')


def inspire(terms: Terms) -> str:
    """INSPIRE's ``q``: lowercase ``or`` and ``and``, a phrase in double quotes."""
    return boolean(terms, or_="or", and_="and")


def words(terms: Terms) -> str:
    """Every word of every term, separated by spaces, for a source with no OR and no phrases."""
    return " ".join(terms.words)


def semantic_scholar(terms: Terms) -> str:
    """Every word, with hyphens read as spaces.

    Semantic Scholar's paper search takes plain text with no syntax, and its
    documentation says a hyphenated term matches nothing ("replace it with
    space to find matches").
    """
    return " ".join(w for w in re.split(r"[\s\-‐-―]+", words(terms)) if w)


@dataclass(frozen=True)
class Plan:
    """How one source is asked for several terms. See the module docstring."""

    kind: Literal["boolean", "per_term", "ranked", "local"]
    #: The few words the source catalog shows for it (Terms Combine).
    label: str
    #: The sentence beside them, in the catalog's notes.
    notes: str


_BOOLEAN_LABEL = "Any or all, phrases kept"
_BOOLEAN_NOTES = (
    "resmon joins your terms with {source}'s own OR for Any and AND for All, "
    "and sends a term of several words as a quoted phrase."
)
_PER_TERM_LABEL = "Any: one request per term"
_PER_TERM_NOTES = (
    "resmon does not ask {source} for OR. For Any, it asks for each term in "
    "turn, at {source}'s own pace, and keeps each paper once, up to the most "
    "papers per source. For All, it sends every word of every term in one "
    "request. A term of several words is sent as its words, not as a phrase."
)
_RANKED_LABEL = "Ranked; All checked by resmon"
_RANKED_NOTES = (
    "{source} ranks papers by relevance and has no OR or AND. resmon sends "
    "every word of your terms; for Any the ranking decides, so a paper can "
    "come back without any one term. For All, resmon keeps only the papers "
    "whose title or abstract has every term, as whole words and phrases, so "
    "a paper with no abstract here is kept only when its title has them all."
)
_LOCAL_LABEL = "Matched by resmon, whole words"
_LOCAL_NOTES = (
    "{source} cannot be asked for words. resmon reads the papers it lists for "
    "your dates and keeps those whose title or abstract has any term (Any) or "
    "every term (All), as whole words, without regard to case; a term of "
    "several words matches only as that phrase."
)


def _plan(kind: str) -> Plan:
    label, notes = {
        "boolean": (_BOOLEAN_LABEL, _BOOLEAN_NOTES),
        "per_term": (_PER_TERM_LABEL, _PER_TERM_NOTES),
        "ranked": (_RANKED_LABEL, _RANKED_NOTES),
        "local": (_LOCAL_LABEL, _LOCAL_NOTES),
    }[kind]
    return Plan(kind, label, notes)  # type: ignore[arg-type]


#: Every source's plan. ``test_search_terms.py`` fails when a registered
#: source has none, and drives each client to check that what it sends is
#: what its plan says.
PLANS: dict[str, Plan] = {
    "arxiv": _plan("boolean"),
    "biorxiv": _plan("local"),
    "core": _plan("boolean"),
    "crossref": _plan("ranked"),
    "datacite": _plan("boolean"),
    "dblp": _plan("per_term"),
    "doaj": _plan("boolean"),
    "dryad": _plan("per_term"),
    "eric": _plan("boolean"),
    "europepmc": _plan("boolean"),
    "govinfo": _plan("boolean"),
    "hal": _plan("boolean"),
    "inspire_hep": _plan("boolean"),
    "medrxiv": _plan("local"),
    "nasa_ads": _plan("boolean"),
    "ndl_search": _plan("per_term"),
    "openaire": _plan("per_term"),
    "openalex": _plan("boolean"),
    "openlibrary": _plan("boolean"),
    "osti": _plan("boolean"),
    "plos": _plan("boolean"),
    "pubmed": _plan("boolean"),
    "semantic_scholar": _plan("ranked"),
    "springer": _plan("boolean"),
    "zenodo": _plan("boolean"),
}


def plan(slug: str) -> Plan | None:
    return PLANS.get(slug)


def label(slug: str) -> str:
    """The catalog's Terms Combine words for a source, or empty for one with no plan."""
    found = PLANS.get(slug)
    return found.label if found else ""


def notes(slug: str, name: str) -> str:
    """The catalog's sentence on how resmon asks a source for several terms."""
    found = PLANS.get(slug)
    return found.notes.format(source=name) if found else ""


# ---------------------------------------------------------------------------
# Matching a paper against the terms (bioRxiv, medRxiv, and All on a ranked source)
# ---------------------------------------------------------------------------

# Between the words of a phrase: any run of spaces or hyphens, so "gaussian
# splatting" matches "Gaussian-splatting" and a phrase broken across a line.
_PHRASE_GAP = r"[\s\-‐-―]+"


def pattern(term: str) -> re.Pattern | None:
    """A case-insensitive matcher for one term as whole words, or ``None`` for an empty term.

    A word matches only as a word: "ai" does not match "said". A term that
    begins or ends with a character that is not a letter or digit ("C++",
    "(R)") is anchored only where a word character is.
    """
    text = clean_term(term)
    if not text:
        return None
    parts = [re.escape(part) for part in re.split(_PHRASE_GAP, text) if part]
    if not parts:
        return None
    body = _PHRASE_GAP.join(parts)
    prefix = r"(?<!\w)" if re.match(r"\w", text[0]) else ""
    suffix = r"(?!\w)" if re.search(r"\w$", text) else ""
    return re.compile(f"{prefix}{body}{suffix}", re.IGNORECASE)


def compile_terms(terms: Terms) -> list[re.Pattern]:
    return [p for p in (pattern(t) for t in terms.terms) if p is not None]


def matches(text: str, terms: Terms, patterns: Sequence[re.Pattern] | None = None) -> bool:
    """Whether ``text`` has any term (Any) or every term (All), as whole words."""
    compiled = list(patterns) if patterns is not None else compile_terms(terms)
    if not compiled:
        return True
    test = any if terms.match == MATCH_ANY else all
    return test(p.search(text or "") is not None for p in compiled)


def paper_text(result) -> str:
    """A result's title and abstract, the text resmon matches terms against."""
    return f"{getattr(result, 'title', '') or ''}\n{getattr(result, 'abstract', '') or ''}"


# ---------------------------------------------------------------------------
# Asking one source
# ---------------------------------------------------------------------------

def search(client, slug: str, terms: Terms, *, date_from: Optional[str],
           date_to: Optional[str], max_results: int) -> list:
    """Ask one source for the terms, by its plan, and return what it gave.

    Every request goes through the client's own ``search()``, its own rate
    limiter, and this thread's outcome channel, so what was sent and how each
    request ended are recorded the way a single request's are.
    """
    from .api_base import note_filtered  # noqa: PLC0415

    found = PLANS.get(slug)
    kind = found.kind if found else "boolean"

    if kind == "per_term" and terms.match == MATCH_ANY and len(terms.terms) > 1:
        return _each_term(client, terms, date_from=date_from, date_to=date_to,
                          max_results=max_results)

    results = client.search(query=terms.joined, date_from=date_from, date_to=date_to,
                            max_results=max_results, terms=terms)

    if kind == "ranked" and terms.match == MATCH_ALL and len(terms.terms) > 1:
        compiled = compile_terms(terms)
        kept = [r for r in results if matches(paper_text(r), terms, compiled)]
        if results and not kept:
            # The source answered with papers and none had every term. Said
            # as such, so the zero does not read as a source that had nothing.
            note_filtered(len(results), 0, "all_terms")
        elif len(kept) < len(results):
            logger.info("%s: kept %d of %d results that have every term",
                        slug, len(kept), len(results))
        return kept
    return results


def _each_term(client, terms: Terms, *, date_from: Optional[str], date_to: Optional[str],
               max_results: int) -> list:
    """Ask for each term in turn, then merge the answers.

    Each term is asked for up to the run's cap, and the answers are merged a
    paper from each term in turn, so the cap keeps papers for every term
    rather than filling up from the first. A paper two terms both found is
    kept once, by its id at the source.

    **A request that fails stops the asking.** The outcome channel keeps the
    last request's result, and a later term's success would clear the failure
    and record a source that answered in full while one term's papers were
    missing. Stopping leaves the failure as the last thing recorded, so the
    run says the source's papers may be incomplete.
    """
    from .api_base import search_outcome  # noqa: PLC0415

    answers: list[list] = []
    for one in terms.each():
        outcome = search_outcome()
        if outcome.stop.is_set():
            break
        answers.append(list(client.search(query=one.joined, date_from=date_from, date_to=date_to,
                                          max_results=max_results, terms=one)))
        if (outcome.last_call_failed or outcome.retained_cooldown_status is not None
                or outcome.explicit_reason == "parse_failure"):
            break

    merged: list = []
    seen: set[str] = set()
    depth = max((len(a) for a in answers), default=0)
    for i in range(depth):
        for answer in answers:
            if i >= len(answer):
                continue
            result = answer[i]
            key = str(getattr(result, "external_id", "") or id(result))
            if key in seen:
                continue
            seen.add(key)
            merged.append(result)
            if len(merged) >= max_results:
                return merged
    return merged
