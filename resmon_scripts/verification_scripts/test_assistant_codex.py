"""Ask on Codex: the command it builds, the events it reads, and the turns it keeps.

Three boundaries, as for Claude Code:

* **argv** -- what ``codex exec`` is actually spawned with: resmon's MCP server
  started read-only, the person's own configuration left out, the sandbox
  read-only, the prompt after ``--``.
* **a real subprocess running a hermetic double** (``fixtures/fake_codex.py``),
  which prints the JSONL ``codex exec --json`` documents, resumes the threads
  it started, answers ``login status``, can expire, and starts resmon's MCP
  server from the ``-c`` overrides it was handed, as Codex does.
* **a real backend**, for the tool calls (through the real MCP server, read-only)
  and for what the store keeps of a turn.

**No real ``codex`` is run here, in any form.** Discovery is held to the
configured path wherever a backend is started, so a path left unset cannot
find a ``codex`` installed on this machine. What the double cannot establish
-- that Codex 0.166 accepts every override, reads ``AGENTS.md`` on a resumed
thread, names its model, and words a lost thread or an expired sign-in as the
double does -- is unverified until the real command is run by a person.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_assistant_api as api  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import mcp_server  # noqa: E402
from implementation_scripts import assistant_choices as choices  # noqa: E402
from implementation_scripts import assistant_runtime as ar  # noqa: E402
from implementation_scripts.ai_model_names import model_display_name  # noqa: E402
from implementation_scripts.assistant_constitution import load_assistant_constitution  # noqa: E402

try:
    import tomllib
except ModuleNotFoundError:             # pragma: no cover - 3.10
    tomllib = None                      # type: ignore[assignment]

FAKE_CODEX = Path(__file__).resolve().parent / "fixtures" / "fake_codex.py"
_API = api._API
# A port nothing listens on: a runtime test that is not about tools must not
# reach any resmon, and an MCP server named this port has nothing to find.
_NO_BACKEND = 9


def fake_codex(folder: Path) -> str:
    """A shim that runs the double under this interpreter (see ``fake_binary`` beside Claude's)."""
    shim = folder / "codex"
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_CODEX}" "$@"\n')
    shim.chmod(0o755)
    return str(shim)


@pytest.fixture
def codex(tmp_path, monkeypatch):
    state = tmp_path / "fake-codex"
    state.mkdir()
    monkeypatch.setenv("FAKE_CODEX_STATE", str(state))
    runtime = ar.CodexCliRuntime(cli_path=fake_codex(tmp_path), backend_port=_NO_BACKEND)
    runtime.state = state  # type: ignore[attr-defined]
    return runtime


def last_run(runtime) -> dict:
    return json.loads((runtime.state / "last-run.json").read_text(encoding="utf-8"))


def turn(runtime, prompt: str, *, thread: str = "", session: int = 701) -> list[dict]:
    return list(runtime.run_turn(session, prompt, cli_session_id=thread, resume=bool(thread)))


def kinds(events: list[dict]) -> list[str]:
    return [e["type"] for e in events]


# ---------------------------------------------------------------------------
# argv
# ---------------------------------------------------------------------------

def test_a_new_thread_is_locked_down_and_its_prompt_comes_last():
    runtime = ar.CodexCliRuntime(model="gpt-5.5-codex", effort="high", backend_port=51234)
    argv = runtime.build_argv("what did my watches find", workdir="/tmp/work", binary="/x/codex")
    assert argv[:2] == ["/x/codex", "exec"] and "resume" not in argv
    for flag in ("--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"):
        assert flag in argv, flag
    assert argv[argv.index("--sandbox") + 1] == "read-only"
    assert argv[argv.index("-C") + 1] == "/tmp/work"
    assert argv[argv.index("-m") + 1] == "gpt-5.5-codex"
    overrides = [argv[i + 1] for i, a in enumerate(argv) if a == "-c"]
    for expected in ('sandbox_mode="read-only"', 'approval_policy="never"',
                     "features.shell_tool=false", "tools.web_search=false",
                     'model_reasoning_effort="high"'):
        assert expected in overrides, expected
    # Every way codex-cli 0.166.0 has to run a command, read the machine, or act
    # for the person, beyond resmon's own tools, is asked off.
    for feature in ("unified_exec", "unified_exec_tty", "browser_use", "computer_use", "apps", "plugins",
                    "code_mode_host", "multi_agent", "memories", "view_image", "skill_mcp_dependency_install"):
        assert f"features.{feature}=false" in overrides, feature
    # ``--`` ends the options, and the prompt is the one thing after it.
    assert argv[-2:] == ["--", "what did my watches find"]
    assert argv.count("what did my watches find") == 1


