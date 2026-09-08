"""Hermetic PR guards across real MCP -> HTTP -> backend -> SQLite.

Only synthetic pre-seeded records and loopback reads/exports. No provider/model
calls. The CLI seed/snapshot modes also support the desktop companion without
adding a production fixture endpoint. Native save dialogs are a separate check.
"""
from __future__ import annotations

from datetime import datetime
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "resmon_scripts"))
import httpx
import pytest
import mcp_server as mcp
from implementation_scripts import database as db, reference_export


def snapshot(path: Path) -> dict:
    """All stored fields in corpus/author/keyword and run/provenance tables."""
    with sqlite3.connect(path) as conn:
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
                  if r[0] == "documents" or r[0].startswith(("document_", "execution"))]
        return {table: conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
                for table in sorted(tables)}


def seed(path: Path) -> dict:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    db.init_db(conn=conn)
    docs = []
    for n, title in enumerate(("Continuity Alpha", "Continuity Beta", "Continuity Gamma"), 1):
        docs.append(db.insert_document(conn, {
            "source_repository": "arxiv", "external_id": f"synthetic-continuity-{n}",
            "title": title, "authors": "Ada Lovelace", "publication_date": "2026-09-01",
            "abstract": f"Synthetic reading/export fixture {n}; no provider request.",
            "doi": f"10.0000/synthetic-{n}" if n == 1 else None,
            "url": f"https://example.invalid/continuity/{n}", "categories": "fixture",
            "metadata_hash": f"continuity-{n}",
        }))
    runs = []
    for n, members in enumerate((docs[:2], docs[:2], docs[2:], []), 1):
        run = db.insert_execution(conn, {
            "execution_type": "deep_dive", "status": "completed",
            "start_time": f"2026-09-01T12:0{n}:00",
            "parameters": json.dumps({"keywords": ["Continuity"], "repositories": ["arxiv"]}),
        })
        for doc in members:
            db.link_execution_document(conn, run, doc, is_new=n != 2)
        db.update_execution_status(conn, run, "completed", result_count=len(members),
                                   new_result_count=len(members) if n != 2 else 0,
                                   end_time=f"2026-09-01T12:0{n}:01")
        runs.append(run)
    conn.close()
    return {"document_ids": docs, "execution_ids": runs, "selected_execution_ids": runs[:3],
            "record_count": 3, "authored_fixture_works": 3, "selected_execution_links": 5,
            "marker": "synthetic-continuity-1"}


