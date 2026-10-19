"""Which resmon an external harness reaches, observed with real processes.

Two real backends on two ephemeral ports, each with its own state directory,
database, reports directory and port file, stand in for the situation a real
machine is in: more than one resmon is installed, and at most one of them is
the one the person means. The MCP server is started as a subprocess and spoken
to in JSON-RPC over stdio, because "an external harness" is the journey --
importing the module into the test process would measure a Python import
rather than the protocol, and would not exercise the environment at all.

**Two mechanisms name a backend and this file covers both**, 2 of 2 as
``mcp_server._candidate_ports`` reads them: ``RESMON_PORT`` in the
environment, and the port file at ``config.PORT_FILE``. The third case -- no
mechanism naming one -- used to fall through to resmon's default port, and the
parity register's external-harness row has always called that out as
forbidden: a wrong or absent app is a refusal, never a silent fallback. It is
now a refusal, and the last test here is what says so.

**Nothing here addresses resmon's background service or the port it uses.**
``_free_port`` refuses to hand that port back, the two backends bind ephemeral
ports the OS chose, and the behavior under test is precisely that the server
reaches for no port it was not given. The refusal case is checked against both
backends' access logs as well as its own payload, so "it did not attach to the
wrong one" is read off the thing that would have served the request rather
than inferred from the answer.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

RESMON_SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RESMON_SCRIPTS))

from implementation_scripts import api_auth  # noqa: E402
from test_local_api_auth import Backend  # noqa: E402


@pytest.fixture(scope="module")
def two_backends(tmp_path_factory):
    """The app the person means, and another resmon that is also running.

    They are deliberately indistinguishable to a port scan and distinguishable
    to this test: different pids, different runtime identities, different
    databases. Which one answers is the whole question.
    """
    root = tmp_path_factory.mktemp("mcp-discovery")
    mine = Backend(root / "mine")
    other = Backend(root / "other")
    try:
        assert mine.port != other.port
        yield mine, other
    finally:
        other.stop()
        mine.stop()


@pytest.fixture(scope="module")
def shared_state(tmp_path_factory, two_backends):
    """One state directory holding both instances' tokens.

    This is not contrived. ``api_auth`` says in as many words that the daemon
    and an Electron-spawned backend can share a state directory, and the token
    file is keyed by port for exactly that reason. A harness pointed at that
    directory can authenticate against either instance, which is why the
    question "which port" has to be answered by something other than "whichever
    one has a token here".
    """
    mine, other = two_backends
    shared = tmp_path_factory.mktemp("harness-state")
    for backend in (mine, other):
        api_auth.write_token_file(backend.port, backend.token, shared)
    return shared


def _run_mcp(state: Path, env_extra: dict, calls: list[tuple[str, dict]]):
    """Drive mcp_server.py over stdio with an environment we fully control.

    Every ``RESMON_*`` variable this process carries is stripped first: the
    suite's own conftest exports one, and inheriting it would mean the harness
    was named something nobody in this file wrote down.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("RESMON_")}
    env.update({"PYTHONPATH": str(RESMON_SCRIPTS), "RESMON_STATE_DIR": str(state)})
    env.update(env_extra)
    lines = [{"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}]
    lines += [{"jsonrpc": "2.0", "id": i + 1, "method": "tools/call",
               "params": {"name": name, "arguments": args}}
              for i, (name, args) in enumerate(calls)]
    done = subprocess.run(
        [sys.executable, str(RESMON_SCRIPTS / "mcp_server.py")],
        cwd=RESMON_SCRIPTS, env=env, timeout=300, capture_output=True, text=True,
        input="".join(json.dumps(line) + "\n" for line in lines),
    )
    responses = [json.loads(line) for line in done.stdout.splitlines() if line.strip()]
    return responses, done.stdout, done.stderr


def _payload(response: dict) -> dict:
    return json.loads(response["result"]["content"][0]["text"])


# ---------------------------------------------------------------------------
# The two surviving routes, 2 of the 2 in _candidate_ports
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("mechanism", ["environment", "port_file"])
def test_each_naming_mechanism_reaches_the_instance_it_names(
        two_backends, shared_state, tmp_path, mechanism):
    """Both routes still work, and each reaches the instance it named.

    Asserted against the *other* backend as well as the named one. "It found a
    resmon" is not the property; "it found this resmon and not that one" is,
    and with one backend running the two are indistinguishable.
    """
    mine, other = two_backends
    for named, unnamed in ((mine, other), (other, mine)):
        if mechanism == "environment":
            env_extra = {"RESMON_PORT": str(named.port),
                         "RESMON_PORT_FILE": str(tmp_path / "absent.port")}
        else:
            port_file = tmp_path / f"{named.port}.port"
            port_file.write_text(str(named.port), encoding="utf-8")
            env_extra = {"RESMON_PORT_FILE": str(port_file)}

        responses, stdout, stderr = _run_mcp(shared_state, env_extra, [("health", {})])
        body = _payload(responses[1])
        assert body.get("error") is None, body
        assert body["pid"] == named.proc.pid
        assert body["pid"] != unnamed.proc.pid
        assert body["identity"]["runtime_id"] != _identity_of(unnamed)
        for backend in (mine, other):
            assert backend.token not in stdout and backend.token not in stderr


def _identity_of(backend: Backend) -> str:
    """The runtime id of a backend, read from the backend itself."""
    with backend.client() as c:
        return c.get("/api/health").json()["identity"]["runtime_id"]


# ---------------------------------------------------------------------------
# The case that was a silent fallback and is now a refusal
# ---------------------------------------------------------------------------

def test_with_neither_mechanism_naming_a_port_the_harness_is_refused(
        two_backends, shared_state, tmp_path):
    """Two resmons are listening and the harness attaches to neither.

    The register's external-harness row states the invariant the old code broke
    -- a wrong or absent app is a refusal, never a silent fallback -- and this
    is that row's third clause at the socket. Both backends' access logs are
    read before and after: a request served by either one would appear there,
    so this does not take the refusal's own word for it.
    """
    mine, other = two_backends
    before = {b.port: b.log.read_text() for b in (mine, other)}

    responses, stdout, stderr = _run_mcp(
        shared_state,
        {"RESMON_PORT_FILE": str(tmp_path / "absent.port")},
        [("health", {}), ("search_corpus", {"query": "x"})],
    )

    for response in responses[1:]:
        body = _payload(response)
        assert body["error"] == "backend_unavailable"
        assert body["detail"]["tried"] == []
        assert body["detail"]["no_port_named"] is True

    for backend in (mine, other):
        after = backend.log.read_text()
        assert after == before[backend.port], (
            "the harness reached a backend although nothing named one:\n"
            + after[len(before[backend.port]):]
        )
        assert backend.token not in stdout and backend.token not in stderr

    # The log check above means nothing unless a request that *was* served
    # shows up in the same file. One deliberate call to each, and both must.
    for backend in (mine, other):
        with backend.client() as c:
            assert c.get("/api/health").status_code == 200
        assert len(backend.log.read_text()) > len(before[backend.port]), (
            "this backend's access log does not record served requests, so the "
            "assertion above could not have failed"
        )


def test_the_refusal_tells_the_operator_what_to_do(two_backends, shared_state, tmp_path):
    """An unexplained failure is only a little better than a wrong answer.

    So the message is a tested surface, not a string the code happens to carry.
    """
    absent = tmp_path / "absent.port"
    responses, _stdout, _stderr = _run_mcp(
        shared_state, {"RESMON_PORT_FILE": str(absent)}, [("health", {})])
    message = _payload(responses[1])["message"]

    assert "RESMON_PORT" in message
    assert "port file" in message and str(absent) in message
    assert "did not guess" in message
    assert "Start resmon" in message
    # It chose no instance, so it names no address and claims nothing about
    # whether resmon is running.
    assert "127.0.0.1" not in message
    assert "not running" not in message
