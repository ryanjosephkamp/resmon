"""No client abandons a failed request and goes on to a different one.

This is the invariant a removal depends on, which is why it is a test rather
than a paragraph.

`zero_reason.terminal_issue` does not fire on `failures` alone. A revision of
PR #169 made it, to catch PubMed's `_efetch` skipping a 503 batch and
finishing the rest, and the branch had to be taken out again: the only
snapshots that reach it in this codebase come from the four client modules
whose documented "retry once" ladder runs *outside* `safe_request` -- five
slugs, since `api_biorxiv` serves two -- and a ladder that recovered has lost
nothing. Reporting it as a partial answer told a user
*"ERIC returned 1 usable record before a later HTTP 503 request failed"* about
a source that answered.

That reasoning holds only while the premise does: **a failed invocation
followed by another one is always the same request being retried, never a
different request after records were dropped.** A client that someday skips a
failed page and keeps going would under-deliver silently, with no zero reason
and nothing on the record -- the exact defect `_efetch` had, and the one the
deleted branch would have caught. Nothing in the code enforces the premise, so
it is enforced here.

The denominator is the registry's own, so a twenty-seventh source is covered on
the day it is registered rather than on the day somebody remembers this file.

**What this does not establish.** One transport attempt fails per case -- the
first, then the second -- so this says nothing about a client's behavior when
several pages fail in a row, and nothing about whether a client's retry is a
good idea. Of the 52 behavioral cases, only the handful belonging to a client
with its own retry ladder compare two invocations at all; four clients
(`core`, `govinfo`, `nasa_ads`, `springer`) return on a missing credential
before any request is made, so their cases assert nothing. The rest make one
invocation and stop, which is the premise holding rather than the test
working. It drives `search()` and never `search_entity()`, so a paging
scheme reached only by the entity path -- `api_dblp`'s SPARQL is the one -- is
recorded but never exercised. It checks the
shape of the request sequence, not the records: a client that re-issues the
same request and then drops the reply on the floor passes this and is still
broken.

It is one row of the conformance harness the 2026-10-18 audit asked for, not
the harness. Its siblings, built to the same shape:
``test_client_outcome_conformance.py`` (a 5xx, and an unreadable 200, each
leave a zero reason that does not read as an answer) and
``test_client_pagination_conformance.py`` (``max_results`` fetches each record
once and asks for the tail -- the row that catches the OpenAlex and DOAJ
page-window defect).
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

from implementation_scripts import api_base, api_registry, config  # noqa: E402

#: Every slug the registry serves. Read at collection so a new client is a new
#: case without anyone editing this file.
SLUGS = api_registry.list_repositories()

#: One module can register more than one slug: ``api_biorxiv`` serves bioRxiv
#: and medRxiv from the same client, under different server paths.
_MODULE_FOR_SLUG = {"medrxiv": "api_biorxiv"}

#: Enough shapes that most clients get past their first `if` without the
#: payload being the subject. A client that cannot read this records a parse
#: failure, which does not affect the property under test: the request
#: sequence is what is asserted.
#: The identifier list is long enough that a client batching by identifier
#: makes more than one call for it -- PubMed's `_efetch` takes 200 at a time,
#: so 250 is two batches. Without that, the client that *had* this defect
#: never reaches a second request and the case passes vacuously.
_IDS = ", ".join(f'"{n}"' for n in range(1, 251)).encode()
_BODY = (
    b'{"results": [], "hits": {"hits": [], "total": 0}, "data": [], '
    b'"response": {"docs": []}, "records": [], "total": 0, '
    b'"esearchresult": {"idlist": [' + _IDS + b']}}'
)


def _module_for(slug: str):
    return importlib.import_module(
        f"implementation_scripts.{_MODULE_FOR_SLUG.get(slug, 'api_' + slug)}")


@pytest.fixture(autouse=True)
def quick_and_isolated(monkeypatch):
    """No real limiter waits, no retry ladder inside `safe_request`.

    `max_retries = 0` is what makes each attempt visible: with the shared
    default, `safe_request` would swallow the 503 in its own retry and no
    client would be seen making a second invocation at all.
    """
    api_base.reset_search_outcome()
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
    monkeypatch.setattr(config, "DEFAULT_BACKOFF_BASE", 0.01)
    # And no backoff actually waits. Lowering the base is not enough on its
    # own: every ladder computes `base ** attempt`, and the first retry is
    # `base ** 0`, which is 1.0 for any base at all. Four clients therefore
    # slept a real second each under the 0.01 above. The assertions here are
    # about the sequence of requests, never about timing, so the wait is
    # removed rather than shortened -- and at the `time` module, because the
    # clients look `time.sleep` up at call time and binding varies between
    # them (`api_inspire_hep` imports its backoff constant directly, so
    # patching `config` would have missed it anyway).
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    yield
    api_base.reset_search_outcome()


def _fail_attempt(monkeypatch, which: int):
    """Fail the ``which``-th transport attempt of the search, answer the rest.

    Both attempts matter and they catch different things. Failing the **first**
    reaches the retry ladders, whose second invocation repeats the request.
    Failing the **second** reaches a client whose opening call is a lookup --
    PubMed asks `esearch` for identifiers before `efetch` fetches them -- and
    that is the only way to see the defect this property exists for: with
    `_efetch`'s old `continue`, the batch after a failed one is a *different*
    request. A probe that only ever failed the first attempt passed PubMed
    with its defect restored, which is how this fixture got its second half.

    Both transports are replaced: a client that passes a ``deadline=`` goes
    through the cancellable async scope and never touches ``httpx.Client``.
    """
    seen = {"n": 0}

    def respond(_self, method, url, **kwargs):
        seen["n"] += 1
        request = httpx.Request(method, str(url))
        if seen["n"] == which:
            return httpx.Response(503, content=b"", request=request)
        return httpx.Response(200, content=_BODY, request=request)

    async def respond_async(_self, method, url, **kwargs):
        return respond(_self, method, url, **kwargs)

    monkeypatch.setattr(httpx.Client, "request", respond)
    monkeypatch.setattr(httpx.AsyncClient, "request", respond_async)


def _trace_invocations(monkeypatch, module) -> list[dict]:
    """Record each ``safe_request`` invocation and whether it failed.

    "Failed" is the outcome channel's own word -- an invocation that raised,
    or one after which ``failures`` went up -- rather than a status code read
    here, so this agrees with what the rest of the app will conclude.
    """
    calls: list[dict] = []
    real = api_base.safe_request

    def traced(method, url, **kwargs):
        # The body matters as much as the query string, and clients disagree
        # about which kwarg carries it: `api_govinfo` puts its `offsetMark` in
        # `json=`, and `api_dblp` pages its SPARQL endpoint by writing
        # LIMIT/OFFSET into the query text and sending it as `content=`. A
        # trace keyed on url+params alone calls two different pages of either
        # one the same request. Headers are deliberately not recorded: the only
        # ones any client sets are credentials and content types.
        record = {"url": str(url).split("?")[0],
                  "params": repr(sorted((kwargs.get("params") or {}).items())),
                  "body": repr(next((kwargs[k] for k in ("json", "content", "data")
                                     if kwargs.get(k) is not None), None)),
                  "failed": True}
        calls.append(record)
        before = api_base.search_outcome().failures
        try:
            response = real(method, url, **kwargs)
        except Exception:
            raise
        else:
            record["failed"] = api_base.search_outcome().failures > before
            return response

    if hasattr(module, "safe_request"):
        monkeypatch.setattr(module, "safe_request", traced)
    for name in dir(module):
        if name.endswith("RATE_LIMITER"):
            monkeypatch.setattr(module, name, api_base.RateLimiter(10_000))
    return calls


@pytest.mark.parametrize("fails_on", [1, 2], ids=["first-call", "second-call"])
@pytest.mark.parametrize("slug", SLUGS)
def test_no_client_continues_past_a_failed_request(slug, fails_on, monkeypatch):
    """A second invocation after a failed one must repeat the first request.

    Sameness is asserted from the recorded URL and params, not read off the
    source: the whole point of the earlier mistake was that the shape looked
    obvious and was not checked.
    """
    module = _module_for(slug)
    _fail_attempt(monkeypatch, fails_on)
    calls = _trace_invocations(monkeypatch, module)

    try:
        api_registry.get_client(slug).search(
            "machine learning", "2024-01-01", "2024-12-31", 5)
    except Exception as exc:  # a client is allowed to give up; it must not lie
        pytest.fail(f"{slug} raised out of search(), which the client "
                    f"contract forbids: {type(exc).__name__}: {exc}")

    for earlier, later in zip(calls, calls[1:]):
        if not earlier["failed"]:
            continue
        assert ((later["url"], later["params"], later["body"])
                == (earlier["url"], earlier["params"], earlier["body"])), (
            f"{slug} issued a different request after one that failed. That is "
            f"either a retry that changed its own query, or records being "
            f"dropped and the search carrying on -- the second is the defect "
            f"api_pubmed._efetch had, and it leaves no zero reason behind.\n"
            f"  failed : {earlier['url']} {earlier['params']} {earlier['body']}\n"
            f"  next   : {later['url']} {later['params']} {later['body']}"
        )


def test_the_denominator_is_the_registry_and_the_ladders_are_derived(monkeypatch):
    """What the case above is worth, in numbers taken from behavior.

    The registry is the only list involved, so a new source is a new case on
    the day it is registered. The ladder set is **derived by running the same
    probe**, not read off an attribute: the first version of this assertion
    asked for ``_MAX_RESPONSE_ATTEMPTS > 1`` and therefore could not see
    ``api_inspire_hep``, which runs the identical shape --
    ``safe_request(..., max_retries=0)`` inside a retry loop -- while reusing
    the shared ``DEFAULT_MAX_RETRIES`` name. An assertion whose stated purpose
    is making a new ladder visible in the record could not see one already
    there. Derive from the behavior the harness measures, never from a name
    that happens to correlate with it.
    """
    assert SLUGS == api_registry.list_repositories()
    assert len(SLUGS) >= 26, "the registry shrank; a source was retired silently"

    ladders, silent = set(), set()
    for slug in SLUGS:
        module = _module_for(slug)
        with monkeypatch.context() as patch:
            _fail_attempt(patch, 1)
            calls = _trace_invocations(patch, module)
            try:
                api_registry.get_client(slug).search(
                    "machine learning", "2024-01-01", "2024-12-31", 5)
            except Exception:
                pass
        if not calls:
            silent.add(slug)
        elif any(earlier["failed"] for earlier, _ in zip(calls, calls[1:])):
            # Any failed invocation with another after it, not only the first:
            # a client whose opening call is a successful preflight would
            # otherwise carry its ladder invisibly.
            ladders.add(slug)

    assert ladders == {"biorxiv", "medrxiv", "dblp", "eric", "inspire_hep"}, (
        f"a client gained or lost its own retry ladder: {sorted(ladders)}. The "
        f"reasoning in zero_reason.terminal_issue's docstring counts these, and "
        f"`grep -l 'max_retries=0' api_*.py` should agree with this set")

    # Said out loud because "every registered client" overstates the reach.
    assert silent == {"core", "govinfo", "nasa_ads", "springer"}, (
        f"the set of clients that never reach the transport changed: "
        f"{sorted(silent)}. These return on a missing credential before any "
        f"request is made, so their cases are collected and counted but assert "
        f"nothing; a credential becoming optional would show up here first")
