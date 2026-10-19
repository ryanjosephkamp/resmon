"""Records already in hand survive a later page that cannot be read.

The fourth row of the connector conformance harness, and the one that puts a
number on a consequence the other three could only reason about.
``test_client_outcome_conformance.py`` drives every request of a search into
the same failure, so it can say what a client *records* about an unreadable
HTTP 200 and nothing at all about what a client *keeps*. Its own "what this
does not establish" names the gap and names the suspicion:

    It is not academic: the clients in ``_RAISES_ON_UNREADABLE_BODY`` throw
    away everything they hold when a later page cannot be read, because the
    exception leaves ``search()``. That consequence is read off the control
    flow here, not measured.

The measurement found something worse than discarded records, and it is the
reason this row reads the outcome channel directly rather than through the
sweep engine. At the instant the exception left ``search()``, nothing had
been written to the channel, so ``zero_reason.derive`` returned
**``answered_empty``** -- "the source answered and had nothing" -- for every
one of the nine. The user was spared that sentence only because the sweep
engine's catch-all sees an exception before it ever reads the channel. That
is a coincidence of the engine's control flow, not a guarantee: any caller
that swallows the exception and asks the channel what happened is handed a
broken monitor wearing a quiet field's clothes, which is the one failure
this product exists to prevent. So the fix had to leave the channel correct
on its own, and assertion 3 below is what holds it correct: it calls
``zero_reason.derive`` exactly as the engine would, with no engine in the
picture.

Each client is served **one good page** of records it can parse, and then a
body nothing can read. Three things are then asserted, in the order a user
would care about them:

1. ``search()`` returns rather than raising, which the client contract in
   ``AGENTS.md`` requires of every client on every upstream failure;
2. every record from the page that *was* readable comes back;
3. the recorded reason is ``parse_failure``, so the sweep engine's partial
   note can say which page the retained set ends at.

Assertion 2 is the one that needed a fixture. A client that lets
``json.JSONDecodeError`` out of ``search()`` loses the whole first page with
it -- the exception unwinds the frame that holds ``results``, and the sweep
engine's catch-all sees an exception, not a short list. The failure message
below prints how many records the transport had already delivered when the
client dropped them, because "the earlier page is lost" and "the earlier page
is lost, and it was 100 records" are different sentences and only the second
one is evidence.

**The page shapes are not written here.** ``_PAGE_SHAPES`` and the unreadable
bodies are imported from the two sibling rows, so a body shape has one
definition in the harness and the rows cannot drift into disagreeing about
what a given source's reply looks like. That import is also the reason this
file's denominator is smaller than theirs: it drives the nine clients that
paginate *and* have a served page shape, named in ``_PARTIAL_PAGE_SLUGS``.

**What this does not establish.** The first page is synthesized from what the
client's own parser requires, not captured from the provider, so it proves
the client keeps records it accepted -- not that a real reply would have been
accepted. Only ``search()`` is driven, never ``search_entity()``. Only the
second page fails; a client that reads page one, page two and then fails on
page three is the same control flow and is not separately driven. The sweep
engine is not in this file: that retained records plus ``parse_failure``
render as a partial note rather than a silent truncation is
``sweep_engine``'s property and is asserted in ``test_engine_truth.py``. The
eighteen registered slugs this row does not drive are listed, with a reason
each, in ``_NOT_DRIVEN``, and the two lists are checked against the registry
by ``test_the_partial_page_denominator_is_named``.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import (  # noqa: E402
    api_base,
    api_registry,
    config,
    zero_reason,
)
from test_client_outcome_conformance import (  # noqa: E402
    _UNREADABLE_BODIES,
    _module_for,
    _prepare,
)
from test_client_pagination_conformance import (  # noqa: E402
    _PAGE_SHAPES,
    _SIZE_PARAMS,
    _int,
)

SLUGS = api_registry.list_repositories()

#: Asked of every client, and deliberately larger than any client's own page
#: size cap -- 50 for Springer, 100 for most, 1000 for Europe PMC. A request
#: for fewer records than one page holds is answered in one page, and a search
#: that only ever made one request cannot lose an earlier one.
_MAX_RESULTS = 2000

#: The clients driven here: they paginate, and the harness already knows how
#: to build a page they will parse. Every other registered slug is in
#: ``_NOT_DRIVEN`` with the reason.
_PARTIAL_PAGE_SLUGS = (
    "core",
    "crossref",
    "doaj",
    "europepmc",
    "nasa_ads",
    "openalex",
    "plos",
    "semantic_scholar",
    "springer",
)

#: Why each remaining slug is not driven. Nothing is skipped silently.
_NOT_DRIVEN = {
    "pubmed": (
        "PubMed does not paginate. esearch makes one request for identifiers "
        "and efetch then fetches them in batches by identifier, so there is "
        "no earlier page to lose; the unreadable reply it is vulnerable to is "
        "esearch's, which is the search's first request. Covered by "
        "test_client_outcome_conformance.py's row 2, not by this one."),
    "ndl_search": (
        "One SRU request with startRecord hard-coded to 1; no second page. "
        "The same exclusion test_client_pagination_conformance.py records."),
    "openaire": (
        "No page shape in the harness: OpenAIRE nests every scalar in a "
        "one-key '$' object inside repeated single-element lists, and the "
        "sibling row judged synthesizing it faithfully a larger job than it "
        "had room for. Inherited here rather than re-litigated."),
    "osti": (
        "Pages on a Link: rel=\"next\" header rather than on anything in the "
        "body. It is drivable -- _PAGE_HEADERS in the sibling row shows how "
        "-- and it is not in the defect set this file was opened for, so it "
        "is left for whoever widens this row rather than added untested."),
    "arxiv": "Atom, and not in the defect set: parses inside its try block.",
    "biorxiv": "Not in the defect set: reads its reply through a guarded helper.",
    "medrxiv": "Same client as biorxiv.",
    "datacite": "Not in the defect set.",
    "dblp": "Not in the defect set: _request_payload is the pattern this fix copied.",
    "dryad": "Not in the defect set.",
    "eric": "Not in the defect set.",
    "govinfo": "Not in the defect set.",
    "hal": "Not in the defect set.",
    "inspire_hep": "Not in the defect set.",
    "nist_rmm": "Not in the defect set.",
    "oapen": "Not in the defect set.",
    "openlibrary": "Not in the defect set.",
    "zenodo": "Not in the defect set.",
}


#: The ten clients this PR repaired: the nine above plus ``pubmed``, which
#: does not paginate and so cannot be driven by the partial-page row.
_DEFECT_SET_SLUGS = _PARTIAL_PAGE_SLUGS + ("pubmed",)

#: Bodies that **decode** as JSON and then carry no object at the root.
#:
#: These are not in ``test_client_outcome_conformance``'s ``_UNREADABLE_BODIES``,
#: which holds bodies that fail to decode at all. They are a third category and
#: they are here because the repair that fixed the second one introduced a
#: defect in this one:
#:
#: * ``null`` decodes to Python ``None``, which is exactly what
#:   ``api_base.read_json_body`` returns to mean "I could not read this". A
#:   helper that returned the decoded value unchecked would hand every caller
#:   its own failure sentinel, the caller would stop, and **nothing would be
#:   recorded** -- which derives to ``answered_empty``, the one sentence this
#:   whole area exists to delete. Before the repair these ten raised
#:   ``AttributeError`` on this body, which is wrong but loud; silence is
#:   worse than a traceback, so the repair had to close this or it would have
#:   made one case worse than the bug it fixed.
#: * an array root and a string root decode to a ``list`` and a ``str``, and
#:   every one of the ten call sites immediately does ``data.get(...)``. All
#:   ten raised ``AttributeError`` out of ``search()`` on both, before this
#:   change and independently of it. ``read_json_body`` requiring a mapping
#:   closes them for nothing extra.
#:
#: Why a dict and not some looser test: the ten clients read their records out
#: of a named container, so a reply with no object at the root is one none of
#: them can use, whatever else it is. A source whose reply is legitimately a
#: bare array -- ``api_oapen`` and ``api_osti`` are the two -- does not use
#: this helper and is unaffected.
_DECODES_BUT_UNUSABLE = {
    "json-null": b"null",
    "json-array-root": b"[1, 2, 3]",
    "json-string-root": b'"hello"',
}


@pytest.fixture(autouse=True)
def quick_and_isolated(monkeypatch):
    """No retry ladder, no sleeping, a clean outcome channel either side.

    The same fixture the sibling rows use, and for the same reasons: the
    ladder would hide which attempt failed, and the first backoff is
    ``base ** 0`` -- 1.0 whatever the base -- so lowering the base does not
    shorten it.
    """
    api_base.reset_search_outcome()
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
    monkeypatch.setattr(config, "DEFAULT_BACKOFF_BASE", 0.01)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    yield
    api_base.reset_search_outcome()


class _OneGoodPageThenGarbage:
    """Serves a full first page, then a body no parser can read.

    The page is built at the size the request asked for, read out of the
    request's own parameters, so a client that asks for fifty records and a
    client that asks for a thousand each get a page that is *full* -- a short
    page is how most of these clients decide they have reached the end, and
    a fixture that served one would be measuring the wrong stop.

    ``delivered`` is the count of records handed over before the failure. It
    exists for the failure message: a client that raises loses exactly these,
    and saying how many turns a control-flow argument into a measurement.
    """

    def __init__(self, slug: str, bad_body: bytes) -> None:
        self.slug = slug
        self.bad_body = bad_body
        self.build = _PAGE_SHAPES[slug]
        self.requests = 0
        self.delivered = 0

    def respond(self, method: str, url: str, params: dict | None) -> httpx.Response:
        self.requests += 1
        request = httpx.Request(method, str(url))
        if self.requests > 1:
            return httpx.Response(200, content=self.bad_body, request=request)

        size = next(
            (_int((params or {}).get(name)) for name in _SIZE_PARAMS
             if _int((params or {}).get(name)) is not None),
            None)
        if size is None or size <= 0:
            # Not a guess: a client whose page size this harness cannot read
            # would be served an arbitrary page, and the record count it
            # returned would mean nothing. Fail loudly instead.
            raise AssertionError(
                f"{self.slug}: no page size found in the first request's "
                f"parameters {sorted((params or {}).keys())}; "
                f"_SIZE_PARAMS needs the name this client uses")
        self.delivered = size
        return httpx.Response(200, content=self.build(0, size), request=request)


def _install(monkeypatch, server: _OneGoodPageThenGarbage) -> None:
    """Both transports, because a client with a deadline uses the async one."""
    def respond(_self, method, url, **kwargs):
        return server.respond(method, url, kwargs.get("params"))

    async def respond_async(_self, method, url, **kwargs):
        return respond(_self, method, url, **kwargs)

    monkeypatch.setattr(httpx.Client, "request", respond)
    monkeypatch.setattr(httpx.AsyncClient, "request", respond_async)


@pytest.mark.parametrize("body_name", sorted(_UNREADABLE_BODIES))
@pytest.mark.parametrize("slug", _PARTIAL_PAGE_SLUGS)
def test_a_readable_page_survives_an_unreadable_one(slug, body_name, monkeypatch):
    """One good page, then garbage: the good page comes back, and so does a reason.

    This is the row that measures the cost. A client that reads page one into
    ``results`` and then lets a decoder error out of ``search()`` does not
    return a short list -- it returns nothing at all, because the exception
    unwinds the frame the list lives in, and the sweep engine's catch-all
    records the source as an error with no zero reason and renders the
    decoder's own message to the user.
    """
    module = _module_for(slug)
    _prepare(monkeypatch, module)
    server = _OneGoodPageThenGarbage(slug, _UNREADABLE_BODIES[body_name])
    _install(monkeypatch, server)

    api_base.reset_search_outcome()
    try:
        results = api_registry.get_client(slug).search(
            "machine learning", "2024-01-01", "2024-12-31", _MAX_RESULTS)
    except Exception as exc:
        pytest.fail(
            f"{slug} raised out of search() when page {server.requests} could "
            f"not be read ({body_name}): {type(exc).__name__}: {exc}. "
            f"{server.delivered} records had already been parsed out of page 1 "
            f"and are discarded with the frame -- the caller receives an "
            f"exception, not a short list, so the sweep engine cannot keep "
            f"what the source did manage to send. The client contract in "
            f"AGENTS.md requires search() to return [] on upstream failure, "
            f"logged, never raised.")

    assert server.requests >= 2, (
        f"{slug} stopped after {server.requests} request(s), so no later page "
        f"ever failed and this row measured nothing. The first page was full "
        f"at {server.delivered} records and the fixture's totals are "
        f"effectively inexhaustible, so a client stopping here is either a "
        f"paging scheme the fixture does not serve or a real early stop.")

    assert len(results) == server.delivered, (
        f"{slug} returned {len(results)} of the {server.delivered} records it "
        f"had already parsed out of page 1 before page 2 came back "
        f"unreadable. Records in hand are not discarded because a later page "
        f"failed: that is what the partial-result note exists to describe.")

    # Read off the channel, with no sweep engine in the picture, because the
    # engine's catch-all is what used to hide this: before the fix the
    # channel said ``answered_empty`` here -- measured on all nine -- and
    # only the engine seeing an exception first kept that out of the UI.
    reason, detail = _derived_reason()
    assert reason == "parse_failure", (
        f"{slug} kept its first page but the outcome channel derives to "
        f"{reason!r} for the page it could not read. If that is "
        f"'answered_empty', any caller that reads the channel is told the "
        f"source looked and had nothing, which is the lie the whole "
        f"zero-reason phase exists to forbid. If it is anything else, the "
        f"sweep engine has no terminal reason for its partial note and a "
        f"truncated set reads as a complete one. The user would be told: "
        f"{zero_reason.sentence(slug, reason, detail)!r}")

    # The point of keeping the records *and* the reason: together they render
    # the one sentence that says the set is short and why. Either alone does
    # not -- records with no reason read as a complete answer, and a reason
    # with no records reads as a source that sent nothing. ``answered`` is
    # correctly True here, because the source did answer; the truncation is
    # what this sentence is for, and the sweep engine persists it verbatim.
    assert zero_reason.answered("ok", len(results), reason) is True
    assert zero_reason.partial_sentence(slug, reason, detail, len(results)) == (
        f"{slug} returned {len(results)} usable records before a later "
        f"HTTP 200 reply could not be read. The retained set may be "
        f"incomplete.")


def _derived_reason() -> tuple[str, dict]:
    """What the sweep engine would record, read the way the engine reads it."""
    return zero_reason.derive(api_base.search_outcome().snapshot())


@pytest.mark.parametrize("shape", sorted(_DECODES_BUT_UNUSABLE))
@pytest.mark.parametrize("slug", _DEFECT_SET_SLUGS)
def test_a_body_that_decodes_to_no_object_is_also_a_parse_failure(
        slug, shape, monkeypatch):
    """``null``, an array and a string are replies, and none of them is usable.

    The ``null`` case is the one that matters, and it is the one a sentinel
    gets wrong. ``response.json()`` on ``b"null"`` succeeds and returns
    Python ``None`` -- indistinguishable, to a caller that only checks
    ``if data is None``, from "the body could not be read". The caller stops
    holding whatever it had, and no reason is recorded anywhere, so
    ``zero_reason.derive`` falls through to ``answered_empty``: *the source
    answered and resmon found no records in the reply*. That is the quiet
    field, reached through the repair rather than through the bug, and it is
    strictly worse than the ``AttributeError`` these ten used to raise here,
    because a traceback at least reaches the error row.
    """
    module = _module_for(slug)
    _prepare(monkeypatch, module)
    body = _DECODES_BUT_UNUSABLE[shape]

    def respond(_self, method, url, **_kwargs):
        return httpx.Response(200, content=body,
                              request=httpx.Request(method, str(url)))

    async def respond_async(_self, method, url, **kwargs):
        return respond(_self, method, url, **kwargs)

    monkeypatch.setattr(httpx.Client, "request", respond)
    monkeypatch.setattr(httpx.AsyncClient, "request", respond_async)

    api_base.reset_search_outcome()
    try:
        results = api_registry.get_client(slug).search(
            "machine learning", "2024-01-01", "2024-12-31", 5)
    except Exception as exc:
        pytest.fail(
            f"{slug} raised out of search() on HTTP 200 carrying {shape}: "
            f"{type(exc).__name__}: {exc}. The body decoded; what it decoded "
            f"to has no container this client reads records out of, which is "
            f"a reply resmon could not read, not a crash.")

    assert results == [], (
        f"{slug} returned {len(results)} records from a body with no object "
        f"at its root")

    reason, detail = _derived_reason()
    assert reason == "parse_failure", (
        f"{slug} was handed HTTP 200 carrying {shape} and the channel derives "
        f"to {reason!r}. If that is 'answered_empty', a reply with no "
        f"container at all has been rendered as the source looking and "
        f"finding nothing: {zero_reason.sentence(slug, reason, detail)!r}")


@pytest.mark.parametrize("shape", sorted(_DECODES_BUT_UNUSABLE))
@pytest.mark.parametrize("slug", _PARTIAL_PAGE_SLUGS)
def test_a_readable_page_survives_a_body_with_no_object_at_its_root(
        slug, shape, monkeypatch):
    """And the earlier page survives that too, with a reason on the record.

    The partial-page property from the row above, driven against the three
    shapes that decode. Separate from that row because the failure mode is
    different: there the client never got a value, here it got one and the
    question is whether it recognizes that it cannot use it.
    """
    module = _module_for(slug)
    _prepare(monkeypatch, module)
    server = _OneGoodPageThenGarbage(slug, _DECODES_BUT_UNUSABLE[shape])
    _install(monkeypatch, server)

    api_base.reset_search_outcome()
    try:
        results = api_registry.get_client(slug).search(
            "machine learning", "2024-01-01", "2024-12-31", _MAX_RESULTS)
    except Exception as exc:
        pytest.fail(
            f"{slug} raised out of search() when page {server.requests} "
            f"carried {shape}: {type(exc).__name__}: {exc}. "
            f"{server.delivered} records from page 1 go with the frame.")

    assert server.requests >= 2, (
        f"{slug} stopped after {server.requests} request(s); nothing was "
        f"measured")
    assert len(results) == server.delivered, (
        f"{slug} returned {len(results)} of the {server.delivered} records it "
        f"had parsed out of page 1 before page 2 came back as {shape}")

    reason, detail = _derived_reason()
    assert reason == "parse_failure", (
        f"{slug} kept its first page but the channel derives to {reason!r}, "
        f"so a truncated set carries no terminal reason and reads as a "
        f"complete one: {zero_reason.sentence(slug, reason, detail)!r}")


def test_the_partial_page_denominator_is_named():
    """Nine of twenty-seven, and the other eighteen are named, not forgotten.

    The project bans "every client" without a denominator beside it. This row
    speaks for nine slugs; this test is what stops that nine from silently
    becoming nine of thirty.
    """
    driven = set(_PARTIAL_PAGE_SLUGS)
    assert len(driven) == len(_PARTIAL_PAGE_SLUGS) == 9
    assert driven <= set(SLUGS), (
        f"_PARTIAL_PAGE_SLUGS names a slug the registry does not serve: "
        f"{sorted(driven - set(SLUGS))}")
    assert driven <= set(_PAGE_SHAPES), (
        f"a driven slug has no page shape in the harness: "
        f"{sorted(driven - set(_PAGE_SHAPES))}")

    uncovered = set(SLUGS) - driven - set(_NOT_DRIVEN)
    assert uncovered == set(), (
        f"a registered slug is neither driven by this row nor named in "
        f"_NOT_DRIVEN with a reason: {sorted(uncovered)}")
    assert set(_NOT_DRIVEN) <= set(SLUGS), (
        f"_NOT_DRIVEN names a slug the registry no longer serves, so the list "
        f"has gone stale against a rename or a retirement: "
        f"{sorted(set(_NOT_DRIVEN) - set(SLUGS))}")
