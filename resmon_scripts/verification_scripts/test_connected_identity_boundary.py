"""Real serving processes, HTTP and MCP stdio; all data is authored synthetic data."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
from uuid import uuid4
import httpx
import pytest
from test_coverage_reports import seed

ROOT = Path(__file__).resolve().parents[2]


def snapshot(path: Path) -> dict:
    with sqlite3.connect(path) as conn:
        tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        # Include virtual tables AND their shadow tables. Sort serialized rows;
        # no physical page/hash claim is made for SQLite journaling.
        return {table: sorted([[{"bytes_hex": value.hex()} if isinstance(value, bytes) else value for value in row] for row in conn.execute('SELECT * FROM "' + table.replace('"', '""') + '"')], key=repr)
                for table in tables}


@contextmanager
def serving(state: Path, port: int = 0):
    state.mkdir(parents=True, exist_ok=True)
    path = state / "corpus.db"
    fixture = seed(path) if not path.exists() else None
    if not port:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
    assert port != 8742
    env = {**os.environ, "RESMON_STATE_DIR": str(state), "RESMON_DB_PATH": str(path),
        "RESMON_REPORTS_DIR": str(state / "reports"), "RESMON_PORT_FILE": str(state / "backend.port"),
        "RESMON_CHROMIUM_PROFILE": str(state / "chromium"), "RESMON_DISABLE_SCHEDULER": "1",
        "RESMON_PORT": str(port), "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
        "PYTHONDONTWRITEBYTECODE": "1"}
    log_path = state / f"backend-{time.time_ns()}.log"
    with log_path.open("w") as log:
        started = time.time()
        proc = subprocess.Popen([sys.executable, str(ROOT / "resmon_scripts/resmon.py"), str(port)],
                                cwd=state, env=env, stdout=log, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{port}"
        try:
            for _ in range(150):
                assert proc.poll() is None, log_path.read_text()
                try:
                    response = httpx.get(base + "/api/health", timeout=1)
                    response.raise_for_status()
                    health = response.json()
                    break
                except httpx.HTTPError:
                    time.sleep(.2)
            else:
                pytest.fail("owned backend startup timed out")
            assert health["pid"] == proc.pid
            assert started - 2 <= datetime.fromisoformat(health["started_at"]).timestamp() <= time.time()
            assert (state / "backend.port").read_text().strip() == str(port)
            before = snapshot(path)
            receipt = {"pid": proc.pid, "port": port, "state": str(state), "health": health,
                       "source": str(ROOT), "database": str(path), "fixture": fixture, "tables": list(before)}
            print("IDENTITY_INSTANCE", json.dumps(receipt), flush=True)
            yield base, health, env, fixture
            assert snapshot(path) == before
            print("IDENTITY_PRESERVED", json.dumps({"tables": list(before), "count": len(before)}), flush=True)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill(); proc.wait(timeout=10)
            print("IDENTITY_SHUTDOWN", json.dumps({"pid": proc.pid, "exit_code": proc.returncode, "port": port}), flush=True)


def stdio(env: dict, calls: list[dict]) -> list[dict]:
    messages = [{"jsonrpc": "2.0", "id": i + 1, **call} for i, call in enumerate(calls)]
    result = subprocess.run([sys.executable, str(ROOT / "resmon_scripts/mcp_server.py")],
        input="".join(json.dumps(m) + "\n" for m in messages), text=True, capture_output=True,
        cwd=env["RESMON_STATE_DIR"], env=env, timeout=30)
    assert result.returncode == 0, result.stderr
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(replies) == len(messages)
    print("IDENTITY_MCP_STDIO", json.dumps({"requests": messages, "responses": replies}), flush=True)
    return replies


def tool(name: str, **args) -> dict:
    return {"method": "tools/call", "params": {"name": name, "arguments": args}}


def payload(reply: dict) -> dict:
    return json.loads(reply["result"]["content"][0]["text"])


def test_two_actual_processes_http_stdio_and_same_state_restart(tmp_path):
    with serving(tmp_path / "A") as (a, ha, env, fixture), serving(tmp_path / "B") as (b, hb, _, fb):
        aid, bid = ha["identity"]["runtime_id"], hb["identity"]["runtime_id"]
        eid = fixture["execution_ids"][0]
        assert eid == fb["execution_ids"][0] and aid != bid
        assert ha["version"] == hb["version"]
        with ThreadPoolExecutor(max_workers=8) as pool:
            identities = list(pool.map(lambda _: httpx.get(a + "/api/health").json()["identity"], range(16)))
        assert all(identity == ha["identity"] for identity in identities)
        assert ha["identity"]["schema_version"] == 14
        assert ha["identity"]["corpus_id"] is None and ha["identity"]["build_id"] is None
        for route in ("/api/health", f"/api/executions/{eid}"):
            matched = httpx.get(a + route, params={"expected_runtime_id": aid})
            assert matched.status_code == 200 and matched.json()["identity"] == ha["identity"]
            wrong = httpx.get(a + route, params={"expected_runtime_id": bid})
            assert wrong.status_code == 409 and wrong.json()["detail"]["code"] == "instance_mismatch"
            assert set(wrong.json()) == {"detail"}
            for malformed in ("", "bad", aid.upper()):
                assert httpx.get(a + route, params={"expected_runtime_id": malformed}).status_code == 422
        assert httpx.get(a + "/api/executions/999999", params={"expected_runtime_id": bid}).status_code == 409
        assert httpx.get(a + "/api/executions/999999", params={"expected_runtime_id": aid}).status_code == 404
        replies = stdio(env, [{"method": "initialize"}, {"method": "tools/list"},
            tool("health"), tool("health", expected_runtime_id=aid),
            tool("get_execution", exec_id=eid, expected_runtime_id=aid),
            tool("get_execution", exec_id=eid, expected_runtime_id=bid),
            tool("health", expected_runtime_id="bad"),
            tool("get_execution", exec_id=999999, expected_runtime_id=aid)])
        tools = replies[1]["result"]["tools"]
        assert len(tools) == 25
        assert {t["name"] for t in tools if "expected_runtime_id" in t["inputSchema"]["properties"]} == {"health", "get_execution"}
        assert payload(replies[3])["identity"]["runtime_id"] == aid
        assert payload(replies[4])["id"] == eid
        assert [payload(x)["error"] for x in replies[5:]] == ["instance_mismatch", "invalid_argument", "not_found"]
        port = int(env["RESMON_PORT"])
    with serving(tmp_path / "A", port) as (a, restarted, _, _):
        assert restarted["identity"]["runtime_id"] not in (aid, bid)
        assert httpx.get(a + "/api/executions/1", params={"expected_runtime_id": aid}).status_code == 409
        print("IDENTITY_RESTART", json.dumps({"before": ha, "after": restarted, "same_state": True, "same_port": port}), flush=True)


if __name__ == "__main__":
    mode, target = sys.argv[1:3]
    print(json.dumps(seed(Path(target)) if mode == "seed" else snapshot(Path(target))))
