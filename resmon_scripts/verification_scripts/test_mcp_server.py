"""The MCP server — contract v1 conformance.

Tests speak the real JSON-RPC protocol at ``handle_message`` and stub the HTTP
layer, because what matters is the surface a harness sees: the tool list, the
shapes, and above all the guarantees the contract states as guarantees rather
than defaults.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import mcp_server as mcp  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_backend():
    mcp.backend._base = None
    mcp.backend._tried = []
    yield
    mcp.backend._base = None


def _payload(result: dict) -> dict:
    """Unwrap the MCP text-content envelope back into the tool's own JSON."""
    return json.loads(result["content"][0]["text"])


def _stub(routes: dict, base: str = "http://127.0.0.1:8742",
          formats: tuple[str, ...] = ("bibtex", "ris", "csv", "json")):
    """Serve canned JSON for exact paths; anything else 404s.

    **This double honours the query string, and that is the point of it.**

    It used to strip ``?...`` before matching, which made it structurally
    incapable of observing the parameter a real bug lived in: the MCP server
    asked the reference endpoint for ``format=json`` when no JSON renderer
    existed, the stub discarded the parameter and returned canned JSON anyway,
    and the suite stayed green while the tool failed for every execution in
    production.

    So *format* is validated here the way the backend validates it -- an
    unknown one is HTTP 400 with the backend's own wording -- and *params*
    passed to a request are recorded for assertion. A test double that cannot
    fail the way the real dependency fails is not testing the integration.
    """
    mcp.backend._base = base
    seen: list[dict] = []

    def _request(method, url, **kwargs):
        raw_path = url[len(base):]
        path, _, query = raw_path.partition("?")
        params = dict(kwargs.get("params") or {})
        if query:
            for pair in query.split("&"):
                key, _, value = pair.partition("=")
                params.setdefault(key, value)
        seen.append({"method": method, "path": path, "params": params})

        fmt = params.get("format")
        if fmt is not None and fmt not in formats:
            return httpx.Response(
                400,
                json={"detail": f"Unknown export format {fmt!r}. Expected one of: "
                                f"{', '.join(sorted(formats))}."},
                request=httpx.Request(method, url),
            )

        entry = routes.get((method, path)) or routes.get(path)
        if entry is None:
            return httpx.Response(404, json={"detail": "Not found"},
                                  request=httpx.Request(method, url))
        status, body = entry if isinstance(entry, tuple) else (200, entry)
        if isinstance(body, str):
            return httpx.Response(status, text=body,
                                  request=httpx.Request(method, url))
        return httpx.Response(status, json=body,
                              request=httpx.Request(method, url))

    patcher = patch.object(mcp.httpx, "request", side_effect=_request)
    patcher.seen = seen  # type: ignore[attr-defined]
    return patcher


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------

