"""What arXiv is asked.

**Every word must match.** arXiv reads `all:graph neural` as `all:graph OR
all:neural` (331,422 papers on October 30, 2026, against 21,136 for the AND),
and a date window appended to it bound only the last word. The client sent
`all:{query}`, so every multi-word search and watch over arXiv matched papers
with any one of its words, from any year, while the catalog said all of them.
The string the client sends is asserted here for every shape a query takes,
and once more after travelling from a watch's stored keywords through the
engine. ``test_a_two_word_query_counts_what_the_and_counts`` is the live half.
"""

from __future__ import annotations

import re
import time

import pytest

from implementation_scripts import api_arxiv

_FEED_OPEN = "<feed xmlns='http://www.w3.org/2005/Atom'>"
_EMPTY_FEED = _FEED_OPEN + "</feed>"


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
        response = real("GET", api_arxiv._ARXIV_API_URL, params={
            "search_query": search_query, "start": 0, "max_results": 1,
        }, rate_limiter=api_arxiv._RATE_LIMITER)
        assert response.status_code == 200, response.status_code
        return total(response.text)

    assert replies, "the client sent nothing"
    sent = total(replies[0])
    both = asked(f"all:graph AND all:neural AND {window}")
    either = asked(f"(all:graph OR all:neural) AND {window}")

    assert sent == both, (sent, both, either)
    assert both < either, (both, either)
