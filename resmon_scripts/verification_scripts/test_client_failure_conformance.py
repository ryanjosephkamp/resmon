"""No client abandons a failed request and goes on to a different one.

This is the invariant a removal depends on, which is why it is a test rather
than a paragraph.

`zero_reason.terminal_issue` does not fire on `failures` alone. A revision of
PR #169 made it, to catch PubMed's `_efetch` skipping a 503 batch and
finishing the rest, and the branch had to be taken out again: the only
snapshots that reach it in this codebase come from the three clients whose
documented "retry once" ladder runs *outside* `safe_request`, and a ladder
that recovered has lost nothing. Reporting it as a partial answer told a user
*"ERIC returned 1 usable record before a later HTTP 503 request failed"* about
a source that answered.

That reasoning holds only while the premise does: **a failed invocation
followed by another one is always the same request being retried, never a
different request after records were dropped.** A client that someday skips a
failed page and keeps going would under-deliver silently, with no zero reason
and nothing on the record -- the exact defect `_efetch` had, and the one the
deleted branch would have caught. Nothing in the code enforces the premise, so
it is enforced here.

The denominator is the registry's own, so a twenty-eighth source is covered on
the day it is registered rather than on the day somebody remembers this file.

**What this does not establish.** Only the first transport attempt fails here,
so this says nothing about a client's behavior when several pages fail in a
row, and nothing about whether a client's retry is a good idea. It checks the
shape of the request sequence, not the records: a client that re-issues the
same request and then drops the reply on the floor passes this and is still
broken. It is one row of the conformance harness the 2026-10-18 audit asked
for, not the harness.
"""

from __future__ import annotations

import importlib
import sys
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
_BODY = (
    b'{"results": [], "hits": {"hits": [], "total": 0}, "data": [], '
    b'"response": {"docs": []}, "records": [], "total": 0, '
    b'"esearchresult": {"idlist": []}}'
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
    yield
    api_base.reset_search_outcome()


@pytest.fixture
def failing_then_answering(monkeypatch):
    """Fail the first transport attempt of the search, answer every one after.

    Both transports are replaced: a client that passes a ``deadline=`` goes
    through the cancellable async scope and never touches ``httpx.Client``.
    """
    seen = {"n": 0}

    def respond(_self, method, url, **kwargs):
        seen["n"] += 1
        request = httpx.Request(method, str(url))
        if seen["n"] == 1:
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
        record = {"url": str(url).split("?")[0],
                  "params": repr(sorted((kwargs.get("params") or {}).items())),
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


@pytest.mark.parametrize("slug", SLUGS)
def test_no_client_continues_past_a_failed_request(
    slug, monkeypatch, failing_then_answering,
):
    """A second invocation after a failed one must repeat the first request.

    Sameness is asserted from the recorded URL and params, not read off the
    source: the whole point of the earlier mistake was that the shape looked
    obvious and was not checked.
    """
    module = _module_for(slug)
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
        assert (later["url"], later["params"]) == (earlier["url"], earlier["params"]), (
            f"{slug} issued a different request after one that failed. That is "
            f"either a retry that changed its own query, or records being "
            f"dropped and the search carrying on -- the second is the defect "
            f"api_pubmed._efetch had, and it leaves no zero reason behind.\n"
            f"  failed : {earlier['url']} {earlier['params']}\n"
            f"  next   : {later['url']} {later['params']}"
        )


def test_the_denominator_is_the_registry_and_the_ladders_are_still_four():
    """What the case above is worth, in numbers taken from the code.

    The count is not pinned -- a new source must not fail this file on the day
    it is added -- but the registry is the only list involved, and the
    known-ladder set is named so that a client growing a second invocation is
    visible in the record rather than only in a green tick.
    """
    assert SLUGS == api_registry.list_repositories()
    assert len(SLUGS) >= 27, "the registry shrank; a source was retired silently"
    # The modules that re-invoke `safe_request` themselves, as of 2026-10-18:
    # each wraps it in `for attempt in range(_MAX_RESPONSE_ATTEMPTS)` with
    # `max_retries=0`. Any other module gaining that loop is new behavior.
    ladders = {slug for slug in SLUGS
               if getattr(_module_for(slug), "_MAX_RESPONSE_ATTEMPTS", 1) > 1}
    assert ladders == {"biorxiv", "medrxiv", "dblp", "eric"}, (
        "a client gained or lost its own retry ladder; the reasoning in "
        "zero_reason.terminal_issue's docstring counts these")
