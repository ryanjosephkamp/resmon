"""Schema 24 -> 25: ``library_files`` rebuilt to keep TeX, and ``library_removed`` added.

The schema-24 database is made by resmon's own code: the committed schema-21
corpus walked by ``init_db`` with schema 25 and every later step held back,
then Library files, paper links, an Evidence project, its members and notes written through
the Library's and Evidence's own functions. The launch after that is the step
under test. A rebuild is the migration shape that can lose a column's values,
drop a row or reset a sequence while a row count stays the same, so every row
of every table that references ``library_files`` is compared, and so is the
AUTOINCREMENT high-water mark.
"""
from pathlib import Path
import sqlite3

import pytest

from implementation_scripts import database as db, evidence as ev, library as lib

CORPUS_21 = Path(__file__).parent / 'fixtures/schema-21/corpus.sql'
LIBRARY_TABLES = ('library_vault', 'library_files', 'library_file_documents', 'evidence_projects',
                  'evidence_project_files', 'evidence_notes')


def schema_24(path: Path, monkeypatch, tmp_path: Path) -> sqlite3.Connection:
    with monkeypatch.context() as held:
        held.setattr(db, '_migrate_library_v25', lambda conn: None)
        held.setattr(db, '_migrate_collections', lambda conn: None)
        held.setattr(db, '_migrate_full_text', lambda conn: None)
        held.setattr(db, '_migrate_assistant_files', lambda conn: None)
        held.setattr(db, '_migrate_default_collection_name', lambda conn: None)
        c = db.get_connection(path)
        c.executescript(CORPUS_21.read_text(encoding='utf-8'))
        c.commit()
        db.init_db(conn=c)
    assert db.get_schema_version(c) == 24
    assert "'text/x-tex'" not in c.execute("SELECT sql FROM sqlite_master WHERE name='library_files'").fetchone()[0]
    # The corpus records a vault at a path that does not exist; point it at a real one.
    vault_id = c.execute('SELECT vault_id FROM library_vault').fetchone()[0]
    parent = tmp_path / 'parent'
    root = parent / ('resmon-library-' + vault_id)
    (root / 'files').mkdir(parents=True)
    (root / 'vault.json').write_text('{"version": 1, "vault_id": "%s"}' % vault_id)
    for file_id, relative in c.execute('SELECT file_id, relative_path FROM library_files'):
        (root / 'files' / file_id).mkdir()
    c.execute('UPDATE library_vault SET root_path=?', (str(root),))
    c.commit()
    # Real bytes for the corpus's three files are not needed: none is read here.
    with lib.Import(c, vault_id, 'chapter.pdf') as upload:
        upload.write(b'%PDF-1.4\nschema 24 chapter')
        pdf = upload.finish()['file']
    with lib.Import(c, vault_id, 'last.txt') as upload:
        upload.write(b'the highest id, deleted below')
        last = upload.finish()['file']
    document = c.execute('SELECT min(id) FROM documents').fetchone()[0]
    lib.add_link(c, vault_id, pdf['file_id'], document)
    project = c.execute('SELECT project_id, revision FROM evidence_projects ORDER BY id').fetchone()
    added = ev.add_file(c, vault_id, project[0], project[1], pdf['file_id'], pdf['version_id'])
    ev.create_note(c, vault_id, project[0], added['project']['revision'], pdf['file_id'], pdf['version_id'],
                   'note', 'Written at schema 24.')
    # The sequence now sits above every surviving id: a copy alone would lower it.
    import shutil
    shutil.rmtree(root / 'files' / last['file_id'])
    c.execute('DELETE FROM library_files WHERE file_id=?', (last['file_id'],))
    c.commit()
    return c


def snapshot(c: sqlite3.Connection) -> dict:
    return {t: [tuple(r) for r in c.execute(f'SELECT * FROM {t} ORDER BY rowid')] for t in LIBRARY_TABLES}


def sequence(c: sqlite3.Connection) -> int:
    return c.execute("SELECT seq FROM sqlite_sequence WHERE name='library_files'").fetchone()[0]


