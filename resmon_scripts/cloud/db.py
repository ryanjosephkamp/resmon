"""SQLAlchemy engine + row-level-security (RLS) scope helpers for resmon-cloud.

At IMPL-28 this module provides:

* :func:`get_engine` — process-wide SQLAlchemy engine built from
  :class:`CloudConfig.database_url`.
* :func:`reset_engine_for_testing` — drop the cached engine so tests can
  rebuild it against a fresh URL (e.g. a ``pytest-postgresql`` tmp DB).
* :func:`set_rls_user_id` — executes ``SET LOCAL resmon.user_id = '<uid>'``
  on an open transaction after validating the UUID.
* :func:`rls_session` — context-managed transaction that begins, applies
  the RLS GUC, yields the connection, and commits/rolls back.
* :func:`rls_dependency_factory` — FastAPI dependency that opens a
  per-request RLS-scoped transaction for authenticated ``/api/v2/*`` routes.
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from typing import Callable, Iterator, Optional

try:
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import Connection, Engine
except ModuleNotFoundError:  # pragma: no cover - optional at skeleton stage
    create_engine = None  # type: ignore[assignment]
    text = None  # type: ignore[assignment]
    Connection = object  # type: ignore[misc,assignment]
    Engine = object  # type: ignore[misc,assignment]

from .config import CloudConfig


_engine: Optional["Engine"] = None


def get_engine(config: CloudConfig) -> "Engine":
    """Return a process-wide SQLAlchemy engine, constructing it on first call."""
    global _engine
    if _engine is not None:
        return _engine
    if create_engine is None:
        raise RuntimeError(
            "SQLAlchemy is required for cloud DB access. "
            "Install with `pip install sqlalchemy`."
        )
    _engine = create_engine(config.database_url, future=True, pool_pre_ping=True)
    return _engine


def reset_engine_for_testing() -> None:
    """Drop the cached engine so tests can rebuild it against a new URL."""
    global _engine
    if _engine is not None:
        try:
            _engine.dispose()
        except Exception:
            pass
    _engine = None


# ---------------------------------------------------------------------------
# Row-level-security scope
# ---------------------------------------------------------------------------


def _validated_uid(user_id) -> str:
    """Coerce ``user_id`` to a canonical UUID string or raise ``ValueError``.

    ``SET LOCAL`` does **not** accept bind parameters for the value side of
    the assignment, so the UUID must be interpolated into the SQL text.
    Validating through :class:`uuid.UUID` guarantees the interpolated value
    is 36 hex-and-hyphen characters — all SQL-safe.
    """
    return str(uuid.UUID(str(user_id)))


def set_rls_user_id(conn: "Connection", user_id) -> None:
    """Run ``SET LOCAL resmon.user_id = '<uid>'`` on ``conn``."""
    if text is None:  # pragma: no cover - SQLAlchemy must be installed
        raise RuntimeError("SQLAlchemy is required for RLS scoping.")
    uid = _validated_uid(user_id)
    conn.execute(text(f"SET LOCAL resmon.user_id = '{uid}'"))


@contextmanager
def rls_session(config: CloudConfig, user_id) -> Iterator["Connection"]:
    """Yield a transaction-scoped connection with the RLS GUC applied."""
    engine = get_engine(config)
    with engine.begin() as conn:
        set_rls_user_id(conn, user_id)
        yield conn


def rls_dependency_factory(config_getter: Callable[[], CloudConfig]) -> Callable:
    """Return a FastAPI dependency that opens an RLS-scoped transaction."""

    def _dependency(current_user):  # type: ignore[no-untyped-def]
        cfg = config_getter()
        with rls_session(cfg, current_user.user_id) as conn:
            yield conn

    return _dependency
