"""Driving an agent CLI as resmon's embedded assistant.

The summary lanes could take their tools away; this one cannot. An assistant
that answers "what did my arXiv routine find this week" has to *ask*, and every
guardrail those lanes got for free from ``--tools ""`` has to be re-established
here as something the code enforces.

Four of them, each with a boundary a test can watch:

**resmon's MCP server is the only tool source.** ``--tools ""`` removes the
built-in set, ``--strict-mcp-config`` ignores every MCP server the user has
configured anywhere else, and ``--mcp-config`` names resmon's own two. The
session's first stream-json message lists what it actually got, so this is not
an argument about flags: ``test_the_real_cli_session_sees_exactly_our_tools``
reads that list and compares it to ``mcp_server.TOOLS``.

**No write runs until a person allows it.** ``--allowedTools`` pre-approves the
read tools *by name, derived from* ``mcp_server.READ_TOOLS``; everything else
routes to ``--permission-prompt-tool``, which is a tool resmon serves and the
model cannot call. Structural rather than instructed: the model has no path to
a write that does not go through the panel.

**The constitution arrives above the conversation, not inside it.** On
``--append-system-prompt``, with ``--system-prompt-snapshot off`` so it applies
fresh on every launch including a resumed one — verified against claude 2.1.258
by resuming a session and getting the appended rule's behaviour back. That flag
matters: with snapshotting on, a resumed conversation would replay whatever
system prompt was recorded the first time, and an edited constitution would not
reach an old session. The 1.8.4 failure was a lane that said "follow the
attached constitution" with nothing attached, and the agent fabricated a file
search rather than admitting it could not find one.

**The user's own Claude Code configuration stays out of it.**
``--setting-sources ""`` and ``--disable-slash-commands`` empty the skills and
slash commands the CLI would otherwise load from the user's home directory.
Measured, not assumed: without them the init message listed fifty of the user's
own slash commands and twenty-four skills inside what is supposed to be a
locked-down session.

## One process per turn

A turn spawns a CLI, streams it, and lets it exit. The first turn passes
``--session-id <uuid>``; every later one passes ``--resume <that uuid>``. The
alternative — one long-lived process per open conversation, fed over
``--input-format stream-json`` — is lower latency and worse in every way that
matters here: a process per open panel, a backend restart orphaning them, and
cancel becoming a kill of something holding conversation state. Resume across
processes *and across different working directories* was verified against the
installed CLI before this was chosen.

## The disguise an escaping exception wears

1.9a shipped two bugs that both looked like a network failure, because an
exception escaping before FastAPI's CORS middleware has no status code and the
browser reports ``net::ERR_FAILED``. A streaming endpoint is worse: the response
has already started, so an exception truncates the stream and the panel sees a
conversation that stopped mid-sentence. Everything in ``run_turn`` is therefore
inside a ``try`` that turns any failure into an ``error`` event, and the
generator's own consumer does the same.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from . import ai_cli
from .assistant_constitution import load_assistant_constitution

logger = logging.getLogger(__name__)

__all__ = [
    "bus",
    "cancel_turn",
    "is_running",
    "SessionBus",
    "EVENT_TYPES",
    "RUNTIME_KINDS",
    "AssistantRuntime",
    "ClaudeCliRuntime",
    "RuntimeStatus",
    "codex_unavailable_reason",
    "get_runtime",
    "runtime_status",
]

# The event vocabulary the panel renders. A CLI event that does not map onto one
# of these is dropped with a log line rather than passed through: the panel
# switches on this set, and an unknown shape reaching it renders as either
# nothing or raw JSON in a chat window. Both are worse than a gap.
EVENT_TYPES = (
    "started",            # the session is up; carries the tool list it was given
    "text_delta",         # a chunk of the assistant's reply
    "tool_call",          # the model asked for a tool
    "tool_result",        # what the tool returned
    "permission_request", # a write is waiting for the panel (emitted by the broker)
    "done",               # the turn finished; carries usage and cost
    "error",              # the turn failed; carries a sentence for a person
)

# Every runtime kind resmon can drive. The denominator for the transmission
# test: a kind added here with no test that watches its constitution arrive
# fails ``test_every_runtime_kind_has_a_transmission_test``.
RUNTIME_KINDS = ("claude_cli",)

# A turn that has produced nothing for this long is killed. Chosen against the
# summary lane's own timeouts rather than invented: a single interactive turn
# with a handful of localhost tool calls is far shorter work than a 50-document
# batch summary, and a person watching a panel will not wait ten minutes.
DEFAULT_TURN_TIMEOUT = 300


@dataclass(frozen=True)
class RuntimeStatus:
    """Whether an assistant can run at all, and if not, why not in one sentence."""

    kind: str
    available: bool
    reason: str
    path: Optional[str] = None
    how: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "kind": self.kind, "available": self.available,
            "reason": self.reason, "path": self.path, "how": self.how,
        }


def codex_unavailable_reason() -> str:
    """Why Codex is not offered as an assistant runtime, in the user's terms.

    Decision 1 of the phase brief offers Codex "only if its shell can be
    disabled". It cannot, on either path, and this was established against
    codex-cli 0.153.1 rather than assumed:

    * ``codex exec --strict-config -c tools.shell=false`` is rejected with
      ``unknown configuration field``; so are ``tools.shell.enabled`` and
      ``shell_tool``. ``tools.web_search`` *is* accepted, so ``--strict-config``
      really does discriminate between real and invented keys.
    * An MCP server *can* be attached per invocation
      (``-c 'mcp_servers.resmon={command=...}'`` is accepted), so the failure is
      not "cannot attach". It is that resmon's server cannot be made the *only*
      source.
    * ``codex exec`` has no interactive approval at all; ``--approve-for-me``
      routes approvals "through automatic review", which is an automatic
      approver rather than a person.
    * ``codex mcp-server`` exposes two tools, ``codex`` and ``codex-reply``, and
      its only approval control is ``approval-policy: on-request | never`` over
      *shell commands the model generates*.

    So an assistant on Codex would be an agent with a shell, on the user's
    machine, reading abstracts from the open internet. resmon's summary lane
    uses codex safely because it takes no tools and reads no live data; an
    assistant is the opposite of both.
    """
    return (
        "Codex is not offered for the assistant. resmon can attach its own tools "
        "to a Codex session but cannot take away Codex's shell, and there is no "
        "way for you to approve a command before it runs — so an assistant on "
        "Codex would be an agent that can run commands on your machine while "
        "reading text off the internet. Codex is still available for "
        "summarising papers, where it is given no tools at all."
    )


class AssistantRuntime:
    """What every runtime must provide. One implementation today."""

    kind = "unset"

    def status(self) -> RuntimeStatus:                      # pragma: no cover
        raise NotImplementedError

    def build_argv(self, *args: Any, **kwargs: Any) -> list[str]:   # pragma: no cover
        raise NotImplementedError

    def run_turn(self, *args: Any, **kwargs: Any) -> Iterator[dict]:  # pragma: no cover
        raise NotImplementedError


class ClaudeCliRuntime(AssistantRuntime):
    """``claude -p`` as a locked-down agent over resmon's MCP surface."""

    kind = "claude_cli"

    def __init__(
        self,
        *,
        cli_path: Optional[str] = None,
        model: Optional[str] = None,
        effort: Optional[str] = None,
        backend_port: Optional[int] = None,
        python_executable: Optional[str] = None,
        timeout: int = DEFAULT_TURN_TIMEOUT,
    ) -> None:
        self.configured_path = (cli_path or "").strip() or None
        self.model = (model or "").strip() or None
        self.effort = (effort or "").strip() or None
        self.backend_port = backend_port
        self.python_executable = python_executable or _bundled_python()
        self.timeout = timeout

    # -- availability ---------------------------------------------------

    def status(self) -> RuntimeStatus:
        found = ai_cli.discover_cli("claude_code", self.configured_path)
        if not found.found:
            return RuntimeStatus(self.kind, False, found.describe())
        return RuntimeStatus(self.kind, True, found.describe(), found.path, found.how)

    # -- the command ----------------------------------------------------

    def mcp_config(self, session_id: int, workdir: str) -> dict:
        """The two servers the CLI may use, and nothing else.

        ``RESMON_PORT`` is set explicitly on both. The MCP server never widens a
        named port to the default, and this is the reason that rule exists: with
        no port named, an MCP server started next to a *different* resmon on the
        default port answers every question truthfully about the wrong corpus.
        Which happened.
        """
        server_dir = str(Path(__file__).resolve().parent.parent)
        env = {"PYTHONPATH": server_dir}
        if self.backend_port:
            env["RESMON_PORT"] = str(self.backend_port)

        return {"mcpServers": {
            "resmon": {
                "command": self.python_executable,
                "args": [str(Path(server_dir) / "mcp_server.py")],
                "env": dict(env),
            },
            "resmon_permission": {
                "command": self.python_executable,
                "args": [str(Path(server_dir) / "assistant_permission_server.py")],
                "env": dict(env, RESMON_ASSISTANT_SESSION=str(session_id)),
            },
        }}

    def allowed_tools(self) -> list[str]:
        """The tools the model may call without asking anyone.

        Derived from ``mcp_server.READ_TOOLS`` rather than written out, so the
        pre-approved set and the set the contract calls safe are one list. A
        tool added without a ``requires_confirmation`` decision lands in
        ``READ_TOOLS`` and is caught by
        ``test_every_tool_declares_whether_it_needs_confirmation``.
        """
        import mcp_server  # noqa: PLC0415 — a sibling script, not a package

        return sorted(f"mcp__resmon__{name}" for name in mcp_server.READ_TOOLS)

    def build_argv(
        self,
        prompt: str,
        *,
        mcp_config_path: str,
        cli_session_id: str,
        resume: bool,
        binary: Optional[str] = None,
    ) -> list[str]:
        """The one place a flag can be added, so it cannot be on one path only.

        That is not a style preference: ``--append-system-prompt`` was missing
        from two of three summary lanes for a whole release because each built
        its own command.
        """
        argv = [
            binary or (self.status().path or "claude"),
            "-p",
            # stream-json requires --verbose. Not optional, and not documented
            # anywhere but the error: "When using --print,
            # --output-format=stream-json requires --verbose".
            "--output-format", "stream-json",
            "--verbose",
            # Built-in tools off; only resmon's MCP servers, ignoring every MCP
            # configuration the user has elsewhere.
            "--tools", "",
            "--strict-mcp-config",
            "--mcp-config", mcp_config_path,
            # The user's own skills, commands and settings stay out of a session
            # that is meant to be locked down.
            "--setting-sources", "",
            "--disable-slash-commands",
            # Reads run; everything else waits for the panel.
            "--allowedTools", " ".join(self.allowed_tools()),
            "--permission-prompt-tool", "mcp__resmon_permission__ask",
            # The constitution, above the conversation, re-applied on every
            # launch including a resumed one.
            "--append-system-prompt", load_assistant_constitution(),
            "--system-prompt-snapshot", "off",
        ]
        argv += ["--resume", cli_session_id] if resume else ["--session-id", cli_session_id]
        if self.model:
            argv += ["--model", self.model]
        if self.effort:
            argv += ["--effort", self.effort]
        argv.append(prompt)
        return argv

    # -- running --------------------------------------------------------

    def run_turn(
        self,
        session_id: int,
        prompt: str,
        *,
        cli_session_id: str,
        resume: bool,
        on_event: Optional[Callable[[dict], None]] = None,
    ) -> Iterator[dict]:
        """Spawn the CLI for one turn and yield normalised events.

        Runs in an empty temporary directory that is removed when the turn ends,
        so the CLI has nothing of the user's to read and nothing of resmon's to
        find except the MCP config it is handed.
        """
        emit = on_event or (lambda _event: None)
        with tempfile.TemporaryDirectory(prefix="resmon-assistant-") as workdir:
            config_path = os.path.join(workdir, "mcp.json")
            with open(config_path, "w", encoding="utf-8") as handle:
                json.dump(self.mcp_config(session_id, workdir), handle)

            argv = self.build_argv(
                prompt, mcp_config_path=config_path,
                cli_session_id=cli_session_id, resume=resume,
            )
            try:
                yield from self._stream(session_id, argv, workdir, emit)
            except Exception as exc:                # noqa: BLE001 - see the docstring
                # Nothing escapes into a half-written SSE response. A truncated
                # stream is indistinguishable, in a panel, from a model that
                # stopped mid-sentence.
                logger.exception("Assistant turn failed")
                yield _error_event(
                    "resmon could not finish that turn.",
                    detail=type(exc).__name__,
                )

    def _stream(
        self, session_id: int, argv: list[str], workdir: str,
        emit: Callable[[dict], None],
    ) -> Iterator[dict]:
        process = subprocess.Popen(
            argv, cwd=workdir, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
            # A fresh, minimal environment. The CLI needs HOME to find the
            # user's login; it does not need resmon's, and it must not inherit
            # RESMON_PORT from this process -- the MCP config sets that per
            # server, deliberately and explicitly.
            env=_child_env(),
        )
        with _PROCESS_LOCK:
            _PROCESSES[session_id] = process

        stderr_tail: list[str] = []
        stderr_thread = threading.Thread(
            target=_drain, args=(process.stderr, stderr_tail), daemon=True,
        )
        stderr_thread.start()

        final_error_text = ""
        try:
            for line in _lines_with_timeout(process, self.timeout):
                for event in _normalise(line):
                    if event["type"] == "done" and event.get("result_text"):
                        final_error_text = str(event["result_text"])
                    emit(event)
                    yield event

            code = process.wait(timeout=15)
            if code != 0:
                # The CLI's own last word first, then stderr. An auth failure
                # arrives in the result envelope with nothing on stderr at all.
                message = _classify_exit(
                    final_error_text or "".join(stderr_tail), code)
                event = _error_event(message, detail=f"exit {code}")
                emit(event)
                yield event
        finally:
            with _PROCESS_LOCK:
                if _PROCESSES.get(session_id) is process:
                    del _PROCESSES[session_id]
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)

    def cancel(self, session_id: int) -> bool:
        return cancel_turn(session_id)


