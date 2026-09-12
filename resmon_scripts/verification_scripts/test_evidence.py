"""Synthetic exact-version Evidence domain tests.

Real SQLite and retained Library objects. HTTP body validation, editor behavior,
PDF extraction and independent acceptance are verified separately.
"""
from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import hashlib
from pathlib import Path
import re
import sqlite3
import threading
import uuid

import pytest

from implementation_scripts import database as db, evidence as ev, evidence_reader as reader, library as lib


RAW_UNICODE = (
    "Lead 😀 e\u0301 / é\r\nfirst target 😀\rsecond target 😀\n"
    "<script>never()</script> [inert](https://evidence.invalid/) $(fiction)\n"
).encode("utf-8")


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(raw: bytes) -> str:
    return raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")


def sql_snapshot(conn: sqlite3.Connection, tables: set[str] | None = None) -> dict:
    if tables is None:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return {name: sorted([tuple(row) for row in conn.execute(
        'SELECT * FROM "' + name.replace('"', '""') + '"')], key=repr) for name in sorted(tables)}


@dataclass
class Workspace:
    conn: sqlite3.Connection
    database: Path
    root: Path
    originals: Path
    vault_id: str
    project_id: str
    document_id: int
    files: list[dict] = field(default_factory=list)
    raw: dict[str, bytes] = field(default_factory=dict)


def revision(workspace: Workspace, project_id: str | None = None) -> int:
    return ev.detail(workspace.conn, workspace.vault_id,
                     project_id or workspace.project_id)["project"]["revision"]


def put_file(workspace: Workspace, name: str, raw: bytes, *, member: bool = True) -> dict:
    # Each chosen original is a distinct authored path, including same-name tests.
    chosen = workspace.originals / str(uuid.uuid4())
    chosen.mkdir()
    (chosen / name).write_bytes(raw)
    with lib.Import(workspace.conn, workspace.vault_id, name, workspace.document_id) as upload:
        upload.write(raw)
        item = upload.finish()["file"]
    if item["file_id"] not in workspace.raw:
        workspace.files.append(item)
        workspace.raw[item["file_id"]] = raw
    if member:
        ev.add_file(workspace.conn, workspace.vault_id, workspace.project_id, revision(workspace),
                    item["file_id"], item["version_id"])
    return item


def files_snapshot(workspace: Workspace) -> dict:
    return {(str(root), str(file.relative_to(root))): sha(file.read_bytes())
            for root in (workspace.originals, workspace.root)
            for file in sorted(root.rglob("*")) if file.is_file()}


def anchor_for(workspace: Workspace, item: dict, quote: str = "target 😀", occurrence: int = 0) -> dict:
    text = canonical(workspace.raw[item["file_id"]])
    start = -1
    for _ in range(occurrence + 1):
        start = text.index(quote, start + 1)
    return {"page_number": 1, "extraction_contract": "library-text-lf/v1",
            "page_text_sha256": sha(text.encode("utf-8")),
            "start_codepoint": start, "end_codepoint": start + len(quote), "quote": quote}


def save_note(workspace: Workspace, item: dict, body: str = "Authored note", *,
              anchor: dict | None = None, project_id: str | None = None) -> dict:
    project = project_id or workspace.project_id
    return ev.create_note(workspace.conn, workspace.vault_id, project, revision(workspace, project),
                          item["file_id"], item["version_id"], "passage" if anchor else "note",
                          body, anchor)["note"]


