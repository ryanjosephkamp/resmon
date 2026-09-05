"""P2 — a sweep's documents get vectors inside the same execution.

The engine is the real ``SweepEngine`` running its real pipeline into a real
database; the source client is a stub returning fixed records, and the embedding
model is :mod:`embedding_server` on a real socket. In the ledger these rows are
**real dependency, in-process**: the socket, the HTTP stack and the whole
query → dedup → link → embed → report sequence are real; the scholarly API and
the model are not.

The property is *arrives*, not *exists*: not "an embedding step is configured"
but "a document this run inserted has a vector for the active model by the time
the run finishes, and the execution's log says how many".
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import sweep_engine as se  # noqa: E402
from implementation_scripts import vector_index  # noqa: E402
from implementation_scripts.api_base import BaseAPIClient  # noqa: E402
from implementation_scripts.database import init_db  # noqa: E402
from implementation_scripts.embeddings import EmbeddingLane  # noqa: E402
from implementation_scripts.progress import progress_store  # noqa: E402
from implementation_scripts.sweep_engine import SweepEngine  # noqa: E402

from embedding_server import DEFAULT_DIMS, EmbeddingServer  # noqa: E402


class _FixedSource(BaseAPIClient):
    """A source that returns the same three papers every time."""

    def get_name(self) -> str:
        return "fixture"

    def search(self, query, date_from=None, date_to=None, max_results=100, **kwargs):
        from implementation_scripts.api_base import NormalizedResult

        return [
            NormalizedResult(
                source_repository="fixture",
                external_id=f"paper-{i}",
                title=f"A paper about {query} number {i}",
                abstract=f"This abstract concerns {query}, specifically case {i}.",
                authors="A. Author",
                publication_date="2026-01-0%d" % (i + 1),
                url=f"https://example.invalid/{i}",
                doi=None,
                categories="cs.AI",
            )
            for i in range(3)
        ]


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "corpus.db"), check_same_thread=False)
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    yield connection
    connection.close()


@pytest.fixture
def server():
    with EmbeddingServer() as running:
        yield running


@pytest.fixture
def engine(conn, monkeypatch, tmp_path):
    monkeypatch.setattr(se, "get_client", lambda _name: _FixedSource())
    monkeypatch.setattr(se, "_REQUIRED_CREDENTIALS", {})
    monkeypatch.setattr(se, "REPORTS_DIR", tmp_path / "reports")
    return SweepEngine(db_conn=conn, config={})


def _lane(server: EmbeddingServer, **overrides) -> EmbeddingLane:
    fields = {
        "kind": "local", "provider": "local", "model": "sweep-model",
        "endpoint": server.base_url, "batch_size": 2,
    }
    fields.update(overrides)
    return EmbeddingLane(**fields)


def _events(exec_id: int) -> list[dict]:
    return progress_store.get_events(exec_id)


def _log_text(conn: sqlite3.Connection, exec_id: int) -> str:
    row = conn.execute("SELECT log_path FROM executions WHERE id = ?", (exec_id,)).fetchone()
    return Path(row["log_path"]).read_text() if row and row["log_path"] else ""


# ---------------------------------------------------------------------------
# P2
# ---------------------------------------------------------------------------


def test_a_sweeps_documents_have_vectors_when_the_sweep_finishes(engine, conn, server):
    engine.embedding_lane = _lane(server)
    result = engine.execute_dive("fixture", {"query": "gravity", "max_results": 10})
    exec_id = result["execution_id"]

    document_ids = [
        int(r["document_id"])
        for r in conn.execute(
            "SELECT document_id FROM execution_documents WHERE execution_id = ?", (exec_id,)
        )
    ]
    assert len(document_ids) == 3

    embedded = {
        int(r["document_id"]): r
        for r in conn.execute(
            "SELECT document_id, model, dims, fields FROM document_embeddings"
        )
    }
    assert set(embedded) == set(document_ids), "every document this run inserted has a vector"
    assert {r["model"] for r in embedded.values()} == {"sweep-model"}
    assert {r["dims"] for r in embedded.values()} == {DEFAULT_DIMS}
    assert {r["fields"] for r in embedded.values()} == {"title+abstract"}

    # And the index is usable, not merely the table populated.
    assert vector_index.index_state(conn) == {
        "model": "sweep-model", "dims": DEFAULT_DIMS, "rows": 3,
    }


def test_the_execution_says_how_many_it_embedded(engine, conn, server):
    engine.embedding_lane = _lane(server)
    exec_id = engine.execute_dive("fixture", {"query": "gravity"})["execution_id"]

    assert "Embedded 3 of 3 document(s) with sweep-model" in _log_text(conn, exec_id)
    embedding_events = [
        e for e in _events(exec_id)
        if e.get("type") == "ai_progress" and e.get("stage") == "embedding"
    ]
    assert embedding_events, "the run emitted no embedding progress"
    final = embedding_events[-1]
    assert final["processed"] == 3 and final["total"] == 3
    assert final["model"] == "sweep-model"
    assert "Embedded 3 of 3" in final["message"]


def test_re_running_embeds_nothing_because_nothing_is_pending(engine, conn, server):
    """The second run's papers are already embedded; it must not pay again."""
    engine.embedding_lane = _lane(server)
    engine.execute_dive("fixture", {"query": "gravity"})
    calls_after_first = len(server.calls)
    engine.execute_dive("fixture", {"query": "gravity"})
    assert len(server.calls) == calls_after_first
    assert conn.execute("SELECT COUNT(*) FROM document_embeddings").fetchone()[0] == 3


