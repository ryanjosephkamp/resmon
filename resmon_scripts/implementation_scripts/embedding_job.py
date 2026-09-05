# resmon_scripts/implementation_scripts/embedding_job.py
"""Embedding the corpus: the backfill job, and the shared write path.

Two callers, one write
----------------------
Documents get embedded from two places — the sweep engine, for what a run just
inserted, and the backfill, for everything that predates the lane. Both go
through :func:`embed_documents`, for the same reason a manual routine run is a
thin wrapper over ``_dispatch_routine_fire``: two write paths that can drift are
two write paths that will.

Resume is a query, not a bookmark
---------------------------------
"Where did the last run get to" is not stored anywhere, because it does not need
to be. The work remaining is *rows lacking a vector for the active model*
(:func:`pending_ids`), which is a fact about the database rather than about the
last run, and it is correct after a cancel, a crash, a power cut, a model change
and a corpus that grew in between. A stored cursor would be wrong after any of
those and would look right.

The write is idempotent for the same reason: ``ON CONFLICT(document_id, model)``
means embedding a document twice costs a wasted call and never a duplicate row.
That is what makes "cancel and restart finishes with exactly M rows" true rather
than hoped for (P3).

Cancellation is between batches
-------------------------------
A batch in flight is finished and written. Killing an in-flight HTTP request
would abandon work already paid for — on a metered provider, literally — and
gain a few seconds. The flag is checked before each batch, so the longest a
cancel waits is one batch.

Why not ``progress_store``
--------------------------
``progress_store`` is keyed by ``execution_id`` and is the transcript of a sweep.
A backfill is not an execution: it has no routine, no sources, no report, and it
outlives the request that started it. This follows the shape ``/api/lifecycle``
already uses for the same kind of work — a module-level state dict behind a lock,
a daemon thread, a cooperative stop flag — with the state and the loop in a
module rather than in ``resmon.py``, so it can be driven by a test without an
HTTP server.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Callable, Iterable, Optional

from . import vector_index
from .embeddings import EmbeddingLane, EmbeddingUnavailable, build_text, embed_texts

logger = logging.getLogger(__name__)

__all__ = [
    "BackfillJob",
    "backfill_job",
    "coverage",
    "embed_documents",
    "pending_ids",
]


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# The shared write path
# ---------------------------------------------------------------------------


def pending_ids(
    conn: sqlite3.Connection, model: str, *, limit: Optional[int] = None,
    within: Optional[Iterable[int]] = None,
) -> list[int]:
    """Document ids with no vector for *model*, oldest first.

    ``within`` restricts to a candidate set — the sweep hook passes the execution's
    new documents, so the same query answers "what does this run still owe" and
    "what does the corpus still owe".
    """
    sql = (
        "SELECT d.id FROM documents d "
        "LEFT JOIN document_embeddings e "
        "  ON e.document_id = d.id AND e.model = ? "
        "WHERE e.document_id IS NULL"
    )
    params: list = [model]
    if within is not None:
        candidates = [int(i) for i in within]
        if not candidates:
            return []
        sql += f" AND d.id IN ({','.join('?' for _ in candidates)})"
        params.extend(candidates)
    sql += " ORDER BY d.id"
    if limit is not None:
        sql += " LIMIT ?"
        params.append(int(limit))
    return [int(row[0]) for row in conn.execute(sql, params)]


def coverage(conn: sqlite3.Connection, model: Optional[str]) -> dict:
    """``{embedded, total, model}`` — "N of M embedded with model X".

    With no model the answer is ``embedded: 0``, not an error: an install with no
    lane configured has a real corpus and no vectors, and that is what this says.
    """
    total = int(conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0])
    if not model:
        return {"embedded": 0, "total": total, "model": None}
    embedded = int(
        conn.execute(
            "SELECT COUNT(*) FROM document_embeddings WHERE model = ?", (model,)
        ).fetchone()[0]
    )
    return {"embedded": embedded, "total": total, "model": model}


def embed_documents(
    conn: sqlite3.Connection,
    lane: EmbeddingLane,
    document_ids: list[int],
    *,
    should_cancel: Optional[Callable[[], bool]] = None,
    on_batch: Optional[Callable[[int, int], None]] = None,
) -> dict:
    """Embed *document_ids* through *lane* and write them. The one write path.

    Returns ``{"embedded", "skipped_no_text", "cancelled", "reason"}``.

    ``reason`` is non-``None`` when the run stopped early, and it is a sentence
    for a person. A lane that cannot embed stops the whole run — retrying a chat
    model per document would be a thousand identical refusals — while a document
    with no usable text is skipped and counted, because that is a fact about the
    paper rather than about the lane.
    """
    result = {"embedded": 0, "skipped_no_text": 0, "cancelled": False, "reason": None}
    if not document_ids:
        return result

    batch_size = max(1, int(lane.batch_size or 1))
    for start in range(0, len(document_ids), batch_size):
        if should_cancel is not None and should_cancel():
            result["cancelled"] = True
            result["reason"] = "Cancelled. The documents already embedded keep their vectors."
            return result

        chunk = document_ids[start : start + batch_size]
        rows = conn.execute(
            f"SELECT id, title, abstract FROM documents WHERE id IN "
            f"({','.join('?' for _ in chunk)})",
            chunk,
        ).fetchall()

        prepared: list[tuple[int, str, str]] = []
        for row in rows:
            text, fields = build_text(row["title"], row["abstract"], lane.input_limit)
            if not text.strip():
                # A paper with neither title nor abstract. It is indexed and
                # searchable by its other metadata; it has nothing to embed, and
                # a vector of an empty string would rank it against everything.
                result["skipped_no_text"] += 1
                continue
            prepared.append((int(row["id"]), text, fields))

        if not prepared:
            continue

        try:
            vectors = embed_texts(lane, [text for _, text, _ in prepared])
        except EmbeddingUnavailable as exc:
            result["reason"] = exc.reason
            return result
        except Exception as exc:
            message = getattr(exc, "message", None) or str(exc)
            result["reason"] = f"The embedding call failed: {message}"
            return result

        written: list[tuple[int, bytes]] = []
        for (doc_id, _text, fields), vector in zip(prepared, vectors):
            blob = vector_index.pack_vector(vector)
            conn.execute(
                "INSERT INTO document_embeddings "
                "  (document_id, model, dims, vector, fields, embedded_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(document_id, model) DO UPDATE SET "
                "  dims = excluded.dims, vector = excluded.vector, "
                "  fields = excluded.fields, embedded_at = excluded.embedded_at",
                (doc_id, lane.model, len(vector), blob, fields, _now()),
            )
            written.append((doc_id, blob))
        conn.commit()

        # The index second, and never as the only copy. If this returns 0 because
        # the extension will not load, the vectors are still in the table and a
        # later rebuild picks them up -- embedding is useful to a machine that
        # cannot rank yet, and refusing to store them would not be.
        vector_index.upsert(conn, lane.model, written)
        conn.commit()

        result["embedded"] += len(written)
        if on_batch is not None:
            on_batch(result["embedded"], len(document_ids))

    return result


# ---------------------------------------------------------------------------
# The backfill
# ---------------------------------------------------------------------------


class BackfillJob:
    """One backfill at a time, cancellable, resumable, with a readable status.

    A module-level singleton (:data:`backfill_job`) rather than a per-request
    object: two concurrent backfills over the same corpus would embed the same
    documents twice and cost the user twice, and there is no reason to want one.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._state: dict = self._idle_state()

    @staticmethod
    def _idle_state() -> dict:
        return {
            "running": False,
            "model": None,
            "processed": 0,
            "total": 0,
            "skipped_no_text": 0,
            "started_at": None,
            "finished_at": None,
            "cancelled": False,
            "reason": None,
        }

    # -- status -------------------------------------------------------------

    def status(self, conn: sqlite3.Connection, model: Optional[str]) -> dict:
        """What the interface renders: the run, the coverage, and the index.

        ``coverage`` is read from the database rather than from the counters, so
        the numbers are right after a restart, after a cancel, and for a corpus
        somebody else's run embedded.
        """
        with self._lock:
            run = dict(self._state)
        return {
            "run": run,
            "coverage": coverage(conn, model),
            "extension": vector_index.extension_status(conn),
            "index": vector_index.index_state(conn),
        }

    @property
    def running(self) -> bool:
        with self._lock:
            return self._state["running"]

    # -- control ------------------------------------------------------------

    def start(
        self,
        connection_factory: Callable[[], sqlite3.Connection],
        lane: EmbeddingLane,
        *,
        close_connection: bool = True,
    ) -> dict:
        """Begin a backfill on a daemon thread. Returns the initial status.

        *connection_factory* is called **on the worker thread**, not here. Each
        thread holds its own connection (BUG-020), and handing a worker the
        request thread's connection is the shape that segfaults CPython when the
        two touch it at once.

        Raises ``RuntimeError`` when one is already running: two backfills over
        one corpus embed everything twice.
        """
        with self._lock:
            if self._state["running"]:
                raise RuntimeError("A backfill is already running.")
            self._cancel.clear()
            self._state = self._idle_state()
            self._state.update(running=True, model=lane.model, started_at=_now())
            snapshot = dict(self._state)

        self._thread = threading.Thread(
            target=self._run,
            args=(connection_factory, lane, close_connection),
            daemon=True,
            name="embedding-backfill",
        )
        self._thread.start()
        return snapshot

    def cancel(self) -> dict:
        """Ask the run to stop after the batch in flight. Cooperative, not abrupt."""
        with self._lock:
            if not self._state["running"]:
                return {"status": "idle"}
        self._cancel.set()
        return {"status": "cancelling"}

    def join(self, timeout: float = 30.0) -> bool:
        """Block until the worker finishes. For tests and for shutdown."""
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    # -- the worker ---------------------------------------------------------

    def _run(
        self,
        connection_factory: Callable[[], sqlite3.Connection],
        lane: EmbeddingLane,
        close_connection: bool,
    ) -> None:
        conn = None
        try:
            conn = connection_factory()
            todo = pending_ids(conn, lane.model)
            with self._lock:
                self._state["total"] = len(todo)

            def _progress(done: int, _total: int) -> None:
                with self._lock:
                    self._state["processed"] = done

            outcome = embed_documents(
                conn, lane, todo,
                should_cancel=self._cancel.is_set,
                on_batch=_progress,
            )
            with self._lock:
                self._state.update(
                    processed=outcome["embedded"],
                    skipped_no_text=outcome["skipped_no_text"],
                    cancelled=outcome["cancelled"],
                    reason=outcome["reason"],
                )
        except Exception as exc:  # pragma: no cover - defence around a daemon thread
            logger.exception("embedding backfill failed")
            with self._lock:
                self._state["reason"] = f"The backfill stopped: {type(exc).__name__}: {exc}"
        finally:
            with self._lock:
                self._state["running"] = False
                self._state["finished_at"] = _now()
            if conn is not None and close_connection:
                # This thread opened it and this thread closes it. ``close_db``
                # refuses a close another live thread owns, and for good reason:
                # connections are check_same_thread=False and nothing serialises
                # a close against another thread's query.
                try:
                    conn.close()
                except Exception:  # pragma: no cover
                    logger.debug("backfill connection close failed", exc_info=True)


backfill_job = BackfillJob()
