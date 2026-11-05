"""Collections inside the one database: which papers each holds, and moving them.

A paper is stored once. ``collection_documents`` says which collections hold
it, when it arrived in each, and how (``database.COLLECTION_ARRIVALS``): a
run, a move, a copy, the upgrade that made collections, or ``kept``, for a
paper left in no other collection when its own was deleted.

Rules this module keeps:

- **Every paper is in at least one collection.** A move adds the paper to its
  target before taking it out of its source; deleting a collection files the
  papers only it held in the default collection first; and a launch files any
  paper left in no collection (``database._migrate_collections``).
- **Nothing here deletes a paper.** Moving, copying, and deleting a
  collection change memberships only. Erasing papers is the Danger zone's.
- **The default collection** (``database.DEFAULT_COLLECTION_ID``) can be
  renamed and never deleted, so a read that names no collection, as every
  client before collections did, always has one to mean.
- **The current collection** is the one the app shows, remembered by the
  engine (``app_settings``), not by a window: a window's own choice, where it
  has one, is sent with each request.

A collection is named by its id or its name wherever a client names one
(``resolve``): the command line and the MCP server take either.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Iterable, Optional, Sequence

from .database import (
    COLLECTION_ARRIVALS,
    DEFAULT_COLLECTION_ID,
    get_setting,
    set_setting,
)

#: The ``app_settings`` key holding the current collection's id.
CURRENT_KEY = "current_collection"
#: The longest name a collection takes; the table's CHECK says the same.
NAME_MAX = 80
#: How many papers one move, copy, or undo may name by id. A selection larger
#: than this is moved by its search instead (``ids_matching``).
IDS_MAX = 100_000
#: How a paper arrived in a collection that Today counts as new there: found
#: by a run, or there since before collections existed (whose arrival is the
#: paper's first-seen time). A paper the person moved or copied in, or one
#: kept from a deleted collection, is not news to them.
NEW_ARRIVALS = ("run", "upgrade")

#: The clause that keeps a query over ``documents`` to one collection's papers.
#: It takes one parameter, the collection's id. A correlated EXISTS rather than
#: ``IN (SELECT ...)``: each row is one lookup in the membership's primary key,
#: so a query read in ``pub_sort`` order with a LIMIT stops as soon as its page
#: is full instead of first reading the whole collection.
MEMBER_SQL = ("EXISTS (SELECT 1 FROM collection_documents cm "
              "WHERE cm.collection_id = ? AND cm.document_id = {column})")


def member_clause(column: str = "documents.id") -> str:
    """``MEMBER_SQL`` for a query whose paper id is *column*."""
    return MEMBER_SQL.format(column=column)


class CollectionError(Exception):
    """A request about collections the engine refuses, with its reason and the words to show."""

    def __init__(self, reason: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.status = status


def _iso(value: Optional[str]) -> Optional[str]:
    """``2026-11-05 06:30:36`` (UTC, as SQLite writes it) as ``2026-11-05T06:30:36Z``."""
    if not value:
        return None
    return value.replace(" ", "T", 1) + ("" if value.endswith("Z") else "Z")


# ---------------------------------------------------------------------------
# Naming a collection
# ---------------------------------------------------------------------------


def exists(conn: sqlite3.Connection, collection_id: int) -> bool:
    return conn.execute("SELECT 1 FROM collections WHERE id = ?", (int(collection_id),)).fetchone() is not None


def holds_every_paper(conn: sqlite3.Connection, collection_id: Optional[int]) -> bool:
    """Whether *collection_id* is the only collection, and so holds every paper.

    Every paper is in at least one collection: a new one is filed in the
    default, and a move, an undo, or a deleted collection never leaves one in
    none. So while there is one collection, a read of it needs no membership
    clause, and costs what a read of the whole database does.
    """
    if collection_id is None:
        return False
    row = conn.execute("SELECT COUNT(*), MAX(id) FROM collections").fetchone()
    return row[0] == 1 and row[1] == int(collection_id)


def name_of(conn: sqlite3.Connection, collection_id: int) -> Optional[str]:
    row = conn.execute("SELECT name FROM collections WHERE id = ?", (int(collection_id),)).fetchone()
    return str(row[0]) if row else None


def resolve(conn: sqlite3.Connection, ref: Any) -> int:
    """The id of the collection *ref* names: an id, a name (any case), or nothing.

    Nothing (``None`` or blank) is the default collection, which is what a
    client from before collections means. A number is an id; a name is matched
    without regard to case. A digit string is an id when one exists by that
    number and otherwise a name, so a collection named "2026" can still be named.
    """
    if ref is None or (isinstance(ref, str) and not ref.strip()):
        return DEFAULT_COLLECTION_ID
    if isinstance(ref, bool):
        raise CollectionError("not_found", f"There is no collection {ref!r}.", 404)
    if isinstance(ref, int):
        if exists(conn, ref):
            return ref
        raise CollectionError("not_found", f"There is no collection {ref}.", 404)
    text = str(ref).strip()
    if text.isdigit() and exists(conn, int(text)):
        return int(text)
    row = conn.execute("SELECT id FROM collections WHERE name = ?", (text,)).fetchone()
    if row is None:
        raise CollectionError("not_found", f"There is no collection named “{text}”.", 404)
    return int(row[0])


def clean_name(name: Any) -> str:
    """A collection's name as stored: trimmed, inner spaces kept, 1 to ``NAME_MAX`` characters."""
    text = " ".join(str(name or "").split())
    if not text:
        raise CollectionError("name_empty", "A collection needs a name.")
    if len(text) > NAME_MAX:
        raise CollectionError("name_too_long", f"A collection's name is at most {NAME_MAX} characters.")
    return text


