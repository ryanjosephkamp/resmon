"""A source that did not answer never reads as a source that answered.

Two rows of the connector conformance harness, both of them the same product
sentence looked at from two sides: **resmon says why a source returned
nothing, or it says it does not know -- and it never says "answered" about a
source that failed.** The taxonomy is ``zero_reason.ZERO_REASONS``; the
distinction that matters to a user is ``zero_reason.DID_NOT_ANSWER``.

*Row 1* drives every registered client against a transport that answers 503 to
everything, and requires the recorded outcome to derive to a reason meaning
*the source did not answer*.

*Row 2* drives every registered client against HTTP 200 carrying a body no
client can read, and requires ``parse_failure`` -- the reason whose sentence
is "answered, and resmon could not read the reply". The nine-plus clients that
instead let ``json.JSONDecodeError`` escape ``search()`` are marked ``xfail``
and named in ``_RAISES_ON_UNREADABLE_BODY`` with what they do instead; see the
note on that constant. Fixing them belongs in its own pull request.

Both rows exist because the 2026-10-18 audit found three engine defects that a
table-driven suite would have caught on the day each client was written, and
the repair for each was applied to the one client that happened to fail in a
live run. The sibling file ``test_client_failure_conformance.py`` is the first
row and the shape all of them follow: the denominator is read from
``api_registry.list_repositories()`` rather than written here, so a
twenty-eighth source is covered on the day it is registered;
``test_client_pagination_conformance.py`` is the third.

**Every client is given a placeholder credential.** Four clients -- ``core``,
``govinfo``, ``nasa_ads`` and ``springer`` -- return an empty list before
making any request when their key is absent, which is correct behavior and
also makes them unable to say anything about a 503. Asking "what does this
client record when the source fails?" of a client that never asked the source
is not a measurement, so ``credential_manager.get_credential_for`` is patched
to hand out one obviously fake string and all twenty-seven reach the
transport. That is why these rows carry a denominator of 27 where the sibling
row carries 23 asserting and 4 silent.

**What this does not establish.** Every request of the search fails the same
way, so neither row says anything about a client that fails on its *second*
page having kept its first -- the case where records were already in hand. (It
is not academic: the clients in ``_RAISES_ON_UNREADABLE_BODY`` throw away
everything they hold when a later page cannot be read, because the exception
leaves ``search()``. That consequence is read off the control flow here, not
measured.) Only ``search()`` is driven, never ``search_entity()``, so a code
path reached only when asking about a person -- ``api_dblp``'s SPARQL route is
the one -- is counted in the denominator and never exercised. 503 is the only
failure status driven; a 429 with a ``Retry-After``, a connect error and a
deadline expiry each take a different branch of ``safe_request`` and are not
here. The bodies in ``_UNREADABLE_BODIES`` are ones *no* client can read; a
reply that parses as JSON but carries the wrong root is a different and
genuinely contested case, and it is recorded by
``test_a_json_body_with_no_known_container_splits_the_clients`` as a census
rather than asserted as a defect. These rows read the client's outcome channel
through ``zero_reason.derive``; what the sweep engine finally writes to the
database for a client that *raises* is an ``error`` row, which is a different
surface and is asserted in ``test_engine_truth.py``, not here.
"""

from __future__ import annotations

import importlib
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

#: Every slug the registry serves, read at collection time. The denominator is
#: never written down in this file; see the sibling's docstring for why.
SLUGS = api_registry.list_repositories()

#: One module can register more than one slug: ``api_biorxiv`` serves bioRxiv
#: and medRxiv from the same client, under different server paths.
_MODULE_FOR_SLUG = {"medrxiv": "api_biorxiv"}

#: Handed to every client that asks for a credential. It is deliberately not
#: key-shaped: nothing here should ever be mistaken for a real one, and no
#: client validates the format before sending it.
_PLACEHOLDER_CREDENTIAL = "conformance-harness-placeholder-not-a-key"


def _module_for(slug: str):
    return importlib.import_module(
        f"implementation_scripts.{_MODULE_FOR_SLUG.get(slug, 'api_' + slug)}")


