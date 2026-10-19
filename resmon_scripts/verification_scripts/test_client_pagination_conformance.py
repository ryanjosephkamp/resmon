"""Asking for N records fetches N distinct records, and asks for the tail.

The third row of the connector conformance harness, and the one that would
have caught a shipped defect on the day the client was written. ``api_openalex``
and ``api_doaj`` both paginated by page *number* while shrinking the page
*size* on the final request. A page number is an offset over the page size, so
asking for 250 fetched page 1 at 200 per page and then page 2 at 50 -- records
51 to 100 a second time -- and records 201 to 250 were never requested at all.
Deduplication downstream collapsed the duplicates, so the only visible symptom
was a result set quietly short of what the user asked for.

``api_zenodo.py`` documents that exact hazard and pins its page size for it.
The other two never got the fix until a live run found them, one at a time, on
2026-10-18. Nine of the twenty-six client modules paginate by page number;
two were broken; nobody had checked the other seven. This row checks all of
them on every run, with its denominator read from
``api_registry.list_repositories()`` so a twenty-eighth source is covered on
the day it is registered.

**How a page is served.** Each client is driven against a transport that
serves an inexhaustible stream of distinct records, each carrying a marker
string unique to its index. The window a request asks for is read from the
request itself -- an offset parameter, a page number multiplied by the page
size *of that request*, or a cursor the transport itself issued -- so the
transport behaves the way a real paginated API behaves, including the part
where shrinking the page size moves the window backwards. The origin is taken
from the client's **first** request rather than assumed, so a zero-based and a
one-based page number are both handled without this file guessing which a
source uses.

Two things are then asserted: every marker comes back at most once, and
exactly ``max_results`` of them come back. The first catches a window that
moved backwards; the second catches a tail that was never requested. Either
one alone would have missed the OpenAlex defect under some downstream
behavior, which is why both are here.

**The body shapes are per source and that is deliberate.** ``_PAGE_SHAPES``
holds one entry per slug: the container the client reads its records out of,
the field it reads a title from, and whatever else that client requires before
it will keep a record. There is no way to avoid this -- a conformance harness
that only drove sources whose replies all look alike would be testing the
sources that were never the problem. A slug with no entry is **not silently
skipped**: ``test_every_registered_slug_is_either_served_or_excluded`` fails
unless it is named in ``_NOT_SERVED`` with a reason, so a new source cannot
join the registry and quietly sit outside this row.

**What this does not establish.** It is read in full at the bottom of this
file, in ``test_every_registered_slug_is_either_served_or_excluded``'s
docstring and in ``_NOT_SERVED``; the short version is that this row speaks
only for the slugs in ``_SERVED``, only through ``search()``, only against a
source that never runs out of records and never fails, and only about record
identity as the client's own normalizer reports it.
"""

from __future__ import annotations

import importlib
import json
import re
import sys
import time
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import api_base, api_registry, config  # noqa: E402

SLUGS = api_registry.list_repositories()

_MODULE_FOR_SLUG = {"medrxiv": "api_biorxiv"}

#: Handed to every client that asks for a credential, so that the four which
#: return before making a request can be driven at all. Deliberately not
#: key-shaped.
_PLACEHOLDER_CREDENTIAL = "conformance-harness-placeholder-not-a-key"

#: The stream the transport serves is effectively inexhaustible: the question
#: is what the client asks for, never what it runs out of.
_TOTAL = 100_000

#: Every record's title. The keyword is in it because ``api_biorxiv`` has no
#: keyword search and filters client-side on the query string, so a title that
#: does not contain the query is dropped before this row can count it.
def _marker(index: int) -> str:
    return f"machine learning RESMON-CONFORMANCE-{index:06d}"


_MARKER_RE = re.compile(r"RESMON-CONFORMANCE-(\d{6})")


def _module_for(slug: str):
    return importlib.import_module(
        f"implementation_scripts.{_MODULE_FOR_SLUG.get(slug, 'api_' + slug)}")