def test_a_document_this_run_returned_that_predates_the_lane_is_picked_up(
    engine, conn, server
):
    """Self-healing rather than merely correct for new rows.

    A corpus embedded halfway — a cancelled backfill, a lane configured after the
    fact — is completed by the runs that touch it, without the user having to
    know to press Backfill.
    """
    engine.embedding_lane = None
    engine.execute_dive("fixture", {"query": "gravity"})
    assert conn.execute("SELECT COUNT(*) FROM document_embeddings").fetchone()[0] == 0

    engine.embedding_lane = _lane(server)
    engine.execute_dive("fixture", {"query": "gravity"})
    assert conn.execute("SELECT COUNT(*) FROM document_embeddings").fetchone()[0] == 3


# ---------------------------------------------------------------------------
# The three skip reasons, each recorded
# ---------------------------------------------------------------------------


def test_no_lane_means_no_embedding_and_no_noise(engine, conn):
    """The state most installs are in. It is not a failure and does not read as one."""
    engine.embedding_lane = None
    exec_id = engine.execute_dive("fixture", {"query": "gravity"})["execution_id"]
    assert conn.execute("SELECT COUNT(*) FROM document_embeddings").fetchone()[0] == 0
    assert not [
        e for e in _events(exec_id)
        if e.get("type") == "ai_progress" and e.get("stage") == "embedding"
    ]
    assert "Embedded" not in _log_text(conn, exec_id)


def test_a_lane_that_refuses_stops_the_step_and_names_the_reason(engine, conn, server):
    server.mode = "cannot_embed"
    engine.embedding_lane = _lane(server)
    exec_id = engine.execute_dive("fixture", {"query": "gravity"})["execution_id"]

    log = _log_text(conn, exec_id)
    assert "Embedded 0 of 3" in log
    assert "cannot produce embeddings" in log
    warnings = [
        e for e in _events(exec_id)
        if e.get("type") == "log_entry" and "Embedding stopped" in e.get("message", "")
    ]
    assert warnings and "cannot produce embeddings" in warnings[0]["message"]


def test_the_sweep_still_succeeds_when_embedding_fails(engine, conn, server):
    """A sweep's job is to find papers. An embedding endpoint being down is not
    a reason to discard the run."""
    server.mode = "error_500"
    engine.embedding_lane = _lane(server)
    result = engine.execute_dive("fixture", {"query": "gravity"})
    exec_id = result["execution_id"]

    status = conn.execute(
        "SELECT status, result_count FROM executions WHERE id = ?", (exec_id,)
    ).fetchone()
    assert status["status"] == "completed"
    assert status["result_count"] == 3
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 3
    assert Path(result["report_path"]).is_file()


def test_vectors_are_still_written_when_the_index_cannot_be_built(
    engine, conn, server, monkeypatch
):
    """Ranking is what is unavailable, not embedding. The work is not thrown away."""
    monkeypatch.setattr(vector_index, "upsert", lambda *a, **k: 0)
    engine.embedding_lane = _lane(server)
    engine.execute_dive("fixture", {"query": "gravity"})
    assert conn.execute("SELECT COUNT(*) FROM document_embeddings").fetchone()[0] == 3


def test_embedding_runs_after_the_source_calls_and_never_between_them(engine, server):
    """P2's boundary clause. An embedding endpoint must not hold a rate-limited
    scholarly connection open.

    Established by ordering: the source client records when it was called, and
    every embedding request arrives after the last of them.
    """
    order: list[str] = []

    class _Recording(_FixedSource):
        def search(self, query, **kwargs):
            order.append("search")
            return super().search(query, **kwargs)

    import implementation_scripts.sweep_engine as module

    original = module.get_client
    module.get_client = lambda _name: _Recording()
    try:
        engine.embedding_lane = _lane(server)
        original_embed = module.embed_documents

        def _recording_embed(*args, **kwargs):
            order.append("embed")
            return original_embed(*args, **kwargs)

        module.embed_documents = _recording_embed
        try:
            engine.execute_dive("fixture", {"query": "gravity"})
        finally:
            module.embed_documents = original_embed
    finally:
        module.get_client = original

    assert order == ["search", "embed"], order