@pytest.fixture(autouse=True)
def quick_and_isolated(monkeypatch):
    """No limiter waits, no retry ladder inside ``safe_request``, no sleeping.

    ``max_retries = 0`` keeps each attempt visible rather than letting
    ``safe_request`` swallow the 503 in its own ladder. The ``time.sleep``
    patch is at the ``time`` module and not at ``config``, for the reason the
    sibling file records: every ladder computes ``base ** attempt`` and the
    first retry is ``base ** 0``, which is 1.0 whatever the base, so lowering
    ``DEFAULT_BACKOFF_BASE`` does not shorten the first wait at all.
    """
    api_base.reset_search_outcome()
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
    monkeypatch.setattr(config, "DEFAULT_BACKOFF_BASE", 0.01)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    yield
    api_base.reset_search_outcome()


def _prepare(monkeypatch, module) -> None:
    """Make this module's client reach the transport without waiting.

    The rate limiters are replaced rather than disabled, because a client
    holds its limiter in a module-level constant and reads it at call time.
    The credential is patched on the module rather than in the keyring so
    that a client reading it through its own import is covered; a client
    that does not ask for one is untouched.
    """
    for name in dir(module):
        if name.endswith("RATE_LIMITER"):
            monkeypatch.setattr(module, name, api_base.RateLimiter(10_000))
    if hasattr(module, "get_credential_for"):
        monkeypatch.setattr(
            module, "get_credential_for",
            lambda _exec_id, _name: _PLACEHOLDER_CREDENTIAL)


def _answer_everything_with(monkeypatch, status: int, body: bytes) -> None:
    """Every request, on either transport, gets this one reply.

    Both ``httpx.Client`` and ``httpx.AsyncClient`` are replaced: a client
    that passes a ``deadline=`` goes through ``safe_request``'s cancellable
    async scope and never touches the synchronous one.
    """
    def respond(_self, method, url, **_kwargs):
        return httpx.Response(status, content=body,
                              request=httpx.Request(method, str(url)))

    async def respond_async(_self, method, url, **kwargs):
        return respond(_self, method, url, **kwargs)

    monkeypatch.setattr(httpx.Client, "request", respond)
    monkeypatch.setattr(httpx.AsyncClient, "request", respond_async)


def _search(slug: str):
    """One ordinary keyword search, with the outcome channel cleared first."""
    api_base.reset_search_outcome()
    return api_registry.get_client(slug).search(
        "machine learning", "2024-01-01", "2024-12-31", 5)


def _derived_reason(slug: str) -> tuple[str, dict]:
    """What the sweep engine would record about this search.

    ``zero_reason.derive`` is called here exactly as ``sweep_engine`` calls it
    on a source that returned nothing, so this row and the engine cannot
    disagree about what the channel means.
    """
    return zero_reason.derive(api_base.search_outcome().snapshot())


# ---------------------------------------------------------------------------
# Row: a 5xx always leaves a legible outcome
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("slug", SLUGS)
def test_a_server_error_leaves_a_reason_that_is_not_an_answer(slug, monkeypatch):
    """503 on every request must derive to a reason meaning *did not answer*.

    The assertion is not "some reason was recorded". ``answered_empty`` is a
    reason, and it is the specific lie this row exists to forbid: a user
    reading "OpenAlex answered (HTTP 200) and resmon found no records" about a
    source that returned 503 to every request has been told their field is
    quiet when their monitoring is broken, which is the one failure this
    product is for. ``not_recorded`` is honest but is the floor for a search
    resmon never observed, and a search that got 503 twenty-seven times was
    observed.

    ``zero_reason.answered`` is asserted directly as well as the reason's
    membership, because that function -- not this set -- is what the search
    record and the executions API both call, and it is the sentence the source
    wall renders.
    """
    module = _module_for(slug)
    _prepare(monkeypatch, module)
    _answer_everything_with(monkeypatch, 503, b"")

    try:
        results = _search(slug)
    except Exception as exc:  # a client may give up; it may not raise
        pytest.fail(f"{slug} raised out of search() on HTTP 503, which the "
                    f"client contract forbids: {type(exc).__name__}: {exc}")

    assert results == [], (
        f"{slug} returned {len(results)} records from a transport that "
        f"answered 503 to every request")

    reason, detail = _derived_reason(slug)
    assert reason in zero_reason.ZERO_REASONS, (
        f"{slug} derived {reason!r}, which is not in zero_reason.ZERO_REASONS "
        f"and would reach a user as a bare slug")
    assert reason in zero_reason.DID_NOT_ANSWER, (
        f"{slug} answered 503 to every request and resmon recorded {reason!r}. "
        f"A source that failed must never read as a source that answered and "
        f"had nothing: that is the difference the whole zero-reason phase "
        f"exists for, and a search strategy listing this source as searched "
        f"would be overstating its coverage.")
    assert zero_reason.answered("ok", 0, reason) is False, (
        f"{slug}: zero_reason.answered counted {reason!r} as an answer")

    # The sentence is rendered, not only the slug chosen: ``_render`` raises on
    # a reason it has no sentence for, and a reason with no sentence is how a
    # bare slug reaches the UI.
    assert zero_reason.sentence(slug, reason, detail)


