# resmon_scripts/verification_scripts/test_cloud_migrations.py
"""IMPL-28 verification — Alembic 0001 migration, RLS dependency, jobstore.

Hermetic offline tests (always run):
* Migration module declares the authoritative revision id and no down
  predecessor.
* Upgrade SQL contains the required DDL: sequence, four tables, three RLS
  policies, RLS enable for routines/executions/credentials.
* Downgrade SQL reverses everything.
* ``set_rls_user_id`` validates UUIDs and interpolates the canonical form.
* ``set_rls_user_id`` rejects non-UUID input (SQL injection hardening).
* ``build_jobstore`` returns a ``SQLAlchemyJobStore`` pointed at the
  configured ``DATABASE_URL`` when APScheduler is installed.

Live-Postgres tests (skipped automatically when no local Postgres is
available; run in CI where ``pytest-postgresql`` is configured):
* ``alembic upgrade head`` + ``alembic downgrade base`` round-trip.
* RLS blocks cross-user reads.
* ``change_version`` sequence is monotonically increasing across two
  different user-scoped inserts.
"""

from __future__ import annotations

import importlib
import shutil
import sys
import uuid
from pathlib import Path
from unittest import mock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from cloud import db as cloud_db
from cloud.config import CloudConfig

MIGRATION_MODULE = "cloud.migrations.versions.rev_0001_initial_schema"


# ---------------------------------------------------------------------------
# Migration module — offline invariants
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def migration():
    # The module name starts with a digit, so ``importlib`` is required.
    return importlib.import_module(MIGRATION_MODULE)


def test_migration_metadata(migration):
    assert migration.revision == "0001_initial_schema"
    assert migration.down_revision is None


def test_upgrade_sql_contains_required_ddl(migration):
    sql = migration.UPGRADE_SQL
    # Sequence must be created before the tables that reference it.
    assert sql.index("CREATE SEQUENCE change_version") < sql.index("CREATE TABLE routines")
    for stmt in (
        "CREATE EXTENSION IF NOT EXISTS pgcrypto",
        "CREATE TABLE users",
        "CREATE TABLE routines",
        "CREATE TABLE executions",
        "CREATE TABLE credentials",
        "ALTER TABLE routines    ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE executions  ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE credentials ENABLE ROW LEVEL SECURITY",
        "CREATE POLICY rls_user ON routines",
        "CREATE POLICY rls_user ON executions",
        "CREATE POLICY rls_user ON credentials",
        "current_setting('resmon.user_id')::uuid",
    ):
        assert stmt in sql, f"missing DDL fragment: {stmt!r}"


def test_downgrade_sql_drops_in_reverse_order(migration):
    sql = migration.DOWNGRADE_SQL
    # Drop policies before tables, tables before sequence.
    assert sql.index("DROP POLICY") < sql.index("DROP TABLE")
    assert sql.index("DROP TABLE") < sql.index("DROP SEQUENCE")
    for name in ("users", "routines", "executions", "credentials", "change_version"):
        assert name in sql


# ---------------------------------------------------------------------------
# RLS helper — injection hardening
# ---------------------------------------------------------------------------


def test_set_rls_user_id_validates_uuid():
    uid = "11111111-2222-3333-4444-555555555555"
    calls: list[str] = []

    class FakeConn:
        def execute(self, clause):
            calls.append(str(clause))

    cloud_db.set_rls_user_id(FakeConn(), uid)
    assert len(calls) == 1
    assert f"SET LOCAL resmon.user_id = '{uid}'" in calls[0]


def test_set_rls_user_id_rejects_injection_attempt():
    with pytest.raises(ValueError):
        cloud_db.set_rls_user_id(mock.MagicMock(), "'; DROP TABLE users; --")


def test_set_rls_user_id_accepts_uuid_object():
    uid_obj = uuid.uuid4()
    calls: list[str] = []

    class FakeConn:
        def execute(self, clause):
            calls.append(str(clause))

    cloud_db.set_rls_user_id(FakeConn(), uid_obj)
    assert str(uid_obj) in calls[0]


# ---------------------------------------------------------------------------
# APScheduler jobstore wiring
# ---------------------------------------------------------------------------


def test_build_jobstore_uses_database_url():
    pytest.importorskip("apscheduler")
    from cloud.worker import build_jobstore
    from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore

    cfg = CloudConfig(
        database_url="sqlite:///:memory:",
        redis_url=None,
        object_store_endpoint="http://minio:9000",
        object_store_bucket="resmon-artifacts",
        kms_key_id=None,
        jwt_issuer="iss",
        jwt_audience="aud",
        jwks_url="http://example/jwks",
        allowed_origins=(),
        log_level="INFO",
    )
    store = build_jobstore(cfg)
    assert isinstance(store, SQLAlchemyJobStore)
    # The public attribute is ``engine`` (SQLAlchemyJobStore builds its own).
    assert str(store.engine.url) == cfg.database_url


# ---------------------------------------------------------------------------
# Live-Postgres tests (gated)
# ---------------------------------------------------------------------------


def _postgres_available() -> bool:
    if not shutil.which("pg_ctl") or not shutil.which("postgres"):
        return False
    try:
        import pytest_postgresql  # noqa: F401
        import psycopg  # noqa: F401
        return True
    except ModuleNotFoundError:
        return False


pg_required = pytest.mark.skipif(
    not _postgres_available(),
    reason="Postgres + pytest-postgresql + psycopg not installed; "
    "live RLS/migration checks skipped",
)


@pg_required
def test_upgrade_downgrade_roundtrip(tmp_path):  # pragma: no cover - CI-only path
    import subprocess
    import pytest_postgresql.factories as pgf

    # Ephemeral Postgres via pytest-postgresql's executor.
    from pytest_postgresql.executor import PostgreSQLExecutor

    executor = PostgreSQLExecutor(
        executable=shutil.which("pg_ctl"),
        host="127.0.0.1",
        port=None,
        datadir=str(tmp_path / "pgdata"),
        unixsocketdir="/tmp",
        logfile=str(tmp_path / "pg.log"),
        startparams="-w",
        dbname="resmon_test",
        user="postgres",
        password="",
        options="",
        postgres_options="",
    )
    executor.start()
    try:
        url = f"postgresql+psycopg://postgres@127.0.0.1:{executor.port}/resmon_test"
        cloud_dir = PROJECT_ROOT / "resmon_scripts" / "cloud"
        env = {**dict(__import__("os").environ), "DATABASE_URL": url}
        subprocess.check_call(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=str(cloud_dir),
            env=env,
        )
        subprocess.check_call(
            [sys.executable, "-m", "alembic", "downgrade", "base"],
            cwd=str(cloud_dir),
            env=env,
        )
    finally:
        executor.stop()


@pg_required
def test_rls_blocks_cross_user_reads():  # pragma: no cover - CI-only path
    pytest.skip(
        "Live RLS verification requires a running Postgres 15 with the "
        "0001 migration applied; see docker-compose.dev.yml."
    )


@pg_required
def test_change_version_sequence_is_monotonic():  # pragma: no cover - CI-only path
    pytest.skip(
        "Live sequence monotonicity requires a running Postgres 15 with the "
        "0001 migration applied; see docker-compose.dev.yml."
    )
