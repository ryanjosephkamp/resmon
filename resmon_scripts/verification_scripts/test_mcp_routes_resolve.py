"""Every path the MCP server calls resolves against a route the app really has.

**This was a manual act three times and is a test once.** Contract amendments
v1.1, v1.2 and v1.3 each say "every route the server calls was re-checked
against the running app while this amendment was written" — and the reason they
say it is v1.1, where three of the contract's rows named endpoints or arguments
that did not exist as written and the tools built against them failed for every
input. A check a person performs at freeze time is a check that has to be
re-performed at the next freeze and can be quietly skipped; this file performs
it on every run.

It is the same lesson as ``routes.ts`` on the renderer side: the denominator has
to be a list in the code, not a list in someone's head. Here the denominator is
``mcp_server.TOOLS`` for the calls and ``resmon.app.routes`` for the answers, and
neither is written out by hand.

Hermetic: no socket is opened. The tools are driven through a recording double
that answers nothing, because what is under test is the *address* each tool
sends to, not what comes back.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import mcp_server as mcp  # noqa: E402
import resmon as resmon_mod  # noqa: E402,F401

BASE = "http://127.0.0.1:8742"

# Arguments chosen to reach *every* path each tool can reach, not just one.
# A tool with several endpoints behind it gets several entries: that is why
# ``export_references`` and ``get_analytics`` are lists of six and two.
# Iterated against ``mcp.TOOLS``, so a new tool with no entry here is a
# KeyError rather than a silent gap.
TOOL_ARGS: dict[str, list[dict]] = {
    "health": [{}],
    "search_corpus": [{"query": "x"}],
    "find_similar": [{"doc_id": 1}],
    "list_sources": [{}],
    "list_routines": [{}],
    "get_routine": [{"routine_id": 1}],
    "list_executions": [{}],
    "get_execution": [{"exec_id": 1}],
    "get_execution_results": [{"exec_id": 1}],
    "get_search_record": [{"exec_id": 1}],
    "explain_match": [{"doc_id": 1}],
    "get_paper_lifecycle": [{"doc_id": 1}],
    "get_analytics": [{"view": v} for v in sorted(mcp._ANALYTICS_VIEWS)],
    "get_watchdog_findings": [{}],
    "export_references": [{"exec_id": 1, "format": "bibtex"},
                          {"doc_ids": [1], "format": "bibtex"}],
    "run_sweep": [{"query": "x", "sources": ["arxiv"]}],
    "create_routine": [{"name": "n", "keywords": ["a"], "sources": ["arxiv"],
                        "schedule": "0 8 * * *"}],
    "run_routine": [{"routine_id": 1}],
    "activate_routine": [{"routine_id": 1}],
    "deactivate_routine": [{"routine_id": 1}],
    "update_settings": [{"group": g, "settings": {"anything": "x"}}
                        for g in mcp.SETTINGS_GROUPS],
}


def _calls() -> list[tuple[str, str]]:
    """Drive every tool and collect the (method, path) pairs it sent."""
    seen: list[tuple[str, str]] = []

    def _request(method, url, **kwargs):
        path = url[len(BASE):].partition("?")[0]
        seen.append((method, path))
        # 200 with a shape each tool can walk far enough to keep going. What
        # matters is that the *next* request also gets recorded -- update_settings
        # sends three, and a double that 404'd would hide two of them.
        return httpx.Response(200, json={"anything": "x", "id": 1},
                              request=httpx.Request(method, url))

    mcp.backend._base = BASE
    try:
        with patch.object(mcp.httpx, "request", side_effect=_request):
            for tool in mcp.TOOLS:
                for args in TOOL_ARGS[tool["name"]]:
                    mcp.call_tool(tool["name"], args)
    finally:
        mcp.backend._base = None
    return seen


def _route_matchers() -> list[tuple[set[str], re.Pattern]]:
    from resmon import app  # noqa: PLC0415

    out = []
    for route in app.routes:
        regex = getattr(route, "path_regex", None)
        methods = getattr(route, "methods", None)
        if regex is not None and methods:
            out.append((set(methods), regex))
    return out


def test_every_tool_has_arguments_that_reach_its_endpoints():
    """The denominator is TOOLS. A tool added without an entry fails here."""
    assert set(TOOL_ARGS) == {t["name"] for t in mcp.TOOLS}


def test_every_path_the_mcp_server_calls_is_a_route_the_app_has():
    """The v1.1 defect, as a test rather than as a promise in a document."""
    matchers = _route_matchers()
    unresolved = []
    for method, path in _calls():
        if not any(method in methods and regex.fullmatch(path)
                   for methods, regex in matchers):
            unresolved.append(f"{method} {path}")
    assert unresolved == [], (
        "the MCP server calls addresses the app does not serve — the failure "
        f"contract v1.1 shipped, found again: {sorted(set(unresolved))}"
    )


def test_the_contract_states_the_right_number_of_pairs():
    """The amendment quotes a count. Counts in prose drift; this one cannot.

    Not decoration: the sentence "all 25 resolve" is only meaningful if 25 is
    the number of pairs there are. When this fails, the contract's amendment is
    the thing to correct.
    """
    pairs = sorted(set(_calls()))
    assert len(pairs) == 39, (
        f"{len(pairs)} distinct method-and-path pairs, and the v2.0 amendment "
        f"says 39:\n" + "\n".join(f"  {m} {p}" for m, p in pairs)
    )


@pytest.mark.parametrize("method,path", sorted(set(_calls())))
def test_each_pair_resolves(method, path):
    """One case per pair, so a failure names the address rather than a count."""
    matchers = _route_matchers()
    assert any(method in methods and regex.fullmatch(path)
               for methods, regex in matchers), f"{method} {path} is not a route"
