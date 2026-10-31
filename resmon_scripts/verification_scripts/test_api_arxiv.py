"""What arXiv is asked, and how long resmon waits when arXiv says to wait.

Two properties of one client, both of which failed quietly.

**Every word must match.** arXiv reads `all:graph neural` as `all:graph OR
all:neural` (331,422 papers on October 30, 2026, against 21,136 for the AND),
and a date window appended to it bound only the last word. The client sent
`all:{query}`, so every multi-word search and watch over arXiv matched papers
with any one of its words, from any year, while the catalog said all of them.
The string the client sends is asserted here for every shape a query takes,
and once more after travelling from a watch's stored keywords through the
engine. ``test_a_two_word_query_counts_what_the_and_counts`` is the live half.

**A 429 is waited out.** arXiv asks for one request every three seconds and
answers a busier caller with 429. ``safe_request``'s shared ladder spent its
four attempts in about ten seconds, and a nightly watch failed twice in one
week. The ladder is driven here against a real loopback server, with the wait
replaced by a recorder so no test sleeps.
"""

from __future__ import annotations

import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from implementation_scripts import api_arxiv, api_base, config, zero_reason
from implementation_scripts.api_base import NormalizedResult, ServerCooldownActive

_FEED_OPEN = "<feed xmlns='http://www.w3.org/2005/Atom'>"
_EMPTY_FEED = _FEED_OPEN + "</feed>"
_ONE_ENTRY = (
    _FEED_OPEN
    + "<entry><id>http://arxiv.org/abs/2410.00001v1</id>"
    "<title>Graph neural networks</title><summary>An abstract.</summary>"
    "<published>2024-10-01T00:00:00Z</published>"
    "<author><name>A. Author</name></author></entry></feed>"
)


# ---------------------------------------------------------------------------
# The query string
# ---------------------------------------------------------------------------

_JAN = "submittedDate:[202401010000 TO 202401312359]"


@pytest.mark.parametrize(("query", "date_from", "date_to", "expected"), [
    # One word, as before.
    ("graph", None, None, "all:graph"),
    # Several words: each its own term, all of them required.
    ("graph neural networks", None, None,
     "all:graph AND all:neural AND all:networks"),
    ("  graph   neural  ", None, None, "all:graph AND all:neural"),
    # A quoted phrase stays one exact phrase, alone or beside words.
    ('"graph neural networks"', None, None, 'all:"graph neural networks"'),
    ('"graph neural" transformer', None, None,
     'all:"graph neural" AND all:transformer'),
    # A quote with no partner is dropped rather than sent.
    ('graph "neural', None, None, "all:graph AND all:neural"),
    # Stop words are not required; arXiv does not index them. A phrase keeps them.
    ("theory of mind", None, None, "all:theory AND all:mind"),
    ("graph and neural", None, None, "all:graph AND all:neural"),
    ('"theory of mind"', None, None, 'all:"theory of mind"'),
    # A query of nothing but stop words is still asked for what it says.
    ("the", None, None, "all:the"),
    # A field prefix opening the query: sent whole, as the entity search needs.
    ('au:"Yoshua Bengio"', None, None, 'au:"Yoshua Bengio"'),
    ("ti:graph neural", None, None, "ti:graph neural"),
    # arXiv's syntax anywhere else: sent as typed, behind the default field.
    ("neural au:Bengio", None, None, "all:neural au:Bengio"),
    ("graph OR neural", None, None, "all:graph OR neural"),
    ("graph AND neural", None, None, "all:graph AND neural"),
    ("graph ANDNOT neural", None, None, "all:graph ANDNOT neural"),
    ("graph NOT neural", None, None, "all:graph NOT neural"),
    # Dates: appended last, and the window binds every word.
    ("graph", "2024-01-01", "2024-01-31", f"all:graph AND {_JAN}"),
    ("graph neural", "2024-01-01", "2024-01-31",
     f"all:graph AND all:neural AND {_JAN}"),
    ("graph", "2024-01-01", None,
     "all:graph AND submittedDate:[202401010000 TO 209912312359]"),
    ("graph", None, "2024-01-31",
     "all:graph AND submittedDate:[190001010000 TO 202401312359]"),
    # A query sent as typed is grouped first, or the window binds its last term.
    ("graph OR neural", "2024-01-01", "2024-01-31",
     f"(all:graph OR neural) AND {_JAN}"),
    ('au:"Yoshua Bengio"', "2024-01-01", "2024-01-31",
     f'(au:"Yoshua Bengio") AND {_JAN}'),
    ("au:Bengio", "2024-01-01", "2024-01-31", f"au:Bengio AND {_JAN}"),
])
def test_the_search_query_arxiv_is_sent(query, date_from, date_to, expected):
    assert api_arxiv._search_query(query, date_from, date_to) == expected


