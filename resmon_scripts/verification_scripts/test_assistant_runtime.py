"""The assistant runtime: the command it builds, and the events it emits.

Two boundaries, and each row of the handback's ledger says which:

* **argv** — what the CLI is actually spawned with. This is where P1 lives, and
  it is the boundary because 1.8.4's defect was invisible everywhere else: the
  constitution loaded, memoised and was under 16 KB, and two lanes still sent
  "follow the attached constitution" with nothing attached.
* **a real subprocess running a hermetic double** — a Python script that speaks
  stream-json and performs the real permission handshake, but hosts no model.
  Real process, real pipes, real kill; fake decisions.

What neither can see is listed in the handback's *Not covered* and checked
against the installed CLI under ``live_network``: that the real binary still
accepts these flags, and that the session really receives only resmon's tools.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import mcp_server  # noqa: E402
from implementation_scripts import assistant_runtime as ar  # noqa: E402
from implementation_scripts.assistant_constitution import (  # noqa: E402
    load_assistant_constitution,
)

FAKE_CLAUDE = Path(__file__).resolve().parent / "fixtures" / "fake_claude.py"


def fake_binary(tmp_path: Path) -> str:
    """A shim that runs the double under *this* interpreter.

    Not a detail: the runtime deliberately hands the child a stripped
    environment, so a ``#!/usr/bin/env python3`` shebang would resolve against
    whatever PATH survives — which on a Finder-launched app is
    ``/usr/bin:/bin:/usr/sbin:/sbin`` and has no ``httpx``. The shim pins the
    interpreter the way the packaged app pins its own.
    """
    shim = tmp_path / "fake-claude"
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_CLAUDE}" "$@"\n')
    shim.chmod(0o755)
    return str(shim)


def argv_for(runtime: ar.ClaudeCliRuntime, prompt: str = "hello", **kwargs) -> list[str]:
    return runtime.build_argv(
        prompt,
        mcp_config_path=kwargs.pop("mcp_config_path", "/tmp/mcp.json"),
        cli_session_id=kwargs.pop("cli_session_id", "11111111-1111-1111-1111-111111111111"),
        resume=kwargs.pop("resume", False),
        binary=kwargs.pop("binary", "/usr/bin/claude"),
    )


def flag_value(argv: list[str], name: str) -> str:
    return argv[argv.index(name) + 1]


# ---------------------------------------------------------------------------
# P1 — the constitution arrives on the system channel
# ---------------------------------------------------------------------------

def test_the_constitution_arrives_on_the_system_channel_and_not_in_the_turn():
    """P1, at the argv boundary.

    Both halves matter. *On* ``--append-system-prompt``, so it sits above the
    conversation; and *not* in the user prompt, so injected text in a tool
    result is arguing with a system instruction rather than with a peer.
    """
    argv = argv_for(ar.ClaudeCliRuntime(), prompt="what did my routine find")
    assert flag_value(argv, "--append-system-prompt") == load_assistant_constitution()
    assert argv[-1] == "what did my routine find"
    assert load_assistant_constitution() not in argv[-1]


def test_the_constitution_is_re_sent_on_a_resumed_turn():
    """A resumed conversation gets the rules again, not a recorded copy.

    ``--system-prompt-snapshot off`` is what makes that true: with snapshotting
    on, a resume replays whatever system prompt was recorded on the first launch
    and an edited constitution never reaches an existing conversation. Verified
    against claude 2.1.258 by resuming a session and getting the appended rule's
    behaviour back.
    """
    argv = argv_for(ar.ClaudeCliRuntime(), resume=True)
    assert "--resume" in argv and "--session-id" not in argv
    assert flag_value(argv, "--append-system-prompt") == load_assistant_constitution()
    assert flag_value(argv, "--system-prompt-snapshot") == "off"


def test_every_runtime_kind_has_a_transmission_test():
    """The denominator, so a second runtime cannot ship without answering P1.

    Modelled on ``test_every_lane_kind_has_a_transmission_test``, which is the
    guard v1.8.4 added after the constitution reached one lane of three.
    """
    tested = set(_TRANSMISSION_TESTS)
    assert tested == set(ar.RUNTIME_KINDS), (
        "a runtime kind with no test that watches its constitution arrive: "
        f"{sorted(set(ar.RUNTIME_KINDS) - tested)}"
    )


_TRANSMISSION_TESTS = {
    "claude_cli": "test_the_constitution_arrives_on_the_system_channel_and_not_in_the_turn",
}


# ---------------------------------------------------------------------------
# The locked-down session
# ---------------------------------------------------------------------------

def test_only_resmons_own_mcp_servers_are_reachable():
    argv = argv_for(ar.ClaudeCliRuntime())
    assert flag_value(argv, "--tools") == "", "built-in tools were not disabled"
    assert "--strict-mcp-config" in argv, (
        "without this the user's own MCP servers load into the session"
    )
    assert flag_value(argv, "--mcp-config") == "/tmp/mcp.json"


def test_the_users_own_claude_configuration_stays_out_of_the_session():
    """Measured, not assumed.

    Without these two flags the real CLI's init message listed fifty of this
    user's own slash commands and twenty-four of their skills inside a session
    that is supposed to be locked down.
    """
    argv = argv_for(ar.ClaudeCliRuntime())
    assert flag_value(argv, "--setting-sources") == ""
    assert "--disable-slash-commands" in argv


def test_the_pre_approved_tools_are_exactly_the_read_tools():
    """P3's structural half: no write tool is pre-approved, by construction.

    The list is *derived* from ``mcp_server.READ_TOOLS``, so this cannot drift.
    A tool added without a confirmation decision lands in ``READ_TOOLS`` and is
    caught by ``test_every_tool_declares_whether_it_needs_confirmation``.
    """
    allowed = set(ar.ClaudeCliRuntime().allowed_tools())
    assert allowed == {f"mcp__resmon__{n}" for n in mcp_server.READ_TOOLS}
    for name in mcp_server.WRITE_TOOLS:
        assert f"mcp__resmon__{name}" not in allowed, name
    assert len(allowed) == 15


def test_the_permission_tool_is_named_and_is_not_a_tool_the_model_has():
    argv = argv_for(ar.ClaudeCliRuntime())
    assert flag_value(argv, "--permission-prompt-tool") == "mcp__resmon_permission__ask"
    assert "mcp__resmon_permission__ask" not in flag_value(argv, "--allowedTools")


def test_stream_json_carries_the_verbose_flag_it_requires():
    """Not decoration: without it the CLI refuses to start, and says so."""
    argv = argv_for(ar.ClaudeCliRuntime())
    assert flag_value(argv, "--output-format") == "stream-json"
    assert "--verbose" in argv


def test_the_mcp_config_names_the_backend_port_explicitly():
    """A named port is never widened to the default, and this is why.

    With no port named, an MCP server started beside a *different* resmon on the
    default port answers every question truthfully about the wrong corpus. Which
    happened, in v1.8.2, against a launchd daemon from April.
    """
    config = ar.ClaudeCliRuntime(backend_port=51234).mcp_config(7, "/tmp/wd")
    servers = config["mcpServers"]
    assert set(servers) == {"resmon", "resmon_permission"}
    assert servers["resmon"]["env"]["RESMON_PORT"] == "51234"
    assert servers["resmon_permission"]["env"]["RESMON_PORT"] == "51234"
    assert servers["resmon_permission"]["env"]["RESMON_ASSISTANT_SESSION"] == "7"
    for server in servers.values():
        assert Path(server["args"][0]).is_absolute(), "a relative script path"


def test_the_child_environment_does_not_leak_resmons_own(monkeypatch):
    """The CLI must not inherit ``RESMON_PORT`` from this process.

    It would reach the MCP server the CLI starts, and then two different things
    would be naming the port — the config, explicitly, and the environment,
    accidentally. One of them is the one the discovery rule trusts.
    """
    monkeypatch.setenv("RESMON_PORT", "8742")
    monkeypatch.setenv("RESMON_DB_PATH", "/somewhere/private.db")
    env = ar._child_env()
    assert "RESMON_PORT" not in env
    assert not [k for k in env if k.startswith("RESMON_")]


def test_the_child_environment_keeps_what_the_cli_needs_to_find_its_login(monkeypatch):
    """``USER``, and the reason it is named here rather than assumed.

    This started as an allowlist of variables that looked necessary. It dropped
    ``USER``, and without ``USER`` the ``claude`` CLI cannot read its stored
    login: every turn came back "Not logged in · Please run /login" from a CLI
    that was signed in, which would have shipped as "the assistant does not work
    for anybody". Bisected against the real binary — ``USER`` alone restores it;
    ``LOGNAME``, ``SHELL``, ``TMPDIR`` and ``XPC_SERVICE_NAME`` do not.

    Kept as a named regression rather than folded into the test above, because
    the interesting claim is not "the denylist works" but "this exact variable
    matters and here is what happens without it".
    """
    monkeypatch.setenv("USER", "someone")
    monkeypatch.setenv("HOME", "/home/someone")
    monkeypatch.setenv("SOME_UNRELATED_TOOL_CONFIG", "1")
    env = ar._child_env()
    assert env["USER"] == "someone"
    assert env["HOME"] == "/home/someone"
    # And the general form: everything else passes through, because an allowlist
    # of what someone else's program needs is a guess that breaks again later.
    assert env["SOME_UNRELATED_TOOL_CONFIG"] == "1"


def test_model_and_effort_ride_only_when_they_are_set():
    plain = argv_for(ar.ClaudeCliRuntime())
    assert "--model" not in plain and "--effort" not in plain
    configured = argv_for(ar.ClaudeCliRuntime(model="opus", effort="high"))
    assert flag_value(configured, "--model") == "opus"
    assert flag_value(configured, "--effort") == "high"


# ---------------------------------------------------------------------------
# P6 — normalising the stream
# ---------------------------------------------------------------------------

def test_an_unknown_cli_event_is_dropped_rather_than_rendered_raw():
    """P6. The CLI's stream carries plenty the panel has no business showing."""
    assert ar._normalise(json.dumps({"type": "rate_limit_event", "info": {}})) == []
    assert ar._normalise(json.dumps({"type": "hook_event"})) == []
    assert ar._normalise("not json at all") == []
    assert ar._normalise("") == []
    assert ar._normalise(json.dumps(["a", "list"])) == []