# ---------------------------------------------------------------------------
# Reading the window a request asks for
# ---------------------------------------------------------------------------

#: Parameter names that carry a **record offset**. Checked before the page
#: names, because no client in this repository sends both and a client that
#: did would be ambiguous and belongs in ``_NOT_SERVED`` rather than guessed
#: at. ``s`` is Springer's offset and ``f`` is DBLP's.
_OFFSET_PARAMS = ("offset", "start", "startRecord", "skip", "f", "s", "retstart")

#: Parameter names that carry a **page number**, which is an offset over the
#: page size of the same request. This is the family the defect lived in.
_PAGE_PARAMS = ("page", "page[number]")

#: Parameter names that carry a **page size**.
_SIZE_PARAMS = ("limit", "rows", "size", "page[size]", "per-page", "per_page",
                "pageSize", "h", "p", "max_results", "maximumRecords", "retmax")


def _int(value) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


class _Window:
    """What one request asked for, and how the transport decided that.

    ``origin`` is the value of the paging parameter in the client's *first*
    request. Anchoring on it rather than on 0 or 1 means this file never has
    to know whether a source numbers its pages from zero, and a client that
    starts somewhere else entirely is still served its own first page first.
    """

    def __init__(self) -> None:
        self.origin: int | None = None
        self.scheme: str | None = None

    def read(self, params: dict) -> tuple[int, int] | None:
        size = next((_int(params[name]) for name in _SIZE_PARAMS
                     if name in params and _int(params[name]) is not None), None)
        if size is None or size <= 0:
            return None

        for name in _OFFSET_PARAMS:
            if name in params and _int(params[name]) is not None:
                value = _int(params[name])
                if self.origin is None:
                    self.origin, self.scheme = value, f"offset:{name}"
                return value - self.origin, size

        for name in _PAGE_PARAMS:
            if name in params and _int(params[name]) is not None:
                value = _int(params[name])
                if self.origin is None:
                    self.origin, self.scheme = value, f"page:{name}"
                # The page size of *this* request, which is exactly why
                # shrinking it on the last page moves the window backwards.
                return (value - self.origin) * size, size

        return None


# ---------------------------------------------------------------------------
# The page shapes, one per source
# ---------------------------------------------------------------------------

def _wrap(path: tuple[str, ...], records: list, extra: dict | None = None) -> dict:
    """A JSON body with ``records`` at ``path`` and ``extra`` merged at the root."""
    node: object = records
    for key in reversed(path[1:]):
        node = {key: node}
    body = {path[0]: node}
    body.update(extra or {})
    return body


def _atom(markers: list[str]) -> bytes:
    entries = "".join(
        f'<entry><id>http://arxiv.org/abs/{i}</id><title>{m}</title>'
        f'<summary>abstract</summary><published>2024-05-01T00:00:00Z</published>'
        f'<author><name>A Researcher</name></author></entry>'
        for i, m in enumerate(markers))
    return (f'<?xml version="1.0" encoding="UTF-8"?>'
            f'<feed xmlns="http://www.w3.org/2005/Atom">{entries}</feed>').encode()


def _pubmed_xml(markers: list[str]) -> bytes:
    articles = "".join(
        f"<PubmedArticle><MedlineCitation><PMID>{i}</PMID><Article>"
        f"<ArticleTitle>{m}</ArticleTitle>"
        f"<Abstract><AbstractText>abstract</AbstractText></Abstract>"
        f"</Article></MedlineCitation>"
        f"<PubmedData><History><PubMedPubDate PubStatus='pubmed'>"
        f"<Year>2024</Year><Month>5</Month><Day>1</Day>"
        f"</PubMedPubDate></History></PubmedData></PubmedArticle>"
        for i, m in enumerate(markers))
    return f"<PubmedArticleSet>{articles}</PubmedArticleSet>".encode()


