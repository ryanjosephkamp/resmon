"""The reading queue: papers the user saved, and whether they have read them.

Membership over the corpus, keyed by the corpus-local document id. Everything
here reads and writes exactly one table -- ``reading_queue`` -- plus the
``documents`` join needed to render a list. Nothing in this module deletes a
paper, and nothing in it copies a paper's metadata anywhere.

Three properties are load-bearing and each has a reason:

**Saving is idempotent and never resets state.** A user saves a paper, reads
it, and then a later sweep finds the same record again; clicking Save from that
run's results must not quietly move it back to *To read*. ``INSERT ... ON
CONFLICT DO NOTHING`` is what makes that true at the database rather than in a
branch someone can forget.

**A state request that changes nothing writes nothing.** ``updated_at`` is a
record of state changes, so re-sending "mark read" for a paper already read
leaves both timestamps alone. Otherwise the queue would report activity the
user did not perform, and "when did this last change" would decay into "when
was the last request".

**Identity is the stored id, never the title or the DOI.** Two records that
look like the same work are two papers everywhere else in resmon -- a
near-duplicate is a link, never a merge -- and the queue does not make a
different claim from the rest of the app.
"""

from __future__ import annotations

import sqlite3

TO_READ = "to_read"
READ = "read"

#: The only two states a queue entry can be in. The database CHECK carries the
#: same list; this constant is what the HTTP layer validates against so an
#: unknown status is a 400 rather than an IntegrityError.
STATUSES: tuple[str, ...] = (TO_READ, READ)

#: What a page of the queue holds when the caller does not say.
DEFAULT_PAGE_SIZE = 50
#: The most one request will return. A queue is a human-sized list; a caller
#: asking for more than this is asking for the corpus, and the Explorer is
#: where the corpus lives.
MAX_PAGE_SIZE = 200

_ENTRY_COLUMNS = (
    "reading_queue.document_id AS document_id, "
    "reading_queue.status AS status, "
    "reading_queue.saved_at AS saved_at, "
    "reading_queue.updated_at AS updated_at, "
    "reading_queue.read_at AS read_at"
)


class UnknownDocument(LookupError):
    """A document id that is not in the corpus."""


class NotInQueue(LookupError):
    """A document that is in the corpus but was never saved (or was removed)."""


def _document_exists(conn: sqlite3.Connection, document_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM documents WHERE id = ?", (document_id,)
    ).fetchone() is not None


def get_entry(conn: sqlite3.Connection, document_id: int) -> dict | None:
    """The queue entry for one paper, or ``None`` when it is not saved."""
    row = conn.execute(
        f"SELECT {_ENTRY_COLUMNS} FROM reading_queue WHERE document_id = ?",
        (int(document_id),),
    ).fetchone()
    return dict(row) if row else None


def save(conn: sqlite3.Connection, document_id: int) -> dict:
    """Put a paper in the queue, or leave it exactly as it already is.

    Returns the entry as it stands afterwards, so the caller can render the
    real state rather than assuming the state it asked for. Raises
    :class:`UnknownDocument` for an id the corpus does not hold -- the foreign
    key would refuse it anyway, but a named error carries a sentence a user can
    read and a 404 the interface can act on.
    """
    document_id = int(document_id)
    if not _document_exists(conn, document_id):
        raise UnknownDocument(f"No document with id {document_id}")
    conn.execute(
        "INSERT INTO reading_queue (document_id) VALUES (?) "
        "ON CONFLICT(document_id) DO NOTHING",
        (document_id,),
    )
    conn.commit()
    entry = get_entry(conn, document_id)
    assert entry is not None  # the insert above either wrote it or found it
    return entry


#: The most papers one save of many takes, listed or described, and the most
#: one Undo of it takes back. A save of many answers with the ids it added, so
#: its Undo can name exactly those; at this size that answer is about 130 KB,
#: and measured on an Apple-silicon Mac the save took 44 ms and its Undo 36 ms
#: (``test_reading_queue_batch.py`` holds both under five seconds). A set
#: larger than this is the collection rather than a list to read, and the
#: refusal says so, so a filter can narrow it.
BATCH_MOST = 20_000


