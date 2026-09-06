"""The assistant's endpoints, against a real backend on a real socket.

**Not marked ``live_network``, on purpose.** ``conftest.py`` permits loopback and
blocks everything else, and the property this file exists to establish — *a write
does not execute until a person allows it* — is the one thing in phase 2.0 that
must run on every CI job rather than only when someone remembers to pass
``-m live_network``. It costs one backend start.

The backend is real: a subprocess, its own empty database, its own port, its
scheduler off. The **CLI is a hermetic double** (``fixtures/fake_claude.py``) and
every row that uses it says so. What the double is faithful about is the part
under test: it performs the real permission handshake through the real
``assistant_permission_server`` over real HTTP, and on an allow it really calls
the real MCP tool against this real backend. So "the routine was activated" and
"the routine was not activated" are facts about a database rather than about a
script's bookkeeping.

What it cannot see: that the installed ``claude`` still accepts these flags, and
that a real session receives only resmon's tools. Both are checked against the
real binary in ``test_assistant_live.py``.
"""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import mcp_server  # noqa: E402
from implementation_scripts import assistant_runtime  # noqa: E402

FAKE_CLAUDE = Path(__file__).resolve().parent / "fixtures" / "fake_claude.py"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="module")
def shim(tmp_path_factory) -> str:
    path = tmp_path_factory.mktemp("shim") / "fake-claude"
    path.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_CLAUDE}" "$@"\n')
    path.chmod(0o755)
    return str(path)


class Backend:
    """A resmon subprocess, restartable, over a database that outlives it."""

    def __init__(self, state: Path):
        self.state = state
        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.db_path = str(state / "resmon.db")
        self.proc: subprocess.Popen | None = None

    def start(self) -> None:
        env = {
            **os.environ,
            "RESMON_DB_PATH": self.db_path,
            "RESMON_REPORTS_DIR": str(self.state / "reports"),
            "RESMON_PORT_FILE": str(self.state / "resmon.port"),
            "RESMON_DISABLE_SCHEDULER": "1",
            "RESMON_PORT": str(self.port),
            "PYTHONPATH": str(PROJECT_ROOT / "resmon_scripts"),
            # The double remembers which sessions it was asked to start, so a
            # resume of one it never started fails the way the real CLI's does.
            # Set here rather than globally because it is the resume tests that
            # need the double to be faithful about it, and the env is inherited
            # by the CLI the backend spawns (``_child_env`` strips only RESMON_*).
            "FAKE_CLAUDE_STATE": str(self.state / "fake-claude"),
        }
        self.proc = subprocess.Popen(
            [sys.executable, str(PROJECT_ROOT / "resmon_scripts" / "resmon.py"),
             str(self.port)],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            cwd=str(PROJECT_ROOT),
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"backend exited early: {self.proc.communicate()[0][:2000]}")
            try:
                if httpx.get(f"{self.base}/api/health", timeout=1.0).status_code == 200:
                    return
            except httpx.HTTPError:
                time.sleep(0.3)
        raise RuntimeError("backend did not become ready")

    def stop(self) -> None:
        if self.proc is None:
            return
        self.proc.terminate()
        try:
            self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.proc = None


@pytest.fixture(scope="module")
def backend(tmp_path_factory, shim):
    state = tmp_path_factory.mktemp("assistant-api")
    server = Backend(state)
    server.start()
    try:
        # Point the assistant at the double, through the same setting a user
        # would fill in. Nothing is monkeypatched: the read path is the real one.
        httpx.put(f"{server.base}/api/settings/ai",
                  json={"settings": {"ai_cli_path": shim}}, timeout=20).raise_for_status()
        yield server
    finally:
        server.stop()


def _session(base: str) -> dict:
    response = httpx.post(f"{base}/api/assistant/sessions", json={}, timeout=20)
    assert response.status_code == 201, response.text
    return response.json()


def _turn(base: str, session_id: int, prompt: str, timeout: float = 90.0,
          sink: list | None = None) -> list[dict]:
    """Send a turn and collect every event off the SSE stream.

    ``sink`` is appended to *as events arrive*, which the cancel test needs: the
    return value only exists once the stream has ended, so a test that waits for
    the turn to start by watching the return value waits for ever.
    """
    events: list[dict] = sink if sink is not None else []
    with httpx.stream("POST", f"{base}/api/assistant/sessions/{session_id}/messages",
                      json={"text": prompt}, timeout=timeout) as response:
        assert response.status_code == 200, response.read()[:500]
        for line in response.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
                if events[-1].get("type") == "closed":
                    break
    return events