#: One entry per served slug: how to build a page of ``n`` records starting at
#: ``start``. Each builder returns ``bytes``. They are small on purpose -- only
#: the fields the client needs before it will keep a record, which is almost
#: always a title and an identifier.
_PAGE_SHAPES = {
    "arxiv": lambda s, n: _atom([_marker(s + i) for i in range(n)]),
    "biorxiv": lambda s, n: json.dumps({
        "messages": [{"status": "ok", "total": _TOTAL}],
        "collection": [{"title": _marker(s + i), "doi": f"10.1101/{s + i}",
                        "date": "2024-05-01", "authors": "A Researcher",
                        "abstract": "abstract", "category": "biology"}
                       for i in range(n)]}).encode(),
    "medrxiv": lambda s, n: json.dumps({
        "messages": [{"status": "ok", "total": _TOTAL}],
        "collection": [{"title": _marker(s + i), "doi": f"10.1101/{s + i}",
                        "date": "2024-05-01", "authors": "A Researcher",
                        "abstract": "abstract", "category": "health"}
                       for i in range(n)]}).encode(),
    "core": lambda s, n: json.dumps(_wrap(
        ("results",), [{"title": _marker(s + i), "id": s + i,
                        "publishedDate": "2024-05-01"} for i in range(n)],
        {"totalHits": _TOTAL})).encode(),
    "crossref": lambda s, n: json.dumps(_wrap(
        ("message", "items"), [{"title": [_marker(s + i)],
                                "DOI": f"10.1/{s + i}", "URL": "https://x"}
                               for i in range(n)],
        {})).encode(),
    "datacite": lambda s, n: json.dumps(_wrap(
        ("data",), [{"id": f"10.5/{s + i}",
                     "attributes": {"doi": f"10.5/{s + i}",
                                    "titles": [{"title": _marker(s + i)}],
                                    "publicationYear": 2024}}
                    for i in range(n)],
        {"meta": {"total": _TOTAL, "totalPages": 10_000}})).encode(),
    # DBLP refuses a page with no ``@total``, and says so as a parse failure.
    "dblp": lambda s, n: json.dumps({"result": {"hits": {
        "@total": str(_TOTAL),
        "hit": [{"info": {"title": _marker(s + i), "key": f"conf/x/{s + i}",
                          "year": "2024", "url": "https://dblp.org/x"}}
                for i in range(n)]}}}).encode(),
    "doaj": lambda s, n: json.dumps(_wrap(
        ("results",), [{"id": f"doaj-{s + i}",
                        "bibjson": {"title": _marker(s + i), "year": "2024"}}
                       for i in range(n)],
        {"total": _TOTAL})).encode(),
    "dryad": lambda s, n: json.dumps(_wrap(
        ("_embedded", "stash:datasets"),
        [{"identifier": f"doi:10.5061/dryad.{s + i}", "title": _marker(s + i),
          "publicationDate": "2024-05-01"} for i in range(n)],
        {"total": _TOTAL})).encode(),
    "eric": lambda s, n: json.dumps(_wrap(
        ("response", "docs"),
        [{"id": f"EJ{s + i}", "title": _marker(s + i),
          "publicationdateyear": 2024} for i in range(n)],
        {})).encode(),
    "europepmc": lambda s, n: json.dumps(_wrap(
        ("resultList", "result"),
        [{"id": str(s + i), "source": "MED", "title": _marker(s + i),
          "firstPublicationDate": "2024-05-01"} for i in range(n)],
        {"nextCursorMark": f"cursor-{s + n}", "hitCount": _TOTAL})).encode(),
    "govinfo": lambda s, n: json.dumps(_wrap(
        ("results",), [{"packageId": f"PKG-{s + i}", "title": _marker(s + i),
                        "dateIssued": "2024-05-01"} for i in range(n)],
        {"count": _TOTAL, "offsetMark": f"cursor-{s + n}"})).encode(),
    "hal": lambda s, n: json.dumps(_wrap(
        ("response", "docs"),
        [{"docid": s + i, "halId_s": f"hal-{s + i}", "title_s": _marker(s + i),
          "uri_s": "https://hal.science/x", "producedDateY_i": 2024}
         for i in range(n)],
        {})).encode(),
    "inspire_hep": lambda s, n: json.dumps(_wrap(
        ("hits", "hits"),
        [{"metadata": {"control_number": s + i,
                       "titles": [{"title": _marker(s + i)}],
                       "earliest_date": "2024-05-01"}} for i in range(n)],
        {})).encode(),
    # Solr's ``numFound`` sits beside ``docs`` inside ``response``; NASA ADS
    # stops as soon as ``start`` reaches it, so an absent one ends the search
    # after one page.
    "nasa_ads": lambda s, n: json.dumps({"response": {
        "numFound": _TOTAL,
        "docs": [{"bibcode": f"2024A&A...{s + i}", "title": [_marker(s + i)],
                  "pubdate": "2024-05-00"} for i in range(n)]}}).encode(),
    "nist_rmm": lambda s, n: json.dumps(_wrap(
        ("ResultData",), [{"ediid": f"nist-{s + i}", "title": _marker(s + i),
                           "publication_date": "2024-05-01",
                           "url": "https://data.nist.gov/x"}
                          for i in range(n)],
        {"ResultCount": _TOTAL})).encode(),
    # OAPEN's parser drops any record without a handle matching its pattern,
    # ``type == "item"`` and an explicit non-withdrawn flag. The reply is a
    # bare JSON array, not an object.
    "oapen": lambda s, n: json.dumps(
        [{"handle": f"20.500.12657/{s + i}", "name": _marker(s + i),
          "type": "item", "withdrawn": False,
          "metadata": [{"key": "dc.date.issued", "value": "2024"}]}
         for i in range(n)]).encode(),
    "openalex": lambda s, n: json.dumps(_wrap(
        ("results",), [{"id": f"https://openalex.org/W{s + i}",
                        "display_name": _marker(s + i),
                        "publication_date": "2024-05-01"} for i in range(n)],
        {"meta": {"count": _TOTAL}})).encode(),
    "openlibrary": lambda s, n: json.dumps(_wrap(
        ("docs",), [{"key": f"/works/OL{s + i}W", "title": _marker(s + i),
                     "first_publish_year": 2024} for i in range(n)],
        {"numFound": _TOTAL})).encode(),
    "osti": lambda s, n: json.dumps(
        [{"osti_id": str(s + i), "title": _marker(s + i),
          "publication_date": "2024-05-01"} for i in range(n)]).encode(),
    "plos": lambda s, n: json.dumps(_wrap(
        ("response", "docs"),
        [{"id": f"10.1371/{s + i}", "title": _marker(s + i),
          "publication_date": "2024-05-01T00:00:00Z"} for i in range(n)],
        {})).encode(),
    "semantic_scholar": lambda s, n: json.dumps(_wrap(
        ("data",), [{"paperId": f"s2-{s + i}", "title": _marker(s + i),
                     "year": 2024} for i in range(n)],
        {"total": _TOTAL})).encode(),
    "springer": lambda s, n: json.dumps(_wrap(
        ("records",), [{"doi": f"10.1007/{s + i}", "title": _marker(s + i),
                        "publicationDate": "2024-05-01"} for i in range(n)],
        {"result": [{"total": str(_TOTAL)}]})).encode(),
    "zenodo": lambda s, n: json.dumps(_wrap(
        ("hits", "hits"),
        [{"id": s + i, "doi": f"10.5281/zenodo.{s + i}",
          "metadata": {"title": _marker(s + i),
                       "publication_date": "2024-05-01"}} for i in range(n)],
        {"hits_total_placeholder": 0})).encode(),
}

