"""Find a paper: one paper asked of every source that can look it up, and what each said.

A find is a run (``execution_type = 'find_paper'``) and goes through the sweep
engine like any other, so Health and Analytics count each source's answer, its
papers land in the collection it was started in, and it has a report and a log.
What is particular to it lives here:

* **What was typed** (``parse``): a DOI, an arXiv id, a PMID, or else a title.
* **Who is asked** (``plan``): a source is asked only by a kind its catalog
  capability names (``repo_catalog.PAPER_LOOKUP``); every other source named is
  recorded as not asked, with the reason.
* **Which record is the paper** (``best_match``): a source's answer is a list of
  candidates, and a copy is kept only when it is the paper by the identifier
  asked for, or by its title (exact, or close above ``CLOSE_TITLE``). Every
  other candidate is dropped and only counted.
* **What differs** (``differences``) between each copy and the reference copy,
  and the record itself (``record``), with ``shared_doi`` links between every
  stored copy that carries the paper's DOI.
"""
from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Iterable

from . import open_access
from .near_duplicates import normalise_title, title_similarity

KINDS = ("doi", "arxiv", "pmid", "title")
KIND_WORDS = {"doi": "DOI", "arxiv": "arXiv id", "pmid": "PMID", "title": "title"}
#: How close a title must be to count as the paper: a token-set ratio, the
#: near-duplicate scan's own measure, over the words that carry meaning.
CLOSE_TITLE = 0.85
#: A title shorter than this, in meaningful words, is asked for but never
#: matched closely: "Deep learning" is a hundred papers.
MIN_TITLE_WORDS = 3
#: The most candidates asked of one source.
CANDIDATES = 5
#: The link Find a paper writes between stored copies of one paper.
LINK_KIND = "same_paper"
LINK_METHOD = "shared_doi"
#: The order a reference copy is chosen in, when several sources hold the paper:
#: the registration agencies and the sources of record first.
_REFERENCE_ORDER = ("crossref", "datacite", "pubmed", "arxiv", "biorxiv", "medrxiv",
                    "europepmc", "openalex", "semantic_scholar")

_PMID = re.compile(r"^(?:pmid:\s*)?(\d{1,9})$", re.I)


@dataclass(frozen=True)
class PaperQuery:
    kind: str
    value: str
    typed: str

    def as_params(self) -> dict:
        return {"kind": self.kind, "value": self.value, "typed": self.typed}


def parse(typed: str) -> PaperQuery:
    """What a person typed into Find a paper, read as the identifier it is, else as a title."""
    text = re.sub(r"\s+", " ", str(typed or "")).strip()
    if not text:
        raise ValueError("Type a DOI, an arXiv id, a PMID, or a title.")
    if len(text) > 500:
        raise ValueError("That is longer than any title; a title or an identifier is at most 500 characters.")
    doi = open_access.bare_doi(text)
    if doi:
        return PaperQuery("doi", doi, text)
    if re.match(r"^(?:arxiv:\s*|https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/)", text, re.I) or re.match(
            r"^(?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?/\d{7})(?:v\d+)?$", text, re.I):
        arxiv_id = open_access.bare_arxiv_id(text)
        if arxiv_id:
            return PaperQuery("arxiv", arxiv_id, text)
    pmid = _PMID.match(text)
    if pmid:
        return PaperQuery("pmid", pmid.group(1), text)
    if re.match(r"^https?://(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov/(\d+)/?$", text, re.I):
        return PaperQuery("pmid", re.findall(r"\d+", text)[-1], text)
    return PaperQuery("title", text, text)


def plan(query: PaperQuery, sources: Iterable[str]) -> tuple[list[str], list[dict]]:
    """The sources to ask, in the order named, and the rest with why each is not asked."""
    from .api_registry import RETIRED_REPOSITORIES  # noqa: PLC0415
    from .repo_catalog import PAPER_LOOKUP, catalog_names  # noqa: PLC0415

    names = catalog_names()
    asked: list[str] = []
    not_asked: list[dict] = []
    for slug in dict.fromkeys(sources):
        name = names.get(slug, slug)
        capability = PAPER_LOOKUP.get(slug)
        if slug in RETIRED_REPOSITORIES:
            why = RETIRED_REPOSITORIES[slug]
        elif capability is None or not capability.kinds:
            why = (capability.established if capability and capability.established
                   else f"resmon cannot look a paper up at {name}.")
        elif query.kind not in capability.kinds:
            kinds = ", ".join(KIND_WORDS[k] for k in capability.kinds)
            why = f"{name} can be asked by {kinds}, not by {KIND_WORDS[query.kind]}."
        elif slug in ("biorxiv", "medrxiv") and not query.value.lower().startswith("10.1101/"):
            why = f"{name}'s DOIs all begin 10.1101/, and this one does not."
        else:
            asked.append(slug)
            continue
        not_asked.append({"source": slug, "why": why})
    return asked, not_asked


