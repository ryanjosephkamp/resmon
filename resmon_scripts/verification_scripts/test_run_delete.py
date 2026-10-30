"""Deleting a run: what goes, what stays, and the run that is still going.

``DELETE /api/executions/{exec_id}`` removes the run's row, and the schema's
``ON DELETE CASCADE`` takes the rows that only mean something beside it. The
renderer tells a person, before they confirm, exactly what that is; these
tests hold the engine to the same sentence: the record goes, the papers and
the files on disk stay, and a run that is still running is refused.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import database as db  # noqa: E402
import resmon as resmon_mod  # noqa: E402


@pytest.fixture
def client():
    """The FastAPI app over a fresh file-backed database, with the suite's token."""
    from fastapi.testclient import TestClient
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    with TestClient(resmon_mod.app) as c:
        yield c
    resmon_mod._db_path = None
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def _run(status: str, tmp_path: Path, **extra) -> int:
    """One run in ``status``, with a report and a log on disk and one paper linked."""
    conn = resmon_mod._get_db()
    exec_id = db.insert_execution(conn, {
        "execution_type": "deep_dive",
        "parameters": json.dumps({"repositories": ["arxiv"], "keywords": ["graph"]}),
        "start_time": db.utc_now_iso(), **extra})
    report = tmp_path / f"report_{exec_id}.md"
    report.write_text("# resmon Literature Report\n", encoding="utf-8")
    log = tmp_path / f"log_{exec_id}.txt"
    log.write_text("the run's log\n", encoding="utf-8")
    if status != "running":
        db.update_execution_status(conn, exec_id, status, end_time=db.utc_now_iso(),
                                   result_count=1, new_result_count=1,
                                   result_path=str(report), log_path=str(log))
    doc = conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
        "VALUES ('arxiv', ?, 'A paper the run found', 'h') RETURNING id",
        (f"2610.{exec_id:05d}",)).fetchone()[0]
    conn.execute("INSERT INTO execution_documents (execution_id, document_id) VALUES (?, ?)", (exec_id, doc))
    conn.execute("INSERT INTO execution_sources (execution_id, source, status, result_count) "
                 "VALUES (?, 'arxiv', 'ok', 1)", (exec_id,))
    conn.commit()
    return exec_id


def _count(table: str, exec_id: int) -> int:
    return resmon_mod._get_db().execute(
        f"SELECT COUNT(*) FROM {table} WHERE execution_id = ?", (exec_id,)).fetchone()[0]


def test_deleting_a_run_takes_its_record_and_leaves_the_papers_and_the_files(client, tmp_path):
    exec_id = _run("completed", tmp_path)
    row = client.get(f"/api/executions/{exec_id}").json()

    resp = client.delete(f"/api/executions/{exec_id}")

    assert resp.status_code == 200, resp.text
    assert client.get(f"/api/executions/{exec_id}").status_code == 404
    assert exec_id not in [r["id"] for r in client.get("/api/executions").json()]
    # The rows that only mean something beside the run go with it.
    assert _count("execution_documents", exec_id) == 0
    assert _count("execution_sources", exec_id) == 0
    # The papers it found stay in the collection, and its files stay on disk.
    conn = resmon_mod._get_db()
    assert conn.execute("SELECT COUNT(*) FROM documents WHERE title = 'A paper the run found'").fetchone()[0] == 1
    assert Path(row["result_path"]).read_text(encoding="utf-8") == "# resmon Literature Report\n"
    assert Path(row["log_path"]).read_text(encoding="utf-8") == "the run's log\n"


def test_a_run_restarted_from_a_deleted_one_stays_without_the_link(client, tmp_path):
    source = _run("interrupted", tmp_path)
    restarted = _run("completed", tmp_path, restarted_from=source)

    assert client.delete(f"/api/executions/{source}").status_code == 200

    after = client.get(f"/api/executions/{restarted}")
    assert after.status_code == 200
    assert after.json()["restarted_from"] is None


def test_a_run_that_is_still_running_is_refused_and_kept(client, tmp_path):
    exec_id = _run("running", tmp_path)

    resp = client.delete(f"/api/executions/{exec_id}")

    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    # A string, for the renderer that shows `detail` as the reason.
    assert isinstance(detail, str)
    assert str(exec_id) in detail and "still running" in detail
    assert client.get(f"/api/executions/{exec_id}").json()["status"] == "running"
    assert _count("execution_documents", exec_id) == 1


def test_a_run_that_does_not_exist_is_a_404(client):
    resp = client.delete("/api/executions/99999")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Execution not found"
