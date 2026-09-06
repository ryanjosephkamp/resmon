"""Every MCP tool, called against a real backend.

This file exists because the previous verification was a *sample*. Six of
seventeen tools were driven end to end and the result was reported as "verified
end to end"; two of the eleven never called were broken for every input, and
both failed the first time a person used them.

**A tool surface is verified when every tool has been called against a real
backend, not when the suite is green and a sample works.** So this parametrises
over ``mcp_server.TOOLS`` rather than a hand-written list: adding a tool without
adding it here is impossible, because the list is the source.

Marked ``live_network`` because it starts a real backend on a real socket. That
backend is a private temp database on an unused port -- it never touches the
user's corpus and never reaches the internet.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import mcp_server as mcp  # noqa: E402

pytestmark = pytest.mark.live_network


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="module")
def backend(tmp_path_factory):
    """A real resmon backend on its own port, over its own empty database."""
    state = tmp_path_factory.mktemp("mcp-live")
    port = _free_port()
    env = {
        **os.environ,
        "RESMON_DB_PATH": str(state / "resmon.db"),
        "RESMON_REPORTS_DIR": str(state / "reports"),
        "RESMON_PORT_FILE": str(state / "resmon.port"),
        "RESMON_DISABLE_SCHEDULER": "1",
        "PYTHONPATH": str(PROJECT_ROOT / "resmon_scripts"),
    }
    proc = subprocess.Popen(
        [sys.executable, str(PROJECT_ROOT / "resmon_scripts" / "resmon.py"), str(port)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        cwd=str(PROJECT_ROOT),
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"backend exited early: {proc.communicate()[0][:2000]}")
            try:
                if httpx.get(f"{base}/api/health", timeout=1.0).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.4)
        else:
            raise RuntimeError("backend did not become ready")

        mcp.backend._base = base
        mcp.backend._tried = []
        yield base
    finally:
        mcp.backend._base = None
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()


def _payload(result: dict) -> dict:
    return json.loads(result["content"][0]["text"])


# Arguments that make each tool reachable against an empty corpus. A tool
# needing an id gets one that does not exist: "not_found" is a real answer and
# proves the call reached the backend, which is what this file is checking.
_ARGS: dict[str, dict] = {
    "health": {},
    "search_corpus": {"query": "neural"},
    "find_similar": {"doc_id": 999999},
    "list_sources": {},
    "list_routines": {},
    "get_routine": {"routine_id": 999999},
    "list_executions": {},
    "get_execution": {"exec_id": 999999},
    "get_execution_results": {"exec_id": 999999},
    "get_search_record": {"exec_id": 999999},
    "explain_match": {"doc_id": 999999},
    "get_paper_lifecycle": {"doc_id": 999999},
    "get_analytics": {"view": "overview"},
    "get_watchdog_findings": {},
    "export_references": {"exec_id": 999999, "format": "bibtex"},
    "run_sweep": None,        # starts real work; covered separately
    "create_routine": None,   # writes; covered separately
    "run_routine": {"routine_id": 999999},
    # v2.0. Two of the three reach the backend with an id that does not exist,
    # which is a real answer and proves the call landed. ``update_settings`` is
    # not one of those: an unknown *group* is refused in this file without a
    # request, so it would pass this test having spoken to nothing. It gets a
    # group that exists and a key that exists, and its own tests below.
    "activate_routine": {"routine_id": 999999},
    "deactivate_routine": {"routine_id": 999999},
    "update_settings": {"group": "notifications",
                        "settings": {"notify_manual": "true"}},
}

_ACCEPTABLE_ERRORS = {"not_found", "invalid_argument", "conflict"}


def test_every_tool_has_a_live_case():
    """The list is derived from TOOLS, so a new tool cannot slip through."""
    assert set(_ARGS) == {tool["name"] for tool in mcp.TOOLS}


@pytest.mark.parametrize(
    "name", [t["name"] for t in mcp.TOOLS if _ARGS.get(t["name"]) is not None],
)
def test_tool_reaches_the_backend(backend, name):
    """Each tool either succeeds or fails for a reason the backend gave.

    What this rules out is the failure that shipped: a tool that cannot work
    for *any* input because it asks the backend for something that does not
    exist. Those surface here as upstream_error or internal_error.
    """
    result = mcp.call_tool(name, _ARGS[name])
    body = _payload(result)

    if result["isError"]:
        assert body["error"] in _ACCEPTABLE_ERRORS, (
            f"{name} failed with {body['error']}: {body['message']}"
        )
    else:
        assert isinstance(body, (dict, list, str))


def test_search_corpus_semantic_mode_reaches_the_backend_and_says_what_it_served(backend):
    """1.9 / P10. A mode the backend cannot serve must be *reported*, not faked.

    This backend has an empty corpus and no embedding lane, so the honest answer
    is keyword order with the reason attached. The failure this rules out is the
    plausible one: semantic mode silently degrading to a date sort while still
    labelling itself semantic, so a harness reports a relevance ranking that is
    a chronology.
    """
    body = _payload(mcp.call_tool("search_corpus", {"query": "neural", "mode": "semantic"}))
    assert body["mode"] in ("keyword", "semantic")
    if body["mode"] == "keyword":
        assert body["mode_unavailable"], (
            "semantic was requested and keyword was served with no reason given"
        )
    else:
        assert "ranked_count" in body and "model" in body


def test_search_corpus_rejects_a_mode_it_does_not_have(backend):
    result = mcp.call_tool("search_corpus", {"query": "x", "mode": "telepathic"})
    assert result["isError"]
    assert _payload(result)["error"] == "invalid_argument"


def test_find_similar_answers_with_a_reason_rather_than_a_bare_empty_list(backend):
    """1.9 / P10. "Nothing similar" and "nothing embedded" are different claims."""
    result = mcp.call_tool("find_similar", {"doc_id": 999999})
    body = _payload(result)
    if result["isError"]:
        assert body["error"] in _ACCEPTABLE_ERRORS
    else:
        assert body["papers"] == []
        assert body["reason"], "an empty neighbour list with no reason is an overclaim"


def test_semantic_search_and_find_similar_over_a_really_embedded_corpus(backend):
    """P10, the success path — the one the two declining tests above cannot reach.

    Everything here is out of process: a real backend on a real socket, a real
    embedding server on another, a real sqlite-vec index, and both tools called
    through ``mcp.call_tool``. The only stand-in is the model, which returns a
    deterministic vector so the expected order is a fact rather than a guess.

    Written because "the tool reached the backend" and "the tool returns a
    ranking" are different claims, and v1.8.2 shipped two tools that satisfied
    the first for every input and the second for none.
    """
    pytest.importorskip("sqlite_vec")
    from embedding_server import EmbeddingServer, deterministic_vector  # noqa: PLC0415

    with EmbeddingServer() as model:
        configured = httpx.put(
            f"{backend}/api/settings/embeddings",
            json={"settings": {
                "embedding_enabled": "true",
                "embedding_provider": "local",
                "embedding_model": "live-surface-model",
                "embedding_endpoint": model.base_url,
            }},
            timeout=30,
        )
        assert configured.status_code == 200, configured.text

        # Two papers, deliberately unalike, inserted through a real sweep so the
        # backend's own pipeline embeds them.
        seeded = httpx.post(
            f"{backend}/api/search/sweep",
            json={"repositories": ["arxiv"], "query": "quantum error correction",
                  "max_results": 5},
            timeout=60,
        )
        if seeded.status_code != 200:
            pytest.skip(f"could not seed a corpus: {seeded.status_code} {seeded.text[:200]}")

        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            status = httpx.get(f"{backend}/api/embeddings/status", timeout=10).json()
            if status["coverage"]["embedded"] > 0:
                break
            time.sleep(0.5)
        else:
            pytest.skip("the seeded sweep returned no papers to embed")

        # The search phrase is taken from a paper the sweep actually stored, not
        # from the sweep's own query. arXiv is relevance-ranked and answers a
        # multi-word query with papers containing none of its words -- measured:
        # "quantum error correction" returned five papers, none matching the
        # corpus filter. A test that assumed otherwise would skip or fail for a
        # reason that has nothing to do with what it checks.
        stored = httpx.post(
            f"{backend}/api/explorer/search", json={"limit": 5}, timeout=30
        ).json()["results"]
        phrase = next(
            (w for w in str(stored[0]["title"]).split() if len(w) > 5 and w.isalpha()),
            None,
        )
        if not phrase:
            pytest.skip("no usable search term in the seeded corpus")

        # Semantic mode, served rather than declined.
        body = _payload(mcp.call_tool(
            "search_corpus", {"query": phrase, "mode": "semantic"}
        ))
        assert body["mode"] == "semantic", body.get("mode_unavailable")
        assert body["model"] == "live-surface-model"
        assert body["papers"], f"a semantic search for {phrase!r} returned nothing"
        assert body["ranked_count"] >= 1
        distances = [p["distance"] for p in body["papers"] if p["distance"] is not None]
        assert distances == sorted(distances), "the ranking is not ordered by distance"

        # The two modes return *different sets*, and that is the contract.
        #
        # This block asserted they were equal -- "a sort, not a search" -- until
        # 2.0a found it red on ``main``. It was written against the first draft
        # of contract v1.2's amendment and never updated when the field test
        # retired that draft before it shipped: semantic mode ranks the corpus
        # within the structured filters, and ``query`` is the thing distance is
        # measured *from* rather than a text filter, so keyword's set is a
        # subset of semantic's. The contract says so in as many words. CI does
        # not run ``live_network``, which is why a test contradicting the
        # shipped contract stayed red without anyone hearing about it.
        keyword = _payload(mcp.call_tool(
            "search_corpus", {"query": phrase, "mode": "keyword", "limit": 100}
        ))
        semantic = _payload(mcp.call_tool(
            "search_corpus", {"query": phrase, "mode": "semantic", "limit": 100}
        ))
        keyword_ids = {p["id"] for p in keyword["papers"]}
        semantic_ids = {p["id"] for p in semantic["papers"]}
        assert keyword_ids <= semantic_ids, (
            "a paper matching the query's words was not in the ranking of the "
            "corpus that query was measured against"
        )
        assert semantic["total"] >= keyword["total"]

        # And semantic really is the whole corpus, not a widened keyword match:
        # the unfiltered listing is the denominator.
        everything = _payload(mcp.call_tool("search_corpus", {"query": "", "limit": 100}))
        if everything.get("papers"):
            assert semantic_ids == {p["id"] for p in everything["papers"]}

        # find_similar, on a paper that really has a vector.
        doc_id = body["papers"][0]["id"]
        similar = _payload(mcp.call_tool("find_similar", {"doc_id": doc_id, "limit": 5}))
        assert similar["model"] == "live-surface-model"
        assert doc_id not in [p["id"] for p in similar["papers"]], "self was not excluded"
        if similar["papers"]:
            assert similar["reason"] is None
            assert all(p["distance"] is not None for p in similar["papers"])
        else:
            assert similar["reason"], "an empty neighbour list must say why"

    # The embedding server is gone once this block exits, so the lane is switched
    # off again rather than left pointing at a dead port for the rest of the
    # module's tests to trip over.
    httpx.put(
        f"{backend}/api/settings/embeddings",
        json={"settings": {"embedding_enabled": "false"}}, timeout=30,
    )


def test_get_execution_results_works_for_a_real_execution(backend):
    """The v1.8.2 defect, against a real backend and a real execution.

    A stub cannot establish this: the bug was that the backend rejected the
    format the tool asked for, and only the backend knows which formats exist.
    """
    created = httpx.post(f"{backend}/api/search/dive", json={
        "repository": "arxiv", "query": "quantum", "max_results": 1,
    }, timeout=60)
    if created.status_code != 200:
        pytest.skip(f"could not start an execution: {created.status_code}")
    exec_id = created.json()["execution_id"]

    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        row = httpx.get(f"{backend}/api/executions/{exec_id}", timeout=10).json()
        if row.get("status") in {"completed", "failed"}:
            break
        time.sleep(1.0)

    result = mcp.call_tool("get_execution_results", {"exec_id": exec_id})
    body = _payload(result)
    assert not result["isError"], f"get_execution_results failed: {body}"
    assert "papers" in body and isinstance(body["papers"], list)


def test_export_references_works_for_a_real_execution(backend):
    rows = httpx.get(f"{backend}/api/executions", timeout=10).json()
    if not rows:
        pytest.skip("no execution to export")
    exec_id = rows[0]["id"]
    for fmt in ("bibtex", "csv", "json"):
        result = mcp.call_tool("export_references", {"exec_id": exec_id, "format": fmt})
        assert not result["isError"], f"{fmt} export failed: {_payload(result)}"


# ---------------------------------------------------------------------------
# The v2.0 tools, against a real backend — P11, P12
# ---------------------------------------------------------------------------

def test_activate_and_deactivate_really_move_a_routine_on_and_off_its_schedule(backend):
    """P12. Not "the call landed": the routine's own state, read back.

    A stub cannot establish this. ``is_active`` is written by
    ``update_routine`` and the scheduler is told separately, so the failure
    worth ruling out is a 200 from an endpoint that changed nothing.
    """
    created = _payload(mcp.call_tool("create_routine", {
        "name": "assistant-live-activation",
        "keywords": ["graphene"], "sources": ["arxiv"],
        "schedule": "0 9 * * 1",
    }))
    routine_id = created["routine"]["id"]
    assert not created["routine"]["is_active"], (
        "create_routine must still create inactive"
    )

    assert not mcp.call_tool("activate_routine", {"routine_id": routine_id})["isError"]
    assert httpx.get(f"{backend}/api/routines/{routine_id}", timeout=10).json()["is_active"]

    assert not mcp.call_tool("deactivate_routine", {"routine_id": routine_id})["isError"]
    assert not httpx.get(f"{backend}/api/routines/{routine_id}", timeout=10).json()["is_active"]


def test_update_settings_changes_exactly_the_keys_it_named(backend):
    """P11. Every other key in the group is read before and after and compared.

    The read path is the real one — no monkeypatched group — which is what
    Ledger 33 was about: ``ai_cli_path`` rode one key list and not the other for
    a whole release because the test that would have caught it patched the read.
    """
    before = httpx.get(f"{backend}/api/settings/ai", timeout=10).json()
    assert "ai_effort" in before, "the group's real key list is what this checks against"
    target = "low" if before.get("ai_effort") != "low" else "high"

    body = _payload(mcp.call_tool(
        "update_settings", {"group": "ai", "settings": {"ai_effort": target}}))
    assert body["changed"] == {"ai_effort": {"from": before.get("ai_effort"), "to": target}}

    after = httpx.get(f"{backend}/api/settings/ai", timeout=10).json()
    assert after["ai_effort"] == target
    assert {k: v for k, v in after.items() if k != "ai_effort"} == \
           {k: v for k, v in before.items() if k != "ai_effort"}, (
        "update_settings moved a key it was not given"
    )


def test_update_settings_reaches_every_group_on_its_allowlist(backend):
    """Denominator: ``mcp_server.SETTINGS_GROUPS``, not a hand-written list.

    A group named in the allowlist that the backend does not serve would be a
    tool that fails for every input in that group — the v1.8.2 defect shape.
    """
    for group in mcp.SETTINGS_GROUPS:
        current = httpx.get(f"{backend}/api/settings/{group}", timeout=10)
        assert current.status_code == 200, f"{group}: {current.status_code}"
        keys = current.json()
        assert keys, f"the '{group}' group came back empty"
        key = sorted(keys)[0]
        result = mcp.call_tool(
            "update_settings", {"group": group, "settings": {key: keys[key] or ""}})
        assert not result["isError"], f"{group}/{key}: {_payload(result)}"


def test_the_credential_denylist_excludes_nothing_that_exists(backend):
    """The guard is a standing one, not a filter quietly doing nothing.

    If a real settings key ever matches a credential-shaped word, this fails
    and the choice — rename the key, or narrow the word — becomes deliberate
    rather than a silently unreachable setting.
    """
    blocked: dict[str, list[str]] = {}
    for group in mcp.SETTINGS_GROUPS:
        keys = httpx.get(f"{backend}/api/settings/{group}", timeout=10).json()
        hit = sorted(k for k in keys
                     if any(w in k.lower() for w in mcp._CREDENTIAL_SHAPED))
        if hit:
            blocked[group] = hit
    assert blocked == {}, f"real settings keys are unreachable through the tool: {blocked}"


def test_no_settings_group_the_app_has_is_silently_reachable(backend):
    """The complement: a group the app grows is *unreachable* until listed.

    Read from the backend's own route table, so this is a denominator rather
    than a second hand-written list. A new group appearing here is not a
    failure of the app; it is a decision this test forces someone to make.
    """
    served = set()
    for route in httpx.get(f"{backend}/openapi.json", timeout=10).json()["paths"]:
        if route.startswith("/api/settings/") and route.count("/") == 3:
            served.add(route.rsplit("/", 1)[1])

    # Deliberately excluded. ``/api/settings/execution`` is admission control --
    # how many executions may run at once, how deep the routine fire queue goes
    # -- and it does not take ``SettingsBody`` at all, so ``update_settings``
    # could not drive it if it were listed. It is also the wrong thing to hand
    # an assistant: raising a concurrency ceiling is a decision about the
    # machine rather than about the research, and the person who wants it
    # changed is already in the Advanced tab.
    deliberately_excluded = {"execution"}
    unlisted = sorted(served - set(mcp.SETTINGS_GROUPS) - deliberately_excluded)
    assert unlisted == [], (
        "these settings groups exist in the app and are not on the tool's "
        f"allowlist: {unlisted}. Add them deliberately or leave them out "
        "deliberately, but do not leave the answer to this test."
    )
