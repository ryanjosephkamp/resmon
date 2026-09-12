"""Actual selected ZIPs and SQL snapshots.

Reduced limits and injected disk/cancellation/tamper arms are labelled. Downloads,
native Save/Cancel, Markdown viewers and browser transport are separate checks.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import io
import json
from pathlib import Path
import re
import stat
import threading
import uuid
import zipfile

import pytest

from implementation_scripts import database as db, evidence as ev, evidence_export as export, library as lib
from test_evidence import (
    Workspace, anchor_for, files_snapshot, put_file, revision, save_note,
    sha, sql_snapshot, workspace,
)


@dataclass
class Spools:
    root: Path
    created: list[Path]
    sentinel: Path


@pytest.fixture
def spools(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Spools:
    root = tmp_path / "bundle-spools"
    root.mkdir()
    sentinel = root / "unrelated-owned-sentinel.txt"
    sentinel.write_bytes(b"Do not remove a neighboring operation's bytes")
    created: list[Path] = []
    original = export.tempfile.TemporaryDirectory

    def owned_directory(*args: object, **kwargs: object):
        assert "dir" not in kwargs
        directory = original(*args, dir=root, **kwargs)
        created.append(Path(directory.name))
        return directory

    monkeypatch.setattr(export.tempfile, "TemporaryDirectory", owned_directory)
    return Spools(root, created, sentinel)


def assert_clean(spools: Spools) -> None:
    assert all(not directory.exists() for directory in spools.created)
    assert spools.sentinel.read_bytes() == b"Do not remove a neighboring operation's bytes"
    assert list(spools.root.iterdir()) == [spools.sentinel]


def selected(items: list[dict]) -> list[dict]:
    return [{"file_id": item["file_id"], "version_id": item["version_id"]} for item in items]


def build(workspace: Workspace, items: list[dict], include_files: bool, **kwargs: object) -> export.Bundle:
    return export.build(workspace.conn, workspace.vault_id, workspace.project_id,
                        revision(workspace), selected(items), include_files, **kwargs)


def consume(bundle: export.Bundle) -> tuple[bytes, dict, str]:
    path = bundle.path
    assert path.is_file() and path.stat().st_size == bundle.size and not bundle.closed
    raw = b"".join(bundle.chunks())
    assert bundle.closed and not path.exists()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert archive.testzip() is None
        manifest = json.loads(archive.read("manifest.json"))
        markdown = archive.read("notes.md").decode("utf-8")
    assert manifest == bundle.manifest
    return raw, manifest, markdown


def six_notes(workspace: Workspace) -> list[dict]:
    first, second, third, fourth = workspace.files[:4]
    return [save_note(workspace, first, "Selected first body ``` fence `````` more"),
            save_note(workspace, first, "Selected passage body", anchor=anchor_for(workspace, first)),
            save_note(workspace, second, "Selected second body"),
            save_note(workspace, second, "Second extra body"),
            save_note(workspace, third, "UNSELECTED_NOTE_SENTINEL"),
            save_note(workspace, fourth, "OTHER_UNSELECTED_NOTE_SENTINEL")]


@pytest.mark.parametrize("include_files", [False, True])
def test_four_members_six_notes_export_exactly_two_selected_identities_and_hashes(
    workspace: Workspace, spools: Spools, include_files: bool,
) -> None:
    notes = six_notes(workspace)
    workspace.conn.execute("INSERT INTO app_settings(key,value) VALUES ('synthetic_private_setting','PRIVATE_SETTING_SENTINEL')")
    workspace.conn.commit()
    before = sql_snapshot(workspace.conn)
    before_files = files_snapshot(workspace)
    current = revision(workspace)
    items = workspace.files[:2]
    raw, manifest, markdown = consume(build(workspace, items, include_files))
    assert manifest["format"] == "evidence-bundle" and manifest["version"] == 1
    assert str(uuid.UUID(manifest["bundle_id"])) == manifest["bundle_id"]
    assert manifest["vault_id"] == workspace.vault_id
    assert manifest["project"] == {"project_id": workspace.project_id, "name": "Evidence fixture", "revision": current}
    assert manifest["mode"] == ("include_retained_files" if include_files else "metadata_only")
    assert len(manifest["files"]) == 2
    assert selected(manifest["files"]) == selected(items)
    assert {note["note_id"] for file in manifest["files"] for note in file["notes"]} == {note["note_id"] for note in notes[:4]}
    assert all(note["project_id"] == workspace.project_id for file in manifest["files"] for note in file["notes"])
    expected_paths = {"manifest.json", "notes.md"}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for file in manifest["files"]:
            assert file["sha256"] == sha(workspace.raw[file["file_id"]])
            assert file["byte_size"] == len(workspace.raw[file["file_id"]])
            if include_files:
                extension = "txt" if file["media_type"] == "text/plain" else "md"
                expected = f"files/{file['file_id']}/{file['version_id']}.{extension}"
                assert file["content_path"] == expected
                expected_paths.add(expected)
                assert archive.read(expected) == workspace.raw[file["file_id"]]
            else:
                assert "content_path" not in file
            assert not ({"root_path", "relative_path", "source_path", "path", "id", "paper_links"} & set(file))
            for note in file["notes"]:
                expected_note = next(n for n in notes if n["note_id"] == note["note_id"])
                assert note == {key: expected_note[key] for key in note}
                assert not ({"id", "file", "membership_state", "resolution"} & set(note))
        names = archive.namelist()
        assert len(names) == len(set(names)) and set(names) == expected_paths
        assert all(not info.is_dir() and not stat.S_ISLNK(info.external_attr >> 16) for info in archive.infolist())
    text = json.dumps(manifest, ensure_ascii=False) + markdown
    for forbidden in (str(workspace.root), str(workspace.originals), str(workspace.database),
                      "PRIVATE_SETTING_SENTINEL", "UNSELECTED_NOTE_SENTINEL", "OTHER_UNSELECTED_NOTE_SENTINEL"):
        assert forbidden not in text
    if include_files:
        assert "rehashed" in manifest["verification"] and "not re-extracted" in manifest["verification"]
    else:
        assert "Retained bytes were not checked" in manifest["verification"]
    # Literal bodies must be inside fences longer than their own backtick runs.
    body = notes[0]["body"]
    longest = max(len(run) for run in re.findall(r"`+", body))
    fence_match = re.search(r"(`{3,})text\n" + re.escape(body) + r"\n\1", markdown)
    assert fence_match is not None and len(fence_match.group(1)) > longest
    assert sql_snapshot(workspace.conn) == before and files_snapshot(workspace) == before_files
    assert workspace.conn.in_transaction is False
    assert_clean(spools)


def test_empty_duplicate_unknown_and_nonboolean_selection_never_means_all(workspace: Workspace, spools: Spools) -> None:
    item = selected(workspace.files[:1])[0]
    cases = [([], False), ([item, item], False),
             ([item, {"file_id": item["file_id"], "version_id": str(uuid.uuid4())}], True),
             ([{**item, "source_path": "/not-an-input"}], False),
             ([{"file_id": item["file_id"]}], False),
             ([{**item, "version_id": "not-uuid"}], False),
             ((item,), False), ([item], 1), ([item], "true"), ([item], None), (None, False)]
    before = sql_snapshot(workspace.conn)
    for selection, inclusion in cases:
        with pytest.raises(lib.LibraryError) as caught:
            export.build(workspace.conn, workspace.vault_id, workspace.project_id, revision(workspace), selection, inclusion)
        assert caught.value.status in (413, 422)
        assert sql_snapshot(workspace.conn) == before
        assert_clean(spools)


def test_twenty_actual_members_export_but_twenty_one_selection_refuses(workspace: Workspace, spools: Spools) -> None:
    assert (export.MAX_FILES, export.MAX_RETAINED_BYTES, export.MAX_MANIFEST_BYTES, export.MAX_NOTES_BYTES) == (
        20, 256 * 1024 * 1024, 4 * 1024 * 1024, 4 * 1024 * 1024)
    for index in range(16):
        put_file(workspace, f"limit-{index}.txt", f"Authored limit item {index}".encode())
    assert len(workspace.files) == 20
    _, manifest, _ = consume(build(workspace, workspace.files, False))
    assert len(manifest["files"]) == 20
    too_many = selected(workspace.files) + [{"file_id": str(uuid.uuid4()), "version_id": str(uuid.uuid4())}]
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        export.build(workspace.conn, workspace.vault_id, workspace.project_id, revision(workspace), too_many, False)
    assert caught.value.reason == "selection_limit" and caught.value.status == 413
    assert sql_snapshot(workspace.conn) == before
    assert_clean(spools)


def test_removed_notes_are_visible_but_never_implicitly_exported(workspace: Workspace, spools: Spools) -> None:
    notes = six_notes(workspace)
    removed = workspace.files[2]
    ev.remove_file(workspace.conn, workspace.vault_id, workspace.project_id, revision(workspace),
                    removed["file_id"], removed["version_id"])
    assert any(n["note_id"] == notes[4]["note_id"] and n["membership_state"] == "removed"
               for n in ev.list_notes(workspace.conn, workspace.vault_id, workspace.project_id)["notes"])
    before = sql_snapshot(workspace.conn)
    _, manifest, markdown = consume(build(workspace, workspace.files[:2], False))
    assert notes[4]["note_id"] not in json.dumps(manifest) and "UNSELECTED_NOTE_SENTINEL" not in markdown
    with pytest.raises(lib.LibraryError) as caught:
        build(workspace, [removed], False)
    assert caught.value.reason == "not_member"
    assert sql_snapshot(workspace.conn) == before
    assert_clean(spools)


def test_metadata_only_does_not_read_or_claim_to_verify_missing_retained_bytes(
    workspace: Workspace, spools: Spools, monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = workspace.files[0]
    saved = save_note(workspace, item, anchor=anchor_for(workspace, item))
    path, raw = workspace.root / item["relative_path"], workspace.raw[item["file_id"]]
    path.unlink()
    before = sql_snapshot(workspace.conn)

    def forbidden_read(*args: object, **kwargs: object) -> None:
        pytest.fail("Metadata-only bundle attempted retained-byte access")

    try:
        with monkeypatch.context() as scoped:
            scoped.setattr(lib, "retained", forbidden_read)
            _, manifest, _ = consume(build(workspace, [item], False))
        assert manifest["files"][0]["notes"][0]["quote"] == saved["quote"]
        assert "Retained bytes were not checked" in manifest["verification"]
        with pytest.raises((lib.LibraryError, OSError)):
            build(workspace, [item], True)
        assert sql_snapshot(workspace.conn) == before
        assert_clean(spools)
    finally:
        path.write_bytes(raw)


def test_path_shaped_names_are_values_and_zip_paths_are_generated_ids(workspace: Workspace, spools: Spools) -> None:
    item = workspace.files[0]
    dangerous = '../outside\\C:<script>alert(1)</script> 😀.txt'
    original = item["original_name"]
    workspace.conn.execute("UPDATE library_files SET original_name=? WHERE file_id=?", (dangerous, item["file_id"]))
    workspace.conn.commit()
    try:
        raw, manifest, markdown = consume(build(workspace, [item], True))
        assert manifest["files"][0]["original_name"] == dangerous
        assert "<script>" not in markdown and "&lt;script&gt;" in markdown
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            assert set(archive.namelist()) == {"manifest.json", "notes.md", f"files/{item['file_id']}/{item['version_id']}.txt"}
            for name in archive.namelist():
                assert not name.startswith(("/", "\\")) and ".." not in name and "\\" not in name and ":" not in name
        assert_clean(spools)
    finally:
        workspace.conn.execute("UPDATE library_files SET original_name=? WHERE file_id=?", (original, item["file_id"]))
        workspace.conn.commit()


def test_unknown_saved_contract_cannot_inject_active_markdown(workspace: Workspace, spools: Spools) -> None:
    item = workspace.files[0]
    note = save_note(workspace, item, anchor=anchor_for(workspace, item))
    attack = 'library-text-lf/v0\n\n[unexpected](https://bundle.invalid/)\n<script>bad()</script>'
    workspace.conn.execute("UPDATE evidence_notes SET extraction_contract=? WHERE note_id=?", (attack, note["note_id"]))
    workspace.conn.commit()
    before = sql_snapshot(workspace.conn)
    try:
        try:
            bundle = build(workspace, [item], False)
        except lib.LibraryError:
            # Refusing the corrupted/unsupported record is also a safe contract.
            pass
        else:
            _, manifest, markdown = consume(bundle)
            assert manifest["files"][0]["notes"][0]["extraction_contract"] == attack
            assert "[unexpected](https://bundle.invalid/)" not in markdown
            assert "<script>" not in markdown
            assert "&lt;script&gt;" in markdown
        assert sql_snapshot(workspace.conn) == before
        assert_clean(spools)
    finally:
        workspace.conn.execute("UPDATE evidence_notes SET extraction_contract=? WHERE note_id=?",
                                (note["extraction_contract"], note["note_id"]))
        workspace.conn.commit()


def test_actual_read_snapshot_survives_concurrent_note_edit_and_member_removal(
    workspace: Workspace, spools: Spools, monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = six_notes(workspace)
    old_revision = revision(workspace)
    second = workspace.files[1]
    before = sql_snapshot(workspace.conn)
    original = ev.file_record
    changed = False

    def interleave(conn: sqlite3.Connection, expected: str, file_id: str, version_id: str) -> dict:
        nonlocal changed
        result = original(conn, expected, file_id, version_id)
        if conn is workspace.conn and not changed:
            changed = True
            writer = db.get_connection(workspace.database)
            try:
                ev.edit_note(writer, workspace.vault_id, workspace.project_id, old_revision,
                             notes[2]["note_id"], notes[2]["revision"], "Committed during snapshot")
                ev.remove_file(writer, workspace.vault_id, workspace.project_id, old_revision + 1,
                                second["file_id"], second["version_id"])
            finally:
                writer.close()
        return result

    monkeypatch.setattr(ev, "file_record", interleave)
    raw, manifest, _ = consume(export.build(workspace.conn, workspace.vault_id, workspace.project_id,
                                            old_revision, selected(workspace.files[:2]), True))
    assert changed
    assert manifest["project"]["revision"] == old_revision
    exported = {n["note_id"]: n for f in manifest["files"] for n in f["notes"]}
    assert exported[notes[2]["note_id"]]["body"] == notes[2]["body"]
    assert selected(manifest["files"]) == selected(workspace.files[:2])
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert archive.read(manifest["files"][1]["content_path"]) == workspace.raw[second["file_id"]]
    assert revision(workspace) == old_revision + 2
    current = {n["note_id"]: n for n in ev.list_notes(workspace.conn, workspace.vault_id, workspace.project_id)["notes"]}
    assert current[notes[2]["note_id"]]["body"] == "Committed during snapshot"
    assert current[notes[2]["note_id"]]["membership_state"] == "removed"
    after = sql_snapshot(workspace.conn)
    assert {table for table in before if before[table] != after[table]} == {
        "evidence_projects", "evidence_project_files", "evidence_notes"}
    assert_clean(spools)


def test_stale_revision_cannot_return_a_bundle(workspace: Workspace, spools: Spools) -> None:
    stale = revision(workspace)
    ev.rename_project(workspace.conn, workspace.vault_id, workspace.project_id, stale, "Changed project")
    before = sql_snapshot(workspace.conn)
    with pytest.raises(lib.LibraryError) as caught:
        export.build(workspace.conn, workspace.vault_id, workspace.project_id, stale, selected(workspace.files[:1]), False)
    assert caught.value.reason == "stale_revision" and caught.value.status == 409
    assert sql_snapshot(workspace.conn) == before
    assert_clean(spools)


@pytest.mark.parametrize("constant,reason", [("MAX_RETAINED_BYTES", "bundle_limit"),
                                            ("MAX_MANIFEST_BYTES", "manifest_limit"),
                                            ("MAX_NOTES_BYTES", "notes_limit")])
def test_reduced_real_output_limits_refuse_and_remove_owned_spool(
    workspace: Workspace, spools: Spools, monkeypatch: pytest.MonkeyPatch, constant: str, reason: str,
) -> None:
    save_note(workspace, workspace.files[0], "Actual output must cross this reduced test bound")
    before = sql_snapshot(workspace.conn)
    before_files = files_snapshot(workspace)
    monkeypatch.setattr(export, constant, 1)
    with pytest.raises(lib.LibraryError) as caught:
        build(workspace, workspace.files[:1], constant == "MAX_RETAINED_BYTES")
    assert caught.value.reason == reason and caught.value.status == 413
    assert sql_snapshot(workspace.conn) == before and files_snapshot(workspace) == before_files
    assert_clean(spools)


@pytest.mark.parametrize("damage,reason", [("append", "bundle_limit"), ("truncate", "changed_content"), ("same_size", "changed_content")])
def test_actual_stream_rechecks_size_hash_and_byte_bound_after_descriptor_verification(
    workspace: Workspace, spools: Spools, monkeypatch: pytest.MonkeyPatch, damage: str, reason: str,
) -> None:
    item = workspace.files[0]
    path = workspace.root / item["relative_path"]
    raw = path.read_bytes()
    before, before_files = sql_snapshot(workspace.conn), files_snapshot(workspace)
    real_retained = lib.retained
    entered = False
    # Metadata is below the reduced total bound. Only real later bytes cross it.
    monkeypatch.setattr(export, "MAX_RETAINED_BYTES", len(raw) + 1)

    @contextmanager
    def change_after_verified(*args: object, **kwargs: object):
        nonlocal entered
        with real_retained(*args, **kwargs) as value:
            assert value[0]["file_id"] == item["file_id"]
            entered = True
            changed = raw + b"extra actual bytes" if damage == "append" else raw[:-1] if damage == "truncate" else b"x" * len(raw)
            path.write_bytes(changed)  # Authored concurrent tamper in disposable fixture only.
            try:
                yield value  # Same real descriptor; exporter reads actual filesystem bytes.
            finally:
                path.write_bytes(raw)

    monkeypatch.setattr(lib, "retained", change_after_verified)
    with pytest.raises(lib.LibraryError) as caught:
        build(workspace, [item], True)
    assert entered and caught.value.reason == reason
    assert sql_snapshot(workspace.conn) == before and files_snapshot(workspace) == before_files
    assert_clean(spools)
    monkeypatch.setattr(lib, "retained", real_retained)
    _, restored, _ = consume(build(workspace, [item], True))
    assert restored["files"][0]["sha256"] == item["sha256"]
    assert_clean(spools)


def test_real_saved_pair_corruption_refuses_without_partial_zip(workspace: Workspace, spools: Spools) -> None:
    item, other = workspace.files[:2]
    note = save_note(workspace, item, "Saved exact identity")
    before = sql_snapshot(workspace.conn)
    workspace.conn.execute("UPDATE evidence_notes SET version_id=? WHERE note_id=?", (other["version_id"], note["note_id"]))
    workspace.conn.commit()
    damaged = sql_snapshot(workspace.conn)
    assert workspace.conn.execute("PRAGMA foreign_key_check").fetchall() == []
    try:
        with pytest.raises(lib.LibraryError):
            build(workspace, [item], True)
        assert sql_snapshot(workspace.conn) == damaged
        assert_clean(spools)
    finally:
        workspace.conn.execute("UPDATE evidence_notes SET version_id=? WHERE note_id=?", (item["version_id"], note["note_id"]))
        workspace.conn.commit()
    assert sql_snapshot(workspace.conn) == before


def test_cancel_before_and_during_file_copy_cleans_only_owned_spools(
    workspace: Workspace, spools: Spools, monkeypatch: pytest.MonkeyPatch,
) -> None:
    item = workspace.files[0]
    cancel = threading.Event()
    cancel.set()
    before, before_files = sql_snapshot(workspace.conn), files_snapshot(workspace)
    with pytest.raises(lib.LibraryError) as caught:
        build(workspace, [item], True, cancel=cancel)
    assert caught.value.reason == "cancelled"
    assert_clean(spools)
    cancel.clear()
    real_retained = lib.retained

    @contextmanager
    def cancel_after_verified(*args: object, **kwargs: object):
        with real_retained(*args, **kwargs) as value:
            cancel.set()
            yield value

    monkeypatch.setattr(lib, "retained", cancel_after_verified)
    with pytest.raises(lib.LibraryError) as caught:
        build(workspace, [item], True, cancel=cancel)
    assert caught.value.reason == "cancelled"
    assert sql_snapshot(workspace.conn) == before and files_snapshot(workspace) == before_files
    assert_clean(spools)


def test_injected_archive_disk_error_rolls_back_snapshot_and_cleans_owned_bytes(
    workspace: Workspace, spools: Spools, monkeypatch: pytest.MonkeyPatch,
) -> None:
    before, before_files = sql_snapshot(workspace.conn), files_snapshot(workspace)

    def enospc(*args: object, **kwargs: object) -> None:
        raise OSError(28, "Authored ENOSPC at actual ZIP write seam")

    monkeypatch.setattr(zipfile.ZipFile, "writestr", enospc)
    with pytest.raises(OSError) as caught:
        build(workspace, workspace.files[:1], True)
    assert caught.value.errno == 28
    assert sql_snapshot(workspace.conn) == before and files_snapshot(workspace) == before_files
    assert workspace.conn.in_transaction is False
    assert_clean(spools)


def test_partial_download_generator_close_and_explicit_close_clean_spool(workspace: Workspace, spools: Spools) -> None:
    first = build(workspace, workspace.files[:1], True)
    iterator = first.chunks()
    assert next(iterator).startswith(b"PK")
    assert first.path.exists()
    iterator.close()
    assert first.closed and not first.path.exists()
    first.close()  # Idempotent cleanup.
    assert_clean(spools)
    second = build(workspace, workspace.files[:1], False)
    second.close()  # An unconsumed response also has an explicit owned cleanup.
    assert second.closed and not second.path.exists()
    assert_clean(spools)