# ---------------------------------------------------------------------------
# Row: an unreadable 200 is a parse failure, not an empty answer
# ---------------------------------------------------------------------------

#: Bodies that **no** client in this repository can read, whatever format it
#: expects. Each one is a shape a real provider has served:
#:
#: * an empty body with HTTP 200 -- bioRxiv and medRxiv both returned
#:   ``content-length: 0`` with ``application/json`` on 2026-09-17;
#: * a truncated JSON document -- a response cut off mid-stream;
#: * an HTML page served as HTTP 200 -- DBLP's Anubis bot challenge arrives
#:   exactly this way, as 200 carrying ``text/html``, which is why a naive
#:   ``response.json()`` raised a decoder error instead of surfacing a status.
#:
#: The ``<p>`` is left unclosed on purpose: a well-formed HTML fragment is also
#: well-formed XML, and the three XML clients would parse it as a document with
#: no records rather than as an unreadable reply.
_UNREADABLE_BODIES = {
    "empty-body": b"",
    "truncated-json": b'{"results": [{"id":',
    "html-where-data-was-expected": (
        b"<html><body><p>Making sure you are not a bot!</body></html>"),
}

#: The clients that let ``json.JSONDecodeError`` out of ``search()`` instead of
#: recording a parse failure. **This is a live defect, found by this row.**
#:
#: All ten share one idiom: ``safe_request`` is wrapped in ``try``/``except``
#: and ``response.json()`` sits on the line *after* the ``except`` block, so
#: nothing catches a reply that cannot be decoded. The other seventeen either
#: parse inside the ``try`` or call ``api_base.note_parse_failure``.
#:
#: What a user sees today is not the quiet field this row's sentence forbids:
#: the exception escapes to ``sweep_engine``'s catch-all, which records the
#: source as ``error`` with ``zero_reason=None`` and renders the decoder's own
#: message -- *"The query failed: Expecting value: line 1 column 1 (char 0).
#: This is not a zero -- the source did not answer."* So the harm is narrower
#: than a lie and wider than cosmetics: the reason column is empty where
#: ``parse_failure`` belongs, the user is shown a Python parser message instead
#: of resmon's sentence, and -- because the exception unwinds ``search()`` --
#: any records already collected from earlier pages are discarded.
#:
#: Marked ``xfail(strict=True)`` so that fixing one of these fails this row
#: until its slug is removed from the list, and a *new* client written with the
#: same idiom fails outright rather than joining a growing exception list.
_RAISES_ON_UNREADABLE_BODY = frozenset({
    "core",
    "crossref",
    "doaj",
    "europepmc",
    "nasa_ads",
    "openalex",
    "plos",
    "pubmed",
    "semantic_scholar",
    "springer",
})


def _slug_params():
    """Slugs, with the known raisers marked ``xfail``.

    Built from the registry, so a new source arrives unmarked and has to earn
    its pass.
    """
    for slug in SLUGS:
        if slug in _RAISES_ON_UNREADABLE_BODY:
            yield pytest.param(slug, marks=pytest.mark.xfail(
                strict=True,
                reason=(f"api_{slug} calls response.json() outside its "
                        f"try/except and lets json.JSONDecodeError out of "
                        f"search(); see _RAISES_ON_UNREADABLE_BODY")))
        else:
            yield slug


@pytest.mark.parametrize("body_name", sorted(_UNREADABLE_BODIES))
@pytest.mark.parametrize("slug", list(_slug_params()))
def test_an_unreadable_two_hundred_is_a_parse_failure(slug, body_name, monkeypatch):
    """HTTP 200 with a body no parser can read must record ``parse_failure``.

    ``parse_failure`` and ``answered_empty`` are the two reasons a client can
    reach after a 200, and they tell a user opposite things: one says the reply
    was unreadable, the other says the source looked and had nothing. Getting
    this wrong is how a bot challenge, a truncated stream or a provider's error
    page becomes "no new papers this week".
    """
    module = _module_for(slug)
    _prepare(monkeypatch, module)
    _answer_everything_with(monkeypatch, 200, _UNREADABLE_BODIES[body_name])

    try:
        results = _search(slug)
    except Exception as exc:
        pytest.fail(f"{slug} raised out of search() on an unreadable HTTP 200, "
                    f"which the client contract forbids: "
                    f"{type(exc).__name__}: {exc}")

    assert results == [], (
        f"{slug} returned {len(results)} records from a body nothing can read")

    reason, detail = _derived_reason(slug)
    assert reason == "parse_failure", (
        f"{slug} was handed HTTP 200 with a {body_name} body and resmon "
        f"recorded {reason!r}. The source did not answer the question; "
        f"{zero_reason.sentence(slug, reason, detail)!r} is what the user "
        f"would be told.")
    assert zero_reason.answered("ok", 0, reason) is False


