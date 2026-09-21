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


def _seed_deliveries(conn, exec_id):
    """One ``delivering`` delivery, which a restore requeues, and one ``awaiting_review``, which it must not.

    The review round found the deliveries half of ``_strip_process_state``
    unguarded: replacing it with ``pass`` passed 58 tests, because no fixture
    anywhere had a ``delivering`` row. Both states are seeded here, and both
    are asserted, so that arm has a witness.
    """
    now = "2026-01-01T00:00:00Z"
    conn.execute(
        "INSERT INTO routines (name, schedule_cron, parameters, is_active, created_at) "
        "VALUES ('nightly', '0 3 * * *', '{}', 0, ?)", (now,))
    routine_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
    targets = {}
    for channel in ("webhook", "email"):
        conn.execute(
            "INSERT INTO routine_delivery_targets "
            "(routine_id, channel, target, enabled, mode, created_at_utc, updated_at_utc) "
            "VALUES (?, ?, ?, 1, 'automatic', ?, ?)",
            (routine_id, channel, f"{channel}://example.invalid", now, now))
        targets[channel] = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
    states = {}
    for channel, state in (("webhook", "delivering"), ("email", "awaiting_review")):
        conn.execute(
            "INSERT INTO deliveries (execution_id, target_id, channel, target_snapshot, "
            "state, attempts, owner_pid, owner_runtime_id, queued_at_utc) "
            "VALUES (?, ?, ?, '{}', ?, 1, 4242, 'runtime-from-another-life', ?)",
            (exec_id, targets[channel], channel, state, now))
        states[state] = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
    conn.commit()
    return {"routine_id": routine_id, "targets": targets, "deliveries": states}


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
    deliveries = _seed_deliveries(conn, exec_id)
    conn.commit()
    yield {
        "conn": conn, "db_path": db_path, "vault_id": vault_id, "vault_root": root,
        "files": files, "document_ids": ids, "exec_id": exec_id,
        "deliveries": deliveries,
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


def test_a_same_size_tamper_is_caught_by_the_hash_and_not_the_size(corpus, tmp_path):
    """The size check would pass this. Only recomputing the hash catches it.

    Written after a mutation that stopped verify recomputing hashes at all and
    no test noticed: the existing tamper case appended bytes, so the size check
    failed first and the hash was never the thing under test.
    """
    manifest = _make_backup(corpus, tmp_path)
    victim = Path(manifest["path"]) / "vault" / corpus["files"][0]["relative_path"]
    original = victim.read_bytes()
    victim.write_bytes(b"X" + original[1:])
    assert victim.stat().st_size == len(original)

    report = backup_module.verify_bundle(
        Path(manifest["path"]), this_schema_version=db.SCHEMA_VERSION)
    assert not report["ok"]
    assert any("hash" in problem for problem in report["problems"]), report["problems"]
    assert report["files_checked"] < report["files_in_manifest"]


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
#: `executions`: a `running` row becomes `interrupted`/`unknown` with its owner
#: cleared. `deliveries`: a `delivering` row becomes `queued` with its owner
#: cleared, and an `awaiting_review` row is left exactly as it was -- it
#: describes a decision the user has not made, not a process.
_INTENDED_REWRITES = {
    "executions": ("status", "interrupted_reason", "owner_pid", "owner_runtime_id", "end_time"),
    "deliveries": ("state", "owner_pid", "owner_runtime_id"),
}


def _comparable(snapshot: dict, extra: dict | None = None) -> dict:
    rows = {}
    for table, entries in snapshot["rows"].items():
        skip = tuple(_INTENDED_REWRITES.get(table, ())) + tuple((extra or {}).get(table, ()))
        rows[table] = [{k: v for k, v in row.items() if k not in skip} for row in entries]
    return {"tables": snapshot["tables"], "rows": rows, "sequences": snapshot["sequences"]}


def _apply_restore_through_startup(corpus, monkeypatch, bundle: Path):
    """Drive the real ``_lifespan`` restore step, not the helper underneath it."""
    import resmon as resmon_mod

    monkeypatch.setattr(resmon_mod, "_db_path", str(corpus["db_path"]), raising=False)
    monkeypatch.setattr(resmon_mod, "_backup_state_dir",
                        lambda: corpus["state_dir"], raising=False)
    return resmon_mod._apply_pending_restore_on_startup()


@pytest.mark.parametrize("relocate", [False, True], ids=["vault_in_place", "vault_parent"])
def test_the_restore_drill_is_the_identity(corpus, monkeypatch, tmp_path, relocate):
    """D6/P3: every table, every sequence mark, every vault byte, the FTS answer.

    Run twice: once with the vault going back where the bundle's database says
    it was, and once with a ``vault_parent`` chosen on the restoring machine.
    The second arm is the whole point of the drill for someone whose old vault
    path does not exist here -- and the only row that may differ between the
    two is ``library_vault.root_path``, which is exactly the row the relocation
    rewrites.
    """
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

    if relocate:
        chosen = tmp_path / "chosen-vault-parent"
        chosen.mkdir()
        vault_root = chosen / backup_module.vault_dir_name(corpus["vault_id"])
        relocated = {"library_vault": ("root_path",)}
    else:
        chosen = None
        vault_root = corpus["vault_root"]
        relocated = {}

    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    assert report["ok"], report["problems"]
    backup_module.stage_restore(bundle, corpus["state_dir"], report,
                                vault_parent=str(chosen) if chosen else None)

    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)
    assert outcome is not None and outcome["ok"], outcome
    assert backup_module.pending_restore(corpus["state_dir"]) is None
    assert outcome["undo_copy"] and Path(outcome["undo_copy"]).is_dir()
    assert outcome["vault"]["root_path"] == str(vault_root)

    after_conn = db.get_connection(corpus["db_path"])
    try:
        after = _snapshot(after_conn)
        assert after["tables"] == before["tables"]
        compared = 0
        for table in tables:
            assert _comparable(after, relocated)["rows"][table] == \
                _comparable(before, relocated)["rows"][table], table
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

        # The deliveries arm, which had no witness until round two.
        requeued = after_conn.execute(
            "SELECT state, owner_pid, owner_runtime_id FROM deliveries WHERE id=?",
            (corpus["deliveries"]["deliveries"]["delivering"],)).fetchone()
        assert requeued["state"] == "queued"
        assert requeued["owner_pid"] is None and requeued["owner_runtime_id"] is None

        held = after_conn.execute(
            "SELECT state, attempts FROM deliveries WHERE id=?",
            (corpus["deliveries"]["deliveries"]["awaiting_review"],)).fetchone()
        assert held["state"] == "awaiting_review", (
            "a delivery the user has not decided on is not a process to reclaim")
        assert held["attempts"] == 1
        assert outcome["rewrites"] == {"executions_interrupted": 1, "deliveries_requeued": 1}

        assert after_conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert after_conn.execute("PRAGMA foreign_key_check").fetchall() == []

        # P2: the vault is back, byte for byte, and library.py agrees.
        status = lib.status(after_conn)
        assert status["status"] == "ready", status
        assert status["vault"]["vault_id"] == corpus["vault_id"]
        assert after_conn.execute(
            "SELECT root_path FROM library_vault WHERE singleton=1"
        ).fetchone()["root_path"] == str(vault_root)
        with lib.checked_vault(after_conn, corpus["vault_id"]) as (_, root):
            lib._catalog_tree(after_conn, root)
        for item in corpus["files"]:
            restored = vault_root / item["relative_path"]
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


