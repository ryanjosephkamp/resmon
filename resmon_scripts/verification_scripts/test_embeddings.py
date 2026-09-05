"""The embedding lane: what can embed, what happens when it cannot, and the job.

Properties from phase 1.9 checked here: **P3** (backfill completeness under
cancel and restart), **P8** (an explicit *can embed* answer for every provider
resmon lists), **P9** (a server that lists models and refuses to embed reads as
"this server cannot embed").

Everything that talks to a model talks to :mod:`embedding_server` — a real HTTP
server on a real socket, driven by the unmodified client. In the ledger that is
**real dependency, in-process**. The one thing it cannot see is a real provider's
own quirks, and section 4 of the handback says so.
"""

from __future__ import annotations

import sqlite3
import sys
import threading
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import embedding_job, embeddings, vector_index  # noqa: E402
from implementation_scripts.database import init_db  # noqa: E402
from implementation_scripts.embeddings import EmbeddingLane, EmbeddingUnavailable  # noqa: E402

from embedding_server import (  # noqa: E402
    DEFAULT_DIMS,
    OLLAMA_CANNOT_EMBED_BODY,
    EmbeddingServer,
    deterministic_vector,
)


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


def _lane(server: EmbeddingServer, **overrides) -> EmbeddingLane:
    fields = {
        "kind": "local",
        "provider": "local",
        "model": "test-embed",
        "endpoint": server.base_url,
        "batch_size": 4,
    }
    fields.update(overrides)
    return EmbeddingLane(**fields)


def _documents(conn: sqlite3.Connection, count: int, *, with_abstract: bool = True) -> list[int]:
    ids = []
    for i in range(count):
        cursor = conn.execute(
            "INSERT INTO documents (source_repository, external_id, title, abstract, "
            "metadata_hash) VALUES ('arxiv', ?, ?, ?, ?)",
            (f"ext-{i}", f"Paper number {i}", f"Abstract for paper {i}." if with_abstract else None,
             f"hash-{i}"),
        )
        ids.append(int(cursor.lastrowid))
    conn.commit()
    return ids


# ---------------------------------------------------------------------------
# P8 — every provider resmon lists has an explicit answer
# ---------------------------------------------------------------------------


def _provider_denominator() -> set[str]:
    """The list in the code, not a hand count.

    ``llm_remote._SUPPORTED_PROVIDERS`` is what a user can pick as an AI
    provider; ``local`` and the two subscription providers complete the set of
    routes to a model resmon offers anywhere. Anything added to any of those
    lists must gain a row in ``PROVIDER_EMBEDDING`` or this test fails.
    """
    from implementation_scripts.ai_lanes import SUBSCRIPTION_PROVIDERS
    from implementation_scripts.llm_remote import _SUPPORTED_PROVIDERS

    return set(_SUPPORTED_PROVIDERS) | {"local"} | set(SUBSCRIPTION_PROVIDERS)


def test_every_provider_resmon_lists_has_an_embedding_answer():
    """P8, the denominator. 11 of 11, taken from the code's own provider lists.

    **The brief's P8 denominator omitted ``google``** — it named
    ``_PROVIDER_SPECS`` plus anthropic, local and custom, and Google is neither
    in ``_PROVIDER_SPECS`` (it is not OpenAI-compatible) nor in that list. It is
    a provider a user can select, so it needs an answer. It has one.
    """
    expected = _provider_denominator()
    assert expected == set(embeddings.PROVIDER_EMBEDDING), (
        "every provider resmon lists needs a can-embed answer; "
        f"missing={expected - set(embeddings.PROVIDER_EMBEDDING)}, "
        f"extra={set(embeddings.PROVIDER_EMBEDDING) - expected}"
    )
    assert len(expected) == 11


@pytest.mark.parametrize("provider", sorted(_provider_denominator()))
def test_each_answer_is_one_of_three_states_and_carries_its_evidence(provider):
    answer = embeddings.can_embed(provider)
    assert answer.state in ("yes", "no", "unknown")
    assert answer.reason.strip(), f"{provider} has no reason a user could read"
    assert answer.evidence.strip(), f"{provider} claims {answer.state} with no evidence"
    if answer.state == "no":
        # A refusal has to say what the user should do instead, or it is a dead
        # end wearing an explanation.
        assert len(answer.reason) > 40


