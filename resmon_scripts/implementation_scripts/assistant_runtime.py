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
import time
import uuid
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
    "AssistantStartupTimeout",
    "RuntimeStatus",
    "TURN_BUDGET_USD",
    "cannot_resume_notice",
    "codex_unavailable_reason",
    "get_runtime",
    "runtime_status",
]

# The event vocabulary the panel renders. A CLI event that does not map onto one
# of these is dropped with a log line rather than passed through: the panel
# switches on this set, and an unknown shape reaching it renders as either
# nothing or raw JSON in a chat window. Both are worse than a gap.
EVENT_TYPES = (
    "model_report",       # literal runtime response field, never a request echo
    "started",            # the session is up; carries the tool list it was given
    "text_delta",         # a chunk of the assistant's reply
    "tool_call",          # the model asked for a tool
    "tool_result",        # what the tool returned
    "permission_request", # a write is waiting for the panel (emitted by the broker)
    "notice",             # resmon has something to say about the conversation
                          # itself rather than about the research -- rendered as
                          # a system line, stored as a system message
    "done",               # the turn finished; carries usage and cost
    "error",              # the turn failed; carries a sentence for a person
)

# Every runtime kind resmon can drive. The denominator for the transmission
# test: a kind added here with no test that watches its constitution arrive
# fails ``test_every_runtime_kind_has_a_transmission_test``.
#
# ``api_key`` (2.0b) is resmon's own loop over the same tools, for someone with
# a provider key and no agent CLI. It has three request shapes and each one is a
# separate place the constitution has to arrive, so the transmission test is
# parametrised over families as well as kinds -- 1.8.4's defect was one lane of
# three, and "the runtime sends it" was true of the runtime and false of two of
# its paths.
RUNTIME_KINDS = ("claude_cli", "api_key")

# A turn that has produced nothing for this long is killed. Chosen against the
# summary lane's own timeouts rather than invented: a single interactive turn
# with a handful of localhost tool calls is far shorter work than a 50-document
# batch summary, and a person watching a panel will not wait ten minutes.
DEFAULT_TURN_TIMEOUT = 300

# How long the CLI may take to say its *first* word before resmon stops waiting.
#
# Separate from the silence timeout above, and much shorter, because the two are
# different failures. A turn that has started and then goes quiet is thinking; a
# turn that has said nothing at all has not started, and waiting five minutes to
# tell someone that is indefensible.
#
# **Measured rather than chosen.** The CLI's ``init`` message is the first thing
# it emits, and across every measurement taken while diagnosing the v2.0.1 field
# defect -- shell, packaged bundle, dev app, spawned by Node, spawned by
# Electron, with and without MCP servers, cold and warm -- it arrived in
# **0.25 s to 2.98 s**. Thirty seconds is ten times the slowest ever seen.
#
# This is what turns the field defect from a five-minute spinner ending in
# "resmon could not finish that turn" into a specific sentence in half a minute.
# It does not stop the CLI hanging; it stops resmon pretending that is normal.
FIRST_OUTPUT_TIMEOUT = 30

# A hard stop the CLI enforces on itself, per turn, in dollars.
#
# Token efficiency is a *contract* term rather than an aspiration -- "a harness
# asking what did my arXiv routine find this week must not cost a five-hour
# usage window" -- and until now the only things holding it were the tool
# surface's small page sizes and the constitution asking nicely. ``claude`` has
# ``--max-budget-usd``, so it can be enforced, and it fails cleanly and
# detectably (``subtype: error_max_budget_usd``, verified against 2.1.258).
#
# 0.75 is **four times the dearest of the ten canonical requests measured**
# (create-routine, $0.1875 -- see
# ``workspace/handbacks/2.0/evidence/assistant-cost.md``). Four rather than two,
# because this is a runaway stop and not a quota: a turn costing twice the
# dearest measured is a big question, and one costing four times it is a loop.
# The regression *detector* is a different number in a different place --
# ``test_assistant_budget.py`` holds the canonical requests to 2x -- so a change
# that makes ordinary turns dearer fails a test rather than cutting off a user's
# answer.
TURN_BUDGET_USD = 0.75