# ---------------------------------------------------------------------------
# R2-2 -- a bundle from a released resmon, older than today's schema
# ---------------------------------------------------------------------------

V220_FIXTURE = (Path(__file__).parent / "fixtures/v2.2.0/corpus_schema_18.sql")
V220_SCHEMA_VERSION = 18


def test_a_v220_era_bundle_restores_through_the_startup_path(tmp_path, monkeypatch):
    """The case that found the round-one bug: schema 18 has no ``deliveries`` table.

    ``_strip_process_state`` used to run *before* ``init_db``, against the
    bundle's own schema, and swallow ``sqlite3.Error``. On this fixture that is
    "no such table: deliveries" -- and the restore carried on and reported
    success. It now runs after the migrations and raises, so a failure there
    restores the undo copy like any other.
    """
    import resmon as resmon_mod

    source = tmp_path / "old" / "resmon.db"
    source.parent.mkdir(parents=True)
    old = db.get_connection(source)
    try:
        old.executescript(V220_FIXTURE.read_text(encoding="utf-8"))
        old.commit()
        assert db.get_schema_version(old) == V220_SCHEMA_VERSION
        documents_before = old.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        assert not old.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='deliveries'"
        ).fetchone(), "this fixture is only interesting while it predates deliveries"
        # The fixture records a vault at a path this machine has never had. A
        # backup of a corpus whose vault is missing correctly aborts (P7), and
        # that is not what this case is about -- the schema walk is. The vault
        # rows go, and the vault half is covered by the drill.
        old.execute("DELETE FROM library_file_documents")
        old.execute("DELETE FROM library_files")
        old.execute("DELETE FROM library_vault")
        old.commit()

        manifest = backup_module.create_backup(
            old, tmp_path / "backups", app_version="2.2.0",
            schema_version=V220_SCHEMA_VERSION, include_reports=False,
            reports_dir=None, state_dir=source.parent)
    finally:
        old.close()
    assert manifest["schema_version"] == V220_SCHEMA_VERSION

    state = tmp_path / "today"
    state.mkdir()
    target = state / "resmon.db"
    report = backup_module.verify_bundle(bundle := Path(manifest["path"]),
                                         this_schema_version=db.SCHEMA_VERSION)
    assert report["ok"], report["problems"]
    assert report["schema_relation"] == "older"
    backup_module.stage_restore(bundle, state, report,
                                accept_fk_violations=report["needs_fk_acceptance"])

    monkeypatch.setattr(resmon_mod, "_db_path", str(target), raising=False)
    monkeypatch.setattr(resmon_mod, "_backup_state_dir", lambda: state, raising=False)
    outcome = resmon_mod._apply_pending_restore_on_startup()
    assert outcome is not None and outcome["ok"], outcome
    assert outcome["schema_relation"] == "older"

    conn = db.get_connection(target)
    try:
        # The migrations ran, so the tables the strip needs now exist.
        assert db.get_schema_version(conn) == db.SCHEMA_VERSION
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='deliveries'").fetchone()
        assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == documents_before
        assert conn.execute(
            "SELECT COUNT(*) FROM executions WHERE status='running'").fetchone()[0] == 0
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        conn.close()


