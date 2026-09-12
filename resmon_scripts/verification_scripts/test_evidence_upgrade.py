"""Populated schema16 migration, exact shape and preservation failures.

The DDL oracle comes from the frozen contract; SQLite/files are synthetic.
No HTTP, Electron, scientific accuracy or independent acceptance claim.
"""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
import hashlib
from pathlib import Path
import sqlite3
import stat
from typing import Any
import uuid

import pytest

from implementation_scripts import database as db, evidence, library


FIXTURES = Path(__file__).parent / "fixtures"
SCHEMA_16 = FIXTURES / "evidence" / "schema_16.sql"
TABLES = ("evidence_projects", "evidence_project_files", "evidence_notes")
INDEXES = ("idx_evidence_project_files_order", "idx_evidence_notes_order")
LIBRARY_TABLES = ("library_vault", "library_files", "library_file_documents")
NOW = "2026-09-11T12:00:00.123456+00:00"

# Frozen approved schema17 DDL, intentionally independent of production values.
APPROVED_SQL = """
CREATE TABLE evidence_projects (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id TEXT NOT NULL UNIQUE,
 vault_id TEXT NOT NULL REFERENCES library_vault(vault_id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created_at_utc TEXT NOT NULL,
 updated_at_utc TEXT NOT NULL
);
CREATE TABLE evidence_project_files (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id TEXT NOT NULL REFERENCES evidence_projects(project_id) ON DELETE RESTRICT,
 file_id TEXT NOT NULL REFERENCES library_files(file_id) ON DELETE RESTRICT,
 version_id TEXT NOT NULL REFERENCES library_files(version_id) ON DELETE RESTRICT,
 added_at_utc TEXT NOT NULL,
 UNIQUE(project_id, file_id)
);
CREATE TABLE evidence_notes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 note_id TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL REFERENCES evidence_projects(project_id) ON DELETE RESTRICT,
 file_id TEXT NOT NULL REFERENCES library_files(file_id) ON DELETE RESTRICT,
 version_id TEXT NOT NULL REFERENCES library_files(version_id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('note', 'passage')),
 body TEXT NOT NULL CHECK(length(body) <= 20000),
 page_number INTEGER,
 extraction_contract TEXT,
 page_text_sha256 TEXT,
 start_codepoint INTEGER,
 end_codepoint INTEGER,
 quote TEXT,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created_at_utc TEXT NOT NULL,
 updated_at_utc TEXT NOT NULL,
 CHECK (
  (kind = 'note' AND length(body) >= 1 AND page_number IS NULL AND extraction_contract IS NULL
   AND page_text_sha256 IS NULL AND start_codepoint IS NULL AND end_codepoint IS NULL AND quote IS NULL)
  OR
  (kind = 'passage' AND page_number IS NOT NULL AND page_number >= 1 AND extraction_contract IS NOT NULL
   AND page_text_sha256 IS NOT NULL AND length(page_text_sha256) = 64 AND page_text_sha256 NOT GLOB '*[^0-9a-f]*'
   AND start_codepoint IS NOT NULL AND end_codepoint IS NOT NULL AND quote IS NOT NULL AND start_codepoint >= 0 AND end_codepoint > start_codepoint
   AND length(quote) BETWEEN 1 AND 20000 AND end_codepoint - start_codepoint = length(quote))
 )
);
CREATE INDEX idx_evidence_project_files_order ON evidence_project_files(project_id, id);
CREATE INDEX idx_evidence_notes_order ON evidence_notes(project_id, id);
"""
APPROVED_DDL = {
    statement.strip().split()[2]: statement.strip()
    for statement in APPROVED_SQL.split(";") if statement.strip()
}

