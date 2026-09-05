# resmon_scripts/implementation_scripts/vector_index.py
"""The one place resmon loads sqlite-vec, and the only code that speaks ``vec0``.

Why a single load site
----------------------
``sqlite3.Connection.load_extension`` can fail for reasons that have nothing to
do with resmon: an interpreter compiled ``--disable-loadable-sqlite-extensions``,
a wheel with no binary for this OS and CPU, a hardened runtime that refuses the
``dlopen``. Every one of those is a *this feature is unavailable* condition
rather than an error, and the app has to keep working through all of them — the
corpus, the sweeps, the reports and the watchdog do not need a vector index.

So there is exactly one function that calls ``load_extension``, it returns a
version string or ``None`` **with a reason** rather than raising, and every
caller routes through it. Delegation 05 (``docs/sqlite-vec-feasibility.md``)
established that the load does work from packaged installer contents on all four
release targets; that is a reason to ship it, not a reason to assume it.

**There is no brute-force fallback.** When the extension will not load, the
features that need it are absent — the sort option is not offered, the similar
panel is not rendered, ``/api/health`` says why — in the same way a missing agent
CLI reads. Computing tens of thousands of distances in Python per query would be
a worse product wearing the same label, and a feature that is quietly hundreds of
times slower is a feature that lies about what it is.

The table is canonical; this is the index
-----------------------------------------
``document_embeddings`` (schema 11) holds the vectors and is readable by any
SQLite. The ``vec0`` virtual table here is a derived index over it: droppable,
rebuildable, and never the only copy of anything. :func:`rebuild` reconstructs it
from the table, which is what a model change, a dropped index and a database
copied from a machine that could not load the extension all resolve to.

One model in the index at a time
--------------------------------
A ``vec0`` table's dimensionality is fixed at creation and two models' distances
are not comparable, so the index holds exactly one model's vectors and records
which, in ``app_settings``. :func:`nearest` rebuilds when asked for a different
one. The model predicate on the query is then a *second* layer rather than the
mechanism — a stale index cannot leak a foreign-model row into a ranking even if
the recorded model is wrong. It fails by returning fewer rows, never wrong ones.

The blob layout
---------------
Vectors travel as little-endian float32 — the layout ``vec0`` reads natively — so
``document_embeddings.vector`` goes into the index as a copy rather than a
conversion. :func:`pack_vector` and :func:`unpack_vector` are the only two places
that know it.
"""

from __future__ import annotations

import logging
import sqlite3
import struct
from typing import Iterable, Optional, Sequence

logger = logging.getLogger(__name__)

__all__ = [
    "INDEX_TABLE",
    "INDEX_MODEL_KEY",
    "drop_index",
    "extension_status",
    "index_state",
    "load_extension",
    "nearest",
    "pack_vector",
    "rebuild",
    "unpack_vector",
    "upsert",
]

# One table, whatever the model — see the module docstring.
INDEX_TABLE = "vec_document_embeddings"

# Which model the index currently holds. An ``app_settings`` key rather than a
# table of its own: it is one string, ``app_settings`` is the store for exactly
# that, and it is not in ``_SETTINGS_GROUPS`` so no endpoint exposes it.
INDEX_MODEL_KEY = "vector_index_model"

# Set by the first ``load_extension`` in this process so a failure reads the
# same on the tenth connection as on the first, and so the reason a user sees is
# the reason that actually occurred.
_LOAD_REASON: Optional[str] = None
_LOAD_VERSION: Optional[str] = None
_PROBED = False


def pack_vector(values: Sequence[float]) -> bytes:
    """Little-endian float32 blob — the layout ``vec0`` reads natively."""
    return struct.pack(f"<{len(values)}f", *(float(v) for v in values))