def test_a_failure_in_the_strip_is_not_swallowed(corpus, monkeypatch, tmp_path):
    """R2-2's other half: the strip raises, and the undo copy comes back.

    Round one logged and continued, so a restore that reclaimed nothing still
    answered ``ok``. The mutation here is the failure itself.
    """
    import resmon as resmon_mod

    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    backup_module.stage_restore(bundle, corpus["state_dir"], report)
    corpus["conn"].close()
    before = corpus["db_path"].read_bytes()

    def explode(conn):
        raise sqlite3.OperationalError("no such table: deliveries")

    monkeypatch.setattr(backup_module, "_strip_process_state", explode)
    monkeypatch.setattr(resmon_mod, "_db_path", str(corpus["db_path"]), raising=False)
    monkeypatch.setattr(resmon_mod, "_backup_state_dir",
                        lambda: corpus["state_dir"], raising=False)

    outcome = resmon_mod._apply_pending_restore_on_startup()
    assert outcome is not None and not outcome["ok"]
    assert "deliveries" in outcome["message"]
    assert outcome["undone"] is True
    assert corpus["db_path"].read_bytes() == before
    assert backup_module.undo_copies(corpus["state_dir"]) == []


# ---------------------------------------------------------------------------
# R2-3 -- orphan rows are recorded at backup, not discovered at restore
# ---------------------------------------------------------------------------


def _orphan(conn):
    """One row whose parent is not there. `foreign_key_check` finds it; opening does not."""
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute(
        "INSERT INTO library_file_documents (file_id, document_id, linked_at_utc) "
        "VALUES ('00000000-0000-4000-8000-000000000000', 999999, '2026-01-01T00:00:00Z')")
    conn.commit()
    conn.execute("PRAGMA foreign_keys=ON")


def test_a_corpus_with_an_orphan_row_still_backs_up_and_records_it(corpus, tmp_path):
    """The bundle is produced. Refusing here is what left a user with an unrestorable backup."""
    _orphan(corpus["conn"])
    manifest = _make_backup(corpus, tmp_path)
    assert Path(manifest["path"]).is_dir()
    # One row, two unsatisfied foreign keys (``library_files`` and
    # ``documents``), so ``foreign_key_check`` reports it twice -- the pragma
    # answers per constraint, not per row, and the manifest records what it says.
    assert manifest["fk_violations_total"] == 2
    assert {v["table"] for v in manifest["fk_violations"]} == {"library_file_documents"}
    assert {v["parent"] for v in manifest["fk_violations"]} == {"library_files", "documents"}
    assert "2 references to a parent that is not there" in manifest["fk_violations_message"]

    report = backup_module.verify_bundle(Path(manifest["path"]),
                                         this_schema_version=db.SCHEMA_VERSION)
    assert report["ok"], report["problems"]          # still a readable bundle
    assert report["needs_fk_acceptance"] is True
    assert report["fk_violations_total"] == 2


def test_an_unaccepted_orphan_refuses_to_stage_and_an_accepted_one_restores(
        corpus, monkeypatch, tmp_path):
    """A test each way: refused without the flag, restored with it, named in the record."""
    _orphan(corpus["conn"])
    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)

    with pytest.raises(backup_module.BackupError) as caught:
        backup_module.stage_restore(bundle, corpus["state_dir"], report)
    assert caught.value.reason == "fk_violations_not_accepted"
    assert backup_module.pending_restore(corpus["state_dir"]) is None

    backup_module.stage_restore(bundle, corpus["state_dir"], report,
                                accept_fk_violations=True)
    corpus["conn"].close()
    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)
    assert outcome is not None and outcome["ok"], outcome
    assert outcome["fk_violations_total"] == 2
    assert "references to a parent that is not there" in outcome["fk_violations_message"]

    conn = db.get_connection(corpus["db_path"])
    try:
        # Restored as it was: resmon did not quietly repair the corpus.
        assert len(conn.execute("PRAGMA foreign_key_check").fetchall()) == 2
    finally:
        conn.close()