def test_every_event_the_panel_can_receive_is_in_the_declared_set():
    """The complement of the test above: nothing invents a new type either."""
    lines = [
        {"type": "system", "subtype": "init", "session_id": "s", "tools": []},
        {"type": "assistant", "message": {"content": [
            {"type": "text", "text": "hi"},
            {"type": "tool_use", "id": "t1", "name": "mcp__resmon__health", "input": {}}]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "{}"}]}},
        {"type": "result", "subtype": "success", "usage": {}},
    ]
    produced = [e for line in lines for e in ar._normalise(json.dumps(line))]
    assert {e["type"] for e in produced} <= set(ar.EVENT_TYPES)
    assert {e["type"] for e in produced} == {
        "started", "text_delta", "tool_call", "tool_result", "done"}


def test_a_tool_name_is_shown_the_way_the_app_names_it():
    event = ar._normalise(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "t", "name": "mcp__resmon__list_routines",
         "input": {}}]}}))[0]
    assert event["tool_name"] == "list_routines"
    assert event["raw_name"] == "mcp__resmon__list_routines", (
        "the transcript keeps the address the call actually used"
    )


def test_an_unreported_cost_is_none_rather_than_zero():
    """Zero is a measurement. Absent is not, and the panel says so differently."""
    done = ar._normalise(json.dumps({"type": "result", "usage": {}}))[0]
    assert done["cost_usd"] is None
    assert done["input_tokens"] is None
    priced = ar._normalise(json.dumps({
        "type": "result", "total_cost_usd": 0.5,
        "usage": {"input_tokens": 3, "output_tokens": 4}}))[0]
    assert priced["cost_usd"] == 0.5
    assert (priced["input_tokens"], priced["output_tokens"]) == (3, 4)