def test_a_resumed_thread_uses_only_options_resume_takes():
    runtime = ar.CodexCliRuntime(backend_port=51234)
    argv = runtime.build_argv("and since then?", workdir="/tmp/work", thread_id="0199-thread", binary="/x/codex")
    assert argv[:3] == ["/x/codex", "exec", "resume"]
    # ``codex exec resume`` has no --sandbox and no -C; the sandbox goes by -c.
    assert "--sandbox" not in argv and "-C" not in argv
    assert 'sandbox_mode="read-only"' in argv
    assert argv[-3:] == ["--", "0199-thread", "and since then?"]
    assert "-m" not in argv and not any(a.startswith("model_reasoning_effort") for a in argv)


def test_resmons_server_is_the_one_attached_and_it_is_read_only():
    runtime = ar.CodexCliRuntime(backend_port=51234, python_executable="/opt/py/bin/python3")
    tree: dict = {}
    for override in runtime.mcp_overrides():
        key, _, raw = override.partition("=")
        value = tomllib.loads(f"v = {raw}")["v"] if tomllib else json.loads(raw)
        node = tree
        for part in key.split(".")[:-1]:
            node = node.setdefault(part, {})
        node[key.split(".")[-1]] = value
    server = tree["mcp_servers"]["resmon"]
    assert list(tree["mcp_servers"]) == ["resmon"]
    assert server["command"] == "/opt/py/bin/python3"
    assert server["args"] == [str(PROJECT_ROOT / "resmon_scripts" / "mcp_server.py")]
    assert server["env"]["RESMON_MCP_READ_ONLY"] == "1"
    assert server["env"]["RESMON_PORT"] == "51234"
    assert server["env"]["PYTHONPATH"] == str(PROJECT_ROOT / "resmon_scripts")
    assert server["env"]["RESMON_STATE_DIR"]
    # The token is never written into what Codex is handed.
    from implementation_scripts import api_auth

    token = api_auth.current_token()
    if token:
        assert token not in json.dumps(runtime.mcp_overrides())


@pytest.mark.parametrize("value", ['/Users/a b/"quoted"\\path', "/Applications/ChatGPT.app/Contents/Résumé/codex",
                                   "tab\there", "line\nbreak", "del\x7fchar"])
def test_a_value_is_handed_to_codex_as_exactly_itself(value):
    raw = ar._toml_string(value)
    parsed = tomllib.loads(f"v = {raw}")["v"] if tomllib else json.loads(raw)
    assert parsed == value


def test_the_effort_is_omitted_when_the_command_should_choose():
    argv = ar.CodexCliRuntime().build_argv("hi", workdir="/w", binary="/x/codex")
    assert not any(a.startswith("model_reasoning_effort") for a in argv)


# ---------------------------------------------------------------------------
# P1 -- the constitution arrives, and not in the turn
# ---------------------------------------------------------------------------

def test_the_constitution_arrives_as_agents_md_and_not_in_the_turn(codex):
    """P1 for Codex: the ``AGENTS.md`` Codex reads from its working directory.

    The channel the summary lane established for codex, which has no
    ``--append-system-prompt``. Read back from what the double found in its
    working directory, so it is the file Codex would have read, not a string
    resmon meant to write. The session's own terms follow the constitution.
    """
    events = turn(codex, "SAY:hello")
    assert "done" in kinds(events), events
    seen = last_run(codex)
    assert seen["agents_md"] == codex.instructions()
    assert seen["agents_md"].startswith(load_assistant_constitution().rstrip("\n"))
    assert "read-only tools" in seen["agents_md"] and "no shell" in seen["agents_md"]
    assert not any(load_assistant_constitution()[:200] in arg for arg in seen["argv"])
    # A fresh, empty directory: the file resmon wrote and nothing of the person's.
    assert Path(seen["cwd"]).name.startswith("resmon-assistant-")
    assert not Path(seen["cwd"]).exists(), "the turn's directory outlived the turn"
    assert seen["resmon_env"] == [], "the command must not inherit resmon's own variables"


