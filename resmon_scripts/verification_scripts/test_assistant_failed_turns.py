"""A failed Ask turn is kept as a failure, never as an answer, on a real backend.

The case this exists for: Claude Code's sign-in had expired, the CLI said so in
an ordinary assistant text block and then in an error result, and resmon
stored that sentence as the assistant's answer, with "Reported cost $0.0000"
under it and "2 saved messages" in the header. Now the user's message stays,
no assistant message is written, the failure is recorded beside the turn with
what the panel can offer next, and no cost is kept unless one was reported.

Also here, because they ride the same turns: the model an answer reports
(``modelUsage``), which the transcript names and the pickers remember; and
the sign-in check and the command's own login, through the real routes and a
fake CLI. **No real ``claude`` or ``codex`` is run.** Discovery is held to the
configured path (``RESMON_AI_CLI_DISCOVERY=configured-only``), so a check with
no path set cannot find one installed on this machine, and the opener is a
script that records what it was asked to open (``RESMON_SIGN_IN_OPENER``).
"""

from __future__ import annotations

import json
import os
import sqlite3
import stat
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_assistant_api as api  # noqa: E402

_API = api._API


@pytest.fixture(scope="module")
def shim(tmp_path_factory) -> str:
    path = tmp_path_factory.mktemp("shim") / "fake-claude"
    path.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{api.FAKE_CLAUDE}" "$@"\n')
    path.chmod(0o755)
    return str(path)


@pytest.fixture(scope="module")
def opener(tmp_path_factory) -> Path:
    """An ``open`` that records its arguments and opens nothing."""
    folder = tmp_path_factory.mktemp("opener")
    record = folder / "opened.txt"
    path = folder / "fake-open"
    path.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" >> "{record}"\n')
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


@pytest.fixture(scope="module")
def backend(tmp_path_factory, shim, opener):
    state = tmp_path_factory.mktemp("assistant-failed-turns")
    saved = {k: os.environ.get(k) for k in ("RESMON_AI_CLI_DISCOVERY", "RESMON_SIGN_IN_OPENER",
                                            "RESMON_STATE_DIR")}
    os.environ["RESMON_AI_CLI_DISCOVERY"] = "configured-only"
    os.environ["RESMON_SIGN_IN_OPENER"] = str(opener)
    os.environ["RESMON_STATE_DIR"] = str(state / "resmon-state")
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
        _API.put(f"{server.base}/api/settings/ai",
                 json={"settings": {"ai_cli_path": shim}}, timeout=20).raise_for_status()
        yield server
    finally:
        server.stop()


def _auth(backend, state: str) -> None:
    folder = backend.state / "fake-claude"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "auth").write_text(state, encoding="utf-8")


def _read(backend, session_id: int) -> dict:
    return _API.get(f"{backend.base}/api/assistant/sessions/{session_id}", timeout=20).json()


# ---------------------------------------------------------------------------
# The failure from the screenshot, and the other ways a turn ends without one
# ---------------------------------------------------------------------------

def test_an_expired_sign_in_is_a_failed_turn_and_not_an_answer(backend):
    session = api._session(backend.base)
    events = api._turn(backend.base, session["id"], "AUTH_EXPIRED")

    errors = [e for e in events if e["type"] == "error"]
    assert len(errors) == 1
    assert errors[0]["code"] == "cli_auth"
    assert "not signed in, or its sign-in expired" in errors[0]["message"]
    assert "Failed to authenticate" in errors[0]["message"]

    stored = _read(backend, session["id"])
    # The user's message stays, and nothing is stored as the assistant speaking.
    assert [m["role"] for m in stored["messages"]] == ["user"]
    assert stored["snapshot"]["message_count"] == 1
    turn = stored["turn_choices"][0]
    assert turn["assistant_message_id"] is None
    assert turn["answered_by"] is None
    failure = turn["failure"]
    assert failure["code"] == "cli_auth"
    assert failure["message"] == errors[0]["message"]
    # The CLI reported a cost of 0, which is not a cost: none is kept.
    assert failure["cost_usd"] is None
    # What the CLI wrote is kept beside the failure, labeled as such.
    assert "Failed to authenticate" in failure["partial_text"]
    assert stored["totals"]["turns"] == 0