# ---------------------------------------------------------------------------
# A real subprocess, running the double
# ---------------------------------------------------------------------------

def test_a_turn_streams_events_from_a_real_process(tmp_path):
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path))
    events = list(runtime.run_turn(
        1, "SAY:first\nSAY:second",
        cli_session_id="22222222-2222-2222-2222-222222222222", resume=False))
    kinds = [e["type"] for e in events]
    assert kinds[0] == "started"
    assert [e["text"] for e in events if e["type"] == "text_delta"] == ["first", "second"]
    assert kinds[-1] == "done"
    assert events[-1]["cost_usd"] == pytest.approx(0.0123)


def test_the_turn_runs_in_an_empty_directory_that_is_removed_afterwards(tmp_path):
    """The workdir is resmon's, holds only what resmon put there, and then goes.

    The summary lanes proved this matters the hard way: an agent told to follow
    a document it cannot find goes looking, and what it finds is whatever is in
    the working directory.
    """
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path))
    seen: list[str] = []
    original = ar.tempfile.TemporaryDirectory

    class _Recording(original):                      # type: ignore[misc,valid-type]
        def __enter__(self):
            path = super().__enter__()
            seen.append(path)
            return path

    ar.tempfile.TemporaryDirectory = _Recording
    try:
        list(runtime.run_turn(1, "SAY:x", cli_session_id="s", resume=False))
    finally:
        ar.tempfile.TemporaryDirectory = original

    assert len(seen) == 1
    assert not os.path.exists(seen[0]), "the working directory outlived the turn"