# ---------------------------------------------------------------------------
# The stream, mapped onto Ask's events
# ---------------------------------------------------------------------------

def test_a_turn_maps_onto_asks_events(codex):
    events = turn(codex, "MODEL:gpt-5.5-codex\nREASONING:working it out\nSAY:First part.\nSAY:Second part.")
    assert kinds(events) == ["started", "text_delta", "text_delta", "done"]
    started, done = events[0], events[-1]
    thread = started["owned_cli_session_id"]
    assert thread and started["cli_session_id"] == thread
    assert started["model_report"]["model"] == "gpt-5.5-codex"
    assert started["model_report"]["source"] == "codex_event_model"
    assert model_display_name(started["model_report"]["model"]) == "GPT-5.5-Codex"
    # Two messages are two paragraphs; the reasoning is not part of the answer.
    assert "".join(e["text"] for e in events if e["type"] == "text_delta") == "First part.\n\nSecond part."
    # Tokens, and no cost: Codex does not report one.
    assert (done["input_tokens"], done["output_tokens"], done["cache_read_tokens"]) == (1200, 80, 300)
    assert done["cost_usd"] is None and done["is_error"] is False
    assert done["model_reports"] == []


def test_the_header_names_the_model_when_the_stream_does_not(codex):
    events = turn(codex, "HEADER:gpt-5.5-mini\nSAY:hi")
    assert "model_report" not in events[0]
    reports = events[-1]["model_reports"]
    assert [(r["model"], r["source"]) for r in reports] == [("gpt-5.5-mini", "codex_header_model")]


def test_no_model_named_is_not_a_model(codex):
    events = turn(codex, "SAY:hi")
    assert "model_report" not in events[0] and events[-1]["model_reports"] == []


def test_unknown_events_are_dropped_never_drawn(codex):
    events = turn(codex, "\n".join([
        'RAW:{"type":"thread.rewound","text":"not an answer"}',
        'RAW:{"type":"item.completed","item":{"id":"x","type":"hologram","text":"not an answer"}}',
        "RAW:this line is not JSON",
        'RAW:["a list"]',
        "SAY:the answer"]))
    assert [e["text"] for e in events if e["type"] == "text_delta"] == ["the answer"]
    assert not any("not an answer" in json.dumps(e) for e in events)
    assert set(kinds(events)) <= set(ar.EVENT_TYPES)


def test_an_error_inside_the_turn_is_put_on_the_record(codex):
    events = turn(codex, "ERROR_ITEM:resmon MCP server took too long to start\nSAY:answered anyway")
    notices = [e for e in events if e["type"] == "notice"]
    assert [n["code"] for n in notices] == ["codex_reported"]
    assert "resmon MCP server took too long to start" in notices[0]["message"]
    assert kinds(events)[-1] == "done"


# ---------------------------------------------------------------------------
# Conversations: a thread is kept and resumed
# ---------------------------------------------------------------------------

def test_a_later_turn_resumes_the_thread_codex_reported(codex):
    first = turn(codex, "SAY:one")
    thread = first[0]["owned_cli_session_id"]
    second = turn(codex, "SAY:two", thread=thread)
    assert kinds(second) == ["started", "text_delta", "done"]
    assert second[0]["owned_cli_session_id"] == thread
    argv = last_run(codex)["argv"]
    assert argv[:2] == ["exec", "resume"] and argv[-2:] == [thread, "SAY:two"]