def lookup_sources() -> dict[str, list[str]]:
    """For each kind of query, the sources that can be asked by it."""
    from .repo_catalog import PAPER_LOOKUP  # noqa: PLC0415

    return {kind: sorted(slug for slug, cap in PAPER_LOOKUP.items() if kind in cap.kinds) for kind in KINDS}


# ---------------------------------------------------------------------------
# Which candidate is the paper
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Match:
    record: object
    matched_by: str
    similarity: float | None
    candidates: int


def _identifiers(record) -> dict[str, set[str]]:
    found: dict[str, set[str]] = {"doi": set(), "arxiv": set(), "pmid": set()}
    doi = open_access.bare_doi(getattr(record, "doi", None))
    if doi:
        found["doi"].add(doi)
        prefix = "10.48550/arxiv."
        if doi.startswith(prefix):
            found["arxiv"].add(doi[len(prefix):])
    for scheme, value in getattr(record, "identifiers", None) or []:
        if scheme == "arxiv":
            bare = open_access.bare_arxiv_id(value)
            if bare:
                found["arxiv"].add(bare.lower())
        elif scheme == "pmid":
            found["pmid"].add(str(value).strip())
    source = getattr(record, "source_repository", "")
    external = str(getattr(record, "external_id", "") or "")
    if source == "arxiv":
        bare = open_access.bare_arxiv_id(external)
        if bare:
            found["arxiv"].add(bare.lower())
    if source == "pubmed" and external.isdigit():
        found["pmid"].add(external)
    return found


def title_match(asked: str, title: str | None) -> tuple[str | None, float]:
    """``exact_title``, ``close_title`` or None, and the similarity."""
    if not title:
        return None, 0.0
    asked_words, words = normalise_title(asked), normalise_title(title)
    if asked_words and asked_words == words:
        return "exact_title", 1.0
    similarity = title_similarity(asked, title)
    if len(asked_words) >= MIN_TITLE_WORDS and similarity >= CLOSE_TITLE:
        return "close_title", round(similarity, 4)
    return None, round(similarity, 4)


def best_match(results: list, query: PaperQuery) -> Match | None:
    """The candidate that is the paper asked for, or None. Never a guess past the rules above."""
    if not results:
        return None
    if query.kind != "title":
        wanted = query.value.lower()
        for record in results:
            if wanted in _identifiers(record)[query.kind]:
                return Match(record, query.kind, None, len(results))
        return None
    best: Match | None = None
    for record in results:
        how, similarity = title_match(query.value, getattr(record, "title", None))
        if how is None:
            continue
        if best is None or (how == "exact_title" and best.matched_by != "exact_title") or (
                how == best.matched_by and (similarity or 0) > (best.similarity or 0)):
            best = Match(record, how, similarity, len(results))
    return best


def reference(matches: dict[str, Match]) -> str | None:
    """The source whose copy the others are compared with."""
    if not matches:
        return None
    exact = {s: m for s, m in matches.items() if m.matched_by != "close_title"} or matches
    ranked = sorted(exact, key=lambda s: (_REFERENCE_ORDER.index(s) if s in _REFERENCE_ORDER
                                          else len(_REFERENCE_ORDER), s))
    return ranked[0]


def _surname(authors: list) -> str | None:
    for author in authors or []:
        name = str(getattr(author, "name", author) or "").strip()
        if name:
            part = name.split(",")[0] if "," in name else name.split(" ")[-1]
            return part.strip().casefold() or None
    return None


