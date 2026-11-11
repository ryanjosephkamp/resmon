"""Why am I seeing this paper, and which of my keywords earn their place.

Query tuning is something every user does constantly, and today it is done
blind: you change a term, wait a week, and guess from what arrives whether the
change helped. This module replaces the guessing with measurement, in two
directions.

**Per paper.** Which of the run's keywords actually appear in the title, the
abstract, the categories, the author list — and which appear nowhere resmon can
check.

**Per keyword, across a corpus.** How many papers a keyword brought in that no
other keyword did. A term contributing nothing unique is costing a slot in
every query and buying nothing.

The honesty problem, and why it is the feature
-----------------------------------------------
resmon cannot know why an upstream source returned a paper. Most of the fifteen
sources are relevance-ranked -- their backends score documents against the query
and return the best matches, so a paper can legitimately come back without
containing any of the terms literally. resmon also checks keywords only against
title, abstract, authors, and categories: the match may be in the full text (even
of a PDF it keeps), in publisher keywords, or in a MeSH term, none of which it
reads for a match.

So this module never claims to explain the upstream's decision. It reports what
is **locally verifiable** and states plainly where its knowledge stops, using
each source's own documented keyword semantics from the repository catalog.
There is exactly one case where resmon can be certain -- bioRxiv/medRxiv have no
upstream keyword search at all, so resmon does the filtering itself and knows
precisely why a paper is in the set.

Pretending to more than that would be a lie the user eventually catches, and the
whole point of this module is to stop resmon lying about itself.

Matching semantics
------------------
The rule a search itself uses (``search_terms.pattern``): each keyword is one
term, matched as whole words, without regard to case, and a keyword of several
words only as that phrase, across spaces or hyphens. Substring matching was
rejected: "AI" appears inside "said" and "chain", and a transparency feature
that reports false matches is worse than no transparency feature. Quote marks
in a keyword are not searched for.

A keyword's text is literal, as it is in the search: an AND or OR typed inside
one is part of the term. Such a keyword is flagged (``contains_operators``),
because the words read like syntax and are not.

For bioRxiv and medRxiv, which resmon filters itself, the explanation checks
what the filter checks, the title and the abstract, and says the paper is
there because it has any of the run's terms, or all of them when the run asked
for all.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections import defaultdict

from . import repo_catalog, search_terms
from .paper_collections import RUN_COLLECTION_SQL, documents_in

# Sources where resmon performs the keyword filtering itself, so the local
# explanation is complete rather than partial: the sources whose plan
# (``search_terms.PLANS``) is ``local``, which have no upstream keyword search.
_LOCALLY_FILTERED_SOURCES = {
    slug for slug, plan in search_terms.PLANS.items() if plan.kind == "local"
}

# The fields a local filter reads (``search_terms.paper_text``).
_FILTERED_FIELDS = ("title", "abstract")

# Fields on ``documents`` that can be checked locally, in the order a reader
# cares about them. Title first: a title match is the strongest local evidence.
_SEARCHABLE_FIELDS = ("title", "abstract", "categories", "authors")

_FIELD_LABELS = {
    "title": "the title",
    "abstract": "the abstract",
    "categories": "the subject categories",
    "authors": "the author list",
}

# Uppercase boolean tokens some upstreams honor inside a single keyword chip.
_OPERATOR_RE = re.compile(r"(?:^|\s)(AND|OR|NOT)(?:\s|$)")

# Minimum papers before a keyword's unique-contribution share is reported as a
# proportion. Below this the percentage swings wildly on one paper.
MIN_SAMPLE_FOR_SHARE = 10


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


def _compile_keyword(keyword: str) -> re.Pattern | None:
    """A whole-word matcher for one keyword, the one a search uses (``search_terms.pattern``).

    Returns ``None`` for a keyword with nothing matchable in it, which keeps a
    stray empty chip from matching every paper in the corpus.
    """
    return search_terms.pattern(keyword)


def _fields_matched(document: dict, pattern: re.Pattern) -> list[str]:
    return [
        field for field in _SEARCHABLE_FIELDS
        if pattern.search(str(document.get(field) or ""))
    ]


def _has_operators(keyword: str) -> bool:
    return bool(_OPERATOR_RE.search(keyword or ""))


# ---------------------------------------------------------------------------
# Keyword extraction
# ---------------------------------------------------------------------------


def keywords_for_execution(execution: dict) -> list[str]:
    """The keywords a run actually used: its terms (``search_terms.from_params``).

    Executions store an explicit ``keywords`` list, but any launched from a bare
    query string carries only ``query``, which is read the way the run read it:
    a quoted phrase as one term and every other word as its own.
    """
    terms = _terms_of(execution)
    return list(terms.terms) if terms else []


def _terms_of(execution: dict) -> search_terms.Terms | None:
    """A run's terms and whether any or all had to match, or ``None`` for a run with none."""
    raw = execution.get("parameters")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            raw = None
    if not isinstance(raw, dict):
        return None
    # A find looked one paper up by its DOI, id or title: what was typed is an
    # identifier, not keywords, and checking a paper for it says nothing.
    # ``from_params`` says so for a find and for a person watch.
    return search_terms.from_params(raw)