def test_a_lost_thread_is_said_and_answered_in_a_new_one(codex):
    events = turn(codex, "SAY:still answered", thread="11111111-2222-3333-4444-555555555555")
    assert kinds(events) == ["notice", "started", "text_delta", "done"]
    assert events[0]["code"] == "cannot_resume"
    assert events[0]["message"].startswith("Codex no longer has this conversation")
    assert events[1]["owned_cli_session_id"] != "11111111-2222-3333-4444-555555555555"
    # The failed attempt's own error was withheld: it was not the turn's outcome.
    assert "error" not in kinds(events)


def test_a_resume_codex_answers_in_another_thread_is_said(codex):
    thread = turn(codex, "SAY:one")[0]["owned_cli_session_id"]
    events = turn(codex, "NEW_THREAD\nSAY:two", thread=thread)
    assert kinds(events)[:2] == ["started", "notice"]
    assert events[0]["owned_cli_session_id"] != thread
    assert "answered in a new one of its own" in events[1]["message"]
    assert kinds(events)[-1] == "done"


# ---------------------------------------------------------------------------
# Failed turns, Stop and what Ask does not allow
# ---------------------------------------------------------------------------

def test_an_expired_sign_in_is_a_sign_in_failure(codex):
    (codex.state / "auth").write_text("expired")
    events = turn(codex, "SAY:never said")
    errors = [e for e in events if e["type"] == "error"]
    assert len(errors) == 1 and errors[0]["code"] == "cli_auth"
    assert errors[0]["message"].startswith("The Codex command on this computer is not signed in")
    assert "401" in errors[0]["message"]
    # Said once, though Codex said it twice (``error`` and ``turn.failed``).
    assert errors[0]["message"].count("Unauthorized") == 1
    assert "done" not in kinds(events) and "text_delta" not in kinds(events)


def test_a_failed_turn_says_what_codex_said(codex):
    events = turn(codex, "SAY:partial\nTURN_FAILED:the model is overloaded")
    assert kinds(events)[-1] == "error"
    assert events[-1]["message"] == "The codex command stopped with exit code 1: the model is overloaded"
    assert events[-1]["code"] == "failed"


def test_an_exit_before_any_event_says_the_exit_and_the_words(codex):
    events = turn(codex, "FAIL:config.toml could not be read")
    assert kinds(events) == ["error"]
    assert events[0]["message"] == "The codex command stopped with exit code 3: config.toml could not be read"


def test_a_turn_without_its_end_is_not_an_answer(codex):
    events = turn(codex, "SAY:half an answer\nNO_COMPLETE")
    assert kinds(events) == ["started", "text_delta", "error"]
    assert events[-1]["message"] == "Codex ended without finishing the turn, and said nothing about why."


@pytest.mark.parametrize("directive, name, words", [
    ("SHELL:cat ~/.ssh/id_ed25519", "shell", "Codex started a shell command"),
    ("WEB:perovskite stability", "web_search", "Codex searched the web"),
    ("OTHER_TOOL:filesystem read_file", "filesystem/read_file", "Codex called a tool resmon did not give it"),
])
def test_what_ask_does_not_offer_stops_the_turn_where_it_is_seen(codex, directive, name, words):
    started = time.monotonic()
    events = turn(codex, f"SAY:looking\n{directive}\nSAY:never reached")
    assert time.monotonic() - started < 20, "the double was left to run out its minute"
    calls = [e for e in events if e["type"] == "tool_call"]
    assert [c["tool_name"] for c in calls] == [name]
    assert kinds(events)[-1] == "error" and events[-1]["message"].startswith(words)
    assert "never reached" not in json.dumps(events)


def test_stop_ends_a_codex_turn_as_stopped(codex):
    sink: list[dict] = []

    def run() -> None:
        sink.extend(turn(codex, "SAY:started\nSLEEP:30", session=733))

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    deadline = time.monotonic() + 20
    while not ar.is_running(733):
        assert time.monotonic() < deadline
        time.sleep(0.05)
    time.sleep(0.5)
    assert ar.cancel_turn(733) is True
    worker.join(timeout=20)
    assert [e["code"] for e in sink if e["type"] == "error"] == ["stopped"]