HISTORICAL_FIXTURE_HASHES = {
    "library/schema_15.sql": "cd5068cdcf8802f474fd46b40941c5888703777b519aeba1fbf4a704bcf76b33",
    "reading_queue/schema_13.sql": "9c5bcd408bed3bcfa0f7d2bfbf79997064dfdeb5e25195a5d1571f61db1e10f8",
}


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def quoted(name: str) -> str:
    """Quote only measured SQLite identifiers, never form a path from them."""
    return '"' + name.replace('"', '""') + '"'


def table_names(conn: sqlite3.Connection) -> set[str]:
    return {str(row[0]) for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}


def objects(conn: sqlite3.Connection) -> dict[str, tuple[str, str, str | None]]:
    return {
        str(name): (str(kind), str(table), None if sql is None else " ".join(sql.split()))
        for name, kind, table, sql in conn.execute(
            "SELECT name,type,tbl_name,sql FROM sqlite_master ORDER BY name")
    }


def contents(conn: sqlite3.Connection, names: set[str] | None = None) -> dict:
    """Fresh value snapshots, including FTS shadows and SQLite sequences."""
    result = {}
    for table in sorted(table_names(conn) if names is None else names):
        result[table] = {
            "columns": [tuple(r) for r in conn.execute(f"PRAGMA table_xinfo({quoted(table)})")],
            "rows": sorted(
                [tuple(r) for r in conn.execute(f"SELECT * FROM {quoted(table)}")], key=repr),
        }
    return result


def row_digest(rows: dict) -> str:
    # repr preserves byte blobs and NULL/type distinctions in this local receipt.
    return digest(repr(rows).encode("utf-8"))


def file_census(roots: tuple[Path, ...]) -> dict:
    """Only explicitly created synthetic roots; no database/journal-byte claim."""
    result = {}
    for root in roots:
        for item in [root, *sorted(root.rglob("*"))]:
            info = item.lstat()
            assert not stat.S_ISLNK(info.st_mode), item
            relative = str(item.relative_to(root))
            key = (str(root), relative)
            if stat.S_ISDIR(info.st_mode):
                result[key] = ("directory", stat.S_IMODE(info.st_mode))
            else:
                assert stat.S_ISREG(info.st_mode), item
                result[key] = ("file", info.st_size, info.st_mtime_ns,
                               stat.S_IMODE(info.st_mode), digest(item.read_bytes()))
    return result


def evidence_shape(conn: sqlite3.Connection) -> dict:
    result: dict[str, Any] = {}
    for table in TABLES:
        result[table] = {
            "columns": [tuple(r) for r in conn.execute(f"PRAGMA table_xinfo({quoted(table)})")],
            "foreign_keys": sorted(
                [tuple(r) for r in conn.execute(f"PRAGMA foreign_key_list({quoted(table)})")]),
            "indexes": {},
        }
        for row in conn.execute(f"PRAGMA index_list({quoted(table)})"):
            name = str(row[1])
            result[table]["indexes"][name] = {
                "unique": row[2], "origin": row[3], "partial": row[4],
                "columns": [tuple(r) for r in conn.execute(f"PRAGMA index_xinfo({quoted(name)})")],
            }
    result["objects"] = {name: obj for name, obj in objects(conn).items() if obj[1] in TABLES}
    return result


def assert_approved_shape(conn: sqlite3.Connection) -> None:
    actual = {name: obj for name, obj in objects(conn).items() if obj[1] in TABLES and obj[2] is not None}
    expected = {
        name: ("table" if name in TABLES else "index",
               name if name in TABLES else "evidence_project_files" if name == INDEXES[0] else "evidence_notes",
               " ".join(sql.split()))
        for name, sql in APPROVED_DDL.items()
    }
    assert actual == expected
    assert len(actual) == 5
    # Validate implicit UNIQUE constraints as well as the two authored indexes.
    expected_unique = {
        TABLES[0]: {("project_id",)},
        TABLES[1]: {("project_id", "file_id")},
        TABLES[2]: {("note_id",)},
    }
    for table, keys in expected_unique.items():
        measured = set()
        for row in conn.execute(f"PRAGMA index_list({quoted(table)})"):
            if row[2]:
                measured.add(tuple(r[2] for r in conn.execute(
                    f"PRAGMA index_info({quoted(str(row[1]))})")))
        assert measured == keys
    assert [r[2] for r in conn.execute(f"PRAGMA index_info({INDEXES[0]})")] == ["project_id", "id"]
    assert [r[2] for r in conn.execute(f"PRAGMA index_info({INDEXES[1]})")] == ["project_id", "id"]
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