def test_the_two_providers_that_cannot_embed_are_the_ones_established_by_a_live_check():
    """Recorded here so a change to the table is a change to this assertion.

    Anthropic: ``/v1/embeddings`` answered 404 while ``/v1/messages`` answered
    401, and the pinned SDK exposes no embeddings resource. The two CLIs: no
    embedding command in either ``--help``. All four observations are in the
    ``evidence`` fields and were made on 2026-09-05.
    """
    cannot = {name for name, a in embeddings.PROVIDER_EMBEDDING.items() if a.state == "no"}
    assert cannot == {"anthropic", "claude_code", "codex"}
    unknown = {name for name, a in embeddings.PROVIDER_EMBEDDING.items() if a.state == "unknown"}
    assert unknown == {"deepseek", "custom"}


def test_a_provider_that_cannot_embed_is_refused_when_the_lane_is_built():
    """P8's "never at backfill". ``build_lane`` returns None before anything runs."""
    settings = {
        "embedding_enabled": "true",
        "embedding_provider": "anthropic",
        "embedding_model": "claude-whatever",
    }
    assert embeddings.build_lane(settings) is None


def test_an_unlisted_provider_reads_as_unknown_rather_than_inheriting_a_capability():
    answer = embeddings.can_embed("some-new-provider")
    assert answer.state == "unknown"
    assert "no recorded answer" in answer.reason


# ---------------------------------------------------------------------------
# P9 — a server that lists models and refuses to embed
# ---------------------------------------------------------------------------


def test_the_ollama_refusal_reads_as_cannot_embed_not_as_an_empty_corpus(server):
    """P9. The body is the one Ollama 0.33.2 actually returned, byte for byte.

    The failure this rules out is the plausible one: a chat model refuses, the
    client treats a non-vector answer as "no results", and the user sees a corpus
    with nothing to rank instead of "that is not an embedding model".
    """
    server.mode = "cannot_embed"
    lane = _lane(server)

    with pytest.raises(EmbeddingUnavailable) as raised:
        embeddings.embed_texts(lane, ["anything"])
    reason = raised.value.reason
    assert "cannot produce embeddings" in reason
    assert "does not support embeddings" in reason  # the server's own words, quoted
    assert "ollama pull nomic-embed-text" in reason  # and what to do about it

    probe = embeddings.probe_lane(lane)
    assert probe["ok"] is False
    assert probe["dims"] is None
    assert "cannot produce embeddings" in probe["reason"]


def test_the_marker_matches_the_body_verbatim_from_a_live_server():
    """Guards the constant against a well-meaning rewrite that stops matching."""
    assert any(
        marker in OLLAMA_CANNOT_EMBED_BODY.lower()
        for marker in embeddings.CANNOT_EMBED_MARKERS
    )


def test_a_refusal_and_an_outage_are_different_answers(server):
    """A server that is down should be retried; a chat model should not."""
    server.mode = "error_500"
    lane = _lane(server)
    probe = embeddings.probe_lane(lane)
    assert probe["ok"] is False
    assert "HTTP 500" in probe["reason"]
    assert "cannot produce embeddings" not in probe["reason"]


def test_a_probe_never_raises_whatever_the_endpoint_does():
    """Settings calls this on a URL the user typed; the reason is the product."""
    lane = EmbeddingLane(
        kind="local", provider="local", model="m",
        endpoint="http://127.0.0.1:1",  # nothing listens here
    )
    result = embeddings.probe_lane(lane)
    assert result["ok"] is False
    assert result["reason"]


# ---------------------------------------------------------------------------
# Calling the model
# ---------------------------------------------------------------------------


def test_a_successful_probe_reports_the_width_the_model_actually_returned(server):
    result = embeddings.probe_lane(_lane(server))
    assert result == {
        "ok": True,
        "dims": DEFAULT_DIMS,
        "model": "test-embed",
        "reason": f"test-embed answered with a {DEFAULT_DIMS}-dimensional vector.",
    }


