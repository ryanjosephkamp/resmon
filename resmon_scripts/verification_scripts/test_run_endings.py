"""How a run ends when something goes wrong at the end: it is still recorded as what it was.

- A canceled or failed run is recorded canceled or failed even when its
  matches can't be written.
- A reply that came after Stop, whether before or after it was counted, is
  stored nowhere, listed nowhere as papers, and said to have come after Stop.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from implementation_scripts import paper_find
from implementation_scripts import sweep_engine as se
from implementation_scripts.api_base import NormalizedResult, search_outcome
from implementation_scripts.database import get_execution_by_id, get_execution_sources, init_db
from implementation_scripts.progress import progress_store

DOI = "10.5555/resmon.endings.1"
TITLE = "An authored fixture paper for how runs end"
LATE = "answered after the run was stopped, and nothing it sent was kept"


def _record(source: str) -> NormalizedResult:
    return NormalizedResult(
        source_repository=source, external_id=f"{source}-1", doi=DOI, title=TITLE,
        authors=["Ada Fixture"], abstract=None, publication_date="2026-01-02",
        url=f"https://example.org/{source}/1",
    )


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "corpus.db"), check_same_thread=False)
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


@pytest.fixture
def engine(conn, monkeypatch, tmp_path):
    monkeypatch.setattr(se, "required_credential_for_sweep", lambda _slug: None)
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setattr(se, "_HEARTBEAT_SECONDS", 0.01)
    return se.SweepEngine(db_conn=conn, config={})


def _prepare_find(engine) -> int:
    query = paper_find.parse(f"https://doi.org/{DOI}")
    asked, not_asked = paper_find.plan(query, ["crossref"])
    return engine.prepare_execution("find_paper", asked, {
        "query": query.typed, "find": {**query.as_params(), "not_asked": not_asked},
        "max_results": paper_find.CANDIDATES})


def _stored(conn, exec_id: int) -> int:
    return conn.execute("SELECT COUNT(*) FROM execution_documents WHERE execution_id = ?", (exec_id,)).fetchone()[0]


def _report(tmp_path: Path) -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in (tmp_path / "reports").rglob("*.md"))


def test_a_failed_run_is_recorded_failed_when_its_matches_cannot_be_written(conn, engine, monkeypatch):
    class Source:
        def __init__(self, slug):
            self.slug = slug

        def get_name(self):
            return self.slug

        def lookup(self, kind, value, max_results=5):
            search_outcome().note_attempt()
            return [_record(self.slug)]

    def full_disk(*_args, **_kwargs):
        raise RuntimeError("disk is full")

    def locked(*_args, **_kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(se, "get_client", lambda name, **_kw: Source(name))
    monkeypatch.setattr(se, "deduplicate_batch", full_disk)
    monkeypatch.setattr(engine, "_record_find", locked)
    exec_id = _prepare_find(engine)
    with pytest.raises(RuntimeError, match="disk is full"):
        engine.run_prepared(exec_id)
    row = get_execution_by_id(conn, exec_id)
    assert row["status"] == "failed"
    assert "disk is full" in (row["error_message"] or "")


def test_a_reply_that_arrives_after_stop_is_kept_nowhere_and_says_so(conn, engine, monkeypatch, tmp_path):
    exec_ids: list[int] = []

    class Source:
        def __init__(self, slug):
            self.slug = slug

        def get_name(self):
            return self.slug

        def lookup(self, kind, value, max_results=5):
            search_outcome().note_attempt()
            assert progress_store.request_cancel(exec_ids[0])
            return [_record(self.slug)]

    def locked(*_args, **_kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(se, "get_client", lambda name, **_kw: Source(name))
    monkeypatch.setattr(engine, "_record_find", locked)
    exec_id = _prepare_find(engine)
    exec_ids.append(exec_id)
    progress_store.register(exec_id)
    try:
        engine.run_prepared(exec_id)
        row = get_execution_by_id(conn, exec_id)
        assert row["status"] == "cancelled"
        assert _stored(conn, exec_id) == 0
        report = _report(tmp_path)
        assert LATE in report
        assert "still being asked" not in report
    finally:
        progress_store.cleanup(exec_id)


def test_a_reply_counted_just_before_stop_is_not_listed_as_papers(conn, engine, monkeypatch, tmp_path):
    exec_ids: list[int] = []
    record_source = engine._record_source

    class Client:
        def search(self, **_kwargs):
            search_outcome().note_attempt()
            return [_record("arxiv")]

    def stop_while_counting(exec_id, repo_name, status, **kwargs):
        # Stop is accepted after the reply is counted and before it is stored.
        if status == "ok":
            assert progress_store.request_cancel(exec_id)
        return record_source(exec_id, repo_name, status, **kwargs)

    monkeypatch.setattr(se, "get_client", lambda *_a, **_kw: Client())
    monkeypatch.setattr(engine, "_record_source", stop_while_counting)
    exec_id = engine.prepare_execution("deep_sweep", ["arxiv"], {"query": "graphs"})
    exec_ids.append(exec_id)
    progress_store.register(exec_id)
    try:
        engine.run_prepared(exec_id)
        row = get_execution_by_id(conn, exec_id)
        assert row["status"] == "cancelled"
        assert _stored(conn, exec_id) == 0
        sources = {s["source"]: s for s in get_execution_sources(conn, exec_id)}
        assert sources["arxiv"]["status"] == "cancelled"
        report = _report(tmp_path)
        assert LATE in report
        assert TITLE not in report
    finally:
        progress_store.cleanup(exec_id)