def test_the_restore_route_refuses_an_unaccepted_orphan_over_http(tmp_path, monkeypatch):
    client, mod, db_path = _route_client(tmp_path, monkeypatch)
    try:
        conn = mod._get_db()
        ids = _seed_documents(conn, 3)
        parent = tmp_path / "fk-vault"
        parent.mkdir()
        _seed_vault(conn, parent, ids)
        _orphan(conn)

        path = client.post("/api/backup", json={"confirm": "CONFIRM",
                                                "include_reports": False}).json()["path"]
        verified = client.post("/api/backup/verify", json={"path": path}).json()
        assert verified["needs_fk_acceptance"] is True

        refused = client.post("/api/restore", json={"confirm": "CONFIRM", "path": path})
        assert refused.status_code == 400
        assert refused.json()["detail"]["reason"] == "fk_violations_not_accepted"
        assert refused.json()["detail"]["fk_violations_total"] == 2

        accepted = client.post("/api/restore", json={
            "confirm": "CONFIRM", "path": path, "accept_fk_violations": True})
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["staged"]["accept_fk_violations"] is True
    finally:
        mod.close_db()


# ---------------------------------------------------------------------------
# F1 / P1 -- how many rows, and not only how many references
# ---------------------------------------------------------------------------


def test_the_manifest_verify_and_the_outcome_all_count_rows(corpus, monkeypatch, tmp_path):
    """P1: one row, two unsatisfied foreign keys -- references 2, rows 1, everywhere.

    The three surfaces are asserted together because they are three copies of
    the same number and the interesting failure is one of them disagreeing:
    the manifest is written at backup, verify reads it back out of the bundle,
    and the outcome record is what Settings shows on the start after.
    """
    _orphan(corpus["conn"])
    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    assert manifest["fk_violations_total"] == 2
    assert manifest["fk_violations_rows"] == 1
    assert "2 references to a parent that is not there, from 1 row" \
        in manifest["fk_violations_message"]

    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    assert report["fk_violations_total"] == 2
    assert report["fk_violations_rows"] == 1
    assert "from 1 row" in report["fk_violations_message"]

    backup_module.stage_restore(bundle, corpus["state_dir"], report,
                                accept_fk_violations=True)
    corpus["conn"].close()
    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)
    assert outcome is not None and outcome["ok"], outcome
    assert outcome["fk_violations_total"] == 2
    assert outcome["fk_violations_rows"] == 1
    assert "from 1 row" in outcome["fk_violations_message"]


def test_a_without_rowid_orphan_is_counted_as_a_reference_and_not_as_a_row(corpus, tmp_path):
    """P1's trap: ``foreign_key_check`` answers rowid NULL for a WITHOUT ROWID table.

    Two such references cannot be told apart -- they may be one row or two --
    so they are counted in the total and never in the row count. The pragma's
    NULL is asserted here rather than assumed: if a future SQLite started
    answering a rowid for these, this case would be measuring nothing.

    resmon's own schema has no WITHOUT ROWID table, so the orphan is made in
    one created for this case; ``PRAGMA foreign_key_check`` looks at whatever
    the database holds.
    """
    conn = corpus["conn"]
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute("CREATE TABLE keyless_notes ("
                 "slug TEXT PRIMARY KEY, document_id INTEGER NOT NULL "
                 "REFERENCES documents(id)) WITHOUT ROWID")
    conn.execute("INSERT INTO keyless_notes VALUES ('a', 999999)")
    conn.execute("INSERT INTO keyless_notes VALUES ('b', 999998)")
    _orphan(conn)  # one ordinary row with two unsatisfied keys
    conn.commit()
    conn.execute("PRAGMA foreign_keys=ON")

    raw = conn.execute("PRAGMA foreign_key_check").fetchall()
    keyless = [r for r in raw if r[0] == "keyless_notes"]
    assert len(keyless) == 2
    assert all(r[1] is None for r in keyless), (
        "this case only measures anything while the pragma gives no rowid here")

    manifest = _make_backup(corpus, tmp_path)
    # Four references: two from the ordinary row, two with no rowid to count by.
    assert manifest["fk_violations_total"] == 4
    assert manifest["fk_violations_rows"] == 1
    assert "4 references to a parent that is not there, from 1 row" \
        in manifest["fk_violations_message"]


