"""Consistent backup of the database and the Library vault, and the restore that undoes it.

Until this module there was no backup and no restore. ``POST /api/cloud/backup``
uploaded ``REPORTS_DIR`` to Google Drive and nothing else -- not the database,
not one vault byte -- and nothing anywhere could read a backup back. The two
facts that shape everything here:

* **The database and the vault are a pair.** ``library._catalog_tree`` requires
  the directory listing to equal the catalog exactly, so a database restored
  without its bytes (or bytes restored without their rows) leaves the user with
  a vault that refuses every import and no way out. A bundle therefore carries
  both or the vault part of it is absent entirely.
* **A file copy of ``resmon.db`` is not a snapshot.** The database runs in WAL
  mode and nothing in resmon checkpoints, so live rows sit in ``-wal``. The
  bundle's database is produced with the SQLite backup API from the live
  connection, which is consistent by construction; the ``-wal``/``-shm``
  sidecars are deliberately *not* copied, because a checkpointed copy that also
  carried a stale WAL would be worse than either half.

What a bundle does not contain is as load-bearing as what it does, and the
manifest says so by name: no credential value is ever written into a bundle,
and process-scoped state (the daemon lock, the port file, the API token) is
described rather than carried. The restore reports the credential *names* the
user must re-enter, which is why the manifest records them.

The restore is staged rather than immediate. Replacing the database of a
running backend is not something a request thread can do safely, so
``POST /api/restore`` writes a pointer file and the work happens on the next
start, before anything opens the database -- and the database it replaces is
moved aside, never deleted, so a restore that fails can be undone.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

logger = logging.getLogger(__name__)

#: Version of the bundle layout. A bundle whose ``manifest_version`` this build
#: does not know is refused rather than guessed at.
MANIFEST_VERSION = 1

DB_NAME = "resmon.db"
VAULT_DIR = "vault"
REPORTS_DIR_NAME = "reports"
MANIFEST_NAME = "manifest.json"

#: The pointer a staged restore leaves in the state directory.
PENDING_NAME = "restore.pending"
#: Where the database being replaced is moved to. Kept until the next
#: successful backup or until the user deletes it from Settings.
UNDO_DIR_NAME = "restore-undo"
#: The record of the last restore attempt, successful or not.
RESTORE_LOG_NAME = "restore-last.json"

#: Process state that exists only while a backend is running. None of it is
#: restorable, and the manifest names it so a reader is not left wondering
#: whether the bundle simply missed it.
PROCESS_STATE_FILES = ("daemon.lock", "resmon.port", "api-token-<port>")


class BackupError(RuntimeError):
    """A backup, verification or restore that cannot proceed, with a reason code."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason
        self.message = message


# ---------------------------------------------------------------------------
# Hashing and small helpers
# ---------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_stamp() -> str:
    """A filesystem-safe UTC stamp: ``20260922T134501Z``."""
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _app_tables(conn: sqlite3.Connection) -> list[str]:
    """Application tables only -- what SQLite and fts5 made for themselves is derived.

    The same definition ``test_cumulative_upgrade.py`` uses, because the counts
    in a manifest are only meaningful against the same denominator the drill
    measures the restore with.
    """
    names = [
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND sql IS NOT NULL")
    ]
    return sorted(
        n for n in names
        if not n.startswith("sqlite_")
        and n != "documents_fts"
        and not n.startswith("documents_fts_")
    )


def credential_names_present(probe: Callable[[str], str] | None = None) -> list[str]:
    """The *names* of the keyring entries this machine holds. Never a value.

    A restore cannot bring secrets back, so the one useful thing a backup can
    record is which ones the user will have to re-enter. Webhook secrets are
    named after a ``routine_delivery_targets`` row id, so they are asked about
    per target rather than read from a fixed list.
    """
    from implementation_scripts import credential_manager as cm

    probe = probe or cm.probe_credential
    names: list[str] = []
    candidates = sorted(cm.allowed_credential_names())
    try:
        from implementation_scripts.repo_catalog import credential_names as catalog_names
        candidates += sorted(catalog_names())
    except Exception:  # pragma: no cover - catalog is always importable in-app
        logger.debug("Repository catalog unavailable while listing credential names")
    candidates += ["google_drive_token", "google_drive_client_id", "google_drive_client_secret"]
    for name in candidates:
        try:
            if probe(name) == cm.PRESENT:
                names.append(name)
        except Exception:
            # A keyring that will not answer is not a reason to fail a backup;
            # it is a reason to under-report, which the report says out loud.
            logger.debug("Keyring would not answer for %s while listing names", name)
    return names