def unpack_vector(blob: bytes) -> list[float]:
    """Inverse of :func:`pack_vector`. The length is derived from the blob."""
    if len(blob) % 4:
        raise ValueError(
            f"vector blob is {len(blob)} bytes, which is not a whole number of "
            "float32 values; this row was not written by pack_vector()"
        )
    return list(struct.unpack(f"<{len(blob) // 4}f", blob))


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load_extension(conn: sqlite3.Connection) -> Optional[str]:
    """Load sqlite-vec onto *conn*. Return ``vec_version()``, or ``None``.

    Never raises. The reason for a ``None`` is available from
    :func:`extension_status`, and it is what the interface shows the user.

    Loading is per *connection*, not per process, and resmon holds one
    connection per thread (BUG-020), so this runs on every connection that wants
    to rank. The probe *result* is cached for reporting; the load itself is not
    skipped, because "it worked on another connection" is not a statement about
    this one.
    """
    global _LOAD_REASON, _LOAD_VERSION, _PROBED

    try:
        import sqlite_vec  # noqa: PLC0415 — optional at runtime, by design
    except Exception as exc:
        _PROBED, _LOAD_VERSION = True, None
        _LOAD_REASON = (
            "The sqlite-vec package is not installed in this backend "
            f"({type(exc).__name__}: {exc})."
        )
        return None

    try:
        conn.enable_load_extension(True)
    except AttributeError:
        # A Python built without loadable-extension support does not expose the
        # method at all. This is the failure the packaging probe exists to rule
        # out on the shipped runtime; it can still be true of a system Python a
        # developer runs the backend under.
        _PROBED, _LOAD_VERSION = True, None
        _LOAD_REASON = (
            "This Python was built without SQLite loadable-extension support, "
            "so no vector index can be loaded."
        )
        return None
    except sqlite3.OperationalError as exc:
        _PROBED, _LOAD_VERSION = True, None
        _LOAD_REASON = f"SQLite refused to enable extension loading ({exc})."
        return None

    try:
        sqlite_vec.load(conn)
        version = conn.execute("SELECT vec_version()").fetchone()[0]
    except Exception as exc:
        _PROBED, _LOAD_VERSION = True, None
        _LOAD_REASON = (
            f"sqlite-vec did not load on this machine ({type(exc).__name__}: {exc})."
        )
        logger.info("sqlite-vec unavailable: %s", _LOAD_REASON)
        return None
    finally:
        # Close the door again whatever happened. Leaving extension loading
        # enabled widens what any later load_extension call in this process can
        # do, for no benefit: this module is the only caller and it re-enables
        # per load.
        try:
            conn.enable_load_extension(False)
        except Exception:  # pragma: no cover - enable() already succeeded
            pass

    _PROBED, _LOAD_VERSION, _LOAD_REASON = True, str(version), None
    return _LOAD_VERSION


def extension_status(conn: Optional[sqlite3.Connection] = None) -> dict:
    """``{"extension": "v0.1.9" | None, "reason": str | None}`` — for ``/api/health``.

    Pass a connection to actually attempt the load. With none, this reports what
    the last attempt in this process found, and says so when there has been no
    attempt: a health endpoint reporting "unavailable" because nobody had tried
    yet would be making a claim it has not earned.
    """
    if conn is not None:
        load_extension(conn)
    elif not _PROBED:
        return {
            "extension": None,
            "reason": "The vector extension has not been loaded in this process yet.",
        }
    return {"extension": _LOAD_VERSION, "reason": _LOAD_REASON}


def _reset_probe_for_tests() -> None:
    """Forget the cached probe result. Used by tests that simulate a load failure."""
    global _LOAD_REASON, _LOAD_VERSION, _PROBED
    _LOAD_REASON, _LOAD_VERSION, _PROBED = None, None, False


# ---------------------------------------------------------------------------
# Index lifecycle
# ---------------------------------------------------------------------------


