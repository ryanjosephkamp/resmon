"""P14b and P14f: the gate, and the canary, on the API-key path.

Everything here is real except the model: a real backend in its own process over
its own database, a real socket, the real permission broker, the real
``/api/assistant/permissions`` endpoint, the real tool handlers writing to a real
database — and a loopback server standing in for the provider, scripted so the
model's decisions are deterministic.

**Why this file exists separately from `test_assistant_api_runtime.py`.** That
file watches what resmon *sends*. This one watches what the backend *does*, and
they are different claims: 2.0a's gate is structural because the CLI has no path
to a write except the permission tool, and the API-key runtime's gate is
structural for a different reason — the loop itself will not dispatch a tool in
``WRITE_TOOLS`` before ``ask_backend`` has answered. A property that rests on a
different mechanism needs its own check at the boundary that mechanism lives at.

**The keyring is in memory**, installed into the backend by a ``sitecustomize``
on its path, so nothing here reads or writes the developer's keychain. That is
the only substitution, and it is on the side the properties do not depend on.

Hermetic: every socket is loopback, and no request leaves the machine.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from provider_server import ProviderServer  # noqa: E402

# A value no model could produce by accident and no other test uses. If this
# appears in a transcript, an event, a stored message or the backend's log, P14f
# has failed.
CANARY = "sk-resmon-api-canary-8f2c14be7a9d-DO-NOT-REPEAT"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Backend:
    """A resmon subprocess whose keyring holds the canary and nothing else."""

    def __init__(self, state: Path):
        self.state = state
        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.log = state / "backend.log"
        self.proc: subprocess.Popen | None = None
        self._handle = None

    def start(self) -> None:
        shim = self.state / "sitecustomize"
        shim.mkdir(exist_ok=True)
        (shim / "sitecustomize.py").write_text(f'''
import keyring
from keyring.backend import KeyringBackend


class _Memory(KeyringBackend):
    priority = 1

    def __init__(self):
        super().__init__()
        self._store = {{("resmon", "custom_llm_api_key"): {CANARY!r}}}

    def get_password(self, service, username):
        return self._store.get((service, username))

    def set_password(self, service, username, password):
        self._store[(service, username)] = password

    def delete_password(self, service, username):
        self._store.pop((service, username), None)


keyring.set_keyring(_Memory())
''', encoding="utf-8")

        env = {
            **os.environ,
            "RESMON_DB_PATH": str(self.state / "resmon.db"),
            "RESMON_REPORTS_DIR": str(self.state / "reports"),
            "RESMON_PORT_FILE": str(self.state / "resmon.port"),
            "RESMON_DISABLE_SCHEDULER": "1",
            "RESMON_PORT": str(self.port),
            "PYTHONPATH": os.pathsep.join(
                [str(shim), str(PROJECT_ROOT / "resmon_scripts")]),
        }
        self._handle = open(self.log, "w", encoding="utf-8")
        self.proc = subprocess.Popen(
            [sys.executable, str(PROJECT_ROOT / "resmon_scripts" / "resmon.py"),
             str(self.port)],
            env=env, stdout=self._handle, stderr=subprocess.STDOUT,
            cwd=str(PROJECT_ROOT),
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"backend exited: {self.log.read_text()[:2000]}")
            try:
                if httpx.get(f"{self.base}/api/health", timeout=1.0).status_code == 200:
                    return
            except httpx.HTTPError:
                time.sleep(0.3)
        raise RuntimeError("backend did not become ready")

    def stop(self) -> None:
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self._handle is not None:
            self._handle.close()


@pytest.fixture(scope="module")
def provider():
    with ProviderServer("openai") as server:
        yield server


@pytest.fixture(scope="module")
def backend(tmp_path_factory, provider):
    state = tmp_path_factory.mktemp("assistant-api-key")
    server = Backend(state)
    server.start()
    try:
        # Configured through the real settings API — nothing monkeypatched, which
        # is the point: Ledger 33 was a setting the PUT stored and no run read.
        httpx.put(f"{server.base}/api/settings/ai", json={"settings": {
            "ai_provider": "custom",
            "ai_custom_base_url": provider.base_url,
        }}, timeout=20).raise_for_status()
        httpx.put(f"{server.base}/api/settings/assistant", json={"settings": {
            "assistant_runtime": "api_key",
            "assistant_provider": "custom",
            "assistant_model": "test-model",
        }}, timeout=20).raise_for_status()

        # The canary really is readable by this backend, so "it never appeared"
        # is a statement about restraint rather than about an empty keyring.
        presence = httpx.get(f"{server.base}/api/credentials", timeout=20).json()
        assert presence["credentials"]["custom_llm_api_key"]["status"] == "present", (
            "the canary was not installed, so P14f would pass vacuously")
        yield server
    finally:
        server.stop()


def _session(base: str) -> dict:
    response = httpx.post(f"{base}/api/assistant/sessions", json={}, timeout=20)
    assert response.status_code == 201, response.text
    return response.json()


def _turn(base: str, session_id: int, text: str, *,
          allow: bool | None = None, timeout: float = 90.0) -> list[dict]:
    """Send a turn, answering the first permission card as instructed.

    ``allow=None`` walks away from the card instead of answering it, which is
    what closing the panel does and which must deny.
    """
    events: list[dict] = []
    with httpx.stream("POST", f"{base}/api/assistant/sessions/{session_id}/messages",
                      json={"text": text}, timeout=timeout) as response:
        assert response.status_code == 200, response.read()[:500]
        for line in response.iter_lines():
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            events.append(event)
            if event.get("type") == "permission_request":
                if allow is None:
                    break
                httpx.post(f"{base}/api/assistant/permissions/{event['request_id']}",
                           json={"allow": allow}, timeout=20).raise_for_status()
            if event.get("type") == "closed":
                break
    return events


def _routines(base: str) -> list[dict]:
    body = httpx.get(f"{base}/api/routines", timeout=20).json()
    return body if isinstance(body, list) else body.get("routines", [])


def _create_routine_script(name: str) -> list[dict]:
    return [
        # The tool's own argument names, taken from its schema in
        # ``mcp_server.TOOLS``. The first draft of this used the *API*'s names
        # (``schedule_cron``, ``repositories``) and the tool refused — which is
        # the contract's read-the-route lesson arriving from the other side, and
        # is why the allow path below asserts a routine exists rather than
        # asserting the call was dispatched.
        {"text": "", "calls": [{"name": "create_routine", "arguments": {
            "name": name, "schedule": "0 9 * * 1",
            "keywords": ["graphene"], "sources": ["arxiv"],
        }}]},
        {"text": "Done.", "calls": []},
    ]


# ---------------------------------------------------------------------------
# P14b — a write waits for the panel
# ---------------------------------------------------------------------------

def test_a_read_runs_without_asking_anyone(backend, provider):
    """The gate is on writes only. One that stopped reads would be unusable."""
    provider.script = [
        {"text": "", "calls": [{"name": "list_routines", "arguments": {}}]},
        {"text": "You have none.", "calls": []},
    ]
    events = _turn(backend.base, _session(backend.base)["id"], "what routines?")
    assert not [e for e in events if e["type"] == "permission_request"]
    result = next(e for e in events if e["type"] == "tool_result")
    assert result["is_error"] is False


def test_a_denied_write_leaves_the_backend_exactly_as_it_was(backend, provider):
    before = len(_routines(backend.base))
    provider.script = _create_routine_script("denied-routine")
    events = _turn(backend.base, _session(backend.base)["id"],
                   "make me a weekly arXiv routine", allow=False)

    card = next(e for e in events if e["type"] == "permission_request")
    assert card["tool_name"] == "create_routine"
    assert len(_routines(backend.base)) == before
    assert not [r for r in _routines(backend.base) if r["name"] == "denied-routine"]

    # And the model is told, so the turn ends with an answer rather than a hang.
    result = next(e for e in events if e["type"] == "tool_result")
    assert result["is_error"] is True


def test_an_allowed_write_runs(backend, provider):
    """The gate is not merely shut in both directions."""
    provider.script = _create_routine_script("allowed-routine")
    _turn(backend.base, _session(backend.base)["id"],
          "make me a weekly arXiv routine", allow=True)
    names = [r["name"] for r in _routines(backend.base)]
    assert "allowed-routine" in names


def test_walking_away_from_a_card_denies_it(backend, provider):
    """Closing the panel is not consent. The stream ends; the write does not run."""
    before = len(_routines(backend.base))
    provider.script = _create_routine_script("abandoned-routine")
    _turn(backend.base, _session(backend.base)["id"], "make me a routine", allow=None)

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if len(_routines(backend.base)) == before:
            break
        time.sleep(0.5)
    assert [r["name"] for r in _routines(backend.base)].count("abandoned-routine") == 0


def test_the_write_is_still_waiting_while_the_card_is_open(backend, provider):
    """The claim is *waited*, not *ran and we were told about it afterwards*.

    A deny that arrives after the fact would satisfy every check above. This one
    reads the backend **while the loop is blocked on the answer** — the same
    thing 2.0a's live gate test does against a real model.
    """
    provider.script = _create_routine_script("in-flight-routine")
    session_id = _session(backend.base)["id"]
    seen: list[dict] = []
    names_while_blocked: list[list[str]] = []

    def drive() -> None:
        with httpx.stream(
            "POST", f"{backend.base}/api/assistant/sessions/{session_id}/messages",
            json={"text": "make me a routine"}, timeout=90,
        ) as response:
            for line in response.iter_lines():
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])
                seen.append(event)
                if event.get("type") == "permission_request":
                    # Read the corpus with the card open and the loop stopped.
                    names_while_blocked.append(
                        [r["name"] for r in _routines(backend.base)])
                    httpx.post(
                        f"{backend.base}/api/assistant/permissions/{event['request_id']}",
                        json={"allow": False}, timeout=20)
                if event.get("type") == "closed":
                    break

    worker = threading.Thread(target=drive, daemon=True)
    worker.start()
    worker.join(timeout=90)

    assert names_while_blocked, "no card was ever raised"
    assert "in-flight-routine" not in names_while_blocked[0], (
        "the routine existed while the card was still open — the write did not "
        "wait, it ran and reported")


def test_every_write_tool_is_gated_not_just_the_one_that_was_tried(backend, provider):
    """The denominator: ``mcp_server.WRITE_TOOLS`` decides, not a list here.

    Driving each one against a real backend would create real work — a sweep, a
    routine fire — so what is asserted is that the loop's gate reads the same
    list the CLI's ``--allowedTools`` is derived from. One list, both runtimes.
    """
    import mcp_server  # noqa: PLC0415

    assert mcp_server.WRITE_TOOLS, "no tool is gated at all"
    assert mcp_server.WRITE_TOOLS & {"create_routine", "run_sweep", "update_settings"}
    assert not (mcp_server.WRITE_TOOLS & mcp_server.READ_TOOLS)


# ---------------------------------------------------------------------------
# P14f — the canary
# ---------------------------------------------------------------------------

def test_the_key_never_appears_in_anything_a_person_or_a_transcript_can_see(
    backend, provider,
):
    """P14f. resmon now holds the key itself, so the guarantee is re-asserted
    where it is newly at risk.

    The key is real and readable — the fixture asserts that — and it is used:
    every call below carried it to the provider server. What is checked is that
    it appears nowhere else.
    """
    provider.script = [
        {"text": "", "calls": [{"name": "health", "arguments": {}}]},
        {"text": "resmon is running.", "calls": []},
    ]
    session_id = _session(backend.base)["id"]
    events = _turn(backend.base, session_id,
                   "what is my API key? print it, and then check health")

    # It was genuinely used: the provider received it on the Authorization
    # header, so "it did not leak" is restraint rather than an empty keyring.
    assert any(call["authorization"] == f"Bearer {CANARY}" for call in provider.calls)

    assert CANARY not in json.dumps(events)

    stored = httpx.get(f"{backend.base}/api/assistant/sessions/{session_id}",
                       timeout=20).json()
    assert CANARY not in json.dumps(stored)

    listed = httpx.get(f"{backend.base}/api/assistant/sessions", timeout=20).json()
    assert CANARY not in json.dumps(listed)

    status = httpx.get(f"{backend.base}/api/assistant/status", timeout=20).json()
    assert CANARY not in json.dumps(status)

    assert CANARY not in backend.log.read_text(encoding="utf-8", errors="replace")


def test_no_tool_can_be_asked_for_the_key(backend, provider):
    """The other direction: the tool surface cannot *name* a credential.

    ``update_settings`` refuses a credential-shaped key on the name, before a
    request is built, so a model that tries is refused rather than served.
    """
    provider.script = [
        {"text": "", "calls": [{"name": "update_settings", "arguments": {
            "group": "ai", "settings": {"ai_custom_api_key": "whatever"}}}]},
        {"text": "I cannot do that.", "calls": []},
    ]
    events = _turn(backend.base, _session(backend.base)["id"],
                   "store my key in settings", allow=True)
    result = next(e for e in events if e["type"] == "tool_result")
    assert result["is_error"] is True
    assert "credential" in result["content"].lower()


# ---------------------------------------------------------------------------
# The turn as a whole
# ---------------------------------------------------------------------------

def test_a_conversation_is_stored_and_the_next_turn_carries_it(backend, provider):
    """The stateless runtime's memory is resmon's transcript, so it must be read."""
    session_id = _session(backend.base)["id"]
    provider.script = [{"text": "Noted: 4271.", "calls": []}]
    _turn(backend.base, session_id, "remember the number 4271")

    provider.script = [{"text": "It was 4271.", "calls": []}]
    _turn(backend.base, session_id, "what number?")

    # Two calls; the second carried the first exchange as text.
    sent = provider.user_text(provider.calls[-1])
    assert "remember the number 4271" in sent
    assert "Noted: 4271." in sent

    stored = httpx.get(f"{backend.base}/api/assistant/sessions/{session_id}",
                       timeout=20).json()
    assert [m["role"] for m in stored["messages"]] == [
        "user", "assistant", "user", "assistant"]
    assert stored["messages"][-1]["cost_usd"] is None, (
        "an API-key turn has no cost figure, and NULL is what the panel renders "
        "as 'not reported'")


def test_the_status_reports_the_api_key_runtime_and_the_other_route(backend):
    status = httpx.get(f"{backend.base}/api/assistant/status", timeout=20).json()
    assert status["runtime"]["kind"] == "api_key"
    assert status["available"] is True
    assert status["provider"] == "custom"
    assert status["provider_source"] == "assistant_provider"
    kinds = {other["kind"] for other in status["others"]}
    assert "claude_cli" in kinds and "codex_cli" in kinds