def test_a_codex_that_never_speaks_is_named_in_the_timeout(codex, monkeypatch):
    monkeypatch.setattr(ar, "FIRST_OUTPUT_TIMEOUT", 1)
    monkeypatch.setattr(ar._lines_with_timeout, "__defaults__", (1,))
    events = turn(codex, "SILENT:5")
    assert kinds(events) == ["error"] and events[0]["detail"] == "startup_timeout"
    assert "The codex command started but said nothing" in events[0]["message"]
    assert "Run `codex` once" in events[0]["message"]


@pytest.mark.parametrize("said, code, words", [
    ("error: unexpected argument '--ignore-rules' found", "failed", "does not accept one of the options"),
    ("unexpected status 401 Unauthorized", "cli_auth", "not signed in"),
    ("Not logged in. Run codex login", "cli_auth", "not signed in"),
    ("You've hit your usage limit. Try again later.", "failed", "usage limit"),
    ("Error: No saved session found with ID 4", "failed", "no longer has this conversation"),
])
def test_codex_failures_are_classified_from_its_own_words(said, code, words):
    message, got = ar._classify_codex_failure(said, "", 1, completed=False)
    assert got == code and words in message


def test_a_key_in_codexs_words_is_never_repeated():
    secret = "sk-" + "a" * 40
    message, _ = ar._classify_codex_failure(f"401 Unauthorized: bad key {secret}", "", 1, completed=False)
    assert secret not in message


# ---------------------------------------------------------------------------
# Choices and status
# ---------------------------------------------------------------------------

def codex_choice(**change) -> dict:
    return {"version": 1, "runtime": "codex_cli", "provider": "codex", "model": None, "effort": None, **change}


@pytest.mark.parametrize("value", [codex_choice(), codex_choice(model="gpt-5.5-codex", effort="minimal"),
                                   codex_choice(effort="xhigh")])
def test_a_codex_choice_is_accepted(value):
    assert choices.validate(value) == value


@pytest.mark.parametrize("value", [codex_choice(provider="claude_code"), codex_choice(effort="High"),
                                   codex_choice(effort="a b"), codex_choice(effort="x" * 33),
                                   codex_choice(effort=3),
                                   {"version": 1, "runtime": "claude_cli", "provider": "codex",
                                    "model": None, "effort": None},
                                   {"version": 1, "runtime": "claude_cli", "provider": "claude_code",
                                    "model": None, "effort": "minimal"}])
def test_a_codex_choice_out_of_shape_is_refused(value):
    with pytest.raises(ValueError):
        choices.validate(value)


def test_codex_is_the_second_connection_and_says_it_is_read_only(tmp_path, monkeypatch):
    monkeypatch.setenv("RESMON_AI_CLI_DISCOVERY", "configured-only")
    shim = fake_codex(tmp_path)
    found = choices.descriptor({"ai_provider": "codex", "ai_cli_path": shim})
    labels = [c["label"] for c in found["connections"]]
    assert labels[:2] == ["Claude Code", "Codex"]
    row = found["connections"][1]
    assert (row["runtime"], row["provider"], row["implemented"], row["available"]) == (
        "codex_cli", "codex", True, True)
    assert "read-only tools only" in row["reason"] and "unverified" in row["reason"]
    assert row["effort_supported"] is True
    # The path was set for Claude Code's summaries: it says nothing about Codex.
    missing = choices.descriptor({"ai_provider": "claude_code", "ai_cli_path": shim})["connections"][1]
    assert missing["available"] is False and "not found" in missing["reason"]


def test_the_codex_route_follows_the_path_set_for_codex():
    a = choices.route_digest({"ai_provider": "codex", "ai_cli_path": "/a/codex"}, "codex_cli", "codex")
    b = choices.route_digest({"ai_provider": "codex", "ai_cli_path": "/b/codex"}, "codex_cli", "codex")
    c = choices.route_digest({"ai_provider": "claude_code", "ai_cli_path": "/a/codex"}, "codex_cli", "codex")
    d = choices.route_digest({"ai_provider": "claude_code", "ai_cli_path": "/b/claude"}, "codex_cli", "codex")
    assert a != b and a != c and c == d