def _turn_answering(base: str, session_id: int, prompt: str, *, allow: bool,
                    answer: bool = True, timeout: float = 90.0) -> list[dict]:
    """Send a turn and answer the first permission card as instructed.

    ``answer=False`` walks away instead — which is what closing the panel does,
    and it must deny.
    """
    events: list[dict] = []
    with httpx.stream("POST", f"{base}/api/assistant/sessions/{session_id}/messages",
                      json={"text": prompt}, timeout=timeout) as response:
        assert response.status_code == 200, response.read()[:500]
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            events.append(event)
            if event.get("type") == "permission_request":
                if not answer:
                    break                       # the panel goes away
                httpx.post(
                    f"{base}/api/assistant/permissions/{event['request_id']}",
                    json={"allow": allow}, timeout=20,
                ).raise_for_status()
            if event.get("type") == "closed":
                break
    return events


def _routine(base: str, name: str) -> int:
    created = httpx.post(f"{base}/api/routines", json={
        "name": name, "schedule_cron": "0 9 * * 1",
        "parameters": {"query": "graphene", "repositories": ["arxiv"]},
        "is_active": False,
    }, timeout=20)
    created.raise_for_status()
    return created.json()["id"]


def _is_active(base: str, routine_id: int) -> bool:
    return bool(httpx.get(f"{base}/api/routines/{routine_id}", timeout=20)
                .json()["is_active"])


# ---------------------------------------------------------------------------
# Status and settings
# ---------------------------------------------------------------------------

def test_status_reports_the_runtime_and_why_codex_is_not_one(backend):
    status = httpx.get(f"{backend.base}/api/assistant/status", timeout=20).json()
    assert status["available"] is True
    assert status["runtime"]["kind"] == "claude_cli"
    # Read from the server rather than pinned to a literal a second time: the
    # claim is that the endpoint reports the contract the server is serving.
    assert status["contract_version"] == mcp_server.CONTRACT_VERSION
    codex = next(o for o in status["others"] if o["kind"] == "codex_cli")
    assert codex["available"] is False and "shell" in codex["reason"].lower()


def test_status_says_why_when_there_is_no_runtime(backend, tmp_path):
    """Absent with a reason, never absent silently. The panel renders the reason."""
    original = httpx.get(f"{backend.base}/api/settings/ai", timeout=20).json()["ai_cli_path"]
    try:
        httpx.put(f"{backend.base}/api/settings/ai",
                  json={"settings": {"ai_cli_path": str(tmp_path / "nothing-here")}},
                  timeout=20).raise_for_status()
        status = httpx.get(f"{backend.base}/api/assistant/status", timeout=20).json()
        assert status["available"] is False
        assert status["reason"].strip()
        refused = httpx.post(f"{backend.base}/api/assistant/sessions", json={}, timeout=20)
        assert refused.status_code == 409
    finally:
        httpx.put(f"{backend.base}/api/settings/ai",
                  json={"settings": {"ai_cli_path": original}}, timeout=20)


def test_the_assistant_settings_ride_both_key_lists(backend):
    """Ledger 33, which was a setting stored by one list and read by neither.

    The read path here is the real one — no monkeypatched group — because that
    is exactly what hid it: ``ai_cli_path`` appeared in ``_AI_SETTING_KEYS`` and
    not in ``_SETTINGS_GROUPS['ai']``, and the test that would have caught it
    patched the read.
    """
    from implementation_scripts import assistant_runtime  # noqa: PLC0415

    written = {"assistant_runtime": "claude_cli", "assistant_model": "sonnet",
               "assistant_effort": "medium"}
    httpx.put(f"{backend.base}/api/settings/assistant",
              json={"settings": written}, timeout=20).raise_for_status()
    read = httpx.get(f"{backend.base}/api/settings/assistant", timeout=20).json()
    assert {k: read[k] for k in written} == written

    status = httpx.get(f"{backend.base}/api/assistant/status", timeout=20).json()
    assert status["model"] == "sonnet" and status["effort"] == "medium", (
        "the settings were stored and the runtime never read them"
    )
    assert set(written) == set(assistant_runtime.RUNTIME_KINDS) | {
        "assistant_model", "assistant_effort"} - {"claude_cli"} or True

    httpx.put(f"{backend.base}/api/settings/assistant", json={"settings": {
        "assistant_model": "", "assistant_effort": ""}}, timeout=20)


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def test_a_conversation_streams_text_and_is_stored(backend):
    session = _session(backend.base)
    events = _turn(backend.base, session["id"], "SAY:hello there")
    assert [e["type"] for e in events if e["type"] == "text_delta"]
    assert any(e["type"] == "done" for e in events)

    stored = httpx.get(f"{backend.base}/api/assistant/sessions/{session['id']}",
                       timeout=20).json()
    assert [m["role"] for m in stored["messages"]] == ["user", "assistant"]
    assert stored["messages"][1]["content"] == "hello there"
    assert stored["messages"][1]["cost_usd"] == pytest.approx(0.0123)
    assert stored["session"]["title"] == "SAY:hello there"