def test_a_failing_cli_becomes_an_error_event_with_a_sentence(tmp_path):
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path))
    events = list(runtime.run_turn(
        1, "FAIL:Invalid API key · Please run /login",
        cli_session_id="s", resume=False))
    error = events[-1]
    assert error["type"] == "error"
    assert "not signed in" in error["message"]


def test_the_turn_carries_a_spending_ceiling_the_cli_enforces_itself():
    """Token efficiency is a contract term, so something has to enforce it.

    Until 2.0 the only things holding it were small page sizes and a
    constitution asking nicely. ``--max-budget-usd`` is a stop the CLI applies
    to itself, and it fails detectably — verified against 2.1.258, which answers
    ``subtype: error_max_budget_usd``.
    """
    argv = argv_for(ar.ClaudeCliRuntime())
    assert float(flag_value(argv, "--max-budget-usd")) == ar.TURN_BUDGET_USD
    # Four times the dearest of the ten measured requests ($0.1875). A runaway
    # stop, not a quota: the regression detector is a different number, in
    # ``test_assistant_budget.py``.
    assert ar.TURN_BUDGET_USD == pytest.approx(0.75)


def test_the_two_ceilings_are_derived_from_the_measurement():
    """The arithmetic, so a ceiling cannot be raised to make a guard pass.

    Two numbers from one table
    (``workspace/handbacks/2.0/evidence/assistant-cost.md``): the runaway stop
    the CLI enforces (4x the dearest request measured) and the regression
    detector in ``test_assistant_budget.py`` (2x). That file is
    ``live_network``, so this hermetic half lives here and runs on every job.
    """
    from test_assistant_budget import (  # noqa: PLC0415
        DEAREST_MEASURED_USD, REGRESSION_CEILING_USD,
    )

    assert REGRESSION_CEILING_USD == pytest.approx(DEAREST_MEASURED_USD * 2)
    assert ar.TURN_BUDGET_USD == pytest.approx(DEAREST_MEASURED_USD * 4)
    assert ar.TURN_BUDGET_USD > REGRESSION_CEILING_USD, (
        "the runaway stop must sit above the regression detector, or a turn "
        "would be cut off before the test meant to warn about it ever failed"
    )


def test_hitting_the_budget_says_so_in_words_a_person_can_act_on(tmp_path):
    """Not "exit code 1". The stop has a reason and a next step."""
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path))
    events = list(runtime.run_turn(1, "SAY:partial\nBUDGET",
                                   cli_session_id="s", resume=False))
    error = events[-1]
    assert error["type"] == "error"
    assert "spending limit" in error["message"]
    assert "narrower" in error["message"]
    assert error["detail"] == "error_max_budget_usd"
    # And what the turn did produce is still delivered rather than discarded.
    assert any(e.get("text") == "partial" for e in events)


def test_the_clis_own_last_word_beats_a_bare_exit_code(tmp_path):
    """An auth failure arrives in the result envelope with an empty stderr.

    Found live: ``claude`` answers "Not logged in · Please run /login" as its
    *result* and then exits non-zero having written nothing to stderr, so a
    classifier reading only stderr told the user "exit code 1 and resmon cannot
    tell you more" while the CLI had said exactly what was wrong.
    """
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path))
    events = list(runtime.run_turn(
        1, "RESULT_ERROR:Not logged in · Please run /login",
        cli_session_id="s", resume=False))
    assert events[-1]["type"] == "error"
    assert "not signed in" in events[-1]["message"]