@pytest.fixture
def workspace(tmp_path: Path) -> Iterator[Workspace]:
    database = tmp_path / "evidence.db"
    conn = db.get_connection(database)
    db.init_db(conn=conn)
    parent, originals = tmp_path / "vault-parent", tmp_path / "originals"
    parent.mkdir()
    originals.mkdir()
    configured = lib.create_vault(conn, str(parent))["vault"]
    document_id = db.insert_document(conn, {"source_repository": "synthetic", "external_id": "owned-fixture",
                                           "title": "Authored provenance sentinel", "metadata_hash": "fixture"})
    assert document_id is not None
    project = ev.create_project(conn, configured["vault_id"], "Evidence fixture")["project"]
    value = Workspace(conn, database, parent / configured["label"], originals,
                      configured["vault_id"], project["project_id"], document_id)
    try:
        put_file(value, "unicode.txt", RAW_UNICODE)
        put_file(value, "hostile.md", b'# <script>never()</script>\n![inert](https://evidence.invalid/x)\n')
        put_file(value, "unselected.txt", b"Unselected original and unrelated text\n")
        put_file(value, "fourth.txt", b"Fourth independently selected file\n")
        yield value
    finally:
        value.conn.close()


def test_no_configured_vault_cannot_create_project_or_implicitly_create_files(tmp_path: Path) -> None:
    conn = db.get_connection(tmp_path / "empty.db")
    try:
        db.init_db(conn=conn)
        before = sql_snapshot(conn)
        with pytest.raises(lib.LibraryError) as caught:
            ev.create_project(conn, str(uuid.uuid4()), "No implicit vault")
        assert caught.value.reason == "no_vault"
        assert sql_snapshot(conn) == before
        assert not list(tmp_path.glob("resmon-library-*"))
    finally:
        conn.close()


def test_project_literal_name_identity_revision_and_microsecond_utc(workspace: Workspace) -> None:
    title = "  ../Research <script>no()</script> 😀 e\u0301  "
    result = ev.create_project(workspace.conn, workspace.vault_id, title)
    project = result["project"]
    assert result["contract_version"] == 1 and result["vault_id"] == workspace.vault_id
    assert str(uuid.UUID(project["project_id"])) == project["project_id"]
    assert project["name"] == title.strip() and project["revision"] == 1
    assert project["created_at_utc"] == project["updated_at_utc"]
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00", project["created_at_utc"])
    assert project["file_count"] == project["note_count"] == 0


@pytest.mark.parametrize("value", ["", " \n\t ", "x" * 121, "bad\x00name", "\ud800", None, 1])
def test_invalid_project_names_leave_all_rows_unchanged(workspace: Workspace, value: object) -> None:
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        ev.create_project(workspace.conn, workspace.vault_id, value)
    assert caught.value.status == 422
    assert sql_snapshot(workspace.conn) == before


def test_53_projects_use_frozen_50_plus_3_ceiling_and_explicit_refresh(workspace: Workspace) -> None:
    for index in range(52):
        ev.create_project(workspace.conn, workspace.vault_id, f"Same title {index % 2}")
    first = ev.list_projects(workspace.conn, workspace.vault_id)
    assert len(first["projects"]) == 50 and first["total"] == 53 and first["has_more"] is True
    new = ev.create_project(workspace.conn, workspace.vault_id, "Created after ceiling")["project"]
    second = ev.list_projects(workspace.conn, workspace.vault_id,
                              after_id=first["next_after_id"], through_id=first["through_id"])
    ids = [p["id"] for p in first["projects"] + second["projects"]]
    assert len(second["projects"]) == 3 and second["total"] == 53 and second["has_more"] is False
    assert len(set(ids)) == 53 and ids == sorted(ids)
    assert new["id"] not in ids
    refreshed = ev.list_projects(workspace.conn, workspace.vault_id)
    assert refreshed["total"] == 54 and refreshed["through_id"] == new["id"]


@pytest.mark.parametrize("field,value", [("after_id", True), ("after_id", 1.0), ("after_id", "1"),
                                         ("through_id", False), ("limit", True), ("limit", 0),
                                         ("limit", 51), ("limit", "2")])
def test_pagination_is_strict_not_coerced(workspace: Workspace, field: str, value: object) -> None:
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        ev.list_projects(workspace.conn, workspace.vault_id, **{field: value})
    assert caught.value.status == 422
    assert sql_snapshot(workspace.conn) == before


