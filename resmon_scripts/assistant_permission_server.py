#!/usr/bin/env python3
"""The one-tool MCP server that stands between the assistant and a write.

``claude`` is started with ``--permission-prompt-tool mcp__resmon_permission__ask``.
Before it runs any tool that is not pre-approved, it calls ``ask`` here and waits
for the answer. This process forwards the question to the running resmon backend,
which shows it to the person as a card in the panel and holds the HTTP request
open until they answer.

**The model cannot call this tool.** Verified against claude 2.1.258: with two MCP
servers attached, the session's tool list contained only the *other* server's
tools — the permission tool is not offered to the model at all. So "the assistant
approved its own write" is not a failure mode that needs guarding against; there
is no path to it.

**Everything that is not an explicit allow is a deny.** A backend that has gone
away, an unparseable answer, a request that timed out, a tool name this server
does not recognise: all deny, each saying which. That direction is not
arbitrary — a gate whose failure mode is "open" is not a gate, and this one is
the only thing standing between a prompt injected into an abstract and a write.

Its own transport is the same hand-written JSON-RPC as ``mcp_server.py``, for the
same reason: four methods, and every dependency costs real megabytes in a ~900 MB
build.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

import httpx

TOOL_NAME = "ask"
PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "resmon_permission"

# Longer than the backend's own wait, so the backend is the thing that decides a
# timeout and this process does not race it into a different answer.
_HTTP_TIMEOUT = httpx.Timeout(360.0, connect=5.0)

TOOLS = [{
    "name": TOOL_NAME,
    "description": (
        "Ask the person using resmon whether a tool call may run. resmon calls "
        "this itself; it is not for the assistant to call."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "tool_name": {"type": "string"},
            "input": {"type": "object"},
            "tool_use_id": {"type": "string"},
        },
    },
}]


def _backend_base() -> Optional[str]:
    """The backend that started us, from the environment resmon set.

    No discovery and no default. ``mcp_server.py`` searches because a harness
    starts it on its own; this process is spawned by a backend that knows its
    own port and sets it, so anything else would be a different resmon — and
    asking the wrong resmon for permission is worse than failing.
    """
    port = os.environ.get("RESMON_PORT")
    if not port:
        return None
    try:
        return f"http://127.0.0.1:{int(port)}"
    except ValueError:
        return None


def _session_id() -> Optional[int]:
    try:
        return int(os.environ["RESMON_ASSISTANT_SESSION"])
    except (KeyError, ValueError):
        return None


def _deny(message: str) -> dict:
    return {"behavior": "deny", "message": message}


def ask_backend(
    base: Optional[str],
    session_id: Optional[int],
    tool_name: str,
    tool_input: Optional[dict],
    tool_use_id: Optional[str] = None,
) -> dict:
    """Put one question to the panel and block until it is answered.

    **Both runtimes come through here**, and that is the point rather than tidy
    reuse. The CLI runtime reaches it as an MCP tool in a separate process; the
    API-key runtime reaches it as a function call on its worker thread. One
    implementation means "the same permission pause" is a fact about the code
    rather than a claim about two things that look alike — and it means the
    everything-is-a-deny rule below cannot be true on one path and not the
    other.

    Everything that is not an explicit allow is a deny: a backend that has gone
    away, an unreadable answer, a request that timed out. A gate whose failure
    mode is "open" is not a gate.
    """
    if base is None or session_id is None:
        return _deny(
            "resmon could not be reached to ask you about this, so it was not run."
        )

    if not isinstance(tool_input, dict):
        tool_input = {}

    try:
        response = httpx.post(
            f"{base}/api/assistant/permissions",
            json={
                "session_id": session_id,
                "tool_name": tool_name,
                "input": tool_input,
                "tool_use_id": tool_use_id,
            },
            timeout=_HTTP_TIMEOUT,
        )
    except httpx.HTTPError:
        return _deny("resmon stopped responding while asking you about this, "
                     "so it was not run.")

    if response.status_code != 200:
        return _deny("resmon refused to ask about this, so it was not run.")

    try:
        body = response.json()
    except ValueError:
        return _deny("resmon's answer could not be read, so this was not run.")

    if body.get("decision") == "allow":
        # ``updatedInput`` is what actually runs. Echoing the input back
        # unchanged is deliberate: the panel shows the person the exact call,
        # and a permission gate that could rewrite the arguments would be
        # showing them one thing and running another.
        return {"behavior": "allow", "updatedInput": tool_input}

    return _deny(str(body.get("message") or "You did not allow this."))


def ask(arguments: dict) -> dict:
    """The MCP tool ``claude`` calls. Reads the environment resmon set for it."""
    tool_input = arguments.get("input")
    return ask_backend(
        _backend_base(),
        _session_id(),
        str(arguments.get("tool_name") or ""),
        tool_input if isinstance(tool_input, dict) else {},
        arguments.get("tool_use_id"),
    )


def handle_message(msg: dict) -> Optional[dict]:
    method, msg_id = msg.get("method"), msg.get("id")

    if method == "initialize":
        return _ok(msg_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": "1.0"},
        })
    if method in ("notifications/initialized", "initialized"):
        return None
    if method == "tools/list":
        return _ok(msg_id, {"tools": TOOLS})
    if method == "tools/call":
        params = msg.get("params") or {}
        if params.get("name") != TOOL_NAME:
            payload = _deny("resmon does not have that permission tool, so "
                            "nothing was run.")
        else:
            payload = ask(params.get("arguments") or {})
        return _ok(msg_id, {
            "content": [{"type": "text", "text": json.dumps(payload)}],
        })
    if method == "ping":
        return _ok(msg_id, {})
    if msg_id is None:
        return None
    return {"jsonrpc": "2.0", "id": msg_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"}}


def _ok(msg_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def serve(stdin=None, stdout=None) -> None:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if not isinstance(msg, dict):
            continue
        response = handle_message(msg)
        if response is not None:
            stdout.write(json.dumps(response, default=str) + "\n")
            stdout.flush()


def main() -> None:  # pragma: no cover - process entrypoint
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    serve()


if __name__ == "__main__":  # pragma: no cover
    main()