def webhook_secret_names(conn: sqlite3.Connection, probe: Callable[[str], str] | None = None) -> list[str]:
    """Per-delivery-target webhook secret names that exist, by row id."""
    from implementation_scripts import credential_manager as cm

    probe = probe or cm.probe_credential
    try:
        ids = [int(r[0]) for r in conn.execute(
            "SELECT id FROM routine_delivery_targets WHERE channel='webhook' ORDER BY id")]
    except sqlite3.Error:
        return []
    found = []
    for target_id in ids:
        name = f"webhook_secret_{target_id}"
        try:
            if probe(name) == cm.PRESENT:
                found.append(name)
        except Exception:
            logger.debug("Keyring would not answer for %s", name)
    return found


# ---------------------------------------------------------------------------
# D1 -- the bundle
# ---------------------------------------------------------------------------


def snapshot_database(conn: sqlite3.Connection, destination: Path) -> None:
    """Write a consistent copy of *conn*'s database to *destination*.

    ``sqlite3.Connection.backup`` is the reason this is a snapshot rather than
    a copy: it reads through the same WAL the live connection does and produces
    a single self-contained file with no sidecars, while writers keep working.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    target = sqlite3.connect(str(destination))
    try:
        conn.backup(target)
        target.commit()
    finally:
        target.close()


def _copy_vault(conn: sqlite3.Connection, vault_root: Path, into: Path) -> list[dict]:
    """Copy every retained byte, re-hashing as we go. A mismatch aborts the backup.

    A vault whose bytes no longer hash to what the catalog recorded is not
    something to back up quietly: the copy would preserve the corruption and
    the manifest would certify it. The backup stops with the file named.
    """
    into.mkdir(parents=True, exist_ok=True)
    entries: list[dict] = []

    marker = vault_root / "vault.json"
    if not marker.is_file():
        raise BackupError("vault_unreadable", "The vault marker vault.json is missing.")
    shutil.copy2(marker, into / "vault.json")
    entries.append(_file_entry(into / "vault.json", f"{VAULT_DIR}/vault.json"))

    rows = [dict(r) for r in conn.execute(
        "SELECT file_id, version_id, sha256, byte_size, relative_path "
        "FROM library_files ORDER BY id")]
    for row in rows:
        relative = str(row["relative_path"])
        source = vault_root / relative
        if not source.is_file():
            raise BackupError(
                "vault_file_missing",
                f"Retained file {relative} is in the catalog but not in the vault; "
                "the backup stopped rather than certify an incomplete vault.",
            )
        destination = into / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        digest = sha256_file(destination)
        if digest != row["sha256"]:
            raise BackupError(
                "vault_hash_mismatch",
                f"Retained file {relative} no longer matches the hash the catalog "
                "recorded for it; the backup stopped rather than certify a corrupt vault.",
            )
        entries.append({
            "path": f"{VAULT_DIR}/{relative}",
            "size": destination.stat().st_size,
            "sha256": digest,
        })
    return entries


def _file_entry(path: Path, logical: str) -> dict:
    return {"path": logical, "size": path.stat().st_size, "sha256": sha256_file(path)}


def _copy_reports(reports_dir: Path, into: Path) -> list[dict]:
    entries: list[dict] = []
    if not reports_dir.is_dir():
        return entries
    for source in sorted(p for p in reports_dir.rglob("*") if p.is_file()):
        relative = source.relative_to(reports_dir)
        destination = into / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        entries.append(_file_entry(destination, f"{REPORTS_DIR_NAME}/{relative.as_posix()}"))
    return entries


def create_backup(
    conn: sqlite3.Connection,
    destination_parent: Path,
    *,
    app_version: str,
    schema_version: int,
    include_reports: bool = True,
    reports_dir: Path | None = None,
    state_dir: Path | None = None,
) -> dict:
    """Write one bundle under *destination_parent* and return its manifest.

    Any failure removes the partial directory: half a bundle that looks like a
    bundle is the thing most likely to be trusted at the worst moment.
    """
    started = time.monotonic()
    bundle = Path(destination_parent) / f"resmon-backup-{utc_stamp()}"
    if bundle.exists():
        raise BackupError("exists", f"{bundle} already exists.")
    bundle.mkdir(parents=True)
    try:
        snapshot_database(conn, bundle / DB_NAME)
        files = [_file_entry(bundle / DB_NAME, DB_NAME)]

        vault_id = None
        vault_row = conn.execute(
            "SELECT vault_id, root_path FROM library_vault WHERE singleton=1").fetchone()
        if vault_row is not None:
            vault_id = vault_row["vault_id"]
            files += _copy_vault(conn, Path(vault_row["root_path"]), bundle / VAULT_DIR)

        if include_reports and reports_dir is not None:
            files += _copy_reports(Path(reports_dir), bundle / REPORTS_DIR_NAME)

        counts = {}
        for table in _app_tables(conn):
            try:
                counts[table] = int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            except sqlite3.Error:
                logger.debug("Could not count %s for the manifest", table)

        excluded_credentials = credential_names_present() + webhook_secret_names(conn)
        manifest = {
            "manifest_version": MANIFEST_VERSION,
            "app_version": app_version,
            "schema_version": int(schema_version),
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "vault_id": vault_id,
            "includes_reports": bool(include_reports and reports_dir is not None),
            "table_counts": counts,
            "table_count_denominator": len(counts),
            "files": files,
            "excluded": {
                # Names only, never values. These are what a restore cannot
                # bring back and the user must re-enter by hand.
                "credentials": sorted(set(excluded_credentials)),
                "process_state": list(PROCESS_STATE_FILES),
                "state_dir": str(state_dir) if state_dir else None,
                "note": (
                    "Credential values are never written into a backup. The names "
                    "above are the keyring entries this machine held when the "
                    "backup was taken; a restore lists them for re-entry."
                ),
            },
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
        (bundle / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2, sort_keys=True))
        manifest["path"] = str(bundle)
        manifest["manifest_sha256"] = sha256_file(bundle / MANIFEST_NAME)
        return manifest
    except BaseException:
        shutil.rmtree(bundle, ignore_errors=True)
        raise


# ---------------------------------------------------------------------------
# D2 -- verify
# ---------------------------------------------------------------------------


def read_manifest(bundle: Path) -> dict:
    path = Path(bundle) / MANIFEST_NAME
    if not path.is_file():
        raise BackupError("not_a_bundle", f"No {MANIFEST_NAME} in {bundle}.")
    try:
        manifest = json.loads(path.read_text())
    except ValueError as exc:
        raise BackupError("manifest_unreadable", f"{MANIFEST_NAME} is not valid JSON: {exc}")
    if not isinstance(manifest, dict):
        raise BackupError("manifest_unreadable", f"{MANIFEST_NAME} is not an object.")
    return manifest


def verify_bundle(
    bundle: Path,
    *,
    this_schema_version: int,
    configured_vault_id: str | None = None,
) -> dict:
    """Recompute every hash and report what a restore would and would not do.

    No side effects: this is the report the UI renders before the user commits
    to anything, and the same report the startup path re-runs before it moves
    a single byte.
    """
    bundle = Path(bundle)
    manifest = read_manifest(bundle)
    problems: list[str] = []

    if manifest.get("manifest_version") != MANIFEST_VERSION:
        problems.append(
            f"This backup's layout is version {manifest.get('manifest_version')!r}; "
            f"this resmon understands version {MANIFEST_VERSION}.")

    bundle_schema = manifest.get("schema_version")
    schema_relation = "same"
    if not isinstance(bundle_schema, int):
        problems.append("The manifest does not record a schema version.")
        schema_relation = "unknown"
    elif bundle_schema > this_schema_version:
        schema_relation = "newer"
        problems.append(
            f"This backup was written by a newer resmon (database schema "
            f"{bundle_schema}; this app understands {this_schema_version}). Update "
            "resmon to restore it; an older resmon cannot read a newer database.")
    elif bundle_schema < this_schema_version:
        schema_relation = "older"

    checked = 0
    for entry in manifest.get("files", []):
        logical = entry.get("path", "")
        path = bundle / logical
        if not path.is_file():
            problems.append(f"{logical} is named in the manifest but missing from the backup.")
            continue
        if path.stat().st_size != entry.get("size"):
            problems.append(f"{logical} is not the size the manifest records.")
            continue
        if sha256_file(path) != entry.get("sha256"):
            problems.append(f"{logical} does not match the hash the manifest records.")
            continue
        checked += 1

    bundle_vault = manifest.get("vault_id")
    if bundle_vault is None:
        vault_relation = "none_in_backup"
    elif configured_vault_id is None:
        vault_relation = "none_configured"
    elif configured_vault_id == bundle_vault:
        vault_relation = "same"
    else:
        vault_relation = "different"

    excluded = manifest.get("excluded", {}) or {}
    return {
        "path": str(bundle),
        "manifest": manifest,
        "manifest_sha256": sha256_file(bundle / MANIFEST_NAME),
        "files_checked": checked,
        "files_in_manifest": len(manifest.get("files", [])),
        "schema_relation": schema_relation,
        "vault_relation": vault_relation,
        "problems": problems,
        "ok": not problems,
        "will_not_restore": {
            "credentials": list(excluded.get("credentials", [])),
            "process_state": list(excluded.get("process_state", [])),
            "note": (
                "Executions that were running and deliveries that were in flight "
                "are reset: resmon cannot resume another process's work, and on "
                "another machine the owner recorded in those rows is a stranger."
            ),
        },
    }


# ---------------------------------------------------------------------------
# D3 -- staged restore
# ---------------------------------------------------------------------------


def stage_restore(bundle: Path, state_dir: Path, report: dict) -> dict:
    """Write the pointer the next start will act on. Nothing is moved here."""
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    pointer = {
        "bundle": str(Path(bundle).resolve()),
        "manifest_sha256": report["manifest_sha256"],
        "staged_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    (state_dir / PENDING_NAME).write_text(json.dumps(pointer, indent=2))
    return pointer


def pending_restore(state_dir: Path) -> dict | None:
    path = Path(state_dir) / PENDING_NAME
    if not path.is_file():
        return None
    try:
        pointer = json.loads(path.read_text())
    except ValueError:
        return {"bundle": None, "manifest_sha256": None, "unreadable": True}
    return pointer if isinstance(pointer, dict) else None


def clear_pending(state_dir: Path) -> None:
    try:
        (Path(state_dir) / PENDING_NAME).unlink()
    except FileNotFoundError:
        pass


def _record(state_dir: Path, outcome: dict) -> dict:
    outcome = dict(outcome)
    outcome["at_utc"] = datetime.now(timezone.utc).isoformat()
    try:
        (Path(state_dir) / RESTORE_LOG_NAME).write_text(json.dumps(outcome, indent=2))
    except OSError:
        logger.exception("Could not record the restore outcome")
    return outcome


def last_restore(state_dir: Path) -> dict | None:
    path = Path(state_dir) / RESTORE_LOG_NAME
    if not path.is_file():
        return None
    try:
        record = json.loads(path.read_text())
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def undo_copies(state_dir: Path) -> list[str]:
    root = Path(state_dir) / UNDO_DIR_NAME
    if not root.is_dir():
        return []
    return sorted(str(p) for p in root.iterdir() if p.is_dir())


def delete_undo_copies(state_dir: Path) -> int:
    copies = undo_copies(state_dir)
    for path in copies:
        shutil.rmtree(path, ignore_errors=True)
    return len(copies)


def _strip_process_state(conn: sqlite3.Connection) -> dict:
    """Undo the parts of the database that describe a *process*, not a corpus.

    ``executions.owner_pid``/``owner_runtime_id`` and the matching delivery
    columns name a process that, after a restore, is certainly gone and on
    another machine never existed. A ``running`` row whose owner cannot be
    asked is ``interrupted`` with reason ``unknown`` -- not ``owner_dead``,
    which claims a fact this path did not establish.
    """
    result = {"executions_interrupted": 0, "deliveries_requeued": 0}
    try:
        cur = conn.execute(
            "UPDATE executions SET status='interrupted', interrupted_reason='unknown', "
            "owner_pid=NULL, owner_runtime_id=NULL WHERE status='running'")
        result["executions_interrupted"] = cur.rowcount
        conn.execute("UPDATE executions SET owner_pid=NULL, owner_runtime_id=NULL")
    except sqlite3.Error:
        logger.exception("Could not strip execution ownership after a restore")
    try:
        cur = conn.execute(
            "UPDATE deliveries SET state='queued', owner_pid=NULL, owner_runtime_id=NULL "
            "WHERE state='delivering'")
        result["deliveries_requeued"] = cur.rowcount
        conn.execute("UPDATE deliveries SET owner_pid=NULL, owner_runtime_id=NULL")
    except sqlite3.Error:
        logger.exception("Could not strip delivery ownership after a restore")
    conn.commit()
    return result


def _rebuild_fts(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("INSERT INTO documents_fts(documents_fts) VALUES ('rebuild')")
        conn.commit()
        return True
    except sqlite3.Error:
        # A bundle from an install predating the search index has no FTS table;
        # ``init_db`` creates and populates it a moment later.
        return False


def _restore_vault(bundle: Path, manifest: dict, target_root: Path) -> dict:
    """Put the vault bytes back beside the rows that describe them.

    Refuses to overwrite a *different* vault: a directory named for another
    vault_id holds someone's retained files, and the pair rule means this
    restore's database could never describe them.
    """
    source = Path(bundle) / VAULT_DIR
    if not source.is_dir():
        return {"restored": False, "reason": "no_vault_in_backup"}
    expected_name = "resmon-library-" + str(manifest.get("vault_id"))
    if target_root.name != expected_name:
        raise BackupError(
            "vault_name_mismatch",
            f"The vault path recorded in the backup's database is {target_root.name}, "
            f"which is not {expected_name}.")
    if target_root.exists():
        marker = target_root / "vault.json"
        existing = None
        if marker.is_file():
            try:
                existing = (json.loads(marker.read_text()) or {}).get("vault_id")
            except (ValueError, OSError):
                existing = None
        if existing is not None and existing != manifest.get("vault_id"):
            raise BackupError(
                "different_vault",
                f"{target_root} already holds vault {existing}, and this backup "
                f"carries vault {manifest.get('vault_id')}. resmon will not overwrite "
                "another vault's retained files; move or rename that directory first.")
        shutil.rmtree(target_root)
    target_root.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target_root)
    try:
        os.chmod(target_root, 0o700)
    except OSError:
        logger.debug("Could not set 0700 on the restored vault root")
    # ``.import.lock`` has no automatic stale-lock recovery, so a bundle that
    # somehow carried one would leave the restored vault permanently busy.
    lock = target_root / ".import.lock"
    if lock.exists():
        lock.unlink()
    return {"restored": True, "root_path": str(target_root)}


def apply_pending_restore(
    state_dir: Path,
    db_path: Path,
    *,
    this_schema_version: int,
    init_db: Callable[[str], None],
    daemon_lock_held: Callable[[], bool] | None = None,
) -> dict | None:
    """Act on a staged restore, if there is one. Runs before anything opens the database.

    Returns ``None`` when there is nothing pending, otherwise the outcome
    record -- which is also written to the state directory so Settings can show
    what happened on a start the user did not watch.

    The pointer is removed last, and only on a path that reached a decision:
    a start that crashes half way through finds the pointer again and retries
    rather than silently forgetting that a restore was asked for.
    """
    state_dir = Path(state_dir)
    pointer = pending_restore(state_dir)
    if pointer is None:
        return None

    db_path = Path(db_path)
    bundle = Path(pointer.get("bundle") or "")

    def fail(reason: str, message: str) -> dict:
        clear_pending(state_dir)
        return _record(state_dir, {"ok": False, "reason": reason, "message": message,
                                   "bundle": str(bundle)})

    if pointer.get("unreadable") or not pointer.get("bundle"):
        return fail("pointer_unreadable", "The staged restore pointer could not be read.")
    if not bundle.is_dir():
        return fail("bundle_missing",
                    f"The backup staged for restore is no longer at {bundle}. "
                    "resmon started normally and changed nothing.")

    try:
        report = verify_bundle(bundle, this_schema_version=this_schema_version)
    except BackupError as exc:
        return fail(exc.reason, exc.message)
    if not report["ok"]:
        return fail("verification_failed", "; ".join(report["problems"]))
    if pointer.get("manifest_sha256") and report["manifest_sha256"] != pointer["manifest_sha256"]:
        return fail("manifest_changed",
                    "The backup's manifest changed after it was staged; nothing was restored.")

    if daemon_lock_held is not None:
        try:
            if daemon_lock_held():
                return fail("database_in_use",
                            "Another resmon process holds this database. Quit it and start "
                            "resmon again to restore.")
        except Exception:
            logger.exception("Could not check the daemon lock before restoring")

    manifest = report["manifest"]
    undo = state_dir / UNDO_DIR_NAME / utc_stamp()
    undo.mkdir(parents=True, exist_ok=True)
    moved: list[tuple[Path, Path]] = []
    for suffix in ("", "-wal", "-shm"):
        current = Path(str(db_path) + suffix)
        if current.exists():
            destination = undo / current.name
            shutil.move(str(current), str(destination))
            moved.append((current, destination))

    def undo_everything() -> None:
        for current, destination in moved:
            if current.exists():
                current.unlink()
            if destination.exists():
                shutil.move(str(destination), str(current))

    try:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(bundle / DB_NAME, db_path)

        vault_result = {"restored": False, "reason": "no_vault_in_backup"}
        if manifest.get("vault_id"):
            probe = sqlite3.connect(str(db_path))
            try:
                probe.row_factory = sqlite3.Row
                row = probe.execute(
                    "SELECT root_path FROM library_vault WHERE singleton=1").fetchone()
            finally:
                probe.close()
            if row is None:
                raise BackupError(
                    "vault_row_missing",
                    "The backup carries vault bytes but its database has no vault row.")
            vault_result = _restore_vault(bundle, manifest, Path(row["root_path"]))

        conn = sqlite3.connect(str(db_path))
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA foreign_keys=ON;")
            rewrites = _strip_process_state(conn)
            _rebuild_fts(conn)
        finally:
            conn.close()

        init_db(str(db_path))

        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("PRAGMA foreign_keys=ON;")
            integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
            fk_problems = conn.execute("PRAGMA foreign_key_check").fetchall()
            # ``init_db`` may have created the FTS table for the first time on
            # an older bundle; rebuild after the migrations either way so the
            # index answers for exactly the rows that were restored.
            _rebuild_fts(conn)
        finally:
            conn.close()
        if integrity != "ok":
            raise BackupError("integrity_check_failed",
                              f"The restored database failed integrity_check: {integrity}")
        if fk_problems:
            raise BackupError("foreign_key_check_failed",
                              f"The restored database has {len(fk_problems)} foreign-key violations.")
    except BaseException as exc:
        for suffix in ("", "-wal", "-shm"):
            broken = Path(str(db_path) + suffix)
            if broken.exists():
                broken.unlink()
        undo_everything()
        shutil.rmtree(undo, ignore_errors=True)
        reason = exc.reason if isinstance(exc, BackupError) else "restore_failed"
        message = exc.message if isinstance(exc, BackupError) else str(exc)
        clear_pending(state_dir)
        return _record(state_dir, {"ok": False, "reason": reason, "message": message,
                                   "bundle": str(bundle), "undone": True})

    outcome = {
        "ok": True,
        "bundle": str(bundle),
        "undo_copy": str(undo) if moved else None,
        "schema_relation": report["schema_relation"],
        "vault": vault_result,
        "rewrites": rewrites,
        "credentials_to_reenter": report["will_not_restore"]["credentials"],
        "acknowledged": False,
    }
    record = _record(state_dir, outcome)
    clear_pending(state_dir)
    return record
