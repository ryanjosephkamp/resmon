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



def process_is_alive(pid: object) -> bool:
    """Whether ``pid`` names a live process, erring towards alive.

    The one implementation of a rule three call sites used to restate: startup
    reconciliation in ``resmon``, ``delivery.requeue_orphaned`` and
    ``selected_evidence_runtime``'s ``_startup``. ``os.kill(pid, 0)`` raises
    ``ProcessLookupError`` only when the kernel is certain there is no such
    process. A ``PermissionError`` (the pid belongs to another user) or any
    other ``OSError`` means we could not tell, and a pid that has been reused
    since answers for whatever holds it now -- all of those read as alive,
    because PID reuse is a conservative refusal and never proof of death.

    A value that is not a positive ``int`` -- ``None``, ``True``, ``0``, a
    string -- is not a pid at all and reads as dead: there is nothing to ask
    about. Callers that treat "no pid recorded" as a reason to stay cautious
    make that decision before calling, because it is a different question.
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def valid_runtime_id(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = UUID(value)
        return parsed.version == 4 and str(parsed) == value
    except ValueError:
        return False


def valid_identity(value: object) -> bool:
    """Require the v1 identity shape rather than treating one token as a contract."""
    if not isinstance(value, dict):
        return False
    required = {"contract_version", "runtime_id", "schema_version", "corpus_id", "build_id"}
    return (required <= value.keys() and type(value["contract_version"]) is int
            and value["contract_version"] == 1 and valid_runtime_id(value["runtime_id"])
            and (value["schema_version"] is None or type(value["schema_version"]) is int)
            and value["corpus_id"] is None and value["build_id"] is None)


def project(conn: sqlite3.Connection) -> dict:
    # Read saved metadata; a release version cannot tell us this database's schema.
    try:
        row = conn.execute("SELECT value FROM app_settings WHERE key = 'schema_version'").fetchone()
        schema = int(row[0]) if row else None
    except (sqlite3.Error, ValueError, TypeError):
        schema = None
    return {"contract_version": 1, "runtime_id": current_runtime_id(),
            "schema_version": schema, "corpus_id": None, "build_id": None}
