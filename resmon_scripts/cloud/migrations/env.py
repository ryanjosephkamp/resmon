"""Alembic runtime entry point for ``resmon-cloud`` migrations.

This file is executed by the Alembic CLI (``alembic upgrade head`` /
``alembic downgrade base``). It loads the database URL from ``DATABASE_URL``
(12-factor per §7.2 of the routines plan) so that migrations do not require
an ``alembic.ini`` override at deploy time.

Importing this module outside of the Alembic runtime is a no-op: the
migration-execution branch runs only when ``alembic.context`` has a real
config attached, which Alembic does only for its own invocations.
"""
from __future__ import annotations

import os

from alembic import context
from sqlalchemy import engine_from_config, pool


# No declarative metadata yet — the initial revision applies raw DDL via
# ``op.execute``. Autogenerate support arrives with later revisions.
target_metadata = None


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL must be set to run resmon-cloud migrations."
        )
    return url


def _is_alembic_runtime() -> bool:
    """True only when Alembic's CLI has configured this env."""
    try:
        return context.config is not None  # raises outside Alembic runtime
    except Exception:
        return False


def run_migrations_offline() -> None:
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        {"sqlalchemy.url": _database_url()},
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if _is_alembic_runtime():
    if context.is_offline_mode():
        run_migrations_offline()
    else:
        run_migrations_online()