class TooMany(ValueError):
    """A save of many papers that names or describes more than :data:`BATCH_MOST`."""


def _known(conn: sqlite3.Connection, ids: list[int]) -> set[int]:
    """The ids among *ids* the corpus holds, read in chunks of integer literals."""
    known: set[int] = set()
    for start in range(0, len(ids), 5_000):
        literals = ",".join(str(i) for i in ids[start:start + 5_000])
        known.update(int(row[0]) for row in conn.execute(f"SELECT id FROM documents WHERE id IN ({literals})"))
    return known


def save_many(conn: sqlite3.Connection, document_ids) -> dict:
    """Save every paper named that is not in the queue; leave each one that is exactly as it is.

    The many-paper form of :func:`save`, with the same rule: a paper already in
    the queue, read or not, keeps its state and its dates, and is counted as
    ``already``. Every entry this adds carries one ``saved_at``, the moment of
    this save, and ``saved_ids`` lists them, which is what an Undo of it names
    (:func:`unsave_many`). An id the corpus does not hold (a paper erased since
    it was listed) is counted as ``missing`` and saves nothing. One transaction:
    the whole save is written, or none of it.
    """
    ids = list(dict.fromkeys(int(i) for i in document_ids))
    if len(ids) > BATCH_MOST:
        raise TooMany(f"A save takes at most {BATCH_MOST:,} papers at once; this one names {len(ids):,}.")
    known = _known(conn, ids)
    stamp = conn.execute("SELECT datetime('now')").fetchone()[0]
    added: list[int] = []
    try:
        for document_id in ids:
            if document_id not in known:
                continue
            # One row at a time, so a paper saved by another request between the
            # read above and this write is counted as already there, not as added.
            cursor = conn.execute(
                "INSERT INTO reading_queue (document_id, status, saved_at, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(document_id) DO NOTHING",
                (document_id, TO_READ, stamp, stamp),
            )
            if cursor.rowcount > 0:
                added.append(document_id)
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return {
        "asked": len(ids),
        "saved": len(added),
        "already": len(known) - len(added),
        "missing": len(ids) - len(known),
        "saved_at": stamp if added else None,
        "saved_ids": added,
        "counts": counts(conn),
    }


def unsave_many(conn: sqlite3.Connection, document_ids, saved_at: str) -> dict:
    """Undo a save of many: take out the entries it added that are still as it left them.

    An entry goes only when it still carries that save's ``saved_at`` and has
    not changed since: still to read, its ``updated_at`` the moment it was
    saved. A paper marked read since, or removed and saved again, stays, and is
    counted as ``kept``, because the person did something with it after the
    save and an Undo of the save is not an Undo of that.
    """
    ids = list(dict.fromkeys(int(i) for i in document_ids))
    if len(ids) > BATCH_MOST:
        raise TooMany(f"An Undo takes back at most {BATCH_MOST:,} papers at once; this one names {len(ids):,}.")
    if not isinstance(saved_at, str) or not 1 <= len(saved_at) <= 40:
        raise ValueError("saved_at must be the save's own, as it answered.")
    removed = 0
    try:
        for document_id in ids:
            removed += conn.execute(
                "DELETE FROM reading_queue WHERE document_id = ? AND saved_at = ? AND updated_at = saved_at "
                "AND status = ?",
                (document_id, saved_at, TO_READ),
            ).rowcount
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return {"removed": removed, "kept": len(statuses_for(conn, ids)), "counts": counts(conn)}


