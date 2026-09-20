"""P1 at its own boundary: two real backends, one corpus, one SIGKILL.

Everything in `test_executions_interrupted.py` runs inside this interpreter.
That establishes what `_reconcile_executions_on_startup` does when it is handed
a dead pid, and nothing about what a real killed backend actually leaves behind:
whether `status='running'` is what survives on disk, whether `_lifespan` runs
the hook at all before the scheduler, whether the second process can read the
adopted row back over HTTP with its token. Those are the claims a user's
force-quit depends on and they are only observable out of process.

So: a real `resmon.py` on an ephemeral port in an isolated state directory,
running a real sweep, killed with SIGKILL mid-run, and a second real
`resmon.py` started over the same database. Port 8742 and the daemon's state
directory belong to the maintainer's live corpus and are never touched.

**The one thing that is not real is the upstream.** A launcher module in the
temp directory replaces the arXiv client's `search` with a sleep before it
starts uvicorn -- in the subprocess, so no socket is opened and nothing leaves
the machine. The slug, the catalog entry, the admission controller, the
execution row, the worker thread, the stage writes and the heartbeat are all
the shipped code. This is the `provider_server.py` arrangement: real transport,
scripted upstream, and the ledger row says which is which.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sqlite3
import sys
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "resmon_scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import api_auth as _api_auth  # noqa: E402

_TOKEN = _api_auth.current_token()
# The backend builds its own headers; the shape is `api_auth.bearer`.
_HEADERS = _api_auth.bearer(_TOKEN) if _TOKEN else {}


# The launcher the backend processes actually run. `search` sleeps rather than
# reaching arXiv: the sweep has to still be in flight when SIGKILL arrives, and
# a test must never touch a real source.
_LAUNCHER = '''
import sys, time
sys.path.insert(0, {scripts!r})
from implementation_scripts import api_arxiv

def _slow_search(self, *args, **kwargs):
    # Long enough that the kill always lands mid-run; the process is killed,
    # never joined, so nothing waits on this.
    time.sleep(600)
    return []

api_arxiv.ArxivClient.search = _slow_search

import resmon
resmon.main()
'''


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 8742, "8742 is the maintainer's live daemon"
    return port


def _env(state: Path, db: Path) -> dict:
    return {
        **os.environ,
        **({"RESMON_API_TOKEN": _TOKEN} if _TOKEN else {}),
        "RESMON_STATE_DIR": str(state),
        "RESMON_DB_PATH": str(db),
        "RESMON_REPORTS_DIR": str(state / "reports"),
        "RESMON_PORT_FILE": str(state / "backend.port"),
        "RESMON_CHROMIUM_PROFILE": str(state / "chromium"),
        "RESMON_DISABLE_SCHEDULER": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
    }


class Backend:
    """One real `resmon.py`, started and waited for on its own port."""

    def __init__(self, state: Path, db: Path, tag: str) -> None:
        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.log_path = state / f"{tag}.log"
        launcher = state / f"{tag}_launch.py"
        launcher.write_text(_LAUNCHER.format(scripts=str(ROOT / "resmon_scripts")))
        self._log = self.log_path.open("w")
        self.proc = subprocess.Popen(
            [sys.executable, str(launcher), str(self.port)],
            cwd=state, env=_env(state, db), stdout=self._log,
            stderr=subprocess.STDOUT)

    def wait_until_serving(self, seconds: float = 40.0) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                pytest.fail(f"backend exited early:\n{self.log_path.read_text()}")
            try:
                httpx.get(self.base + "/api/health", headers=_HEADERS,
                          timeout=2).raise_for_status()
                return
            except (httpx.HTTPError, ValueError):
                time.sleep(0.2)
        pytest.fail(f"backend never served:\n{self.log_path.read_text()}")

    def get(self, path: str) -> httpx.Response:
        return httpx.get(self.base + path, headers=_HEADERS, timeout=15)

    def post(self, path: str, json_body: dict | None = None) -> httpx.Response:
        return httpx.post(self.base + path, headers=_HEADERS,
                          json=json_body or {}, timeout=15)

    def sigkill(self) -> None:
        """No handler runs, no `finally`, no graceful flush. A force-quit."""
        os.kill(self.proc.pid, signal.SIGKILL)
        self.proc.wait(timeout=20)

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        self._log.close()


def _start_sweep(backend: Backend) -> int:
    resp = backend.post("/api/search/sweep", {
        "query": "diffusion", "keywords": ["diffusion"],
        "repositories": ["arxiv"], "max_results": 5, "ai_enabled": False})
    assert resp.status_code == 200, resp.text
    return int(resp.json()["execution_id"])


def _wait_for_running(db: Path, exec_id: int, seconds: float = 30.0) -> dict:
    """Read the row straight off disk until the worker has claimed it.

    Read-only, on its own connection, while the backend that owns the file is
    still writing to it -- which is what WAL is for and what the second backend
    will be doing for real in a moment.
    """
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute("SELECT * FROM executions WHERE id = ?",
                               (exec_id,)).fetchone()
            if row and row["status"] == "running" and row["owner_pid"]:
                return dict(row)
        except sqlite3.Error:
            pass
        finally:
            conn.close()
        time.sleep(0.1)
    pytest.fail(f"execution {exec_id} never reached a claimed running state")


def test_a_sigkilled_backend_leaves_a_running_row_the_next_start_adopts(tmp_path):
    """The journey a force-quit is: kill mid-sweep, reopen, read the truth.

    Three claims in one, because they are only true together: the killed
    backend leaves `running` (not `failed`, not a flushed row -- no handler
    ran); the next start adopts it as `interrupted / owner_dead` with an end
    time; and the adopted row is readable over HTTP by the process that adopted
    it, through the same endpoint the renderer uses.
    """
    state = tmp_path / "state"
    state.mkdir()
    db = state / "corpus.db"

    first = Backend(state, db, "first")
    try:
        first.wait_until_serving()
        exec_id = _start_sweep(first)
        claimed = _wait_for_running(db, exec_id)
        assert claimed["owner_pid"] == first.proc.pid, (
            "the row records the pid of the process that is running it")
        assert claimed["owner_runtime_id"]
        first.sigkill()
    finally:
        first.stop()

    # Nothing graceful ran. This is the state a user's force-quit leaves.
    after_kill = sqlite3.connect(db)
    after_kill.row_factory = sqlite3.Row
    try:
        row = dict(after_kill.execute(
            "SELECT * FROM executions WHERE id = ?", (exec_id,)).fetchone())
    finally:
        after_kill.close()
    assert row["status"] == "running", (
        "a SIGKILLed backend is supposed to leave the row exactly as the "
        "worker last wrote it; if this is 'failed' something ran that should "
        "not have")
    assert row["end_time"] is None
    assert row["interrupted_reason"] is None

    second = Backend(state, db, "second")
    try:
        second.wait_until_serving()
        served = second.get(f"/api/executions/{exec_id}")
        assert served.status_code == 200, served.text
        body = served.json()
        assert body["status"] == "interrupted", body
        assert body["interrupted_reason"] == "owner_dead", body
        assert body["end_time"], "an interrupted run ended; say when"
        assert body["progress_events"] in (None, "", []), (
            "nothing was resumed, so nothing may be claimed to have been seen")
        assert body["restarted_into"] == []
        # And it is honestly uncancellable now, in a sentence.
        cancel = second.post(f"/api/executions/{exec_id}/cancel")
        assert cancel.status_code == 409
        assert "interrupted" in cancel.json()["detail"]
        # From here the user's way forward is Restart.
        restart = second.post(f"/api/executions/{exec_id}/restart")
        assert restart.status_code == 202, restart.text
        assert restart.json()["restarted_from"] == exec_id
    finally:
        second.stop()


def test_a_second_backend_leaves_a_row_whose_owner_is_still_alive_alone(tmp_path):
    """The companion, and the one that matters more.

    Adopting too eagerly is the worse failure: it tells the user a run that is
    still working has died, and the Restart button then starts a duplicate
    beside it. Two backends over one corpus is not a supported configuration,
    but it is reachable -- the daemon plus an Electron-spawned fallback -- and
    the conservative rule has to hold there.
    """
    state = tmp_path / "state"
    state.mkdir()
    db = state / "corpus.db"

    first = Backend(state, db, "live")
    second = None
    try:
        first.wait_until_serving()
        exec_id = _start_sweep(first)
        claimed = _wait_for_running(db, exec_id)
        assert claimed["owner_pid"] == first.proc.pid

        # The first backend is still running, still holding the sweep.
        second = Backend(state, db, "beside")
        second.wait_until_serving()

        body = second.get(f"/api/executions/{exec_id}").json()
        assert body["status"] == "running", (
            "a second backend relabelled a run whose owner is alive -- that is "
            "the overclaim this rule exists to prevent")
        assert body["interrupted_reason"] is None
        assert body["end_time"] is None
        assert first.proc.poll() is None, "the first backend died on its own"
    finally:
        if second is not None:
            second.stop()
        first.stop()


# ---------------------------------------------------------------------------
# P5 -- the MCP surface, through the real stdio server
# ---------------------------------------------------------------------------


class StdioMCP:
    """The real `mcp_server.py` as a subprocess, spoken to in JSON-RPC.

    Not `mcp.call_tool(...)` in this interpreter: that skips the process
    boundary, the backend discovery through `RESMON_STATE_DIR`, the token file
    and the JSON serialisation, and those are the four places a field quietly
    fails to arrive. The server is handed nothing but the state directory, and
    finds the backend the way a harness on a user's machine does.
    """

    def __init__(self, state: Path, db: Path) -> None:
        self.log_path = state / "mcp.log"
        self._log = self.log_path.open("w")
        self.proc = subprocess.Popen(
            [sys.executable, str(ROOT / "resmon_scripts/mcp_server.py")],
            cwd=state, env=_env(state, db), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self._log, text=True, bufsize=1)
        self._next_id = 0

    def rpc(self, method: str, params: dict | None = None) -> dict:
        self._next_id += 1
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": self._next_id,
             "method": method, "params": params or {}}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        assert line, f"the MCP server said nothing:\n{self.log_path.read_text()}"
        return json.loads(line)

    def tool(self, name: str, arguments: dict) -> dict:
        answer = self.rpc("tools/call", {"name": name, "arguments": arguments})
        result = answer["result"]
        assert not result["isError"], result
        return json.loads(result["content"][0]["text"])

    def stop(self) -> None:
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=15)
        except (subprocess.TimeoutExpired, OSError):
            self.proc.kill()
            self.proc.wait(timeout=10)
        self._log.close()


def test_the_mcp_tools_report_an_interrupted_run_and_its_restart(tmp_path):
    """P5, with an interrupted row made the only honest way: by killing a backend.

    `get_execution` passes the backend row through whole, so it would be easy
    to assume the new fields arrive. `list_executions` does not -- it projects
    a fixed set of keys -- and a field left out of that projection is invisible
    to an agent reading a list of runs. Both are asserted here, through the
    same process boundary.
    """
    state = tmp_path / "state"
    state.mkdir()
    db = state / "corpus.db"

    first = Backend(state, db, "mcp-first")
    try:
        first.wait_until_serving()
        exec_id = _start_sweep(first)
        _wait_for_running(db, exec_id)
        first.sigkill()
    finally:
        first.stop()

    second = Backend(state, db, "mcp-second")
    mcp = None
    try:
        second.wait_until_serving()
        restart = second.post(f"/api/executions/{exec_id}/restart")
        assert restart.status_code == 202, restart.text
        new_id = restart.json()["execution_id"]

        mcp = StdioMCP(state, db)
        hello = mcp.rpc("initialize")
        assert hello["result"]["serverInfo"]["name"]

        one = mcp.tool("get_execution", {"exec_id": exec_id})
        assert one["status"] == "interrupted", one
        assert one["interrupted_reason"] == "owner_dead", one
        assert one["restarted_into"] == [new_id], one

        restarted = mcp.tool("get_execution", {"exec_id": new_id})
        assert restarted["restarted_from"] == exec_id, restarted

        listing = mcp.tool("list_executions", {"limit": 50})
        rows = {r["id"]: r for r in listing["executions"]}
        assert rows[exec_id]["status"] == "interrupted", rows[exec_id]
        assert rows[exec_id]["interrupted_reason"] == "owner_dead", rows[exec_id]
        assert rows[new_id]["restarted_from"] == exec_id, rows[new_id]

        # Denominator: 2 of 25 tools touched by this change, M from
        # mcp_server.TOOLS as the running server reports it.
        tools = mcp.rpc("tools/list")["result"]["tools"]
        names = {t["name"] for t in tools}
        assert {"get_execution", "list_executions"} <= names
        print(f"P5: 2 of {len(tools)} MCP tools exercised, M from the server's own "
              "tools/list")
        assert len(tools) == 25, (
            f"the tool inventory moved to {len(tools)}; this change adds none")
    finally:
        if mcp is not None:
            mcp.stop()
        second.stop()


def test_the_progress_stream_of_an_interrupted_run_closes(tmp_path):
    """R3-4 at the only boundary where its regression is legible.

    `stream_progress` sends persisted events as a batch and closes when the run
    is over, and opens a live generator that heartbeats for ever when it is
    not. An interrupted run has no live store entry and never will: the process
    that would have produced events is what went away. Before `interrupted`
    joined the terminal list, this request opened the live generator and hung.

    It has to be a real socket. Through `TestClient` the generator blocks inside
    the in-process portal before yielding anything, so the failure is a hung
    worker that no client-side timeout can reach; here it is a `ReadTimeout`.
    """
    state = tmp_path / "state"
    state.mkdir()
    db = state / "corpus.db"

    first = Backend(state, db, "stream-first")
    try:
        first.wait_until_serving()
        exec_id = _start_sweep(first)
        _wait_for_running(db, exec_id)
        first.sigkill()
    finally:
        first.stop()

    second = Backend(state, db, "stream-second")
    try:
        second.wait_until_serving()
        assert second.get(f"/api/executions/{exec_id}").json()["status"] == "interrupted"
        # Bounded by the clock, not by a read timeout: the live generator
        # heartbeats every ~300 ms, so the socket is never idle long enough for
        # one to fire and the regression is an endless *busy* stream.
        deadline, body, closed = time.monotonic() + 15, b"", False
        with httpx.stream("GET",
                          f"{second.base}/api/executions/{exec_id}/progress/stream",
                          headers=_HEADERS, timeout=20.0) as resp:
            assert resp.status_code == 200
            for chunk in resp.iter_bytes():
                body += chunk
                if time.monotonic() > deadline:
                    break
            else:
                closed = True
        assert closed, (
            "the live generator was opened for a run that is over; nothing is "
            f"left to emit a real event, so the stream never closes "
            f"({len(body)} bytes of heartbeat in 15s)")
        assert b"heartbeat" not in body
    finally:
        second.stop()