def test_duplicate_bytes_and_same_name_changed_bytes_never_infer_note_identity(workspace: Workspace) -> None:
    first = workspace.files[0]
    saved = save_note(workspace, first, anchor=anchor_for(workspace, first))
    duplicate = put_file(workspace, "renamed.txt", RAW_UNICODE)
    assert (duplicate["file_id"], duplicate["version_id"]) == (first["file_id"], first["version_id"])
    assert duplicate["original_name"] == first["original_name"]
    changed = put_file(workspace, first["original_name"], b"New bytes under the same chosen basename\n")
    assert changed["file_id"] != first["file_id"] and changed["version_id"] != first["version_id"]
    assert ev.list_notes(workspace.conn, workspace.vault_id, workspace.project_id,
                         changed["file_id"], changed["version_id"])["notes"] == []
    old = ev.list_notes(workspace.conn, workspace.vault_id, workspace.project_id)["notes"]
    assert len(old) == 1 and old[0]["note_id"] == saved["note_id"]


def test_remove_readd_noops_preserve_notes_other_project_library_and_provenance(workspace: Workspace) -> None:
    item = workspace.files[0]
    plain = save_note(workspace, item, "Keep plain")
    passage = save_note(workspace, item, "Keep passage", anchor=anchor_for(workspace, item, occurrence=1))
    other = ev.create_project(workspace.conn, workspace.vault_id, "Other project")["project"]
    ev.add_file(workspace.conn, workspace.vault_id, other["project_id"], 1, item["file_id"], item["version_id"])
    save_note(workspace, item, "Other project body", project_id=other["project_id"])
    untouched_tables = {"documents", "document_authors", "document_categories", "library_vault", "library_files", "library_file_documents", "evidence_notes"}
    before = sql_snapshot(workspace.conn, untouched_tables)
    before_files = files_snapshot(workspace)
    other_before = ev.detail(workspace.conn, workspace.vault_id, other["project_id"])
    old_member = ev.member(workspace.conn, workspace.vault_id, workspace.project_id, item["file_id"], item["version_id"])
    current = revision(workspace)
    noop = ev.add_file(workspace.conn, workspace.vault_id, workspace.project_id, current, item["file_id"], item["version_id"])
    assert noop["added"] is False and noop["membership"] == old_member
    assert revision(workspace) == current and sql_snapshot(workspace.conn, untouched_tables) == before
    removed = ev.remove_file(workspace.conn, workspace.vault_id, workspace.project_id, current, item["file_id"], item["version_id"])
    assert removed["removed"] is True and revision(workspace) == current + 1
    settled = sql_snapshot(workspace.conn)
    again = ev.remove_file(workspace.conn, workspace.vault_id, workspace.project_id, current + 1, item["file_id"], item["version_id"])
    assert again["removed"] is False and sql_snapshot(workspace.conn) == settled
    notes = ev.list_notes(workspace.conn, workspace.vault_id, workspace.project_id)["notes"]
    assert {n["note_id"] for n in notes} == {plain["note_id"], passage["note_id"]}
    assert {n["membership_state"] for n in notes} == {"removed"}
    with pytest.raises(lib.LibraryError):
        save_note(workspace, item, "No new note without membership")
    assert ev.detail(workspace.conn, workspace.vault_id, other["project_id"]) == other_before
    assert sql_snapshot(workspace.conn, untouched_tables) == before
    assert files_snapshot(workspace) == before_files
    ev.add_file(workspace.conn, workspace.vault_id, workspace.project_id, current + 1, item["file_id"], item["version_id"])
    assert {n["membership_state"] for n in ev.list_notes(workspace.conn, workspace.vault_id, workspace.project_id)["notes"]} == {"member"}
    assert sql_snapshot(workspace.conn, untouched_tables) == before and files_snapshot(workspace) == before_files


