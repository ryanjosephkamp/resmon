"""The vector index: loading, the lifecycle, and what a ranking must never do.

Two properties in phase 1.9's list live here.

**P5 — absence is a first-class state.** When the extension will not load, every
entry point returns a "not available" answer with a reason and nothing raises.
The test does not mock the answer; it makes the real load site fail, by hiding
the module the real code imports, and then drives the real functions.

**P7 — vectors from two models never mix.** The index holds one model at a time,
so the obvious test would pass without the guard that matters. This builds the
situation the guard exists for instead: an index that *does* hold both models'
rows, which is what a partial re-embed or a hand-edited database leaves behind.
The mutation is to delete the model join in ``nearest``; the test below fails.
"""

from __future__ import annotations

import builtins
import sqlite3
import sys
import threading
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import vector_index  # noqa: E402
from implementation_scripts.database import init_db  # noqa: E402

pytest.importorskip("sqlite_vec", reason="sqlite-vec is a runtime dependency of 1.9")


DIMS = 4


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "corpus.db"))
    connection.row_factory = sqlite3.Row
    init_db(conn=connection)
    vector_index._reset_probe_for_tests()
    yield connection
    connection.close()
    vector_index._reset_probe_for_tests()


def _document(conn: sqlite3.Connection, external_id: str) -> int:
    cursor = conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
        "VALUES ('arxiv', ?, ?, ?)",
        (external_id, f"Paper {external_id}", f"hash-{external_id}"),
    )
    return int(cursor.lastrowid)