# ---------------------------------------------------------------------------
# Per-document explanation
# ---------------------------------------------------------------------------


def _source_entry(slug: str) -> dict | None:
    for entry in repo_catalog.catalog_as_dicts():
        if entry.get("slug") == slug:
            return entry
    return None


def _limits(source: dict | None, slug: str) -> list[str]:
    """What resmon demonstrably cannot see about this paper.

    Stated every time, including when keywords did match. A match in the title
    explains why the paper is *plausible*; it still is not the upstream's
    reasoning, and the difference matters to anyone defending a search strategy.
    """
    limits = [
        "resmon checks keywords against each paper's title, abstract, authors, and "
        "categories, never its full text, even when it keeps the PDF. A keyword could "
        "appear in the body of the paper, in publisher-supplied keywords, or in an "
        "indexing term such as MeSH, and resmon would not see it there.",
    ]
    combination = (source or {}).get("keyword_combination") or ""
    notes = (source or {}).get("keyword_combination_notes") or ""
    name = (source or {}).get("name") or slug

    plan = search_terms.plan(slug)
    if slug in _LOCALLY_FILTERED_SOURCES:
        limits.append(
            f"{name} is the exception: it has no upstream keyword search, so "
            "resmon did the filtering itself. For this source the explanation "
            "below is complete rather than partial."
        )
    elif plan is not None and plan.kind == "ranked":
        limits.append(
            f"{name} is relevance-ranked, not a strict keyword filter. It scores "
            "papers against the whole query and returns the best matches, so a "
            "paper can legitimately come back without containing any single term "
            "literally. resmon cannot see that score or the reasoning behind it."
            + (f" {notes}" if notes else "")
        )
    elif notes or combination:
        # The notes open with how resmon asks this source for several terms
        # (``search_terms.PLANS``), then what is known about the source itself.
        limits.append(notes or f"How resmon asks {name} for several terms: {combination}.")
    return limits