def _refuse_taken(conn: sqlite3.Connection, name: str, other_than: Optional[int] = None) -> None:
    row = conn.execute("SELECT id, name FROM collections WHERE name = ?", (name,)).fetchone()
    if row is not None and int(row[0]) != other_than:
        raise CollectionError("name_taken", f"There is already a collection named “{row[1]}”.", 409)


# ---------------------------------------------------------------------------
# Reading collections
# ---------------------------------------------------------------------------


def revision(conn: sqlite3.Connection, collection_id: int) -> int:
    """How many times this collection's papers have changed: a cache's key."""
    row = conn.execute("SELECT revision FROM collections WHERE id = ?", (int(collection_id),)).fetchone()
    return int(row[0]) if row else -1


def _watch_target_sql() -> str:
    # A watch whose collection was deleted under it before a launch put it right
    # is the default collection's: NULL never means "nowhere".
    return f"COALESCE(collection_id, {DEFAULT_COLLECTION_ID})"


def summaries(conn: sqlite3.Connection) -> list[dict]:
    """Every collection, the default first and then in the order they were made.

    ``papers`` counts the papers each holds and ``watches`` the watches whose
    runs put their papers there.
    """
    papers = dict(conn.execute(
        "SELECT collection_id, COUNT(*) FROM collection_documents GROUP BY collection_id").fetchall())
    watches = dict(conn.execute(
        f"SELECT {_watch_target_sql()}, COUNT(*) FROM routines GROUP BY 1").fetchall())
    out = []
    for row in conn.execute("SELECT id, name, created_at FROM collections ORDER BY id"):
        cid = int(row["id"])
        out.append({
            "id": cid,
            "name": row["name"],
            "is_default": cid == DEFAULT_COLLECTION_ID,
            "papers": int(papers.get(cid, 0)),
            "watches": int(watches.get(cid, 0)),
            "created_at": _iso(row["created_at"]),
        })
    return out


def summary(conn: sqlite3.Connection, collection_id: int) -> dict:
    for each in summaries(conn):
        if each["id"] == int(collection_id):
            return each
    raise CollectionError("not_found", f"There is no collection {collection_id}.", 404)