def test_texts_are_batched_at_the_lane_size_and_come_back_in_order(server):
    lane = _lane(server, batch_size=3)
    texts = [f"text {i}" for i in range(7)]
    vectors = embeddings.embed_texts(lane, texts)
    assert len(vectors) == 7
    assert server.batch_sizes == [3, 3, 1]
    for text, vector in zip(texts, vectors):
        assert vector == pytest.approx(deterministic_vector(text, DEFAULT_DIMS))


def test_a_reordered_openai_response_is_put_back_in_index_order(server):
    """The OpenAI shape permits reordering, and a silent one is undetectable.

    Every vector would still be a valid vector and every paper would still have
    one; they would simply be each other's. Sorting on ``index`` is the whole
    defence, and this is the test that holds it.
    """
    server.mode = "reordered"
    # ``custom`` reads the custom key slot. The server does not check it, but the
    # client refuses to call without one, and the in-memory keyring conftest
    # installs starts empty.
    import keyring

    keyring.set_password("resmon", "custom_llm_api_key", "probe-key")
    lane = EmbeddingLane(
        kind="api_key", provider="custom", model="m", base_url=server.base_url,
        credential_alias="custom_llm_api_key", batch_size=4,
    )
    texts = ["alpha", "beta", "gamma"]
    vectors = embeddings.embed_texts(lane, texts)
    for text, vector in zip(texts, vectors):
        assert vector == pytest.approx(deterministic_vector(text, DEFAULT_DIMS))


def test_a_short_response_is_a_failure_rather_than_a_partial_success(server):
    """One vector missing means every vector after it belongs to the wrong paper."""
    server.mode = "short_count"
    with pytest.raises(EmbeddingUnavailable, match="will not guess"):
        embeddings.embed_texts(_lane(server, batch_size=4), ["a", "b", "c"])


def test_a_missing_key_is_refused_before_the_request_with_a_sentence():
    lane = EmbeddingLane(
        kind="api_key", provider="openai", model="text-embedding-3-small",
        credential_alias="openai_api_key",
    )
    result = embeddings.probe_lane(lane)
    assert result["ok"] is False
    assert "No API key is stored" in result["reason"]


# ---------------------------------------------------------------------------
# The text that gets embedded
# ---------------------------------------------------------------------------


def test_fields_records_what_actually_went_in():
    assert embeddings.build_text("T", "A")[1] == "title+abstract"
    assert embeddings.build_text("T", None)[1] == "title"
    assert embeddings.build_text("T", "")[1] == "title"
    assert embeddings.build_text(None, "A")[1] == "abstract"


def test_the_title_survives_truncation_and_the_abstract_is_what_gets_cut():
    """A vector from half an abstract and no title is worse than one from a title."""
    title = "A short but load-bearing title"
    abstract = "x" * 10_000
    text, fields = embeddings.build_text(title, abstract, input_limit=64)
    assert text.startswith(title)
    assert fields == "title+abstract(truncated)"
    assert len(text) <= 64 * 4


def test_a_title_too_long_for_the_budget_is_still_never_dropped_for_the_abstract():
    text, fields = embeddings.build_text("t" * 500, "a" * 500, input_limit=10)
    assert set(text) == {"t"}
    assert fields == "title"


def test_a_document_with_no_text_at_all_produces_nothing_to_embed():
    text, _fields = embeddings.build_text(None, None)
    assert text == ""


# ---------------------------------------------------------------------------
# The cost estimate
# ---------------------------------------------------------------------------


def test_a_local_lane_costs_nothing_and_says_so(server):
    estimate = embeddings.estimate_cost(_lane(server), ["a" * 400])
    assert estimate["cost_usd"] == 0.0
    assert "costs nothing" in estimate["note"]


def test_a_provider_with_no_price_on_record_reports_none_rather_than_zero():
    """Zero would read as free. ``None`` reads as "resmon does not know"."""
    lane = EmbeddingLane(kind="api_key", provider="xai", model="some-model")
    estimate = embeddings.estimate_cost(lane, ["a" * 4000])
    assert estimate["cost_usd"] is None
    assert estimate["estimated_tokens"] > 0
    assert "no price on record" in estimate["note"]


