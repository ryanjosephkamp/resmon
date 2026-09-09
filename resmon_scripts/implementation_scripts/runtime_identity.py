"""Ephemeral serving-process identity, separate from corpus and build provenance."""
import os
import sqlite3
from uuid import UUID, uuid4

_runtime_id = str(uuid4())


def _after_fork() -> None:
    global _runtime_id
    _runtime_id = str(uuid4())


# A preloaded ASGI application must not lend its parent's token to fork workers.
if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork)


def current_runtime_id() -> str:
    return _runtime_id


def valid_runtime_id(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = UUID(value)
        return parsed.version == 4 and str(parsed) == value
    except ValueError:
        return False


def project(conn: sqlite3.Connection) -> dict:
    # Read saved metadata; a release version cannot tell us this database's schema.
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key = 'schema_version'").fetchone()
        schema = int(row[0]) if row else None
    except (sqlite3.Error, ValueError, TypeError):
        schema = None
    return {"contract_version": 1, "runtime_id": current_runtime_id(),
            "schema_version": schema, "corpus_id": None, "build_id": None}
