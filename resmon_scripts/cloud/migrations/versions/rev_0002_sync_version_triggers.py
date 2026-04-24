"""Row-level ``BEFORE UPDATE`` triggers bumping ``version`` from
``change_version`` on every write to ``routines``, ``executions``, and
``credentials``.

The 0001 migration already defaults ``version`` from ``nextval('change_version')``
on INSERT. This migration closes the gap for UPDATE, which does **not**
re-evaluate column DEFAULTs. Together they satisfy the §11.1 invariant that
every write transaction bumps the sync cursor, which is what the
``/api/v2/sync`` endpoint relies on (IMPL-35 / V-F1, V-F2, V-F3).

Revision ID: 0002_sync_version_triggers
Revises: 0001_initial_schema
Create Date: 2026-04-19
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op


revision: str = "0002_sync_version_triggers"
down_revision: Union[str, None] = "0001_initial_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


UPGRADE_SQL: str = """
CREATE OR REPLACE FUNCTION bump_change_version() RETURNS TRIGGER AS $$
BEGIN
    NEW.version := nextval('change_version');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_routines_bump_version
    BEFORE UPDATE ON routines
    FOR EACH ROW EXECUTE FUNCTION bump_change_version();

CREATE TRIGGER trg_executions_bump_version
    BEFORE UPDATE ON executions
    FOR EACH ROW EXECUTE FUNCTION bump_change_version();

CREATE TRIGGER trg_credentials_bump_version
    BEFORE UPDATE ON credentials
    FOR EACH ROW EXECUTE FUNCTION bump_change_version();
"""


DOWNGRADE_SQL: str = """
DROP TRIGGER IF EXISTS trg_credentials_bump_version ON credentials;
DROP TRIGGER IF EXISTS trg_executions_bump_version  ON executions;
DROP TRIGGER IF EXISTS trg_routines_bump_version    ON routines;
DROP FUNCTION IF EXISTS bump_change_version();
"""


def upgrade() -> None:
    op.execute(UPGRADE_SQL)


def downgrade() -> None:
    op.execute(DOWNGRADE_SQL)