def test_when_nothing_can_be_counted_by_rowid_the_sentence_says_so():
    """Zero rows with a non-zero total is the only case where every reference was keyless."""
    listed = [{"table": "keyless_notes", "rowid": None, "parent": "documents", "fkid": 0}]
    said = backup_module.describe_fk_violations(listed, 2, 0)
    assert "2 references" in said
    assert "cannot count" in said
    assert "from 0 rows" not in said


def test_a_bundle_written_before_the_row_count_says_what_it_always_said(corpus, tmp_path):
    """P1: the field is additive, so its absence is "not measured", never zero.

    ``manifest_version`` stays 1, which means this build reads bundles that
    predate the field and must not invent a number for them.
    """
    _orphan(corpus["conn"])
    manifest = _make_backup(corpus, tmp_path)
    path = Path(manifest["path"]) / "manifest.json"
    raw = json.loads(path.read_text())
    del raw["fk_violations_rows"]
    path.write_text(json.dumps(raw, indent=2, sort_keys=True))

    report = backup_module.verify_bundle(Path(manifest["path"]),
                                         this_schema_version=db.SCHEMA_VERSION)
    assert report["ok"], report["problems"]
    assert report["fk_violations_rows"] is None
    assert "2 references to a parent that is not there (" in report["fk_violations_message"]
    assert "row" not in report["fk_violations_message"].split("(")[0]


# ---------------------------------------------------------------------------
# F2 / P2 -- the vault half of the undo
# ---------------------------------------------------------------------------


def _vault_hashes(root: Path) -> dict:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def test_a_restore_that_fails_after_the_vault_was_replaced_puts_the_vault_back(
        corpus, monkeypatch, tmp_path):
    """P2: both halves of the pair come back, and the undo directory goes.

    The vault on disk is deliberately *newer* than the bundle's -- a fourth
    file is imported after the backup -- so "byte for byte" is a statement
    about the user's own vault and not about the copy the restore just laid
    down. Before this change the restore removed that directory outright, and
    a failure afterwards put the database back over a vault that no longer
    existed.
    """
    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])

    with lib.Import(corpus["conn"], corpus["vault_id"], "fourth.txt", None) as upload:
        upload.write(b"retained after the backup was taken")
        upload.finish()
    corpus["conn"].commit()
    before_vault = _vault_hashes(corpus["vault_root"])
    assert len(before_vault) == 5, before_vault  # marker + four retained files

    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    backup_module.stage_restore(bundle, corpus["state_dir"], report)
    corpus["conn"].close()
    before_db = corpus["db_path"].read_bytes()

    seen = {}

    def explode(conn):
        """Fail after ``_restore_vault`` returned, and record what is on disk then."""
        copies = backup_module.undo_copies(corpus["state_dir"])
        seen["undo"] = copies
        seen["kept"] = sorted(
            str(p.relative_to(Path(copies[0]))) for p in Path(copies[0]).rglob("*")
        ) if copies else []
        raise sqlite3.OperationalError("no such table: deliveries")

    monkeypatch.setattr(backup_module, "_strip_process_state", explode)
    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)

    assert outcome is not None and not outcome["ok"]
    assert outcome["undone"] is True
    # The vault really was set aside rather than deleted: it was inside the
    # undo directory at the moment the restore failed.
    assert any(name.startswith(backup_module.VAULT_UNDO_NAME) for name in seen["kept"]), seen
    assert f"{backup_module.VAULT_UNDO_NAME}/vault.json" in seen["kept"]

    assert _vault_hashes(corpus["vault_root"]) == before_vault
    assert corpus["db_path"].read_bytes() == before_db
    assert backup_module.undo_copies(corpus["state_dir"]) == []