# What ``claude`` says when the conversation behind ``--resume`` is gone.
#
# **Established against the binary, not guessed.** claude 2.1.258, in an empty
# directory, ``--resume`` with a syntactically valid session id it has never
# seen:
#
#     exit code 1
#     stdout: {"type":"result","subtype":"error_during_execution","is_error":true,
#              "num_turns":0,"session_id":"<the id>","total_cost_usd":0,
#              "errors":["No conversation found with session ID: <the id>"], ...}
#     stderr: No conversation found with session ID: <the id>
#
# Three things in that shape matter. The envelope carries **no ``result``
# field at all**, so a classifier reading only the result text has nothing to
# read. The subtype is the generic ``error_during_execution``, so the subtype
# alone cannot tell this apart from any other mid-run failure. The specific
# sentence is in ``errors``, an array 2.0a's normaliser dropped on the floor --
# which is why this is matched on ``errors`` first and on stderr only as a
# fallback.
#
# Matched on the stable half of the sentence. The session id is interpolated
# into it, so the whole string is never a constant; "no conversation found" is
# the part that is.
_CANNOT_RESUME_MARKERS = ("no conversation found",)


def cannot_resume_notice() -> str:
    """What the person is told when the CLI has lost their conversation.

    It says three things and claims nothing else: the CLI no longer has it,
    resmon carried on in a new one, and the assistant does not remember what
    was said before. That last clause is the honest half — resmon's own record
    of the conversation is still on screen, and it would be easy to let the
    user infer the assistant can still see it.
    """
    return (
        "The claude CLI no longer has this conversation, so resmon started a "
        "fresh one to answer you. Your earlier messages are still here, but the "
        "assistant is not able to see them any more."
    )


def _is_cannot_resume(errors: Any, stderr: str) -> bool:
    """Whether a failed turn failed because the CLI could not resume.

    ``errors`` first: it is the CLI's own structured account of what went
    wrong. stderr is the fallback for a version that stops populating it.
    """
    haystacks = []
    if isinstance(errors, (list, tuple)):
        haystacks.extend(str(item).lower() for item in errors)
    elif errors:
        haystacks.append(str(errors).lower())
    if stderr:
        haystacks.append(stderr.lower())
    return any(marker in text for text in haystacks
               for marker in _CANNOT_RESUME_MARKERS)


