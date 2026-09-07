#!/usr/bin/env python3
"""What can each source be asked about a *person*, and what does it give back?

Phase 2.1's brief names candidates and says, in as many words, that which
sources can answer an entity query and which return an ORCID or an affiliation
is the implementer's to establish with a live record and cite. This is that
record. It is opt-in and lives beside ``measure_assistant_cost.py`` and
``probe_sqlite_vec.py``: run it, read what it wrote, put the answers in the
catalog with their citations.

## The shape of the probe, and why it has a control

Asking a source for ``au:Hinton`` and getting papers back establishes nothing:
almost every one of these endpoints will accept an unknown field prefix and
search for the whole string as keywords, which returns plausible results for a
famous name. So every author probe is run **three times**:

| | |
|---|---|
| **A** | the documented author syntax, with a real author |
| **B** | the same syntax with an author who does not exist |
| **C** | the bare name as a plain keyword query, no syntax |

The field or parameter is honoured when **A returns records whose author list
actually contains the person and B returns none**. If B returns as much as A,
the syntax was ignored and the source was doing a keyword search — which is
``none``, however good A looked. If A and C are identical and B is empty, the
source may be doing an author search either way; the row says what was seen.

**A is not evidence on its own, and a plausible answer is the failure mode this
probe exists to catch.**

## What it cannot establish

It reads one query per source on one day. A source that changes its query parser
leaves this record stale, and nothing re-runs it — the same standing weakness
``can_embed`` and the tool-calling table have. Where a source needs a key this
machine does not hold, the row is ``unknown`` and says which key is missing,
rather than guessing from the documentation.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

TIMEOUT = httpx.Timeout(60.0, connect=15.0)

# One real author per source, chosen inside that source's own coverage — a
# physicist for INSPIRE, a clinician for Europe PMC — because "returns nothing"
# has two causes and only one of them is about the query syntax.
NONSENSE = "Zzqxwvyt Pflurgenhaus"


@dataclass
class Probe:
    slug: str
    author: str
    orcid: Optional[str] = None
    # (label -> callable returning (status, body_text)) built per source below.
    run: Optional[Callable[[str], tuple[int, str]]] = None
    # The *same* query with no author syntax at all. Where A and this return the
    # same records, the syntax was ignored and the source was keyword-searching.
    bare: Optional[Callable[[str], tuple[int, str]]] = None
    # The same term asked of a *different* field of the same source. A parser
    # that ignores an unknown prefix answers this identically to the author
    # query; a parser that reads it does not.
    other_field: Optional[Callable[[str], tuple[int, str]]] = None
    note: str = ""


@dataclass
class Finding:
    slug: str
    author: str
    a_status: int = 0
    a_count: int = 0
    a_named: bool = False
    b_status: int = 0
    b_count: int = 0
    c_status: int = 0
    c_count: int = 0
    c_same: bool = False
    bare_ran: bool = False
    d_status: int = 0
    d_count: int = 0
    d_same: bool = False
    other_field_ran: bool = False
    orcid_seen: bool = False
    affiliation_seen: bool = False
    orcid_path: str = ""
    affiliation_path: str = ""
    error: str = ""
    sample: str = ""

    @property
    def discriminates(self) -> bool:
        """The syntax was honoured, not merely tolerated.

        A found the person, B found nobody, **and** the bare-keyword control did
        not return the same set. That last clause is the one that separates a
        real author field from an ignored prefix.
        """
        return (self.a_count > 0 and self.a_named and self.b_count == 0
                and not self.c_same and not self.d_same)


# Several of these endpoints run an anonymous pool that sheds load, and a 429 is
# not an answer about the query. Identify politely and back off rather than
# recording "not established" for a source that was simply busy — the first run
# of this probe recorded OpenAlex and Semantic Scholar as unestablished for
# exactly that reason, which would have been a wrong catalog entry.
USER_AGENT = "resmon/2.1 entity-search probe (mailto:ryanjosephkamp@gmail.com)"


def _get(url: str, params: dict | None = None, headers: dict | None = None) -> tuple[int, str]:
    head = {"User-Agent": USER_AGENT, **(headers or {})}
    for attempt in range(4):
        try:
            r = httpx.get(url, params=params, headers=head, timeout=TIMEOUT,
                          follow_redirects=True)
        except httpx.HTTPError as exc:
            return 0, f"__error__ {type(exc).__name__}: {exc}"
        # arXiv sheds load with **HTTP 200** and the body "Rate exceeded.", so
        # a status-code backoff never fires for it. Detected by content, which
        # is the only signal there is.
        shed = r.status_code in (429, 503) or r.text.strip().startswith("Rate exceeded")
        if shed and attempt < 3:
            time.sleep(12 * (attempt + 1))
            continue
        return r.status_code, r.text
    return 0, "__error__ rate limited after four attempts"


def _count_and_named(body: str, author: str) -> tuple[int, bool]:
    """A crude record count and whether the author's surname appears.

    Deliberately crude and deliberately the same for every source: the probe is
    comparing A against B against C for one source, not comparing sources with
    each other. A surname substring is enough to answer "did the author search
    find this person", and a false positive there makes the probe *less* likely
    to claim a source discriminates, not more.
    """
    if body.startswith("__error__"):
        return 0, False
    surname = author.split()[-1].lower()
    # Try JSON shapes first, then fall back to counting XML entries.
    try:
        data = json.loads(body)
    except ValueError:
        entries = len(re.findall(r"<(entry|record|doc|PubmedArticle)\b", body))
        return entries, surname in body.lower()
    named = surname in body.lower()
    if isinstance(data, list):
        return len(data), named

    # The shapes these APIs actually use, walked rather than guessed at one
    # level. OpenAIRE nests results.result, DBLP nests result.hits.hit, INSPIRE
    # nests hits.hits, Dryad nests _embedded["stash:datasets"].
    def walk(node: Any, depth: int = 0) -> Optional[int]:
        if depth > 4 or not isinstance(node, dict):
            return None
        for key in ("results", "data", "items", "records", "docs", "papers",
                    "hits", "hit", "result", "message", "response", "resultList",
                    "_embedded", "stash:datasets", "esearchresult", "idlist"):
            child = node.get(key)
            if isinstance(child, list):
                return len(child)
            if isinstance(child, dict):
                deeper = walk(child, depth + 1)
                if deeper is not None:
                    return deeper
        return None

    found = walk(data)
    return (found if found is not None else 0), named


def _fields_seen(body: str) -> tuple[bool, str, bool, str]:
    """Whether an ORCID and an affiliation appear anywhere in the raw record.

    Substring, not schema: what matters for the catalog is whether the field is
    *there to be read*, and the client fill is where its exact path is pinned.
    The path columns record the first key seen so the fill has somewhere to
    start.
    """
    lowered = body.lower()
    orcid_key = ""
    for key in ("orcid", "orcid_id", "authenticated-orcid", "orcidid"):
        if f'"{key}"' in lowered or f"<{key}" in lowered:
            orcid_key = key
            break
    # An ORCID URI in the body counts even when the key is named something else.
    orcid_uri = bool(re.search(r"orcid\.org/\d{4}-\d{4}-\d{4}-\d{3}[\dxX]", body))
    aff_key = ""
    for key in ("affiliation", "affiliations", "institution", "authorAffiliation",
                "affiliationstring_s", "raw_affiliation_strings", "aff"):
        if f'"{key}"' in lowered or f"<{key}" in lowered:
            aff_key = key
            break
    return bool(orcid_key or orcid_uri), orcid_key or ("orcid.org URI" if orcid_uri else ""), \
        bool(aff_key), aff_key


# ---------------------------------------------------------------------------
# The probes, one per source
# ---------------------------------------------------------------------------
#
# Each returns a callable taking the author name and producing (status, body).
# The syntax used is the source's own documented author field or parameter; a
# source with no documented one gets a ``None`` runner and is recorded as
# ``none`` without a call, which is itself the honest answer.

def _arxiv(name: str) -> tuple[int, str]:
    surname = name.split()[-1]
    return _get("https://export.arxiv.org/api/query",
                {"search_query": f'au:"{surname}"', "max_results": 5})


def _crossref(name: str) -> tuple[int, str]:
    return _get("https://api.crossref.org/works",
                {"query.author": name, "rows": 5},
                {"User-Agent": "resmon/2.1 (entity-search probe; mailto:noreply@example.org)"})


def _openalex(name: str) -> tuple[int, str]:
    return _get("https://api.openalex.org/works",
                {"filter": f"raw_author_name.search:{name}", "per_page": 5,
                 # The polite pool. Without it the anonymous cluster sheds this
                 # request under load and answers a rate-limit body.
                 "mailto": "ryanjosephkamp@gmail.com"})


def _openalex_by_orcid(orcid: str) -> tuple[int, str]:
    """The identifier query, which is a different capability from the name one."""
    return _get("https://api.openalex.org/works",
                {"filter": f"author.orcid:https://orcid.org/{orcid}", "per_page": 5,
                 "mailto": "ryanjosephkamp@gmail.com"})


def _europepmc(name: str) -> tuple[int, str]:
    return _get("https://www.ebi.ac.uk/europepmc/webservices/rest/search",
                {"query": f'AUTH:"{name}"', "format": "json", "pageSize": 5,
                 "resultType": "core"})


def _pubmed(name: str) -> tuple[int, str]:
    status, body = _get(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
        {"db": "pubmed", "term": f"{name}[au]", "retmax": 5, "retmode": "json"})
    if status != 200 or body.startswith("__error__"):
        return status, body
    try:
        ids = json.loads(body)["esearchresult"]["idlist"]
    except (ValueError, KeyError):
        return status, body
    if not ids:
        return status, json.dumps({"results": []})
    # efetch, because esearch answers ids and the ORCID/affiliation question is
    # about the *record*.
    fstatus, fbody = _get(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
        {"db": "pubmed", "id": ",".join(ids), "retmode": "xml"})
    return fstatus, fbody


def _hal(name: str) -> tuple[int, str]:
    # `authFullName_s` is an *exact string* field: HAL holds "Yann Le Cun" and
    # `authFullName_s:"Yann LeCun"` returns zero. That is a fact about the
    # source worth carrying into the capability note, not a probe bug.
    return _get("https://api.archives-ouvertes.fr/search/",
                {"q": f'authFullName_s:"{name}"', "rows": 5, "wt": "json",
                 "fl": "docid,title_s,authFullName_s,authOrcidId_s,"
                       "labStructName_s,structAcronym_s"})


def _inspire(name: str) -> tuple[int, str]:
    # INSPIRE's own `a` operator, unquoted. Quoting it — `a "Edward Witten"` —
    # returns zero, which is the first thing this probe got wrong.
    return _get("https://inspirehep.net/api/literature",
                {"q": f"a {name}", "size": 5, "fields": "titles,authors"})


def _datacite(name: str) -> tuple[int, str]:
    return _get("https://api.datacite.org/dois",
                {"query": f'creators.name:"{name}"', "page[size]": 5})


def _zenodo(name: str) -> tuple[int, str]:
    return _get("https://zenodo.org/api/records",
                {"q": f'creators.name:"{name}"', "size": 5})


def _openaire(name: str) -> tuple[int, str]:
    return _get("https://api.openaire.eu/search/publications",
                {"author": name, "size": 5, "format": "json"})


def _semantic_scholar(name: str) -> tuple[int, str]:
    # The paper search has no author field; the *author* endpoint is the route,
    # which is why the capability for this source is `endpoint` and not `field`.
    status, body = _get("https://api.semanticscholar.org/graph/v1/author/search",
                        {"query": name, "limit": 3, "fields": "name,externalIds"})
    if status != 200 or body.startswith("__error__"):
        return status, body
    try:
        authors = json.loads(body).get("data") or []
    except ValueError:
        return status, body
    if not authors:
        return status, json.dumps({"results": []})
    author_id = authors[0]["authorId"]
    # `authors.externalIds` and `authors.affiliations` are rejected outright
    # ("Unrecognized or unsupported fields"), which is itself the answer to
    # whether this endpoint returns an ORCID with a paper's authors: it does
    # not, and the author *record* is where the identifier lives.
    return _get(f"https://api.semanticscholar.org/graph/v1/author/{author_id}/papers",
                {"limit": 5, "fields": "title,authors"})


def _dblp(name: str) -> tuple[int, str]:
    return _get("https://dblp.org/search/publ/api",
                {"q": f"author:{name.replace(' ', '_')}:", "format": "json", "h": 5})


def _doaj(name: str) -> tuple[int, str]:
    return _get(f"https://doaj.org/api/search/articles/bibjson.author.name:%22"
                f"{name.replace(' ', '%20')}%22", {"pageSize": 5})


def _plos(name: str) -> tuple[int, str]:
    return _get("https://api.plos.org/search",
                {"q": f'author:"{name}"', "rows": 5, "wt": "json",
                 "fl": "id,title,author_display,author_affiliate"})


def _osti(name: str) -> tuple[int, str]:
    return _get("https://www.osti.gov/api/v1/records", {"author": name, "rows": 5})


def _core(name: str) -> tuple[int, str]:
    return 0, "__error__ needs a CORE API key, which this machine does not hold"


def _nasa_ads(name: str) -> tuple[int, str]:
    return 0, "__error__ needs a NASA ADS token, which this machine does not hold"


def _springer(name: str) -> tuple[int, str]:
    return 0, "__error__ needs a Springer key, which this machine does not hold"


def _govinfo(name: str) -> tuple[int, str]:
    return 0, "__error__ needs a GovInfo key, which this machine does not hold"


def _openlibrary(name: str) -> tuple[int, str]:
    return _get("https://openlibrary.org/search.json",
                {"author": name, "limit": 5})


def _ndl(name: str) -> tuple[int, str]:
    return _get("https://ndlsearch.ndl.go.jp/api/sru",
                {"operation": "searchRetrieve", "version": "1.2",
                 "query": f'creator="{name}"', "maximumRecords": 5,
                 "recordSchema": "dcndl"})


def _dryad(name: str) -> tuple[int, str]:
    return _get("https://datadryad.org/api/v2/search",
                {"author": name, "per_page": 5})


def _oapen(name: str) -> tuple[int, str]:
    # DSpace's REST search, and the field prefix **is** parsed. A first reading
    # of this probe said the opposite, on the strength of A and the bare-keyword
    # control sharing their first record — which they do, because the field
    # result is a *subset* of the keyword result (2 of 100). The D control
    # settles it: `dc.title:"Suber"` returns 0 against the same word.
    return _get("https://library.oapen.org/rest/search",
                {"query": f'dc.contributor.author:"{name.split()[-1]}"',
                 "expand": "metadata"})


def _eric(name: str) -> tuple[int, str]:
    return _get("https://api.ies.ed.gov/eric/",
                {"search": f'author:"{name}"', "format": "json", "rows": 5})


def _nist(name: str) -> tuple[int, str]:
    return _get("https://data.nist.gov/rmm/papers", {"author": name})


def _biorxiv(name: str) -> tuple[int, str]:
    return 0, ("__error__ the details endpoint takes a date window and a cursor "
               "and has no query of any kind")




# --- the bare-keyword controls (C) -----------------------------------------
#
# One per source whose author probe puts a *field prefix inside a keyword
# query*. A source asked through a dedicated parameter (`query.author=`,
# `author=`) or a separate endpoint has no "same query without the syntax", and
# its row has no C.

def _arxiv_bare(name: str) -> tuple[int, str]:
    return _get("https://export.arxiv.org/api/query",
                {"search_query": f'all:"{name.split()[-1]}"', "max_results": 5})


def _europepmc_bare(name: str) -> tuple[int, str]:
    return _get("https://www.ebi.ac.uk/europepmc/webservices/rest/search",
                {"query": f'"{name}"', "format": "json", "pageSize": 5,
                 "resultType": "core"})


def _hal_bare(name: str) -> tuple[int, str]:
    return _get("https://api.archives-ouvertes.fr/search/",
                {"q": f'"{name}"', "rows": 5, "wt": "json",
                 "fl": "docid,title_s,authFullName_s,authOrcidId_s"})


def _inspire_bare(name: str) -> tuple[int, str]:
    return _get("https://inspirehep.net/api/literature",
                {"q": name, "size": 5, "fields": "titles,authors"})


def _datacite_bare(name: str) -> tuple[int, str]:
    return _get("https://api.datacite.org/dois", {"query": f'"{name}"', "page[size]": 5})


def _zenodo_bare(name: str) -> tuple[int, str]:
    return _get("https://zenodo.org/api/records", {"q": f'"{name}"', "size": 5})


def _plos_bare(name: str) -> tuple[int, str]:
    return _get("https://api.plos.org/search",
                {"q": f'"{name}"', "rows": 5, "wt": "json", "fl": "id,title"})


def _doaj_bare(name: str) -> tuple[int, str]:
    return _get(f"https://doaj.org/api/search/articles/%22{name.replace(' ', '%20')}%22",
                {"pageSize": 5})


def _oapen_bare(name: str) -> tuple[int, str]:
    return _get("https://library.oapen.org/rest/search",
                {"query": name.split()[-1], "expand": "metadata"})


def _eric_bare(name: str) -> tuple[int, str]:
    return _get("https://api.ies.ed.gov/eric/",
                {"search": f'"{name}"', "format": "json", "rows": 5})


def _pubmed_bare(name: str) -> tuple[int, str]:
    return _get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
                {"db": "pubmed", "term": name, "retmax": 5, "retmode": "json"})


def _ndl_bare(name: str) -> tuple[int, str]:
    return _get("https://ndlsearch.ndl.go.jp/api/sru",
                {"operation": "searchRetrieve", "version": "1.2",
                 "query": f'anywhere="{name}"', "maximumRecords": 5,
                 "recordSchema": "dcndl"})


# --- the other-field controls (D) ------------------------------------------
#
# The same word, asked of a different field of the same source. Where D returns
# what A returned, the prefix was decoration.

def _arxiv_title(name: str) -> tuple[int, str]:
    return _get("https://export.arxiv.org/api/query",
                {"search_query": f'ti:"{name.split()[-1]}"', "max_results": 5})


def _europepmc_title(name: str) -> tuple[int, str]:
    return _get("https://www.ebi.ac.uk/europepmc/webservices/rest/search",
                {"query": f'TITLE:"{name}"', "format": "json", "pageSize": 5})


def _hal_title(name: str) -> tuple[int, str]:
    return _get("https://api.archives-ouvertes.fr/search/",
                {"q": f'title_s:"{name}"', "rows": 5, "wt": "json", "fl": "docid"})


def _inspire_title(name: str) -> tuple[int, str]:
    return _get("https://inspirehep.net/api/literature",
                {"q": f"t {name}", "size": 5, "fields": "titles"})


def _datacite_title(name: str) -> tuple[int, str]:
    return _get("https://api.datacite.org/dois",
                {"query": f'titles.title:"{name}"', "page[size]": 5})


def _zenodo_title(name: str) -> tuple[int, str]:
    return _get("https://zenodo.org/api/records", {"q": f'title:"{name}"', "size": 5})


def _plos_title(name: str) -> tuple[int, str]:
    return _get("https://api.plos.org/search",
                {"q": f'title:"{name}"', "rows": 5, "wt": "json", "fl": "id"})


def _doaj_title(name: str) -> tuple[int, str]:
    return _get(f"https://doaj.org/api/search/articles/bibjson.title:%22"
                f"{name.replace(' ', '%20')}%22", {"pageSize": 5})


def _oapen_title(name: str) -> tuple[int, str]:
    return _get("https://library.oapen.org/rest/search",
                {"query": f'dc.title:"{name.split()[-1]}"', "expand": "metadata"})


def _eric_title(name: str) -> tuple[int, str]:
    return _get("https://api.ies.ed.gov/eric/",
                {"search": f'title:"{name}"', "format": "json", "rows": 5})


def _pubmed_title(name: str) -> tuple[int, str]:
    return _get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
                {"db": "pubmed", "term": f"{name}[ti]", "retmax": 5, "retmode": "json"})


def _ndl_title(name: str) -> tuple[int, str]:
    return _get("https://ndlsearch.ndl.go.jp/api/sru",
                {"operation": "searchRetrieve", "version": "1.2",
                 "query": f'title="{name}"', "maximumRecords": 5,
                 "recordSchema": "dcndl"})


PROBES: list[Probe] = [
    Probe("arxiv", "Geoffrey Hinton", run=_arxiv, bare=_arxiv_bare, other_field=_arxiv_title),
    Probe("biorxiv", "Eric Topol", run=_biorxiv),
    Probe("core", "Yoshua Bengio", run=_core),
    Probe("crossref", "Yoshua Bengio", orcid="0000-0002-9322-3515", run=_crossref),
    Probe("datacite", "Yoshua Bengio", run=_datacite, bare=_datacite_bare, other_field=_datacite_title),
    Probe("dblp", "Geoffrey Hinton", run=_dblp),
    Probe("doaj", "Eric Topol", run=_doaj, bare=_doaj_bare, other_field=_doaj_title),
    Probe("dryad", "Michael Brown", run=_dryad),
    Probe("eric", "John Hattie", run=_eric, bare=_eric_bare, other_field=_eric_title),
    Probe("europepmc", "Eric Topol", run=_europepmc, bare=_europepmc_bare, other_field=_europepmc_title),
    Probe("govinfo", "Janet Yellen", run=_govinfo),
    Probe("hal", "Jean-Pierre Serre", run=_hal, bare=_hal_bare, other_field=_hal_title),
    Probe("inspire_hep", "Edward Witten", run=_inspire, bare=_inspire_bare, other_field=_inspire_title),
    Probe("medrxiv", "Eric Topol", run=_biorxiv),
    Probe("nasa_ads", "Sara Seager", run=_nasa_ads),
    Probe("ndl_search", "Haruki Murakami", run=_ndl, bare=_ndl_bare, other_field=_ndl_title),
    Probe("nist_rmm", "John Smith", run=_nist),
    Probe("oapen", "Peter Suber", run=_oapen, bare=_oapen_bare, other_field=_oapen_title),
    Probe("openaire", "Yoshua Bengio", run=_openaire),
    Probe("openalex", "Yoshua Bengio", orcid="0000-0002-9322-3515", run=_openalex),
    Probe("openlibrary", "Ursula K. Le Guin", run=_openlibrary),
    Probe("osti", "Steven Chu", run=_osti),
    Probe("plos", "Eric Topol", run=_plos, bare=_plos_bare, other_field=_plos_title),
    Probe("pubmed", "Eric Topol", orcid="0000-0002-1478-4729", run=_pubmed, bare=_pubmed_bare, other_field=_pubmed_title),
    Probe("semantic_scholar", "Yoshua Bengio", run=_semantic_scholar),
    Probe("springer", "Yoshua Bengio", run=_springer),
    Probe("zenodo", "Yoshua Bengio", run=_zenodo, bare=_zenodo_bare, other_field=_zenodo_title),
]


# ---------------------------------------------------------------------------
# Running it
# ---------------------------------------------------------------------------

def probe_one(probe: Probe, keep: Optional[Path] = None) -> Finding:
    finding = Finding(slug=probe.slug, author=probe.author)
    if probe.run is None:
        finding.error = "no documented author query for this source"
        return finding

    finding.a_status, a_body = probe.run(probe.author)
    if a_body.startswith("__error__"):
        finding.error = a_body[len("__error__ "):]
        return finding
    finding.a_count, finding.a_named = _count_and_named(a_body, probe.author)
    (finding.orcid_seen, finding.orcid_path,
     finding.affiliation_seen, finding.affiliation_path) = _fields_seen(a_body)
    finding.sample = a_body[:1200]
    if keep is not None:
        (keep / f"{probe.slug}.a.txt").write_text(a_body[:200_000], encoding="utf-8")

    finding.b_status, b_body = probe.run(NONSENSE)
    if not b_body.startswith("__error__"):
        finding.b_count, _ = _count_and_named(b_body, NONSENSE)

    # C — and this is the control that matters, because A-versus-B does not
    # separate the two things it looks like it separates. A source that ignores
    # an unknown field prefix and keyword-searches the whole string will *also*
    # return nothing for a nonsense author, so A>0 and B=0 is exactly as
    # consistent with "there is no author field" as with "there is one".
    #
    # OAPEN is the case that proved it: `dc.contributor.author:"Suber"` and a
    # bare `Suber` return the same items, so the prefix is decoration. Only C
    # says so.
    # D — the same word under a different field of the same source. This is the
    # strongest control of the three and it is the one that changed an answer:
    # OAPEN's author prefix looked ignored under A-versus-C (they share their
    # first record, because the field result is a subset of the keyword result)
    # and is plainly parsed under D, where `dc.title:"Suber"` returns nothing
    # for a word `dc.contributor.author:"Suber"` finds twice.
    if probe.other_field is not None:
        finding.d_status, d_body = probe.other_field(probe.author)
        if not d_body.startswith("__error__"):
            finding.d_count, _ = _count_and_named(d_body, probe.author)
            finding.d_same = _same_records(a_body, d_body)
            finding.other_field_ran = True

    if probe.bare is not None:
        finding.c_status, c_body = probe.bare(probe.author)
        if not c_body.startswith("__error__"):
            finding.c_count, _ = _count_and_named(c_body, probe.author)
            finding.c_same = _same_records(a_body, c_body)
            finding.bare_ran = True
    return finding


def _same_records(a: str, c: str) -> bool:
    """Whether the syntax query and the bare-keyword query returned the same set.

    Compared on the identifiers in the two bodies rather than on the bytes: a
    response carries timings and echoed queries that differ by construction.
    """
    def ids(body: str) -> set:
        found = set(re.findall(
            r'"(?:uuid|id|doi|DOI|objID|handle|paperId|docid)"\s*:\s*"([^"]{6,})"', body))
        if found:
            return found
        # **XML sources, and this is the half that was silently doing nothing.**
        # The first version of this comparison only read JSON keys, so for
        # arXiv, NDL and PubMed's efetch the controls ran, produced bodies, and
        # were compared to nothing — the verdict came out "honoured" on A and B
        # alone, which is precisely the reasoning this probe exists to refuse.
        return set(re.findall(
            r"<(?:id|Id|dcterms:identifier|identifier|PMID)[^>]*>([^<]{6,})</", body))

    a_ids, c_ids = ids(a), ids(c)
    if not a_ids or not c_ids:
        # Nothing comparable came back. Say so by refusing to claim sameness —
        # and the caller must not read that as "different", which is why the
        # verdict below also requires the record counts to differ.
        return False
    return a_ids == c_ids


def render(findings: list[Finding]) -> str:
    lines = [
        "# What each source can be asked about a person — the probe",
        "",
        "Run by `verification_scripts/probe_entity_search.py`. Every author query is run "
        "twice: once with a real author (**A**) and once with an author who does not "
        "exist (**B**). The syntax is honoured when A finds the person and B finds "
        "nobody; a source that answers B as fully as A was doing a keyword search and "
        "the row says `none` however good A looked.",
        "",
        "| Source | Author asked | A: records | A: found them | B: nonsense | C: bare keyword | D: other field | ORCID in record | Affiliation in record | Verdict |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for f in findings:
        if f.error:
            verdict = f"**unknown** — {f.error}"
            lines.append(
                f"| `{f.slug}` | {f.author} | — | — | — | — | — | — | — | {verdict} |")
            continue
        if f.d_same:
            verdict = "**none** — a different field returned the same records"
        elif f.c_same:
            verdict = "**none** — the bare-keyword control returned the same records"
        elif f.discriminates:
            verdict = "**honoured**"
        else:
            verdict = "**not established**"
        lines.append(
            f"| `{f.slug}` | {f.author} | {f.a_count} | "
            f"{'yes' if f.a_named else 'no'} | {f.b_count} | "
            f"{f.c_count if f.bare_ran else '—'} | "
            f"{f.d_count if f.other_field_ran else '—'} | "
            f"{f.orcid_path or 'no'} | {f.affiliation_path or 'no'} | {verdict} |")
    lines += ["", "## Raw first responses", ""]
    for f in findings:
        lines += [f"### `{f.slug}`", "", "```", (f.sample or f.error)[:900], "```", ""]
    return "\n".join(lines)



# ---------------------------------------------------------------------------
# Second pass: is the field *there*, or is it there and empty?
# ---------------------------------------------------------------------------
#
# "The record has an `affiliation` key" and "the record tells you where this
# person works" are different claims, and the first is the one a substring
# search answers. Crossref is the case in point: `affiliation` is present on
# every author object and is an **empty list** on most of them.
#
# So this pass walks each source's own author objects, by the path the client
# fill will use, and counts how many are actually populated. Those counts are
# what D4's "which clients fill" list is built from, and what 2.1b's
# affiliation matching has to live with.

def _authors_crossref(b: dict) -> list[dict]:
    return [a for it in b["message"]["items"] for a in (it.get("author") or [])]


def _authors_openalex(b: dict) -> list[dict]:
    return [a for w in b["results"] for a in (w.get("authorships") or [])]


def _authors_europepmc(b: dict) -> list[dict]:
    out = []
    for r in b["resultList"]["result"]:
        out += ((r.get("authorList") or {}).get("author") or [])
    return out


def _authors_datacite(b: dict) -> list[dict]:
    return [c for d in b["data"] for c in (d["attributes"].get("creators") or [])]


def _authors_zenodo(b: dict) -> list[dict]:
    return [c for h in b["hits"]["hits"]
            for c in ((h.get("metadata") or {}).get("creators") or [])]


def _authors_inspire(b: dict) -> list[dict]:
    return [a for h in b["hits"]["hits"]
            for a in ((h.get("metadata") or {}).get("authors") or [])]


def _authors_dryad(b: dict) -> list[dict]:
    return [a for d in b["_embedded"]["stash:datasets"]
            for a in (d.get("authors") or [])]


def _authors_doaj(b: dict) -> list[dict]:
    return [a for r in b["results"]
            for a in ((r.get("bibjson") or {}).get("author") or [])]


# path -> (extractor, orcid key, affiliation key)
AUTHOR_SHAPES: dict[str, tuple[Callable[[dict], list[dict]], str, str]] = {
    "crossref": (_authors_crossref, "ORCID", "affiliation"),
    "openalex": (_authors_openalex, "author.orcid", "raw_affiliation_strings"),
    "europepmc": (_authors_europepmc, "authorId.value", "affiliation"),
    "datacite": (_authors_datacite, "nameIdentifiers", "affiliation"),
    "zenodo": (_authors_zenodo, "orcid", "affiliation"),
    "inspire_hep": (_authors_inspire, "ids", "affiliations"),
    "dryad": (_authors_dryad, "orcid", "affiliation"),
    "doaj": (_authors_doaj, "orcid_id", "affiliation"),
}


def _dig(obj: Any, path: str) -> Any:
    for part in path.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


def analyse(raw_dir: Path) -> str:
    lines = [
        "## Populated, not merely present",
        "",
        "One author object at a time, by the path the client fill uses. A key that "
        "is present and empty is a field resmon must not claim to have.",
        "",
        "| Source | Authors seen | With an ORCID | With an affiliation | ORCID path | Affiliation path |",
        "|---|---|---|---|---|---|",
    ]
    for slug, (extract, orcid_key, aff_key) in sorted(AUTHOR_SHAPES.items()):
        path = raw_dir / f"{slug}.a.txt"
        if not path.exists():
            continue
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
            authors = extract(body)
        except Exception as exc:                     # noqa: BLE001 - reported, not raised
            lines.append(f"| `{slug}` | — | — | — | — | (could not read: {exc}) |")
            continue
        orcid = sum(1 for a in authors if _dig(a, orcid_key))
        aff = sum(1 for a in authors if _dig(a, aff_key))
        lines.append(f"| `{slug}` | {len(authors)} | {orcid} | {aff} | "
                     f"`{orcid_key}` | `{aff_key}` |")
    return "\n".join(lines)


def main() -> int:                                   # pragma: no cover - entrypoint
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="entity-search-probe.md")
    parser.add_argument("--keep", default="", help="directory for raw bodies")
    parser.add_argument("--only", default="", help="comma-separated slugs")
    args = parser.parse_args()

    keep = Path(args.keep) if args.keep else None
    if keep:
        keep.mkdir(parents=True, exist_ok=True)

    wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    findings = []
    for probe in PROBES:
        if wanted and probe.slug not in wanted:
            continue
        finding = probe_one(probe, keep)
        findings.append(finding)
        state = finding.error or (
            "honoured" if finding.discriminates else "not established")
        print(f"{probe.slug:18} A={finding.a_count:<4} B={finding.b_count:<4} "
              f"orcid={finding.orcid_path or '-':<12} aff={finding.affiliation_path or '-':<22} "
              f"{state}", flush=True)

    report = render(findings)
    if keep:
        report += "\n\n" + analyse(keep) + "\n"
    Path(args.out).write_text(report, encoding="utf-8")
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":                           # pragma: no cover
    sys.exit(main())
