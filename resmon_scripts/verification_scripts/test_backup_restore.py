"""The restore drill: backup → erase → restore must be the identity.

A backup nobody has ever restored is a belief, not a capability. This module is
the drill that turns it into one: a real corpus with a real vault is backed up,
the corpus is erased and the vault directory deleted, and the bundle is put back
through the *startup* path the app actually uses -- not a helper called in
isolation. What comes out is compared row for row, sequence mark for sequence
mark, and FTS answer for FTS answer, against what went in, using the same
snapshot helpers that prove the cumulative migration.

The comparison is exact except where the restore deliberately rewrites: a
``running`` execution becomes ``interrupted`` with reason ``unknown`` and the
owner columns are cleared, because after a restore -- and certainly on another
machine -- the process those columns name is gone.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import backup as backup_module  # noqa: E402
from implementation_scripts import database as db  # noqa: E402
from implementation_scripts import library as lib  # noqa: E402
from implementation_scripts.database import insert_document, insert_execution  # noqa: E402

from verification_scripts.test_cumulative_upgrade import (  # noqa: E402
    _app_tables,
    _snapshot,
)

CONFIRM = {"confirm": "CONFIRM"}


# ---------------------------------------------------------------------------
# A corpus worth backing up
# ---------------------------------------------------------------------------


def _seed_documents(conn, n=4):
    ids = []
    for i in range(n):
        ids.append(insert_document(conn, {
            "source_repository": "arxiv", "external_id": f"x{i}", "doi": None,
            "title": f"Superconducting paper {i}", "authors": "A. Author",
            "abstract": "An abstract about superconductivity.",
            "publication_date": "2026-01-01", "url": "u", "categories": "c",
            "metadata_hash": f"h{i}",
        }))
    return ids


def _seed_vault(conn, parent: Path, document_ids):
    """A real vault with three retained files, linked to real documents."""
    status = lib.create_vault(conn, str(parent))
    vault_id = status["vault"]["vault_id"]
    root = parent / status["vault"]["label"]
    payloads = [
        ("one.txt", b"the first retained text"),
        ("two.md", b"# the second retained file\n"),
        ("three.pdf", b"%PDF-1.4\nthe third retained file"),
    ]
    files = []
    for (name, content), document_id in zip(payloads, document_ids):
        with lib.Import(conn, vault_id, name, document_id) as upload:
            upload.write(content)
            files.append(upload.finish()["file"])
    return vault_id, root, files


def _seed_process_state(conn):
    """One running execution and one in-flight delivery -- the rows a restore rewrites."""
    exec_id = insert_execution(conn, {
        "execution_type": "deep_sweep",
        "parameters": "{}",
        "start_time": "2026-01-01T00:00:00Z",
        "status": "running",
        "owner_pid": 4242,
        "owner_runtime_id": "runtime-from-another-life",
    })
    conn.commit()
    return int(exec_id)


@pytest.fixture
def corpus(tmp_path):
    """A file-backed database, a real vault, rows in both."""
    db_path = tmp_path / "state" / "resmon.db"
    db_path.parent.mkdir(parents=True)
    conn = db.get_connection(db_path)
    db.init_db(conn=conn)
    ids = _seed_documents(conn)
    parent = tmp_path / "vault-parent"
    parent.mkdir()
    vault_id, root, files = _seed_vault(conn, parent, ids)
    exec_id = _seed_process_state(conn)
    conn.commit()
    yield {
        "conn": conn, "db_path": db_path, "vault_id": vault_id, "vault_root": root,
        "files": files, "document_ids": ids, "exec_id": exec_id,
        "state_dir": db_path.parent, "tmp": tmp_path,
    }
    conn.close()


def _make_backup(corpus, tmp_path, include_reports=False, reports_dir=None):
    return backup_module.create_backup(
        corpus["conn"],
        tmp_path / "backups",
        app_version="2.2.0",
        schema_version=db.SCHEMA_VERSION,
        include_reports=include_reports,
        reports_dir=reports_dir,
        state_dir=corpus["state_dir"],
    )


def _fts_answer(conn):
    return [r[0] for r in conn.execute(
        "SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'superconductivity' "
        "ORDER BY rowid")]


# ---------------------------------------------------------------------------
# D1 / P1 -- the bundle
# ---------------------------------------------------------------------------


def test_a_bundle_carries_the_database_the_vault_and_a_manifest(corpus, tmp_path):
    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    assert (bundle / "resmon.db").is_file()
    assert (bundle / "vault" / "vault.json").is_file()
    # No sidecars: the SQLite backup API produces one self-contained file.
    assert not (bundle / "resmon.db-wal").exists()
    assert not (bundle / "resmon.db-shm").exists()

    for item in corpus["files"]:
        copied = bundle / "vault" / item["relative_path"]
        assert copied.is_file()
        assert hashlib.sha256(copied.read_bytes()).hexdigest() == item["sha256"]

    assert manifest["vault_id"] == corpus["vault_id"]
    tables = _app_tables(corpus["conn"])
    counted = [t for t in tables if t in manifest["table_counts"]]
    print(f"D1: {len(counted)} of {len(tables)} app tables counted in the manifest")
    assert len(counted) == len(tables)
    assert manifest["table_counts"]["documents"] == len(corpus["document_ids"])
    assert manifest["table_counts"]["library_files"] == 3


def test_the_bundles_database_is_a_consistent_snapshot(corpus, tmp_path):
    """P1: the snapshot is taken through the live connection and passes integrity_check.

    The live connection keeps writing after the backup starts; what the bundle
    holds is what the backup API saw when it began, not a half-written file.
    """
    before = corpus["conn"].execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    manifest = _make_backup(corpus, tmp_path)
    _seed_documents(corpus["conn"], 2)  # writes after the snapshot
    corpus["conn"].commit()

    copy = sqlite3.connect(str(Path(manifest["path"]) / "resmon.db"))
    try:
        assert copy.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert copy.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == before
    finally:
        copy.close()


def test_a_vault_whose_bytes_no_longer_match_aborts_the_backup(corpus, tmp_path):
    """P7: a corrupt vault is not something to back up quietly."""
    victim = corpus["vault_root"] / corpus["files"][0]["relative_path"]
    victim.write_bytes(b"tampered bytes of the same length!!")
    with pytest.raises(backup_module.BackupError) as caught:
        _make_backup(corpus, tmp_path)
    assert caught.value.reason == "vault_hash_mismatch"
    assert corpus["files"][0]["relative_path"] in caught.value.message
    # The partial directory is gone: half a bundle that looks like one is worse.
    assert not list((tmp_path / "backups").glob("resmon-backup-*"))


def test_no_credential_value_reaches_the_bundle(corpus, tmp_path):
    """P6: names only, never values."""
    from implementation_scripts import credential_manager as cm

    cm.store_credential("smtp_password", "hunter2-the-secret-value")
    try:
        manifest = _make_backup(corpus, tmp_path)
    finally:
        cm.delete_credential("smtp_password")
    assert "smtp_password" in manifest["excluded"]["credentials"]
    bundle = Path(manifest["path"])
    for path in bundle.rglob("*"):
        if path.is_file():
            assert b"hunter2-the-secret-value" not in path.read_bytes(), path
    assert json.dumps(manifest).count("hunter2") == 0


# ---------------------------------------------------------------------------
# D2 / P5 -- verify and refuse
# ---------------------------------------------------------------------------


def test_verify_recomputes_every_hash_and_reports_what_is_not_restored(corpus, tmp_path):
    manifest = _make_backup(corpus, tmp_path)
    report = backup_module.verify_bundle(
        Path(manifest["path"]),
        this_schema_version=db.SCHEMA_VERSION,
        configured_vault_id=corpus["vault_id"],
    )
    assert report["ok"], report["problems"]
    assert report["files_checked"] == report["files_in_manifest"] == len(manifest["files"])
    assert report["schema_relation"] == "same"
    assert report["vault_relation"] == "same"
    assert "daemon.lock" in report["will_not_restore"]["process_state"]


def test_a_tampered_file_is_refused_at_verify(corpus, tmp_path):
    manifest = _make_backup(corpus, tmp_path)
    victim = Path(manifest["path"]) / "vault" / corpus["files"][0]["relative_path"]
    victim.write_bytes(victim.read_bytes() + b"appended")
    report = backup_module.verify_bundle(
        Path(manifest["path"]), this_schema_version=db.SCHEMA_VERSION)
    assert not report["ok"]
    assert any("size" in p or "hash" in p for p in report["problems"])


def test_a_newer_schema_is_refused_with_the_sentence(corpus, tmp_path):
    manifest = _make_backup(corpus, tmp_path)
    path = Path(manifest["path"]) / "manifest.json"
    raw = json.loads(path.read_text())
    raw["schema_version"] = db.SCHEMA_VERSION + 5
    path.write_text(json.dumps(raw, indent=2, sort_keys=True))
    report = backup_module.verify_bundle(
        Path(manifest["path"]), this_schema_version=db.SCHEMA_VERSION)
    assert not report["ok"]
    assert report["schema_relation"] == "newer"
    assert any("newer resmon" in p for p in report["problems"])


def test_a_vault_that_belongs_to_someone_else_is_refused(corpus, tmp_path):
    """P5: a different existing vault stops the restore before anything moves."""
    manifest = _make_backup(corpus, tmp_path)
    other = tmp_path / "vault-parent" / ("resmon-library-" + corpus["vault_id"])
    shutil.rmtree(other)
    other.mkdir()
    (other / "vault.json").write_text(json.dumps(
        {"version": 1, "vault_id": "11111111-1111-1111-1111-111111111111"}))
    with pytest.raises(backup_module.BackupError) as caught:
        backup_module._restore_vault(Path(manifest["path"]), manifest, other)
    assert caught.value.reason == "different_vault"
    assert (other / "vault.json").is_file()  # untouched


# ---------------------------------------------------------------------------
# D6 / P2 / P3 -- the drill
# ---------------------------------------------------------------------------


#: What the restore is expected to rewrite, said out loud so the comparison can
#: be exact everywhere else.
_INTENDED_REWRITES = {
    "executions": ("status", "interrupted_reason", "owner_pid", "owner_runtime_id", "end_time"),
    "deliveries": ("state", "owner_pid", "owner_runtime_id"),
}


def _comparable(snapshot: dict) -> dict:
    rows = {}
    for table, entries in snapshot["rows"].items():
        skip = _INTENDED_REWRITES.get(table, ())
        rows[table] = [{k: v for k, v in row.items() if k not in skip} for row in entries]
    return {"tables": snapshot["tables"], "rows": rows, "sequences": snapshot["sequences"]}


def _apply_restore_through_startup(corpus, monkeypatch, bundle: Path):
    """Drive the real ``_lifespan`` restore step, not the helper underneath it."""
    import resmon as resmon_mod

    monkeypatch.setattr(resmon_mod, "_db_path", str(corpus["db_path"]), raising=False)
    monkeypatch.setattr(resmon_mod, "_backup_state_dir",
                        lambda: corpus["state_dir"], raising=False)
    return resmon_mod._apply_pending_restore_on_startup()


def test_the_restore_drill_is_the_identity(corpus, monkeypatch, tmp_path):
    """D6/P3: every table, every sequence mark, every vault byte, the FTS answer."""
    conn = corpus["conn"]
    before = _snapshot(conn)
    before_fts = _fts_answer(conn)
    tables = _app_tables(conn)
    assert tables, "no app tables to compare"

    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])

    # Erase: the corpus goes, the vault directory goes.
    conn.execute("DELETE FROM library_file_documents")
    conn.execute("DELETE FROM library_files")
    conn.execute("DELETE FROM library_vault")
    conn.execute("DELETE FROM documents")
    conn.execute("DELETE FROM executions")
    conn.execute("DELETE FROM sqlite_sequence")
    conn.commit()
    conn.close()
    shutil.rmtree(corpus["vault_root"])
    assert not corpus["vault_root"].exists()

    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    assert report["ok"], report["problems"]
    backup_module.stage_restore(bundle, corpus["state_dir"], report)

    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)
    assert outcome is not None and outcome["ok"], outcome
    assert backup_module.pending_restore(corpus["state_dir"]) is None
    assert outcome["undo_copy"] and Path(outcome["undo_copy"]).is_dir()

    after_conn = db.get_connection(corpus["db_path"])
    try:
        after = _snapshot(after_conn)
        assert after["tables"] == before["tables"]
        compared = 0
        for table in tables:
            assert _comparable(after)["rows"][table] == _comparable(before)["rows"][table], table
            compared += 1
        print(f"D6: {compared} of {len(tables)} app tables identical after restore "
              f"(intended rewrites excluded on {len(_INTENDED_REWRITES)} of them)")
        assert compared == len(tables)

        # The invisible state: AUTOINCREMENT high-water marks survive.
        assert after["sequences"] == before["sequences"]

        # The FTS answer, which is derived and needs an explicit rebuild.
        assert _fts_answer(after_conn) == before_fts and before_fts

        # The intended rewrites, named rather than merely excluded.
        row = after_conn.execute(
            "SELECT status, interrupted_reason, owner_pid, owner_runtime_id "
            "FROM executions WHERE id=?", (corpus["exec_id"],)).fetchone()
        assert row["status"] == "interrupted"
        assert row["interrupted_reason"] == "unknown"
        assert row["owner_pid"] is None and row["owner_runtime_id"] is None

        assert after_conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert after_conn.execute("PRAGMA foreign_key_check").fetchall() == []

        # P2: the vault is back, byte for byte, and library.py agrees.
        status = lib.status(after_conn)
        assert status["status"] == "ready", status
        assert status["vault"]["vault_id"] == corpus["vault_id"]
        with lib.checked_vault(after_conn, corpus["vault_id"]) as (_, root):
            lib._catalog_tree(after_conn, root)
        for item in corpus["files"]:
            restored = corpus["vault_root"] / item["relative_path"]
            assert hashlib.sha256(restored.read_bytes()).hexdigest() == item["sha256"]

        # The lock is gone, so the vault still accepts an import afterwards.
        with lib.Import(after_conn, corpus["vault_id"], "after.txt", None) as upload:
            upload.write(b"an import after the restore")
            assert upload.finish()["file"]["file_id"]
    finally:
        after_conn.close()


def test_a_staged_restore_whose_bundle_vanished_clears_itself(corpus, monkeypatch, tmp_path):
    """P5: the app starts normally and records why it restored nothing."""
    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    backup_module.stage_restore(bundle, corpus["state_dir"], report)
    shutil.rmtree(bundle)

    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)
    assert outcome is not None and not outcome["ok"]
    assert outcome["reason"] == "bundle_missing"
    assert backup_module.pending_restore(corpus["state_dir"]) is None
    assert corpus["db_path"].is_file()
    assert backup_module.undo_copies(corpus["state_dir"]) == []


def test_a_tampered_bundle_is_refused_at_startup_and_nothing_moves(corpus, monkeypatch, tmp_path):
    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    backup_module.stage_restore(bundle, corpus["state_dir"], report)
    victim = bundle / "resmon.db"
    victim.write_bytes(victim.read_bytes() + b"\x00")
    before = corpus["db_path"].read_bytes()

    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)
    assert outcome is not None and not outcome["ok"]
    assert outcome["reason"] == "verification_failed"
    assert corpus["db_path"].read_bytes() == before
    assert backup_module.undo_copies(corpus["state_dir"]) == []


def test_the_undo_copy_can_be_deleted_and_the_restore_record_read(corpus, monkeypatch, tmp_path):
    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    backup_module.stage_restore(bundle, corpus["state_dir"], report)
    corpus["conn"].close()
    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)
    assert outcome["ok"], outcome
    assert len(backup_module.undo_copies(corpus["state_dir"])) == 1
    record = backup_module.last_restore(corpus["state_dir"])
    assert record["ok"] and record["acknowledged"] is False
    assert backup_module.delete_undo_copies(corpus["state_dir"]) == 1
    assert backup_module.undo_copies(corpus["state_dir"]) == []


def test_the_restore_step_is_wired_into_the_lifespan(corpus, monkeypatch, tmp_path):
    """The hook is only worth testing if startup actually calls it.

    The drill above drives ``_apply_pending_restore_on_startup`` directly. This
    case drives FastAPI's real lifespan and asserts the step ran inside it, so
    a future edit that removes the call from ``_lifespan`` fails here rather
    than silently turning every staged restore into a no-op.
    """
    import asyncio

    import resmon as resmon_mod

    called = []
    monkeypatch.setattr(resmon_mod, "_apply_pending_restore_on_startup",
                        lambda: called.append("restore"))
    for name in ("_init_admission_on_startup", "_migrate_legacy_ai_key_on_startup",
                 "_reconcile_executions_on_startup", "_init_scheduler_on_startup",
                 "_init_delivery_on_startup", "_selected_startup",
                 "_selected_shutdown", "_shutdown_delivery", "_shutdown_scheduler"):
        monkeypatch.setattr(resmon_mod, name,
                            lambda *a, **k: called.append("other"), raising=False)

    async def drive():
        async with resmon_mod._lifespan(resmon_mod.app):
            pass

    asyncio.run(drive())
    assert called and called[0] == "restore", called


# ---------------------------------------------------------------------------
# D5 -- the routes, over the real HTTP seam
# ---------------------------------------------------------------------------


def _route_client(tmp_path, monkeypatch):
    import resmon as resmon_mod
    from fastapi.testclient import TestClient

    db_path = tmp_path / "routes" / "resmon.db"
    db_path.parent.mkdir(parents=True)
    monkeypatch.setattr(resmon_mod, "_db_path", str(db_path), raising=False)
    monkeypatch.setattr(resmon_mod, "_shared_conn", None, raising=False)
    monkeypatch.setattr(resmon_mod, "_db_initialized", False, raising=False)
    monkeypatch.setattr(resmon_mod, "_backup_state_dir", lambda: db_path.parent, raising=False)
    client = TestClient(resmon_mod.app)
    conn = resmon_mod._get_db()
    resmon_mod.set_setting(conn, "export_directory", str(tmp_path / "exports"))
    conn.commit()
    return client, resmon_mod, db_path


def test_the_routes_refuse_without_confirm_and_produce_a_bundle(tmp_path, monkeypatch):
    client, mod, db_path = _route_client(tmp_path, monkeypatch)
    try:
        _seed_documents(mod._get_db(), 2)
        mod._get_db().commit()

        assert client.post("/api/backup", json={"confirm": "no"}).status_code == 400

        response = client.post("/api/backup", json={"confirm": "CONFIRM",
                                                    "include_reports": False})
        assert response.status_code == 200, response.text
        bundle = response.json()["path"]
        assert Path(bundle).is_dir()

        verified = client.post("/api/backup/verify", json={"path": bundle})
        assert verified.status_code == 200, verified.text
        assert verified.json()["ok"] is True
        # Names only: no credential value can reach a route answer either.
        assert all(isinstance(n, str) for n in
                   verified.json()["will_not_restore"]["credentials"])

        staged = client.post("/api/restore", json={"confirm": "CONFIRM", "path": bundle})
        assert staged.status_code == 200, staged.text
        assert "Restart resmon" in staged.json()["next_step"]

        last = client.get("/api/backup/last").json()
        assert last["last_backup"]["path"] == bundle
        assert last["pending_restore"]["bundle"] == str(Path(bundle).resolve())

        assert client.post("/api/restore/cancel").json()["success"] is True
        assert client.get("/api/backup/last").json()["pending_restore"] is None
    finally:
        mod.close_db()


def test_a_backup_of_a_corrupt_vault_fails_loudly_over_http(tmp_path, monkeypatch):
    """P7 at the route: the reason reaches the caller rather than a log line."""
    client, mod, db_path = _route_client(tmp_path, monkeypatch)
    try:
        conn = mod._get_db()
        ids = _seed_documents(conn, 3)
        parent = tmp_path / "routes-vault"
        parent.mkdir()
        _, root, files = _seed_vault(conn, parent, ids)
        conn.commit()
        (root / files[0]["relative_path"]).write_bytes(b"not what the catalog recorded")

        response = client.post("/api/backup", json={"confirm": "CONFIRM",
                                                    "include_reports": False})
        assert response.status_code == 400
        detail = response.json()["detail"]
        assert detail["reason"] == "vault_hash_mismatch"
        assert files[0]["relative_path"] in detail["message"]
    finally:
        mod.close_db()


def test_a_bundle_restores_into_a_fresh_state_directory_and_serves_over_http(
        corpus, tmp_path, monkeypatch):
    """The second-machine shape: a state directory that has never held a corpus.

    This is not two machines and does not claim to be -- it is one process, and
    the vault comes back at the path the *backup's* database records rather
    than at a parent this side chose, which is the limitation to widen next.
    What it does establish is that a bundle restored into a state directory
    with no database of its own produces a backend that serves the executions
    and the library items over the real HTTP seam, and that the report names
    the credentials the restore could not bring back.
    """
    import resmon as resmon_mod
    from fastapi.testclient import TestClient

    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    library_before = len(corpus["files"])
    corpus["conn"].close()

    fresh_state = tmp_path / "machine-b"
    fresh_state.mkdir()
    fresh_db = fresh_state / "resmon.db"
    # Machine A's vault is out of the way: the restore must put the bytes back.
    shutil.rmtree(corpus["vault_root"])

    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    assert report["ok"], report["problems"]
    backup_module.stage_restore(bundle, fresh_state, report)

    monkeypatch.setattr(resmon_mod, "_db_path", str(fresh_db), raising=False)
    monkeypatch.setattr(resmon_mod, "_shared_conn", None, raising=False)
    monkeypatch.setattr(resmon_mod, "_db_initialized", False, raising=False)
    monkeypatch.setattr(resmon_mod, "_backup_state_dir", lambda: fresh_state, raising=False)

    outcome = resmon_mod._apply_pending_restore_on_startup()
    assert outcome is not None and outcome["ok"], outcome
    assert outcome["vault"]["restored"] is True

    client = TestClient(resmon_mod.app)
    try:
        executions = client.get("/api/executions")
        assert executions.status_code == 200, executions.text
        # The Library routes sit behind the renderer-origin guard, which a
        # TestClient cannot satisfy without impersonating the renderer; the
        # library half is read through the same connection the backend serves
        # from instead, and the HTTP boundary for Library is covered by
        # ``test_library_boundary.py``.
        listed = lib.list_files(resmon_mod._get_db(), corpus["vault_id"])
        assert len(listed["files"]) == library_before
        assert lib.status(resmon_mod._get_db())["status"] == "ready"

        card = client.get("/api/backup/last").json()
        assert card["last_restore"]["ok"] is True
        assert isinstance(card["last_restore"]["credentials_to_reenter"], list)
    finally:
        resmon_mod.close_db()