def explain_document(
    conn: sqlite3.Connection,
    document_id: int,
    execution_id: int | None = None,
) -> dict:
    """Why this paper is in the corpus, as far as resmon can honestly say.

    When ``execution_id`` is given the explanation uses that run's keywords.
    Otherwise every run that returned this paper is considered, and the union of
    their keywords is explained -- a paper found by three routines was not
    "because of" any one of them.
    """
    row = conn.execute(
        "SELECT * FROM documents WHERE id = ?", (int(document_id),)
    ).fetchone()
    if row is None:
        raise LookupError(f"No document with id {document_id}")
    document = dict(row)

    if execution_id is not None:
        executions = conn.execute(
            """
            SELECT e.id, e.execution_type, e.start_time, e.parameters,
                   e.routine_id, r.name AS routine_name
            FROM executions e
            LEFT JOIN routines r ON r.id = e.routine_id
            WHERE e.id = ?
            """,
            (int(execution_id),),
        ).fetchall()
    else:
        executions = conn.execute(
            """
            SELECT e.id, e.execution_type, e.start_time, e.parameters,
                   e.routine_id, r.name AS routine_name
            FROM executions e
            JOIN execution_documents ed ON ed.execution_id = e.id
            LEFT JOIN routines r ON r.id = e.routine_id
            WHERE ed.document_id = ?
            ORDER BY e.start_time DESC
            """,
            (int(document_id),),
        ).fetchall()

    runs = []
    seen_keywords: dict[str, None] = {}
    run_matches: list[str] = []
    for execution in executions:
        execution = dict(execution)
        terms = _terms_of(execution)
        keywords = list(terms.terms) if terms else []
        if terms:
            run_matches.append(terms.match)
        for keyword in keywords:
            seen_keywords.setdefault(keyword, None)
        runs.append({
            "execution_id": execution["id"],
            "execution_type": execution["execution_type"],
            "start_time": execution["start_time"],
            "routine_name": execution.get("routine_name"),
            "keywords": keywords,
        })

    slug = document.get("source_repository") or ""
    source = _source_entry(slug)

    matches = []
    for keyword in seen_keywords:
        pattern = _compile_keyword(keyword)
        fields = _fields_matched(document, pattern) if pattern else []
        matches.append({
            "keyword": keyword,
            "matched": bool(fields),
            "fields": fields,
            "where": _describe_fields(fields),
            "contains_operators": _has_operators(keyword),
        })

    # Title first, then abstract, then anything else, then the misses. A reader
    # scanning this wants the strongest evidence at the top.
    matches.sort(key=lambda m: (
        not m["matched"],
        "title" not in m["fields"],
        "abstract" not in m["fields"],
        m["keyword"].lower(),
    ))

    matched = [m for m in matches if m["matched"]]
    # Every run that found the paper asked for all of its terms, or not.
    match = (search_terms.MATCH_ALL if run_matches and all(m == search_terms.MATCH_ALL for m in run_matches)
             else search_terms.MATCH_ANY)
    verdict, headline = _verdict(slug, source, matches, matched, match)
    finds = [run for run in runs if run["execution_type"] == "find_paper"]
    if finds and not matches:
        how = conn.execute(
            "SELECT matched_by FROM execution_find_results WHERE document_id = ? AND outcome = 'found' "
            "ORDER BY execution_id DESC LIMIT 1", (int(document_id),)).fetchone()
        verdict = "found_by_find"
        headline = (
            f"Look Up a Paper looked it up, and {(source or {}).get('name') or slug} answered with this "
            f"record{_FIND_MATCH_WORDS.get(how[0] if how else '', '')}. A find is not a keyword search, so "
            "there are no keywords to check it against.")

    return {
        "document": {
            "id": document["id"],
            "title": document.get("title"),
            "source_repository": slug,
            "doi": document.get("doi"),
            "publication_date": document.get("publication_date"),
            "first_seen_at": document.get("first_seen_at"),
        },
        "source": {
            "slug": slug,
            "name": (source or {}).get("name") or slug,
            "keyword_combination": (source or {}).get("keyword_combination"),
            "keyword_combination_notes": (source or {}).get("keyword_combination_notes"),
            "resmon_filtered_locally": slug in _LOCALLY_FILTERED_SOURCES,
        },
        "runs": runs,
        "keywords": matches,
        "matched_count": len(matched),
        "keyword_count": len(matches),
        "verdict": verdict,
        "headline": headline,
        "what_resmon_cannot_see": _limits(source, slug),
        "fields_checked": list(_SEARCHABLE_FIELDS),
    }


def _describe_fields(fields: list[str]) -> str:
    if not fields:
        return "nowhere resmon can check"
    labels = [_FIELD_LABELS[f] for f in fields]
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        return f"{labels[0]} and {labels[1]}"
    return ", ".join(labels[:-1]) + ", and " + labels[-1]