def test_search_sends_the_built_query(monkeypatch):
    """The builder is what reaches the request, page after page."""
    sent: list[dict] = []

    class _Reply:
        status_code = 200
        text = _EMPTY_FEED

    def record(method, url, **kwargs):
        sent.append(dict(kwargs.get("params") or {}))
        return _Reply()

    monkeypatch.setattr(api_arxiv, "safe_request", record)
    api_arxiv.ArxivClient().search(
        "graph neural", date_from="2024-01-01", date_to="2024-01-31", max_results=5)

    assert [p["search_query"] for p in sent] == [
        f"all:graph AND all:neural AND {_JAN}"]


# ---------------------------------------------------------------------------
# A watch's keywords and a search's terms reach arXiv as the same query
# ---------------------------------------------------------------------------

@pytest.fixture
def app_client():
    import resmon as resmon_mod  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415

    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    return TestClient(resmon_mod.app)


def _asked_of_arxiv(app_client, monkeypatch, tmp_path, start) -> list[str]:
    """Run whatever ``start`` begins and return each `search_query` arXiv got."""
    from unittest.mock import patch  # noqa: PLC0415

    sent: list[str] = []

    class _Reply:
        status_code = 200
        text = _EMPTY_FEED

    def record(method, url, **kwargs):
        sent.append((kwargs.get("params") or {}).get("search_query"))
        return _Reply()

    monkeypatch.setattr(api_arxiv, "safe_request", record)
    reports = tmp_path / "reports"
    reports.mkdir(exist_ok=True)
    with patch("implementation_scripts.sweep_engine.REPORTS_DIR", reports):
        exec_id = start()
        for _ in range(120):
            run = app_client.get(f"/api/executions/{exec_id}").json()
            if run["status"] in ("completed", "failed", "cancelled"):
                break
            time.sleep(0.1)
    assert run["status"] in ("completed", "failed"), run
    return sent


def test_a_watch_and_a_search_with_the_same_keywords_ask_arxiv_the_same(
    app_client, monkeypatch, tmp_path,
):
    """Followed from the stored parameters to the request, through the engine.

    Every writer of a watch (both watch editors, the MCP server's
    `create_routine` and the command line's `watch add`) stores the keyword
    list and the same words joined with spaces as `query`, and the engine
    hands `query` to the client. So the keyword list of a watch and the terms
    of a search mean the same thing at arXiv: every word.
    """
    keywords = ["graph neural", "networks"]

    made = app_client.post("/api/routines", json={
        "name": "Graphs", "schedule_cron": "0 8 * * *", "is_active": False,
        "parameters": {"repositories": ["arxiv"], "keywords": keywords,
                       "query": " ".join(keywords), "max_results": 5},
    })
    assert made.status_code == 201, made.text
    routine_id = made.json()["id"]

    def run_watch() -> int:
        resp = app_client.post(f"/api/routines/{routine_id}/run")
        assert resp.status_code in (200, 202), resp.text
        return resp.json()["execution_id"]

    def run_search() -> int:
        resp = app_client.post("/api/search/sweep", json={
            "repositories": ["arxiv"], "query": " ".join(keywords),
            "keywords": keywords, "max_results": 5,
        })
        assert resp.status_code == 200, resp.text
        return resp.json()["execution_id"]

    watched = _asked_of_arxiv(app_client, monkeypatch, tmp_path, run_watch)
    searched = _asked_of_arxiv(app_client, monkeypatch, tmp_path, run_search)

    assert watched == searched == ["all:graph AND all:neural AND all:networks"]


# ---------------------------------------------------------------------------
# Waiting out a 429 or a 503
# ---------------------------------------------------------------------------