def test_a_vault_copy_the_undo_could_not_put_back_survives_the_clean_up(
        corpus, monkeypatch, tmp_path):
    """The one window where the undo cannot help: the copy must not be deleted too.

    `shutil.move` between volumes copies and then removes, and a removal
    interrupted part way leaves the original incomplete beside a *complete*
    copy in the undo directory. The pair is deliberately not recorded then --
    a copy that failed the other way round (copy interrupted, original intact)
    must never be moved back over the original -- so the undo skips the vault,
    and the clean-up used to delete the only whole copy one line later.

    The move is faked rather than performed across a real volume: the fake does
    exactly what `shutil.move`'s cross-device branch does in that window, which
    is what the test is about. A genuine two-volume move stays unmeasured and
    the handback says so.
    """
    import shutil as real_shutil

    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    backup_module.stage_restore(bundle, corpus["state_dir"], report)
    corpus["conn"].close()
    before_db = corpus["db_path"].read_bytes()
    vault_root = corpus["vault_root"]

    class _HalfRemovedMove:
        """`shutil` for this module only -- patching the module itself is global."""

        def __getattr__(self, name):
            return getattr(real_shutil, name)

        def move(self, src, dst):
            if Path(src) != vault_root:
                return real_shutil.move(src, dst)
            real_shutil.copytree(src, dst)                  # the copy completed
            (Path(src) / "vault.json").unlink()             # the removal did not
            raise OSError("interrupted while removing the original")

    monkeypatch.setattr(backup_module, "shutil", _HalfRemovedMove())
    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)

    assert outcome is not None and not outcome["ok"]
    assert corpus["db_path"].read_bytes() == before_db      # the database still came back
    copies = backup_module.undo_copies(corpus["state_dir"])
    assert len(copies) == 1, copies
    kept = Path(copies[0]) / backup_module.VAULT_UNDO_NAME
    assert kept.is_dir() and (kept / "vault.json").is_file()
    for item in corpus["files"]:
        assert hashlib.sha256((kept / item["relative_path"]).read_bytes()).hexdigest() \
            == item["sha256"]
    # And the record says where it is, rather than leaving the user to find it.
    assert outcome["vault_copy_kept"] == str(kept)


def test_a_failed_restore_to_an_empty_parent_leaves_that_parent_empty(
        corpus, monkeypatch, tmp_path):
    """P2, the `vault_parent` arm: nothing was set aside, so nothing may be left behind.

    The review round found this hole. Where the chosen parent holds no vault --
    the ordinary case on a second machine, and the case `vault_parent` exists
    for -- `vault_moved` is empty, so the undo had nothing to put back and the
    tree `_restore_vault` had just written stayed there: a full
    `resmon-library-<id>` holding every retained byte the bundle carried, in a
    folder the user chose, under a restore that reported `undone: True`.
    """
    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    chosen = tmp_path / "empty-chosen-parent"
    chosen.mkdir()

    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    backup_module.stage_restore(bundle, corpus["state_dir"], report,
                                vault_parent=str(chosen))
    corpus["conn"].close()
    before_db = corpus["db_path"].read_bytes()

    seen = {}

    def explode(conn):
        """Fail after `_restore_vault` returned, with the new tree on disk."""
        seen["during"] = sorted(str(p.relative_to(chosen)) for p in chosen.rglob("*"))
        raise sqlite3.OperationalError("no such table: deliveries")

    monkeypatch.setattr(backup_module, "_strip_process_state", explode)
    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)

    assert outcome is not None and not outcome["ok"]
    assert outcome["undone"] is True
    # The vault really had been written there, so this case is measuring something.
    assert any(name.startswith(backup_module.vault_dir_name(corpus["vault_id"]))
               for name in seen["during"]), seen
    assert list(chosen.iterdir()) == [], (
        "a restore that reports it undid everything left a vault the user never had")
    assert corpus["db_path"].read_bytes() == before_db
    assert backup_module.undo_copies(corpus["state_dir"]) == []
    assert outcome["vault_copy_kept"] is None


def test_an_undo_copy_covers_both_halves_and_one_delete_removes_both(
        corpus, monkeypatch, tmp_path):
    """D2: ``undo_copies`` lists one directory holding both, and deleting it deletes both."""
    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    backup_module.stage_restore(bundle, corpus["state_dir"], report)
    corpus["conn"].close()

    outcome = _apply_restore_through_startup(corpus, monkeypatch, bundle)
    assert outcome["ok"], outcome
    assert outcome["undo_includes_vault"] is True
    copies = backup_module.undo_copies(corpus["state_dir"])
    assert copies == [outcome["undo_copy"]]
    kept = Path(copies[0])
    assert (kept / "resmon.db").is_file()
    assert (kept / backup_module.VAULT_UNDO_NAME / "vault.json").is_file()

    assert backup_module.delete_undo_copies(corpus["state_dir"]) == 1
    assert not kept.exists()
    assert backup_module.undo_copies(corpus["state_dir"]) == []


# ---------------------------------------------------------------------------
# F3 / P3, P4 -- a vault parent on the restoring machine
# ---------------------------------------------------------------------------


SCRIPTS = PROJECT_ROOT / "resmon_scripts"

#: The restore step, run in a second interpreter that has never imported this
#: test's modules, against the environment the packaged app actually passes:
#: ``RESMON_DB_PATH`` and ``RESMON_STATE_DIR``. A restart is a new process, and
#: this is the closest a hermetic test gets to one without binding a socket.
#: That the lifespan calls this step is a separate case
#: (``test_the_restore_step_is_wired_into_the_lifespan``).
_RESTORE_IN_A_SECOND_PROCESS = (
    "import json, sys;"
    "import resmon;"
    "print('OUTCOME ' + json.dumps(resmon._apply_pending_restore_on_startup()))"
)