def test_claude_code_is_not_handed_a_path_set_for_codex(tmp_path, monkeypatch):
    monkeypatch.setenv("RESMON_AI_CLI_DISCOVERY", "configured-only")
    shim = fake_codex(tmp_path)
    for_codex = {"ai_provider": "codex", "ai_cli_path": shim}
    assert ar.claude_cli_path(for_codex) == ""
    assert ar.get_runtime(for_codex).configured_path is None
    claude = choices.descriptor(for_codex)["connections"][0]
    assert (claude["runtime"], claude["available"]) == ("claude_cli", False)
    others = {o["kind"]: o for o in ar.runtime_status({**for_codex, "assistant_runtime": "codex_cli"})["others"]}
    assert others["claude_cli"]["available"] is False
    # Set for Claude Code's summaries, or with summaries on a key, the path is still Claude Code's.
    for provider in ("claude_code", "anthropic", ""):
        assert ar.claude_cli_path({"ai_provider": provider, "ai_cli_path": "/a/claude"}) == "/a/claude"
    kept = choices.route_digest({"ai_provider": "claude_code", "ai_cli_path": "/a/claude"}, "claude_cli", "claude_code")
    assert kept == choices.route_digest({"ai_provider": "anthropic", "ai_cli_path": "/a/claude"}, "claude_cli", "claude_code")
    assert choices.route_digest(for_codex, "claude_cli", "claude_code") == choices.route_digest({}, "claude_cli", "claude_code")


def test_the_key_route_does_not_borrow_a_commands_sentence():
    # Summaries on a command, and no key provider chosen for Ask: the key route says so, rather
    # than describing the command it never runs.
    for provider, name in (("codex", "Codex"), ("claude_code", "Claude Code")):
        others = {o["kind"]: o for o in ar.runtime_status({"ai_provider": provider})["others"]}
        reason = others["api_key"]["reason"]
        assert others["api_key"]["available"] is False
        assert reason.startswith(f"No key provider is chosen for the assistant: summaries use the {name} command")
        assert "signed into" not in reason


def test_codex_is_asks_default_when_settings_say_so(tmp_path, monkeypatch):
    monkeypatch.setenv("RESMON_AI_CLI_DISCOVERY", "configured-only")
    settings = {"ai_provider": "codex", "ai_cli_path": fake_codex(tmp_path), "assistant_runtime": "codex_cli",
                "assistant_model": "gpt-5.5-codex", "assistant_effort": "high"}
    assert ar.get_runtime(settings).kind == "codex_cli"
    found = choices.descriptor(settings)
    assert found["default_request"] == {"version": 1, "runtime": "codex_cli", "provider": "codex",
                                        "model": "gpt-5.5-codex", "effort": "high"}


def test_selected_evidence_answers_do_not_run_on_codex():
    binding = choices.resolve({}, codex_choice())
    with pytest.raises(ValueError, match="not Codex"):
        ar.get_bound_runtime(binding, {}, profile="selected_evidence_v1")


def test_the_status_reports_codex_with_what_it_is_offered(tmp_path, monkeypatch):
    monkeypatch.setenv("RESMON_AI_CLI_DISCOVERY", "configured-only")
    status = ar.runtime_status({"ai_provider": "codex", "ai_cli_path": fake_codex(tmp_path)})
    others = {o["kind"]: o for o in status["others"]}
    assert others["codex_cli"]["available"] is True and others["codex_cli"]["installed"] is True
    assert others["codex_cli"]["reason"] == ar.codex_connection_reason()
    assert status["kinds"] == ["claude_cli", "codex_cli", "api_key"]
    absent = {o["kind"]: o for o in ar.runtime_status({})["others"]}["codex_cli"]
    assert absent["available"] is False and absent["installed"] is False and absent["reason"]