def differences(record, ref) -> list[dict]:
    """What this copy says that the reference copy does not: title, year, DOI, first author, author count."""
    if ref is None or record is ref:
        return []
    out: list[dict] = []

    def add(field: str, this, other) -> None:
        out.append({"field": field, "this": this, "reference": other})

    if normalise_title(record.title) != normalise_title(ref.title):
        add("title", record.title, ref.title)
    year, ref_year = str(record.publication_date or "")[:4] or None, str(ref.publication_date or "")[:4] or None
    if year != ref_year:
        add("year", year, ref_year)
    doi, ref_doi = open_access.bare_doi(record.doi), open_access.bare_doi(ref.doi)
    if doi != ref_doi:
        add("doi", record.doi, ref.doi)
    names, ref_names = list(record.authors or []), list(ref.authors or [])
    if names and ref_names and _surname(names) != _surname(ref_names):
        add("first_author", getattr(names[0], "name", str(names[0])),
            getattr(ref_names[0], "name", str(ref_names[0])))
    if len(names) != len(ref_names):
        add("author_count", len(names), len(ref_names))
    return out


# ---------------------------------------------------------------------------
# The record
# ---------------------------------------------------------------------------


def record(conn: sqlite3.Connection, execution_id: int, query: PaperQuery,
           sources: list[str], not_asked: list[dict], matches: dict[str, Match],
           candidates: dict[str, int], answered: dict[str, bool]) -> dict:
    """Write ``execution_find_results`` for every source the find named, and the copies' links.

    *sources* are the ones asked, *answered* whether each answered at all
    (from its run record), *candidates* how many records each returned.
    """
    from .normalizer import normalize_result  # noqa: PLC0415

    ref_source = reference(matches)
    ref = normalize_result(matches[ref_source].record) if ref_source else None
    position = 0
    stored: dict[str, int] = {}
    for slug in sources:
        match = matches.get(slug)
        document_id = None
        diffs: list[dict] = []
        if match is not None:
            found = normalize_result(match.record)
            row = conn.execute("SELECT id FROM documents WHERE source_repository = ? AND external_id = ?",
                               (found.source_repository, found.external_id)).fetchone()
            document_id = int(row[0]) if row else None
            if document_id is not None:
                stored[slug] = document_id
            diffs = differences(found, ref) if slug != ref_source else []
            outcome = "found"
        elif not answered.get(slug, True):
            outcome = "did_not_answer"
        else:
            outcome = "not_found"
        conn.execute(
            "INSERT OR REPLACE INTO execution_find_results (execution_id, source, position, outcome, matched_by, "
            "title_similarity, document_id, candidates, differences, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (int(execution_id), slug, position, outcome, match.matched_by if match else None,
             match.similarity if match else None, document_id, candidates.get(slug),
             json.dumps(diffs) if diffs else None,
             "reference" if slug == ref_source else None))
        position += 1
    for item in not_asked:
        conn.execute(
            "INSERT OR REPLACE INTO execution_find_results (execution_id, source, position, outcome, detail) "
            "VALUES (?, ?, ?, 'not_asked', ?)", (int(execution_id), item["source"], position, item["why"]))
        position += 1
    conn.commit()
    links = link_copies(conn, list(stored.values()))
    return {"reference": ref_source, "stored": stored, "links": links}


def link_copies(conn: sqlite3.Connection, document_ids: list[int]) -> int:
    """``shared_doi`` links between these papers and every stored record with the same DOI.

    A DOI names one work, so every pair that shares one is the same paper; the
    pair is stored once, smaller id first, as ``document_links`` requires. A
    DOI shared by more than ``open_access.MAX_COPIES`` records is not linked:
    that many records under one DOI is not one paper's copies.
    """
    written = 0
    dois = set()
    for document_id in document_ids:
        row = conn.execute("SELECT doi FROM documents WHERE id = ?", (int(document_id),)).fetchone()
        doi = open_access.bare_doi(row[0]) if row else None
        if doi:
            dois.add(doi)
    for doi in sorted(dois):
        ids = [int(r[0]) for r in conn.execute(
            "SELECT id FROM documents WHERE lower(doi) = ? ORDER BY id LIMIT ?", (doi, open_access.MAX_COPIES + 1))]
        if len(ids) > open_access.MAX_COPIES:
            continue
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO document_links (document_a, document_b, kind, score, method) "
                    "VALUES (?, ?, ?, 1.0, ?)", (a, b, LINK_KIND, LINK_METHOD))
                written += cursor.rowcount
    conn.commit()
    return written