class _Script(BaseHTTPRequestHandler):
    """Answers each request with the next reply in the server's script."""

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's spelling
        server = self.server
        with server.lock:
            server.hits += 1
            status, headers, body = (
                server.script.pop(0) if server.script else server.otherwise)
        payload = body.encode("utf-8")
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("Content-Type", "application/atom+xml")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class _Limiter:
    """Admits at once, and can be told to refuse once with a cooldown."""

    def __init__(self):
        self.cooldown: float | None = None
        self.deferred: list[float] = []

    def acquire(self, *, deadline=None):
        if self.cooldown is not None:
            seconds, self.cooldown = self.cooldown, None
            raise ServerCooldownActive(seconds, 429)

    def defer(self, seconds, *, status_code=429):
        self.deferred.append(seconds)


@pytest.fixture
def arxiv(monkeypatch):
    """arXiv on loopback, a limiter that never sleeps, and a recorded wait."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Script)
    server.lock = threading.Lock()
    server.hits = 0
    server.script = []
    server.otherwise = (200, {}, _ONE_ENTRY)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    waits: list[float] = []
    limiter = _Limiter()
    monkeypatch.setattr(api_arxiv, "_ARXIV_API_URL",
                        f"http://127.0.0.1:{server.server_address[1]}/api/query")
    monkeypatch.setattr(api_arxiv, "_RATE_LIMITER", limiter)
    monkeypatch.setattr(api_arxiv, "_wait", waits.append)
    # safe_request's own ladder still runs for a 500; nothing in it may sleep.
    monkeypatch.setattr(config, "DEFAULT_BACKOFF_BASE", 0.0)
    api_base.reset_search_outcome()
    server.waits = waits
    server.limiter = limiter
    try:
        yield server
    finally:
        api_base.reset_search_outcome()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _search() -> list[NormalizedResult]:
    return api_arxiv.ArxivClient().search("graph neural", max_results=1)


def test_a_429_without_retry_after_is_waited_out_from_five_seconds_doubling(arxiv):
    arxiv.script = [(429, {}, "")] * 3

    results = _search()

    assert [r.external_id for r in results] == ["2410.00001v1"]
    assert arxiv.waits == [5.0, 10.0, 20.0]
    assert arxiv.hits == 4
    snapshot = api_base.search_outcome().snapshot()
    assert snapshot["attempts"] == 4
    assert snapshot["waited_seconds"] == 35.0
    # A ladder that recovered lost nothing, and is not called partial.
    assert zero_reason.terminal_issue(snapshot) is None


def test_retry_after_is_honored_when_it_asks_for_longer(arxiv):
    arxiv.script = [(429, {"Retry-After": "30"}, ""), (503, {"Retry-After": "45"}, "")]

    results = _search()

    assert len(results) == 1
    assert arxiv.waits == [30.0, 45.0]
    # And it still reaches the shared limiter, so every other arXiv search
    # running at the same time waits as well.
    assert arxiv.limiter.deferred == [30.0, 45.0]


def test_a_retry_after_shorter_than_the_backoff_does_not_shorten_it(arxiv):
    arxiv.script = [(429, {"Retry-After": "1"}, "")]

    assert len(_search()) == 1
    assert arxiv.waits == [5.0]


def test_a_429_that_outlasts_the_patience_is_recorded_with_the_time_waited(arxiv):
    arxiv.otherwise = (429, {}, "")

    assert _search() == []

    # 5 + 10 + 20 + 40 + 80 = 155 seconds; the next wait, 160, would pass
    # three minutes, so the sixth answer is the one the run records.
    assert arxiv.waits == [5.0, 10.0, 20.0, 40.0, 80.0]
    assert arxiv.hits == 6
    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert (reason, detail) == ("upstream_failure", {
        "detail": "rate_limited", "status": 429, "attempts": 6,
        "waited_seconds": 155,
    })
    assert zero_reason.sentence("arXiv", reason, detail) == (
        "arXiv could not be queried: HTTP 429 after 6 attempts, with 155 "
        "seconds of waiting between them. This is not a zero — the source "
        "did not answer."
    )


def test_a_503_is_waited_out_the_same_way(arxiv):
    arxiv.script = [(503, {}, "")] * 2

    assert len(_search()) == 1
    assert arxiv.waits == [5.0, 10.0]


def test_a_retry_after_beyond_the_patience_is_not_waited_for(arxiv):
    """An hour is not waited; the 429 is recorded at once, with no wait."""
    arxiv.otherwise = (429, {"Retry-After": "3600"}, "")

    assert _search() == []
    assert arxiv.waits == []
    assert arxiv.hits == 1
    reason, detail = zero_reason.derive(api_base.search_outcome().snapshot())
    assert (reason, detail) == ("upstream_failure", {
        "detail": "rate_limited", "status": 429, "attempts": 1})


def test_a_cooldown_another_search_was_given_is_waited_out(arxiv):
    """The shared limiter refuses with another search's Retry-After; it is waited."""
    arxiv.limiter.cooldown = 40.0

    assert len(_search()) == 1
    assert arxiv.waits == [40.0]
    assert arxiv.hits == 1