# ---------------------------------------------------------------------------
# Running turns, and the bus the panel reads them off
# ---------------------------------------------------------------------------

# Module level rather than per-instance, because the endpoint that cancels a
# turn is a different request from the one that started it and builds its own
# runtime object. A per-instance registry would make cancel silently do nothing,
# which is the worst possible failure for a stop button.
_PROCESSES: dict[int, subprocess.Popen] = {}
_PROCESS_LOCK = threading.Lock()


def cancel_turn(session_id: int) -> bool:
    """Kill a session's running turn. False when there was nothing to kill."""
    with _PROCESS_LOCK:
        process = _PROCESSES.get(session_id)
    if process is None or process.poll() is not None:
        return False
    process.kill()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:                # pragma: no cover - defensive
        logger.warning("Assistant process for session %s did not die", session_id)
    return True


def is_running(session_id: int) -> bool:
    with _PROCESS_LOCK:
        process = _PROCESSES.get(session_id)
    return process is not None and process.poll() is None


class SessionBus:
    """One event queue per live conversation.

    Two producers write to a session's queue and they are not on the same side
    of the thread boundary: the CLI reader runs on a worker thread, and the
    permission endpoint runs on the event loop. ``queue.Queue`` is the whole
    reason this is a class rather than a list — the alternative was an
    asyncio.Queue that the worker thread cannot legally touch.
    """

    def __init__(self) -> None:
        self._queues: dict[int, "queue.Queue[dict]"] = {}
        self._lock = threading.Lock()

    def try_open(self, session_id: int) -> Optional["queue.Queue[dict]"]:
        """Claim a session for one turn, atomically. ``None`` when it is taken.

        **This is the concurrency guard, and it has to be here rather than at
        the endpoint.** The obvious guard — "is a process running for this
        session?" — was written first and was wrong: the subprocess is not
        registered until the worker thread reaches it, so a second request
        arriving in that window saw no process and was accepted. Two CLIs then
        ran the same conversation, resuming the same session id and racing each
        other into the transcript. Found by
        ``test_a_second_turn_is_refused_while_one_is_running``, which sends the
        second request in a loop rather than once.

        The claim is taken under this lock before the thread starts, so there is
        no window at all.
        """
        with self._lock:
            if session_id in self._queues:
                return None
            q: "queue.Queue[dict]" = queue.Queue()
            self._queues[session_id] = q
            return q

    def open(self, session_id: int) -> "queue.Queue[dict]":
        """Claim, replacing any existing claim. For tests and for a forced retake."""
        with self._lock:
            q: "queue.Queue[dict]" = queue.Queue()
            self._queues[session_id] = q
            return q

    def publish(self, session_id: int, event: dict) -> bool:
        """Push an event. False when nobody is listening, which is not an error.

        A permission request can arrive microseconds after the panel closed the
        stream; dropping it is correct, and the CLI still gets its deny from the
        broker's own timeout or from the cancel path.
        """
        with self._lock:
            q = self._queues.get(session_id)
        if q is None:
            return False
        q.put(event)
        return True

    def close(self, session_id: int) -> None:
        with self._lock:
            self._queues.pop(session_id, None)

    def is_open(self, session_id: int) -> bool:
        with self._lock:
            return session_id in self._queues