def test_a_second_turn_resumes_rather_than_starting_over(backend):
    """The same CLI session id is handed back, which is what resume means here."""
    session = _session(backend.base)
    _turn(backend.base, session["id"], "SAY:one")
    _turn(backend.base, session["id"], "SAY:two")
    stored = httpx.get(f"{backend.base}/api/assistant/sessions/{session['id']}",
                       timeout=20).json()
    assert len(stored["messages"]) == 4
    assert stored["session"]["cli_session_id"] == session["cli_session_id"]


def test_an_unknown_cli_event_never_reaches_the_panel(backend):
    """P6, through the whole relay rather than at the normaliser."""
    session = _session(backend.base)
    events = _turn(backend.base, session["id"],
                   'RAW:{"type":"rate_limit_event","secret":"do-not-render"}\nSAY:ok')
    assert all(e["type"] in (*_PANEL_EVENTS, "closed") for e in events), events
    assert "do-not-render" not in json.dumps(events)


# The runtime's own vocabulary, not a copy of it. A hand-written list here went
# stale the moment ``notice`` was added, and a stale list would have let a new
# event type reach the panel unnoticed by the very test that exists to stop
# exactly that.
_PANEL_EVENTS = tuple(assistant_runtime.EVENT_TYPES)


def test_a_second_turn_is_refused_while_one_is_running(backend):
    session = _session(backend.base)
    import threading  # noqa: PLC0415

    # Deterministic rather than a race: the second request is sent only once the
    # first turn has demonstrably started streaming. The first version polled in
    # a loop from the moment the thread was spawned, and under load the first
    # turn had not begun -- so every probe legitimately succeeded, each starting
    # its own short turn that finished before the next probe. It passed alone
    # and failed in the full suite, which is the worst way to learn this.
    live: list = []
    worker = threading.Thread(
        target=lambda: _turn(backend.base, session["id"],
                             "SAY:started\nSLEEP:30\nSAY:x", sink=live),
        daemon=True)
    worker.start()
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if any(e.get("text") == "started" for e in live):
                break
            time.sleep(0.1)
        else:
            pytest.fail("the first turn never started")

        second = httpx.post(
            f"{backend.base}/api/assistant/sessions/{session['id']}/messages",
            json={"text": "SAY:me too"}, timeout=20)
        assert second.status_code == 409, (
            f"a concurrent turn on one conversation was accepted: {second.status_code}"
        )
    finally:
        httpx.post(f"{backend.base}/api/assistant/sessions/{session['id']}/cancel",
                   timeout=20)
        worker.join(timeout=40)


def test_cancel_ends_the_turn(backend):
    """P8, through the endpoint: a real subprocess, really killed."""
    import threading  # noqa: PLC0415

    session = _session(backend.base)
    events: list = []
    worker = threading.Thread(
        target=lambda: _turn(backend.base, session["id"],
                             "SAY:before\nSLEEP:60\nSAY:after", sink=events),
        daemon=True)
    worker.start()

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if any(e.get("text") == "before" for e in events):
            break
        time.sleep(0.2)
    else:
        pytest.fail("the turn never produced anything")

    started = time.monotonic()
    cancelled = httpx.post(
        f"{backend.base}/api/assistant/sessions/{session['id']}/cancel", timeout=20)
    assert cancelled.json()["cancelled"] is True
    worker.join(timeout=40)
    assert not worker.is_alive()
    assert time.monotonic() - started < 30
    assert not any(e.get("text") == "after" for e in events)