#: Response headers a client needs before it will ask for another page.
#: ``api_osti`` pages on the presence of a ``Link: …; rel="next"`` header and
#: nothing else, so a transport that sends no headers stops it after one page
#: -- which is the client behaving correctly and the fixture being wrong.
_PAGE_HEADERS = {
    "osti": {"Link": '<https://www.osti.gov/api/v1/records?page=2>; rel="next"'},
}

#: Slugs this row does not drive, each with the reason. Nothing is skipped
#: silently: ``test_every_registered_slug_is_either_served_or_excluded``
#: requires every registered slug to be in ``_PAGE_SHAPES`` or in here.
_NOT_SERVED = {
    "ndl_search": (
        "api_ndl_search issues one SRU request with startRecord hard-coded to "
        "1 and maximumRecords capped at the module's _MAX_RECORDS. It has no "
        "second page at all, so 'asks for the tail' is not a property it can "
        "have, and asserting it would be asserting that the source should be "
        "rewritten. Recorded here rather than fixed: a source that cannot be "
        "paged is a capability question for the owner, not a defect."),
    "openaire": (
        "OpenAIRE's reply nests every scalar in a one-key '$' object inside "
        "repeated single-element lists. Synthesizing it faithfully enough to "
        "be evidence was judged a larger job than this change had room for, "
        "and a fixture that got the nesting subtly wrong would report a "
        "pagination defect that is really a fixture bug. It paginates by page "
        "number with a fixed size, so it is in the family this row exists "
        "for, and it is the first gap worth closing."),
    "pubmed": (
        "PubMed does not paginate: esearch returns up to retmax identifiers "
        "in one request and efetch then fetches them in batches of 200 by "
        "identifier, so there is no window to move. Its batch loop is already "
        "under test -- that is the lost-batch defect "
        "test_client_failure_conformance.py was written for."),
}