#: How a find matched the record it kept, as the paper's account says it.
_FIND_MATCH_WORDS = {
    "doi": ", which carries the DOI asked for",
    "arxiv": ", which carries the arXiv id asked for",
    "pmid": ", which carries the PMID asked for",
    "exact_title": ", whose title is the title asked for",
    "close_title": ", whose title is close to the title asked for",
}


def _verdict(
    slug: str,
    source: dict | None,
    matches: list[dict],
    matched: list[dict],
    match: str = search_terms.MATCH_ANY,
) -> tuple[str, str]:
    """Grade the explanation itself, not the paper.

    The three grades say how much of the answer resmon actually has. None of
    them is a judgement about whether the paper is relevant -- that is the
    user's call, and a tool claiming to make it would be the recommender this
    feature exists to be an alternative to.
    """
    name = (source or {}).get("name") or slug

    if not matches:
        return (
            "no_keywords_recorded",
            "This run did not record the keywords it used, so there is nothing "
            "to check the paper against.",
        )

    if slug in _LOCALLY_FILTERED_SOURCES:
        # The filter reads the title and the abstract, and nothing else, so
        # only a match there is the reason the paper was kept.
        filtered = [m for m in matched if any(f in _FILTERED_FIELDS for f in m["fields"])]
        complete = (len(filtered) == len(matches) if match == search_terms.MATCH_ALL
                    else bool(filtered))
        if complete:
            every = match == search_terms.MATCH_ALL and len(filtered) > 1
            return (
                "resmon_filtered",
                f"{name} has no keyword search of its own, so resmon did the "
                f"matching in the title and abstract. This paper is here because "
                f"{'every term, ' if every else ''}"
                f"{_join_keywords([m['keyword'] for m in filtered])}"
                f"{',' if every else ''} "
                f"{'appear' if len(filtered) > 1 else 'appears'} in it. That is "
                "the complete reason, not a partial one.",
            )
        return (
            "no_local_evidence",
            f"{name} is filtered by resmon itself, so a paper without "
            f"{'every term' if match == search_terms.MATCH_ALL else 'a matching term'} "
            "in its title or abstract is unexpected here. It may predate a change "
            "to this watch's keywords.",
        )

    if matched:
        return (
            "local_evidence",
            f"{_join_keywords([m['keyword'] for m in matched])} "
            f"{'appear' if len(matched) > 1 else 'appears'} in this paper. That "
            f"makes it a plausible match — but {name} chose to return it for its "
            "own reasons, which resmon cannot see.",
        )

    return (
        "no_local_evidence",
        f"None of your keywords appear anywhere resmon can check. That does not "
        f"mean the paper is irrelevant: {name} returned it, and the match may be "
        "in text resmon does not store.",
    )


def _join_keywords(keywords: list[str]) -> str:
    quoted = [f"“{k}”" for k in keywords]
    if len(quoted) == 1:
        return quoted[0]
    if len(quoted) == 2:
        return f"{quoted[0]} and {quoted[1]}"
    return ", ".join(quoted[:-1]) + f", and {quoted[-1]}"


# ---------------------------------------------------------------------------
# Per-keyword marginal contribution
# ---------------------------------------------------------------------------