def detail(conn: sqlite3.Connection, collection_id: int) -> dict:
    """One collection, with what deleting it would do.

    ``only_here`` counts the papers no other collection holds: deleting this
    one files them in the default collection. ``also_elsewhere`` counts the
    rest, which stay where else they are. ``watch_list`` names the watches that
    put their papers here; deleting it points them at the default collection.
    """
    base = summary(conn, collection_id)
    only_here = int(conn.execute(
        "SELECT COUNT(*) FROM collection_documents m WHERE m.collection_id = ? AND NOT EXISTS ("
        "SELECT 1 FROM collection_documents o WHERE o.document_id = m.document_id "
        "AND o.collection_id <> m.collection_id)", (int(collection_id),)).fetchone()[0])
    watch_list = [
        {"id": int(r["id"]), "name": r["name"]}
        for r in conn.execute(
            f"SELECT id, name FROM routines WHERE {_watch_target_sql()} = ? "
            "ORDER BY name COLLATE NOCASE, id", (int(collection_id),))
    ]
    return {**base, "only_here": only_here, "also_elsewhere": base["papers"] - only_here,
            "watch_list": watch_list}


def of_document(conn: sqlite3.Connection, document_id: int) -> list[dict]:
    """The collections one paper is in, the default first, with when and how it arrived in each."""
    return [
        {"id": int(r["id"]), "name": r["name"], "added_at": _iso(r["added_at"]),
         "added_by": r["added_by"], "execution_id": r["execution_id"]}
        for r in conn.execute(
            "SELECT c.id, c.name, m.added_at, m.added_by, m.execution_id "
            "FROM collection_documents m JOIN collections c ON c.id = m.collection_id "
            "WHERE m.document_id = ? ORDER BY c.id", (int(document_id),))
    ]


def watch_target(conn: sqlite3.Connection, routine: dict) -> int:
    """Where a watch's papers land: its collection, or the default one if that is gone."""
    raw = routine.get("collection_id")
    if raw is not None and exists(conn, int(raw)):
        return int(raw)
    return DEFAULT_COLLECTION_ID


# ---------------------------------------------------------------------------
# The current collection
# ---------------------------------------------------------------------------


def current(conn: sqlite3.Connection) -> int:
    """The collection the app shows: the one last chosen, or the default if it is gone."""
    raw = get_setting(conn, CURRENT_KEY)
    try:
        chosen = int(raw) if raw is not None else DEFAULT_COLLECTION_ID
    except (TypeError, ValueError):
        return DEFAULT_COLLECTION_ID
    return chosen if exists(conn, chosen) else DEFAULT_COLLECTION_ID


def set_current(conn: sqlite3.Connection, collection_id: int) -> int:
    if not exists(conn, collection_id):
        raise CollectionError("not_found", f"There is no collection {collection_id}.", 404)
    set_setting(conn, CURRENT_KEY, str(int(collection_id)))
    return int(collection_id)


# ---------------------------------------------------------------------------
# Making, renaming, and deleting
# ---------------------------------------------------------------------------


def create(conn: sqlite3.Connection, name: Any) -> dict:
    text = clean_name(name)
    _refuse_taken(conn, text)
    cursor = conn.execute("INSERT INTO collections (name) VALUES (?)", (text,))
    conn.commit()
    return summary(conn, int(cursor.lastrowid))


def rename(conn: sqlite3.Connection, collection_id: int, name: Any) -> dict:
    if not exists(conn, collection_id):
        raise CollectionError("not_found", f"There is no collection {collection_id}.", 404)
    text = clean_name(name)
    _refuse_taken(conn, text, other_than=int(collection_id))
    conn.execute("UPDATE collections SET name = ? WHERE id = ?", (text, int(collection_id)))
    conn.commit()
    return summary(conn, collection_id)