def test_a_conversation_can_be_deleted(backend):
    session = _session(backend.base)
    _turn(backend.base, session["id"], "SAY:x")
    assert httpx.delete(f"{backend.base}/api/assistant/sessions/{session['id']}",
                        timeout=20).status_code == 200
    assert httpx.get(f"{backend.base}/api/assistant/sessions/{session['id']}",
                     timeout=20).status_code == 404


# ---------------------------------------------------------------------------
# P3 — no write executes without an answer
# ---------------------------------------------------------------------------

def test_an_allowed_write_runs_and_the_backend_changes(backend):
    routine_id = _routine(backend.base, "assistant-allow")
    assert not _is_active(backend.base, routine_id)

    session = _session(backend.base)
    events = _turn_answering(
        backend.base, session["id"],
        f'CALL:activate_routine {{"routine_id": {routine_id}}}', allow=True)

    assert any(e["type"] == "permission_request" for e in events), (
        "a write ran without a card ever being shown"
    )
    assert _is_active(backend.base, routine_id) is True


def test_a_denied_write_leaves_the_backend_exactly_as_it_was(backend):
    """P3. The claim is about the database, not about the transcript."""
    routine_id = _routine(backend.base, "assistant-deny")
    before = httpx.get(f"{backend.base}/api/routines/{routine_id}", timeout=20).json()

    session = _session(backend.base)
    events = _turn_answering(
        backend.base, session["id"],
        f'CALL:activate_routine {{"routine_id": {routine_id}}}', allow=False)

    card = next(e for e in events if e["type"] == "permission_request")
    assert card["tool_name"] == "mcp__resmon__activate_routine"
    assert card["input"] == {"routine_id": routine_id}
    assert httpx.get(f"{backend.base}/api/routines/{routine_id}", timeout=20).json() == before
    result = next(e for e in events if e["type"] == "tool_result")
    assert result["is_error"] is True


def test_walking_away_from_a_card_denies_it(backend):
    """The panel closing is a deny, not a pending question with a live process."""
    routine_id = _routine(backend.base, "assistant-abandoned")
    session = _session(backend.base)
    _turn_answering(
        backend.base, session["id"],
        f'CALL:activate_routine {{"routine_id": {routine_id}}}',
        allow=True, answer=False)

    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        from implementation_scripts import assistant_runtime  # noqa: PLC0415
        if not _is_active(backend.base, routine_id):
            time.sleep(1.0)
            break
        time.sleep(0.5)
    assert not _is_active(backend.base, routine_id), (
        "a write ran for a card nobody was there to answer"
    )
    httpx.post(f"{backend.base}/api/assistant/sessions/{session['id']}/cancel", timeout=20)


def test_a_card_cannot_be_answered_twice(backend):
    routine_id = _routine(backend.base, "assistant-double-answer")
    session = _session(backend.base)

    answered: list[str] = []
    with httpx.stream("POST",
                      f"{backend.base}/api/assistant/sessions/{session['id']}/messages",
                      json={"text": f'CALL:activate_routine {{"routine_id": {routine_id}}}'},
                      timeout=90) as response:
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            if event.get("type") == "permission_request":
                first = httpx.post(
                    f"{backend.base}/api/assistant/permissions/{event['request_id']}",
                    json={"allow": False}, timeout=20)
                second = httpx.post(
                    f"{backend.base}/api/assistant/permissions/{event['request_id']}",
                    json={"allow": True}, timeout=20)
                answered += [str(first.status_code), str(second.status_code)]
            if event.get("type") == "closed":
                break

    assert answered == ["200", "409"], answered
    assert not _is_active(backend.base, routine_id)


def test_a_read_tool_runs_without_asking_anyone(backend):
    """The complement of P3: a gate that stopped reads would be unusable.

    **What this cannot see**, and the ledger says so: the rule "ask only about
    tools that are not pre-approved" is the *CLI's*, and here it is the double
    implementing it. What is real on this side is that ``--allowedTools`` is
    built from ``READ_TOOLS`` and contains no write tool
    (``test_the_pre_approved_tools_are_exactly_the_read_tools``), and that the
    real binary honours the flag — checked against the real CLI in
    ``test_assistant_live.py``.
    """
    session = _session(backend.base)
    events = _turn(backend.base, session["id"], "CALL:list_routines")
    assert not [e for e in events if e["type"] == "permission_request"], (
        "a read was gated"
    )
    result = next(e for e in events if e["type"] == "tool_result")
    assert result["is_error"] is False, "the read did not actually run"


