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


def contents(c):
    tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'library_%' AND name NOT IN ('evidence_projects','evidence_project_files','evidence_notes')")]
    return {t: sorted([tuple(r) for r in c.execute(f'SELECT * FROM "{t}"')], key=repr) for t in tables}


def objects(c):
    return {r[0]: (r[1], ' '.join(r[2].split())) for r in c.execute(
        "SELECT name,type,sql FROM sqlite_master WHERE name LIKE 'library_%' OR name='idx_library_file_documents_document'")}


def test_populated_15_upgrade_restart_preserves_old_rows_and_creates_no_vault(tmp_path):
    path = tmp_path / 'old.db'; c = old_database(path); before = contents(c)
    db.init_db(conn=c)
    assert db.get_schema_version(c) == 17
    after = contents(c)
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
        assert db.get_schema_version(reopened) == 17
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