def keyword_contribution(
    conn: sqlite3.Connection,
    execution_id: int | None = None,
    collection_id: int | None = None,
) -> dict:
    """Per keyword: papers it brought in that no other keyword did.

    Scoped to one execution when ``execution_id`` is given, otherwise to every
    keyword the user has ever searched, against the whole corpus; with
    ``collection_id``, to the keywords of the runs that put papers in that
    collection, against its papers.

    A keyword whose every paper is also matched by another keyword is
    contributing nothing on its own. That is the actionable finding, and it is
    invisible without this arithmetic.

    Cost note: this reads every candidate document once and evaluates all
    keywords in a single pass, rather than issuing one query per keyword. The
    same matcher runs here as in ``explain_document``, so a paper listed under a
    keyword here will say so when opened -- consistency being worth more than
    the speed of pushing the work into SQL with different semantics.
    """
    if execution_id is not None:
        execution = conn.execute(
            "SELECT id, parameters FROM executions WHERE id = ?",
            (int(execution_id),),
        ).fetchone()
        if execution is None:
            raise LookupError(f"No execution with id {execution_id}")
        keywords = keywords_for_execution(dict(execution))
        documents = conn.execute(
            """
            SELECT d.id, d.title, d.abstract, d.categories, d.authors
            FROM documents d
            JOIN execution_documents ed ON ed.document_id = d.id
            WHERE ed.execution_id = ?
            """,
            (int(execution_id),),
        ).fetchall()
        scope = {"type": "execution", "execution_id": int(execution_id)}
    else:
        keywords = _all_keywords(conn, collection_id)
        documents = conn.execute(
            f"SELECT id, title, abstract, categories, authors FROM {documents_in(collection_id)}"
        ).fetchall()
        scope = {"type": "corpus"}

    if not keywords:
        return _empty_contribution(
            scope, "No keywords have been recorded on any run yet.",
        )
    if not documents:
        return _empty_contribution(scope, "No papers to measure against yet.")

    patterns = {}
    for keyword in keywords:
        pattern = _compile_keyword(keyword)
        if pattern is not None:
            patterns[keyword] = pattern
    if not patterns:
        return _empty_contribution(
            scope, "None of the recorded keywords contain anything matchable.",
        )

    hits: dict[str, set[int]] = defaultdict(set)
    matched_any: set[int] = set()
    for row in documents:
        document = dict(row)
        for keyword, pattern in patterns.items():
            if _fields_matched(document, pattern):
                hits[keyword].add(document["id"])
                matched_any.add(document["id"])

    rows = []
    for keyword in patterns:
        mine = hits.get(keyword, set())
        others: set[int] = set()
        for other, ids in hits.items():
            if other != keyword:
                others |= ids
        unique = mine - others
        rows.append({
            "keyword": keyword,
            "matched": len(mine),
            "unique": len(unique),
            "shared": len(mine) - len(unique),
            "contains_operators": _has_operators(keyword),
            # A share is only meaningful once there is a corpus to take a share
            # of; below the threshold it is reported as None rather than as a
            # confident percentage of nine papers.
            "unique_share": (
                round(len(unique) / len(mine), 3)
                if len(mine) >= MIN_SAMPLE_FOR_SHARE else None
            ),
        })

    rows.sort(key=lambda r: (-r["unique"], -r["matched"], r["keyword"].lower()))

    return {
        "scope": scope,
        "keywords": rows,
        "documents_considered": len(documents),
        "documents_matched": len(matched_any),
        # Papers no keyword accounts for. On a relevance-ranked source this is
        # entirely normal and the interface says so; a large share of them is
        # still worth knowing about.
        "documents_unexplained": len(documents) - len(matched_any),
        "sample_size": len(documents),
        "minimum_sample_for_share": MIN_SAMPLE_FOR_SHARE,
        "sufficient": True,
        "insufficient_reason": None,
        "fields_checked": list(_SEARCHABLE_FIELDS),
    }


def _all_keywords(conn: sqlite3.Connection, collection_id: int | None = None) -> list[str]:
    """Every distinct keyword across every execution (or every one that put
    papers in a collection), in first-seen order."""
    rows = conn.execute(
        "SELECT parameters FROM executions"
        + ("" if collection_id is None else f" WHERE {RUN_COLLECTION_SQL} = {int(collection_id)}")
        + " ORDER BY start_time ASC, id ASC"
    ).fetchall()
    seen: dict[str, None] = {}
    for row in rows:
        for keyword in keywords_for_execution({"parameters": row["parameters"]}):
            seen.setdefault(keyword, None)
    return list(seen)


def _empty_contribution(scope: dict, reason: str) -> dict:
    return {
        "scope": scope,
        "keywords": [],
        "documents_considered": 0,
        "documents_matched": 0,
        "documents_unexplained": 0,
        "sample_size": 0,
        "minimum_sample_for_share": MIN_SAMPLE_FOR_SHARE,
        "sufficient": False,
        "insufficient_reason": reason,
        "fields_checked": list(_SEARCHABLE_FIELDS),
    }