def _index_dims(conn: sqlite3.Connection) -> Optional[int]:
    """The width the existing index was built at, or ``None`` if there is none.

    Read out of the stored ``CREATE VIRTUAL TABLE`` statement: ``vec0`` exposes
    no introspection of its own and ``PRAGMA table_info`` reports the column
    without its width.
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (INDEX_TABLE,)
    ).fetchone()
    if row is None or not row[0]:
        return None
    text = str(row[0])
    start = text.find("float[")
    if start == -1:  # pragma: no cover - only a hand-edited table gets here
        return None
    try:
        return int(text[start + len("float[") : text.find("]", start)])
    except ValueError:  # pragma: no cover
        return None


def _recorded_model(conn: sqlite3.Connection) -> Optional[str]:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = ?", (INDEX_MODEL_KEY,)
    ).fetchone()
    return str(row[0]) if row and row[0] else None


def index_state(conn: sqlite3.Connection) -> dict:
    """What the index currently is: ``{model, dims, rows}``, all ``None``/0 if absent."""
    dims = _index_dims(conn)
    if dims is None:
        return {"model": None, "dims": None, "rows": 0}
    rows = conn.execute(f"SELECT COUNT(*) FROM {INDEX_TABLE}").fetchone()[0]
    return {"model": _recorded_model(conn), "dims": dims, "rows": int(rows)}


def drop_index(conn: sqlite3.Connection) -> None:
    """Remove the index. The vectors live in ``document_embeddings`` and stay."""
    if load_extension(conn) is None:
        return
    conn.execute(f"DROP TABLE IF EXISTS {INDEX_TABLE}")
    conn.execute("DELETE FROM app_settings WHERE key = ?", (INDEX_MODEL_KEY,))
    conn.commit()


def upsert(conn: sqlite3.Connection, model: str, rows: Iterable[tuple[int, bytes]]) -> int:
    """Put ``(document_id, float32 blob)`` pairs into the index for *model*.

    Returns how many rows were written — 0 when the extension will not load, or
    when the index is built for a different model. In the second case the index
    is left alone rather than silently mixed: the caller (the embedding job)
    rebuilds when the active model changes, and a stray insert under the wrong
    model is exactly the corruption the rebuild exists to prevent.

    ``vec0`` has no ``ON CONFLICT``, so a re-embed is a delete followed by an
    insert. Both run inside the caller's transaction.
    """
    if load_extension(conn) is None:
        return 0
    batch = [(int(doc_id), blob) for doc_id, blob in rows]
    if not batch:
        return 0

    dims = len(batch[0][1]) // 4
    if _index_dims(conn) != dims or _recorded_model(conn) != model:
        # Nothing usable to append to. Build it from the canonical table, which
        # also picks up whatever else is already embedded under this model.
        result = rebuild(conn, model)
        if not result["ok"]:
            return 0
        # The rebuild read document_embeddings, so rows already written there
        # are in. Rows the caller has not committed yet still need inserting,
        # and the delete-then-insert below is idempotent for the rest.

    conn.executemany(
        f"DELETE FROM {INDEX_TABLE} WHERE document_id = ?", [(doc_id,) for doc_id, _ in batch]
    )
    conn.executemany(
        f"INSERT INTO {INDEX_TABLE}(document_id, embedding) VALUES (?, ?)", batch
    )
    return len(batch)


def rebuild(conn: sqlite3.Connection, model: str) -> dict:
    """Rebuild the index from ``document_embeddings`` for one *model*.

    This is the answer to every way the index can go wrong: a model change, a
    dims change, a dropped table, a database copied between machines where one
    could load the extension and the other could not. The canonical rows are
    never touched.

    Returns ``{"ok", "rebuilt", "dims", "reason"}``. ``ok`` is ``False`` only
    when the extension will not load.
    """
    if load_extension(conn) is None:
        return {"ok": False, "rebuilt": 0, "dims": None, "reason": _LOAD_REASON}

    # The index is built at whichever width most of this model's rows use, ties
    # broken by the most recent -- a model that changed its output width under
    # the same name leaves both in the table, and the newer one is the one the
    # next query will be embedded at. The minority is skipped below rather than
    # coerced, and the caller is told how many.
    row = conn.execute(
        "SELECT dims, COUNT(*) AS n, MAX(embedded_at) AS latest "
        "FROM document_embeddings WHERE model = ? "
        "GROUP BY dims ORDER BY n DESC, latest DESC LIMIT 1",
        (model,),
    ).fetchone()

    conn.execute(f"DROP TABLE IF EXISTS {INDEX_TABLE}")
    if row is None:
        # No vectors for this model. Leave no index rather than an empty one
        # built for a model nothing will query: an empty index and a stale index
        # answer a query identically, and only one of them is honest.
        conn.execute("DELETE FROM app_settings WHERE key = ?", (INDEX_MODEL_KEY,))
        conn.commit()
        return {
            "ok": True,
            "rebuilt": 0,
            "dims": None,
            "reason": f"No documents are embedded with {model!r}.",
        }

    dims = int(row[0])
    conn.execute(
        f"CREATE VIRTUAL TABLE {INDEX_TABLE} USING vec0("
        f"document_id INTEGER PRIMARY KEY, embedding float[{dims}])"
    )

    # Rows whose stored width disagrees with the index are skipped rather than
    # coerced. That happens where a model changed its output width under the
    # same name; inserting them would corrupt every ranking that followed while
    # raising nothing.
    written = skipped = 0
    cursor = conn.execute(
        "SELECT document_id, vector, dims FROM document_embeddings WHERE model = ?", (model,)
    )
    while True:
        chunk = cursor.fetchmany(500)
        if not chunk:
            break
        usable = [(r[0], r[1]) for r in chunk if int(r[2]) == dims and len(r[1]) == dims * 4]
        skipped += len(chunk) - len(usable)
        if usable:
            conn.executemany(
                f"INSERT INTO {INDEX_TABLE}(document_id, embedding) VALUES (?, ?)", usable
            )
            written += len(usable)

    conn.execute(
        "INSERT INTO app_settings(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (INDEX_MODEL_KEY, model),
    )
    conn.commit()

    reason = None
    if skipped:
        reason = (
            f"{skipped} stored vector(s) for {model!r} are not {dims}-dimensional and "
            "were left out of the index; re-embed them to include them."
        )
        logger.warning("%s", reason)
    return {"ok": True, "rebuilt": written, "dims": dims, "reason": reason}


# ---------------------------------------------------------------------------
# Querying
# ---------------------------------------------------------------------------

_CANDIDATE_TABLE = "temp.vec_candidate_ids"


def nearest(
    conn: sqlite3.Connection,
    model: str,
    vector: bytes,
    k: int,
    within_ids: Optional[Sequence[int]] = None,
) -> list[tuple[int, float]]:
    """The *k* nearest document ids to *vector*, closest first, with distances.

    ``within_ids`` restricts the ranking to a candidate set — the Explorer's
    filtered id set — so a similarity sort re-orders exactly the rows the filters
    already chose and cannot introduce one they excluded. It is applied **inside**
    the KNN as a ``vec0`` metadata filter, not afterwards: ``k`` is a limit taken
    before any join, so a post-filter would return far fewer than *k* rows —
    often none — whenever the candidate set is a small slice of the corpus.
    Measured on a 16,000-row 768-dimension index: ``k=10`` within a 50-id
    candidate set returns 10 rows, all of them inside the set.

    The candidate ids go through a temporary table rather than bound parameters.
    A filtered Explorer view is capped at ``explorer.COUNT_CAP`` = 10,000 ids, and
    while this SQLite reports a 250,000 parameter ceiling, that limit is a compile
    option — a build with the old default of 999 would turn a large filtered view
    into an error rather than a slow query.

    **The model predicate is a second layer, not the mechanism.** The index holds
    one model at a time (:func:`rebuild`), and this function rebuilds when asked
    for a different one. The join against ``document_embeddings`` then costs
    nothing — and if the recorded model is ever wrong, it drops the foreign rows
    instead of ranking against them. It fails by returning fewer rows, never
    wrong ones. P7's mutation is to remove it.
    """
    if load_extension(conn) is None:
        return []

    if _recorded_model(conn) != model or _index_dims(conn) is None:
        # Self-healing rather than silently empty. A rebuild is a copy out of the
        # canonical table: 16,000 768-dimension vectors in 0.20 s, measured, so
        # doing it on the query that needs it is cheaper than any bookkeeping
        # that would avoid it.
        if not rebuild(conn, model)["ok"]:
            return []
        if _index_dims(conn) is None:
            return []

    k = max(1, int(k))
    query_dims = len(vector) // 4
    if query_dims != _index_dims(conn):
        # A query vector from a different model than the index. Caught here
        # rather than left to sqlite-vec, whose error names neither side.
        logger.warning(
            "vector query is %d-dimensional but the index for %r is %s-dimensional",
            query_dims, model, _index_dims(conn),
        )
        return []

    params: list = [model, vector, k]
    if within_ids is not None:
        if not within_ids:
            return []
        conn.execute(f"DROP TABLE IF EXISTS {_CANDIDATE_TABLE}")
        conn.execute(f"CREATE TEMP TABLE {_CANDIDATE_TABLE.split('.')[1]} (id INTEGER PRIMARY KEY)")
        conn.executemany(
            f"INSERT OR IGNORE INTO {_CANDIDATE_TABLE}(id) VALUES (?)",
            [(int(i),) for i in within_ids],
        )
        restriction = f"AND v.document_id IN (SELECT id FROM {_CANDIDATE_TABLE})"
    else:
        restriction = ""

    sql = f"""
        SELECT v.document_id, v.distance
        FROM {INDEX_TABLE} v
        JOIN document_embeddings de
          ON de.document_id = v.document_id AND de.model = ?
        WHERE v.embedding MATCH ?
          AND v.k = ?
          {restriction}
        ORDER BY v.distance
    """
    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError as exc:
        # A configuration fault, not a crash: the caller renders "no ranking
        # available" and the log carries the detail.
        logger.warning("vector query failed: %s", exc)
        return []
    finally:
        if within_ids is not None:
            conn.execute(f"DROP TABLE IF EXISTS {_CANDIDATE_TABLE}")
    return [(int(r[0]), float(r[1])) for r in rows]