# ---------------------------------------------------------------------------
# On a real backend: the tools, and what the store keeps
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def backend(tmp_path_factory):
    state = tmp_path_factory.mktemp("assistant-codex")
    folder = tmp_path_factory.mktemp("codex-bin")
    shim = fake_codex(folder)
    saved = {k: os.environ.get(k) for k in ("RESMON_AI_CLI_DISCOVERY", "RESMON_STATE_DIR", "FAKE_CODEX_STATE")}
    os.environ["RESMON_AI_CLI_DISCOVERY"] = "configured-only"
    os.environ["RESMON_STATE_DIR"] = str(state / "resmon-state")
    os.environ["FAKE_CODEX_STATE"] = str(state / "fake-codex")
    server = api.Backend(state)
    try:
        server.start()
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    try:
        _API.put(f"{server.base}/api/settings/ai", json={"settings": {
            "ai_provider": "codex", "ai_cli_path": shim}}, timeout=20).raise_for_status()
        server.codex_state = state / "fake-codex"  # type: ignore[attr-defined]
        server.shim = shim  # type: ignore[attr-defined]
        yield server
    finally:
        server.stop()


def _codex_session(base: str, **change) -> dict:
    response = _API.post(f"{base}/api/assistant/sessions", json={"choices": codex_choice(**change)}, timeout=20)
    assert response.status_code == 201, response.text
    return response.json()


def _read(backend, session_id: int) -> dict:
    return _API.get(f"{backend.base}/api/assistant/sessions/{session_id}", timeout=20).json()


def _auth(backend, state: str) -> None:
    backend.codex_state.mkdir(parents=True, exist_ok=True)
    (backend.codex_state / "auth").write_text(state, encoding="utf-8")


def _run(backend) -> dict:
    return json.loads((backend.codex_state / "last-run.json").read_text(encoding="utf-8"))


def test_a_read_runs_through_resmons_read_only_server(backend):
    session = _codex_session(backend.base)
    events = api._turn(backend.base, session["id"], "CALL:list_sources {}\nSAY:listed")
    calls = [e for e in events if e["type"] == "tool_call"]
    results = [e for e in events if e["type"] == "tool_result"]
    assert [c["tool_name"] for c in calls] == ["list_sources"]
    assert results and results[0]["is_error"] is False and results[0]["tool_use_id"] == calls[0]["tool_use_id"]
    assert "arxiv" in results[0]["content"]
    # What the server offered Codex, as the double saw it over MCP: the reads, exactly.
    assert set(_run(backend)["tools"]) == set(mcp_server.READ_TOOLS)


def test_a_write_codex_guesses_is_refused_by_the_server_and_nothing_changes(backend):
    before = _API.get(f"{backend.base}/api/routines", timeout=20).json()
    session = _codex_session(backend.base)
    events = api._turn(backend.base, session["id"],
                       'CALL:create_routine {"name": "Codex watch", "schedule": "0 7 * * 1", '
                       '"sources": ["arxiv"], "keywords": ["perovskite"]}\nSAY:tried')
    result = next(e for e in events if e["type"] == "tool_result")
    assert result["is_error"] is True and "read-only tools only" in result["content"]
    assert not [e for e in events if e["type"] == "permission_request"]
    assert _API.get(f"{backend.base}/api/routines", timeout=20).json() == before


def test_the_store_keeps_the_thread_resumes_it_and_names_the_model(backend):
    session = _codex_session(backend.base, model="gpt-5.5-codex", effort="high")
    first = api._turn(backend.base, session["id"], "MODEL:gpt-5.5-codex\nSAY:first answer")
    thread = next(e for e in first if e["type"] == "started")["owned_cli_session_id"]
    with sqlite3.connect(backend.db_path) as conn:
        stored = conn.execute("SELECT runtime, cli_session_id FROM assistant_sessions WHERE id=?",
                              (session["id"],)).fetchone()
    assert stored == ("codex_cli", thread)
    argv = _run(backend)["argv"]
    assert "resume" not in argv and argv[argv.index("-m") + 1] == "gpt-5.5-codex"
    assert 'model_reasoning_effort="high"' in argv

    api._turn(backend.base, session["id"], "SAY:second answer")
    argv = _run(backend)["argv"]
    assert argv[:2] == ["exec", "resume"] and argv[-2] == thread

    read = _read(backend, session["id"])
    assert [m["role"] for m in read["messages"]] == ["user", "assistant", "user", "assistant"]
    answer = read["messages"][1]
    assert answer["content"] == "first answer"
    assert (answer["input_tokens"], answer["output_tokens"], answer["cost_usd"]) == (1200, 80, None)
    first_turn = read["turn_choices"][0]
    assert first_turn["requested"]["runtime"] == "codex_cli"
    assert first_turn["requested"]["requested_effort"] == "high"
    assert first_turn["answered_by"] == {"model": "gpt-5.5-codex", "name": "GPT-5.5-Codex",
                                         "source": "codex_event_model"}
    assert read["session"]["choices"]["provider"] == "codex"
    # The pickers learn what a requested Codex model answered as.
    entries = _API.get(f"{backend.base}/api/ai/last-answered", timeout=20).json()["entries"]
    assert not [e for e in entries if e["provider"] == "codex" and e["requested"] == "gpt-5.5-codex"], (
        "a model that reported itself as asked says nothing new")