@pytest.mark.parametrize("action", ["rename", "membership", "note"])
def test_two_sqlite_clients_have_one_cas_winner_without_lost_update(workspace: Workspace, action: str) -> None:
    item = put_file(workspace, "raced.txt", b"Raced authored bytes\n", member=False)
    expected = revision(workspace)
    old_note_count = workspace.conn.execute("SELECT count(*) FROM evidence_notes").fetchone()[0]
    barrier = threading.Barrier(2)

    def contender(label: str) -> tuple[str, object]:
        conn = db.get_connection(workspace.database)
        try:
            barrier.wait(timeout=5)
            try:
                if action == "rename":
                    result = ev.rename_project(conn, workspace.vault_id, workspace.project_id, expected, label)
                elif action == "membership":
                    result = ev.add_file(conn, workspace.vault_id, workspace.project_id, expected, item["file_id"], item["version_id"])
                else:
                    result = ev.create_note(conn, workspace.vault_id, workspace.project_id, expected,
                                            workspace.files[0]["file_id"], workspace.files[0]["version_id"], "note", label)
                return "success", result
            except lib.LibraryError as error:
                return "refused", (error.status, error.reason)
        finally:
            conn.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(contender, ("writer A", "writer B")))
    assert sorted(outcome for outcome, _ in results) == ["refused", "success"]
    assert [detail for outcome, detail in results if outcome == "refused"] == [(409, "stale_revision")]
    assert revision(workspace) == expected + 1
    if action == "membership":
        assert workspace.conn.execute("SELECT count(*) FROM evidence_project_files WHERE project_id=? AND file_id=?",
                                      (workspace.project_id, item["file_id"])).fetchone()[0] == 1
    if action == "note":
        assert workspace.conn.execute("SELECT count(*) FROM evidence_notes").fetchone()[0] == old_note_count + 1


@pytest.mark.parametrize("invalid_revision", [True, 1.0, "1", None, 0])
def test_write_revision_is_mandatory_exact_integer(workspace: Workspace, invalid_revision: object) -> None:
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        ev.rename_project(workspace.conn, workspace.vault_id, workspace.project_id, invalid_revision, "No coercion")
    assert caught.value.status == 422 and sql_snapshot(workspace.conn) == before


def test_passage_edit_changes_body_only_and_checks_note_revision(workspace: Workspace) -> None:
    item = workspace.files[0]
    note = save_note(workspace, item, "before", anchor=anchor_for(workspace, item, occurrence=1))
    immutable = {key: note[key] for key in ("note_id", "project_id", "file_id", "version_id", "kind", "created_at_utc", *ev.ANCHOR_FIELDS)}
    old_revision = revision(workspace)
    edited = ev.edit_note(workspace.conn, workspace.vault_id, workspace.project_id, old_revision,
                          note["note_id"], note["revision"], "<script>literal</script>\n```notes```")["note"]
    assert {key: edited[key] for key in immutable} == immutable
    assert edited["revision"] == note["revision"] + 1 and revision(workspace) == old_revision + 1
    assert edited["body"] == "<script>literal</script>\n```notes```"
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        ev.edit_note(workspace.conn, workspace.vault_id, workspace.project_id, revision(workspace),
                     note["note_id"], note["revision"], "stale edit")
    assert caught.value.reason == "stale_note" and caught.value.status == 409
    assert sql_snapshot(workspace.conn) == before
    workspace.conn.close()
    workspace.conn = db.get_connection(workspace.database)
    db.init_db(conn=workspace.conn)
    reopened = ev.list_notes(workspace.conn, workspace.vault_id, workspace.project_id)["notes"][0]
    assert {key: reopened[key] for key in immutable} == immutable and reopened["body"] == edited["body"]


