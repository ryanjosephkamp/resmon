"""Schema 29 changes only the unchanged default collection's name, once."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from implementation_scripts import database

CORPUS = Path(__file__).parent / 'fixtures/schema-28/corpus.sql'


def _open_old(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.executescript(CORPUS.read_text(encoding='utf-8'))
    conn.commit()
    return conn


def _snapshot(conn: sqlite3.Connection) -> dict:
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    return {
        'objects': conn.execute('SELECT type,name,sql FROM sqlite_master ORDER BY name').fetchall(),
        'rows': {table: conn.execute(f'SELECT * FROM "{table}" ORDER BY 1').fetchall() for table in tables},
    }


@pytest.mark.parametrize('name', ['Your collection', 'Photonics', 'your collection', 'Your Collection'])
def test_upgrade_changes_only_the_exact_old_default_and_the_version(tmp_path, name):
    conn = _open_old(tmp_path / 'corpus.db')
    conn.execute('UPDATE collections SET name=? WHERE id=1', (name,))
    if name == 'Photonics':
        conn.execute("UPDATE collections SET name='Your collection' WHERE id=2")
    conn.commit()
    before = _snapshot(conn)
    database._migrate_default_collection_name(conn)
    after = _snapshot(conn)
    expected = 'Main Collection' if name == 'Your collection' else name
    before['rows']['collections'] = [(r[0], expected, *r[2:]) if r[0] == 1 else r for r in before['rows']['collections']]
    before['rows']['app_settings'] = [(k, '29' if k == 'schema_version' else v) for k, v in before['rows']['app_settings']]
    assert after == before
    assert database.get_schema_version(conn) == 29
    assert conn.execute('PRAGMA integrity_check').fetchone() == ('ok',)
    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    conn.close()


def test_a_current_database_keeps_an_owner_chosen_old_name_on_every_launch(tmp_path):
    path = tmp_path / 'corpus.db'
    conn = _open_old(path)
    database.init_db(conn=conn, keep_upgrade_copy=False)
    assert conn.execute('SELECT name FROM collections WHERE id=1').fetchone()[0] == 'Main Collection'
    conn.execute("UPDATE collections SET name='Your collection' WHERE id=1")
    conn.commit()
    before = _snapshot(conn)
    database.init_db(conn=conn, keep_upgrade_copy=False)
    assert _snapshot(conn) == before
    conn.close()


def test_a_failed_version_write_rolls_back_the_name_and_marker(tmp_path):
    conn = _open_old(tmp_path / 'corpus.db')
    conn.execute("CREATE TRIGGER reject_version BEFORE UPDATE ON app_settings WHEN NEW.key='schema_version' "
                 "BEGIN SELECT RAISE(ABORT, 'version refused'); END")
    conn.commit()
    before = _snapshot(conn)
    with pytest.raises(sqlite3.IntegrityError, match='version refused'):
        database._migrate_default_collection_name(conn)
    assert _snapshot(conn) == before
    conn.execute('DROP TRIGGER reject_version')
    database._migrate_default_collection_name(conn)
    assert database.get_schema_version(conn) == 29
    conn.close()


def test_fresh_database_names_its_default_main_collection(tmp_path):
    path = tmp_path / 'fresh.db'
    database.init_db(str(path), keep_upgrade_copy=False)
    conn = sqlite3.connect(path)
    assert conn.execute('SELECT id,name,revision FROM collections').fetchall() == [(1, 'Main Collection', 0)]
    conn.close()


@pytest.mark.parametrize('other_name', ['Main Collection', 'main collection'])
def test_a_name_the_owner_already_chose_is_left_to_them_and_the_upgrade_goes_ahead(tmp_path, other_name):
    conn = _open_old(tmp_path / 'corpus.db')
    conn.execute('UPDATE collections SET name=? WHERE id=2', (other_name,))
    conn.commit()
    before = _snapshot(conn)
    database._migrate_default_collection_name(conn)
    after = _snapshot(conn)
    # Both collections keep their names; only the version marker moves.
    assert conn.execute('SELECT id,name FROM collections ORDER BY id').fetchall()[:2] == [
        (1, 'Your collection'), (2, other_name)]
    assert database.get_schema_version(conn) == 29
    assert after['objects'] == before['objects']
    assert {t: r for t, r in after['rows'].items() if t != 'app_settings'} == {
        t: r for t, r in before['rows'].items() if t != 'app_settings'}
    conn.close()
