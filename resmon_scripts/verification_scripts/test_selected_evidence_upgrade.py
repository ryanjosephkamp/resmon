"""S21-S25: frozen populated 17, exact atomic 18, real row/file preservation."""
from __future__ import annotations
from pathlib import Path
import sqlite3
import uuid
import pytest
from implementation_scripts import database as db, evidence as ev, library
from test_evidence import Workspace,put_file,save_note,anchor_for,files_snapshot
from test_evidence_upgrade import contents,objects,table_names

FIXTURE=Path(__file__).parent/'fixtures/selected_evidence/schema_17.sql'


@pytest.fixture
def legacy17(tmp_path):
    path=tmp_path/'schema17.db';conn=db.get_connection(path)
    conn.executescript(FIXTURE.read_text());conn.commit()
    assert db.get_schema_version(conn)==17 and len(table_names(conn))==36
    parent=tmp_path/'vault-parent';parent.mkdir();originals=tmp_path/'originals';originals.mkdir()
    v=library.create_vault(conn,str(parent))['vault']
    p=ev.create_project(conn,v['vault_id'],'Synthetic populated migration')['project']
    w=Workspace(conn,path,parent/v['label'],originals,v['vault_id'],p['project_id'],1)
    f=put_file(w,'populated.txt','First target 😀\nsecond target 😀\n'.encode())
    save_note(w,f,'Literal owner note')
    save_note(w,f,'Passage commentary',anchor=anchor_for(w,f))
    try:yield w
    finally:conn.close()


def shape(conn):
    return {name:value for name,value in objects(conn).items() if name=='evidence_answers' or value[1]=='evidence_answers'}


def test_populated_17_upgrades_all_old_objects_rows_originals_and_notes(legacy17):
    w=legacy17;before=contents(w.conn);old_objects=objects(w.conn);files=files_snapshot(w)
    db.init_db(conn=w.conn)
    after=contents(w.conn,set(before))
    expected={**before,'app_settings':{**before['app_settings'],'rows':sorted([('schema_version','18') if r[0]=='schema_version' else r for r in before['app_settings']['rows']],key=repr)}}
    assert after==expected and files_snapshot(w)==files
    assert {k:objects(w.conn)[k] for k in old_objects}==old_objects
    assert len(table_names(w.conn))==37 and db.get_schema_version(w.conn)==18
    assert w.conn.execute('SELECT count(*) FROM evidence_answers').fetchone()[0]==0
    assert w.conn.execute('SELECT count(*) FROM evidence_notes').fetchone()[0]==2
    db.init_db(conn=w.conn)
    assert contents(w.conn,set(before))==expected
    w.conn.close();w.conn=db.get_connection(w.database);db.init_db(conn=w.conn)
    assert contents(w.conn,set(before))==expected and files_snapshot(w)==files


