"""Actual retained-byte Evidence reads.

Parser stress/child enforcement is in test_evidence_pdf. These tests exercise
domain access and real retained descriptors, including exact literal text basis.
"""
from __future__ import annotations

import os
import threading
import uuid

import pytest

from implementation_scripts import database as db, evidence as ev, evidence_reader as reader, library as lib, library_text
from test_evidence import (
    Workspace, anchor_for, canonical, files_snapshot, put_file, revision,
    save_note, sha, sql_snapshot, workspace,
)


def read(workspace: Workspace, item: dict, page: int = 1, **kwargs: object) -> dict:
    return reader.read_text(workspace.conn, workspace.vault_id, workspace.project_id,
                            item["file_id"], item["version_id"], page, **kwargs)


@pytest.mark.parametrize("index", [0, 1])
def test_literal_lf_unicode_codepoint_basis_leaves_sql_and_originals_unchanged(workspace: Workspace, index: int) -> None:
    item = workspace.files[index]
    raw = workspace.raw[item["file_id"]]
    expected = canonical(raw)
    before, before_files = sql_snapshot(workspace.conn), files_snapshot(workspace)
    changes = workspace.conn.total_changes
    result = read(workspace, item)
    assert result["contract_version"] == 1
    assert (result["vault_id"], result["project_id"], result["file_id"], result["version_id"]) == (
        workspace.vault_id, workspace.project_id, item["file_id"], item["version_id"])
    assert result["status"] == "extracted" and result["text"] == expected
    assert result["sha256"] == sha(raw) and result["page_text_sha256"] == sha(expected.encode("utf-8"))
    assert result["extraction_contract"] == "library-text-lf/v1"
    assert result["page_number"] == result["page_count"] == 1 and result["examined_pages"] == [1]
    assert "\r" not in result["text"]
    assert "<script>never()</script>" in result["text"]
    assert workspace.conn.total_changes == changes and sql_snapshot(workspace.conn) == before
    assert files_snapshot(workspace) == before_files
    if index == 0:
        assert "e\u0301 / é" in result["text"]  # No Unicode composition/decomposition.
        first, second = anchor_for(workspace, item), anchor_for(workspace, item, occurrence=1)
        assert first["start_codepoint"] != second["start_codepoint"]
        for anchor in (first, second):
            assert result["text"][anchor["start_codepoint"]:anchor["end_codepoint"]] == "target 😀"
            assert anchor["end_codepoint"] - anchor["start_codepoint"] == len("target 😀")


@pytest.mark.parametrize("page", [True, False, 1.0, "1", None, 0, 2, 201])
def test_text_page_inputs_are_exact_integers_and_only_logical_page_one(workspace: Workspace, page: object) -> None:
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        read(workspace, workspace.files[0], page)
    assert caught.value.status == 422
    assert sql_snapshot(workspace.conn) == before


@pytest.mark.parametrize("raw,reason", [(b"a" * 262144, None), (b"a" * 262145, "too_large"),
                                        (b"\n" * 4999, None), (b"\n" * 5000, "too_many_lines")])
def test_evidence_reuses_actual_library_text_limits_without_truncation(workspace: Workspace, raw: bytes, reason: str | None) -> None:
    assert (library_text.MAX_TEXT_BYTES, library_text.MAX_LINES) == (262144, 5000)
    item = put_file(workspace, "bounded.txt", raw)
    before = sql_snapshot(workspace.conn)
    if reason is None:
        result = read(workspace, item)
        assert result["text"] == canonical(raw)
    else:
        with pytest.raises(lib.LibraryError) as caught:
            read(workspace, item)
        assert caught.value.reason == reason and caught.value.status == 413
    assert sql_snapshot(workspace.conn) == before
    assert (workspace.root / item["relative_path"]).read_bytes() == raw
    # Retention remains independently usable even when the bounded reader refuses.
    assert lib.open_request(workspace.conn, workspace.vault_id, item["file_id"], item["version_id"])["file_id"] == item["file_id"]


def test_existing_note_permits_removed_member_read_but_unselected_file_does_not(workspace: Workspace) -> None:
    item = workspace.files[0]
    save_note(workspace, item, anchor=anchor_for(workspace, item))
    ev.remove_file(workspace.conn, workspace.vault_id, workspace.project_id, revision(workspace),
                    item["file_id"], item["version_id"])
    before = sql_snapshot(workspace.conn)
    assert read(workspace, item)["text"] == canonical(workspace.raw[item["file_id"]])
    assert sql_snapshot(workspace.conn) == before
    unselected = put_file(workspace, "never-selected.txt", b"Never selected in this project", member=False)
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        read(workspace, unselected)
    assert caught.value.reason == "not_member"
    assert sql_snapshot(workspace.conn) == before