def test_an_unrecognised_failure_says_it_is_unrecognised(tmp_path):
    """Never a guess. The exit code and "resmon cannot tell you more"."""
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path))
    events = list(runtime.run_turn(1, "FAIL:", cli_session_id="s", resume=False))
    assert events[-1]["type"] == "error"
    assert "exit code 3" in events[-1]["message"]


def test_a_missing_binary_is_an_error_event_not_an_exception(tmp_path):
    """Nothing escapes ``run_turn``. A streaming response cannot become a 500."""
    runtime = ar.ClaudeCliRuntime(cli_path=str(tmp_path / "no-such-binary"))
    events = list(runtime.run_turn(1, "SAY:x", cli_session_id="s", resume=False))
    assert [e["type"] for e in events] == ["error"]


# ---------------------------------------------------------------------------
# P8 — cancel
# ---------------------------------------------------------------------------

def test_cancel_kills_the_running_turn(tmp_path):
    """P8's process half, against a real subprocess that is really sleeping."""
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path))
    collected: list[dict] = []

    def _run():
        collected.extend(runtime.run_turn(
            99, "SAY:before\nSLEEP:30\nSAY:after",
            cli_session_id="s", resume=False))

    worker = threading.Thread(target=_run, daemon=True)
    worker.start()

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not ar.is_running(99):
        time.sleep(0.05)
    assert ar.is_running(99), "the turn never started"

    started = time.monotonic()
    assert ar.cancel_turn(99) is True
    worker.join(timeout=20)
    assert not worker.is_alive()
    assert time.monotonic() - started < 15
    assert not ar.is_running(99)
    assert "after" not in [e.get("text") for e in collected]


def test_cancelling_nothing_says_so_rather_than_claiming_success():
    assert ar.cancel_turn(123456) is False


def test_a_silent_cli_is_killed_at_the_timeout(tmp_path):
    """An unbounded read would hang the worker thread until the app closed."""
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path), timeout=1)
    started = time.monotonic()
    events = list(runtime.run_turn(
        7, "SLEEP:30", cli_session_id="s", resume=False))
    assert time.monotonic() - started < 20
    assert events[-1]["type"] == "error"
    assert not ar.is_running(7)


# ---------------------------------------------------------------------------
# The bus
# ---------------------------------------------------------------------------

def test_publishing_to_a_closed_session_is_not_an_error():
    """A card can arrive microseconds after the panel closed the stream."""
    assert ar.bus.publish(4242, {"type": "text_delta"}) is False
    ar.bus.open(4242)
    assert ar.bus.publish(4242, {"type": "text_delta"}) is True
    ar.bus.close(4242)
    assert ar.bus.publish(4242, {"type": "text_delta"}) is False


# ---------------------------------------------------------------------------
# Codex
# ---------------------------------------------------------------------------

def test_codex_is_refused_as_a_runtime_with_a_reason_a_person_can_read():
    """Decision 1's condition, and the answer established against codex 0.153.1.

    ``--strict-config`` rejects ``tools.shell``, ``tools.shell.enabled`` and
    ``shell_tool`` as unknown fields while accepting ``tools.web_search``, so the
    check discriminates. ``codex exec`` has no interactive approval, and
    ``codex mcp-server``'s only control is ``on-request | never`` over shell
    commands. The shell cannot be taken away, so the condition is not met.
    """
    assert "claude_cli" in ar.RUNTIME_KINDS
    assert "codex_cli" not in ar.RUNTIME_KINDS
    reason = ar.codex_unavailable_reason()
    assert "shell" in reason.lower()
    assert "summaris" in reason.lower(), (
        "the reason must say codex is still fine for the job it does today"
    )


def test_the_status_reports_codex_even_when_it_is_installed():
    """Omitting it would read, to a user who has it, as resmon not noticing."""
    status = ar.runtime_status({})
    others = {entry["kind"]: entry for entry in status["others"]}
    assert others["codex_cli"]["available"] is False
    assert others["codex_cli"]["reason"]
    assert status["kinds"] == list(ar.RUNTIME_KINDS)


# ---------------------------------------------------------------------------
# P16 — a session whose CLI id cannot be resumed says so
# ---------------------------------------------------------------------------
#
# 2.0a left P10's second clause unproven and said so: nothing made a resume fail
# and watched what the user was told. Deleting the CLI's own session file was
# rightly refused — reaching into another program's private state proves
# something about that program, not about resmon. The route taken instead is the
# one the reconciliation named: establish the real shape once against the binary
# (recorded in ``fixtures/fake_claude.py`` and re-established live by
# ``test_assistant_live.py``), then make the double answer with exactly it.