def test_after_signing_in_the_same_conversation_answers_without_a_lost_session_notice(backend):
    """A conversation whose only turn failed is started again, not resumed."""
    _auth(backend, "expired")
    try:
        session = api._session(backend.base)
        api._turn(backend.base, session["id"], "SAY:first try")
        assert _read(backend, session["id"])["turn_choices"][0]["failure"]["code"] == "cli_auth"
    finally:
        _auth(backend, "signed_in")

    events = api._turn(backend.base, session["id"], "SAY:answered after signing in")
    assert not [e for e in events if e["type"] in ("error", "notice")], events
    assert [e["text"] for e in events if e["type"] == "text_delta"] == ["answered after signing in"]
    stored = _read(backend, session["id"])
    assert [m["role"] for m in stored["messages"]] == ["user", "user", "assistant"]
    assert stored["turn_choices"][0]["failure"] is not None
    assert stored["turn_choices"][1]["failure"] is None


def test_a_budget_stop_keeps_its_reported_cost_on_the_failure(backend):
    session = api._session(backend.base)
    api._turn(backend.base, session["id"], "SAY:partial\nBUDGET")
    stored = _read(backend, session["id"])
    assert [m["role"] for m in stored["messages"]] == ["user"]
    failure = stored["turn_choices"][0]["failure"]
    assert failure["code"] == "failed"
    assert failure["detail"] == "error_max_budget_usd"
    assert failure["cost_usd"] == pytest.approx(0.75)
    assert failure["partial_text"] == "partial"


def test_an_unrecognized_failure_is_kept_as_a_failure(backend):
    session = api._session(backend.base)
    api._turn(backend.base, session["id"], "FAIL:something broke")
    failure = _read(backend, session["id"])["turn_choices"][0]["failure"]
    assert failure["code"] == "failed"
    assert "exit code 3" in failure["message"]


def test_stop_is_recorded_as_stopped_not_as_an_exit_code(backend):
    session = api._session(backend.base)
    sink: list[dict] = []
    worker = threading.Thread(target=api._turn, args=(backend.base, session["id"],
                                                      "SAY:started\nSLEEP:30"),
                              kwargs={"sink": sink}, daemon=True)
    worker.start()
    deadline = time.monotonic() + 30
    while not any(e.get("type") == "text_delta" for e in sink):
        assert time.monotonic() < deadline, sink
        time.sleep(0.1)
    cancelled = _API.post(f"{backend.base}/api/assistant/sessions/{session['id']}/cancel",
                          timeout=20).json()
    assert cancelled["cancelled"] is True
    worker.join(timeout=30)
    errors = [e for e in sink if e["type"] == "error"]
    assert [e["code"] for e in errors] == ["stopped"]
    assert errors[0]["message"] == "Stopped before it finished."
    failure = _read(backend, session["id"])["turn_choices"][0]["failure"]
    assert failure["code"] == "stopped"
    assert failure["partial_text"] == "started"


def test_deleting_a_conversation_removes_its_failures(backend):
    session = api._session(backend.base)
    api._turn(backend.base, session["id"], "AUTH_EXPIRED")
    _API.delete(f"{backend.base}/api/assistant/sessions/{session['id']}", timeout=20).raise_for_status()
    conn = sqlite3.connect(backend.db_path)
    try:
        left = conn.execute("SELECT COUNT(*) FROM assistant_turn_failures f LEFT JOIN assistant_messages m "
                            "ON m.id = f.user_message_id WHERE m.id IS NULL").fetchone()[0]
    finally:
        conn.close()
    assert left == 0


# ---------------------------------------------------------------------------
# What answered
# ---------------------------------------------------------------------------

def test_the_model_an_answer_reports_is_named_on_the_turn(backend):
    session = api._session(backend.base)
    events = api._turn(backend.base, session["id"],
                       "USAGE:claude-haiku-5-5,claude-haiku-4-5-20251001\nSAY:hello")
    reports = [e["reported"] for e in events if e["type"] == "turn_model_report"]
    assert [(r["model"], r["source"], r["name"]) for r in reports] == [
        ("fake-model", "claude_system_init_model", "fake-model"),
        ("claude-haiku-5-5", "claude_result_model_usage", "Haiku 5.5"),
        ("claude-haiku-4-5-20251001", "claude_result_model_usage", "Haiku 4.5"),
    ]
    turn = _read(backend, session["id"])["turn_choices"][0]
    assert turn["answered_by"] == {"model": "claude-haiku-5-5", "name": "Haiku 5.5",
                                   "source": "claude_result_model_usage"}
    assert [r["name"] for r in turn["reported"]] == ["fake-model", "Haiku 5.5", "Haiku 4.5"]