# ---------------------------------------------------------------------------
# Driving one client
# ---------------------------------------------------------------------------

class _RecordServer:
    """Serves an inexhaustible stream of distinct records, window by window.

    A request whose window cannot be read gets an empty page rather than a
    guess, and the fact is recorded in ``unreadable`` so a client whose paging
    scheme this file does not understand shows up as an exclusion instead of
    as a passing case.
    """

    def __init__(self, slug: str) -> None:
        self.slug = slug
        self.build = _PAGE_SHAPES[slug]
        self.window = _Window()
        self.requests: list[dict] = []
        self.unreadable = 0
        self._cursor_next: dict[str, int] = {}

    def _start_and_size(self, url: str, params: dict, body) -> tuple[int, int] | None:
        # A cursor the transport itself issued. Both clients that use one --
        # europepmc's ``cursorMark`` and govinfo's ``offsetMark`` -- echo back
        # the exact string from the previous page, so the index is read out of
        # the token rather than inferred.
        for key in ("cursorMark", "offsetMark"):
            token = params.get(key) if key in params else (body or {}).get(key)
            if token is not None:
                size = next((_int(params.get(n)) or _int((body or {}).get(n))
                             for n in _SIZE_PARAMS
                             if params.get(n) is not None or (body or {}).get(n) is not None),
                            None)
                if not size:
                    return None
                match = re.fullmatch(r"cursor-(\d+)", str(token))
                return (int(match.group(1)) if match else 0), size

        # bioRxiv pages by a cursor in the **path**, not in a parameter.
        if self.slug in ("biorxiv", "medrxiv"):
            tail = url.rstrip("/").rsplit("/", 1)[-1]
            cursor = _int(tail)
            if cursor is None:
                return None
            return cursor, 30  # the documented /details page size

        merged = dict(params)
        merged.update(body or {})
        return self.window.read(merged)

    def respond(self, method: str, url: str, **kwargs) -> httpx.Response:
        params = {str(k): v for k, v in (kwargs.get("params") or {}).items()}
        body = kwargs.get("json") if isinstance(kwargs.get("json"), dict) else None
        self.requests.append({"url": str(url).split("?")[0], "params": params})

        window = self._start_and_size(str(url), params, body)
        if window is None:
            self.unreadable += 1
            content = self.build(0, 0)
        else:
            start, size = window
            # A negative start is what a page window that moved backwards past
            # the beginning would ask for; serve nothing rather than pretend.
            content = self.build(max(start, 0), max(min(size, 500), 0))
        return httpx.Response(200, content=content,
                              headers=_PAGE_HEADERS.get(self.slug),
                              request=httpx.Request(method, str(url)))