def test_the_cannot_resume_shape_is_recognised_from_the_errors_array():
    """The sentence is in ``errors``, and there is no ``result`` text at all.

    Matched on the errors array first because that is where the real CLI puts
    it. A classifier reading only ``result`` would find an empty string here and
    fall through to "exit code 1 and resmon cannot tell you more".
    """
    assert ar._is_cannot_resume(
        ["No conversation found with session ID: abc"], "") is True
    assert ar._is_cannot_resume([], "No conversation found with session ID: abc") is True
    assert ar._is_cannot_resume([], "") is False
    assert ar._is_cannot_resume(["Invalid API key"], "some other failure") is False


def test_a_normalised_result_carries_the_clis_errors_array():
    """2.0a dropped this field; the whole recovery hangs off it."""
    (done,) = ar._normalise(json.dumps({
        "type": "result", "subtype": "error_during_execution", "is_error": True,
        "errors": ["No conversation found with session ID: zzz"], "usage": {},
    }))
    assert done["errors"] == ["No conversation found with session ID: zzz"]
    assert done["result_text"] is None, "the real envelope has no result field"


def test_a_lost_conversation_is_said_out_loud_and_answered_anyway(tmp_path):
    """P16a and P16b, against a double reproducing the real cannot-resume shape.

    The turn is launched as a resume; the CLI answers the way claude 2.1.258
    really answers a session id it does not have; the person gets a notice
    saying the earlier messages are no longer in front of the assistant, and
    then gets their answer.
    """
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path))
    events = list(runtime.run_turn(
        7, "CANNOT_RESUME\nSAY:here is the answer",
        cli_session_id="33333333-3333-3333-3333-333333333333", resume=True))
    kinds = [e["type"] for e in events]

    notice = next(e for e in events if e["type"] == "notice")
    assert notice["code"] == "cannot_resume"
    assert "no longer has this conversation" in notice["message"]
    assert "not able to see them" in notice["message"], (
        "the notice has to say the assistant cannot see the earlier messages; "
        "the transcript is still on screen and would otherwise imply it can")

    assert [e["text"] for e in events if e["type"] == "text_delta"] == [
        "here is the answer"]
    assert kinds[-1] == "done" and not events[-1]["is_error"]
    assert "error" not in kinds, (
        "the failed attempt's error event must not reach the panel: the turn "
        "succeeded")
    assert kinds.count("done") == 1, "the discarded attempt must not report a turn"


def test_the_retry_is_a_new_cli_session_and_the_relay_can_see_its_id(tmp_path):
    """P16b. The second launch carries --session-id, not --resume.

    And the ``started`` event carries the fresh id, which is the only way the
    store learns to stop resuming an id the CLI has already disowned.
    """
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path))
    asked = "44444444-4444-4444-4444-444444444444"
    events = list(runtime.run_turn(
        8, "CANNOT_RESUME\nSAY:ok", cli_session_id=asked, resume=True))
    started = next(e for e in events if e["type"] == "started")
    assert started["cli_session_id"] != asked
    assert uuid.UUID(started["cli_session_id"])      # a real uuid, not a marker


def test_only_one_retry_and_only_for_this_failure(tmp_path):
    """A failure that is not a lost conversation is reported, not retried."""
    runtime = ar.ClaudeCliRuntime(cli_path=fake_binary(tmp_path))
    events = list(runtime.run_turn(
        9, "RESULT_ERROR:Not logged in · Please run /login",
        cli_session_id="s", resume=True))
    assert [e["type"] for e in events].count("done") == 1
    assert events[-1]["type"] == "error"
    assert "not signed in" in events[-1]["message"]
    assert not any(e["type"] == "notice" for e in events)


def test_a_direct_stream_still_gets_the_real_reason(tmp_path):
    """The classifier says it even where the recovery is not in play.

    ``_classify_failure`` is reachable from a turn that was not a resume and
    from anything driving ``_stream`` itself. "exit code 1" would be true and
    useless.
    """
    message = ar._classify_failure(
        "error_during_execution", "", 1,
        errors=["No conversation found with session ID: q"])
    assert "no longer has this conversation" in message
    assert "Start a new conversation" in message