def result(conn: sqlite3.Connection, execution_id: int) -> dict | None:
    """A find as its page reads it: what was asked, and each source's answer with its open copy."""
    from .repo_catalog import catalog_names  # noqa: PLC0415

    row = conn.execute("SELECT id, execution_type, parameters, status FROM executions WHERE id = ?",
                       (int(execution_id),)).fetchone()
    if row is None or row["execution_type"] != "find_paper":
        return None
    params = json.loads(row["parameters"] or "{}")
    find = params.get("find") or {}
    names = catalog_names()
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM execution_find_results WHERE execution_id = ? ORDER BY position", (int(execution_id),))]
    found_ids = [r["document_id"] for r in rows if r["document_id"] is not None]
    copies_by_doc: dict[int, list[dict]] = {}
    for location in open_access.locations_for(conn, found_ids):
        copies_by_doc.setdefault(int(location["document_id"]), []).append(location)
    sources = []
    for r in rows:
        own = copies_by_doc.get(r["document_id"] or -1, [])
        best = open_access.best_copy(own)
        open_copy = None
        if own:
            shown = best or own[0]
            open_copy = {
                "downloadable": best is not None,
                "license": shown.get("license"),
                "license_words": open_access.license_words(shown.get("license")),
                "host": shown.get("host"),
                "pdf_url": shown.get("pdf_url"),
                "license_to_be_read": open_access.needs_license_lookup(shown),
            }
        sources.append({
            "source": r["source"],
            "name": names.get(r["source"], r["source"]),
            "outcome": r["outcome"],
            "matched_by": r["matched_by"],
            "title_similarity": r["title_similarity"],
            "document_id": r["document_id"],
            "candidates": r["candidates"],
            "differences": json.loads(r["differences"]) if r["differences"] else [],
            "reference": r["detail"] == "reference",
            "why_not_asked": r["detail"] if r["outcome"] == "not_asked" else None,
            "open_copy": open_copy,
        })
    reference_row = next((s for s in sources if s["reference"]), None)
    return {
        "execution_id": int(execution_id),
        "status": row["status"],
        "query": {"kind": find.get("kind"), "value": find.get("value"), "typed": find.get("typed")},
        "reference_document_id": reference_row["document_id"] if reference_row else None,
        "sources": sources,
        "counts": {outcome: sum(1 for s in sources if s["outcome"] == outcome)
                   for outcome in ("found", "not_found", "did_not_answer", "not_asked")},
    }


# ---------------------------------------------------------------------------
# A finished find's notification
# ---------------------------------------------------------------------------


def asked_words(kind: object, value: object) -> str:
    """What a find asked for, as a sentence names it: "the DOI 10.1000/x", "the title “A paper”"."""
    text = str(value or "")
    if kind in ("doi", "arxiv", "pmid"):
        return f"the {KIND_WORDS[str(kind)]} {text}"
    return f"the title \u201c{text}\u201d"


def notice_words(conn: sqlite3.Connection, execution_id: int) -> str | None:
    """A finished find's notification: how many of the sources asked hold the paper, as its page says it.

    None when the run is not a find or recorded no source as asked.
    """
    row = conn.execute("SELECT parameters FROM executions WHERE id = ? AND execution_type = 'find_paper'",
                       (int(execution_id),)).fetchone()
    if row is None:
        return None
    find = (json.loads(row["parameters"] or "{}").get("find") or {})
    outcomes = {r[0]: int(r[1]) for r in conn.execute(
        "SELECT outcome, COUNT(*) FROM execution_find_results WHERE execution_id = ? GROUP BY outcome",
        (int(execution_id),))}
    asked = sum(outcomes.get(k, 0) for k in ("found", "not_found", "did_not_answer"))
    if not asked:
        return None
    what = asked_words(find.get("kind"), find.get("value"))
    sources = "source" if asked == 1 else "sources"
    found = outcomes.get("found", 0)
    if found:
        words = f"{found} of {asked} {sources} asked {'holds' if found == 1 else 'hold'} {what}"
    else:
        words = f"None of the {asked} {sources} asked holds {what}"
    silent = outcomes.get("did_not_answer", 0)
    if silent:
        words += f"; {silent} did not answer"
    return words + "."
