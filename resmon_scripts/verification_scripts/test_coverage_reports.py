"""Coverage crosses real SQLite, backend HTTP, read adapter and ZIP boundaries.

The seeded histories are authored, not claimed provider searches. Actual source
transport is exercised separately in coverage-reports.spec.ts.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
import zipfile
from datetime import datetime
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # safe when run as a script
from implementation_scripts import api_auth as _api_auth  # noqa: E402

# 2.2: every request to a resmon backend carries its local API token. The
# backends this file starts are handed the suite's token in RESMON_API_TOKEN,
# exactly as Electron hands its own over, and test-side calls go through this
# shim. The code under test builds its own headers; nothing here adds any.
_TOKEN = _api_auth.current_token()


class _WithToken:
    """httpx's module-level ``get``/``post``/``stream``/…, plus the token header.

    A shim over the functions rather than a shared ``httpx.Client``: each call
    keeps its own throwaway client, so a stream a test abandons is closed exactly
    as before — a pooled connection outlived one and hid a disconnect.
    """

    def __getattr__(self, name):
        function = getattr(httpx, name)

        def call(*args, **kwargs):
            auth = _api_auth.bearer(_TOKEN) if _TOKEN else {}
            kwargs["headers"] = {**auth, **dict(kwargs.get("headers") or {})}
            return function(*args, **kwargs)
        return call


_API = _WithToken()
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "resmon_scripts"))
import mcp_server as mcp
from implementation_scripts import database as db, reading_queue, search_record
from test_reading_export_continuity import seed as seed_corpus, snapshot as corpus_snapshot


def snapshot(path: Path) -> dict:
    result = corpus_snapshot(path)
    with sqlite3.connect(path) as conn:
        result["reading_queue"] = conn.execute("SELECT * FROM reading_queue ORDER BY document_id").fetchall()
        result["schema"] = conn.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").fetchall()
    return result


HISTORIES = [
    ("mixed", {"repositories": ["positive", "empty", "503", "parse", "old", "missing"]},
     [("positive", 3, None), ("empty", 0, "answered_empty"), ("503", 0, "upstream_failure"), ("parse", 0, "parse_failure"), ("old", 0, None)]),
    ("no-history", {}, []),
    ("extra", {"repositories": ["a", "a", "A", "missing"]}, [("a", 0, "answered_empty"), ("extra", 0, "upstream_failure")]),
    ("conflict", {"repositories": ["a"], "repository": "b"}, [("a", 0, "answered_empty")]),
    ("rights", {"repositories": ["rights", "unusable"], "max_results": 1}, [("rights", 0, "rights_filtered"), ("unusable", 0, "records_unusable")]),
    ("malformed", {"repositories": ["a", None]}, [("a", 0, "future_reason")]),
    ("hostile", {"repository": "a", "keywords": ["<script>bad()</script>|\n# forged"]}, [("a", 0, "retired")]),
    ("empty-selection", {"repositories": []}, []),
    ("singular", {"repository": "a"}, [("a", 0, "answered_empty")]),
    ("partial", {"repository": "arxiv"}, [("arxiv", 2, "upstream_failure")]),
]

PARTIAL_SENTENCE = (
    "arXiv returned 2 usable records before a later HTTP 503 request failed. "
    "The retained set may be incomplete."
)


def seed(path: Path) -> dict:
    fixture = seed_corpus(path)
    reports = path.parent / "reports"
    reports.mkdir(exist_ok=True)
    fixture["coverage_ids"] = {}
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    reading_queue.save(conn, fixture["document_ids"][0])
    reading_queue.set_status(conn, fixture["document_ids"][0], "read")
    conn.execute("INSERT OR REPLACE INTO document_authors (document_id,author,orcid,affiliation,source_author_id) VALUES (?,?,?,?,?)",
                 (fixture["document_ids"][0], "Ada Fixture", "authored-orcid", "Authored institution", "arxiv:authored-author"))
    for name, params, sources in HISTORIES:
        params = {"query": "authored coverage", "max_results": 3, **params}
        eid = db.insert_execution(conn, {"execution_type": "deep_sweep", "status": "completed",
            "start_time": "2026-09-01T12:00:00Z", "parameters": json.dumps(params)})
        for source, count, reason in sources:
            detail = {"attempts": 1, "status": 503} if source == "503" else {}
            if name == "partial":
                detail = {
                    "attempts": 2, "detail": "http_503", "status": 503,
                    "partial": True, "returned": 2, "message": PARTIAL_SENTENCE,
                }
            if name == "hostile":
                detail = {"detail": "<img src=x onerror=bad()>|\n# forged [link](javascript:bad)"}
            db.record_execution_source(conn, eid, source, "ok", result_count=count,
                zero_reason=reason, zero_detail=json.dumps(detail))
        report, log = reports / f"original-{eid}.md", reports / f"original-{eid}.log"
        report.write_bytes(f"# Historical report {eid}\nPreserved bytes.\n".encode())
        log.write_bytes(f"Original log {eid}\r\n".encode())
        progress = None
        if name == "partial":
            progress = json.dumps([{
                "type": "repo_done", "repository": "arxiv", "index": 1,
                "total_repos": 1, "result_count": 2,
                "zero_reason": "upstream_failure", "zero_detail": detail,
                "zero_message": PARTIAL_SENTENCE,
                "timestamp": "2026-09-01T12:00:01Z",
            }])
        conn.execute(
            "UPDATE executions SET result_path=?,log_path=?,dedup_new=0,"
            "result_count=?,progress_events=COALESCE(?,progress_events) WHERE id=?",
            (str(report), str(log), sum(s[1] for s in sources), progress, eid),
        )
        fixture["coverage_ids"][name] = eid
    fixture["partial_sentence"] = PARTIAL_SENTENCE
    conn.commit()
    conn.close()
    return fixture


@pytest.fixture(scope="module")
def boundary(tmp_path_factory):
    state = tmp_path_factory.mktemp("coverage-reports")
    path = state / "corpus.db"
    fixture = seed(path)
    before = snapshot(path)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 8742
    env = {**os.environ, **({"RESMON_API_TOKEN": _TOKEN} if _TOKEN else {}), "RESMON_STATE_DIR": str(state), "RESMON_DB_PATH": str(path),
           "RESMON_REPORTS_DIR": str(state / "reports"), "RESMON_PORT_FILE": str(state / "backend.port"),
           "RESMON_CHROMIUM_PROFILE": str(state / "chromium"), "RESMON_DISABLE_SCHEDULER": "1",
           "PYTHONDONTWRITEBYTECODE": "1", "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring"}
    with (state / "backend.log").open("w") as log:
        requested = time.time()
        proc = subprocess.Popen([sys.executable, str(ROOT / "resmon_scripts/resmon.py"), str(port)],
                                cwd=state, env=env, stdout=log, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{port}"
        try:
            for _ in range(150):
                assert proc.poll() is None, (state / "backend.log").read_text()
                try:
                    response = _API.get(base + "/api/health", timeout=1)
                    response.raise_for_status()
                    health = response.json()
                    break
                except (httpx.HTTPError, ValueError):
                    time.sleep(0.2)
            else:
                pytest.fail("isolated backend did not start")
            assert health["pid"] == proc.pid
            started = datetime.fromisoformat(health["started_at"].replace("Z", "+00:00")).timestamp()
            assert requested - 2 <= started <= time.time()
            assert (state / "backend.port").read_text().strip() == str(port)
            # Match a live HTTP response to the synthetic data in the pinned DB.
            raw = _API.get(f"{base}/api/executions/{fixture['execution_ids'][0]}/references",
                            params={"format": "json"}).json()
            assert fixture["marker"] in {d["external_id"] for d in raw}
            from test_mcp_settings_boundary import _source_receipt
            receipt = {"base": base, "state": str(state), "database": str(path), "health": health,
                       "owned_pid": proc.pid, "launch_requested_at": requested, "fixture": fixture,
                       "source": _source_receipt(ROOT)}
            print("INSTANCE", json.dumps(receipt))
            yield base, path, fixture
            assert snapshot(path) == before, "reads/exports changed corpus or execution provenance"
            print("PRESERVATION", json.dumps({"tables": list(before), "unchanged": True}))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
            print("COVERAGE_SHUTDOWN", json.dumps({"pid": proc.pid, "exit_code": proc.returncode}))


def test_history_account_arrives_in_http_markdown_list_and_detail(boundary):
    base, path, fixture = boundary
    listed = {r["id"]: r for r in _API.get(base + "/api/executions").json()}
    for name, eid in fixture["coverage_ids"].items():
        response = _API.get(f"{base}/api/executions/{eid}/search-record")
        assert response.status_code == 200, response.text
        record = response.json()
        c = record["coverage"]
        with sqlite3.connect(path) as conn:
            conn.row_factory = sqlite3.Row
            expected = search_record.build(conn, eid)
        assert c == expected["coverage"]
        assert c == listed[eid]["coverage"]
        assert c == _API.get(f"{base}/api/executions/{eid}").json()["coverage"]
        md = _API.get(f"{base}/api/executions/{eid}/search-record?format=markdown").text
        assert f"resmon execution id | {eid}" in md
        assert "Source coverage" in md
        if name == "mixed":
            assert c["counts"] == {"answered": 2, "non_answer": 2, "unknown": 2, "genuine_empty": 1, "partial": 0}
            assert [r["source"] for r in c["sources"]] == ["positive", "empty", "503", "parse", "old", "missing"]
            assert "Recorded at" in md and "Outcome not recorded" in md
        if name == "malformed":
            assert c["counts"]["unknown"] == 1
            assert "0 of 1 recorded sources answered" in md
            assert "unknown / unsupported recorded outcome" in md
        if name == "hostile":
            assert "<img" not in md
            assert "\\|" in md and "&lt;img" in md
        if name == "partial":
            assert c["counts"] == {"answered": 1, "non_answer": 0, "unknown": 0, "genuine_empty": 0, "partial": 1}
            assert c["sources"][0]["note"] == PARTIAL_SENTENCE
            assert search_record._text(PARTIAL_SENTENCE) in md
        print("COVERAGE_HISTORY", json.dumps({"name": name, "coverage": c}))
    assert _API.get(f"{base}/api/executions/999999/search-record").status_code == 404


def test_explicit_multi_run_zip_matches_saved_facts_and_original_bytes(boundary):
    base, path, fixture = boundary
    ids = [fixture["coverage_ids"][name] for name in ("mixed", "no-history")]
    response = _API.post(base + "/api/executions/export", json={"ids": ids})
    assert response.status_code == 200, response.text
    assert response.json()["count"] == 2
    receipts = []
    with zipfile.ZipFile(response.json()["path"]) as bundle, sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        manifest = json.loads(bundle.read("manifest.json"))
        for eid in ids:
            prefix = f"execution_{eid}/"
            record = json.loads(bundle.read(prefix + "search-record.json"))
            expected = search_record.build(conn, eid)
            assert record["search"]["execution_id"] == eid
            assert record["coverage"] == expected["coverage"]
            assert bundle.read(prefix + "search-record.md").decode() == search_record.to_markdown(record)
            row = conn.execute("SELECT * FROM executions WHERE id=?", (eid,)).fetchone()
            for field in ("result_path", "log_path"):
                original = Path(row[field])
                assert bundle.read(prefix + original.name) == original.read_bytes()
                receipts.append({"id":eid,"member":prefix+original.name,"sha256":hashlib.sha256(original.read_bytes()).hexdigest()})
            entry = next(e for e in manifest if e["id"] == eid)
            assert entry["search_record"]["generated_at"] == record["generated_at"]
        print("COVERAGE_ZIP", json.dumps({"members":bundle.namelist(),"originals":receipts}))


def test_actual_read_adapter_returns_same_coverage(boundary):
    base, path, fixture = boundary
    prior = mcp.backend._base
    try:
        mcp.backend.pin(base, _TOKEN)
        for eid in fixture["coverage_ids"].values():
            result = mcp.t_get_search_record({"exec_id": eid})
            assert result["coverage"] == _API.get(f"{base}/api/executions/{eid}/search-record").json()["coverage"]
        print("COVERAGE_MCP", json.dumps({"exercised":["get_search_record"],"declared_tools":len(mcp.TOOLS),"runs":len(fixture["coverage_ids"])}))
    finally:
        mcp.backend._base = prior


def test_optional_companion_failure_and_default_caller_are_honest(tmp_path, monkeypatch):
    import resmon
    path = tmp_path / "db.sqlite"
    fixture = seed(path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    eid = fixture["coverage_ids"]["mixed"]
    row = dict(conn.execute("SELECT * FROM executions WHERE id=?", (eid,)).fetchone())
    legacy = tmp_path / "legacy.zip"
    resmon._build_execution_zip([row], legacy)
    with zipfile.ZipFile(legacy) as bundle:
        assert not any("search-record" in n for n in bundle.namelist())
        assert "search_record" not in json.loads(bundle.read("manifest.json"))[0]
    record = search_record.build(conn, eid)
    collision = tmp_path / "search-record.json"
    collision.write_text("original collision bytes")
    with pytest.raises(ValueError, match="conflicts"):
        resmon._build_execution_zip([{**row,"result_path":str(collision)}], tmp_path / "bad.zip", companions={eid:record})
    assert collision.read_text() == "original collision bytes"
    monkeypatch.setattr(resmon, "_get_db", lambda: conn)
    monkeypatch.setattr(resmon, "_close_db", lambda _: None)
    def fail(*args, **kwargs):
        raise RuntimeError("authored companion failure")
    monkeypatch.setattr(search_record, "build", fail)
    with pytest.raises(RuntimeError, match="companion failure"):
        resmon.export_executions(resmon.ExecutionExport(ids=[eid]))
    conn.close()


if __name__ == "__main__":
    mode, path = sys.argv[1], Path(sys.argv[2])
    print(json.dumps(seed(path) if mode == "seed" else snapshot(path)))