def _restart_in_a_second_process(db_path: Path, state_dir: Path, reports_dir: Path) -> dict:
    import subprocess

    env = {**os.environ,
           "RESMON_DB_PATH": str(db_path),
           "RESMON_STATE_DIR": str(state_dir),
           "RESMON_REPORTS_DIR": str(reports_dir),
           "RESMON_DISABLE_SCHEDULER": "1"}
    done = subprocess.run([sys.executable, "-c", _RESTORE_IN_A_SECOND_PROCESS],
                          cwd=str(SCRIPTS), env=env, capture_output=True,
                          text=True, timeout=180)
    assert done.returncode == 0, done.stderr
    line = [l for l in done.stdout.splitlines() if l.startswith("OUTCOME ")]
    assert line, done.stdout + done.stderr
    return json.loads(line[-1][len("OUTCOME "):])


def test_verify_says_where_the_vault_would_go_and_whether_that_works_here(corpus, tmp_path):
    """P3/D3: the destination comes out of the *bundle's* database, not this one."""
    manifest = _make_backup(corpus, tmp_path)
    report = backup_module.verify_bundle(Path(manifest["path"]),
                                         this_schema_version=db.SCHEMA_VERSION)
    destination = report["vault_destination"]
    assert destination["root_path"] == str(corpus["vault_root"])
    assert destination["parent"] == str(corpus["vault_root"].parent)
    assert destination["name"] == backup_module.vault_dir_name(corpus["vault_id"])
    assert destination["parent_exists"] is True
    assert destination["parent_writable"] is True

    # The second-machine case: that parent is not here.
    shutil.rmtree(corpus["vault_root"].parent)
    again = backup_module.verify_bundle(Path(manifest["path"]),
                                        this_schema_version=db.SCHEMA_VERSION)
    assert again["ok"], again["problems"]      # reported, never a refusal
    assert again["vault_destination"]["parent_exists"] is False
    assert again["vault_destination"]["parent_writable"] is False


def test_a_bundle_with_no_vault_has_no_destination_to_show(tmp_path):
    """The card shows none of this for a bundle that carries no vault."""
    db_path = tmp_path / "novault" / "resmon.db"
    db_path.parent.mkdir(parents=True)
    conn = db.get_connection(db_path)
    try:
        db.init_db(conn=conn)
        _seed_documents(conn, 1)
        conn.commit()
        manifest = backup_module.create_backup(
            conn, tmp_path / "backups", app_version="2.2.0",
            schema_version=db.SCHEMA_VERSION, include_reports=False,
            reports_dir=None, state_dir=db_path.parent)
    finally:
        conn.close()
    assert manifest["vault_id"] is None
    report = backup_module.verify_bundle(Path(manifest["path"]),
                                         this_schema_version=db.SCHEMA_VERSION)
    assert report["vault_destination"] is None


def test_a_restore_staged_with_a_vault_parent_lands_the_vault_there(corpus, tmp_path):
    """P3: the vault goes where this machine chose, and the corpus works afterwards.

    Machine A's vault parent is removed entirely before the restore, so a
    restore -- or the backup taken after it -- that still read from the old
    location could not succeed at all. The final backup re-hashes every
    retained byte against the catalog, from the new root.
    """
    manifest = _make_backup(corpus, tmp_path)
    bundle = Path(manifest["path"])
    retained = len(corpus["files"])
    corpus["conn"].close()

    machine_b = tmp_path / "machine-b"
    (machine_b / "state").mkdir(parents=True)
    (machine_b / "vaults").mkdir()
    fresh_db = machine_b / "state" / "resmon.db"
    chosen = machine_b / "vaults"
    shutil.rmtree(corpus["vault_root"].parent)          # machine A is gone

    report = backup_module.verify_bundle(bundle, this_schema_version=db.SCHEMA_VERSION)
    assert report["vault_destination"]["parent_exists"] is False
    resolved = backup_module.validate_vault_parent(
        str(chosen), bundle=bundle, vault_id=manifest["vault_id"])
    backup_module.stage_restore(bundle, machine_b / "state", report,
                                vault_parent=str(resolved))

    outcome = _restart_in_a_second_process(
        fresh_db, machine_b / "state", machine_b / "reports")
    assert outcome and outcome["ok"], outcome
    assert outcome["vault"]["restored"] is True
    expected_root = chosen / backup_module.vault_dir_name(corpus["vault_id"])
    assert outcome["vault"]["root_path"] == str(expected_root)
    assert expected_root.is_dir()

    conn = db.get_connection(fresh_db)
    try:
        assert conn.execute(
            "SELECT root_path FROM library_vault WHERE singleton=1"
        ).fetchone()["root_path"] == str(expected_root)
        assert lib.status(conn)["status"] == "ready"
        assert len(lib.list_files(conn, corpus["vault_id"])["files"]) == retained
        for item in corpus["files"]:
            copied = expected_root / item["relative_path"]
            assert hashlib.sha256(copied.read_bytes()).hexdigest() == item["sha256"]

        # A Library import works against the relocated vault.
        with lib.Import(conn, corpus["vault_id"], "after-the-move.txt", None) as upload:
            upload.write(b"an import after the vault moved house")
            assert upload.finish()["file"]["file_id"]

        # And a backup taken here re-hashes every byte from the new location:
        # `_copy_vault` reads through `library_vault.root_path` and aborts on a
        # missing or mismatched file, and the old parent no longer exists.
        again = backup_module.create_backup(
            conn, machine_b / "backups", app_version="2.2.0",
            schema_version=db.SCHEMA_VERSION, include_reports=False,
            reports_dir=None, state_dir=machine_b / "state")
        vault_entries = [f for f in again["files"] if f["path"].startswith("vault/")]
        print(f"F3: {len(vault_entries)} vault entries re-hashed from the new root "
              f"({retained + 1} retained files plus the marker)")
        assert len(vault_entries) == retained + 2
    finally:
        conn.close()