@pytest.mark.parametrize("damage", ["same_size", "missing", "symlink", "hardlink", "marker", "invalid_utf8", "nul"])
def test_corrupt_missing_or_unauthorized_retained_objects_refuse_and_restore(
    workspace: Workspace, damage: str, tmp_path,
) -> None:
    item = workspace.files[0]
    saved = save_note(workspace, item, "Saved independently of availability", anchor=anchor_for(workspace, item))
    path = workspace.root / item["relative_path"]
    raw = path.read_bytes()
    marker = workspace.root / "vault.json"
    marker_bytes = marker.read_bytes()
    before_sql = sql_snapshot(workspace.conn)
    outside = tmp_path / "owned-outside-object.txt"
    outside.write_bytes(raw)
    if damage == "same_size":
        path.write_bytes(b"x" * len(raw))
    elif damage in ("missing", "symlink", "hardlink"):
        path.unlink()
        if damage == "symlink":
            path.symlink_to(outside)
        elif damage == "hardlink":
            os.link(outside, path)
    elif damage == "marker":
        marker.write_bytes(b"{}")
    else:
        altered = b"\xff" if damage == "invalid_utf8" else b"a\x00b"
        path.write_bytes(altered)
        # Valid-looking catalog hash cannot bypass UTF-8/NUL rules.
        workspace.conn.execute("UPDATE library_files SET byte_size=?,sha256=? WHERE file_id=?",
                                (len(altered), sha(altered), item["file_id"]))
        workspace.conn.commit()
    damaged_sql = sql_snapshot(workspace.conn)
    try:
        with pytest.raises((lib.LibraryError, OSError)):
            read(workspace, item)
        assert sql_snapshot(workspace.conn) == damaged_sql
        # Listing saved records does not claim re-extraction/current availability.
        notes = ev.list_notes(workspace.conn, workspace.vault_id, workspace.project_id)["notes"]
        assert len(notes) == 1 and notes[0]["note_id"] == saved["note_id"]
        assert notes[0]["quote"] == saved["quote"] and notes[0]["body"] == saved["body"]
        assert notes[0]["resolution"] == "not_checked"
        assert outside.read_bytes() == raw
    finally:
        if path.is_symlink() or path.exists():
            path.unlink()
        path.write_bytes(raw)
        marker.write_bytes(marker_bytes)
        workspace.conn.execute("UPDATE library_files SET byte_size=?,sha256=? WHERE file_id=?",
                                (item["byte_size"], item["sha256"], item["file_id"]))
        workspace.conn.commit()
    assert sql_snapshot(workspace.conn) == before_sql
    restored = read(workspace, item)
    assert restored["text"] == canonical(raw) and restored["page_text_sha256"] == saved["page_text_sha256"]
    assert outside.read_bytes() == raw


def test_missing_bytes_do_not_erase_or_reanchor_saved_note_across_restart(workspace: Workspace) -> None:
    item = workspace.files[0]
    saved = save_note(workspace, item, "Saved body", anchor=anchor_for(workspace, item, occurrence=1))
    path = workspace.root / item["relative_path"]
    raw = path.read_bytes()
    path.unlink()
    try:
        workspace.conn.close()
        workspace.conn = db.get_connection(workspace.database)
        db.init_db(conn=workspace.conn)
        note = ev.list_notes(workspace.conn, workspace.vault_id, workspace.project_id)["notes"][0]
        for key in ("note_id", "project_id", "file_id", "version_id", "body", *ev.ANCHOR_FIELDS):
            assert note[key] == saved[key]
        with pytest.raises((lib.LibraryError, OSError)):
            read(workspace, item)
        edited = ev.edit_note(workspace.conn, workspace.vault_id, workspace.project_id, revision(workspace),
                              saved["note_id"], saved["revision"], "Edit survives missing bytes")["note"]
        assert edited["quote"] == saved["quote"] and edited["version_id"] == saved["version_id"]
    finally:
        path.write_bytes(raw)
    assert read(workspace, item)["page_text_sha256"] == saved["page_text_sha256"]


def test_wrong_pair_or_vault_never_returns_text(workspace: Workspace) -> None:
    first, second = workspace.files[:2]
    before = sql_snapshot(workspace.conn)
    for vid, version in [(workspace.vault_id, second["version_id"]),
                         (str(uuid.uuid4()), first["version_id"])]:
        with pytest.raises(lib.LibraryError):
            reader.read_text(workspace.conn, vid, workspace.project_id, first["file_id"], version, 1)
        assert sql_snapshot(workspace.conn) == before


def test_pre_cancelled_text_read_and_passage_save_refuse_without_writes(workspace: Workspace) -> None:
    item = workspace.files[0]
    cancelled = threading.Event()
    cancelled.set()
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as read_error:
        read(workspace, item, cancel=cancelled)
    assert read_error.value.reason == "cancelled"
    with pytest.raises(lib.LibraryError) as save_error:
        ev.create_note(workspace.conn, workspace.vault_id, workspace.project_id, revision(workspace),
                        item["file_id"], item["version_id"], "passage", "", anchor_for(workspace, item), cancel=cancelled)
    assert save_error.value.reason == "cancelled"
    assert sql_snapshot(workspace.conn) == before


def test_real_pdf_pages_have_separate_physical_identity_and_verified_raw_bytes(workspace: Workspace) -> None:
    from test_evidence_pdf import ALPHA, BETA, two_pages
    raw = two_pages()
    item = put_file(workspace, "authored-two-pages.pdf", raw)
    before, before_files = sql_snapshot(workspace.conn), files_snapshot(workspace)
    metadata, returned = reader.pdf_bytes(workspace.conn, workspace.vault_id, workspace.project_id,
                                           item["file_id"], item["version_id"])
    assert returned == raw and metadata["sha256"] == sha(raw)
    for page, expected in ((1, ALPHA), (2, BETA)):
        result = read(workspace, item, page)
        assert result["status"] == "extracted" and result["text"] == expected
        assert (result["page_number"], result["page_count"], result["examined_pages"]) == (page, 2, [page])
        assert result["extraction_contract"] == "pypdf-6.18.1/plain-lf/v1"
        assert result["page_text_sha256"] == sha(expected.encode("utf-8"))
    assert sql_snapshot(workspace.conn) == before and files_snapshot(workspace) == before_files


def test_pdf_representation_rejects_text_file_without_leaking_bytes(workspace: Workspace) -> None:
    item = workspace.files[0]
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        reader.pdf_bytes(workspace.conn, workspace.vault_id, workspace.project_id, item["file_id"], item["version_id"])
    assert caught.value.status == 415
    assert sql_snapshot(workspace.conn) == before