def test_other_server_errors_keep_the_shared_quick_retry(arxiv):
    """A 500 is still safe_request's to retry, at once and without patience."""
    arxiv.script = [(500, {}, "")]

    assert len(_search()) == 1
    assert arxiv.waits == []
    assert arxiv.hits == 2


def test_the_patience_is_one_budget_for_the_whole_search(arxiv):
    """A second page that meets a 429 spends what the first left over."""
    page = _FEED_OPEN + "".join(
        f"<entry><id>http://arxiv.org/abs/2410.{n:05d}v1</id><title>T{n}</title></entry>"
        for n in range(100)) + "</feed>"
    arxiv.script = [(429, {}, "")] * 4 + [(200, {}, page)]
    arxiv.otherwise = (429, {}, "")

    results = api_arxiv.ArxivClient().search("graph neural", max_results=101)

    # 5 + 10 + 20 + 40 on the first page leaves 105 seconds of 180: the
    # second page waits 80 more (the ladder keeps doubling) and then stops,
    # because 160 would pass the budget. The 100 records already read stay.
    assert arxiv.waits == [5.0, 10.0, 20.0, 40.0, 80.0]
    assert len(results) == 100


# ---------------------------------------------------------------------------
# Live
# ---------------------------------------------------------------------------

_TOTAL = re.compile(r"<opensearch:totalResults[^>]*>(\d+)<")


@pytest.mark.live_network
def test_a_two_word_query_counts_what_the_and_counts():
    """arXiv itself counts a two-word search as the AND of its words.

    One closed month, so the three totals cannot drift between the requests:
    the client's own request, the explicit AND and the explicit OR, all through
    the module's limiter, three seconds apart. The OR is asked so that a pass
    means something: the two words must not be a pair whose AND and OR agree.
    """
    window = "submittedDate:[202401010000 TO 202401312359]"
    replies: list[str] = []
    real = api_arxiv.safe_request

    def keep(method, url, **kwargs):
        response = real(method, url, **kwargs)
        replies.append(response.text)
        return response

    api_arxiv.safe_request = keep
    try:
        api_arxiv.ArxivClient().search(
            "graph neural", date_from="2024-01-01", date_to="2024-01-31", max_results=1)
    finally:
        api_arxiv.safe_request = real

    def total(text: str) -> int:
        match = _TOTAL.search(text)
        assert match, text[:500]
        return int(match.group(1))

    def asked(search_query: str) -> int:
        # Through the client's own ladder, so a busy arXiv is waited out here
        # as it is in a run, rather than failing the comparison.
        response = api_arxiv._patient_request({
            "search_query": search_query, "start": 0, "max_results": 1,
        }, api_arxiv._Patience())
        assert response.status_code == 200, response.status_code
        return total(response.text)

    assert replies, "the client sent nothing"
    sent = total(replies[0])
    both = asked(f"all:graph AND all:neural AND {window}")
    either = asked(f"(all:graph OR all:neural) AND {window}")

    assert sent == both, (sent, both, either)
    assert both < either, (both, either)


def test_a_stand_in_for_arxiv_can_shorten_its_patience(monkeypatch):
    """A test serving arXiv's refusals sets the budget short; it never lengthens it."""
    monkeypatch.setenv("RESMON_ARXIV_PATIENCE_SECONDS", "8")
    patience = api_arxiv._Patience()
    assert patience.allows(5)
    patience.waited = 5
    assert not patience.allows(10)
    monkeypatch.setenv("RESMON_ARXIV_PATIENCE_SECONDS", "1000")
    assert api_arxiv._patience_seconds() == 180.0
    monkeypatch.setenv("RESMON_ARXIV_PATIENCE_SECONDS", "soon")
    assert api_arxiv._patience_seconds() == 180.0
    monkeypatch.delenv("RESMON_ARXIV_PATIENCE_SECONDS")
    assert api_arxiv._patience_seconds() == 180.0