@pytest.fixture(autouse=True)
def quick_and_isolated(monkeypatch):
    """No limiter waits, no retries, no sleeping. See the sibling files."""
    api_base.reset_search_outcome()
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    yield
    api_base.reset_search_outcome()


def _drive(slug: str, max_results: int, monkeypatch) -> tuple[list[str], _RecordServer]:
    module = _module_for(slug)
    for name in dir(module):
        if name.endswith("RATE_LIMITER"):
            monkeypatch.setattr(module, name, api_base.RateLimiter(10_000))
    if hasattr(module, "get_credential_for"):
        monkeypatch.setattr(module, "get_credential_for",
                            lambda _exec_id, _name: _PLACEHOLDER_CREDENTIAL)

    server = _RecordServer(slug)

    def respond(_self, method, url, **kwargs):
        return server.respond(method, url, **kwargs)

    async def respond_async(_self, method, url, **kwargs):
        return server.respond(method, url, **kwargs)

    monkeypatch.setattr(httpx.Client, "request", respond)
    monkeypatch.setattr(httpx.AsyncClient, "request", respond_async)

    api_base.reset_search_outcome()
    results = api_registry.get_client(slug).search(
        "machine learning", "2024-01-01", "2024-12-31", max_results)
    # Identity comes from the marker the transport minted, read back out of
    # whatever field the client's own normalizer put it in. Matching on the
    # marker rather than on the whole title means a client that decorates or
    # trims the title is still measured on which record it returned.
    markers = []
    for record in results:
        match = _MARKER_RE.search(record.title or "")
        markers.append(match.group(1) if match else f"?{record.title!r}")
    return markers, server


_SERVED = sorted(_PAGE_SHAPES)


@pytest.mark.parametrize("max_results", [150, 250, 500])
@pytest.mark.parametrize("slug", _SERVED)
def test_max_results_fetches_each_record_exactly_once(slug, max_results, monkeypatch):
    """No record twice, and ``max_results`` of them.

    250 is the size the OpenAlex defect was found at -- a first page of 200
    and a second page that should be 50 records further on. 150 and 500 are
    there because a defect that only shows up when the shortfall is smaller
    than one page, or only after three pages, is the same defect.
    """
    markers, server = _drive(slug, max_results, monkeypatch)

    assert server.unreadable == 0, (
        f"{slug} sent {server.unreadable} request(s) whose paging window this "
        f"file could not read, so it was served an empty page and the result "
        f"below means nothing. Either the scheme is new -- add it to "
        f"_OFFSET_PARAMS/_PAGE_PARAMS -- or the slug belongs in _NOT_SERVED "
        f"with a reason. Requests: {server.requests[:3]}")

    duplicates = sorted({m for m in markers if markers.count(m) > 1})
    assert not duplicates, (
        f"{slug} returned {len(duplicates)} record(s) more than once when "
        f"asked for {max_results}. A page window that moves backwards is how "
        f"this happens -- shrinking the page size while paginating by page "
        f"number re-fetches records already held and never asks for the tail. "
        f"First few: {duplicates[:5]}. Windows requested: "
        f"{[r['params'] for r in server.requests][:6]}")

    assert len(markers) == max_results, (
        f"{slug} was asked for {max_results} records from a source holding "
        f"{_TOTAL:,} and returned {len(markers)}. The tail was never "
        f"requested. Windows: {[r['params'] for r in server.requests][:6]}")