@pytest.fixture(scope="module")
def boundary(tmp_path_factory):
    state = tmp_path_factory.mktemp("reading-export")
    path = state / "corpus.db"
    fixture = seed(path)
    before = snapshot(path)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 8742
    env = {**os.environ, "RESMON_STATE_DIR": str(state), "RESMON_DB_PATH": str(path),
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
                    response = httpx.get(base + "/api/health", timeout=1)
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
            raw = httpx.get(f"{base}/api/executions/{fixture['execution_ids'][0]}/references",
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


def call(base: str, tool: str, args: dict) -> dict:
    old = mcp.backend._base
    try:
        mcp.backend._base = base
        return json.loads(mcp.call_tool(tool, args)["content"][0]["text"])
    finally:
        mcp.backend._base = old


def test_mcp_result_ids_continue_to_the_same_paper_explanation(boundary):
    base, _, fixture = boundary
    run = fixture["execution_ids"][0]
    ids = []
    for offset in (0, 1):
        page = call(base, "get_execution_results", {"exec_id": run, "limit": 1, "offset": offset})
        assert page["count"] == 1 and page["total"] == 2
        paper = page["papers"][0]
        assert isinstance(paper["id"], int)
        ids.append(paper["id"])
        why = call(base, "explain_match", {"doc_id": paper["id"]})
        assert why["document"]["id"] == paper["id"]
        assert why["document"]["title"] == paper["title"]
        assert "report_text" not in page
    assert ids == list(reversed(fixture["document_ids"][:2]))
    assert call(base, "get_execution_results", {"exec_id": run, "offset": 2}) == {
        "papers": [], "count": 0, "total": 2}
    assert call(base, "get_execution_results", {"exec_id": fixture["execution_ids"][3]}) == {
        "papers": [], "count": 0, "total": 0}
    assert "error" in call(base, "get_execution_results", {"exec_id": 999999})
    print("MCP_EFFECT", json.dumps({"ids": ids, "explanations_same_paper": True,
          "tools_exercised": ["get_execution_results", "explain_match"],
          "tool_denominator": len(mcp.TOOLS), "read_denominator": len(mcp.READ_TOOLS)}))


@pytest.mark.parametrize("fmt", ["bibtex", "ris", "csv", "json"])
def test_combined_export_unions_ids_and_preserves_single_run_formats(boundary, fmt):
    base, path, fixture = boundary
    runs = fixture["selected_execution_ids"]
    combined = httpx.post(base + "/api/export/references", json={"execution_ids": runs, "format": fmt})
    combined.raise_for_status()
    assert combined.headers["X-Resmon-Document-Count"] == "3"
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        docs = db.get_documents_by_ids(conn, fixture["document_ids"])
    # One real serializer call: no per-run concatenation; the ordering is global.
    assert combined.text == reference_export.render(docs, fmt)[0]
    reversed_runs = httpx.post(base + "/api/export/references", json={"execution_ids": runs[::-1] + runs, "format": fmt})
    assert reversed_runs.text == combined.text
    single = httpx.get(f"{base}/api/executions/{runs[0]}/references", params={"format": fmt})
    via_selection = httpx.post(base + "/api/export/references", json={"execution_ids": [runs[0]], "format": fmt})
    assert single.text == via_selection.text
    explicit = httpx.post(base + "/api/export/references", json={"document_ids": fixture["document_ids"], "format": fmt})
    assert explicit.text == combined.text
    if fmt == "bibtex":
        keys = re.findall(r"^@\w+\{([^,]+),", combined.text, re.M)
        assert len(keys) == len(set(keys)) == 3
        assert keys == ["lovelace2026continuity", "lovelace2026continuity2", "lovelace2026continuity3"]
    elif fmt == "ris":
        assert combined.text.count("TY  - ") == 3
    elif fmt == "csv":
        reader = csv.DictReader(io.StringIO(combined.text))
        assert reader.fieldnames == list(reference_export.CSV_COLUMNS)
        assert len(list(reader)) == 3
    else:
        assert all(set(row) == set(reference_export.CSV_COLUMNS) for row in combined.json())
    print("EXPORT_EFFECT", json.dumps({"format": fmt, "entries": 3, "selected_links": 5,
          "sha256": hashlib.sha256(combined.content).hexdigest(), "selection_order_independent": True}))


def test_export_empty_stale_mixed_and_id_option(boundary):
    base, _, fixture = boundary
    url = base + "/api/export/references"
    assert httpx.post(url, json={"execution_ids": [], "format": "json"}).json() == []
    assert httpx.post(url, json={"execution_ids": [999999], "format": "bibtex"}).status_code == 404
    assert httpx.post(url, json={"execution_ids": fixture["execution_ids"], "document_ids": [1]}).status_code == 400
    route = f"{base}/api/executions/{fixture['execution_ids'][0]}/references"
    plain = httpx.get(route, params={"format": "json"}).json()
    identified = httpx.get(route, params={"format": "json", "include_ids": "true"}).json()
    assert [{k: v for k, v in d.items() if k != "id"} for d in identified] == plain
    assert [d["id"] for d in identified] == list(reversed(fixture["document_ids"][:2]))
    assert httpx.get(route, params={"format": "csv", "include_ids": "true"}).status_code == 400


if __name__ == "__main__":
    mode, target = sys.argv[1:]
    print(json.dumps(seed(Path(target)) if mode == "seed" else snapshot(Path(target))))