def test_a_priced_model_gives_a_number_with_the_date_it_was_read():
    lane = EmbeddingLane(kind="api_key", provider="openai", model="text-embedding-3-small")
    estimate = embeddings.estimate_cost(lane, ["a" * 4_000_000])
    assert estimate["cost_usd"] == pytest.approx(0.02, rel=0.01)
    assert "2026-09-05" in estimate["note"]


# ---------------------------------------------------------------------------
# P3 — the backfill
# ---------------------------------------------------------------------------


def test_pending_is_every_row_lacking_a_vector_for_this_model(conn, server):
    ids = _documents(conn, 5)
    assert embedding_job.pending_ids(conn, "test-embed") == ids

    embedding_job.embed_documents(conn, _lane(server), ids[:2])
    assert embedding_job.pending_ids(conn, "test-embed") == ids[2:]
    # A different model owes the whole corpus: two models are two indexes.
    assert embedding_job.pending_ids(conn, "other-model") == ids


def test_embedding_writes_the_canonical_row_and_the_index(conn, server):
    ids = _documents(conn, 3)
    outcome = embedding_job.embed_documents(conn, _lane(server), ids)
    assert outcome["embedded"] == 3 and outcome["reason"] is None

    rows = conn.execute(
        "SELECT document_id, model, dims, fields FROM document_embeddings ORDER BY document_id"
    ).fetchall()
    assert [r["document_id"] for r in rows] == ids
    assert {r["model"] for r in rows} == {"test-embed"}
    assert {r["dims"] for r in rows} == {DEFAULT_DIMS}
    assert {r["fields"] for r in rows} == {"title+abstract"}
    assert vector_index.index_state(conn) == {
        "model": "test-embed", "dims": DEFAULT_DIMS, "rows": 3,
    }


def test_a_document_with_no_title_or_abstract_is_skipped_and_counted(conn, server):
    conn.execute(
        "INSERT INTO documents (source_repository, external_id, title, metadata_hash) "
        "VALUES ('arxiv', 'blank', '', 'h')"
    )
    conn.commit()
    ids = [int(conn.execute("SELECT id FROM documents").fetchone()[0])]
    outcome = embedding_job.embed_documents(conn, _lane(server), ids)
    assert outcome == {"embedded": 0, "skipped_no_text": 1, "cancelled": False, "reason": None}


def test_re_embedding_replaces_rather_than_duplicating(conn, server):
    ids = _documents(conn, 3)
    for _ in range(3):
        embedding_job.embed_documents(conn, _lane(server), ids)
    assert conn.execute("SELECT COUNT(*) FROM document_embeddings").fetchone()[0] == 3
    assert vector_index.index_state(conn)["rows"] == 3


def test_a_lane_that_cannot_embed_stops_the_run_rather_than_failing_per_document(
    conn, server
):
    ids = _documents(conn, 20)
    server.mode = "cannot_embed"
    outcome = embedding_job.embed_documents(conn, _lane(server, batch_size=2), ids)
    assert outcome["embedded"] == 0
    assert "cannot produce embeddings" in outcome["reason"]
    # One batch attempted, not ten. A thousand identical refusals is not a retry
    # strategy, and on a metered provider it is a thousand charges.
    assert len(server.calls) == 1