def run_paper_ids(conn: sqlite3.Connection, execution_id: int, *, only_new: bool = False,
                  limit: int | None = None) -> list[int]:
    """The papers a run stored that are still in the collection, by id; ``only_new``, the ones it found first."""
    sql = ("SELECT DISTINCT ed.document_id FROM execution_documents ed JOIN documents d ON d.id = ed.document_id "
           "WHERE ed.execution_id = ?" + (" AND ed.is_new = 1" if only_new else "") + " ORDER BY ed.document_id")
    params: list = [int(execution_id)]
    if limit is not None:
        sql += " LIMIT ?"
        params.append(int(limit))
    return [int(row[0]) for row in conn.execute(sql, params)]


def set_status(conn: sqlite3.Connection, document_id: int, status: str) -> dict:
    """Move a saved paper between *To read* and *Read*.

    Only a real change writes. ``read_at`` is set when the paper becomes read
    and cleared when it stops being read, which the table's CHECK also
    enforces: a read date beside an unread paper is a claim resmon would not be
    able to justify.
    """
    document_id = int(document_id)
    if status not in STATUSES:
        raise ValueError(
            f"Unknown reading status {status!r}. Expected one of: "
            + ", ".join(STATUSES)
        )
    current = get_entry(conn, document_id)
    if current is None:
        raise NotInQueue(f"Document {document_id} is not in the reading queue")
    if current["status"] == status:
        # Deliberately no write: see the module docstring. The caller still
        # gets the entry, so a repeated click is a no-op rather than an error.
        return current
    if status == READ:
        conn.execute(
            "UPDATE reading_queue SET status = ?, read_at = datetime('now'), "
            "updated_at = datetime('now') WHERE document_id = ?",
            (READ, document_id),
        )
    else:
        conn.execute(
            "UPDATE reading_queue SET status = ?, read_at = NULL, "
            "updated_at = datetime('now') WHERE document_id = ?",
            (TO_READ, document_id),
        )
    conn.commit()
    entry = get_entry(conn, document_id)
    assert entry is not None
    return entry


def remove(conn: sqlite3.Connection, document_id: int) -> dict | None:
    """Drop the membership row. The paper, its provenance and its runs stay.

    Returns the entry as it was, so a removal can be undone exactly (``restore``),
    or ``None`` when there was nothing to remove, so a second click can be
    answered honestly instead of reported as a removal that did not happen.
    """
    document_id = int(document_id)
    entry = get_entry(conn, document_id)
    if entry is None:
        return None
    conn.execute("DELETE FROM reading_queue WHERE document_id = ?", (document_id,))
    conn.commit()
    return entry


def restore(conn: sqlite3.Connection, document_id: int, status: str, saved_at: str,
            updated_at: str, read_at: str | None) -> tuple[dict, bool]:
    """Put a removed entry back exactly as ``remove`` returned it: Undo.

    Its dates are the ones it had, not the time of the undo, because an undo
    is not a new save. A paper saved again since it was removed keeps the entry
    it has now, and ``False`` says nothing was put back. The table's CHECK holds
    the pairing of ``status`` and ``read_at`` here as everywhere.
    """
    document_id = int(document_id)
    if status not in STATUSES:
        raise ValueError(f"Unknown reading status {status!r}. Expected one of: " + ", ".join(STATUSES))
    for value in (saved_at, updated_at) + ((read_at,) if read_at is not None else ()):
        if not isinstance(value, str) or not 1 <= len(value) <= 40:
            raise ValueError("Each date must be the entry's own, as the queue returned it.")
    if not _document_exists(conn, document_id):
        raise UnknownDocument(f"No document with id {document_id}")
    cursor = conn.execute(
        "INSERT INTO reading_queue (document_id, status, saved_at, updated_at, read_at) "
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(document_id) DO NOTHING",
        (document_id, status, saved_at, updated_at, read_at),
    )
    conn.commit()
    entry = get_entry(conn, document_id)
    assert entry is not None
    return entry, cursor.rowcount > 0


