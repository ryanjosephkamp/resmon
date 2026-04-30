# resmon_scripts/implementation_scripts/database.py
"""SQLite database layer: schema creation, connection management, and CRUD operations."""

import json
import sqlite3
from pathlib import Path

from .config import DEFAULT_DB_PATH

# ---------------------------------------------------------------------------
# Schema DDL
# ---------------------------------------------------------------------------

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

-- IMPL-36: cloud-sync mirror of executions and routines, plus on-disk
-- artifact cache metadata and the cursor-sync state table (§14.1).
CREATE TABLE IF NOT EXISTS cloud_executions (
    execution_id      TEXT PRIMARY KEY,          -- cloud UUID
    routine_id        TEXT,                      -- cloud UUID or NULL
    status            TEXT NOT NULL,
    started_at        TEXT NOT NULL,
    finished_at       TEXT,
    cancel_reason     TEXT,
    artifact_uri      TEXT,
    stats             TEXT,                      -- JSON
    version           INTEGER NOT NULL DEFAULT 0,
    synced_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cloud_routines (
    routine_id        TEXT PRIMARY KEY,          -- cloud UUID
    name              TEXT NOT NULL,
    cron              TEXT NOT NULL,
    parameters        TEXT NOT NULL,             -- JSON
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    version           INTEGER NOT NULL DEFAULT 0,
    synced_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cloud_cache_meta (
    execution_id      TEXT NOT NULL,             -- cloud UUID
    artifact_name     TEXT NOT NULL,
    local_path        TEXT NOT NULL,
    bytes             INTEGER NOT NULL,
    downloaded_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (execution_id, artifact_name)
);

CREATE TABLE IF NOT EXISTS sync_state (
    k                 TEXT PRIMARY KEY,          -- e.g. 'last_synced_version'
    v                 TEXT NOT NULL,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

# Schema version constants. Bumped by IMPL-36 (→2), IMPL-37 (→3), and
# Update 3 / 4_27_26 (→4) which adds ``executions.saved_configuration_id``
# linking each manual execution back to the saved configuration it was
# launched from (or saved as).
SCHEMA_VERSION = 4
_SCHEMA_VERSION_KEY = "schema_version"

# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------


def get_connection(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Return a sqlite3.Connection with WAL mode, foreign keys, and Row factory."""
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

    conn.executescript(_SCHEMA_SQL)
    _migrate_executions_columns(conn)
    _migrate_routines_columns(conn)
    _migrate_schema_version(conn)

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
      scheduled: ``'local'`` for the local daemon (default) or
      ``'cloud'`` for the resmon-cloud scheduler.
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
    conn.commit()


def _migrate_schema_version(conn: sqlite3.Connection) -> None:
    """Record / bump the schema_version in app_settings (IMPL-36)."""
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
    conn.commit()
    return cursor.lastrowid if cursor.rowcount > 0 else None


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
    if loc not in ("local", "cloud"):
        raise ValueError(f"execution_location must be 'local' or 'cloud', got {loc!r}")
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
    if "execution_location" in filtered and filtered["execution_location"] not in (
        "local",
        "cloud",
    ):
        raise ValueError(
            f"execution_location must be 'local' or 'cloud', got "
            f"{filtered['execution_location']!r}"
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
    """Delete a routine by ID."""
    conn.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
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


# ---------------------------------------------------------------------------
# Cloud-Sync Mirror CRUD (IMPL-36, §§12 + 14.1)
#
# The cloud-mirror tables (``cloud_executions``, ``cloud_routines``) hold a
# read-only copy of rows that live authoritatively in the cloud Postgres
# schema. The desktop uses them to render the merged Results view and the
# Dashboard "Last cloud sync" card without re-fetching from the cloud on
# every render. The cursor (``last_synced_version``) is persisted in
# ``sync_state`` so a restart does not reset the sync window.
# ---------------------------------------------------------------------------


def upsert_cloud_routine(conn: sqlite3.Connection, row: dict) -> None:
    """Insert-or-replace a cloud routine row (keyed by cloud UUID)."""
    conn.execute(
        """
        INSERT INTO cloud_routines
            (routine_id, name, cron, parameters, enabled,
             created_at, updated_at, version, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(routine_id) DO UPDATE SET
            name        = excluded.name,
            cron        = excluded.cron,
            parameters  = excluded.parameters,
            enabled     = excluded.enabled,
            created_at  = excluded.created_at,
            updated_at  = excluded.updated_at,
            version     = excluded.version,
            synced_at   = datetime('now')
        """,
        (
            str(row["routine_id"]),
            row.get("name", ""),
            row.get("cron", ""),
            json.dumps(row.get("parameters") or {}),
            1 if row.get("enabled", True) else 0,
            row.get("created_at") or "",
            row.get("updated_at") or "",
            int(row.get("version") or 0),
        ),
    )
    conn.commit()


def upsert_cloud_execution(conn: sqlite3.Connection, row: dict) -> None:
    """Insert-or-replace a cloud execution row (keyed by cloud UUID)."""
    stats = row.get("stats")
    conn.execute(
        """
        INSERT INTO cloud_executions
            (execution_id, routine_id, status, started_at, finished_at,
             cancel_reason, artifact_uri, stats, version, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(execution_id) DO UPDATE SET
            routine_id     = excluded.routine_id,
            status         = excluded.status,
            started_at     = excluded.started_at,
            finished_at    = excluded.finished_at,
            cancel_reason  = excluded.cancel_reason,
            artifact_uri   = excluded.artifact_uri,
            stats          = excluded.stats,
            version        = excluded.version,
            synced_at      = datetime('now')
        """,
        (
            str(row["execution_id"]),
            str(row["routine_id"]) if row.get("routine_id") else None,
            row.get("status", "unknown"),
            row.get("started_at") or "",
            row.get("finished_at"),
            row.get("cancel_reason"),
            row.get("artifact_uri"),
            json.dumps(stats) if stats is not None else None,
            int(row.get("version") or 0),
        ),
    )
    conn.commit()


def get_cloud_executions(conn: sqlite3.Connection, limit: int = 500) -> list[dict]:
    """Return cloud-mirror executions newest-first."""
    rows = conn.execute(
        "SELECT execution_id, routine_id, status, started_at, finished_at, "
        "cancel_reason, artifact_uri, stats, version, synced_at "
        "FROM cloud_executions ORDER BY started_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        d = dict(r)
        if d.get("stats"):
            try:
                d["stats"] = json.loads(d["stats"])
            except Exception:
                pass
        out.append(d)
    return out


def get_cloud_routines(conn: sqlite3.Connection) -> list[dict]:
    """Return cloud-mirror routines (insertion order by created_at DESC)."""
    rows = conn.execute(
        "SELECT routine_id, name, cron, parameters, enabled, "
        "created_at, updated_at, version, synced_at "
        "FROM cloud_routines ORDER BY created_at DESC"
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        d = dict(r)
        if d.get("parameters"):
            try:
                d["parameters"] = json.loads(d["parameters"])
            except Exception:
                pass
        d["enabled"] = bool(d["enabled"])
        out.append(d)
    return out


def clear_cloud_mirror(conn: sqlite3.Connection) -> None:
    """Wipe every cloud-mirror row (used on sign-out per V-G3)."""
    conn.execute("DELETE FROM cloud_executions")
    conn.execute("DELETE FROM cloud_routines")
    conn.execute("DELETE FROM cloud_cache_meta")
    conn.execute("DELETE FROM sync_state")
    conn.commit()


# ---------------------------------------------------------------------------
# Sync cursor state
# ---------------------------------------------------------------------------


def get_sync_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute(
        "SELECT v FROM sync_state WHERE k = ?", (key,)
    ).fetchone()
    return row[0] if row else None


def set_sync_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO sync_state (k, v, updated_at) "
        "VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime('now')",
        (key, value),
    )
    conn.commit()


def get_last_synced_version(conn: sqlite3.Connection) -> int:
    raw = get_sync_state(conn, "last_synced_version")
    try:
        return int(raw) if raw else 0
    except (TypeError, ValueError):
        return 0


def set_last_synced_version(conn: sqlite3.Connection, version: int) -> None:
    set_sync_state(conn, "last_synced_version", str(int(version)))


# ---------------------------------------------------------------------------
# Cloud artifact cache metadata + LRU eviction
# ---------------------------------------------------------------------------


def record_cloud_cache_entry(
    conn: sqlite3.Connection,
    execution_id: str,
    artifact_name: str,
    local_path: str,
    size_bytes: int,
) -> None:
    conn.execute(
        """
        INSERT INTO cloud_cache_meta
            (execution_id, artifact_name, local_path, bytes,
             downloaded_at, last_accessed_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(execution_id, artifact_name) DO UPDATE SET
            local_path       = excluded.local_path,
            bytes            = excluded.bytes,
            downloaded_at    = excluded.downloaded_at,
            last_accessed_at = excluded.last_accessed_at
        """,
        (str(execution_id), artifact_name, local_path, int(size_bytes)),
    )
    conn.commit()


def touch_cloud_cache_entry(
    conn: sqlite3.Connection, execution_id: str, artifact_name: str
) -> None:
    conn.execute(
        "UPDATE cloud_cache_meta SET last_accessed_at = datetime('now') "
        "WHERE execution_id = ? AND artifact_name = ?",
        (str(execution_id), artifact_name),
    )
    conn.commit()


def get_cloud_cache_entry(
    conn: sqlite3.Connection, execution_id: str, artifact_name: str
) -> dict | None:
    row = conn.execute(
        "SELECT execution_id, artifact_name, local_path, bytes, "
        "downloaded_at, last_accessed_at FROM cloud_cache_meta "
        "WHERE execution_id = ? AND artifact_name = ?",
        (str(execution_id), artifact_name),
    ).fetchone()
    return dict(row) if row else None


def get_cloud_cache_total_bytes(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(bytes), 0) AS total FROM cloud_cache_meta"
    ).fetchone()
    return int(row[0]) if row else 0


def list_cloud_cache_entries_lru(conn: sqlite3.Connection) -> list[dict]:
    """Return cache entries ordered oldest-accessed first (LRU tail first)."""
    rows = conn.execute(
        "SELECT execution_id, artifact_name, local_path, bytes, "
        "downloaded_at, last_accessed_at FROM cloud_cache_meta "
        "ORDER BY last_accessed_at ASC"
    ).fetchall()
    return [dict(r) for r in rows]


def delete_cloud_cache_entry(
    conn: sqlite3.Connection, execution_id: str, artifact_name: str
) -> None:
    conn.execute(
        "DELETE FROM cloud_cache_meta WHERE execution_id = ? AND artifact_name = ?",
        (str(execution_id), artifact_name),
    )
    conn.commit()


# Default cache ceiling per §11.2 of resmon_routines_and_accounts.md (1 GB).
CLOUD_CACHE_MAX_BYTES_DEFAULT = 1024 * 1024 * 1024


def evict_cloud_cache_if_needed(
    conn: sqlite3.Connection,
    *,
    max_bytes: int = CLOUD_CACHE_MAX_BYTES_DEFAULT,
    unlink: bool = True,
) -> list[dict]:
    """Evict LRU cache entries (optionally removing files) until
    ``total_bytes <= max_bytes``. Returns the evicted metadata rows.
    """
    evicted: list[dict] = []
    total = get_cloud_cache_total_bytes(conn)
    if total <= max_bytes:
        return evicted
    for entry in list_cloud_cache_entries_lru(conn):
        if total <= max_bytes:
            break
        if unlink:
            try:
                Path(entry["local_path"]).unlink(missing_ok=True)
            except Exception:
                pass
        delete_cloud_cache_entry(
            conn, entry["execution_id"], entry["artifact_name"]
        )
        total -= int(entry["bytes"])
        evicted.append(entry)
    return evicted