def delete(conn: sqlite3.Connection, collection_id: int) -> dict:
    """Delete a collection. Its papers stay in the database.

    In one transaction: the papers no other collection holds are filed in the
    default collection (as ``kept``), the watches that put their papers here
    are pointed at the default collection, the current collection moves to the
    default if it was this one, and the collection goes, taking its
    memberships with it. A paper also in another collection stays there.
    """
    cid = int(collection_id)
    if cid == DEFAULT_COLLECTION_ID:
        raise CollectionError(
            "default", "The default collection can be renamed but not deleted: a paper "
            "in no other collection is kept there.", 409)
    found = detail(conn, cid)
    conn.execute("SAVEPOINT collection_delete")
    try:
        kept = conn.execute(
            "INSERT OR IGNORE INTO collection_documents (collection_id, document_id, added_by) "
            "SELECT ?, m.document_id, 'kept' FROM collection_documents m "
            "WHERE m.collection_id = ? AND NOT EXISTS (SELECT 1 FROM collection_documents o "
            "WHERE o.document_id = m.document_id AND o.collection_id <> m.collection_id)",
            (DEFAULT_COLLECTION_ID, cid)).rowcount
        moved = conn.execute(
            "UPDATE routines SET collection_id = ? WHERE collection_id = ?",
            (DEFAULT_COLLECTION_ID, cid)).rowcount
        if current(conn) == cid:
            # Written here rather than through ``set_setting``, which commits,
            # and a commit would end this savepoint half done.
            conn.execute("UPDATE app_settings SET value = ? WHERE key = ?",
                         (str(DEFAULT_COLLECTION_ID), CURRENT_KEY))
        # Its Today's last look (``today.looked_key``) goes with it.
        conn.execute("DELETE FROM app_settings WHERE key = ?", (f"today_looked_at.{cid}",))
        conn.execute("DELETE FROM collection_documents WHERE collection_id = ?", (cid,))
        conn.execute("DELETE FROM collections WHERE id = ?", (cid,))
        conn.execute("RELEASE collection_delete")
    except BaseException:
        conn.execute("ROLLBACK TO collection_delete")
        conn.execute("RELEASE collection_delete")
        raise
    conn.commit()
    return {
        "id": cid,
        "name": found["name"],
        "papers": found["papers"],
        "kept_in_default": int(kept),
        "still_elsewhere": found["papers"] - int(kept),
        "watches_moved": int(moved),
        "default_id": DEFAULT_COLLECTION_ID,
    }


# ---------------------------------------------------------------------------
# Filing, copying, moving, and undoing
# ---------------------------------------------------------------------------


def _unique_ids(ids: Iterable[Any]) -> list[int]:
    seen: set[int] = set()
    out: list[int] = []
    for raw in ids:
        value = int(raw)
        if value not in seen:
            seen.add(value)
            out.append(value)
    if len(out) > IDS_MAX:
        raise CollectionError(
            "too_many", f"One move or copy names at most {IDS_MAX:,} papers by id; move a "
            "larger selection by its search.")
    return out


def _existing(conn: sqlite3.Connection, ids: Sequence[int]) -> list[int]:
    """The ids among *ids* that are papers in the database, in the order given."""
    found: set[int] = set()
    for start in range(0, len(ids), 500):
        chunk = list(ids[start:start + 500])
        marks = ",".join("?" * len(chunk))
        found.update(int(r[0]) for r in conn.execute(f"SELECT id FROM documents WHERE id IN ({marks})", chunk))
    return [i for i in ids if i in found]


def _members(conn: sqlite3.Connection, collection_id: int, ids: Sequence[int]) -> set[int]:
    held: set[int] = set()
    for start in range(0, len(ids), 500):
        chunk = list(ids[start:start + 500])
        marks = ",".join("?" * len(chunk))
        held.update(int(r[0]) for r in conn.execute(
            f"SELECT document_id FROM collection_documents WHERE collection_id = ? AND document_id IN ({marks})",
            (int(collection_id), *chunk)))
    return held


def file_papers(conn: sqlite3.Connection, collection_id: int, ids: Iterable[int], *, how: str,
                execution_id: Optional[int] = None, commit: bool = True) -> int:
    """Put papers in a collection, leaving any already there as they were. Returns how many arrived."""
    if how not in COLLECTION_ARRIVALS:
        raise ValueError(f"{how!r} is not one of {COLLECTION_ARRIVALS}")
    rows = [(int(collection_id), int(i), how, execution_id) for i in ids]
    if not rows:
        return 0
    # ``rowcount`` sums the rows each insert made, and not the triggers' updates.
    arrived = conn.executemany(
        "INSERT OR IGNORE INTO collection_documents (collection_id, document_id, added_by, execution_id) "
        "VALUES (?, ?, ?, ?)", rows).rowcount
    if commit:
        conn.commit()
    return arrived