def _bundle_for_route(client, mod, tmp_path, name):
    conn = mod._get_db()
    ids = _seed_documents(conn, 3)
    parent = tmp_path / name
    parent.mkdir()
    _seed_vault(conn, parent, ids)
    conn.commit()
    response = client.post("/api/backup", json={"confirm": "CONFIRM",
                                                "include_reports": False})
    assert response.status_code == 200, response.text
    return response.json()["path"]


@pytest.mark.parametrize("reason", backup_module.VAULT_PARENT_REFUSALS)
def test_every_vault_parent_refusal_is_made_at_the_route_and_stages_nothing(
        reason, tmp_path, monkeypatch):
    """P4: 6 of 6 refusals, the denominator being ``backup.VAULT_PARENT_REFUSALS``.

    Each one is refused where the user is still holding the dialog, and none of
    them leaves a pointer behind -- a refusal that staged anything would be a
    restore nobody agreed to.
    """
    client, mod, db_path = _route_client(tmp_path, monkeypatch)
    try:
        path = _bundle_for_route(client, mod, tmp_path, f"vault-{reason}")
        vault_id = backup_module.read_manifest(Path(path))["vault_id"]
        home = tmp_path / "homes" / reason
        home.mkdir(parents=True)

        if reason == "vault_parent_not_absolute":
            chosen = "somewhere/relative"
        elif reason == "vault_parent_missing":
            chosen = str(home / "not-here")
        elif reason == "vault_parent_not_a_directory":
            target = home / "a-file"
            target.write_text("not a folder")
            chosen = str(target)
        elif reason == "vault_parent_not_writable":
            target = home / "read-only"
            target.mkdir()
            os.chmod(target, 0o500)
            if os.access(target, os.W_OK):
                pytest.skip("this user can write into a 0500 directory; "
                            "the refusal cannot be observed here")
            chosen = str(target)
        elif reason == "vault_parent_inside_bundle":
            chosen = str(Path(path) / "vault")
        else:
            target = home / "taken"
            (target / backup_module.vault_dir_name(vault_id)).mkdir(parents=True)
            (target / backup_module.vault_dir_name(vault_id) / "vault.json").write_text(
                json.dumps({"version": 1,
                            "vault_id": "11111111-1111-1111-1111-111111111111"}))
            chosen = str(target)

        refused = client.post("/api/restore", json={
            "confirm": "CONFIRM", "path": path, "vault_parent": chosen})
        assert refused.status_code == 400, refused.text
        assert refused.json()["detail"]["reason"] == reason, refused.text
        assert client.get("/api/backup/last").json()["pending_restore"] is None
    finally:
        try:
            os.chmod(tmp_path / "homes" / reason / "read-only", 0o700)
        except OSError:
            pass
        mod.close_db()


def test_an_accepted_vault_parent_reaches_the_pointer(tmp_path, monkeypatch):
    """The other half of P4: a parent that passes every check is what gets staged."""
    client, mod, db_path = _route_client(tmp_path, monkeypatch)
    try:
        path = _bundle_for_route(client, mod, tmp_path, "vault-ok")
        chosen = tmp_path / "somewhere-else"
        chosen.mkdir()
        staged = client.post("/api/restore", json={
            "confirm": "CONFIRM", "path": path, "vault_parent": str(chosen)})
        assert staged.status_code == 200, staged.text
        assert staged.json()["staged"]["vault_parent"] == str(chosen.resolve())
        pending = client.get("/api/backup/last").json()["pending_restore"]
        assert pending["vault_parent"] == str(chosen.resolve())
    finally:
        mod.close_db()