bus = SessionBus()


# ---------------------------------------------------------------------------
# Normalising the CLI's stream
# ---------------------------------------------------------------------------

def _normalise(line: str) -> list[dict]:
    """Turn one stream-json line into zero or more resmon events.

    Unknown message types are **dropped with a log line, never rendered raw**.
    The CLI's stream carries rate-limit notices, hook lifecycle, partial-message
    plumbing and whatever a later version adds; a panel that passed those
    through would show the user the inside of a tool they did not ask about.
    """
    line = line.strip()
    if not line:
        return []
    try:
        message = json.loads(line)
    except ValueError:
        logger.debug("Assistant runtime: unparseable stream line dropped")
        return []
    if not isinstance(message, dict):
        return []

    kind = message.get("type")

    if kind == "system" and message.get("subtype") == "init":
        return [{
            "type": "started",
            "cli_session_id": message.get("session_id"),
            "model": message.get("model"),
            # What the session actually got, as opposed to what was asked for.
            # The live denominator check reads this.
            "tools": message.get("tools") or [],
            "mcp_servers": message.get("mcp_servers") or [],
        }]

    if kind == "assistant":
        events: list[dict] = []
        body = message.get("message") or {}
        for block in body.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text"):
                events.append({"type": "text_delta", "text": block["text"]})
            elif block.get("type") == "tool_use":
                events.append({
                    "type": "tool_call",
                    "tool_name": _short_tool_name(block.get("name")),
                    "raw_name": block.get("name"),
                    "input": block.get("input") or {},
                    "tool_use_id": block.get("id"),
                })
        return events

    if kind == "user":
        events = []
        body = message.get("message") or {}
        for block in body.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                events.append({
                    "type": "tool_result",
                    "tool_use_id": block.get("tool_use_id"),
                    "is_error": bool(block.get("is_error")),
                    "content": _flatten_result(block.get("content")),
                })
        return events

    if kind == "result":
        usage = message.get("usage") or {}
        return [{
            "type": "done",
            # The envelope's own final text. Not rendered -- the assistant's
            # reply already arrived as text_delta events -- but kept because it
            # is where the CLI puts a failure it decided to answer with rather
            # than exit over. "Not logged in · Please run /login" comes back
            # this way, with an exit code and an empty stderr, so without this
            # the user is told "exit code 1 and resmon cannot tell you more"
            # when the CLI said exactly what was wrong.
            "result_text": message.get("result") if message.get("is_error") else None,
            "subtype": message.get("subtype"),
            "is_error": bool(message.get("is_error")),
            # ``None`` rather than 0 when the CLI did not report a figure. The
            # store keeps NULL and the panel says "not reported"; a zero here
            # would become a measured-looking number nobody measured.
            "cost_usd": message.get("total_cost_usd"),
            "input_tokens": _int_or_none(usage.get("input_tokens")),
            "output_tokens": _int_or_none(usage.get("output_tokens")),
            "cache_read_tokens": _int_or_none(usage.get("cache_read_input_tokens")),
            "cache_creation_tokens": _int_or_none(
                usage.get("cache_creation_input_tokens")),
            "duration_ms": message.get("duration_ms"),
            "num_turns": message.get("num_turns"),
        }]

    logger.debug("Assistant runtime: dropped a %r stream message", kind)
    return []


