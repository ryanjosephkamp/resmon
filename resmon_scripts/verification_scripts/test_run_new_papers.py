"""A paper a run stores is linked to that run as new, and counted in its new papers.

``execution_documents.is_new`` and the run's ``new_result_count`` came from
comparing ``documents.first_seen_at`` (SQLite's ``datetime('now')``,
``2026-11-05 10:00:00``) with the run's start (``now_iso()``,
``2026-11-05T10:00:00Z``) as strings. The space sorts before the ``T``, so a
paper the run stored that same day read as older than the run: its new papers
and its new-only export were empty, and it said it found nothing new.
"""
from __future__ import annotations

import sqlite3

import pytest

from implementation_scripts import sweep_engine as se
from implementation_scripts.api_base import NormalizedResult
from implementation_scripts.database import init_db
from implementation_scripts.progress import progress_store
from implementation_scripts.sweep_engine import SweepEngine


@pytest.fixture(autouse=True)
def reports_elsewhere(monkeypatch, tmp_path):
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")


class _Stand:
    def __init__(self, papers: list[NormalizedResult]):
        self.papers = papers

    def search(self, query, date_from=None, date_to=None, max_results=100):
        return list(self.papers)


def _paper(n: int) -> NormalizedResult:
    return NormalizedResult(
        source_repository="arxiv", external_id=f"2511.{n:05d}", doi=None,
        title=f"A paper about lattice gauge theory, number {n}", authors=["Ada Lovelace"],
        abstract="An abstract long enough to be kept.", publication_date="2026-11-01",
        url=f"https://arxiv.org/abs/2511.{n:05d}",
    )


def _run(monkeypatch, conn, papers) -> int:
    monkeypatch.setattr(se, "get_client", lambda name, **kwargs: _Stand(papers))
    engine = SweepEngine(db_conn=conn, config={})
    exec_id = engine.prepare_execution("deep_dive", ["arxiv"], {"query": "lattice", "max_results": 10})
    progress_store.register(exec_id)
    engine.run_prepared(exec_id)
    return exec_id


def test_the_papers_a_run_stores_are_its_new_papers(monkeypatch) -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_db(conn=conn)
    first = _run(monkeypatch, conn, [_paper(1), _paper(2)])

    rows = conn.execute("SELECT is_new FROM execution_documents WHERE execution_id = ?", (first,)).fetchall()
    assert [r["is_new"] for r in rows] == [1, 1]
    assert conn.execute("SELECT new_result_count FROM executions WHERE id = ?", (first,)).fetchone()[0] == 2

    # A later run that finds the same two and one more: only the one is new to it. The stored times have
    # one-second resolution, so the first run's papers are dated a minute back, as a later run would find them.
    conn.execute("UPDATE documents SET first_seen_at = datetime('now', '-1 minute')")
    conn.commit()
    second = _run(monkeypatch, conn, [_paper(1), _paper(2), _paper(3)])
    new = conn.execute(
        "SELECT d.external_id FROM execution_documents ed JOIN documents d ON d.id = ed.document_id "
        "WHERE ed.execution_id = ? AND ed.is_new = 1", (second,)).fetchall()
    assert [r[0] for r in new] == ["2511.00003"]
    assert conn.execute("SELECT new_result_count FROM executions WHERE id = ?", (second,)).fetchone()[0] == 1
    conn.close()


def test_the_two_clocks_compare_as_times() -> None:
    assert se._utc_clock("2026-11-05 10:00:01") >= se._utc_clock("2026-11-05T10:00:00Z")
    assert se._utc_clock("2026-11-05 09:59:59") < se._utc_clock("2026-11-05T10:00:00Z")
    assert se._utc_clock(None) == ""