def test_every_registered_slug_is_either_served_or_excluded():
    """The denominator, and every exclusion with its reason beside it.

    This is the assertion that keeps the row honest. ``_PAGE_SHAPES`` is a
    hand-written table and a hand-written table goes stale: without this, a
    twenty-eighth source would join the registry, have no page shape, be
    driven by nothing, and this file would still report every test passing.

    **What this row does not establish, in full.**

    * It speaks for the slugs in ``_PAGE_SHAPES`` and for no others. The three
      in ``_NOT_SERVED`` carry their reasons above; ``openaire`` is in the
      page-number family this row exists for and is the gap worth closing
      first.
    * The transport never fails and never runs out. A client that handles the
      tail correctly against a full stream and mishandles a short final page,
      or a page that 503s halfway through, is not measured here --
      ``test_client_failure_conformance.py`` covers the second.
    * Only ``search()`` is driven. ``search_entity()`` reaches a different
      paging loop in ``api_dblp`` (SPARQL, paged by distinct publication IRI)
      and a different parameter set in several others.
    * Identity is the marker the transport minted, recovered from the title
      the client's normalizer produced. A client that returns the right number
      of distinct titles while corrupting every other field passes this.
    * The page shapes are the minimum each client needs to keep a record. A
      real reply carries far more, and a client that mis-handles a field this
      fixture omits is invisible here.
    * The windows are served from the request, so this measures what each
      client **asked for**. It cannot tell you that a real provider interprets
      that request the same way; that is what the weekly live suite is for.
    """
    assert SLUGS == api_registry.list_repositories()
    assert len(SLUGS) >= 27, "the registry shrank; a source was retired silently"

    unaccounted = set(SLUGS) - set(_PAGE_SHAPES) - set(_NOT_SERVED)
    assert not unaccounted, (
        f"these registered slugs have no page shape and no recorded reason "
        f"for being left out: {sorted(unaccounted)}. Add an entry to "
        f"_PAGE_SHAPES, or a sentence to _NOT_SERVED saying what stopped you. "
        f"A source outside this row with nothing written down is how the "
        f"OpenAlex defect survived being written.")

    stale = (set(_PAGE_SHAPES) | set(_NOT_SERVED)) - set(SLUGS)
    assert not stale, f"these are named here and not registered: {sorted(stale)}"

    # Said out loud, with the denominator, because "every client paginates
    # correctly" is exactly the claim this project bans without one.
    assert len(_SERVED) == 24
    assert len(_NOT_SERVED) == 3
    assert len(_SERVED) + len(_NOT_SERVED) == len(SLUGS)


def test_the_paging_scheme_each_client_uses_is_recorded():
    """Which family each served client is in, derived by driving it.

    The page-number family is the one the defect lived in, and a client moving
    into or out of it is a change worth seeing in a diff. Derived from the
    requests the client actually makes, never from a module constant: the
    sibling file records what happens when an assertion like this is written
    against a name instead -- it missed ``api_inspire_hep`` entirely, because
    that client runs the shape under a different constant's name.
    """
    schemes: dict[str, str] = {}
    for slug in _SERVED:
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
            patch.setattr(time, "sleep", lambda _seconds: None)
            _markers, server = _drive(slug, 250, patch)
        schemes[slug] = server.window.scheme or "cursor-or-path"

    by_page = {slug for slug, scheme in schemes.items() if scheme.startswith("page:")}
    assert by_page == {
        "datacite", "doaj", "dryad", "inspire_hep", "openalex", "openlibrary",
        "osti", "zenodo",
    }, (f"the set of clients paginating by page number changed: "
        f"{sorted(by_page)}. This is the family that carried the 2026-10-18 "
        f"defect; a client joining it needs its page size held fixed for the "
        f"whole search, and a client leaving it should say why in its diff.")