class AssistantStartupTimeout(Exception):
    """The CLI was spawned and never said anything.

    Its own message reaches the panel, which is the point: ``run_turn``'s
    catch-all turns every other failure into "resmon could not finish that
    turn", and that sentence is what a user saw for five minutes in v2.0.0 and
    v2.0.1 when the CLI hung before its first line.
    """


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
        profile: Optional[str] = None,
    ) -> None:
        if profile not in (None, "selected_evidence_v1"):
            raise ValueError("Unknown runtime profile")
        self.profile = profile
        self._selected_cancel = threading.Event()
        self._selected_owned_job = None
        self.selected_system_sha256 = None
        self.configured_path = (cli_path or "").strip() or None
        self.model = (model or "").strip() or None
        self.effort = (effort or "").strip() or None
        self.backend_port = backend_port
        self.python_executable = python_executable or _bundled_python()
        self.timeout = timeout
        self.resolved_binary: Optional[str] = None
        self.admitted_status: Optional[RuntimeStatus] = None

    # -- availability ---------------------------------------------------

    def status(self) -> RuntimeStatus:
        if self.admitted_status is not None:
            return self.admitted_status
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
        if self.profile == "selected_evidence_v1":
            return {"mcpServers": {}}
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
        if self.profile == "selected_evidence_v1":
            return []
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
        if self.profile == "selected_evidence_v1":
            from .selected_evidence_context import system_rules
            from .evidence import identity
            from .selected_evidence import sha
            system = system_rules()
            if self.selected_system_sha256 is not None and sha(system) != self.selected_system_sha256:
                raise ValueError("Selected system rules changed after admission")
            identity(cli_session_id)
            if resume:
                raise ValueError("Selected evidence cannot resume a native session")
            argv = [binary or self.resolved_binary or (self.status().path or "claude"), "-p",
                    "--output-format", "stream-json", "--verbose", "--tools", "",
                    "--strict-mcp-config", "--mcp-config", mcp_config_path,
                    "--setting-sources", "", "--disable-slash-commands",
                    "--append-system-prompt", system, "--system-prompt-snapshot", "off",
                    "--max-budget-usd", str(TURN_BUDGET_USD), "--session-id", cli_session_id]
            if self.model is not None:
                argv += ["--model", self.model]
            if self.effort is not None:
                argv += ["--effort", self.effort]
            return [*argv, prompt]
        argv = [
            binary or self.resolved_binary or (self.status().path or "claude"),
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
            # The turn's own hard stop. See TURN_BUDGET_USD.
            "--max-budget-usd", str(TURN_BUDGET_USD),
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
        history: Optional[list[dict]] = None,
    ) -> Iterator[dict]:
        """Spawn the CLI for one turn and yield normalised events.

        ``history`` is accepted and unused: the CLI keeps the conversation and
        ``--resume`` is how it is reached. It is in the signature because the
        API-key runtime needs it and a caller must not have to know which
        runtime it is holding.

        Runs in an empty temporary directory that is removed when the turn ends,
        so the CLI has nothing of the user's to read and nothing of resmon's to
        find except the MCP config it is handed.

        **A resume the CLI cannot honour is recovered from, once, and said out
        loud.** ``claude`` keeps its conversations in its own storage, on its
        own terms: a user who runs ``claude`` themselves, clears its history, or
        moves to a machine that restored resmon's database but not the CLI's,
        has a resmon conversation whose CLI session no longer exists. Before
        this, that turn simply failed -- the user's message was stored, nothing
        answered it, and the sentence they got was "exit code 1". Now the failed
        resume is recognised from what the CLI actually said, a fresh CLI
        session answers the same message, and a ``notice`` event tells the
        person their earlier messages are still on screen but no longer in front
        of the assistant.

        Once, and only for this failure. A retry loop on an unrecognised failure
        would double every real error, and a retry that did not say anything
        would quietly turn "it remembers" into "it does not".
        """
        emit = on_event or (lambda _event: None)
        if self.profile == "selected_evidence_v1":
            if resume or history:
                raise ValueError("Selected evidence cannot receive history or resume")
            yield from self._selected_turn(session_id, prompt, cli_session_id, emit)
            return
        with tempfile.TemporaryDirectory(prefix="resmon-assistant-") as workdir:
            config_path = os.path.join(workdir, "mcp.json")
            with open(config_path, "w", encoding="utf-8") as handle:
                json.dump(self.mcp_config(session_id, workdir), handle)

            try:
                yield from self._turn_with_resume_recovery(
                    session_id, prompt, config_path, workdir,
                    cli_session_id=cli_session_id, resume=resume, emit=emit,
                )
            except AssistantStartupTimeout as exc:
                # This one carries its own sentence. The catch-all below would
                # flatten it to "resmon could not finish that turn", which is
                # what a user saw for five minutes in v2.0.0 and v2.0.1 and
                # could do nothing with.
                logger.warning("Assistant turn: %s", exc)
                yield _error_event(str(exc), detail="startup_timeout")
            except Exception as exc:                # noqa: BLE001 - see the docstring
                # Nothing escapes into a half-written SSE response. A truncated
                # stream is indistinguishable, in a panel, from a model that
                # stopped mid-sentence.
                logger.exception("Assistant turn failed")
                yield _error_event(
                    "resmon could not finish that turn.",
                    detail=type(exc).__name__,
                )

    def _turn_with_resume_recovery(
        self, session_id: int, prompt: str, config_path: str, workdir: str,
        *, cli_session_id: str, resume: bool, emit: Callable[[dict], None],
    ) -> Iterator[dict]:
        """One turn, retried once as a new CLI session if the resume was refused.

        The failed attempt's own ``done`` and ``error`` events are **withheld**
        rather than forwarded. They are true about a CLI invocation and false
        about the turn: the panel would finalise the message, show a failure and
        then start streaming an answer underneath it. What the person gets
        instead is the ``notice``, then the answer.
        """
        outcome: dict = {}
        argv = self.build_argv(
            prompt, mcp_config_path=config_path,
            cli_session_id=cli_session_id, resume=resume,
        )
        for event in self._stream(session_id, argv, workdir, emit, outcome=outcome):
            if resume and event["type"] in ("done", "error"):
                # Held back until the stream ends, because whether they are the
                # turn's outcome or a discarded first attempt is not known yet.
                outcome.setdefault("held", []).append(event)
                continue
            yield event

        held = outcome.pop("held", [])
        if not outcome.get("cannot_resume"):
            for event in held:
                emit(event)
                yield event
            return

        logger.info(
            "Assistant session %s could not be resumed; starting a fresh CLI session",
            session_id,
        )
        notice = {
            "type": "notice",
            "code": "cannot_resume",
            "message": cannot_resume_notice(),
        }
        emit(notice)
        yield notice

        fresh = str(uuid.uuid4())
        argv = self.build_argv(
            prompt, mcp_config_path=config_path,
            cli_session_id=fresh, resume=False,
        )
        # No ``outcome`` on the retry: a second cannot-resume against an id the
        # CLI has never seen would mean something other than a lost
        # conversation, and one retry is the whole allowance either way.
        yield from self._stream(session_id, argv, workdir, emit)

    def _stream(
        self, session_id: int, argv: list[str], workdir: str,
        emit: Callable[[dict], None], outcome: Optional[dict] = None,
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
        failed_subtype = ""
        reported_errors: list = []
        try:
            for line in _lines_with_timeout(process, self.timeout):
                for event in _normalise(line):
                    if event['type'] == 'started':
                        native_flag = '--resume' if '--resume' in argv else '--session-id'
                        expected_native = argv[argv.index(native_flag) + 1] if native_flag in argv else None
                        # A provider-returned ID is not authority to resume a
                        # different native conversation next time.
                        event['owned_cli_session_id'] = expected_native if event.get('cli_session_id') == expected_native else None
                    if event["type"] == "done" and event.get("is_error"):
                        final_error_text = str(event.get("result_text") or "")
                        failed_subtype = str(event.get("subtype") or "")
                        reported_errors = list(event.get("errors") or [])
                    emit(event)
                    yield event

            code = process.wait(timeout=15)
            if code != 0 or failed_subtype:
                stderr_text = "".join(stderr_tail)
                if outcome is not None:
                    outcome["cannot_resume"] = _is_cannot_resume(
                        reported_errors, stderr_text)
                # The CLI's own last word first, then stderr. An auth failure
                # arrives in the result envelope with nothing on stderr at all,
                # and the budget stop arrives as a subtype with no text.
                message = _classify_failure(
                    failed_subtype,
                    final_error_text or "; ".join(str(e) for e in reported_errors)
                    or stderr_text,
                    code,
                    errors=reported_errors,
                )
                event = _error_event(message, detail=failed_subtype or f"exit {code}")
                emit(event)
                yield event
        finally:
            with _PROCESS_LOCK:
                if _PROCESSES.get(session_id) is process:
                    del _PROCESSES[session_id]
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)

    def _selected_turn(self, session_id: int, prompt: str, native_id: str,
                       emit: Callable[[dict], None]) -> Iterator[dict]:
        """Bound pipes before allocation; require observed empty startup inventory.

        Ordinary Ask keeps its original environment and stream handling. The
        selected profile projects only native login/location prerequisites from
        that helper; no arbitrary API key or application variable is inherited.
        """
        from . import selected_evidence as se
        import queue
        stop = threading.Event()
        events: queue.Queue = queue.Queue(maxsize=16)
        process = None
        readers = []
        deadline = time.monotonic() + min(self.timeout, 300)
        with tempfile.TemporaryDirectory(prefix="resmon-selected-") as workdir:
            config = os.path.join(workdir, "mcp.json")
            Path(config).write_text('{"mcpServers":{}}', encoding='utf-8')
            argv = self.build_argv(prompt, mcp_config_path=config, cli_session_id=native_id, resume=False)
            source_env = _child_env()
            env = {k: source_env[k] for k in ('HOME','USER','LOGNAME','PATH','TMPDIR','LANG','LC_ALL','SYSTEMROOT','WINDIR') if k in source_env}
            def consume(stream: Any, label: str) -> None:
                try:
                    while not stop.is_set():
                        chunk = os.read(stream.fileno(), 16384)
                        while not stop.is_set():
                            try:
                                events.put((label, chunk), timeout=0.1)
                                break
                            except queue.Full:
                                continue
                        if not chunk:
                            return
                except OSError:
                    return
            try:
                if session_id >= 0:
                    raise ValueError('Selected evidence requires its negative job identity')
                with _PROCESS_LOCK:
                    if self._selected_cancel.is_set():
                        raise ValueError("selected_cancelled_before_spawn")
                    self._selected_owned_job = session_id
                    if session_id in _PROCESSES:
                        raise ValueError('Selected job is already owned')
                    process = subprocess.Popen(argv, cwd=workdir, stdin=subprocess.DEVNULL,
                                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
                    _PROCESSES[session_id] = process
                for stream, label in ((process.stdout,'stdout'), (process.stderr,'stderr')):
                    thread = threading.Thread(target=consume, args=(stream,label), daemon=True)
                    readers.append(thread); thread.start()
                pending = bytearray(); total = stderr_bytes = text_bytes = 0
                ended = set(); started = completed = False
                while len(ended) < 2:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('selected_deadline')
                    try:
                        label, chunk = events.get(timeout=0.1)
                    except queue.Empty:
                        if process.poll() is not None and all(not t.is_alive() for t in readers):
                            break
                        continue
                    if not chunk:
                        ended.add(label)
                        continue
                    if label == 'stderr':
                        stderr_bytes += len(chunk)
                        if stderr_bytes > 16384:
                            raise ValueError('selected_stderr_limit')
                        # Diagnostics are intentionally not copied into public events.
                        continue
                    total += len(chunk)
                    if total > 1048576:
                        raise ValueError('selected_stream_limit')
                    pending.extend(chunk)
                    while b'\n' in pending:
                        line, _, remaining = pending.partition(b'\n'); pending = bytearray(remaining)
                        if len(line) > 262144:
                            raise ValueError('selected_line_limit')
                        message = json.loads(line.decode('utf-8'), object_pairs_hook=se._unique,
                                             parse_constant=lambda _: se.fail('Nonfinite transport JSON'))
                        if not isinstance(message, dict):
                            raise ValueError('selected_stream_shape')
                        if message.get('type') == 'system' and message.get('subtype') == 'init':
                            if (started or message.get('session_id') != native_id or
                                    message.get('tools') != [] or message.get('mcp_servers') != []):
                                raise ValueError('selected_startup_inventory')
                            started = True
                        normal = _normalise(line.decode('utf-8'))
                        for event in normal:
                            kind = event['type']
                            if kind in ('tool_call','tool_result'):
                                raise ValueError('selected_unexpected_tool')
                            if kind != 'started' and not started:
                                raise ValueError('selected_missing_startup')
                            if completed:
                                raise ValueError('selected_after_completion')
                            if kind == 'text_delta':
                                text_bytes += len(event['text'].encode('utf-8'))
                                if text_bytes > 65536:
                                    raise ValueError('selected_text_limit')
                            if kind == 'done':
                                if event.get('is_error') or event.get('subtype') != 'success':
                                    raise ValueError('selected_completion_failure')
                                completed = True
                            emit(event); yield event
                    if len(pending) > 262144:
                        raise ValueError('selected_line_limit')
                if pending or not started or not completed or process.wait(timeout=10) != 0:
                    raise ValueError('selected_incomplete_stream')
            except Exception as exc:
                event = {'type':'error','detail':type(exc).__name__,
                         'message':'Selected evidence runtime failed; no retry or structured result was published.'}
                emit(event); yield event
            finally:
                stop.set()
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=10)
                    for thread in readers:
                        thread.join(timeout=2)
                    process.stdout.close(); process.stderr.close()
                    with _PROCESS_LOCK:
                        if _PROCESSES.get(session_id) is process:
                            del _PROCESSES[session_id]

    def cancel(self, session_id: int) -> bool:
        if self.profile == 'selected_evidence_v1':
            if self._selected_owned_job != session_id:
                return False
            self._selected_cancel.set()
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

    def close(self, session_id: int, *, expected: Optional["queue.Queue[dict]"] = None) -> None:
        with self._lock:
            if expected is None or self._queues.get(session_id) is expected:
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
        from .assistant_choices import report

        return [{
            "type": "started",
            "cli_session_id": message.get("session_id"),
            "model": message.get("model"),
            "model_report": report(message.get("model"), "claude_system_init_model"),
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
            # The CLI's structured account of what went wrong, which is where a
            # failed ``--resume`` says so. 2.0a dropped this field; the result
            # envelope for a lost conversation has no ``result`` text at all, so
            # dropping it left the only description of the failure on stderr.
            "errors": [str(e) for e in (message.get("errors") or [])],
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


def _classify_failure(
    subtype: str, stderr: str, code: int, *, errors: Optional[list] = None,
) -> str:
    """One sentence a person can act on, built only from what the CLI said.

    Never a stack trace and never a guess: an unrecognised failure says the exit
    code and that resmon does not know, which is the honest answer.

    The cannot-resume branch is reachable in normal running only when the retry
    in ``_turn_with_resume_recovery`` is not in play -- a turn that was not a
    resume, or a caller driving ``_stream`` directly. It is here so that a
    caller who does not recover still gets the real reason rather than "exit 1".
    """
    if _is_cannot_resume(errors, stderr):
        return (
            "The claude CLI no longer has this conversation, so it could not be "
            "picked up where it left off. Start a new conversation to carry on."
        )
    if subtype == "error_max_budget_usd":
        return (
            f"That turn reached resmon's per-answer spending limit of "
            f"${TURN_BUDGET_USD:.2f} and was stopped part-way. Ask for something "
            f"narrower - a smaller page of results, or one question at a time."
        )
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


def _lines_with_timeout(
    process: subprocess.Popen, timeout: int,
    first_timeout: int = FIRST_OUTPUT_TIMEOUT,
) -> Iterator[str]:
    """stdout lines, with two deadlines: one to start, a longer one to continue.

    ``Popen.stdout`` has no read timeout, so a hung CLI would block the worker
    thread until the app closed. A reader thread and a queue give the wait a
    bound; the sentinel tells the consumer the pipe closed rather than stalled.

    **Two deadlines, because there are two failures.** A turn that has begun
    answering and then goes quiet is thinking, and gets ``timeout``. A turn that
    has said *nothing at all* has not begun, and gets ``first_timeout`` --
    thirty seconds against a first line that has never taken longer than three
    (see ``FIRST_OUTPUT_TIMEOUT``).

    That distinction is the v2.0.1 field defect. The CLI hung before its first
    line and resmon waited the full five minutes, then said "resmon could not
    finish that turn" -- a sentence that names nothing and suggests nothing. The
    startup deadline does not stop the CLI hanging. It stops resmon treating a
    silent CLI as a slow one.
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

    started = False
    while True:
        wait = timeout if started else min(first_timeout, timeout)
        try:
            item = lines.get(timeout=wait)
        except queue.Empty:
            process.kill()
            if not started:
                raise AssistantStartupTimeout(
                    f"The claude command started but said nothing for "
                    f"{wait} seconds, so resmon stopped waiting. It normally "
                    f"answers within a second. Run `claude` once in a terminal "
                    f"to check it works and is signed in, then try again."
                ) from None
            raise TimeoutError(
                f"The assistant produced nothing for {wait} seconds."
            ) from None
        if item is sentinel:
            return
        started = True
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

def assistant_provider(settings: dict) -> str:
    """Which provider the API-key runtime uses.

    ``assistant_provider`` when it is set, and the summary lane's own
    ``ai_provider`` when it is not. Falling back rather than requiring a second
    choice: someone who has already told resmon which provider to summarise with
    has answered this question, and asking twice is how the two drift apart.
    ``/api/assistant/status`` reports which of the two was used, so the fallback
    is visible rather than magic.
    """
    explicit = str(settings.get("assistant_provider") or "").strip().lower()
    if explicit:
        return explicit
    return str(settings.get("ai_provider") or "").strip().lower()


def get_runtime(settings: dict, *, backend_port: Optional[int] = None) -> AssistantRuntime:
    """The configured runtime.

    ``claude_cli`` unless the user has chosen ``api_key``. The CLI stays the
    default because it spends a subscription the user already has rather than a
    key they pay per token for -- decision 1's "but not first".
    """
    if str(settings.get("assistant_runtime") or "").strip().lower() == "api_key":
        from .assistant_api_runtime import ApiKeyRuntime  # noqa: PLC0415

        provider = assistant_provider(settings)
        return ApiKeyRuntime(
            provider=provider,
            model=settings.get("assistant_model") or "",
            custom_base_url=settings.get("ai_custom_base_url") or "",
            backend_port=backend_port,
        )
    return ClaudeCliRuntime(
        cli_path=settings.get("ai_cli_path") or "",
        model=settings.get("assistant_model") or "",
        effort=settings.get("assistant_effort") or "",
        backend_port=backend_port,
    )


def get_bound_runtime(binding: dict, settings: dict, *, backend_port: Optional[int] = None, profile: Optional[str] = None) -> AssistantRuntime:
    """Construct once from a validated saved request and captured route settings."""
    from .assistant_choices import request_projection, route_digest
    from .assistant_api_runtime import ApiKeyRuntime

    request_projection(binding)
    if route_digest(settings, binding['runtime'], binding['provider']) != binding['route_digest']:
        raise ValueError('This connection configuration changed. Start a new conversation.')
    if binding['runtime'] == 'api_key':
        runtime = ApiKeyRuntime(provider=binding['provider'], model=binding['requested_model'],
                                custom_base_url=settings.get('ai_custom_base_url'), backend_port=backend_port, profile=profile)
    else:
        runtime = ClaudeCliRuntime(cli_path=settings.get('ai_cli_path'), model=binding['requested_model'],
                                   effort=binding['requested_effort'], backend_port=backend_port, profile=profile)
        status = runtime.status()
        runtime.resolved_binary = status.path
        runtime.admitted_status = status
    # The explicit ID is one literal argument; constructor normalization must
    # not silently change the immutable requested value.
    runtime.model = binding['requested_model']
    return runtime


def runtime_status(settings: dict, *, backend_port: Optional[int] = None) -> dict:
    """What ``/api/assistant/status`` answers.

    Codex is listed as unavailable **with its reason**, rather than omitted. A
    user who has Codex installed and sees no mention of it would reasonably
    conclude resmon had not noticed.
    """
    from .assistant_api_runtime import ApiKeyRuntime  # noqa: PLC0415
    from .assistant_tool_calling import tool_calling  # noqa: PLC0415

    runtime = get_runtime(settings, backend_port=backend_port)
    status = runtime.status()
    codex = ai_cli.discover_cli("codex", settings.get("ai_cli_path") or "")

    # Both runtimes are reported, always, whichever is selected. A user whose
    # CLI is missing needs to see that the other route exists, and a user on the
    # API-key route needs to see that the CLI one is there -- the same reason
    # codex is listed with its reason rather than omitted.
    provider = assistant_provider(settings)
    alternative = (
        ClaudeCliRuntime(cli_path=settings.get("ai_cli_path") or "")
        if runtime.kind == "api_key" else
        ApiKeyRuntime(provider=provider,
                      model=settings.get("assistant_model") or "",
                      custom_base_url=settings.get("ai_custom_base_url") or "",
                      backend_port=backend_port)
    )
    alternative_status = alternative.status()
    answer = tool_calling(provider)

    return {
        "runtime": status.to_dict(),
        "available": status.available,
        "reason": status.reason,
        "model": getattr(runtime, "model", None),
        "effort": getattr(runtime, "effort", None),
        "kinds": list(RUNTIME_KINDS),
        "provider": provider,
        "provider_source": (
            "assistant_provider" if str(settings.get("assistant_provider") or "").strip()
            else "ai_provider"
        ),
        "tool_calling": {
            "state": answer.state,
            "reason": answer.reason,
            "assistant": answer.assistant,
            "assistant_reason": answer.assistant_reason,
        },
        "others": [
            {
                "kind": alternative.kind,
                "installed": True,
                "available": alternative_status.available,
                "reason": alternative_status.reason,
            },
            {
                "kind": "codex_cli",
                "installed": codex.found,
                "available": False,
                "reason": codex_unavailable_reason(),
            },
        ],
    }