def file_run_papers(conn: sqlite3.Connection, collection_id: int, ids: Iterable[int], *,
                    execution_id: Optional[int] = None) -> int:
    """A run's papers into its collection, or the default one where that
    collection was deleted while the run went: each statement finds the
    collection as it writes, so a paper is never filed in one that is gone.
    Returns how many arrived."""
    rows = [(int(collection_id), DEFAULT_COLLECTION_ID, int(i), execution_id) for i in ids]
    if not rows:
        return 0
    arrived = conn.executemany(
        "INSERT OR IGNORE INTO collection_documents (collection_id, document_id, added_by, execution_id) "
        "SELECT COALESCE((SELECT id FROM collections WHERE id = ?), ?), ?, 'run', ?", rows).rowcount
    conn.commit()
    return arrived


def _target(conn: sqlite3.Connection, collection_id: int) -> int:
    if not exists(conn, collection_id):
        raise CollectionError("not_found", f"There is no collection {collection_id}.", 404)
    return int(collection_id)


def copy(conn: sqlite3.Connection, target_id: int, ids: Iterable[Any]) -> dict:
    """Add papers to a collection; every collection they were in keeps them.

    ``added`` lists the papers that arrived, which is what an undo takes out
    again. A paper already there is counted in ``already_there`` and left as it
    was; an id that is no paper is counted in ``missing``.
    """
    target = _target(conn, target_id)
    wanted = _unique_ids(ids)
    present = _existing(conn, wanted)
    held = _members(conn, target, present)
    added = [i for i in present if i not in held]
    conn.execute("SAVEPOINT collection_copy")
    try:
        file_papers(conn, target, added, how="copy", commit=False)
        conn.execute("RELEASE collection_copy")
    except BaseException:
        conn.execute("ROLLBACK TO collection_copy")
        conn.execute("RELEASE collection_copy")
        raise
    conn.commit()
    return {"mode": "copy", "collection_id": target, "from_collection_id": None, "added": added,
            "already_there": len(present) - len(added), "removed": [], "not_in_source": 0,
            "missing": len(wanted) - len(present)}


def move(conn: sqlite3.Connection, source_id: int, target_id: int, ids: Iterable[Any]) -> dict:
    """Move papers from one collection to another. Nothing leaves the database.

    Only papers in the source move (``not_in_source`` counts the rest). Each
    joins the target, unless it is already there, and then leaves the source,
    so at no point is it in no collection. ``removed`` carries each source
    membership as it was (when the paper arrived there and how), which is what
    an undo puts back.
    """
    source = _target(conn, source_id)
    target = _target(conn, target_id)
    if source == target:
        raise CollectionError("same_collection", "The papers are already in that collection.")
    wanted = _unique_ids(ids)
    present = _existing(conn, wanted)
    in_source = _members(conn, source, present)
    moving = [i for i in present if i in in_source]
    held = _members(conn, target, moving)
    added = [i for i in moving if i not in held]
    removed: list[dict] = []
    conn.execute("SAVEPOINT collection_move")
    try:
        file_papers(conn, target, added, how="move", commit=False)
        for start in range(0, len(moving), 500):
            chunk = moving[start:start + 500]
            marks = ",".join("?" * len(chunk))
            removed.extend(
                {"document_id": int(r[0]), "added_at": r[1], "added_by": r[2], "execution_id": r[3]}
                for r in conn.execute(
                    "SELECT document_id, added_at, added_by, execution_id FROM collection_documents "
                    f"WHERE collection_id = ? AND document_id IN ({marks})", (source, *chunk)))
            conn.execute(
                f"DELETE FROM collection_documents WHERE collection_id = ? AND document_id IN ({marks})",
                (source, *chunk))
        conn.execute("RELEASE collection_move")
    except BaseException:
        conn.execute("ROLLBACK TO collection_move")
        conn.execute("RELEASE collection_move")
        raise
    conn.commit()
    order = {doc_id: n for n, doc_id in enumerate(moving)}
    removed.sort(key=lambda row: order[row["document_id"]])
    return {"mode": "move", "collection_id": target, "from_collection_id": source, "added": added,
            "already_there": len(moving) - len(added), "removed": removed,
            "not_in_source": len(present) - len(moving), "missing": len(wanted) - len(present)}


