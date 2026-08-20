# resmon_scripts/implementation_scripts/database.py
"""SQLite database layer: schema creation, connection management, and CRUD operations."""

import json
import logging
import sqlite3
from pathlib import Path

from .config import DEFAULT_DB_PATH

# ---------------------------------------------------------------------------
# Schema DDL
# ---------------------------------------------------------------------------

logger = logging.getLogger(__name__)

_SCHEMA_SQL = """\
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_repository TEXT NOT NULL,
    external_id TEXT NOT NULL,
    doi TEXT,
    title TEXT NOT NULL,
    authors TEXT,
    abstract TEXT,
    publication_date TEXT,
    url TEXT,
    categories TEXT,
    metadata_hash TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    pub_sort TEXT GENERATED ALWAYS AS (COALESCE(publication_date, '')) VIRTUAL,
    UNIQUE(source_repository, external_id)
);

CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_type TEXT NOT NULL CHECK(execution_type IN ('deep_dive', 'deep_sweep', 'automated_sweep')),
    routine_id INTEGER,
    saved_configuration_id INTEGER,
    parameters TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
    result_count INTEGER DEFAULT 0,
    new_result_count INTEGER DEFAULT 0,
    log_path TEXT,
    result_path TEXT,
    error_message TEXT,
    progress_events TEXT,
    current_stage TEXT,
    FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE SET NULL,
    FOREIGN KEY (saved_configuration_id) REFERENCES saved_configurations(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS execution_documents (
    execution_id INTEGER NOT NULL,
    document_id INTEGER NOT NULL,
    is_new INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (execution_id, document_id),
    FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    schedule_cron TEXT NOT NULL,
    parameters TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    email_enabled INTEGER NOT NULL DEFAULT 0,
    email_ai_summary_enabled INTEGER NOT NULL DEFAULT 0,
    ai_enabled INTEGER NOT NULL DEFAULT 0,
    notify_on_complete INTEGER NOT NULL DEFAULT 0,
    ai_settings TEXT,
    storage_settings TEXT,
    execution_location TEXT NOT NULL DEFAULT 'local'
        CHECK (execution_location IN ('local', 'cloud')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_executed_at TEXT
);

CREATE TABLE IF NOT EXISTS saved_configurations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    config_type TEXT NOT NULL CHECK(config_type IN ('manual_dive', 'manual_sweep', 'routine')),
    parameters TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cloud_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'google_drive',
    account_info TEXT,
    is_linked INTEGER NOT NULL DEFAULT 0,
    auto_backup_enabled INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,
    sync_status TEXT DEFAULT 'idle' CHECK(sync_status IN ('idle', 'syncing', 'error'))
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Search and faceting support (Phase 2b)
-- ---------------------------------------------------------------------------
--
-- ``documents`` had no indexes at all beyond the implicit UNIQUE on
-- (source_repository, external_id). Every filter was a full table scan, which
-- is invisible at a few hundred papers and unusable at a hundred thousand.
--
-- Authors and categories are stored on ``documents`` as comma-joined strings,
-- which is fine for display but cannot be filtered or counted without reading
-- every row. These two tables normalise them so both are index-backed. They are
-- derived data: ``documents`` remains the source of truth and the strings are
-- still written there unchanged.

CREATE TABLE IF NOT EXISTS document_authors (
    document_id INTEGER NOT NULL,
    author      TEXT NOT NULL,
    PRIMARY KEY (document_id, author),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_authors_author
    ON document_authors(author);

CREATE TABLE IF NOT EXISTS document_categories (
    document_id INTEGER NOT NULL,
    category    TEXT NOT NULL,
    PRIMARY KEY (document_id, category),
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_categories_category
    ON document_categories(category);

-- Filter columns, and the explorer's sort key.
--
-- pub_sort exists because the sort key must be a *column*, not an expression.
-- SQLite will not match a row-value comparison against an expression index, so
-- ordering directly on COALESCE(publication_date,'') compiled to a SCAN and was
-- slower than the LIMIT/OFFSET it was meant to replace. Measured on 100,000
-- papers at row 90,000:
--
--     expression index + row-value cursor   SCAN     3.83 ms
--     LIMIT/OFFSET                          SCAN     1.66 ms
--     pub_sort column + row-value cursor    SEARCH   0.08 ms
--
-- The COALESCE is still load-bearing: undated papers sort last as '', and a
-- row-value comparison against a real NULL yields NULL, which would silently
-- drop every undated paper out of pagination. VIRTUAL rather than STORED so
-- ALTER TABLE can add it to an existing database -- SQLite refuses to add a
-- STORED generated column in place. The index stores the computed value, which
-- is what makes the seek fast; VIRTUAL only means the column is not duplicated
-- in the row.
CREATE INDEX IF NOT EXISTS idx_documents_source
    ON documents(source_repository);
-- idx_documents_pubsort is NOT created here. It references pub_sort, and on a
-- database that predates that column CREATE TABLE IF NOT EXISTS is a no-op, so
-- the column does not exist yet when this script runs and the whole script
-- fails with "no such column: pub_sort" -- taking the backend down with it.
-- _migrate_pub_sort adds the column and then the index, in that order, for
-- both fresh and existing databases.
CREATE INDEX IF NOT EXISTS idx_documents_first_seen
    ON documents(first_seen_at);

"""