@dataclass
class Legacy:
    conn: sqlite3.Connection
    path: Path
    vault_id: str
    vault_root: Path
    originals: Path
    roots: tuple[Path, ...]
    files: list[dict]


def build_populated_16(root: Path) -> Legacy:
    root.mkdir()
    path = root / "schema16.db"
    conn = db.get_connection(path)
    try:
        conn.executescript(SCHEMA_16.read_text(encoding="utf-8"))
        conn.execute("PRAGMA foreign_keys=ON")
        assert db.get_schema_version(conn) == 16
        assert len(table_names(conn)) == 33  # 32 application/FTS tables plus SQLite internal sqlite_sequence.
        assert not any(name in objects(conn) for name in (*TABLES, *INDEXES))
        assert all(conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
                   for table in LIBRARY_TABLES)
        required_populated = (
            "documents", "document_authors", "document_categories",
            "document_lifecycle", "document_lifecycle_checks", "document_embeddings",
            "document_links", "execution_documents", "execution_sources", "execution_ai",
            "executions", "reading_queue", "assistant_sessions", "assistant_messages",
            "assistant_session_choices", "assistant_turn_choices",
        )
        for table in required_populated:
            assert conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] > 0, table
        assert conn.execute(
            "SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'diffusion'").fetchall()
        assert {"documents_fts_insert", "documents_fts_update", "documents_fts_delete"} <= set(objects(conn))
        parent = root / "vault-parent"
        originals = root / "originals"
        unrelated = root / "unrelated"
        for directory in (parent, originals, unrelated):
            directory.mkdir()
        (unrelated / "keep.txt").write_bytes(b"synthetic unrelated preservation sentinel")
        configured = library.create_vault(conn, str(parent))
        vault_id = configured["vault"]["vault_id"]
        vault_root = parent / configured["vault"]["label"]
        first_document = int(conn.execute("SELECT min(id) FROM documents").fetchone()[0])
        files = []
        for name, raw in (("source.txt", "First 😀 passage\r\nsecond line\n".encode()),
                          ("notes.md", b"# Authored literal\nsecond source\n")):
            (originals / name).write_bytes(raw)
            with library.Import(conn, vault_id, name, first_document) as upload:
                upload.write(raw)
                item = upload.finish()["file"]
            files.append(item)
            assert (vault_root / item["relative_path"]).read_bytes() == raw
            assert digest(raw) == item["sha256"]
        assert db.get_schema_version(conn) == 16
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        return Legacy(conn, path, vault_id, vault_root, originals, (parent, originals, unrelated), files)
    except BaseException:
        conn.close()
        raise


@pytest.fixture
def legacy(tmp_path: Path) -> Iterator[Legacy]:
    value = build_populated_16(tmp_path / "populated16")
    try:
        yield value
    finally:
        value.conn.close()


def test_historical_fixture_bytes_remain_exact() -> None:
    for relative, expected in HISTORICAL_FIXTURE_HASHES.items():
        assert digest((FIXTURES / relative).read_bytes()) == expected


