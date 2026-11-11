# resmon_scripts/verification_scripts/test_database.py
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.database import (
    init_db, get_connection, insert_document, get_document_by_source,
    find_duplicates_by_hash, insert_execution, update_execution_status,
    insert_routine, get_routines, delete_routine,
    insert_configuration, get_configurations, delete_configuration,
    get_setting, set_setting,
)


def test_schema_creation():
    """All tables are created in a fresh in-memory database."""
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = {row[0] for row in cursor.fetchall()}
    required = {"documents", "executions", "execution_documents", "routines",
                "saved_configurations", "cloud_sync", "app_settings"}
    assert required.issubset(tables), f"Missing tables: {required - tables}"
    conn.close()


def test_document_crud():
    """Insert a document, retrieve it, verify fields match."""
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    doc = {
        "source_repository": "arxiv",
        "external_id": "2604.12345",
        "doi": "10.1234/test",
        "title": "Test Paper Title",
        "authors": '["Author A", "Author B"]',
        "abstract": "This is a test abstract.",
        "publication_date": "2026-04-15",
        "url": "https://arxiv.org/abs/2604.12345",
        "categories": '["cs.LG"]',
        "metadata_hash": "abc123hash",
    }
    insert_document(conn, doc)
    retrieved = get_document_by_source(conn, "arxiv", "2604.12345")
    assert retrieved is not None
    assert retrieved["title"] == "Test Paper Title"
    conn.close()


def test_duplicate_document_ignored():
    """Inserting a duplicate (same source + external_id) is silently ignored."""
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    doc = {
        "source_repository": "arxiv", "external_id": "2604.12345",
        "title": "Paper", "authors": "[]", "metadata_hash": "h1",
    }
    insert_document(conn, doc)
    insert_document(conn, doc)  # should not raise
    cursor = conn.execute("SELECT COUNT(*) FROM documents")
    assert cursor.fetchone()[0] == 1
    conn.close()


def test_execution_lifecycle():
    """Insert an execution, update status, verify persistence."""
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    exec_id = insert_execution(conn, {
        "execution_type": "deep_sweep",
        "parameters": '{"query": "test"}',
        "start_time": "2026-04-15T08:00:00Z",
    })
    assert exec_id is not None
    update_execution_status(conn, exec_id, "completed",
                            end_time="2026-04-15T08:01:00Z", result_count=10)
    row = conn.execute("SELECT status, result_count FROM executions WHERE id=?",
                       (exec_id,)).fetchone()
    assert row[0] == "completed"
    assert row[1] == 10
    conn.close()


def test_routine_crud():
    """Insert, update, delete a routine successfully."""
    conn = sqlite3.connect(":memory:")
    init_db(conn=conn)
    rid = insert_routine(conn, {
        "name": "Daily ML Sweep",
        "schedule_cron": "0 8 * * *",
        "parameters": '{"keywords": ["machine learning"]}',
    })
    routines = get_routines(conn)
    assert len(routines) == 1
    assert routines[0]["name"] == "Daily ML Sweep"
    delete_routine(conn, rid)
    assert len(get_routines(conn)) == 0
    conn.close()