def undo(conn: sqlite3.Connection, target_id: int, added: Iterable[Any],
         source_id: Optional[int] = None, removed: Sequence[dict] = ()) -> dict:
    """Undo a move or a copy, from what it answered.

    The papers it ``added`` to the target leave the target; the memberships it
    ``removed`` from the source are put back exactly as they were. A paper is
    put back before any is taken out, so none is ever in no collection; a
    removal that would leave a paper in no collection is skipped and counted.
    A run that has since been deleted is no longer named on a membership put back.
    """
    target = _target(conn, target_id)
    taken = _unique_ids(added)
    rows = list(removed)
    if rows and source_id is None:
        raise CollectionError("no_source", "An undo that puts papers back needs the collection they came from.")
    source = _target(conn, source_id) if source_id is not None else None
    for row in rows:
        if row.get("added_by") not in COLLECTION_ARRIVALS:
            raise CollectionError("bad_arrival", f"{row.get('added_by')!r} is not how a paper arrives.")
    conn.execute("SAVEPOINT collection_undo")
    restored = left = 0
    try:
        for row in rows:
            execution = row.get("execution_id")
            if execution is not None and conn.execute(
                    "SELECT 1 FROM executions WHERE id = ?", (int(execution),)).fetchone() is None:
                execution = None
            if conn.execute("SELECT 1 FROM documents WHERE id = ?", (int(row["document_id"]),)).fetchone() is None:
                continue
            restored += conn.execute(
                "INSERT OR IGNORE INTO collection_documents "
                "(collection_id, document_id, added_at, added_by, execution_id) "
                "VALUES (?, ?, COALESCE(NULLIF(?, ''), datetime('now')), ?, ?)",
                (source, int(row["document_id"]), str(row.get("added_at") or ""), row["added_by"],
                 execution)).rowcount
        for doc_id in taken:
            elsewhere = conn.execute(
                "SELECT 1 FROM collection_documents WHERE document_id = ? AND collection_id <> ?",
                (doc_id, target)).fetchone()
            if elsewhere is None:
                left += 1
                continue
            conn.execute("DELETE FROM collection_documents WHERE collection_id = ? AND document_id = ?",
                         (target, doc_id))
        conn.execute("RELEASE collection_undo")
    except BaseException:
        conn.execute("ROLLBACK TO collection_undo")
        conn.execute("RELEASE collection_undo")
        raise
    conn.commit()
    return {"collection_id": target, "from_collection_id": source, "taken_out": len(taken) - left,
            "put_back": int(restored), "left_in_place": left}


# ---------------------------------------------------------------------------
# Reading a collection from other modules
# ---------------------------------------------------------------------------

#: The collection a run's papers went to, as SQL over ``executions.parameters``:
#: the ``collection_id`` the run carries, and the default collection for a run
#: from before collections, which carries none.
RUN_COLLECTION_SQL = (
    "COALESCE(CASE WHEN json_valid(parameters) "
    "THEN CAST(json_extract(parameters, '$.collection_id') AS INTEGER) END, "
    f"{DEFAULT_COLLECTION_ID})"
)


def documents_in(collection_id: Optional[int]) -> str:
    """``documents`` kept to one collection's papers, to stand where a query says ``FROM documents``.

    ``None`` is every paper in the database. The id is an integer the caller
    resolved, written into the SQL as one, so the query keeps its own parameters.
    """
    if collection_id is None:
        return "documents"
    return (f"(SELECT * FROM documents WHERE {member_clause()}".replace("?", str(int(collection_id)), 1)
            + ") AS documents")