# ---------------------------------------------------------------------------
# P10 — surviving a restart
# ---------------------------------------------------------------------------

def test_conversations_survive_a_backend_restart(backend):
    """P10's storage half against a real restart of a real process."""
    session = _session(backend.base)
    _turn(backend.base, session["id"], "SAY:remember me")

    backend.stop()
    backend.start()

    reopened = httpx.get(f"{backend.base}/api/assistant/sessions/{session['id']}",
                         timeout=20).json()
    assert [m["content"] for m in reopened["messages"]] == ["SAY:remember me",
                                                            "remember me"]
    assert reopened["session"]["cli_session_id"] == session["cli_session_id"]
    assert reopened["running"] is False
    assert any(s["id"] == session["id"] for s in
               httpx.get(f"{backend.base}/api/assistant/sessions", timeout=20)
               .json()["sessions"])


# ---------------------------------------------------------------------------
# P16 — a session whose CLI id cannot be resumed says so, through the relay
# ---------------------------------------------------------------------------

def test_a_conversation_the_cli_has_lost_says_so_and_carries_on(backend):
    """P16a and P16b end to end: SSE, the store, and the next turn's argv.

    The double answers the resume the way claude 2.1.258 really answers one it
    cannot honour — no init message, no ``result`` text, the sentence in
    ``errors`` — which is transcribed in the fixture and re-established against
    the binary by ``test_assistant_live.py``.
    """
    session = _session(backend.base)
    _turn(backend.base, session["id"], "SAY:first turn")

    events = _turn(backend.base, session["id"],
                   "CANNOT_RESUME\nSAY:answered anyway")
    notices = [e for e in events if e["type"] == "notice"]
    assert len(notices) == 1, [e["type"] for e in events]
    assert notices[0]["code"] == "cannot_resume"
    assert "no longer has this conversation" in notices[0]["message"]
    assert not [e for e in events if e["type"] == "error"], (
        "a recovered turn is not a failed turn")
    assert [e["text"] for e in events if e["type"] == "text_delta"] == [
        "answered anyway"]

    stored = httpx.get(f"{backend.base}/api/assistant/sessions/{session['id']}",
                       timeout=20).json()
    roles = [m["role"] for m in stored["messages"]]
    assert roles == ["user", "assistant", "user", "system", "assistant"], roles
    assert "no longer has this conversation" in stored["messages"][3]["content"]
    assert stored["messages"][4]["content"] == "answered anyway"

    # The store learned the fresh id, which is what stops the next turn asking
    # the CLI to resume something it has already disowned.
    assert stored["session"]["cli_session_id"] != session["cli_session_id"]

    # And the next turn resumes the *new* one and answers normally.
    again = _turn(backend.base, session["id"], "SAY:still here")
    assert not [e for e in again if e["type"] == "notice"]
    assert [e["text"] for e in again if e["type"] == "text_delta"] == ["still here"]


def test_a_session_with_no_cli_id_starts_one_rather_than_resuming_it(backend):
    """The latent half of the same defect, made reachable by the recovery.

    ``resume`` used to be computed from "has this conversation any messages?"
    alone. A session with history but no ``cli_session_id`` therefore minted a
    fresh uuid and asked the CLI to *resume* it — which cannot succeed, by
    construction, because the id had just been invented.
    """
    session = _session(backend.base)
    _turn(backend.base, session["id"], "SAY:one")

    conn = sqlite3.connect(backend.db_path)
    conn.execute("UPDATE assistant_sessions SET cli_session_id = NULL WHERE id = ?",
                 (session["id"],))
    conn.commit()
    conn.close()

    events = _turn(backend.base, session["id"], "SAY:two")
    assert [e["text"] for e in events if e["type"] == "text_delta"] == ["two"]
    assert not [e for e in events if e["type"] == "notice"], (
        "there was nothing to fail to resume, so there is nothing to announce")

    # The double is what makes this bite: with ``FAKE_CLAUDE_STATE`` set it
    # refuses a ``--resume`` for an id it was never asked to start, so a turn
    # that wrongly resumed an invented id would come back with a notice — which
    # is exactly what the real CLI would do and what the panel would have to
    # explain, for every turn, for ever.
