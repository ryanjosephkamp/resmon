#!/usr/bin/env python3
"""A stand-in for ``claude -p --output-format stream-json``. A hermetic double.

**What it is honestly not.** It is not the CLI. It does not host a model, does
not speak MCP, and cannot fail the way the real binary fails — a flag the real
CLI stopped accepting, a tool list it did not actually receive, an auth prompt.
Every ledger row that uses this says *hermetic double*, and the properties it
cannot establish are checked against the real CLI under ``live_network``.

**What it is faithful about, deliberately.** The two things the relay and the
gate are built on:

* the stream-json line protocol, message by message, including the ``init``
  message's ``tools``/``mcp_servers`` fields and the ``result`` envelope's
  usage and cost;
* the *permission handshake* — it reads the ``--mcp-config`` it was handed and
  calls ``assistant_permission_server.ask`` exactly as the real CLI causes that
  server to be called, over real HTTP to the real backend. So the round trip
  under test is real on every hop except the model's decision to make the call.

Driven by directives in the prompt, so a test says what the turn should do:

    SAY:<text>          emit an assistant text block
    CALL:<tool> <json>  ask permission for <tool>, and on allow really call it
                        against the real backend with <json> as its arguments
    SLEEP:<seconds>     stall, for the cancel and timeout tests

    RAW:<json>          emit a line verbatim, for the unknown-event test
    FAIL:<message>      write to stderr and exit non-zero
    RESULT_ERROR:<msg>  answer with an error *result* and exit non-zero with an
                        empty stderr, which is how the real CLI reports an auth
                        failure
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

import assistant_permission_server as perm  # noqa: E402
import mcp_server  # noqa: E402


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> int:
    argv = sys.argv[1:]
    prompt = argv[-1] if argv else ""

    def flag(name: str, default: str = "") -> str:
        return argv[argv.index(name) + 1] if name in argv else default

    session_id = flag("--session-id") or flag("--resume") or str(uuid.uuid4())

    # The permission server's environment comes from the MCP config resmon
    # wrote, exactly as the real CLI would start it.
    config_path = flag("--mcp-config")
    if config_path and os.path.exists(config_path):
        config = json.loads(Path(config_path).read_text(encoding="utf-8"))
        for server in ("resmon_permission", "resmon"):
            env = config.get("mcpServers", {}).get(server, {}).get("env", {})
            os.environ.update({k: str(v) for k, v in env.items()})

    allowed = [t for t in (flag("--allowedTools") or "").split(" ") if t]
    emit({
        "type": "system", "subtype": "init", "session_id": session_id,
        "model": flag("--model") or "fake-model",
        # A real session lists every tool it was given, allowed or not. This
        # lists only the pre-approved ones, and the difference is exactly what
        # the live denominator check exists to catch — which is why that check
        # does not use this file.
        "tools": allowed,
        "mcp_servers": [{"name": "resmon", "status": "connected"},
                        {"name": "resmon_permission", "status": "connected"}],
    })

    for line in prompt.splitlines():
        line = line.strip()
        if line.startswith("SAY:"):
            emit({"type": "assistant", "message": {"content": [
                {"type": "text", "text": line[4:]}]}})
        elif line.startswith("RAW:"):
            sys.stdout.write(line[4:] + "\n")
            sys.stdout.flush()
        elif line.startswith("SLEEP:"):
            time.sleep(float(line[6:]))
        elif line.startswith("RESULT_ERROR:"):
            emit({"type": "result", "subtype": "error_during_execution",
                  "is_error": True, "result": line[13:], "usage": {}})
            return 1
        elif line.startswith("FAIL:"):
            sys.stderr.write(line[5:] + "\n")
            sys.stderr.flush()
            return 3
        elif line.startswith("CALL:"):
            tool, _, raw_args = line[5:].strip().partition(" ")
            use_id = "toolu_" + uuid.uuid4().hex[:12]
            args = json.loads(raw_args) if raw_args.strip() else {}
            emit({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": use_id,
                 "name": f"mcp__resmon__{tool}", "input": args}]}})
            # The real CLI asks about a tool only when it is *not* in
            # --allowedTools; a pre-approved one runs straight away. The double
            # follows that rule rather than asking about everything, because a
            # gate that stopped reads would be unusable and a double that asked
            # about reads could not tell anyone so. Written after this file did
            # ask about everything and hung a test for five minutes on a card
            # nobody was waiting for.
            if f"mcp__resmon__{tool}" in allowed:
                verdict = {"behavior": "allow"}
            else:
                verdict = perm.ask({"tool_name": f"mcp__resmon__{tool}",
                                    "input": args, "tool_use_id": use_id})

            if verdict.get("behavior") == "allow":
                # And only then does the tool run — for real, against the real
                # backend, through the real ``mcp_server``. That is what makes
                # "deny leaves the backend unchanged" a checkable claim about
                # the database rather than about this script's bookkeeping.
                result = mcp_server.call_tool(tool, args)
                emit({"type": "user", "message": {"content": [
                    {"type": "tool_result", "tool_use_id": use_id,
                     "is_error": bool(result.get("isError")),
                     "content": result["content"]}]}})
            else:
                emit({"type": "user", "message": {"content": [
                    {"type": "tool_result", "tool_use_id": use_id,
                     "is_error": True,
                     "content": verdict.get("message", "denied")}]}})

    emit({
        "type": "result", "subtype": "success", "is_error": False,
        "total_cost_usd": 0.0123, "duration_ms": 12, "num_turns": 1,
        "usage": {"input_tokens": 11, "output_tokens": 7,
                  "cache_read_input_tokens": 3, "cache_creation_input_tokens": 5},
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