def _embed(conn: sqlite3.Connection, doc_id: int, model: str, values: list[float]) -> None:
    conn.execute(
        "INSERT INTO document_embeddings (document_id, model, dims, vector, fields) "
        "VALUES (?, ?, ?, ?, 'title+abstract')",
        (doc_id, model, len(values), vector_index.pack_vector(values)),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Schema 11
# ---------------------------------------------------------------------------


def test_schema_11_creates_the_three_additions(conn):
    """The migration's own contract, on a database ``init_db`` just built."""
    from implementation_scripts import database

    # 12 since 2.0a's assistant tables. The three additions this test names are
    # still what schema 11 brought; the version constant has moved past it.
    assert database.SCHEMA_VERSION >= 11
    assert database.get_schema_version(conn) == database.SCHEMA_VERSION

    tables = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert "document_embeddings" in tables
    assert "document_links" in tables
    routine_columns = {row[1] for row in conn.execute("PRAGMA table_info(routines)")}
    assert "intent" in routine_columns


def test_intent_is_not_backfilled_from_the_keyword_string(tmp_path):
    """A pre-1.9 routine reads as "no intent recorded", not as one it never typed.

    The coverage audit falls back to the keywords and says so. Writing them into
    the column instead would make every existing routine claim a stated intent.
    """
    path = tmp_path / "old.db"
    old = sqlite3.connect(str(path))
    old.executescript(
        """
        CREATE TABLE routines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            schedule_cron TEXT NOT NULL,
            parameters TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            email_enabled INTEGER NOT NULL DEFAULT 0,
            email_ai_summary_enabled INTEGER NOT NULL DEFAULT 0,
            ai_enabled INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO routines (name, schedule_cron, parameters)
        VALUES ('old one', '0 9 * * *', '{"keywords": "graph neural networks"}');
        """
    )
    old.commit()
    old.close()

    upgraded = sqlite3.connect(str(path))
    upgraded.row_factory = sqlite3.Row
    init_db(conn=upgraded)
    row = upgraded.execute("SELECT intent, parameters FROM routines").fetchone()
    assert row["intent"] is None
    assert "graph neural networks" in row["parameters"]
    upgraded.close()


def test_a_link_row_cannot_be_stored_in_both_directions(conn):
    """``document_a < document_b`` is a CHECK, so a pair cannot disagree with itself."""
    a, b = _document(conn, "1"), _document(conn, "2")
    conn.execute(
        "INSERT INTO document_links (document_a, document_b, kind, score, method) "
        "VALUES (?, ?, 'near_duplicate', 0.1, 'vector+title')",
        (a, b),
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO document_links (document_a, document_b, kind, score, method) "
            "VALUES (?, ?, 'near_duplicate', 0.1, 'vector+title')",
            (b, a),
        )


# ---------------------------------------------------------------------------
# Loading and the lifecycle
# ---------------------------------------------------------------------------


def test_the_extension_loads_and_health_reports_its_version(conn):
    version = vector_index.load_extension(conn)
    assert version is not None
    status = vector_index.extension_status(conn)
    assert status["extension"] == version
    assert status["reason"] is None
    # The version is the extension's own answer, not a constant in resmon.
    assert conn.execute("SELECT vec_version()").fetchone()[0] == version


def test_status_before_any_attempt_says_so_rather_than_claiming_unavailable():
    """A health endpoint must not report "unavailable" because nobody has tried."""
    vector_index._reset_probe_for_tests()
    status = vector_index.extension_status()
    assert status["extension"] is None
    assert "has not been loaded" in status["reason"]


def test_rebuild_reconstructs_the_index_from_the_canonical_table(conn):
    ids = [_document(conn, str(i)) for i in range(5)]
    for offset, doc_id in enumerate(ids):
        _embed(conn, doc_id, "m1", [1.0 + offset, 0.0, 0.0, 0.0])

    assert vector_index.rebuild(conn, "m1")["rebuilt"] == 5
    assert vector_index.index_state(conn) == {"model": "m1", "dims": DIMS, "rows": 5}

    # The index is derived. Dropping it costs a rebuild and no vectors.
    vector_index.drop_index(conn)
    assert vector_index.index_state(conn)["rows"] == 0
    assert conn.execute("SELECT COUNT(*) FROM document_embeddings").fetchone()[0] == 5
    assert vector_index.rebuild(conn, "m1")["rebuilt"] == 5


def test_rebuild_leaves_no_index_when_the_model_has_no_vectors(conn):
    doc = _document(conn, "1")
    _embed(conn, doc, "m1", [1.0, 0, 0, 0])
    vector_index.rebuild(conn, "m1")
    result = vector_index.rebuild(conn, "m2")
    assert result["ok"] and result["rebuilt"] == 0
    assert "No documents are embedded" in result["reason"]
    # An empty index and a stale index answer a query identically; only one is
    # honest, so there is no index at all.
    assert vector_index.index_state(conn)["dims"] is None


def test_rebuild_skips_rows_whose_width_disagrees_and_says_how_many(conn):
    """A model that changed output width under one name leaves both in the table."""
    for i in range(3):
        _embed(conn, _document(conn, f"good-{i}"), "m1", [1.0, 0, 0, 0])
    _embed(conn, _document(conn, "odd"), "m1", [1.0, 0, 0, 0, 0, 0, 0, 0])
    result = vector_index.rebuild(conn, "m1")
    assert result["dims"] == 4  # the majority width, not whichever row came last
    assert result["rebuilt"] == 3
    assert "1 stored vector(s)" in result["reason"]
    assert "not 4-dimensional" in result["reason"]


def test_switching_model_rebuilds_at_the_new_width(conn):
    a, b = _document(conn, "a"), _document(conn, "b")
    _embed(conn, a, "small", [1.0, 0, 0, 0])
    _embed(conn, b, "large", [1.0, 0, 0, 0, 0, 0])
    vector_index.rebuild(conn, "small")
    assert vector_index.index_state(conn)["dims"] == 4
    vector_index.rebuild(conn, "large")
    assert vector_index.index_state(conn) == {"model": "large", "dims": 6, "rows": 1}


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------


def test_nearest_ranks_by_distance_and_honours_the_candidate_set(conn):
    ids = [_document(conn, str(i)) for i in range(6)]
    for offset, doc_id in enumerate(ids):
        _embed(conn, doc_id, "m1", [1.0, float(offset), 0.0, 0.0])
    query = vector_index.pack_vector([1.0, 0.0, 0.0, 0.0])

    ranked = vector_index.nearest(conn, "m1", query, k=3)
    assert [doc for doc, _ in ranked] == ids[:3]
    assert ranked[0][1] == pytest.approx(0.0)
    assert [dist for _, dist in ranked] == sorted(dist for _, dist in ranked)

    # ``k`` is applied *inside* the KNN, so a small candidate set still yields k
    # rows. A post-filter would return one row here (only id[5] is in the top 3
    # of the whole index) or none.
    subset = ids[4:]
    restricted = vector_index.nearest(conn, "m1", query, k=2, within_ids=subset)
    assert len(restricted) == 2
    assert {doc for doc, _ in restricted} <= set(subset)


def test_an_empty_candidate_set_ranks_nothing_rather_than_everything(conn):
    doc = _document(conn, "1")
    _embed(conn, doc, "m1", [1.0, 0, 0, 0])
    vector_index.rebuild(conn, "m1")
    query = vector_index.pack_vector([1.0, 0, 0, 0])
    assert vector_index.nearest(conn, "m1", query, k=5, within_ids=[]) == []


def test_ranking_with_one_model_never_returns_a_row_embedded_only_by_another(conn):
    """P7. The index is built holding *both* models, which is the failure state.

    A partial re-embed, or a database hand-edited between versions, leaves an
    index containing rows the active model never produced. Their distances are
    computed against a different vector space, so they sort confidently and
    meaninglessly. ``nearest`` joins ``document_embeddings`` on the model to make
    that impossible.

    **Mutation:** delete the ``AND de.model = ?`` join condition in
    ``vector_index.nearest``. This test then returns the model-B row and fails.
    """
    only_a = _document(conn, "a")
    only_b = _document(conn, "b")
    _embed(conn, only_a, "model-a", [0.0, 1.0, 0.0, 0.0])
    # Deliberately the closer vector, so a missing predicate is visible rather
    # than hidden behind the ordering.
    _embed(conn, only_b, "model-b", [1.0, 0.0, 0.0, 0.0])

    vector_index.rebuild(conn, "model-a")
    # Force the failure state: put model B's row into model A's index by hand.
    conn.execute(
        f"INSERT INTO {vector_index.INDEX_TABLE}(document_id, embedding) VALUES (?, ?)",
        (only_b, vector_index.pack_vector([1.0, 0.0, 0.0, 0.0])),
    )
    conn.commit()
    assert conn.execute(
        f"SELECT COUNT(*) FROM {vector_index.INDEX_TABLE}"
    ).fetchone()[0] == 2

    query = vector_index.pack_vector([1.0, 0.0, 0.0, 0.0])
    ranked = vector_index.nearest(conn, "model-a", query, k=5)
    assert [doc for doc, _ in ranked] == [only_a]


def test_a_query_vector_of_the_wrong_width_ranks_nothing_and_does_not_raise(conn):
    doc = _document(conn, "1")
    _embed(conn, doc, "m1", [1.0, 0, 0, 0])
    vector_index.rebuild(conn, "m1")
    assert vector_index.nearest(conn, "m1", vector_index.pack_vector([1.0] * 9), k=3) == []


def test_asking_for_a_different_model_rebuilds_rather_than_ranking_the_old_one(conn):
    a, b = _document(conn, "a"), _document(conn, "b")
    _embed(conn, a, "m1", [1.0, 0, 0, 0])
    _embed(conn, b, "m2", [1.0, 0, 0, 0])
    vector_index.rebuild(conn, "m1")
    ranked = vector_index.nearest(conn, "m2", vector_index.pack_vector([1.0, 0, 0, 0]), k=5)
    assert [doc for doc, _ in ranked] == [b]
    assert vector_index.index_state(conn)["model"] == "m2"


def test_upsert_puts_a_new_vector_into_an_existing_index(conn):
    first = _document(conn, "1")
    _embed(conn, first, "m1", [1.0, 0, 0, 0])
    vector_index.rebuild(conn, "m1")

    second = _document(conn, "2")
    _embed(conn, second, "m1", [0.9, 0.1, 0, 0])
    written = vector_index.upsert(
        conn, "m1", [(second, vector_index.pack_vector([0.9, 0.1, 0, 0]))]
    )
    conn.commit()
    assert written == 1
    assert vector_index.index_state(conn)["rows"] == 2
    ranked = vector_index.nearest(conn, "m1", vector_index.pack_vector([0.9, 0.1, 0, 0]), k=1)
    assert ranked[0][0] == second


def test_upsert_replaces_rather_than_duplicating(conn):
    doc = _document(conn, "1")
    _embed(conn, doc, "m1", [1.0, 0, 0, 0])
    vector_index.rebuild(conn, "m1")
    for _ in range(3):
        vector_index.upsert(conn, "m1", [(doc, vector_index.pack_vector([1.0, 0, 0, 0]))])
    conn.commit()
    assert vector_index.index_state(conn)["rows"] == 1


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


def test_every_public_entry_point_survives_a_connection_that_never_loaded_it(tmp_path):
    """The second half of the same bug, and the one that outlived the first fix.

    resmon holds one connection per thread (BUG-020) and FastAPI answers sync
    endpoints on a thread pool, so whether the extension is loaded on *this*
    connection depends on which thread took the request. ``index_state`` queried
    the ``vec0`` table without going through the load site, so on a fresh thread
    it raised ``no such module: vec0`` — before the CORS middleware, so the
    browser saw ``net::ERR_FAILED`` with no status code rather than a 500.

    Six call sites, several of them the first thing an endpoint does.

    **Mutation:** delete the ``load_extension`` call at the top of
    ``index_state``. This test raises ``sqlite3.OperationalError``.
    """
    path = tmp_path / "corpus.db"
    setup = sqlite3.connect(str(path))
    setup.row_factory = sqlite3.Row
    init_db(conn=setup)
    doc = _document(setup, "1")
    _embed(setup, doc, "m1", [1.0, 0.0, 0.0, 0.0])
    vector_index.rebuild(setup, "m1")
    setup.close()

    # A connection that has never loaded the extension — exactly what a request
    # landing on a new worker thread gets.
    fresh = sqlite3.connect(str(path))
    fresh.row_factory = sqlite3.Row
    try:
        state = vector_index.index_state(fresh)
        assert state["rows"] == 1 and state["model"] == "m1"
    finally:
        fresh.close()

    # And the endpoints' other first-touch entry points, each on its own
    # never-loaded connection.
    for call in (
        lambda c: vector_index.index_state(c),
        lambda c: vector_index.extension_status(c),
        lambda c: vector_index.nearest(c, "m1", vector_index.pack_vector([1.0, 0, 0, 0]), 3),
        lambda c: vector_index.rebuild(c, "m1"),
    ):
        conn = sqlite3.connect(str(path))
        conn.row_factory = sqlite3.Row
        try:
            call(conn)  # must not raise
        finally:
            conn.close()


def test_concurrent_ranking_never_raises_while_another_thread_rebuilds(tmp_path):
    """The 1.9b bug, as a regression test.

    A rebuild drops and recreates a real table in the database file, so it is
    process-wide state even though every thread has its own connection. One
    thread dropping ``vec_document_embeddings`` while another queried it raised
    out of the endpoint, and because the exception escaped before FastAPI's CORS
    middleware the browser reported a bare ``net::ERR_FAILED`` rather than a 500
    — no stack trace, no server error, just a panel that said "Failed to fetch".

    It is reachable from one page: the Explorer's similarity search ranks, and
    every open similar-papers panel ranks too.

    **Mutation, performed:** remove ``with _REBUILD_LOCK:`` from ``nearest`` so
    only the rebuild itself is serialised and the query is not. **69 of 150
    rankings came back empty** — every one of them a query that landed between a
    DROP and its CREATE and was swallowed by the handler below. Without that
    handler they are exceptions instead, which is what shipped.

    The window has to be wide enough to hit: at forty documents the mutation
    passed and this test proved nothing, so the corpus here is 1,500.
    """
    path = tmp_path / "corpus.db"
    setup = sqlite3.connect(str(path), check_same_thread=False)
    setup.row_factory = sqlite3.Row
    init_db(conn=setup)
    # Enough rows that a rebuild takes long enough for another thread to land
    # inside it. At forty the window was microseconds and the mutation below
    # passed, which would have made this a test that proves nothing.
    for i in range(1500):
        doc = _document(setup, str(i))
        _embed(setup, doc, "m1", [1.0, i * 0.001, 0.0, 0.0])
    vector_index.rebuild(setup, "m1")
    setup.close()

    query = vector_index.pack_vector([1.0, 0.0, 0.0, 0.0])
    errors: list[BaseException] = []
    empties = [0]
    barrier = threading.Barrier(6)

    def worker(force_rebuild: bool) -> None:
        conn = sqlite3.connect(str(path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            barrier.wait(timeout=30)
            for _ in range(25):
                if force_rebuild:
                    # Ask for a model the index is not built for, which is what
                    # sends ``nearest`` down the lazy-rebuild path.
                    vector_index.rebuild(conn, "m1")
                got = vector_index.nearest(conn, "m1", query, k=5)
                if not got:
                    empties[0] += 1
        except BaseException as exc:  # noqa: BLE001 - the point is to catch everything
            errors.append(exc)
        finally:
            conn.close()

    threads = [threading.Thread(target=worker, args=(i % 2 == 0,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)

    assert not errors, f"ranking raised under concurrency: {errors[:3]}"
    # And it did not "succeed" by returning nothing every time, which would pass
    # the assertion above while the feature was dead.
    assert empties[0] == 0, f"{empties[0]} rankings came back empty under contention"


# ---------------------------------------------------------------------------
# P5 — the extension cannot load
# ---------------------------------------------------------------------------


@pytest.fixture
def extension_unavailable(monkeypatch):
    """Make the *real* load site fail, by hiding the module it imports.

    Not a monkeypatched ``load_extension``: the point of P5 is that the code path
    a user without the extension takes is the one under test, and a patched
    return value would exercise resmon's happy-path plumbing with a different
    answer stapled on. Ledger 23 and 33 are both that mistake.
    """
    real_import = builtins.__import__

    def _import(name, *args, **kwargs):
        if name == "sqlite_vec":
            raise ImportError("No module named 'sqlite_vec'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _import)
    vector_index._reset_probe_for_tests()
    yield
    vector_index._reset_probe_for_tests()


def test_every_entry_point_degrades_with_a_reason_when_the_extension_is_absent(
    conn, extension_unavailable
):
    """P5. Nothing raises; each answer carries the reason a user is shown."""
    assert vector_index.load_extension(conn) is None

    status = vector_index.extension_status(conn)
    assert status["extension"] is None
    assert "sqlite-vec package is not installed" in status["reason"]

    rebuilt = vector_index.rebuild(conn, "m1")
    assert rebuilt == {
        "ok": False,
        "rebuilt": 0,
        "dims": None,
        "reason": status["reason"],
    }

    assert vector_index.nearest(conn, "m1", vector_index.pack_vector([1.0] * 4), k=3) == []
    assert vector_index.upsert(conn, "m1", [(1, vector_index.pack_vector([1.0] * 4))]) == 0
    assert vector_index.index_state(conn) == {"model": None, "dims": None, "rows": 0}
    vector_index.drop_index(conn)  # a no-op, not a crash


def test_the_corpus_is_untouched_when_the_extension_is_absent(conn, extension_unavailable):
    """Inserting and reading documents cannot depend on an optional index."""
    doc = _document(conn, "1")
    _embed(conn, doc, "m1", [1.0, 0, 0, 0])
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
    # The canonical vectors are a plain table and are readable without it.
    row = conn.execute("SELECT vector, dims FROM document_embeddings").fetchone()
    assert vector_index.unpack_vector(row["vector"]) == [1.0, 0.0, 0.0, 0.0]
    assert row["dims"] == 4


# ---------------------------------------------------------------------------
# The blob layout
# ---------------------------------------------------------------------------


def test_pack_and_unpack_round_trip():
    values = [0.5, -1.25, 0.0, 3.5]
    assert vector_index.unpack_vector(vector_index.pack_vector(values)) == values
    assert len(vector_index.pack_vector(values)) == 4 * len(values)


def test_unpacking_a_blob_that_is_not_float32_says_so_rather_than_guessing():
    with pytest.raises(ValueError, match="not a whole number of float32"):
        vector_index.unpack_vector(b"\x00\x01\x02")