@pytest.mark.parametrize("damage", ["quote", "hash", "utf16_offsets", "contract", "bool_offset", "stale_revision"])
def test_backend_reextracts_passage_and_refuses_forged_basis_without_write(workspace: Workspace, damage: str) -> None:
    item = workspace.files[0]
    anchor = anchor_for(workspace, item, occurrence=1)
    expected = revision(workspace)
    if damage == "quote":
        anchor["quote"] = "x" * len(anchor["quote"])
    elif damage == "hash":
        anchor["page_text_sha256"] = "0" * 64
    elif damage == "utf16_offsets":
        text = canonical(workspace.raw[item["file_id"]])
        utf16_start = len(text[:anchor["start_codepoint"]].encode("utf-16-le")) // 2
        assert utf16_start != anchor["start_codepoint"]
        anchor["start_codepoint"] = utf16_start
        anchor["end_codepoint"] = utf16_start + len(anchor["quote"])
    elif damage == "contract":
        anchor["extraction_contract"] = "library-text-lf/v0"
    elif damage == "bool_offset":
        anchor["start_codepoint"] = True
    else:
        expected -= 1
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError):
        ev.create_note(workspace.conn, workspace.vault_id, workspace.project_id, expected,
                        item["file_id"], item["version_id"], "passage", "", anchor)
    assert sql_snapshot(workspace.conn) == before
    # The independently authored correct anchor is accepted by the same boundary.
    saved = save_note(workspace, item, "", anchor=anchor_for(workspace, item, occurrence=1))
    assert saved["quote"] == "target 😀" and saved["start_codepoint"] == anchor_for(workspace, item, occurrence=1)["start_codepoint"]