def test_a_json_body_with_no_known_container_splits_the_clients():
    """A census, not a verdict: who calls ``{"unexpected": {}}`` unreadable.

    A body that decodes cleanly as JSON and carries none of the keys a client
    looks for is the one case in this area where the right answer is arguable.
    ``api_zenodo`` treats "``hits`` is not a dict" as a parse failure on the
    grounds that the source promised a shape and did not deliver it;
    ``api_openalex`` reads ``data.get("results", [])`` and sees an empty list,
    which is indistinguishable from a real empty answer at that line.

    Both readings are defensible and this file does not pick one. What it
    refuses to allow is the split changing without anyone noticing, so the two
    sets are pinned here with the reason they are pinned. A client moving from
    one set to the other is a decision; failing this assertion is how it gets
    made deliberately.

    Note the shape of the finding. Two of the ten that call this body
    unreadable -- ``arxiv`` and ``ndl_search`` -- do so by accident of format:
    an XML parser cannot read a JSON object whatever its root. The other eight
    checked the shape and said so. The seventeen in the other set are not a
    uniform group either: ten of them never got as far as looking, because
    they are the clients that raise on a body that does not decode and this
    one does.
    """
    body = b'{"unexpected_root": {"nothing": 1}}'
    unreadable, empty_answer, other = set(), set(), {}

    for slug in SLUGS:
        module = _module_for(slug)
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
            patch.setattr(time, "sleep", lambda _seconds: None)
            _prepare(patch, module)
            _answer_everything_with(patch, 200, body)
            try:
                _search(slug)
            except Exception as exc:
                other[slug] = f"raised {type(exc).__name__}"
                continue
        reason, _detail = _derived_reason(slug)
        if reason == "parse_failure":
            unreadable.add(slug)
        elif reason == "answered_empty":
            empty_answer.add(slug)
        else:
            other[slug] = reason

    assert other == {}, (
        f"a client did something other than call this body unreadable or call "
        f"it empty: {other}")
    assert unreadable == {
        "arxiv", "biorxiv", "dblp", "eric", "govinfo", "hal", "medrxiv",
        "ndl_search", "oapen", "zenodo",
    }, f"the set calling a wrong-rooted JSON body unreadable changed: {sorted(unreadable)}"
    assert empty_answer == {
        "core", "crossref", "datacite", "doaj", "dryad", "europepmc",
        "inspire_hep", "nasa_ads", "nist_rmm", "openaire", "openalex",
        "openlibrary", "osti", "plos", "pubmed", "semantic_scholar",
        "springer",
    }, f"the set calling a wrong-rooted JSON body an empty answer changed: {sorted(empty_answer)}"


def test_the_denominator_is_the_registry_and_the_exclusions_are_named():
    """What these rows are worth, in numbers that come from the code.

    Said out loud because "every client records a reason" is the kind of claim
    this project bans without a denominator beside it.
    """
    assert SLUGS == api_registry.list_repositories()
    assert len(SLUGS) >= 27, "the registry shrank; a source was retired silently"

    # Row 1 asserts on every registered slug with nothing excluded: the
    # placeholder credential is what makes that true, and it is worth failing
    # here if a client ever stops reaching the transport for some other reason.
    assert len(SLUGS) == len(set(SLUGS))

    # Row 2's exclusions are a defect list, not a design. Every name in it must
    # still be a registered slug, or the list has gone stale against a rename.
    assert _RAISES_ON_UNREADABLE_BODY <= set(SLUGS), (
        f"_RAISES_ON_UNREADABLE_BODY names a slug the registry does not serve: "
        f"{sorted(_RAISES_ON_UNREADABLE_BODY - set(SLUGS))}")
    assert len(_RAISES_ON_UNREADABLE_BODY) == 10