def counts(conn: sqlite3.Connection) -> dict:
    """How many entries are in each state, and in total."""
    result = {TO_READ: 0, READ: 0}
    for row in conn.execute(
        "SELECT status, COUNT(*) AS n FROM reading_queue GROUP BY status"
    ):
        result[row["status"]] = int(row["n"])
    result["all"] = result[TO_READ] + result[READ]
    return result


#: How a page of the queue can be ordered. ``map`` is not here: it is an order
#: the caller computes from the collection's map and passes in (``map_order``).
SORTS = {
    "saved": "reading_queue.saved_at DESC, reading_queue.document_id DESC",
    "published": "documents.pub_sort DESC, reading_queue.saved_at DESC, reading_queue.document_id DESC",
    "title": "lower(documents.title) ASC, reading_queue.document_id DESC",
    "source": "documents.source_repository ASC, reading_queue.saved_at DESC, reading_queue.document_id DESC",
}
_DOCUMENT_KEYS = ("id", "source_repository", "external_id", "doi", "title", "authors", "abstract",
                  "publication_date", "url", "categories", "first_seen_at")


def list_entries(
    conn: sqlite3.Connection,
    *,
    status: str | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
    offset: int = 0,
    q: str = "",
    sort: str = "saved",
    map_order: dict[int, tuple] | None = None,
) -> dict:
    """One page of the queue, with each paper's metadata, its PDF and where it came from.

    ``status=None`` is the *All* filter. The default order is ``saved_at`` then
    ``document_id``, both descending, matching ``idx_reading_queue_status_saved``;
    the id is in every sort so two papers that tie cannot swap places between
    two page requests and show one of them twice. ``q`` keeps the papers whose
    title, authors or source contain it. ``sort="map"`` orders by ``map_order``,
    a key per paper that keeps the map's neighbors together; papers the map has
    not placed come after, newest save first. Without a ``map_order`` the page
    says it was sorted by ``saved``, because that is the order it is in.

    Each entry carries ``pdf``, the PDF in the Library most recently linked to
    the paper (a link is the person's association, not a claim that the file
    is that paper), and ``found_by``, the first run that collected it.
    """
    if status is not None and status not in STATUSES:
        raise ValueError(
            f"Unknown reading status {status!r}. Expected one of: "
            + ", ".join(STATUSES)
        )
    if sort != "map" and sort not in SORTS:
        raise ValueError("sort must be one of: " + ", ".join([*SORTS, "map"]))
    if not isinstance(q, str) or len(q) > 200:
        raise ValueError("q must be at most 200 characters")
    limit = int(limit)
    offset = int(offset)
    if limit < 1 or limit > MAX_PAGE_SIZE:
        raise ValueError(f"limit must be between 1 and {MAX_PAGE_SIZE}")
    if offset < 0:
        raise ValueError("offset must not be negative")
    if sort == "map" and map_order is None:
        sort = "saved"

    clauses: list[str] = []
    params: list = []
    if status is not None:
        clauses.append("reading_queue.status = ?")
        params.append(status)
    if q.strip():
        clauses.append(
            "(instr(lower(documents.title), lower(?)) > 0 OR instr(lower(coalesce(documents.authors, '')), lower(?)) > 0"
            " OR instr(lower(documents.source_repository), lower(?)) > 0)")
        params += [q.strip()] * 3
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    joined = "FROM reading_queue JOIN documents ON documents.id = reading_queue.document_id"

    total = conn.execute(f"SELECT COUNT(*) {joined} {where}", params).fetchone()[0]
    if sort == "map":
        ids = [r[0] for r in conn.execute(
            f"SELECT reading_queue.document_id {joined} {where} ORDER BY {SORTS['saved']}", params)]
        placed = [i for i in ids if i in map_order]
        placed.sort(key=lambda i: (map_order[i], -i))
        page_ids = (placed + [i for i in ids if i not in map_order])[offset:offset + limit]
        rows_by_id = {r["document_id"]: r for r in conn.execute(
            f"SELECT {_ENTRY_COLUMNS}, documents.* {joined} WHERE reading_queue.document_id IN "
            f"({','.join(str(int(i)) for i in page_ids) or 'NULL'})")}
        rows = [rows_by_id[i] for i in page_ids if i in rows_by_id]
    else:
        rows = conn.execute(
            f"SELECT {_ENTRY_COLUMNS}, documents.* {joined} {where} ORDER BY {SORTS[sort]} LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()

    ids = [int(row["document_id"]) for row in rows]
    pdfs = linked_pdfs(conn, ids)
    found = found_by(conn, ids)
    entries = []
    for row in rows:
        record = dict(row)
        # ``documents.*`` brings its own ``id``; the aliased queue columns are
        # already distinct. Both name the same paper.
        entries.append({
            "document_id": record["document_id"],
            "status": record["status"],
            "saved_at": record["saved_at"],
            "updated_at": record["updated_at"],
            "read_at": record["read_at"],
            "document": {key: record[key] for key in _DOCUMENT_KEYS if key in record},
            "pdf": pdfs.get(record["document_id"]),
            "found_by": found.get(record["document_id"]),
        })
    return {
        "entries": entries,
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "status": status,
        "counts": counts(conn),
        "sort": sort,
        "q": q,
    }


def linked_pdfs(conn: sqlite3.Connection, document_ids: list[int]) -> dict[int, dict]:
    """The Library PDF most recently linked to each paper, by id; absent where there is none."""
    if not document_ids:
        return {}
    literals = ",".join(str(int(i)) for i in document_ids)
    out: dict[int, dict] = {}
    for row in conn.execute(
            "SELECT l.document_id, f.vault_id, f.file_id, f.version_id, f.sha256, f.byte_size, f.original_name "
            "FROM library_file_documents l JOIN library_files f ON f.file_id = l.file_id "
            f"WHERE l.document_id IN ({literals}) AND f.media_type = 'application/pdf' "
            "ORDER BY l.linked_at_utc DESC, f.id DESC"):
        out.setdefault(int(row["document_id"]), {
            key: row[key] for key in ("vault_id", "file_id", "version_id", "sha256", "byte_size", "original_name")})
    return out


def found_by(conn: sqlite3.Connection, document_ids: list[int]) -> dict[int, dict]:
    """The first run that collected each paper: a watch's (with its name while it exists) or a search."""
    if not document_ids:
        return {}
    literals = ",".join(str(int(i)) for i in document_ids)
    out: dict[int, dict] = {}
    for row in conn.execute(
            "SELECT first.document_id, e.id AS execution_id, e.execution_type, e.routine_id, r.name AS routine_name, "
            "e.start_time FROM (SELECT document_id, min(execution_id) AS execution_id FROM execution_documents "
            f"WHERE document_id IN ({literals}) GROUP BY document_id) AS first "
            "JOIN executions e ON e.id = first.execution_id LEFT JOIN routines r ON r.id = e.routine_id"):
        out[int(row["document_id"])] = {
            "execution_id": row["execution_id"],
            "kind": "watch" if row["execution_type"] == "automated_sweep" else "search",
            "watch_id": row["routine_id"],
            "watch_name": row["routine_name"],
            "at": row["start_time"],
        }
    return out


def statuses_for(conn: sqlite3.Connection, document_ids: list[int]) -> dict:
    """``{document_id: status}`` for the ids that are in the queue.

    An id missing from the mapping is not saved. The absent key is the answer,
    rather than a third status value that the database does not have.
    """
    ids = [int(i) for i in document_ids]
    if not ids:
        return {}
    # Only normalized integer literals reach SQL, and one IN list rather than
    # one bind per id: a page of results can exceed SQLite's variable limit on
    # some builds, which is the failure ``get_documents_by_ids`` already
    # carries a regression for.
    literals = ",".join(str(i) for i in ids)
    return {
        int(row["document_id"]): row["status"]
        for row in conn.execute(
            f"SELECT document_id, status FROM reading_queue "
            f"WHERE document_id IN ({literals})"
        )
    }