def test_membership_change_during_extraction_is_rechecked_before_note_commit(
    workspace: Workspace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = workspace.files[0]
    original = reader.read_text
    initial_revision = revision(workspace)

    def change_membership(*args: object, **kwargs: object) -> dict:
        result = original(*args, **kwargs)
        second = db.get_connection(workspace.database)
        try:
            ev.remove_file(second, workspace.vault_id, workspace.project_id, initial_revision,
                            item["file_id"], item["version_id"])
        finally:
            second.close()
        return result

    monkeypatch.setattr(reader, "read_text", change_membership)
    with pytest.raises(lib.LibraryError) as caught:
        ev.create_note(workspace.conn, workspace.vault_id, workspace.project_id, initial_revision,
                        item["file_id"], item["version_id"], "passage", "", anchor_for(workspace, item))
    assert caught.value.status == 409
    assert workspace.conn.execute("SELECT count(*) FROM evidence_notes").fetchone()[0] == 0
    assert revision(workspace) == initial_revision + 1
    assert workspace.conn.execute("SELECT count(*) FROM evidence_project_files WHERE project_id=? AND file_id=?",
                                  (workspace.project_id, item["file_id"])).fetchone()[0] == 0


def test_wrong_version_vault_and_project_never_attach_a_note(workspace: Workspace) -> None:
    item, other = workspace.files[:2]
    attempts = [(workspace.vault_id, workspace.project_id, item["file_id"], other["version_id"]),
                (str(uuid.uuid4()), workspace.project_id, item["file_id"], item["version_id"]),
                (workspace.vault_id, str(uuid.uuid4()), item["file_id"], item["version_id"])]
    before = sql_snapshot(workspace.conn)
    for vid, project, fid, version in attempts:
        with pytest.raises(lib.LibraryError):
            ev.create_note(workspace.conn, vid, project, revision(workspace), fid, version, "note", "Wrong identity")
        assert sql_snapshot(workspace.conn) == before


def test_actual_project_quota_refuses_without_truncation(workspace: Workspace) -> None:
    assert (ev.MAX_PROJECTS, ev.MAX_MEMBERS, ev.MAX_NOTES, ev.MAX_BODY) == (100, 1000, 5000, 20000)
    for index in range(99):
        ev.create_project(workspace.conn, workspace.vault_id, f"Project {index}")
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        ev.create_project(workspace.conn, workspace.vault_id, "Project 101")
    assert caught.value.status == 413 and caught.value.reason == "project_limit"
    assert sql_snapshot(workspace.conn) == before

def test_reduced_member_and_note_quota_preserves_existing_data_and_membership_noop(
    workspace: Workspace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert (ev.MAX_MEMBERS, ev.MAX_NOTES) == (1000, 5000)
    new = put_file(workspace, "over-member-limit.txt", b"New file remains in Library", member=False)
    monkeypatch.setattr(ev, "MAX_MEMBERS", 4)
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as member_error:
        ev.add_file(workspace.conn, workspace.vault_id, workspace.project_id, revision(workspace),
                    new["file_id"], new["version_id"])
    assert member_error.value.reason == "member_limit" and member_error.value.status == 413
    assert sql_snapshot(workspace.conn) == before
    existing = workspace.files[0]
    noop = ev.add_file(workspace.conn, workspace.vault_id, workspace.project_id, revision(workspace),
                       existing["file_id"], existing["version_id"])
    assert noop["added"] is False and sql_snapshot(workspace.conn) == before
    save_note(workspace, existing, "First permitted note")
    monkeypatch.setattr(ev, "MAX_NOTES", 1)
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as note_error:
        save_note(workspace, existing, "Second note is explicitly refused")
    assert note_error.value.reason == "note_limit" and note_error.value.status == 413
    assert sql_snapshot(workspace.conn) == before


@pytest.mark.parametrize("body", ["", "x" * 20001, "a\x00b", "\ud800", None, True])
def test_plain_note_requires_bounded_literal_body(workspace: Workspace, body: object) -> None:
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        save_note(workspace, workspace.files[0], body)
    assert caught.value.status == 422 and sql_snapshot(workspace.conn) == before


@pytest.mark.parametrize("table,field,read_name", [
    ("evidence_projects", "created_at_utc", "list_projects"),
    ("evidence_projects", "updated_at_utc", "list_projects"),
    ("evidence_project_files", "added_at_utc", "list_files"),
    ("evidence_notes", "created_at_utc", "list_notes"),
    ("evidence_notes", "updated_at_utc", "list_notes"),
])
def test_corrupt_evidence_timestamp_refuses_read_and_bundle_without_repair(workspace: Workspace, table: str, field: str, read_name: str) -> None:
    from implementation_scripts import evidence_export
    item = workspace.files[0]
    save_note(workspace, item, "Preserve this saved body")
    before = sql_snapshot(workspace.conn)
    row = workspace.conn.execute(f'SELECT id,{field} FROM {table} ORDER BY id LIMIT 1').fetchone()
    workspace.conn.execute(f'UPDATE {table} SET {field}=? WHERE id=?', ('2026-99-11T12:00:00.123456+00:00', row[0]))
    workspace.conn.commit()
    damaged = sql_snapshot(workspace.conn)
    try:
        args = (workspace.conn, workspace.vault_id) if read_name == 'list_projects' else (workspace.conn, workspace.vault_id, workspace.project_id)
        with pytest.raises(lib.LibraryError) as caught:
            getattr(ev, read_name)(*args)
        assert caught.value.reason == 'corrupt_record'
        # Read the revision directly because project() deliberately refuses
        # the corrupt timestamp; stale CAS must not mask the shape check.
        actual_revision = workspace.conn.execute('SELECT revision FROM evidence_projects WHERE project_id=?', (workspace.project_id,)).fetchone()[0]
        with pytest.raises(lib.LibraryError) as caught:
            evidence_export.build(workspace.conn, workspace.vault_id, workspace.project_id, actual_revision,
                                  [{'file_id': item['file_id'], 'version_id': item['version_id']}], False)
        assert caught.value.reason == 'corrupt_record'
        assert sql_snapshot(workspace.conn) == damaged
    finally:
        workspace.conn.execute(f'UPDATE {table} SET {field}=? WHERE id=?', (row[1], row[0]))
        workspace.conn.commit()
    assert sql_snapshot(workspace.conn) == before