# Schema version constants. Bumped by IMPL-36 (→2), IMPL-37 (→3), and
# Update 3 / 4_27_26 (→4) which adds ``executions.saved_configuration_id``
# linking each manual execution back to the saved configuration it was
# launched from (or saved as).
SCHEMA_VERSION = 5
_SCHEMA_VERSION_KEY = "schema_version"

# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------


def get_connection(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Return a sqlite3.Connection with WAL mode, foreign keys, and Row factory."""
    # ``str(db_path)`` used to be applied to whatever was passed. Handing this
    # function a Connection - easy to do, because ``init_db`` takes both a
    # ``db_path`` and a ``conn`` - stringified it to
    # "<sqlite3.Connection object at 0x...>" and created a real database file
    # under that name instead of raising. The caller then operated on an empty
    # database and never found out.
    if db_path is not None and not isinstance(db_path, (str, Path)):
        raise TypeError(
            "get_connection() expects a str, Path, or None for db_path, got "
            f"{type(db_path).__name__}. If you meant to reuse an existing "
            "connection, pass it as the keyword argument conn=... instead."
        )
    path = str(db_path) if db_path else str(DEFAULT_DB_PATH)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db(db_path: str | Path | None = None, *, conn: sqlite3.Connection | None = None) -> None:
    """Create all tables if they do not exist. Accepts an existing connection or a path."""
    if conn is None:
        conn = get_connection(db_path)
        own_conn = True
    else:
        # Ensure pragmas on passed-in connections (e.g. :memory:)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON;")
        own_conn = False

    # pub_sort must exist before _SCHEMA_SQL runs, because an older database
    # reaching this point already has a documents table without it.
    if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'"
    ).fetchone():
        _migrate_pub_sort(conn)

    conn.executescript(_SCHEMA_SQL)
    _migrate_executions_columns(conn)
    _migrate_routines_columns(conn)
    _migrate_pub_sort(conn)
    _migrate_search_index(conn)
    _migrate_schema_version(conn)
    # Commit before returning. Since BUG-020 each thread holds its own
    # connection, so schema left inside an open transaction on this one is
    # invisible to every other -- an in-memory database shared through
    # cache=shared then answers "no such table: executions" on the next
    # connection to touch it.
    conn.commit()

    if own_conn:
        conn.close()


def _migrate_executions_columns(conn: sqlite3.Connection) -> None:
    """Add progress_events, current_stage, cancel_reason, saved_configuration_id columns if missing."""
    cursor = conn.execute("PRAGMA table_info(executions)")
    existing = {row[1] for row in cursor.fetchall()}
    if "progress_events" not in existing:
        conn.execute("ALTER TABLE executions ADD COLUMN progress_events TEXT")
    if "current_stage" not in existing:
        conn.execute("ALTER TABLE executions ADD COLUMN current_stage TEXT")
    if "cancel_reason" not in existing:
        conn.execute("ALTER TABLE executions ADD COLUMN cancel_reason TEXT")
    # Update 3 / 4_27_26: link each manual execution back to the saved
    # configuration it was launched from (ConfigLoader-initiated runs)
    # or saved as later (Save Config button on Calendar/Dashboard/
    # Results & Logs). Nullable; ON DELETE SET NULL is enforced by the
    # CREATE TABLE statement for new databases. ALTER TABLE in SQLite
    # cannot add a FOREIGN KEY clause to an existing column, but the
    # behaviour we need (graceful nulling on config delete) is enforced
    # at the application layer in delete_configuration_endpoint and is
    # also a no-op when the column is NULL.
    if "saved_configuration_id" not in existing:
        conn.execute(
            "ALTER TABLE executions ADD COLUMN saved_configuration_id INTEGER"
        )
    conn.commit()


def _migrate_routines_columns(conn: sqlite3.Connection) -> None:
    """Add columns to ``routines`` introduced after the original schema.

    * ``notify_on_complete`` (IMPL-10 ergonomics).
    * ``execution_location`` (IMPL-37, §14.1) — where a routine is
      scheduled. Only ``'local'`` is meaningful now that the cloud service
      is gone; the column is kept because dropping it would mean rebuilding
      the table on every existing install for no functional gain.

    Any routine still marked ``'cloud'`` is flipped back to ``'local'``.
    Its scheduler was deleted, so it would otherwise sit in the UI looking
    active while never firing again.
    """
    cursor = conn.execute("PRAGMA table_info(routines)")
    existing = {row[1] for row in cursor.fetchall()}
    if "notify_on_complete" not in existing:
        conn.execute(
            "ALTER TABLE routines ADD COLUMN notify_on_complete INTEGER NOT NULL DEFAULT 0"
        )
    if "execution_location" not in existing:
        conn.execute(
            "ALTER TABLE routines ADD COLUMN execution_location "
            "TEXT NOT NULL DEFAULT 'local' "
            "CHECK (execution_location IN ('local', 'cloud'))"
        )
    else:
        # Pre-existing rows only. The CHECK constraint still permits 'cloud'
        # on databases created before this release; rewriting it would need a
        # full table rebuild, and nothing writes that value any more.
        conn.execute(
            "UPDATE routines SET execution_location = 'local' "
            "WHERE execution_location != 'local'"
        )
    conn.commit()


def _split_list_field(raw: str | None) -> list[str]:
    """Split a stored comma-joined field back into its parts."""
    if not raw:
        return []
    seen, out = set(), []
    for part in str(raw).split(","):
        part = part.strip()
        if part and part not in seen:
            seen.add(part)
            out.append(part)
    return out


def index_document_facets(conn: sqlite3.Connection, document_id: int,
                          authors: str | None, categories: str | None) -> None:
    """Populate the normalised author/category rows for one document."""
    conn.executemany(
        "INSERT OR IGNORE INTO document_authors (document_id, author) VALUES (?, ?)",
        [(document_id, a) for a in _split_list_field(authors)],
    )
    conn.executemany(
        "INSERT OR IGNORE INTO document_categories (document_id, category) VALUES (?, ?)",
        [(document_id, c) for c in _split_list_field(categories)],
    )


def _migrate_pub_sort(conn: sqlite3.Connection) -> None:
    """Add the explorer's sort column and its index.

    Runs for fresh and existing databases alike, and must run *before* anything
    references ``pub_sort``. The index deliberately lives here rather than in
    ``_SCHEMA_SQL``: on a database created before this column existed,
    ``CREATE TABLE IF NOT EXISTS`` is a no-op, so the column is absent when the
    schema script runs and ``CREATE INDEX ... (pub_sort ...)`` fails the entire
    script with ``no such column: pub_sort``. That took the backend down on
    startup for every user upgrading from an earlier version.
    """
    # table_xinfo, not table_info: the latter omits generated columns entirely,
    # so the check would never see pub_sort and would try to add it on every
    # single startup.
    cols = {r[1] for r in conn.execute("PRAGMA table_xinfo(documents)")}
    if "pub_sort" not in cols:
        conn.execute(
            "ALTER TABLE documents ADD COLUMN pub_sort TEXT "
            "GENERATED ALWAYS AS (COALESCE(publication_date, '')) VIRTUAL"
        )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_documents_pubsort "
        "ON documents(pub_sort DESC, id DESC)"
    )
    conn.commit()


def _migrate_search_index(conn: sqlite3.Connection) -> None:
    """Create the full-text index and backfill facets for existing corpora.

    Free-text search over titles and abstracts is the one filter that cannot be
    served by an ordinary index: ``LIKE '%term%'`` has no usable prefix, so
    SQLite reads every abstract in the table. At a hundred thousand papers that
    is tens of megabytes scanned per query. FTS5 builds an inverted index and
    turns the same search into a lookup.

    The index is *external-content*: it stores only the tokens and refers back
    to ``documents`` by rowid, so abstracts are not duplicated on disk. Triggers
    keep it in step with inserts, updates and deletes.

    Backfill is idempotent and runs once. On a database that predates this
    schema it populates the facet tables and the FTS index from what is already
    there; on a fresh one it is a no-op.
    """
    # Whether the index existed *before* this call is the only reliable signal
    # that it needs backfilling. COUNT(*) on an external-content FTS table reads
    # from the content table, not from the index, so comparing the two counts
    # always says "equal" and the rebuild never runs -- which left every paper
    # collected before the upgrade silently unsearchable.
    fts_existed = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents_fts'"
    ).fetchone() is not None

    try:
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
                title, abstract, authors,
                content='documents',
                content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            )
            """
        )
    except sqlite3.OperationalError:
        # FTS5 is compiled into every mainstream Python build, but if it is
        # missing the explorer falls back to LIKE rather than failing to start.
        logger.warning("FTS5 unavailable; free-text search will use a slower scan")
        return

    conn.executescript(
        """
        CREATE TRIGGER IF NOT EXISTS documents_fts_insert AFTER INSERT ON documents BEGIN
            INSERT INTO documents_fts(rowid, title, abstract, authors)
            VALUES (new.id, new.title, new.abstract, new.authors);
        END;
        CREATE TRIGGER IF NOT EXISTS documents_fts_delete AFTER DELETE ON documents BEGIN
            INSERT INTO documents_fts(documents_fts, rowid, title, abstract, authors)
            VALUES ('delete', old.id, old.title, old.abstract, old.authors);
        END;
        CREATE TRIGGER IF NOT EXISTS documents_fts_update AFTER UPDATE ON documents BEGIN
            INSERT INTO documents_fts(documents_fts, rowid, title, abstract, authors)
            VALUES ('delete', old.id, old.title, old.abstract, old.authors);
            INSERT INTO documents_fts(rowid, title, abstract, authors)
            VALUES (new.id, new.title, new.abstract, new.authors);
        END;
        """
    )

    # Backfill, once. Compare counts rather than keeping a flag, so a database
    # restored from a partial backup repairs itself.
    doc_count = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    if doc_count:
        if not fts_existed:
            conn.execute("INSERT INTO documents_fts(documents_fts) VALUES ('rebuild')")

        faceted = conn.execute(
            "SELECT COUNT(DISTINCT document_id) FROM document_authors"
        ).fetchone()[0]
        if faceted < doc_count:
            for row in conn.execute(
                "SELECT id, authors, categories FROM documents"
            ).fetchall():
                index_document_facets(conn, row["id"] if hasattr(row, "keys") else row[0],
                                      row["authors"] if hasattr(row, "keys") else row[1],
                                      row["categories"] if hasattr(row, "keys") else row[2])
    conn.commit()


