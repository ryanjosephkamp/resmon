#!/usr/bin/env python3
"""A stand-in for ``codex``: ``exec --json``, ``exec resume``, ``login`` and ``debug models``.

**What it is honestly not.** It is not Codex. It hosts no model, and every
shape it prints is taken from Codex's own ``--help`` (codex-cli 0.166.0) and
from the JSONL events Codex documents for ``codex exec --json`` --
``thread.started``, ``turn.started``, ``item.started`` / ``item.updated`` /
``item.completed``, ``turn.completed``, ``turn.failed`` and ``error`` -- not
from a recorded run. Where a real field's presence is unknown (a model name in
the stream, the wording of a failed resume, the words of an expired sign-in),
the directive that produces it says so, and resmon's reader is written not to
depend on it.

**What it is faithful about, deliberately.** The two things Ask on Codex is
built on:

* the command line: it parses the ``exec`` and ``exec resume`` options it was
  given the way Codex's help describes them, and refuses one it does not know,
  as clap does ("unexpected argument");
* the tools: it starts resmon's MCP server from the ``-c mcp_servers.resmon.*``
  overrides it was handed -- the command, the arguments and the environment,
  read as TOML -- and speaks MCP to it over stdio, exactly as Codex starts an
  MCP server. So a tool call under test is real on every hop except the
  model's decision to make it, and the tool list the server offered is what
  the fake writes down.

Driven by directives in the prompt, one per line:

    SAY:<text>            an agent_message item
    CALL:<tool> <json>    call <tool> on resmon's server, started from the
                          overrides; called even when the server did not list
                          it, the way a model that guessed a name would
    REASONING:<text>      a reasoning item (Ask draws nothing for it)
    MODEL:<id>            put ``model`` on thread.started (whether Codex does
                          is not known; resmon reads it where it is)
    HEADER:<id>           print a ``model: <id>`` header on stderr first
    SLEEP:<seconds>       stall, for Stop and the turn's own deadline
    SILENT:<seconds>      say nothing at all, then exit
    RAW:<json>            print a line verbatim, for unknown events
    ERROR_ITEM:<text>     an error item inside the turn
    SHELL:<command>       start a command_execution item and hang, the way a
                          command still running would
    WEB:<query>           a web_search item
    OTHER_TOOL:<server> <tool>  an mcp_tool_call on a server that is not resmon's
    TURN_FAILED:<text>    a turn.failed event, then exit 1
    FAIL:<text>           write to stderr and exit 3 before any event
    NO_COMPLETE           end with exit 0 and no turn.completed
    CANNOT_RESUME         *on a resume*, refuse the thread id: stderr and exit 1
    NEW_THREAD            *on a resume*, start a new thread instead, and say so
                          only by reporting its own id

``FAKE_CODEX_STATE`` names a directory where the double keeps the threads it
started (``threads.txt``; a resume of any other id is refused like
``CANNOT_RESUME``), its sign-in (``auth``: ``signed_in``, ``signed_out`` or
``expired``; ``FAKE_CODEX_AUTH`` when there is no file), and ``last-run.json``:
the argv, the working directory, the ``AGENTS.md`` it found there, and the
tools resmon's server listed. With the sign-in ``expired`` every turn fails the
way an expired ChatGPT sign-in plausibly does: an ``error`` event and a
``turn.failed`` naming a 401, then exit 1.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Optional

try:                                    # 3.11+
    import tomllib
except ModuleNotFoundError:             # pragma: no cover - 3.10
    tomllib = None                      # type: ignore[assignment]

# The options ``codex exec`` and ``codex exec resume`` take, from their help.
_EXEC_VALUED = {"-c", "--config", "--enable", "--disable", "-i", "--image", "-m", "--model",
                "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd",
                "--add-dir", "--thread-source", "--cyber-access-program", "--output-schema",
                "--color", "-o", "--output-last-message"}
_EXEC_FLAGS = {"--strict-config", "--oss", "--approve-for-me",
               "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust",
               "--worktree", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
               "--ignore-rules", "--json"}
_RESUME_VALUED = {"-c", "--config", "--enable", "--disable", "-i", "--image", "-m", "--model",
                  "--thread-source", "--cyber-access-program", "--output-schema",
                  "-o", "--output-last-message"}
_RESUME_FLAGS = {"--last", "--all", "--strict-config", "--dangerously-bypass-approvals-and-sandbox",
                 "--dangerously-bypass-hook-trust", "--worktree", "--skip-git-repo-check",
                 "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json"}


def _state() -> Optional[Path]:
    root = os.environ.get("FAKE_CODEX_STATE")
    return Path(root) if root else None


def _auth_state() -> str:
    root = _state()
    if root is not None and (root / "auth").exists():
        return (root / "auth").read_text(encoding="utf-8").strip() or "signed_in"
    return os.environ.get("FAKE_CODEX_AUTH", "signed_in")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _toml_value(raw: str) -> Any:
    """A ``-c`` value as Codex reads it: TOML, or the raw string when that fails."""
    if tomllib is not None:
        try:
            return tomllib.loads(f"v = {raw}")["v"]
        except tomllib.TOMLDecodeError:
            return raw
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def _parse(args: list[str], valued: set, flags: set) -> tuple[dict, list[str]]:
    """Options and positionals, as clap would split them; exits 2 on an unknown option."""
    options: dict = {"-c": []}
    positional: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            positional += args[i + 1:]
            break
        if arg in valued:
            if i + 1 >= len(args):
                sys.stderr.write(f"error: a value is required for '{arg}'\n")
                sys.exit(2)
            key = "-c" if arg in ("-c", "--config") else arg
            if key == "-c":
                options["-c"].append(args[i + 1])
            else:
                options[key] = args[i + 1]
            i += 2
            continue
        if arg in flags:
            options[arg] = True
            i += 1
            continue
        if arg.startswith("-"):
            sys.stderr.write(f"error: unexpected argument '{arg}' found\n")
            sys.exit(2)
        positional.append(arg)
        i += 1
    return options, positional


def _overrides(pairs: list[str]) -> dict:
    """``-c key=value`` overrides as one nested dictionary."""
    tree: dict = {}
    for pair in pairs:
        key, sep, raw = pair.partition("=")
        if not sep:
            continue
        node = tree
        parts = key.strip().split(".")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = _toml_value(raw.strip())
    return tree


class _Server:
    """resmon's MCP server, started from the overrides, spoken to over stdio."""

    def __init__(self, config: dict) -> None:
        command = config.get("command")
        args = config.get("args") or []
        env = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "LOGNAME", "TMPDIR") if k in os.environ}
        env.update({str(k): str(v) for k, v in (config.get("env") or {}).items()})
        self.process = subprocess.Popen([str(command), *[str(a) for a in args]], env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self._id = 0
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                    "clientInfo": {"name": "fake-codex", "version": "0"}})
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.process.stdin.flush()
        self.tools = [t["name"] for t in self.request("tools/list", {}).get("tools", [])]

    def request(self, method: str, params: dict) -> dict:
        self._id += 1
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method,
                                             "params": params}) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        return (json.loads(line) if line else {}).get("result") or {}

    def close(self) -> None:
        try:
            self.process.stdin.close()
            self.process.wait(timeout=5)
        except Exception:               # noqa: BLE001 - a double tidying up
            self.process.kill()