def test_populated_16_upgrade_preserves_all_old_rows_objects_and_files(
    legacy: Legacy, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = legacy.conn
    before_rows = contents(conn)
    before_objects = objects(conn)
    before_files = file_census(legacy.roots)
    before_rows_hash = row_digest(before_rows)
    fixture_hash = digest(SCHEMA_16.read_bytes())
    other = build_populated_16(tmp_path / "other-vault16")
    try:
        assert legacy.vault_id != other.vault_id
        untouched = (contents(other.conn), objects(other.conn), file_census(other.roots))

        def forbidden_io(*args: object, **kwargs: object) -> None:
            pytest.fail("Schema migration called Library import/vault/read behavior")

        # The migration must operate on metadata only, never create/read a vault.
        with monkeypatch.context() as scoped:
            for name in ("create_vault", "Import", "retained", "checked_vault"):
                scoped.setattr(library, name, forbidden_io)
            db.init_db(conn=conn)
        assert db.SCHEMA_VERSION == db.get_schema_version(conn) == 17
        assert table_names(conn) == set(before_rows) | set(TABLES)
        assert len(table_names(conn)) == 36
        after_rows = contents(conn, set(before_rows))
        assert before_rows_hash == row_digest(before_rows), "the before snapshot itself changed"
        expected_settings = dict(before_rows["app_settings"]["rows"]) | {"schema_version": "17"}
        assert dict(after_rows["app_settings"]["rows"]) == expected_settings
        for table in before_rows:
            if table != "app_settings":
                assert after_rows[table] == before_rows[table], table
        assert after_rows["app_settings"]["columns"] == before_rows["app_settings"]["columns"]
        assert {name: objects(conn)[name] for name in before_objects} == before_objects
        for table in TABLES:
            assert conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
        assert_approved_shape(conn)
        assert file_census(legacy.roots) == before_files
        assert digest(SCHEMA_16.read_bytes()) == fixture_hash
        assert (contents(other.conn), objects(other.conn), file_census(other.roots)) == untouched
        assert db.get_schema_version(other.conn) == 16
        print("E01_SCHEMA_CENSUS", {"old_tables": len(before_rows), "new_tables": len(table_names(conn)),
                                   "old_objects": len(before_objects), "objects": len(objects(conn)),
                                   "old_rows_digest": before_rows_hash,
                                   "preserved_file_entries": len(before_files),
                                   "schema16_fixture_sha256": fixture_hash})
    finally:
        other.conn.close()


def test_fresh_upgraded_and_twice_reopened_schema_are_identical(legacy: Legacy, tmp_path: Path) -> None:
    db.init_db(conn=legacy.conn)
    expected_shape = evidence_shape(legacy.conn)
    expected_rows = contents(legacy.conn)
    expected_objects = objects(legacy.conn)
    expected_files = file_census(legacy.roots)
    fresh = db.get_connection(tmp_path / "fresh17.db")
    try:
        db.init_db(conn=fresh)
        assert_approved_shape(fresh)
        assert evidence_shape(fresh) == expected_shape
        assert all(fresh.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
                   for table in (*LIBRARY_TABLES, *TABLES))
        assert db.get_schema_version(fresh) == 17
        assert len(table_names(fresh)) == 36
    finally:
        fresh.close()
    legacy.conn.close()
    for _ in range(2):
        reopened = db.get_connection(legacy.path)
        try:
            db.init_db(conn=reopened)
            assert contents(reopened) == expected_rows
            assert objects(reopened) == expected_objects
            assert evidence_shape(reopened) == expected_shape
            assert db.get_schema_version(reopened) == 17
        finally:
            reopened.close()
    assert file_census(legacy.roots) == expected_files


@pytest.mark.parametrize("blocker", ["early_table", "early_view", "late_index", "partial_exact", "late_authorizer"])
def test_failed_migration_preserves_marker16_and_every_preexisting_object(
    legacy: Legacy, blocker: str,
) -> None:
    conn = legacy.conn
    if blocker == "early_table":
        conn.execute("CREATE TABLE evidence_projects(wrong INTEGER)")
    elif blocker == "early_view":
        conn.execute("CREATE VIEW evidence_projects AS SELECT 1 AS wrong")
    elif blocker == "late_index":
        conn.execute("CREATE INDEX idx_evidence_notes_order ON documents(title)")
    elif blocker == "partial_exact":
        # Even an exact isolated table under marker16 must not be adopted.
        conn.execute(APPROVED_DDL["evidence_projects"])
    conn.commit()
    before = (contents(conn), objects(conn), file_census(legacy.roots))
    ddl_seen: list[tuple[int, str | None]] = []

    def authorizer(code: int, name: str | None, arg: str | None,
                   database: str | None, trigger: str | None) -> int:
        if code in (sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_CREATE_INDEX):
            ddl_seen.append((code, name))
        if blocker == "late_authorizer" and code == sqlite3.SQLITE_CREATE_INDEX and name == INDEXES[1]:
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    conn.set_authorizer(authorizer)
    try:
        with pytest.raises(sqlite3.DatabaseError):
            db.init_db(conn=conn)
    finally:
        conn.set_authorizer(None)
    assert db.get_schema_version(conn) == 16
    assert (contents(conn), objects(conn), file_census(legacy.roots)) == before
    if blocker in ("late_index", "late_authorizer"):
        assert {name for code, name in ddl_seen if code == sqlite3.SQLITE_CREATE_TABLE} >= set(TABLES)
        assert (sqlite3.SQLITE_CREATE_INDEX, INDEXES[0]) in ddl_seen
    # Reopening must expose the rolled-back state, not uncommitted local success.
    reopened = db.get_connection(legacy.path)
    try:
        assert db.get_schema_version(reopened) == 16
        assert (contents(reopened), objects(reopened), file_census(legacy.roots)) == before
    finally:
        reopened.close()
    print("E02_ROLLBACK", {"blocker": blocker, "ddl_attempted": ddl_seen,
                           "marker": db.get_schema_version(conn), "rows_digest": row_digest(before[0])})
    # Authored test-only restoration: production offers no recovery operation.
    if blocker in ("early_table", "partial_exact"):
        conn.execute("DROP TABLE evidence_projects")
    elif blocker == "early_view":
        conn.execute("DROP VIEW evidence_projects")
    elif blocker == "late_index":
        conn.execute("DROP INDEX idx_evidence_notes_order")
    conn.commit()
    db.init_db(conn=conn)
    assert db.get_schema_version(conn) == 17
    assert_approved_shape(conn)


@pytest.mark.parametrize("damage", ["not_null", "check", "foreign_key", "unique", "index_order", "extra_index", "extra_trigger", "missing_table"])
def test_schema17_restart_refuses_bad_shapes_without_repair(legacy: Legacy, damage: str) -> None:
    conn = legacy.conn
    db.init_db(conn=conn)
    pristine = (contents(conn), objects(conn), file_census(legacy.roots))
    if damage in ("not_null", "check", "foreign_key", "unique"):
        conn.execute("DROP TABLE evidence_notes")
        ddl = APPROVED_DDL["evidence_notes"]
        old, new = {
            "not_null": ("body TEXT NOT NULL", "body TEXT"),
            "check": ("CHECK(revision >= 1)", "CHECK(revision >= 0)"),
            "foreign_key": ("REFERENCES library_files(version_id) ON DELETE RESTRICT", ""),
            "unique": ("note_id TEXT NOT NULL UNIQUE", "note_id TEXT NOT NULL"),
        }[damage]
        assert old in ddl
        conn.execute(ddl.replace(old, new, 1))
        conn.execute(APPROVED_DDL[INDEXES[1]])
    elif damage == "index_order":
        conn.execute(f"DROP INDEX {INDEXES[1]}")
        conn.execute(f"CREATE INDEX {INDEXES[1]} ON evidence_notes(id, project_id)")
    elif damage == "extra_index":
        conn.execute("CREATE INDEX authored_extra_evidence ON evidence_notes(body)")
    elif damage == "extra_trigger":
        conn.execute("CREATE TRIGGER authored_extra_evidence AFTER INSERT ON evidence_notes BEGIN SELECT 1; END")
    else:
        conn.execute("DROP TABLE evidence_notes")
    conn.commit()
    damaged = (contents(conn), objects(conn), file_census(legacy.roots))
    assert damaged != pristine
    with pytest.raises(sqlite3.DatabaseError):
        db.init_db(conn=conn)
    assert db.get_schema_version(conn) == 17  # Retains the prior marker; no false downgrade/repair.
    assert (contents(conn), objects(conn), file_census(legacy.roots)) == damaged
    # Restore only this test's empty schema objects and prove exact shape restoration.
    if damage in ("not_null", "check", "foreign_key", "unique"):
        conn.execute("DROP TABLE evidence_notes")
    elif damage == "index_order":
        conn.execute(f"DROP INDEX {INDEXES[1]}")
    elif damage == "extra_index":
        conn.execute("DROP INDEX authored_extra_evidence")
    elif damage == "extra_trigger":
        conn.execute("DROP TRIGGER authored_extra_evidence")
    if damage in ("not_null", "check", "foreign_key", "unique", "missing_table"):
        conn.execute(APPROVED_DDL["evidence_notes"])
        conn.execute(APPROVED_DDL[INDEXES[1]])
    elif damage == "index_order":
        conn.execute(APPROVED_DDL[INDEXES[1]])
    conn.commit()
    db.init_db(conn=conn)
    assert (contents(conn), objects(conn), file_census(legacy.roots)) == pristine


def seed_project(legacy: Legacy) -> str:
    db.init_db(conn=legacy.conn)
    project_id = str(uuid.uuid4())
    legacy.conn.execute(
        "INSERT INTO evidence_projects(project_id,vault_id,name,revision,created_at_utc,updated_at_utc) "
        "VALUES (?,?,?,1,?,?)", (project_id, legacy.vault_id, "Authored collection", NOW, NOW))
    for item in legacy.files:
        legacy.conn.execute(
            "INSERT INTO evidence_project_files(project_id,file_id,version_id,added_at_utc) VALUES (?,?,?,?)",
            (project_id, item["file_id"], item["version_id"], NOW))
    legacy.conn.commit()
    return project_id


def note_values(legacy: Legacy, project_id: str, kind: str = "note") -> dict:
    item = legacy.files[0]
    row = {"note_id": str(uuid.uuid4()), "project_id": project_id,
           "file_id": item["file_id"], "version_id": item["version_id"],
           "kind": kind, "body": "Authored body", "page_number": None,
           "extraction_contract": None, "page_text_sha256": None,
           "start_codepoint": None, "end_codepoint": None, "quote": None,
           "revision": 1, "created_at_utc": NOW, "updated_at_utc": NOW}
    if kind == "passage":
        text = (legacy.originals / item["original_name"]).read_text(encoding="utf-8")
        quote = "First 😀 passage"
        assert text.startswith(quote)
        row.update(body="", page_number=1, extraction_contract="library-text-lf/v1",
                   page_text_sha256=digest(text.encode()), start_codepoint=0,
                   end_codepoint=len(quote), quote=quote)
    return row


def insert_note(conn: sqlite3.Connection, values: dict) -> None:
    keys = tuple(values)
    conn.execute(f"INSERT INTO evidence_notes({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})",
                 tuple(values[key] for key in keys))


@pytest.mark.parametrize("kind,change", [
    ("note", {"body": ""}), ("note", {"body": None}),
    ("note", {"body": "x" * 20001}), ("note", {"kind": "html"}),
    ("note", {"page_number": 1}), ("note", {"quote": "x"}),
    ("note", {"revision": 0}), ("note", {"note_id": None}),
    ("passage", {"page_number": None}), ("passage", {"page_number": 0}),
    ("passage", {"extraction_contract": None}),
    ("passage", {"page_text_sha256": None}),
    ("passage", {"page_text_sha256": "A" * 64}),
    ("passage", {"page_text_sha256": "a" * 63}),
    ("passage", {"start_codepoint": None}), ("passage", {"end_codepoint": None}),
    ("passage", {"start_codepoint": -1}), ("passage", {"end_codepoint": 0}),
    ("passage", {"quote": None}), ("passage", {"quote": ""}),
    ("passage", {"quote": "wrong length"}),
    ("passage", {"quote": "x" * 20001, "end_codepoint": 20001}),
])
def test_note_check_and_not_null_rejections_leave_no_partial_rows(
    legacy: Legacy, kind: str, change: dict,
) -> None:
    project_id = seed_project(legacy)
    values = note_values(legacy, project_id, kind)
    values.update(change)
    before = contents(legacy.conn)
    with pytest.raises(sqlite3.IntegrityError):
        insert_note(legacy.conn, values)
    legacy.conn.rollback()
    assert contents(legacy.conn) == before


@pytest.mark.parametrize("change", [{"project_id": None}, {"vault_id": None},
                                    {"name": ""}, {"name": "x" * 121},
                                    {"revision": 0}, {"created_at_utc": None},
                                    {"updated_at_utc": None}])
def test_project_constraints_are_real_sqlite_constraints(legacy: Legacy, change: dict) -> None:
    db.init_db(conn=legacy.conn)
    values = {"project_id": str(uuid.uuid4()), "vault_id": legacy.vault_id,
              "name": "Valid", "revision": 1, "created_at_utc": NOW, "updated_at_utc": NOW}
    values.update(change)
    before = contents(legacy.conn)
    with pytest.raises(sqlite3.IntegrityError):
        legacy.conn.execute(
            "INSERT INTO evidence_projects(project_id,vault_id,name,revision,created_at_utc,updated_at_utc) "
            "VALUES (:project_id,:vault_id,:name,:revision,:created_at_utc,:updated_at_utc)", values)
    legacy.conn.rollback()
    assert contents(legacy.conn) == before


@pytest.mark.parametrize("field", ["project_id", "file_id", "version_id"])
def test_note_foreign_keys_reject_missing_parent(legacy: Legacy, field: str) -> None:
    project_id = seed_project(legacy)
    values = note_values(legacy, project_id)
    values[field] = str(uuid.uuid4())
    before = contents(legacy.conn)
    with pytest.raises(sqlite3.IntegrityError):
        insert_note(legacy.conn, values)
    legacy.conn.rollback()
    assert contents(legacy.conn) == before


def test_note_and_project_uniqueness_and_restrict_preserve_rows(legacy: Legacy) -> None:
    project_id = seed_project(legacy)
    plain = note_values(legacy, project_id)
    passage = note_values(legacy, project_id, "passage")
    insert_note(legacy.conn, plain)
    insert_note(legacy.conn, passage)
    legacy.conn.commit()
    before = contents(legacy.conn)
    actions = [
        ("INSERT INTO evidence_notes(" + ",".join(plain) + ") VALUES (" + ",".join("?" for _ in plain) + ")", tuple(plain.values())),
        ("INSERT INTO evidence_projects(project_id,vault_id,name,revision,created_at_utc,updated_at_utc) VALUES (?,?,?,1,?,?)", (project_id, legacy.vault_id, "Repeated ID", NOW, NOW)),
        ("INSERT INTO evidence_project_files(project_id,file_id,version_id,added_at_utc) VALUES (?,?,?,?)", (project_id, legacy.files[0]["file_id"], legacy.files[0]["version_id"], NOW)),
        ("DELETE FROM evidence_projects WHERE project_id=?", (project_id,)),
        ("DELETE FROM library_files WHERE file_id=?", (legacy.files[0]["file_id"],)),
        ("DELETE FROM library_vault WHERE vault_id=?", (legacy.vault_id,)),
    ]
    for sql, parameters in actions:
        with pytest.raises(sqlite3.IntegrityError):
            legacy.conn.execute(sql, parameters)
        legacy.conn.rollback()
        assert contents(legacy.conn) == before
    assert len(legacy.conn.execute("SELECT * FROM evidence_notes").fetchall()) == 2
    assert_approved_shape(legacy.conn)


@pytest.mark.parametrize("table", ["evidence_project_files", "evidence_notes"])
def test_cross_pair_corruption_is_not_caught_by_separate_fks_but_domain_refuses(
    legacy: Legacy, table: str,
) -> None:
    project_id = seed_project(legacy)
    values = note_values(legacy, project_id)
    insert_note(legacy.conn, values)
    legacy.conn.commit()
    good = contents(legacy.conn)
    file_a, file_b = legacy.files
    legacy.conn.execute(f"UPDATE {table} SET version_id=? WHERE project_id=? AND file_id=?",
                        (file_b["version_id"], project_id, file_a["file_id"]))
    legacy.conn.commit()
    damaged = contents(legacy.conn)
    assert damaged != good
    assert legacy.conn.execute("PRAGMA foreign_key_check").fetchall() == [], (
        "this arm must use two individually valid foreign IDs")
    try:
        if table == "evidence_project_files":
            with pytest.raises(library.LibraryError):
                evidence.list_files(legacy.conn, legacy.vault_id, project_id)
        with pytest.raises(library.LibraryError):
            evidence.list_notes(legacy.conn, legacy.vault_id, project_id)
        with pytest.raises(library.LibraryError):
            evidence.edit_note(legacy.conn, legacy.vault_id, project_id, 1,
                               values["note_id"], 1, "Must not overwrite corruption")
        assert contents(legacy.conn) == damaged
    finally:
        legacy.conn.execute(f"UPDATE {table} SET version_id=? WHERE project_id=? AND file_id=?",
                            (file_a["version_id"], project_id, file_a["file_id"]))
        legacy.conn.commit()
    assert contents(legacy.conn) == good
    assert evidence.list_notes(legacy.conn, legacy.vault_id, project_id)["notes"][0]["body"] == values["body"]


def test_membership_removal_and_restart_preserve_both_saved_note_kinds(legacy: Legacy) -> None:
    project_id = seed_project(legacy)
    for kind in ("note", "passage"):
        insert_note(legacy.conn, note_values(legacy, project_id, kind))
    legacy.conn.commit()
    before_notes = contents(legacy.conn, {"evidence_notes"})
    before_library = contents(legacy.conn, set(LIBRARY_TABLES))
    before_files = file_census(legacy.roots)
    item = legacy.files[0]
    removed = evidence.remove_file(legacy.conn, legacy.vault_id, project_id, 1,
                                   item["file_id"], item["version_id"])
    assert removed["removed"] is True
    assert contents(legacy.conn, {"evidence_notes"}) == before_notes
    assert contents(legacy.conn, set(LIBRARY_TABLES)) == before_library
    saved = evidence.list_notes(legacy.conn, legacy.vault_id, project_id)["notes"]
    assert len(saved) == 2 and {n["membership_state"] for n in saved} == {"removed"}
    settled = contents(legacy.conn)
    legacy.conn.close()
    legacy.conn = db.get_connection(legacy.path)
    db.init_db(conn=legacy.conn)
    assert contents(legacy.conn) == settled
    assert file_census(legacy.roots) == before_files
    readded = evidence.add_file(legacy.conn, legacy.vault_id, project_id, 2,
                               item["file_id"], item["version_id"])
    assert readded["added"] is True
    assert {n["membership_state"] for n in evidence.list_notes(
        legacy.conn, legacy.vault_id, project_id)["notes"]} == {"member"}
    assert contents(legacy.conn, {"evidence_notes"}) == before_notes
    assert contents(legacy.conn, set(LIBRARY_TABLES)) == before_library
    assert file_census(legacy.roots) == before_files