def test_the_pickers_learn_which_model_an_alias_last_resolved_to(backend):
    created = _API.post(f"{backend.base}/api/assistant/sessions", json={"choices": {
        "version": 1, "runtime": "claude_cli", "provider": "claude_code",
        "model": "haiku", "effort": "high"}}, timeout=20)
    assert created.status_code == 201, created.text
    api._turn(backend.base, created.json()["id"], "USAGE:claude-haiku-5-5\nSAY:hi")
    entries = _API.get(f"{backend.base}/api/ai/last-answered", timeout=20).json()["entries"]
    haiku = [e for e in entries if e["provider"] == "claude_code" and e["requested"] == "haiku"]
    assert len(haiku) == 1
    assert (haiku[0]["model"], haiku[0]["name"], haiku[0]["where"]) == (
        "claude-haiku-5-5", "Haiku 5.5", "ask")


# ---------------------------------------------------------------------------
# Signing in, through the routes
# ---------------------------------------------------------------------------

def test_check_sign_in_reports_what_the_fake_command_said(backend, shim):
    for state, expected in (("signed_in", "signed_in"), ("signed_out", "signed_out"),
                            ("expired", "expired"), ("odd", "unknown")):
        _auth(backend, state)
        answer = _API.get(f"{backend.base}/api/ai/cli/sign-in",
                          params={"provider": "claude_code", "purpose": "ask"}, timeout=20).json()
        assert answer["state"] == expected, (state, answer)
        assert answer["path"] == shim
        assert answer["command"] == f"{shim} auth status --json"
    _auth(backend, "signed_in")
    answer = _API.get(f"{backend.base}/api/ai/cli/sign-in",
                      params={"provider": "claude_code", "purpose": "ask"}, timeout=20).json()
    assert (answer["email"], answer["plan"]) == ("reader@example.com", "max")
    assert answer["message"] == "The Claude Code command is signed in as reader@example.com (max)."


def test_a_command_that_is_not_found_is_never_searched_for_here(backend):
    """Codex is not configured, and discovery is held to configured paths."""
    answer = _API.get(f"{backend.base}/api/ai/cli/sign-in",
                      params={"provider": "codex", "purpose": "summaries"}, timeout=20).json()
    assert answer["state"] == "missing"
    assert answer["path"] is None


def test_sign_in_opens_the_commands_own_login_and_check_again_sees_it(backend, shim, opener):
    _auth(backend, "signed_out")
    opened = _API.post(f"{backend.base}/api/ai/cli/sign-in",
                       json={"provider": "claude_code", "purpose": "ask"}, timeout=20)
    assert opened.status_code == 200, opened.text
    body = opened.json()
    if sys.platform == "darwin":
        assert body["opened"] is True and body["how"] == "terminal"
        record = opener.parent / "opened.txt"
        script = Path(record.read_text(encoding="utf-8").strip().splitlines()[-1])
        assert script.name == "resmon-sign-in-claude-code.command"
        assert script.parent == backend.state / "resmon-state" / "sign-in"
        text = script.read_text(encoding="utf-8")
        assert f"\n{shim} auth login\n" in text
        # Run what Terminal would have run, against the fake: the login it
        # starts is the command's own, and Check again sees its result.
        import subprocess
        subprocess.run(["/bin/sh", str(script)], capture_output=True, timeout=30,
                       env={**os.environ, "TERM": "dumb",
                            "FAKE_CLAUDE_STATE": str(backend.state / "fake-claude")})
    else:
        assert body["opened"] is False and body["how"] == "copy"
        _auth(backend, "signed_in")
    assert body["command"] == f"{shim} auth login"
    again = _API.get(f"{backend.base}/api/ai/cli/sign-in",
                     params={"provider": "claude_code", "purpose": "ask"}, timeout=20).json()
    assert again["state"] == "signed_in"


def test_a_purpose_or_provider_resmon_does_not_offer_is_refused(backend):
    for params in ({"provider": "gemini"}, {"provider": "codex", "purpose": "ask"},
                   {"provider": "claude_code", "purpose": "elsewhere"}):
        assert _API.get(f"{backend.base}/api/ai/cli/sign-in", params=params,
                        timeout=20).status_code == 400
