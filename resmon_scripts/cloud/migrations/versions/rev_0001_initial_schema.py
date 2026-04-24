"""Initial cloud schema — users, routines, executions, credentials, RLS.

Applies the DDL defined verbatim in §14.2 of
``resmon_routines_and_accounts.md`` with **one ordering adjustment**: the
``change_version`` sequence is created before the tables whose columns
reference it via ``DEFAULT nextval('change_version')``, because Postgres
resolves default expressions against the system catalog at ``CREATE TABLE``
time. The resulting schema is semantically identical to the plan doc.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-04-19
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0001_initial_schema"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


UPGRADE_SQL: str = """
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Sequence must exist before the tables that default to ``nextval`` from it.
CREATE SEQUENCE change_version AS BIGINT INCREMENT 1 START 1;

CREATE TABLE users (
    user_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idp_sub           TEXT UNIQUE NOT NULL,
    email             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled          BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE routines (
    routine_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users ON DELETE CASCADE,
    name              TEXT NOT NULL,
    parameters        JSONB NOT NULL,
    cron              TEXT NOT NULL,
    enabled           BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           BIGINT NOT NULL DEFAULT nextval('change_version')
);

CREATE TABLE executions (
    execution_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users ON DELETE CASCADE,
    routine_id        UUID REFERENCES routines ON DELETE SET NULL,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at       TIMESTAMPTZ,
    status            TEXT NOT NULL,
    cancel_reason     TEXT,
    artifact_uri      TEXT,
    stats             JSONB,
    version           BIGINT NOT NULL DEFAULT nextval('change_version')
);

CREATE TABLE credentials (
    user_id           UUID NOT NULL REFERENCES users ON DELETE CASCADE,
    key_name          TEXT NOT NULL,
    ciphertext        BYTEA NOT NULL,
    nonce             BYTEA NOT NULL,
    wrapped_dek       BYTEA NOT NULL,
    kek_id            TEXT NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    version           BIGINT NOT NULL DEFAULT nextval('change_version'),
    PRIMARY KEY (user_id, key_name)
);

-- Row-level security: keyed on the ``resmon.user_id`` session GUC.
ALTER TABLE routines    ENABLE ROW LEVEL SECURITY;
ALTER TABLE executions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_user ON routines    USING (user_id = current_setting('resmon.user_id')::uuid);
CREATE POLICY rls_user ON executions  USING (user_id = current_setting('resmon.user_id')::uuid);
CREATE POLICY rls_user ON credentials USING (user_id = current_setting('resmon.user_id')::uuid);
"""


DOWNGRADE_SQL: str = """
DROP POLICY IF EXISTS rls_user ON credentials;
DROP POLICY IF EXISTS rls_user ON executions;
DROP POLICY IF EXISTS rls_user ON routines;

DROP TABLE IF EXISTS credentials;
DROP TABLE IF EXISTS executions;
DROP TABLE IF EXISTS routines;
DROP TABLE IF EXISTS users;

DROP SEQUENCE IF EXISTS change_version;
"""


def upgrade() -> None:
    op.execute(UPGRADE_SQL)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
