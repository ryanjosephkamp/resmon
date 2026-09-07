"""Trust P1: real MCP function -> real HTTP -> subprocess backend -> SQLite.

No providers or credentials. GET response types and the backend group manifest
supply the denominator; no fake HTTP handler normalizes away the defect.
"""
from __future__ import annotations

import json
from datetime import datetime
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time

import httpx
import pytest

import mcp_server as mcp
import resmon

pytestmark = pytest.mark.live_network
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def isolated_backend(tmp_path_factory):
    state = tmp_path_factory.mktemp("trust-settings")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 8742
    env = {**os.environ, "RESMON_STATE_DIR": str(state),
           "RESMON_DB_PATH": str(state / "corpus.db"),
           "RESMON_REPORTS_DIR": str(state / "reports"),
           "RESMON_PORT_FILE": str(state / "backend.port"),
           "RESMON_CHROMIUM_PROFILE": str(state / "chromium"),
           "RESMON_DISABLE_SCHEDULER": "1", "PYTHONDONTWRITEBYTECODE": "1",
           "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring"}
    with (state / "backend.log").open("w") as log:
        started = time.time()
        proc = subprocess.Popen([sys.executable, str(ROOT / "resmon_scripts/resmon.py"), str(port)],
                                cwd=state, env=env, stdout=log, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{port}"
        try:
            for _ in range(150):
                assert proc.poll() is None, (state / "backend.log").read_text()
                try:
                    health = httpx.get(base + "/api/health", timeout=1).json()
                    break
                except (httpx.HTTPError, ValueError):
                    time.sleep(0.2)
            else:
                pytest.fail("isolated backend did not start")
            assert health["pid"] == proc.pid
            backend_started = datetime.fromisoformat(health["started_at"].replace("Z", "+00:00")).timestamp()
            assert started - 2 <= backend_started <= time.time()
            assert (state / "backend.port").read_text().strip() == str(port)
            marker = httpx.post(base + "/api/profiles", json={"display_name": "Trust synthetic marker"}).json()
            with sqlite3.connect(state / "corpus.db") as conn:
                assert conn.execute("SELECT display_name FROM watch_profiles WHERE id=?", (marker["id"],)).fetchone()[0] == "Trust synthetic marker"
            print("INSTANCE", json.dumps({"port": port, "pid": proc.pid, "launch_requested_at": started, "health_started_at": health["started_at"], "health_pid": health["pid"],
                  "state": str(state), "version": health.get("version"), "corpus_marker": marker["id"],
                  "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()}))
            old_base = mcp.backend._base
            mcp.backend._base = base
            yield base, state
            mcp.backend._base = old_base
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)


def _settings(base: str, group: str) -> dict:
    response = httpx.get(f"{base}/api/settings/{group}", timeout=10)
    response.raise_for_status()
    body = response.json()
    return body["settings"] if group == "embeddings" else body


def _stored(state: Path) -> dict:
    with sqlite3.connect(state / "corpus.db") as conn:
        return dict(conn.execute("SELECT key,value FROM app_settings"))


def test_boolean_effects_cross_the_real_mcp_http_and_storage_boundary(isolated_backend, monkeypatch):
    base, state = isolated_backend
    groups = {group: _settings(base, group) for group in mcp.SETTINGS_GROUPS}
    for group, values in groups.items():
        assert set(values) == set(resmon._SETTINGS_GROUPS[group])
    fields = [(group, key) for group, values in groups.items()
              for key, value in values.items() if isinstance(value, bool)]
    assert fields, "no boolean-valued GET field was found"
    # These three are string-valued GET fields but boolean flags at their readers.
    string_flags = [("ai", "ai_show_audit_prefix"), ("cloud", "cloud_auto_backup"),
                    ("embeddings", "embedding_enabled")]
    requests = []
    real_request = httpx.request

    def observe(method, url, **kwargs):
        if method == "PUT":
            requests.append(kwargs["json"])
        return real_request(method, url, **kwargs)

    monkeypatch.setattr(mcp.httpx, "request", observe)
    for group, key in fields + string_flags:
        inputs = [("false", False), ("true", True), ("false", False)]
        if (group, key) in fields:
            inputs += [(True, True), (False, False)]
        for value, target in inputs:
            before = _settings(base, group)
            stored_before = _stored(state)
            result = mcp.call_tool("update_settings", {"group": group, "settings": {key: value}})
            assert not result["isError"], result
            result = json.loads(result["content"][0]["text"])
            after = _settings(base, group)
            stored = _stored(state)
            expected = target if (group, key) in fields else value
            assert requests[-1] == {"settings": {key: expected}}
            assert after[key] == expected
            assert stored[key] == (("1" if target else "0") if (group, key) in fields else value)
            assert {k:v for k,v in stored.items() if k != key} == {k:v for k,v in stored_before.items() if k != key}
            expected_diff = {} if before[key] == expected else {key: {"from": before[key], "to": expected}}
            assert result["changed"] == expected_diff
            print("EFFECT", json.dumps({"group": group, "key": key, "before": before[key],
                  "request": requests[-1], "stored": stored[key], "after": after[key], "diff": result["changed"]}))
    print("DENOMINATOR", json.dumps({"groups": len(groups), "tools": len(mcp.TOOLS),
          "boolean_GET_fields": fields, "string_flags": string_flags}))


def test_real_refusals_leave_settings_unchanged(isolated_backend):
    base, state = isolated_backend
    cases = [("unknown", {"notify_manual": "false"}),
             ("notifications", {"unknown": "false"}),
             ("notifications", {"notify_manual": "false", "api_token": "synthetic"}),
             ("notifications", {"notify_manual": "maybe"}),
             ("embeddings", {"capability": "synthetic"})]
    for group, settings in cases:
        before = _stored(state)
        result = mcp.call_tool("update_settings", {"group": group, "settings": settings})
        assert result["isError"], result
        assert _stored(state) == before


def test_each_allowed_group_reports_actual_before_after(isolated_backend):
    base, state = isolated_backend
    for group in mcp.SETTINGS_GROUPS:
        before = _settings(base, group)
        # No-op writes still cross the real boundary; separate boolean tests
        # establish both directions, and embeddings must use a real stored key.
        key = sorted(before)[0]
        value = before[key]
        value = str(value).lower() if isinstance(value, bool) else value
        stored_before = _stored(state)
        result = mcp.call_tool("update_settings", {"group": group, "settings": {key: value}})
        assert not result["isError"], result
        assert _settings(base, group) == before
        body = json.loads(result["content"][0]["text"])
        assert body["changed"] == {}
        stored_after = _stored(state)
        assert {k:v for k,v in stored_after.items() if k != key} == {k:v for k,v in stored_before.items() if k != key}
        print("GROUP", group, key, "unchanged", body["unchanged_key_count"])
