"""Real populated schema 15, exact additive objects and atomic failure."""
import sqlite3
from pathlib import Path
import pytest
from implementation_scripts import database as db

FIXTURE = Path(__file__).parent / 'fixtures/library/schema_15.sql'


def old_database(path):
    c = db.get_connection(path)
    c.executescript(FIXTURE.read_text())
    assert db.get_schema_version(c) == 15
    for table in ('documents', 'reading_queue', 'assistant_messages', 'assistant_session_choices', 'assistant_turn_choices'):
        assert c.execute(f'SELECT count(*) FROM {table}').fetchone()[0] > 0
    assert not c.execute("SELECT 1 FROM sqlite_master WHERE name LIKE 'library_%'").fetchone()
    return c


# Schema 19 rebuilt ``executions`` with a wider ``status`` CHECK and five new
# nullable columns, so its DDL and the width of its row tuples both change on
# an upgrade. That is growth, which this file allows; what it does not allow is
# a value being rewritten or a row disappearing, and the projections below keep
# that claim exact by re-reading the table through the columns it had before.


def contents(c, widths=None):
    tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'library_%' AND name NOT IN ('evidence_projects','evidence_project_files','evidence_notes','evidence_answers')")]
    out = {}
    for t in tables:
        columns = [r[1] for r in c.execute(f'PRAGMA table_info("{t}")')]
        if widths and t in widths:
            columns = [col for col in columns if col in widths[t]]
        order = ', '.join(f'"{col}"' for col in columns)
        out[t] = sorted([tuple(r) for r in c.execute(f'SELECT {order} FROM "{t}"')], key=repr)
    return out


def column_names(c):
    return {r[0]: [x[1] for x in c.execute(f'PRAGMA table_info("{r[0]}")')]
            for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def objects(c):
    return {r[0]: (r[1], ' '.join(r[2].split())) for r in c.execute(
        "SELECT name,type,sql FROM sqlite_master WHERE name LIKE 'library_%' OR name='idx_library_file_documents_document'")}


def test_populated_15_upgrade_restart_preserves_old_rows_and_creates_no_vault(tmp_path):
    path = tmp_path / 'old.db'; c = old_database(path); before = contents(c)
    widths = column_names(c)
    db.init_db(conn=c)
    assert db.get_schema_version(c) == 19
    after = contents(c, widths)
    after['app_settings'] = [(k, '15' if k == 'schema_version' else v) for k, v in after['app_settings']]
    assert after == before
    ddl = objects(c)
    assert len(ddl) == 4
    assert [x[0] for x in ddl.values()].count('table') == 3
    assert [x[0] for x in ddl.values()].count('index') == 1
    for table in ('library_vault', 'library_files', 'library_file_documents'):
        assert c.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0
    c.close(); db.init_db(path); db.init_db(path)
    with db.get_connection(path) as reopened:
        assert objects(reopened) == ddl
        assert db.get_schema_version(reopened) == 19
    assert not list(tmp_path.glob('resmon-library-*'))
    fresh = db.get_connection(tmp_path / 'fresh.db'); db.init_db(conn=fresh)
    assert objects(fresh) == ddl
    fresh.close()


@pytest.mark.parametrize('blocker', ['table', 'view', 'index', 'authorizer'])
def test_real_blockers_leave_15_and_roll_back_new_objects(tmp_path, blocker):
    c = old_database(tmp_path / 'blocked.db')
    if blocker == 'table':
        c.execute('CREATE TABLE library_files (wrong INTEGER)')
    elif blocker == 'view':
        c.execute('CREATE VIEW library_files AS SELECT 1 AS wrong')
    elif blocker == 'index':
        c.execute('CREATE INDEX idx_library_file_documents_document ON documents(title)')
    c.commit(); before = contents(c); initial = objects(c)
    if blocker == 'authorizer':
        c.set_authorizer(lambda code, name, *args: sqlite3.SQLITE_DENY if code == sqlite3.SQLITE_CREATE_INDEX and name == 'idx_library_file_documents_document' else sqlite3.SQLITE_OK)
    with pytest.raises(sqlite3.DatabaseError):
        db.init_db(conn=c)
    c.set_authorizer(lambda *_: sqlite3.SQLITE_OK)
    assert db.get_schema_version(c) == 15
    assert objects(c) == initial
    assert contents(c) == before
    c.close()