def _migrate_schema_version(conn: sqlite3.Connection) -> None:
    """Record / bump the schema_version in app_settings.

    5 dropped the four cloud-mirror tables along with the cloud service.
    Existing databases keep whatever those tables already held — they are
    empty on every real install, because the service never ran — but nothing
    reads or creates them any more.
    """
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = ?", (_SCHEMA_VERSION_KEY,)
    ).fetchone()
    current = int(row[0]) if row else 0
    if current < SCHEMA_VERSION:
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (_SCHEMA_VERSION_KEY, str(SCHEMA_VERSION)),
        )
        conn.commit()


def get_schema_version(conn: sqlite3.Connection) -> int:
    """Return the current SQLite schema version (0 if never initialized)."""
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = ?", (_SCHEMA_VERSION_KEY,)
    ).fetchone()
    return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# Documents CRUD
# ---------------------------------------------------------------------------


def insert_document(conn: sqlite3.Connection, doc: dict) -> int | None:
    """INSERT OR IGNORE a document. Returns the row id or None if ignored."""
    sql = """\
        INSERT OR IGNORE INTO documents
            (source_repository, external_id, doi, title, authors, abstract,
             publication_date, url, categories, metadata_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    cursor = conn.execute(sql, (
        doc["source_repository"],
        doc["external_id"],
        doc.get("doi"),
        doc["title"],
        doc.get("authors"),
        doc.get("abstract"),
        doc.get("publication_date"),
        doc.get("url"),
        doc.get("categories"),
        doc["metadata_hash"],
    ))
    doc_id = cursor.lastrowid if cursor.rowcount > 0 else None
    if doc_id:
        # Keep the normalised facet tables in step. The FTS index maintains
        # itself through triggers; these two cannot, because they split a
        # comma-joined string that SQL has no clean way to parse.
        index_document_facets(conn, doc_id, doc.get("authors"), doc.get("categories"))
    conn.commit()
    return doc_id


def get_document_by_source(conn: sqlite3.Connection, source: str, external_id: str) -> dict | None:
    """Fetch a single document by source repository and external ID."""
    row = conn.execute(
        "SELECT * FROM documents WHERE source_repository = ? AND external_id = ?",
        (source, external_id),
    ).fetchone()
    return dict(row) if row else None


def find_duplicates_by_hash(conn: sqlite3.Connection, metadata_hash: str) -> list[dict]:
    """Find all documents sharing the given metadata hash (cross-source duplicates)."""
    rows = conn.execute(
        "SELECT * FROM documents WHERE metadata_hash = ?",
        (metadata_hash,),
    ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Executions CRUD
# ---------------------------------------------------------------------------


def insert_execution(conn: sqlite3.Connection, exec_dict: dict) -> int:
    """Create a new execution record. Returns its ID.

    ``saved_configuration_id`` (Update 3 / 4_27_26) is optional and links
    the new execution back to the ``saved_configurations`` row it was
    launched from when the user picked a config in the ConfigLoader on
    the Deep Dive / Deep Sweep pages. ``None`` is the default for
    ad-hoc runs and routine fires.
    """
    sql = """\
        INSERT INTO executions
            (execution_type, routine_id, saved_configuration_id, parameters, start_time, status)
        VALUES (?, ?, ?, ?, ?, ?)
    """
    cursor = conn.execute(sql, (
        exec_dict["execution_type"],
        exec_dict.get("routine_id"),
        exec_dict.get("saved_configuration_id"),
        exec_dict["parameters"],
        exec_dict["start_time"],
        exec_dict.get("status", "running"),
    ))
    conn.commit()
    return cursor.lastrowid


def update_execution_status(
    conn: sqlite3.Connection,
    exec_id: int,
    status: str,
    *,
    end_time: str | None = None,
    result_count: int | None = None,
    new_result_count: int | None = None,
    log_path: str | None = None,
    result_path: str | None = None,
    error_message: str | None = None,
    cancel_reason: str | None = None,
) -> None:
    """Update execution fields (status and optional kwargs)."""
    fields = ["status = ?"]
    params: list = [status]

    optional = {
        "end_time": end_time,
        "result_count": result_count,
        "new_result_count": new_result_count,
        "log_path": log_path,
        "result_path": result_path,
        "error_message": error_message,
        "cancel_reason": cancel_reason,
    }
    for col, val in optional.items():
        if val is not None:
            fields.append(f"{col} = ?")
            params.append(val)

    params.append(exec_id)
    sql = f"UPDATE executions SET {', '.join(fields)} WHERE id = ?"
    conn.execute(sql, params)
    conn.commit()


def get_execution_documents(
    conn: sqlite3.Connection,
    execution_id: int,
    only_new: bool = False,
) -> list[dict]:
    """Return the documents an execution found, newest publication first.

    ``only_new=True`` restricts the result to papers that were new to this user
    at the time of the run, which is usually what someone wants to import into a
    reference manager -- the rest are already in their library.
    """
    sql = """
        SELECT documents.*
        FROM documents
        JOIN execution_documents ON execution_documents.document_id = documents.id
        WHERE execution_documents.execution_id = ?
    """
    params: list = [execution_id]
    if only_new:
        sql += " AND execution_documents.is_new = 1"
    sql += " ORDER BY documents.publication_date DESC, documents.id DESC"
    return [dict(row) for row in conn.execute(sql, params).fetchall()]


def get_documents_by_ids(conn: sqlite3.Connection, ids: list[int]) -> list[dict]:
    """Return documents for an explicit selection of ids."""
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT * FROM documents WHERE id IN ({placeholders}) "
        "ORDER BY publication_date DESC, id DESC",
        [int(i) for i in ids],
    ).fetchall()
    return [dict(row) for row in rows]


def link_execution_document(
    conn: sqlite3.Connection, exec_id: int, doc_id: int, is_new: bool = True
) -> None:
    """Insert into the execution_documents junction table."""
    conn.execute(
        "INSERT OR IGNORE INTO execution_documents (execution_id, document_id, is_new) VALUES (?, ?, ?)",
        (exec_id, doc_id, int(is_new)),
    )
    conn.commit()


def get_executions(
    conn: sqlite3.Connection,
    limit: int = 50,
    offset: int = 0,
    execution_type: str | None = None,
) -> list[dict]:
    """Paginated execution history, optionally filtered by type.

    LEFT JOINs ``saved_configurations`` so each row carries a denormalized
    ``saved_configuration_name`` field (NULL when the execution is not
    linked to a saved config). The JOIN happens at read time so renames
    of the underlying config row are reflected without any backfill.
    """
    base = (
        "SELECT executions.*, saved_configurations.name AS saved_configuration_name "
        "FROM executions "
        "LEFT JOIN saved_configurations "
        "  ON saved_configurations.id = executions.saved_configuration_id "
    )
    if execution_type:
        rows = conn.execute(
            base
            + "WHERE executions.execution_type = ? "
            "ORDER BY executions.start_time DESC LIMIT ? OFFSET ?",
            (execution_type, limit, offset),
        ).fetchall()
    else:
        rows = conn.execute(
            base
            + "ORDER BY executions.start_time DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [dict(r) for r in rows]


def get_execution_by_id(conn: sqlite3.Connection, exec_id: int) -> dict | None:
    """Fetch a single execution by ID, with the joined saved_configuration_name."""
    row = conn.execute(
        "SELECT executions.*, saved_configurations.name AS saved_configuration_name "
        "FROM executions "
        "LEFT JOIN saved_configurations "
        "  ON saved_configurations.id = executions.saved_configuration_id "
        "WHERE executions.id = ?",
        (exec_id,),
    ).fetchone()
    return dict(row) if row else None


def set_execution_saved_configuration(
    conn: sqlite3.Connection, exec_id: int, saved_configuration_id: int | None
) -> None:
    """Stamp / clear the saved_configuration_id link on an execution row (Update 3)."""
    conn.execute(
        "UPDATE executions SET saved_configuration_id = ? WHERE id = ?",
        (saved_configuration_id, exec_id),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Routines CRUD
# ---------------------------------------------------------------------------


def insert_routine(conn: sqlite3.Connection, routine_dict: dict) -> int:
    """Create a new routine definition. Returns its ID."""
    sql = """\
        INSERT INTO routines
            (name, schedule_cron, parameters, is_active, email_enabled,
             email_ai_summary_enabled, ai_enabled, ai_settings, storage_settings,
             notify_on_complete, execution_location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    loc = routine_dict.get("execution_location", "local")
    if loc != "local":
        raise ValueError(
            f"execution_location must be 'local', got {loc!r}. Cloud-scheduled "
            f"routines were removed along with the cloud service."
        )
    cursor = conn.execute(sql, (
        routine_dict["name"],
        routine_dict["schedule_cron"],
        routine_dict["parameters"],
        routine_dict.get("is_active", 1),
        routine_dict.get("email_enabled", 0),
        routine_dict.get("email_ai_summary_enabled", 0),
        routine_dict.get("ai_enabled", 0),
        routine_dict.get("ai_settings"),
        routine_dict.get("storage_settings"),
        routine_dict.get("notify_on_complete", 0),
        loc,
    ))
    conn.commit()
    return cursor.lastrowid


def update_routine(conn: sqlite3.Connection, routine_id: int, updates: dict) -> None:
    """Update routine fields from a dict of {column: value} pairs."""
    allowed = {
        "name", "schedule_cron", "parameters", "is_active", "email_enabled",
        "email_ai_summary_enabled", "ai_enabled", "ai_settings",
        "storage_settings", "last_executed_at", "notify_on_complete",
        "execution_location",
    }
    filtered = {k: v for k, v in updates.items() if k in allowed}
    if not filtered:
        return
    if "execution_location" in filtered and filtered["execution_location"] != "local":
        raise ValueError(
            f"execution_location must be 'local', got "
            f"{filtered['execution_location']!r}. Cloud-scheduled routines were "
            f"removed along with the cloud service."
        )
    # Always bump updated_at
    filtered["updated_at"] = "datetime('now')"

    set_parts = []
    params: list = []
    for col, val in filtered.items():
        if val == "datetime('now')":
            set_parts.append(f"{col} = datetime('now')")
        else:
            set_parts.append(f"{col} = ?")
            params.append(val)

    params.append(routine_id)
    sql = f"UPDATE routines SET {', '.join(set_parts)} WHERE id = ?"
    conn.execute(sql, params)
    conn.commit()


def delete_routine(conn: sqlite3.Connection, routine_id: int) -> None:
    """Delete a routine by ID.

    Also cascades the matching APScheduler job row in ``apscheduler_jobs``
    so the persistent jobstore cannot retain a ghost row pointing at a
    routine that no longer exists. The cascade is tolerant of the
    jobstore table not existing yet (e.g., when no scheduler has ever
    been started against this database file, as in many test fixtures).
    The APScheduler ``id`` column is stored as TEXT and uses the
    string-form of the routine id, so cast accordingly.
    """
    conn.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
    try:
        conn.execute(
            "DELETE FROM apscheduler_jobs WHERE id = ?", (str(routine_id),)
        )
    except sqlite3.OperationalError:
        # apscheduler_jobs table not present (no scheduler has touched
        # this DB file). Nothing to cascade; not an error.
        pass
    conn.commit()


def get_routines(conn: sqlite3.Connection, active_only: bool = False) -> list[dict]:
    """Fetch routines, optionally filtered to active only."""
    if active_only:
        rows = conn.execute(
            "SELECT * FROM routines WHERE is_active = 1 ORDER BY created_at DESC"
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM routines ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


def get_routine_by_id(conn: sqlite3.Connection, routine_id: int) -> dict | None:
    """Fetch a single routine by ID."""
    row = conn.execute("SELECT * FROM routines WHERE id = ?", (routine_id,)).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Saved Configurations CRUD
# ---------------------------------------------------------------------------


def insert_configuration(conn: sqlite3.Connection, config_dict: dict) -> int:
    """Save a named configuration. Returns its ID."""
    sql = """\
        INSERT INTO saved_configurations (name, config_type, parameters)
        VALUES (?, ?, ?)
    """
    cursor = conn.execute(sql, (
        config_dict["name"],
        config_dict["config_type"],
        config_dict["parameters"],
    ))
    conn.commit()
    return cursor.lastrowid


def update_configuration(conn: sqlite3.Connection, config_id: int, updates: dict) -> None:
    """Update a saved configuration's name and/or parameters."""
    allowed = {"name", "parameters"}
    filtered = {k: v for k, v in updates.items() if k in allowed}
    if not filtered:
        return

    set_parts = []
    params: list = []
    for col, val in filtered.items():
        set_parts.append(f"{col} = ?")
        params.append(val)
    set_parts.append("updated_at = datetime('now')")

    params.append(config_id)
    sql = f"UPDATE saved_configurations SET {', '.join(set_parts)} WHERE id = ?"
    conn.execute(sql, params)
    conn.commit()


def delete_configuration(conn: sqlite3.Connection, config_id: int) -> None:
    """Delete a saved configuration by ID.

    Update 3 / 4_27_26: also null out ``executions.saved_configuration_id``
    for any execution that linked back to this config so the "Saved as"
    badge stops referencing a now-orphaned row. The ``CREATE TABLE``
    FK clause already does this for fresh databases, but databases
    migrated from older schemas have the column without a FK declaration
    (SQLite ``ALTER TABLE`` cannot add FK constraints), so we do it
    explicitly for parity.
    """
    conn.execute(
        "UPDATE executions SET saved_configuration_id = NULL WHERE saved_configuration_id = ?",
        (config_id,),
    )
    conn.execute("DELETE FROM saved_configurations WHERE id = ?", (config_id,))
    conn.commit()


def get_configurations(
    conn: sqlite3.Connection, config_type: str | None = None
) -> list[dict]:
    """Fetch configurations, optionally filtered by type."""
    if config_type:
        rows = conn.execute(
            "SELECT * FROM saved_configurations WHERE config_type = ? ORDER BY created_at DESC",
            (config_type,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM saved_configurations ORDER BY created_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# App Settings CRUD
# ---------------------------------------------------------------------------


def get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    """Fetch an application setting by key. Returns the value or None."""
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    """Upsert an application setting."""
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Progress Events CRUD
# ---------------------------------------------------------------------------


def save_progress_events(conn: sqlite3.Connection, exec_id: int, events: list[dict]) -> None:
    """Persist JSON-serialized progress events for a completed execution."""
    conn.execute(
        "UPDATE executions SET progress_events = ? WHERE id = ?",
        (json.dumps(events, default=str), exec_id),
    )
    conn.commit()


def get_progress_events(conn: sqlite3.Connection, exec_id: int) -> list[dict]:
    """Retrieve persisted progress events for an execution. Returns empty list if none."""
    row = conn.execute(
        "SELECT progress_events FROM executions WHERE id = ?",
        (exec_id,),
    ).fetchone()
    if row and row["progress_events"]:
        return json.loads(row["progress_events"])
    return []


def update_current_stage(conn: sqlite3.Connection, exec_id: int, stage: str) -> None:
    """Update the current_stage column for a running execution."""
    conn.execute(
        "UPDATE executions SET current_stage = ? WHERE id = ?",
        (stage, exec_id),
    )
    conn.commit()
