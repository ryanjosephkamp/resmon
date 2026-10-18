"""Three ways a run under-delivered and then reported itself whole.

From the 2026-10-18 engine audit. The defects are unrelated in the code and
identical in shape: each one loses records the source was willing to give, and
each one leaves every surface the user can read saying that nothing went
wrong. That is the single thing this project exists to refuse, so what follows
is written as properties rather than as regression cases.

1. **PubMed skipped a failed batch.** ``_efetch`` fetched PMIDs 200 at a time
   and hit ``continue`` on a failed batch where every sibling client breaks. A
   later batch then cleared ``last_call_failed``, ``zero_reason.terminal_issue``
   returned ``None``, and the sweep recorded ``ok`` over a result set short by
   however many records the lost batches held.
2. **``terminal_issue`` only looked at the last call.** The same erasure was
   available to any client making more than one request invocation in one
   search, because the rule read ``last_call_failed`` and nothing read
   ``failure_history``.
3. **OpenAlex and DOAJ moved their own page window.** Both paginate by page
   *number* while shrinking the page size on the last request, and a page
   number is an offset over the page size: shrinking it slides the window back
   over records already held and never asks for the tail. ``api_zenodo.py``
   documents the hazard and pins its size; these two did not.
4. **The completion email read a column the table does not have** --
   ``new_count`` for ``new_result_count`` -- behind a ``.get(..., 0)`` that
   turned the mismatch into a confident zero in every scheduled email resmon
   has ever sent, with no test in any delivery file naming either key.

Every HTTP case drives the real client through the real ``safe_request`` with
only the transport replaced, so the retry ladder, the rate limiter and the
``SearchOutcome`` bookkeeping are the production ones: a double that cannot
fail the way the real dependency fails is not evidence.
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import (  # noqa: E402
    api_base,
    api_doaj,
    api_eric,
    api_openalex,
    api_pubmed,
    config,
    database,
    email_notifier,
    email_sender,
    zero_reason,
)


@pytest.fixture(autouse=True)
def isolated_outcome(monkeypatch):
    """One search's outcome channel, and limiters that do not sleep.

    The rate limits are the real providers' and are not under test here; a
    three-batch PubMed search at 3 req/s would spend two thirds of a second
    waiting to prove nothing.
    """
    api_base.reset_search_outcome()
    monkeypatch.setattr(api_pubmed, "_RATE_LIMITER", api_base.RateLimiter(1000))
    monkeypatch.setattr(api_openalex, "_RATE_LIMITER", api_base.RateLimiter(1000))
    monkeypatch.setattr(api_doaj, "_RATE_LIMITER", api_base.RateLimiter(1000))
    monkeypatch.setattr(api_eric, "_RATE_LIMITER", api_base.RateLimiter(1000))
    # ``safe_request`` reads these at call time. Shrinking the ladder keeps an
    # exhausted 503 from sleeping 1 + 2 + 4 seconds on every Python in CI.
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 1)
    monkeypatch.setattr(config, "DEFAULT_BACKOFF_BASE", 0.01)
    yield
    api_base.reset_search_outcome()


class Wire:
    """The synchronous transport these three clients use, and nothing else.

    ``calls`` holds what the client actually put on the wire, which is the
    whole subject of the pagination cases: the defect there is visible only in
    the sequence of requests, never in the records that come back.
    """

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self._respond = None

    def answers(self, respond) -> "Wire":
        """Install ``respond(url, params, call_number) -> (status, body)``."""
        self._respond = respond
        return self

    def params(self, key: str) -> list:
        return [c["params"][key] for c in self.calls]

    def _request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        status, body = self._respond(url, kwargs.get("params") or {}, len(self.calls))
        built = httpx.Request(method, url)
        if isinstance(body, (bytes, str)):
            return httpx.Response(status, content=body, request=built)
        return httpx.Response(status, json=body, request=built)


@pytest.fixture
def wire(monkeypatch) -> Wire:
    """Both transports, because ``safe_request`` has two.

    A client that passes a ``deadline=`` goes through the cancellable async
    scope and never touches ``httpx.Client``; ERIC is one, so patching only
    the synchronous half let its requests reach a real socket.
    """
    bench = Wire()

    def sync(_self, method, url, **kwargs):
        return bench._request(method, url, **kwargs)

    async def asynchronous(_self, method, url, **kwargs):
        return bench._request(method, url, **kwargs)

    monkeypatch.setattr(httpx.Client, "request", sync)
    monkeypatch.setattr(httpx.AsyncClient, "request", asynchronous)
    return bench


def _limiter() -> api_base.RateLimiter:
    return api_base.RateLimiter(1000)


# ---------------------------------------------------------------------------
# 1. PubMed stops where it failed, and the failure survives a later success
# ---------------------------------------------------------------------------

#: ``_efetch``'s own batch size, which the request sequence is read against.
_PUBMED_BATCH = 200

_ARTICLE = (
    "<PubmedArticle><MedlineCitation><PMID>{pmid}</PMID><Article>"
    "<ArticleTitle>Paper {pmid}</ArticleTitle><AuthorList>"
    "<Author><LastName>Doe</LastName><ForeName>Jane</ForeName></Author>"
    "</AuthorList></Article></MedlineCitation></PubmedArticle>"
)


def _pubmed_holding(wire: Wire, *, total: int, failing_batch: int, status: int = 503):
    """A PubMed with ``total`` PMIDs that answers one efetch batch badly.

    ``failing_batch`` is 1-based over *batches*, not over calls: the batch is
    identified by the PMIDs asked for, so an internal retry of a failing batch
    fails again, the way a source that is down does. Keying on a call counter
    instead makes the retry succeed and quietly tests the wrong thing.

    ``failing_batch`` 1 is the audit's reproduction; 2 is a failure after real
    records are already in hand.
    """
    def respond(url, params, _call):
        if "esearch" in url:
            return 200, {"esearchresult":
                         {"idlist": [str(i) for i in range(1, total + 1)]}}
        pmids = params["id"].split(",")
        if (int(pmids[0]) - 1) // _PUBMED_BATCH + 1 == failing_batch:
            return status, b""
        body = "".join(_ARTICLE.format(pmid=p) for p in pmids)
        return 200, f"<PubmedArticleSet>{body}</PubmedArticleSet>"

    return wire.answers(respond)


def _efetch_calls(wire: Wire) -> list[dict]:
    return [c for c in wire.calls if "efetch" in c["url"]]


def test_pubmed_stops_at_the_batch_that_failed(wire):
    """A failed batch ends the fetch; it is not stepped over.

    The audit's reproduction: 500 PMIDs, three efetch batches, the first
    answering 503. Before the fix the client skipped it and returned 300 of
    500 records with ``terminal_issue`` ``None`` -- 200 papers lost and
    nothing on the record anywhere a user could see.
    """
    _pubmed_holding(wire, total=500, failing_batch=1)
    results = api_pubmed.PubmedClient().search("cancer", max_results=500)

    # Two attempts at the first batch (one retry) and then nothing: the client
    # did not go on to ask for batches 2 and 3 as though batch 1 had been
    # answered.
    assert len(_efetch_calls(wire)) == 2
    assert results == []

    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["failures"] == 1
    assert snapshot["last_call_failed"] is True
    assert snapshot["failure_history"] == ["http_503", "http_503"]
    reason, detail = zero_reason.derive(snapshot)
    assert reason == "upstream_failure"
    assert detail["status"] == 503


def test_pubmed_keeps_what_it_had_and_says_the_set_may_be_short(wire):
    """A failure after usable records is a partial answer, not a clean one."""
    _pubmed_holding(wire, total=500, failing_batch=2)
    results = api_pubmed.PubmedClient().search("cancer", max_results=500)

    assert len(_efetch_calls(wire)) == 3  # batch 1, batch 2 twice, then stop
    assert len(results) == 200

    issue = zero_reason.terminal_issue(api_base.search_outcome().snapshot())
    assert issue is not None
    reason, detail = issue
    assert (reason, detail["status"]) == ("upstream_failure", 503)
    sentence = zero_reason.partial_sentence("PubMed", reason, detail, len(results))
    assert "200 usable records" in sentence
    assert "may be incomplete" in sentence


def test_a_retry_that_succeeded_is_still_not_a_terminal_issue(wire):
    """The boundary the fix must not cross.

    An internal retry that succeeds is one successful invocation, and the
    established contract says so: ``failures`` stays 0 and the 500 lives in
    the history only, where a quarantine signature is matched against it. A
    partiality rule reading the history alone would call every recovered retry
    a partial answer, which is the opposite overclaim.
    """
    wire.answers(lambda url, params, call: (500, b"") if call == 1 else (200, {}))

    api_base.safe_request("GET", "https://example.test/retried",
                          rate_limiter=_limiter())

    snapshot = api_base.search_outcome().snapshot()
    assert len(wire.calls) == 2
    assert (snapshot["failures"], snapshot["last_call_failed"]) == (0, False)
    assert snapshot["failure_history"] == ["http_500"]
    assert zero_reason.terminal_issue(snapshot) is None
    assert zero_reason.derive(snapshot) == ("answered_empty", {"attempts": 2})


def test_a_recovered_retry_ladder_is_not_a_partial_answer(wire):
    """The other half of that boundary, and the one a guard did not reach.

    Three clients run their documented "retry once" ladder *outside*
    ``safe_request``, calling it again with ``max_retries=0``: ``api_eric``,
    ``api_dblp`` and ``api_biorxiv`` (which serves both bioRxiv and medRxiv),
    so 3 of 26 active modules and 4 of 27 slugs. Each attempt is a separate
    invocation, so a first-attempt 503 leaves ``failures`` at 1 and the second
    attempt's success clears ``last_call_failed`` -- the one snapshot shape a
    rule reading ``failures`` alone would call partial.

    It is not partial. The ladder re-issues the same URL with the same params;
    the request recovered and no record is missing. A revision of this branch
    did report it, and told the user "ERIC returned 1 usable record before a
    later HTTP 503 request failed" about a source that answered. This drives
    the real ERIC client over the real ladder so the case cannot come back
    through the gap the internal-retry guard above does not cover.
    """
    record = {"id": "EJ1", "title": "A paper", "author": ["Doe, Jane"],
              "description": "x", "publicationdateyear": 2024,
              "subject": ["education"], "url": "https://eric.ed.gov/?id=EJ1"}
    wire.answers(lambda url, params, call: (
        (503, b"") if call == 1
        else (200, {"response": {"docs": [record], "numFound": 1}})))

    results = api_eric.EricClient().search(
        "reading", "2024-01-01", "2024-12-31", max_results=5)

    # Two separate invocations, the ladder's own, not safe_request's retry.
    assert len(wire.calls) == 2
    assert wire.calls[0]["params"] == wire.calls[1]["params"], (
        "the ladder must re-issue the same request, or this is not a retry")
    assert len(results) == 1

    snapshot = api_base.search_outcome().snapshot()
    assert (snapshot["failures"], snapshot["last_call_failed"]) == (1, False)
    assert snapshot["failure_history"] == ["http_503"]
    assert zero_reason.terminal_issue(snapshot) is None, (
        "a request that recovered on its second attempt returned everything "
        "it was asked for; calling the result partial is a false claim")


# ---------------------------------------------------------------------------
# 3. A page number is an offset over the page size
# ---------------------------------------------------------------------------

def _offset_pages(record, total: int):
    """Standard page/per-page offset semantics over a provider of ``total``."""
    def build(page: int, size: int) -> list:
        first = (page - 1) * size
        return [record(i + 1) for i in range(first, min(first + size, total))]
    return build


def _openalex_work(n: int) -> dict:
    return {"id": f"https://openalex.org/W{n}", "display_name": f"Work {n}",
            "authorships": [], "publication_date": "2024-01-02", "doi": None}


def _doaj_article(n: int) -> dict:
    return {"id": f"d{n}", "bibjson": {"title": f"Article {n}", "author": [],
                                       "year": "2024", "link": []}}


def _serve_openalex(wire: Wire, total: int) -> Wire:
    pages = _offset_pages(_openalex_work, total)
    return wire.answers(lambda url, params, call: (
        200, {"results": pages(int(params["page"]), int(params["per-page"]))}))


def _serve_doaj(wire: Wire, total: int) -> Wire:
    pages = _offset_pages(_doaj_article, total)
    return wire.answers(lambda url, params, call: (
        200, {"total": total,
              "results": pages(int(params["page"]), int(params["pageSize"]))}))


@pytest.mark.parametrize("maximum", [150, 250, 500])
def test_openalex_holds_its_page_size_and_asks_for_the_tail(wire, maximum):
    """Each record is requested exactly once, and all of them are requested.

    Asking OpenAlex for 250 used to request page 1 at 200 per page and then
    page 2 at 50 per page -- records 51-100 again, and 201-250 never -- with
    the duplicates collapsed later by dedup so the shortfall was invisible.
    Max Results is a 10-500 slider in the UI, so every value that is not a
    multiple of 200 reached this.
    """
    _serve_openalex(wire, total=1000)
    results = api_openalex.OpenAlexClient().search("quantum", max_results=maximum)
    ids = [r.external_id for r in results]

    assert set(wire.params("per-page")) == {min(maximum, 200)}, "the page size moved"
    assert wire.params("page") == list(range(1, len(wire.calls) + 1))
    assert len(ids) == maximum
    assert len(set(ids)) == maximum, "a record was requested twice"
    assert set(ids) == {f"W{n}" for n in range(1, maximum + 1)}


@pytest.mark.parametrize("maximum", [150, 250, 500])
def test_doaj_holds_its_page_size_and_asks_for_the_tail(wire, maximum):
    """The same property for DOAJ, whose page size is 100."""
    _serve_doaj(wire, total=1000)
    results = api_doaj.DoajClient().search("open access", max_results=maximum)
    ids = [r.external_id for r in results]

    assert set(wire.params("pageSize")) == {min(maximum, 100)}, "the page size moved"
    assert wire.params("page") == list(range(1, len(wire.calls) + 1))
    assert len(ids) == maximum
    assert len(set(ids)) == maximum, "a record was requested twice"
    assert set(ids) == {f"d{n}" for n in range(1, maximum + 1)}


@pytest.mark.parametrize("source,held", [("openalex", 250), ("doaj", 150)])
def test_a_provider_with_fewer_records_than_asked_stops_cleanly(wire, source, held):
    """A pinned size must still stop on the short page that ends the set.

    One full page, then a page the provider cannot fill. The loop has to read
    that as the end of the results rather than asking again forever, and the
    overshoot trim must not hide a record that was never returned.
    """
    if source == "openalex":
        _serve_openalex(wire, total=held)
        results = api_openalex.OpenAlexClient().search("quantum", max_results=500)
    else:
        _serve_doaj(wire, total=held)
        results = api_doaj.DoajClient().search("open access", max_results=500)

    assert len(results) == held
    assert len({r.external_id for r in results}) == held
    assert len(wire.calls) == 2  # the full page, then the short one that ends it


# ---------------------------------------------------------------------------
# 4. The completion email reads the column the row actually has
# ---------------------------------------------------------------------------

_SMTP = {"host": "smtp.test", "port": 587, "username": "u", "password": "p",
         "recipient": "r@test", "sender": "s@test"}


def _body(message) -> str:
    """The plain-text part, decoded: a non-ASCII em dash makes it base64."""
    return message.get_payload()[0].get_payload(decode=True).decode("utf-8")


def test_completion_email_reports_the_recorded_new_result_count(tmp_path, monkeypatch):
    """The assertion that was missing while every scheduled email said zero.

    The row is built by the real schema and read back by the same
    ``get_execution_by_id`` the delivery queue uses, so the column name in the
    email is checked against the column name in the table rather than against
    a dict a test wrote.
    """
    db_path = tmp_path / "corpus.db"
    database.init_db(str(db_path))
    conn = database.get_connection(str(db_path))
    exec_id = database.insert_execution(conn, {
        "execution_type": "automated_sweep",
        "parameters": "{}",
        "start_time": "2026-10-18T08:00:00",
    })
    database.update_execution_status(
        conn, exec_id, "completed",
        end_time="2026-10-18T08:04:00", result_count=31, new_result_count=7,
    )
    execution = database.get_execution_by_id(conn, exec_id)
    assert "new_count" not in execution, (
        "the executions row has no new_count column; that is the whole defect")

    sent: list = []
    monkeypatch.setattr(email_notifier, "send_email",
                        lambda smtp, message: sent.append(message))
    email_sender.send_routine_completion_email(
        routine={"id": 1, "name": "Daily ML"},
        execution=execution,
        smtp_config=dict(_SMTP),
    )

    assert len(sent) == 1
    assert "Total results: 31" in _body(sent[0])
    assert "New results: 7" in _body(sent[0])


def test_completion_email_still_accepts_the_old_key(monkeypatch):
    """A caller that hands over ``new_count`` is not broken by the fix.

    ``sweep_engine._run`` returns a dict under that name. It does not reach
    this function today, and keeping the fallback costs one ``or`` rather than
    a second bug the day something routes it here.
    """
    sent: list = []
    monkeypatch.setattr(email_notifier, "send_email",
                        lambda smtp, message: sent.append(message))
    email_sender.send_routine_completion_email(
        routine={"id": 1, "name": "Daily ML"},
        execution={"status": "completed", "result_count": 12, "new_count": 5},
        smtp_config=dict(_SMTP),
    )

    assert "New results: 5" in _body(sent[0])
