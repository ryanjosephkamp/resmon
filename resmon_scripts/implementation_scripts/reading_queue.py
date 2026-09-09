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


def remove(conn: sqlite3.Connection, document_id: int) -> bool:
    """Drop the membership row. The paper, its provenance and its runs stay.

    Returns whether there was anything to remove, so a second click can be
    answered honestly instead of reported as a removal that did not happen.
    """
    document_id = int(document_id)
    cursor = conn.execute(
        "DELETE FROM reading_queue WHERE document_id = ?", (document_id,)
    )
    conn.commit()
    return cursor.rowcount > 0


def counts(conn: sqlite3.Connection) -> dict:
    """How many entries are in each state, and in total."""
    result = {TO_READ: 0, READ: 0}
    for row in conn.execute(
        "SELECT status, COUNT(*) AS n FROM reading_queue GROUP BY status"
    ):
        result[row["status"]] = int(row["n"])
    result["all"] = result[TO_READ] + result[READ]
    return result


def list_entries(
    conn: sqlite3.Connection,
    *,
    status: str | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
    offset: int = 0,
) -> dict:
    """One page of the queue, newest save first, with each paper's metadata.

    ``status=None`` is the *All* filter. The order is ``saved_at`` then
    ``document_id``, both descending, matching
    ``idx_reading_queue_status_saved``; the id is in the sort so two papers
    saved in the same second cannot swap places between two page requests and
    show one of them twice.
    """
    if status is not None and status not in STATUSES:
        raise ValueError(
            f"Unknown reading status {status!r}. Expected one of: "
            + ", ".join(STATUSES)
        )
    limit = int(limit)
    offset = int(offset)
    if limit < 1 or limit > MAX_PAGE_SIZE:
        raise ValueError(f"limit must be between 1 and {MAX_PAGE_SIZE}")
    if offset < 0:
        raise ValueError("offset must not be negative")

    where = ""
    params: list = []
    if status is not None:
        where = "WHERE reading_queue.status = ?"
        params.append(status)

    total = conn.execute(
        f"SELECT COUNT(*) FROM reading_queue {where}", params
    ).fetchone()[0]
    rows = conn.execute(
        f"SELECT {_ENTRY_COLUMNS}, documents.* FROM reading_queue "
        "JOIN documents ON documents.id = reading_queue.document_id "
        f"{where} "
        "ORDER BY reading_queue.saved_at DESC, reading_queue.document_id DESC "
        "LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()

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
            "document": {
                key: record[key] for key in (
                    "id", "source_repository", "external_id", "doi", "title",
                    "authors", "abstract", "publication_date", "url",
                    "categories", "first_seen_at",
                ) if key in record
            },
        })
    return {
        "entries": entries,
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "status": status,
        "counts": counts(conn),
    }


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