def test_an_expired_codex_sign_in_is_a_failed_turn_with_a_way_to_sign_in(backend):
    _auth(backend, "expired")
    try:
        session = _codex_session(backend.base)
        events = api._turn(backend.base, session["id"], "SAY:not said")
        assert [e["code"] for e in events if e["type"] == "error"] == ["cli_auth"]
        read = _read(backend, session["id"])
        assert [m["role"] for m in read["messages"]] == ["user"]
        failure = read["turn_choices"][0]["failure"]
        assert failure["code"] == "cli_auth" and failure["cost_usd"] is None
        check = _API.get(f"{backend.base}/api/ai/cli/sign-in",
                         params={"provider": "codex", "purpose": "ask"}, timeout=20).json()
        assert check["state"] == "expired" and check["path"] == backend.shim
        assert check["command"] == f"{backend.shim} login status"
    finally:
        _auth(backend, "signed_in")
    check = _API.get(f"{backend.base}/api/ai/cli/sign-in",
                     params={"provider": "codex", "purpose": "ask"}, timeout=20).json()
    assert check["state"] == "signed_in" and check["method"] == "ChatGPT"
    # Signed in again, the same conversation answers, in a thread of its own.
    events = api._turn(backend.base, session["id"], "SAY:answered after signing in")
    assert not [e for e in events if e["type"] in ("error", "notice")], events
    assert [m["role"] for m in _read(backend, session["id"])["messages"]] == ["user", "user", "assistant"]


def test_a_codex_conversation_is_fixed_to_codex(backend):
    session = _codex_session(backend.base)
    api._turn(backend.base, session["id"], "SAY:one")
    with sqlite3.connect(backend.db_path) as conn:
        row = conn.execute("SELECT runtime, provider FROM assistant_session_choices WHERE session_id=?",
                           (session["id"],)).fetchone()
    assert row == ("codex_cli", "codex")
    # Changing which command summaries use changes Codex's route: the next turn
    # is refused rather than sent to a different binary.
    _API.put(f"{backend.base}/api/settings/ai", json={"settings": {"ai_provider": "claude_code"}},
             timeout=20).raise_for_status()
    try:
        refused = _API.post(f"{backend.base}/api/assistant/sessions/{session['id']}/messages",
                            json={"text": "SAY:two"}, timeout=20)
        assert refused.status_code == 409
    finally:
        _API.put(f"{backend.base}/api/settings/ai", json={"settings": {"ai_provider": "codex"}},
                 timeout=20).raise_for_status()


def test_asks_codex_models_come_from_the_command_ask_runs(backend):
    """The composer holds no path; ``purpose: ask`` has the engine ask Ask's Codex."""
    listed = _API.post(f"{backend.base}/api/ai/models", json={"provider": "codex", "purpose": "ask"}, timeout=30)
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["models"] == ["gpt-5.5-codex", "gpt-5.5-mini"]
    assert body["efforts"]["gpt-5.5-codex"] == ["minimal", "low", "medium", "high"]
    # Without it the route finds the command the way a summary lane does, which
    # here, held to configured paths and given none, is not at all.
    plain = _API.post(f"{backend.base}/api/ai/models", json={"provider": "codex"}, timeout=30)
    assert plain.status_code == 400