def test_the_rebuild_keeps_every_row_reference_and_the_sequence(tmp_path, monkeypatch):
    path = tmp_path / 'library.db'
    c = schema_24(path, monkeypatch, tmp_path)
    before, seq = snapshot(c), sequence(c)
    assert seq > max(r[0] for r in before['library_files'])
    assert before['evidence_notes'] and before['evidence_project_files'] and before['library_file_documents']
    columns = [r[1] for r in c.execute('PRAGMA table_info(library_files)')]
    c.close()

    db.init_db(str(path))                     # the launch

    c = db.get_connection(path)
    try:
        assert db.get_schema_version(c) == db.SCHEMA_VERSION
        ddl = c.execute("SELECT sql FROM sqlite_master WHERE name='library_files'").fetchone()[0]
        assert ' '.join(ddl.split()) == ' '.join(db._LIBRARY_FILES_V25_DDL.split())
        assert [r[1] for r in c.execute('PRAGMA table_info(library_files)')] == columns
        assert snapshot(c) == before and sequence(c) == seq
        assert c.execute('PRAGMA foreign_key_check').fetchall() == []
        assert c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert c.execute('SELECT count(*) FROM library_removed').fetchone()[0] == 0
        # The children still hold the file: RESTRICT is a real constraint on the new table.
        with pytest.raises(sqlite3.IntegrityError):
            c.execute('DELETE FROM library_files WHERE file_id=(SELECT file_id FROM evidence_notes LIMIT 1)')
        c.rollback()
        vault_id = c.execute('SELECT vault_id FROM library_vault').fetchone()[0]
        with lib.Import(c, vault_id, 'proof.tex') as upload:
            upload.write(b'\\begin{equation}a^2+b^2=c^2\\end{equation}')
            tex = upload.finish()['file']
        assert tex['media_type'] == 'text/x-tex' and tex['id'] == seq + 1
        with pytest.raises(sqlite3.IntegrityError):
            c.execute("UPDATE library_files SET media_type='text/html' WHERE file_id=?", (tex['file_id'],))
        c.rollback()
        after = snapshot(c)
    finally:
        c.close()
    db.init_db(str(path)); db.init_db(str(path))      # later launches change nothing
    c = db.get_connection(path)
    try:
        assert snapshot(c) == after and db.get_schema_version(c) == db.SCHEMA_VERSION
    finally:
        c.close()


def test_a_fresh_database_and_an_upgraded_one_have_one_shape(tmp_path, monkeypatch):
    c = schema_24(tmp_path / 'old.db', monkeypatch, tmp_path)
    c.close()
    db.init_db(str(tmp_path / 'old.db'))
    db.init_db(str(tmp_path / 'fresh.db'))

    def shape(p):
        with sqlite3.connect(p) as conn:
            return {r[0]: ' '.join((r[1] or '').split()) for r in conn.execute(
                "SELECT name, sql FROM sqlite_master WHERE tbl_name IN ('library_files', 'library_removed')")}
    assert shape(tmp_path / 'old.db') == shape(tmp_path / 'fresh.db')


@pytest.mark.parametrize('blocker', ['removed_table', 'files_shape'])
def test_a_conflicting_object_leaves_schema_24_untouched(tmp_path, monkeypatch, blocker):
    path = tmp_path / 'blocked.db'
    c = schema_24(path, monkeypatch, tmp_path)
    if blocker == 'removed_table':
        c.execute('CREATE TABLE library_removed (wrong INTEGER)')
    else:
        # Neither schema 16's shape nor schema 25's: refused, never adopted or repaired.
        c.execute('PRAGMA writable_schema=ON')
        c.execute("UPDATE sqlite_master SET sql=replace(sql, 'original_name TEXT NOT NULL', "
                  "'original_name TEXT NOT NULL DEFAULT ''x''') WHERE name='library_files'")
        c.execute('PRAGMA writable_schema=OFF')
    c.commit(); c.close()
    c = db.get_connection(path)
    before = snapshot(c)
    ddl = c.execute("SELECT sql FROM sqlite_master WHERE name='library_files'").fetchone()[0]
    with pytest.raises(sqlite3.DatabaseError):
        db.init_db(conn=c)
    assert db.get_schema_version(c) == 24
    assert c.execute("SELECT sql FROM sqlite_master WHERE name='library_files'").fetchone()[0] == ddl
    assert snapshot(c) == before
    assert c.execute('PRAGMA foreign_keys').fetchone()[0] == 1
    c.close()


def test_a_link_that_already_dangled_is_carried_not_judged(tmp_path, monkeypatch):
    # A backup can carry such a row (``backup.foreign_key_violations`` reports it);
    # the upgrade keeps it as it was rather than refusing the whole database.
    path = tmp_path / 'orphaned.db'
    c = schema_24(path, monkeypatch, tmp_path)
    c.execute('PRAGMA foreign_keys=OFF')
    c.execute("INSERT INTO library_file_documents VALUES ('00000000-0000-4000-8000-000000000000', "
              "(SELECT min(id) FROM documents), '2026-10-29T00:00:00Z')")
    c.commit()
    c.execute('PRAGMA foreign_keys=ON')
    before = snapshot(c)
    c.close()
    db.init_db(str(path))
    c = db.get_connection(path)
    try:
        assert db.get_schema_version(c) == db.SCHEMA_VERSION and snapshot(c) == before
    finally:
        c.close()