def _login(argv: list[str]) -> int:
    root = _state()
    if argv[1:2] == ["status"]:
        state = _auth_state()
        if state == "signed_in":
            sys.stderr.write("Logged in using ChatGPT\n")
            return 0
        if state == "expired":
            sys.stderr.write("Your access token could not be refreshed. Please log in again.\n")
            return 1
        sys.stderr.write("Not logged in\n")
        return 1
    if root is not None:
        root.mkdir(parents=True, exist_ok=True)
        (root / "auth").write_text("signed_in", encoding="utf-8")
    print("Successfully logged in")
    return 0


def _models() -> int:
    levels = [{"effort": e, "description": e} for e in ("minimal", "low", "medium", "high")]
    print(json.dumps({"models": [
        {"slug": "gpt-5.5-codex", "visibility": "list", "supported_reasoning_levels": levels,
         "default_reasoning_level": "medium"},
        {"slug": "gpt-5.5-mini", "visibility": "list",
         "supported_reasoning_levels": levels[1:], "default_reasoning_level": "low"},
        {"slug": "internal-only", "visibility": "hide"},
    ]}))
    return 0


def _exec(argv: list[str]) -> int:
    resuming = argv[:1] == ["resume"]
    options, positional = (_parse(argv[1:], _RESUME_VALUED, _RESUME_FLAGS) if resuming
                           else _parse(argv, _EXEC_VALUED, _EXEC_FLAGS))
    asked = positional[0] if resuming and positional else None
    prompt = positional[-1] if positional[1 if resuming else 0:] else ""
    lines = [line.strip() for line in prompt.splitlines()]
    config = _overrides(options["-c"])
    root = _state()
    known = (root / "threads.txt").read_text(encoding="utf-8").split() \
        if root is not None and (root / "threads.txt").exists() else []

    record: dict = {"argv": sys.argv[1:], "cwd": os.getcwd(), "config": config,
                    "agents_md": Path("AGENTS.md").read_text(encoding="utf-8") if Path("AGENTS.md").exists() else None,
                    "resmon_env": sorted(k for k in os.environ if k.startswith("RESMON_")), "tools": None}

    def save() -> None:
        if root is not None:
            root.mkdir(parents=True, exist_ok=True)
            (root / "last-run.json").write_text(json.dumps(record), encoding="utf-8")

    save()
    for line in lines:
        if line.startswith("FAIL:"):
            sys.stderr.write(line[5:] + "\n")
            return 3
        if line.startswith("SILENT:"):
            time.sleep(float(line[7:]))
            return 0
        if line.startswith("HEADER:"):
            sys.stderr.write(f"OpenAI Codex (fake)\n--------\nworkdir: {os.getcwd()}\n"
                             f"model: {line[7:]}\nprovider: openai\nsandbox: read-only\n--------\n")
            sys.stderr.flush()

    if resuming and ("CANNOT_RESUME" in lines or (root is not None and asked not in known)):
        # Not a recorded sentence: no real codex was run to collect one.
        sys.stderr.write(f"Error: No saved session found with ID {asked}\n")
        return 1

    thread = str(uuid.uuid4()) if not resuming or "NEW_THREAD" in lines else str(asked)
    if root is not None and thread not in known:
        with (root / "threads.txt").open("a", encoding="utf-8") as handle:
            handle.write(thread + "\n")
    started: dict = {"type": "thread.started", "thread_id": thread}
    for line in lines:
        if line.startswith("MODEL:"):
            started["model"] = line[6:]
    emit(started)
    emit({"type": "turn.started"})

    if _auth_state() == "expired":
        said = ("unexpected status 401 Unauthorized: Your access token could not be refreshed. "
                "Please log in again.")
        emit({"type": "error", "message": said})
        emit({"type": "turn.failed", "error": {"message": said}})
        return 1

    server: Optional[_Server] = None
    counter = 0

    def next_id() -> str:
        nonlocal counter
        counter += 1
        return f"item_{counter}"

    try:
        for line in lines:
            if line.startswith("SAY:"):
                emit({"type": "item.completed", "item": {"id": next_id(), "type": "agent_message", "text": line[4:]}})
            elif line.startswith("REASONING:"):
                emit({"type": "item.completed", "item": {"id": next_id(), "type": "reasoning", "text": line[10:]}})
            elif line.startswith("RAW:"):
                sys.stdout.write(line[4:] + "\n")
                sys.stdout.flush()
            elif line.startswith("SLEEP:"):
                time.sleep(float(line[6:]))
            elif line.startswith("ERROR_ITEM:"):
                emit({"type": "item.completed", "item": {"id": next_id(), "type": "error", "message": line[11:]}})
            elif line.startswith("SHELL:"):
                emit({"type": "item.started", "item": {"id": next_id(), "type": "command_execution",
                                                      "command": line[6:], "aggregated_output": "",
                                                      "exit_code": None, "status": "in_progress"}})
                time.sleep(60)
            elif line.startswith("WEB:"):
                emit({"type": "item.started", "item": {"id": next_id(), "type": "web_search", "query": line[4:]}})
                time.sleep(60)
            elif line.startswith("OTHER_TOOL:"):
                other, _, tool = line[11:].strip().partition(" ")
                emit({"type": "item.started", "item": {"id": next_id(), "type": "mcp_tool_call", "server": other,
                                                      "tool": tool, "arguments": {}, "status": "in_progress"}})
                time.sleep(60)
            elif line.startswith("TURN_FAILED:"):
                emit({"type": "turn.failed", "error": {"message": line[12:]}})
                return 1
            elif line.startswith("CALL:"):
                tool, _, raw = line[5:].strip().partition(" ")
                args = json.loads(raw) if raw.strip() else {}
                if server is None:
                    server = _Server((config.get("mcp_servers") or {}).get("resmon") or {})
                    record["tools"] = server.tools
                    save()
                item = {"id": next_id(), "type": "mcp_tool_call", "server": "resmon", "tool": tool,
                        "arguments": args, "result": None, "error": None, "status": "in_progress"}
                emit({"type": "item.started", "item": item})
                result = server.request("tools/call", {"name": tool, "arguments": args})
                text = "\n".join(b.get("text", "") for b in result.get("content") or [] if isinstance(b, dict))
                failed = bool(result.get("isError"))
                emit({"type": "item.completed", "item": {
                    **item, "status": "failed" if failed else "completed",
                    "result": {"content": result.get("content") or [], "structured_content": None},
                    "error": {"message": text} if failed else None}})
    finally:
        if server is not None:
            server.close()

    if "NO_COMPLETE" in lines:
        return 0
    emit({"type": "turn.completed", "usage": {"input_tokens": 1200, "cached_input_tokens": 300,
                                              "output_tokens": 80}})
    return 0


def main() -> int:
    argv = sys.argv[1:]
    if argv[:1] == ["login"]:
        return _login(argv)
    if argv[:2] == ["debug", "models"]:
        return _models()
    if argv[:1] == ["exec"]:
        return _exec(argv[1:])
    sys.stderr.write(f"fake codex: not a command this double answers: {argv[:2]}\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