def _short_tool_name(raw: Any) -> str:
    """``mcp__resmon__list_routines`` → ``list_routines``.

    The panel shows the tool the user would recognise from the app, not the MCP
    address. The raw name rides along on the event for the transcript.
    """
    name = str(raw or "")
    if name.startswith("mcp__"):
        return name.rsplit("__", 1)[-1]
    return name


def _flatten_result(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [block.get("text", "") for block in content
                 if isinstance(block, dict) and block.get("type") == "text"]
        return "\n".join(p for p in parts if p)
    return json.dumps(content, default=str) if content is not None else ""


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _error_event(message: str, detail: Optional[str] = None) -> dict:
    return {"type": "error", "message": message, "detail": detail}


def _classify_exit(stderr: str, code: int) -> str:
    """One sentence a person can act on, built only from what the CLI said.

    Never a stack trace and never a guess: an unrecognised failure says the exit
    code and that resmon does not know, which is the honest answer.
    """
    lowered = stderr.lower()
    if "unknown option" in lowered or "unknown argument" in lowered:
        return (
            "The installed claude CLI does not accept one of the options resmon "
            "uses. Updating resmon, or the CLI, should fix it."
        )
    if any(word in lowered for word in ("not logged in", "log in", "unauthenticated",
                                        "authentication", "/login")):
        return ("The claude CLI is not signed in. Run `claude` in a terminal and "
                "sign in, then try again.")
    if "rate limit" in lowered or "usage limit" in lowered:
        return ("Your Claude usage limit has been reached. The assistant shares "
                "the same window as your own work.")
    first = next((l for l in stderr.splitlines() if l.strip()), "")
    if first:
        return f"The claude CLI stopped with exit code {code}: {first.strip()[:300]}"
    return (f"The claude CLI stopped with exit code {code} and said nothing about "
            f"why. resmon cannot tell you more than that.")


def _drain(stream, sink: list) -> None:
    try:
        for line in stream:
            sink.append(line)
            del sink[:-40]      # keep the tail; a banner is not a diagnosis
    except (ValueError, OSError):                    # pragma: no cover - closed
        pass


def _lines_with_timeout(process: subprocess.Popen, timeout: int) -> Iterator[str]:
    """stdout lines, giving up if the process goes quiet for *timeout* seconds.

    ``Popen.stdout`` has no read timeout, so a hung CLI would block the worker
    thread until the app closed. A reader thread and a queue give the wait a
    bound; the sentinel tells the consumer the pipe closed rather than stalled.
    """
    lines: queue.Queue = queue.Queue()
    sentinel = object()

    def _read() -> None:
        try:
            for line in process.stdout:
                lines.put(line)
        except (ValueError, OSError):                # pragma: no cover - closed
            pass
        finally:
            lines.put(sentinel)

    reader = threading.Thread(target=_read, daemon=True)
    reader.start()

    while True:
        try:
            item = lines.get(timeout=timeout)
        except queue.Empty:
            process.kill()
            raise TimeoutError(
                f"The assistant produced nothing for {timeout} seconds."
            ) from None
        if item is sentinel:
            return
        yield item


def _child_env() -> dict:
    """The environment the CLI runs in: the user's own, minus resmon's.

    **A denylist, and it started as an allowlist that broke the feature
    outright.** The concern is real and narrow: ``RESMON_PORT`` and the
    state-directory variables must not be inherited, because the CLI passes its
    environment to the MCP server it starts and the server would then have two
    things naming a port — the config, explicitly, and the environment,
    accidentally. That is the ambiguity the contract's "a named port is never
    widened" rule exists for.

    The first version answered it by keeping a short list of variables that
    looked necessary. It dropped ``USER``, and without ``USER`` the ``claude``
    CLI cannot find its stored login: every turn came back *"Not logged in ·
    Please run /login"* from a CLI that was signed in. Measured by bisecting the
    environment against the real binary — ``USER`` alone restores it, and
    ``LOGNAME``, ``SHELL``, ``TMPDIR`` and ``XPC_SERVICE_NAME`` do not.

    The lesson generalises past ``USER``: an allowlist of what an agent CLI
    needs is a guess about someone else's program, and the next thing it needs
    breaks the same way. The summary lane has always passed the environment
    through untouched, so this now matches it — the CLI is the user's own,
    running as the user, and the only thing it must not see is resmon's idea of
    where resmon is.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("RESMON_")}
    env.setdefault("PATH", os.defpath)
    return env


def _bundled_python() -> str:
    """The interpreter the MCP server is started with.

    ``sys.executable`` in the packaged app is the bundled interpreter beside the
    backend, which is the one that can import ``httpx``. A bare ``python3``
    would resolve against the user's PATH — where there may be none at all,
    since a Finder-launched app inherits ``/usr/bin:/bin:/usr/sbin:/sbin``.
    """
    import sys  # noqa: PLC0415

    return sys.executable or shutil.which("python3") or "python3"


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------

def get_runtime(settings: dict, *, backend_port: Optional[int] = None) -> AssistantRuntime:
    """The configured runtime. Only ``claude_cli`` exists in 2.0a."""
    return ClaudeCliRuntime(
        cli_path=settings.get("ai_cli_path") or "",
        model=settings.get("assistant_model") or "",
        effort=settings.get("assistant_effort") or "",
        backend_port=backend_port,
    )


def runtime_status(settings: dict, *, backend_port: Optional[int] = None) -> dict:
    """What ``/api/assistant/status`` answers.

    Codex is listed as unavailable **with its reason**, rather than omitted. A
    user who has Codex installed and sees no mention of it would reasonably
    conclude resmon had not noticed.
    """
    runtime = get_runtime(settings, backend_port=backend_port)
    status = runtime.status()
    codex = ai_cli.discover_cli("codex", settings.get("ai_cli_path") or "")
    return {
        "runtime": status.to_dict(),
        "available": status.available,
        "reason": status.reason,
        "model": runtime.model,
        "effort": runtime.effort,
        "kinds": list(RUNTIME_KINDS),
        "others": [{
            "kind": "codex_cli",
            "installed": codex.found,
            "available": False,
            "reason": codex_unavailable_reason(),
        }],
    }