def test_initialize_reports_the_contract_version():
    resp = mcp.handle_message({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert resp["result"]["serverInfo"]["name"] == "resmon"
    assert resp["result"]["serverInfo"]["version"] == mcp.CONTRACT_VERSION


def test_initialized_notification_gets_no_reply():
    """A notification has no id; answering one is a protocol error."""
    assert mcp.handle_message({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None


def test_tools_list_matches_the_contract():
    resp = mcp.handle_message({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    names = {t["name"] for t in resp["result"]["tools"]}
    assert names == {
        "health", "search_corpus", "find_similar", "list_sources", "list_routines",
        "get_routine", "list_executions", "get_execution", "get_execution_results",
        "get_search_record", "explain_match", "get_paper_lifecycle",
        "get_analytics", "get_watchdog_findings", "export_references",
        "run_sweep", "create_routine", "run_routine",
        "activate_routine", "deactivate_routine", "update_settings",
    }
    # 18 through contract v1.3. v2.0 (phase 2.0a) adds the three above and marks
    # every write tool ``requires_confirmation`` — a major bump, because a
    # caller that ignores that flag is running writes the contract says a person
    # approves first.
    assert len(names) == 21
    # v2.1 (phase 2.0b) is additive and adds no tool: ``update_settings``'s
    # group allowlist gains ``assistant``, a group v2.0 shipped unreachable and
    # undecided. The count is unchanged and the version is not.
    assert mcp.CONTRACT_VERSION == "2.1"


def test_every_tool_declares_whether_it_needs_confirmation():
    """The flag is emitted for every tool, true *and* false.

    A harness that has to infer "no flag means safe" is one release away from
    inferring it about a tool that grew teeth. And because the assistant builds
    its pre-approved set from ``READ_TOOLS``, a tool that forgets to declare
    lands in the pre-approved set — so this is the guard that makes
    confirmation a decision rather than a default.
    """
    resp = mcp.handle_message({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    for tool in resp["result"]["tools"]:
        assert isinstance(tool["requires_confirmation"], bool), tool["name"]

    flagged = {t["name"] for t in resp["result"]["tools"] if t["requires_confirmation"]}
    assert flagged == mcp.WRITE_TOOLS
    assert flagged == {
        "run_sweep", "create_routine", "run_routine",
        "activate_routine", "deactivate_routine", "update_settings",
    }
    assert mcp.READ_TOOLS | mcp.WRITE_TOOLS == {t["name"] for t in mcp.TOOLS}
    assert not (mcp.READ_TOOLS & mcp.WRITE_TOOLS)


def test_no_read_tool_reaches_the_backend_with_a_writing_method():
    """The read/write split is a claim about HTTP verbs, so check the verbs.

    ``READ_TOOLS`` is what the assistant pre-approves without asking anyone, so
    "read" has to mean something the code enforces rather than something the
    name suggests. Every read tool is called against a stub that answers
    everything, and the methods it actually used are asserted.
    """
    calls_by_tool: dict[str, list[str]] = {}
    for name in sorted(mcp.READ_TOOLS):
        methods: list[str] = []
        for args in _READ_TOOL_ARGS[name]:
            stub = _stub({})        # 404s everything; the method is still recorded
            with stub:
                mcp.call_tool(name, args)
            methods += [c["method"] for c in stub.seen]
        calls_by_tool[name] = methods

    for name, methods in calls_by_tool.items():
        assert methods, f"{name} made no request at all"
        offending = [m for m in methods if m not in ("GET", "POST")]
        assert not offending, f"{name} used {offending}"

    # The two read tools that POST do so because the backend's search and
    # bulk-export routes take a body. Anything else POSTing would be a write
    # wearing a read's name, so the exception is named rather than allowed.
    # ``export_references`` reaches both of its endpoints here, which is why
    # its entry below has two argument sets: the by-execution path is a GET and
    # only the by-document-ids path posts.
    posting = {n for n, ms in calls_by_tool.items() if "POST" in ms}
    assert posting == {"search_corpus", "export_references"}


# Arguments that make each read tool issue exactly one request. Derived
# coverage: the test above iterates ``READ_TOOLS``, so a read tool with no
# entry here raises a KeyError rather than being skipped.
_READ_TOOL_ARGS: dict[str, list[dict]] = {
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
    "get_analytics": [{"view": "overview"}],
    "get_watchdog_findings": [{}],
    "export_references": [{"exec_id": 1, "format": "bibtex"},
                          {"doc_ids": [1, 2], "format": "bibtex"}],
}


# ---------------------------------------------------------------------------
# The v2.0 tools
# ---------------------------------------------------------------------------

def test_activate_and_deactivate_hit_the_endpoints_that_exist():
    for tool, path in (("activate_routine", "/api/routines/4/activate"),
                       ("deactivate_routine", "/api/routines/4/deactivate")):
        stub = _stub({("POST", path): {"id": 4, "is_active": tool == "activate_routine"}})
        with stub:
            body = _payload(mcp.call_tool(tool, {"routine_id": 4}))
        assert stub.seen[0] == {"method": "POST", "path": path, "params": {}}
        assert body["id"] == 4


def test_update_settings_sends_only_the_keys_it_was_given():
    """P11. The PUT carries the named keys and nothing else.

    The backend's own PUT is a partial update, so a tool that sent the whole
    group back would still *look* correct — until a key the model had not
    thought about was rewritten with a stale value read seconds earlier. What
    is asserted is the request body, not the outcome.
    """
    group = {"ai_provider": "claude_cli", "ai_model": "opus", "ai_effort": "high"}
    changed = dict(group, ai_effort="low")
    stub = _stub({("GET", "/api/settings/ai"): group,
                  ("PUT", "/api/settings/ai"): {"success": True}})
    stub_get_after = changed

    calls: list = []

    def _sequence(method, url, **kwargs):
        calls.append((method, url, kwargs.get("json")))
        if method == "PUT":
            return httpx.Response(200, json={"success": True},
                                  request=httpx.Request(method, url))
        body = group if len([c for c in calls if c[0] == "GET"]) == 1 else stub_get_after
        return httpx.Response(200, json=body, request=httpx.Request(method, url))

    mcp.backend._base = "http://127.0.0.1:8742"
    with patch.object(mcp.httpx, "request", side_effect=_sequence):
        body = _payload(mcp.call_tool(
            "update_settings", {"group": "ai", "settings": {"ai_effort": "low"}}))

    put = next(c for c in calls if c[0] == "PUT")
    assert put[2] == {"settings": {"ai_effort": "low"}}
    assert body["changed"] == {"ai_effort": {"from": "high", "to": "low"}}
    assert body["unchanged_key_count"] == 2


def test_update_settings_refuses_a_credential_shaped_key_before_any_request():
    """Structural: the tool cannot be *asked* for a secret.

    Refused on the key's name, before the group is even fetched — so this holds
    for a credential key the app does not have yet as much as for one it does.
    """
    stub = _stub({("GET", "/api/settings/ai"): {"ai_provider": "x"}})
    with stub:
        result = mcp.call_tool("update_settings", {
            "group": "ai", "settings": {"anthropic_api_key": "sk-real-value"}})
    body = _payload(result)
    assert result["isError"]
    assert body["error"] == "invalid_argument"
    assert body["detail"]["refused_keys"] == ["anthropic_api_key"]
    assert stub.seen == [], "a refused key must not reach the backend at all"
    assert "sk-real-value" not in json.dumps(body), (
        "the refusal echoed the value it was refusing"
    )


@pytest.mark.parametrize("key", [
    "api_key", "ANTHROPIC_TOKEN", "smtp_password", "client_secret",
    "my_passphrase", "credential_store", "auth_header",
])
def test_every_credential_shaped_word_is_refused(key):
    stub = _stub({})
    with stub:
        result = mcp.call_tool(
            "update_settings", {"group": "ai", "settings": {key: "value"}})
    assert result["isError"]
    assert stub.seen == []


def test_update_settings_refuses_a_group_that_is_not_on_the_allowlist():
    for group in ("credentials", "advanced", "execution", ""):
        stub = _stub({})
        with stub:
            result = mcp.call_tool(
                "update_settings", {"group": group, "settings": {"a": "b"}})
        assert result["isError"], group
        assert stub.seen == [], group


def test_update_settings_refuses_an_unknown_key_rather_than_dropping_it():
    """The backend ignores keys outside the group. A tool must not.

    Right for a form, wrong for a tool: a caller told "success" for a key that
    was silently discarded has been lied to, and the assistant would report the
    change to the user as done.
    """
    stub = _stub({("GET", "/api/settings/ai"): {"ai_provider": "x", "ai_model": "y"}})
    with stub:
        result = mcp.call_tool(
            "update_settings", {"group": "ai", "settings": {"ai_provder": "z"}})
    body = _payload(result)
    assert result["isError"]
    assert body["detail"]["unknown_keys"] == ["ai_provder"]
    assert "ai_provider" in body["detail"]["group_keys"]
    assert not [c for c in stub.seen if c["method"] == "PUT"]


def test_update_settings_says_so_when_nothing_moved():
    """A no-op write reported as a change is an overclaim like any other."""
    group = {"ai_effort": "high"}
    stub = _stub({("GET", "/api/settings/ai"): group,
                  ("PUT", "/api/settings/ai"): {"success": True}})
    with stub:
        body = _payload(mcp.call_tool(
            "update_settings", {"group": "ai", "settings": {"ai_effort": "high"}}))
    assert body["changed"] == {}
    assert "Nothing changed" in body["detail"]


def test_every_tool_advertises_a_schema_and_description():
    resp = mcp.handle_message({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})
    for tool in resp["result"]["tools"]:
        assert tool["description"].strip()
        assert tool["inputSchema"]["type"] == "object"


def test_an_unknown_method_is_a_jsonrpc_error():
    resp = mcp.handle_message({"jsonrpc": "2.0", "id": 4, "method": "nope"})
    assert resp["error"]["code"] == -32601


def test_serve_round_trips_over_stdio():
    """The transport itself: newline-delimited JSON in, JSON out."""
    import io
    stdin = io.StringIO(
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}) + "\n"
        + json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"
        + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}) + "\n"
    )
    stdout = io.StringIO()
    mcp.serve(stdin, stdout)
    lines = [json.loads(l) for l in stdout.getvalue().splitlines() if l.strip()]
    assert [m["id"] for m in lines] == [1, 2]  # the notification got no reply


def test_unparseable_input_does_not_kill_the_server():
    import io
    stdin = io.StringIO(
        "{not json\n" + json.dumps({"jsonrpc": "2.0", "id": 9, "method": "ping"}) + "\n"
    )
    stdout = io.StringIO()
    mcp.serve(stdin, stdout)
    assert json.loads(stdout.getvalue().strip())["id"] == 9


# ---------------------------------------------------------------------------
# The guarantee: never a silent empty result when the app is closed
# ---------------------------------------------------------------------------

def test_backend_down_is_a_named_error_not_an_empty_list():
    """A harness told "you have no papers" would repeat that to the user."""
    def _boom(*a, **k):
        raise httpx.ConnectError("refused")

    with patch.object(mcp.httpx, "get", side_effect=_boom):
        result = mcp.call_tool("search_corpus", {"query": "x"})

    assert result["isError"] is True
    body = _payload(result)
    assert body["error"] == "backend_unavailable"
    assert "not running" in body["message"]
    assert body["detail"]["tried"]


def test_port_discovery_prefers_the_environment(monkeypatch):
    monkeypatch.setenv("RESMON_PORT", "9999")
    assert mcp._candidate_ports()[0] == 9999


def test_port_discovery_falls_back_to_the_default(monkeypatch, tmp_path):
    """Only when nothing names a port -- an older backend writes no port file."""
    monkeypatch.delenv("RESMON_PORT", raising=False)
    monkeypatch.setenv("RESMON_PORT_FILE", str(tmp_path / "absent.port"))
    import implementation_scripts.config as cfg
    monkeypatch.setattr(cfg, "PORT_FILE", tmp_path / "absent.port")
    assert mcp._candidate_ports() == [mcp.DEFAULT_PORT]


def test_a_named_port_is_never_widened_to_the_default(monkeypatch):
    """The bug this prevents attached the server to the launchd daemon.

    When a named port stopped answering, falling through to 8742 connected to a
    different process over a different database, and every tool then answered
    truthfully about the wrong corpus. Failing is the correct outcome.
    """
    monkeypatch.setenv("RESMON_PORT", "8791")
    assert mcp.DEFAULT_PORT not in mcp._candidate_ports()


def test_a_dead_named_port_is_backend_unavailable(monkeypatch, tmp_path):
    """Only the named port is tried, and nothing else is.

    ``PORT_FILE`` is pointed at a path that does not exist, because it is a
    *second* named source and a real one on disk makes ``tried`` two entries
    long. This test passed only because no port file happened to be sitting in
    the repo root; running the dev build puts one there and the assertion
    changed under it. A test whose result depends on a file nobody mentioned is
    not testing what its name says.
    """
    monkeypatch.setenv("RESMON_PORT", "8791")
    monkeypatch.setattr(
        "implementation_scripts.config.PORT_FILE", str(tmp_path / "absent.port"),
    )

    def _boom(*a, **k):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(mcp.httpx, "get", _boom)
    body = _payload(mcp.call_tool("search_corpus", {"query": "x"}))
    assert body["error"] == "backend_unavailable"
    assert body["detail"]["tried"] == ["http://127.0.0.1:8791"]


def test_a_candidate_is_confirmed_with_health_before_use(monkeypatch):
    """The default port is a guess; a dev build may hold it."""
    monkeypatch.setenv("RESMON_PORT", "9001")
    seen: list[str] = []

    def _get(url, **kwargs):
        seen.append(url)
        ok = "9002" in url
        return httpx.Response(200 if ok else 500,
                              json={"version": "1.8.2"},
                              request=httpx.Request("GET", url))

    monkeypatch.setattr(mcp.httpx, "get", _get)
    with patch.object(mcp, "_candidate_ports", return_value=[9001, 9002]):
        assert mcp.backend.base_url() == "http://127.0.0.1:9002"
    assert all(u.endswith("/api/health") for u in seen)


# ---------------------------------------------------------------------------
# The guarantee: no credential values, ever
# ---------------------------------------------------------------------------

def test_list_sources_reports_presence_never_a_value():
    with _stub({
        "/api/repositories/catalog": [{
            "slug": "core", "name": "CORE", "subject_coverage": "OA",
            "api_key_requirement": "required", "credential_name": "core_api_key",
            "attribution": "Powered by CORE", "attribution_requirement": "required",
        }],
        "/api/credentials": {"credentials": {
            "core_api_key": {"present": True, "status": "present",
                             "value": "sk-should-never-appear"}}},
    }):
        body = _payload(mcp.call_tool("list_sources", {}))

    source = body["sources"][0]
    assert source["credential_alias"] == "core_api_key"
    assert source["credential_status"] == "present"
    assert "sk-should-never-appear" not in json.dumps(body)


def test_list_sources_survives_an_unreadable_keyring():
    """The catalog is the answer; key status is a nicety."""
    with _stub({
        "/api/repositories/catalog": [{"slug": "arxiv", "name": "arXiv"}],
        "/api/credentials": (500, {"detail": "keyring timed out"}),
    }):
        body = _payload(mcp.call_tool("list_sources", {}))
    assert body["sources"][0]["slug"] == "arxiv"
    assert body["sources"][0]["credential_status"] is None


# ---------------------------------------------------------------------------
# The guarantee: token efficiency is a contract term
# ---------------------------------------------------------------------------

def test_list_executions_pages_and_caps():
    rows = [{"id": i, "status": "completed"} for i in range(500)]
    with _stub({"/api/executions": rows}):
        body = _payload(mcp.call_tool("list_executions", {"limit": 10_000}))
    assert body["count"] == mcp.MAX_LIMIT
    assert body["total"] == 500


def test_list_executions_defaults_to_a_small_page():
    rows = [{"id": i} for i in range(200)]
    with _stub({"/api/executions": rows}):
        body = _payload(mcp.call_tool("list_executions", {}))
    assert body["count"] == mcp.DEFAULT_LIMIT


def test_execution_results_do_not_return_the_whole_report():
    """The report endpoint returns the entire rendered Markdown.

    Returning it would break the contract's own token-efficiency guarantee, so
    the structured reference export is used instead.
    """
    docs = [{"id": i, "title": f"Paper {i}", "doi": f"10.1/{i}"} for i in range(60)]
    with _stub({
        "/api/executions/7/references": json.dumps(docs),
        "/api/executions/7/report": {"report_text": "x" * 500_000},
    }):
        body = _payload(mcp.call_tool("get_execution_results", {"exec_id": 7}))
    assert body["count"] == mcp.DEFAULT_LIMIT
    assert body["total"] == 60
    assert "x" * 1000 not in json.dumps(body)


def test_search_refuses_offset_rather_than_ignoring_it():
    """Silently ignoring it would page the first result set forever."""
    body = _payload(mcp.call_tool("search_corpus", {"query": "q", "offset": 25}))
    assert body["error"] == "invalid_argument"
    assert "cursor" in body["message"]


def test_search_passes_the_cursor_through_and_returns_the_next_one():
    with _stub({"/api/explorer/search": {
        "results": [{"id": 1, "title": "A", "source_repository": "arxiv"}],
        "next_cursor": "2026-01-01|1", "has_more": True,
        "total": 900, "total_is_capped": True,
    }}):
        body = _payload(mcp.call_tool(
            "search_corpus", {"query": "q", "cursor": "2026-02-02|9"}))
    assert body["next_cursor"] == "2026-01-01|1"
    assert body["has_more"] is True
    # The cap travels with the number, so "900" cannot be read as exact.
    assert body["total_is_capped"] is True


# ---------------------------------------------------------------------------
# Behavior the contract fixes
# ---------------------------------------------------------------------------

def test_analytics_view_names_map_to_endpoints_that_exist():
    """Three of the contract's view names differ from the route serving them."""
    seen = {}
    for view in ("volume", "sources", "keywords"):
        with _stub({("GET", mcp._ANALYTICS_VIEWS[view]): {"ok": view}}):
            seen[view] = _payload(mcp.call_tool("get_analytics", {"view": view}))
    assert seen["volume"] == {"ok": "volume"}
    assert seen["sources"] == {"ok": "sources"}
    assert seen["keywords"] == {"ok": "keywords"}
    assert mcp._ANALYTICS_VIEWS["volume"] == "/api/analytics/publication-volume"


def test_an_unknown_analytics_view_lists_the_real_ones():
    body = _payload(mcp.call_tool("get_analytics", {"view": "nonsense"}))
    assert body["error"] == "invalid_argument"
    assert "routine-health" in body["message"]


def test_create_routine_creates_it_inactive():
    """Scheduling something on a user's machine is not a tool call's side effect."""
    captured = {}

    seen: list[tuple[str, str]] = []

    def _request(method, url, **kwargs):
        seen.append((method, url))
        captured.update(kwargs.get("json") or {})
        return httpx.Response(201, json={"id": 1, "is_active": False},
                              request=httpx.Request(method, url))

    mcp.backend._base = "http://127.0.0.1:8742"
    with patch.object(mcp.httpx, "request", side_effect=_request):
        body = _payload(mcp.call_tool("create_routine", {
            "name": "n", "keywords": ["a", "b"], "sources": ["arxiv"],
            "schedule": "0 8 * * *"}))

    assert captured["is_active"] is False
    assert "Activate it" in body["detail"]
    # v2.0: the record is read back, because ``POST /api/routines`` answers with
    # ``{id, name}`` and the contract promised "the created routine". The
    # caller can now see ``is_active`` rather than take the detail sentence's
    # word for it.
    assert seen == [("POST", "http://127.0.0.1:8742/api/routines"),
                    ("GET", "http://127.0.0.1:8742/api/routines/1")]
    assert body["routine"]["is_active"] is False
    # A dict, not a JSON string: RoutineCreate declares `parameters: dict` and
    # rejects the string form with a 422. The column stores JSON text, which
    # makes the string the tempting guess.
    assert isinstance(captured["parameters"], dict)
    assert captured["parameters"]["repositories"] == ["arxiv"]
    # No intent was given, so none is sent -- never defaulted from the keywords.
    # The coverage audit reports which of the two it compared against, and a
    # silent fallback written into the column at creation would erase that.
    assert "intent" not in captured


def test_create_routine_passes_a_stated_intent_through():
    """Contract v1.3's one addition, at the boundary it crosses.

    ``routines.intent`` is what the coverage audit compares against; without this
    a harness could create a routine but never say what it was for, and every
    audit of it would be the circular keyword comparison.
    """
    captured = {}

    def _request(method, url, **kwargs):
        captured.update(kwargs.get("json") or {})
        return httpx.Response(201, json={"id": 1, "is_active": False},
                              request=httpx.Request(method, url))

    mcp.backend._base = "http://127.0.0.1:8742"
    with patch.object(mcp.httpx, "request", side_effect=_request):
        mcp.call_tool("create_routine", {
            "name": "n", "keywords": ["a"], "sources": ["arxiv"],
            "schedule": "0 8 * * *",
            "intent": "methods for irregular time series in astronomy"})

    assert captured["intent"] == "methods for irregular time series in astronomy"


def test_the_coverage_counts_on_get_routine_are_totals_not_page_lengths():
    """A harness reading ``off_target_count`` gets the whole, not the page.

    Both lists are capped at 25 in the payload. ``len(off_target)`` would report
    25 for a routine with 312 -- precise, repeated verbatim by whatever consumes
    it, and wrong.
    """
    audit = {
        "summary": "s", "intent": "i", "intent_source": "stated",
        "results": 400, "results_embedded": 400,
        "off_target": [{"id": n} for n in range(25)], "off_target_total": 312,
        "missed_in_corpus": [{"id": n} for n in range(25)],
        "missed_in_corpus_total": 63,
        "missed_in_corpus_total_is_lower_bound": True,
        "reason": None, "cannot_see": "c",
    }

    def _request(method, url, **kwargs):
        payload = audit if url.endswith("/coverage") else {"id": 4, "name": "r"}
        return httpx.Response(200, json=payload, request=httpx.Request(method, url))

    mcp.backend._base = "http://127.0.0.1:8742"
    with patch.object(mcp.httpx, "request", side_effect=_request):
        body = _payload(mcp.call_tool("get_routine", {"routine_id": 4}))

    assert body["coverage"]["off_target_count"] == 312
    assert body["coverage"]["missed_in_corpus_count"] == 63
    assert body["coverage"]["missed_in_corpus_count_is_lower_bound"] is True


def test_no_destructive_tool_is_exposed():
    """v1 excludes everything destructive, and the omission is asserted."""
    names = {t["name"] for t in mcp.TOOLS}
    for banned in ("delete", "erase", "factory", "reset", "revoke", "uninstall"):
        assert not any(banned in n for n in names), banned


def test_no_tool_writes_a_credential_or_a_setting():
    schemas = json.dumps([t["schema"] for t in mcp.TOOLS])
    assert "api_key" not in schemas
    assert "credential_value" not in schemas


def test_a_missing_item_is_not_found_rather_than_a_crash():
    with _stub({}):
        body = _payload(mcp.call_tool("get_routine", {"routine_id": 42}))
    assert body["error"] == "not_found"


def test_a_required_argument_is_named_when_missing():
    body = _payload(mcp.call_tool("get_routine", {}))
    assert body["error"] == "invalid_argument"
    assert "routine_id" in body["message"]


def test_an_unknown_tool_is_reported_not_raised():
    result = mcp.call_tool("drop_everything", {})
    assert result["isError"] is True
    assert _payload(result)["error"] == "invalid_argument"


def test_run_routine_calls_the_new_endpoint():
    with _stub({("POST", "/api/routines/3/run"): {
        "execution_id": 11, "routine_id": 3, "was_inactive": True,
        "detail": "This routine is not scheduled; it was run once because you asked for it.",
    }}):
        body = _payload(mcp.call_tool("run_routine", {"routine_id": 3}))
    assert body["execution_id"] == 11
    assert body["was_inactive"] is True


# ---------------------------------------------------------------------------
# The version guard — the wrong-instance hazard
# ---------------------------------------------------------------------------
#
# resmon writes a port file only while it is running, so with the app closed
# nothing names a port and the default applies. On a machine where an older
# resmon holds that port, it answers -- and every tool then reports another
# installation's corpus as the user's own. That happened with a v1.2.1 daemon.

def _health(version, port=8742, status=200):
    def _get(url, **kwargs):
        body = {"status": "ok"} if version is None else {"status": "ok", "version": version}
        return httpx.Response(status, json=body, request=httpx.Request("GET", url))
    return _get


@pytest.mark.parametrize("version", ["1.8.0", "1.8.2", "1.10.0", "2.0.0"])
def test_a_supported_backend_is_accepted(monkeypatch, version):
    monkeypatch.setattr(mcp.httpx, "get", _health(version))
    with patch.object(mcp, "_candidate_ports", return_value=[8742]):
        assert mcp.backend.base_url() == "http://127.0.0.1:8742"


@pytest.mark.parametrize("version", ["1.2.1", "1.7.9", "0.1.0"])
def test_an_older_backend_is_refused_rather_than_used(monkeypatch, version):
    """The whole point: answering about the wrong corpus is worse than failing."""
    monkeypatch.setattr(mcp.httpx, "get", _health(version))
    with patch.object(mcp, "_candidate_ports", return_value=[8742]):
        with pytest.raises(mcp.ToolError) as excinfo:
            mcp.backend.base_url()
    assert excinfo.value.code == "backend_unavailable"
    assert version in excinfo.value.message
    assert version in str(excinfo.value.detail["rejected"])


@pytest.mark.parametrize("version", [None, "", "garbage"])
def test_a_backend_that_cannot_say_its_version_is_refused(monkeypatch, version):
    """Unparseable is refused, not assumed good — that is the case guarded against."""
    monkeypatch.setattr(mcp.httpx, "get", _health(version))
    with patch.object(mcp, "_candidate_ports", return_value=[8742]):
        with pytest.raises(mcp.ToolError):
            mcp.backend.base_url()


def test_the_refusal_names_the_version_so_a_user_can_act(monkeypatch):
    monkeypatch.setattr(mcp.httpx, "get", _health("1.2.1"))
    with patch.object(mcp, "_candidate_ports", return_value=[8742]):
        with pytest.raises(mcp.ToolError) as excinfo:
            mcp.backend.base_url()
    message = excinfo.value.message
    assert "1.2.1" in message and mcp.MIN_BACKEND_VERSION in message
    assert "background" in message


# ---------------------------------------------------------------------------
# Format negotiation — the parameter the old double could not see
# ---------------------------------------------------------------------------

def test_execution_results_ask_for_a_format_the_backend_supports():
    """The v1.8.2 defect, pinned. It asked for json when json did not exist."""
    docs = [{"id": 1, "title": "A"}]
    stub = _stub({"/api/executions/7/references": json.dumps(docs)})
    with stub:
        body = _payload(mcp.call_tool("get_execution_results", {"exec_id": 7}))
    assert body["count"] == 1
    assert stub.seen[0]["params"]["format"] == "json"


def test_a_format_the_backend_rejects_surfaces_as_an_error_not_a_summary():
    """If the double did not validate format, this test could not exist."""
    stub = _stub({"/api/executions/7/references": json.dumps([])},
                 formats=("bibtex", "ris", "csv"))
    with stub:
        body = _payload(mcp.call_tool("get_execution_results", {"exec_id": 7}))
    assert body["error"] == "invalid_argument"
    assert "Unknown export format" in body["message"]


def test_export_references_by_execution_uses_the_execution_endpoint():
    """It sent execution_id to an endpoint requiring document_ids: a 422 every time."""
    stub = _stub({("GET", "/api/executions/9/references"): "@article{...}"})
    with stub:
        mcp.call_tool("export_references", {"exec_id": 9, "format": "bibtex"})
    call = stub.seen[0]
    assert call["method"] == "GET"
    assert call["path"] == "/api/executions/9/references"
    assert call["params"]["format"] == "bibtex"


def test_export_references_by_doc_ids_still_posts_document_ids():
    stub = _stub({("POST", "/api/export/references"): "@article{...}"})
    with stub:
        mcp.call_tool("export_references", {"doc_ids": [1, 2], "format": "ris"})
    assert stub.seen[0]["path"] == "/api/export/references"


@pytest.mark.parametrize("fmt", ["bibtex", "ris", "csv", "json"])
def test_every_advertised_export_format_is_one_the_backend_has(fmt):
    """The schema advertised 'json' before json existed. Now they must agree."""
    from implementation_scripts import reference_export

    schema = next(t["schema"] for t in mcp.TOOLS if t["name"] == "export_references")
    assert fmt in schema["properties"]["format"]["enum"]
    assert fmt in reference_export.FORMATS


def test_health_description_does_not_promise_fields_the_endpoint_lacks():
    """It claimed schema version and scheduler state; /api/health returns neither."""
    description = next(t["description"] for t in mcp.TOOLS if t["name"] == "health")
    assert "schema" not in description.lower()
    assert "scheduler" not in description.lower()