def test_fresh_and_upgraded_exact_approved_shape(legacy17,tmp_path):
    db.init_db(conn=legacy17.conn)
    fresh=db.get_connection(tmp_path/'fresh.db')
    try:
        db.init_db(conn=fresh)
        assert shape(fresh)==shape(legacy17.conn)
        expected=sqlite3.connect(':memory:')
        try:
            expected.executescript(APPROVED_SQL)
            expected_shape={r[0]:(r[1],r[2],None if r[3] is None else ' '.join(r[3].split())) for r in expected.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE tbl_name='evidence_answers'")}
            assert shape(fresh)==expected_shape
        finally:expected.close()
    finally:fresh.close()


@pytest.mark.parametrize('fault',['table','view','index','late_marker','second_ddl'])
def test_migration_fault_rolls_back_new_objects_and_keeps17(legacy17,fault):
    conn=legacy17.conn
    if fault=='table':conn.execute('CREATE TABLE evidence_answers(wrong TEXT)')
    elif fault=='view':conn.execute('CREATE VIEW evidence_answers AS SELECT 1 AS wrong')
    elif fault=='index':conn.execute('CREATE INDEX idx_evidence_answers_project_order ON evidence_projects(id)')
    elif fault=='late_marker':conn.execute("CREATE TRIGGER block18 BEFORE UPDATE ON app_settings WHEN NEW.key='schema_version' AND NEW.value='18' BEGIN SELECT RAISE(ABORT,'authored late marker denial'); END")
    conn.commit();before=contents(conn);old_objects=objects(conn)
    if fault=='second_ddl':
        conn.set_authorizer(lambda action,arg1,arg2,dbname,trigger:sqlite3.SQLITE_DENY if action==sqlite3.SQLITE_CREATE_INDEX and arg1=='idx_evidence_answers_project_order' else sqlite3.SQLITE_OK)
    try:
        with pytest.raises(sqlite3.DatabaseError):db.init_db(conn=conn)
    finally:conn.set_authorizer(None)
    assert db.get_schema_version(conn)==17 and contents(conn)==before and objects(conn)==old_objects


@pytest.mark.parametrize('fault',['missing_index','extra_trigger','extra_index','changed_table'])
def test_schema18_restart_refuses_corruption_without_repair(legacy17,fault):
    conn=legacy17.conn;db.init_db(conn=conn)
    if fault=='missing_index':conn.execute('DROP INDEX idx_evidence_answers_project_order')
    elif fault=='extra_trigger':conn.execute('CREATE TRIGGER extra_answer AFTER INSERT ON evidence_answers BEGIN SELECT 1; END')
    elif fault=='extra_index':conn.execute('CREATE INDEX extra_answer ON evidence_answers(state)')
    else:conn.execute('ALTER TABLE evidence_answers ADD COLUMN unapproved TEXT')
    conn.commit();before=objects(conn);rows=contents(conn)
    with pytest.raises(sqlite3.DatabaseError):db.init_db(conn=conn)
    assert objects(conn)==before and contents(conn)==rows and db.get_schema_version(conn)==18

# Independent approved DDL oracle, copied from the frozen owner-reviewed SQL.
APPROVED_SQL = "-- PROPOSED schema 18. Preparation only; not executed.\n-- One table and one explicit index; UNIQUE creates its ordinary implicit indexes.\nCREATE TABLE evidence_answers (\n id INTEGER PRIMARY KEY AUTOINCREMENT,\n answer_id TEXT NOT NULL UNIQUE,\n preview_id TEXT NOT NULL UNIQUE,\n vault_id TEXT NOT NULL REFERENCES library_vault(vault_id) ON DELETE RESTRICT,\n project_id TEXT NOT NULL REFERENCES evidence_projects(project_id) ON DELETE RESTRICT,\n project_revision INTEGER NOT NULL CHECK(project_revision >= 1),\n mode TEXT NOT NULL CHECK(mode IN ('question', 'briefing')),\n state TEXT NOT NULL CHECK(state IN ('admitted', 'running', 'succeeded', 'refused', 'failed', 'cancelled', 'interrupted')),\n request_json TEXT NOT NULL CHECK(length(CAST(request_json AS BLOB)) <= 262144),\n request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),\n private_binding_json TEXT NOT NULL CHECK(length(CAST(private_binding_json AS BLOB)) <= 4096),\n private_native_session_id TEXT,\n owner_runtime_id TEXT NOT NULL,\n partial_text TEXT NOT NULL DEFAULT '' CHECK(length(CAST(partial_text AS BLOB)) <= 65536),\n result_json TEXT CHECK(result_json IS NULL OR length(CAST(result_json AS BLOB)) <= 65536),\n reports_json TEXT NOT NULL DEFAULT '[]' CHECK(length(CAST(reports_json AS BLOB)) <= 16384),\n usage_json TEXT CHECK(usage_json IS NULL OR length(CAST(usage_json AS BLOB)) <= 4096),\n error_code TEXT CHECK(error_code IS NULL OR length(error_code) <= 80),\n error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),\n cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('not_started', 'pending', 'confirmed', 'unknown')),\n created_at_utc TEXT NOT NULL,\n started_at_utc TEXT,\n finished_at_utc TEXT,\n CHECK((state IN ('admitted','running') AND finished_at_utc IS NULL)\n       OR (state IN ('succeeded','refused','failed','cancelled','interrupted') AND finished_at_utc IS NOT NULL)),\n CHECK(result_json IS NULL OR state IN ('succeeded','refused'))\n);\nCREATE INDEX idx_evidence_answers_project_order ON evidence_answers(project_id, id);\n"