def test_backfill_cancelled_mid_run_and_restarted_finishes_with_exactly_m_rows(
    conn, server, tmp_path
):
    """P3, and the mutation is the cancel itself.

    Cancel is checked *between* batches, so a run stopped part-way must leave a
    consistent prefix — every document it reports as embedded actually embedded,
    and none embedded twice. Restarting is then a plain re-run: the work left is
    a query against the database, not a cursor the cancelled run had to save.
    """
    total = 20
    _documents(conn, total)
    lane = _lane(server, batch_size=2)

    def _factory():
        c = sqlite3.connect(str(tmp_path / "corpus.db"), check_same_thread=False)
        c.row_factory = sqlite3.Row
        return c

    # The cancel is landed **deterministically**, not raced against a clock.
    #
    # The first version let batches through and polled the coverage until four
    # papers were in, then cancelled. On a fast runner all twenty finished
    # between two polls, and CI went red on the guard below -- which is the
    # guard doing its job, but a flaky test is not evidence of anything.
    #
    # This holds the server's gate shut, waits until the first batch has
    # *arrived* (the handler records the call before it blocks, so one entry in
    # `server.calls` means one request is parked mid-flight), requests the
    # cancel while that batch cannot finish, and only then opens the gate. The
    # in-flight batch completes -- cancellation is deliberately between batches,
    # never mid-request -- and the loop stops before the second. Exactly
    # `batch_size` papers are embedded, on any machine at any speed.
    gate = threading.Event()
    server.gate = gate
    job = embedding_job.BackfillJob()
    job.start(_factory, lane)

    deadline = time.monotonic() + 30
    while not server.calls and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.calls, "the backfill never reached the embedding server"

    job.cancel()
    server.gate = None
    gate.set()
    assert job.join(30), "the backfill thread did not finish"

    state = job.status(conn, lane.model)
    embedded_after_cancel = state["coverage"]["embedded"]
    # Still asserted as a range rather than as ``== 2``: the point is that the
    # run stopped part-way, and pinning the exact number would make the test
    # fail on a change to the batch size that broke nothing.
    assert 0 < embedded_after_cancel < total, (
        f"the cancel did not land mid-run (embedded={embedded_after_cancel}); "
        "the test cannot establish what it is for"
    )
    assert state["run"]["cancelled"] is True
    assert state["run"]["running"] is False

    # Restart. No cursor was saved and none is needed.
    resumed = embedding_job.BackfillJob()
    resumed.start(_factory, lane)
    assert resumed.join(60)

    assert embedding_job.pending_ids(conn, lane.model) == []
    assert conn.execute("SELECT COUNT(*) FROM document_embeddings").fetchone()[0] == total
    assert conn.execute(
        "SELECT COUNT(*) FROM (SELECT document_id, model FROM document_embeddings "
        "GROUP BY document_id, model HAVING COUNT(*) > 1)"
    ).fetchone()[0] == 0
    assert vector_index.index_state(conn)["rows"] == total


def test_two_backfills_cannot_run_at_once(conn, server, tmp_path):
    _documents(conn, 4)
    lane = _lane(server, batch_size=1)

    def _factory():
        c = sqlite3.connect(str(tmp_path / "corpus.db"), check_same_thread=False)
        c.row_factory = sqlite3.Row
        return c

    gate = threading.Event()
    server.gate = gate
    job = embedding_job.BackfillJob()
    job.start(_factory, lane)
    try:
        with pytest.raises(RuntimeError, match="already running"):
            job.start(_factory, lane)
    finally:
        server.gate = None
        gate.set()
        job.join(30)


def test_coverage_reads_the_database_rather_than_the_run_counters(conn, server):
    """After a restart the counters are zero and the corpus is not."""
    ids = _documents(conn, 5)
    embedding_job.embed_documents(conn, _lane(server), ids[:3])
    fresh = embedding_job.BackfillJob()
    assert fresh.status(conn, "test-embed")["coverage"] == {
        "embedded": 3, "total": 5, "model": "test-embed",
    }


def test_coverage_with_no_model_reports_the_corpus_and_zero_rather_than_erroring(conn):
    _documents(conn, 4)
    assert embedding_job.coverage(conn, None) == {"embedded": 0, "total": 4, "model": None}


def test_vectors_survive_an_index_that_could_not_be_written(conn, server, monkeypatch):
    """Embedding is useful on a machine that cannot rank yet.

    A user whose extension will not load still gets a corpus of vectors that a
    later resmon — or the same one on another machine — can rank. Refusing to
    store them because the index is unavailable would throw away paid-for work.
    """
    monkeypatch.setattr(vector_index, "upsert", lambda *a, **k: 0)
    ids = _documents(conn, 3)
    outcome = embedding_job.embed_documents(conn, _lane(server), ids)
    assert outcome["embedded"] == 3
    assert conn.execute("SELECT COUNT(*) FROM document_embeddings").fetchone()[0] == 3
