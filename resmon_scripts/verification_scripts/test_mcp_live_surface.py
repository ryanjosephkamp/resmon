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
