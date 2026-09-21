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
#: Where the database being replaced is moved to. **Nothing removes it on its
#: own** -- ``delete_undo_copies`` has one caller, the Settings route, so a copy
#: stays until the user deletes it. That is deliberate (an undo the app can
#: silently expire is not an undo), and it is why every copy is kept rather than
#: only the most recent one.
UNDO_DIR_NAME = "restore-undo"
#: The record of the last restore attempt, successful or not.
RESTORE_LOG_NAME = "restore-last.json"

#: Process state that exists only while a backend is running. None of it is
#: restorable, and the manifest names it so a reader is not left wondering
#: whether the bundle simply missed it.
PROCESS_STATE_FILES = ("daemon.lock", "resmon.port", "api-token-<port>")


#: How many foreign-key violations a manifest lists individually. A corpus that
#: has drifted badly enough to exceed this does not become more diagnosable by
#: listing another thousand rows, and the manifest stays readable; the total is
#: recorded either way.
MAX_LISTED_FK_VIOLATIONS = 100

#: Where a vault the restore replaces is kept inside ``restore-undo/<stamp>/``,
#: beside the database files of the same restore. One name, so that deleting the
#: stamp directory deletes both halves of the undo and nothing else.
VAULT_UNDO_NAME = "vault-replaced"

#: Every reason a vault parent chosen on the restoring machine can be refused.
#: The route validates in this order and the property test parametrises over
#: this tuple, so a check added without a case to cover it changes the
#: denominator and fails that test rather than passing unnoticed.
VAULT_PARENT_REFUSALS = (
    "vault_parent_not_absolute",
    "vault_parent_missing",
    "vault_parent_not_a_directory",
    "vault_parent_not_writable",
    "vault_parent_inside_bundle",
    "different_vault",
)


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


def foreign_key_violations(conn: sqlite3.Connection) -> tuple[list[dict], int, int]:
    """Every orphan row ``PRAGMA foreign_key_check`` can find, the total, and the rows.

    Recorded at *backup* time, which is the point this exists. ``foreign_key_check``
    already gated the restore, so a corpus carrying one orphan row -- which
    resmon opens quite happily, because the pragma is a check and not a
    constraint on existing rows -- could be backed up, could be verified, and
    could then never be restored. The user found that out at the worst possible
    moment. Now the bundle records what it found, verify reports it, and the
    restore asks the user to accept it rather than refusing forever.

    Rows come back as ``(table, rowid, parent, fkid)``. The pragma answers once
    per unsatisfied foreign key, so one row with two broken keys appears twice;
    the third return value de-duplicates by ``(table, rowid)`` and is therefore
    a count of *rows*, which is the number a person is actually picturing.

    **The rowid is NULL for a WITHOUT ROWID table**, and two such references
    cannot be told apart -- they may be one row or two. Those references are
    counted in the total and deliberately *not* in the row count, so the row
    count is a count of the rows SQLite identified and never a guess. resmon's
    own schema has no WITHOUT ROWID table today, so this is a guard rather than
    a case; ``docs/backup.md`` says the same thing for anyone reading a manifest.
    """
    try:
        rows = conn.execute("PRAGMA foreign_key_check").fetchall()
    except sqlite3.Error:
        logger.exception("Could not run foreign_key_check while backing up")
        return [], 0, 0
    listed = [
        {"table": r[0], "rowid": r[1], "parent": r[2], "fkid": r[3]}
        for r in rows[:MAX_LISTED_FK_VIOLATIONS]
    ]
    # Over every row the pragma returned, not only the listed sample: a bundle
    # with 400 references still records how many rows they came from.
    distinct = {(r[0], r[1]) for r in rows if r[1] is not None}
    return listed, len(rows), len(distinct)


def describe_fk_violations(listed: list[dict], total: int, rows: int | None = None) -> str:
    """One sentence a person can act on, for the route answer and the card.

    The leading number counts **references**, not rows, because that is what
    ``PRAGMA foreign_key_check`` counts: it answers once per unsatisfied
    foreign key, so a single row with two broken keys appears twice. Reporting
    only that number left a person dividing by an unknown, so the sentence now
    carries the row count beside it -- de-duplicated by ``(table, rowid)``.

    *rows* is ``None`` for a bundle written before the manifest recorded it, and
    the sentence then reads exactly as it did: an old bundle does not acquire a
    number nobody measured. It is ``0`` with a non-zero total only when every
    reference came from a WITHOUT ROWID table, where the pragma gives no rowid
    to de-duplicate on; the sentence says so rather than printing "from 0 rows".
    """
    if not total:
        return ""
    shown = ", ".join(
        f"{v['table']} row {v['rowid']} -> {v['parent']}" for v in listed[:5])
    more = "" if total <= 5 else f", and {total - 5} more"
    references = f"{total} reference{'' if total == 1 else 's'} to a parent that is not there"
    if rows is None:
        opening = references
    elif rows == 0:
        opening = (f"{references}, from rows resmon cannot count (the tables "
                   "involved have no rowid for it to tell them apart by)")
    else:
        opening = f"{references}, from {rows} row{'' if rows == 1 else 's'}"
    return (f"{opening} ({shown}{more}). resmon can restore this database, but those "
            "rows will still be orphaned afterwards.")


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
        # Measured on the bundle's own copy, which is what a restore will put
        # back -- not on the live database, which may have moved on since.
        snapshot = sqlite3.connect(str(bundle / DB_NAME))
        try:
            fk_listed, fk_total, fk_rows = foreign_key_violations(snapshot)
        finally:
            snapshot.close()
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
            "fk_violations": fk_listed,
            "fk_violations_total": fk_total,
            # Additive in manifest version 1: a bundle written before this
            # field existed has no row count, and everything downstream treats
            # its absence as "not measured" rather than as zero.
            "fk_violations_rows": fk_rows,
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
        manifest["fk_violations_message"] = describe_fk_violations(
            fk_listed, fk_total, fk_rows)
        return manifest
    except BaseException:
        shutil.rmtree(bundle, ignore_errors=True)
        raise


# ---------------------------------------------------------------------------
# D2 -- verify
# ---------------------------------------------------------------------------


def vault_dir_name(vault_id) -> str:
    """The one name a vault directory may have. ``library.vault_row`` enforces it."""
    return "resmon-library-" + str(vault_id)


def bundle_vault_root(bundle: Path, manifest: dict) -> str | None:
    """Where the bundle's own database says its vault lives, or ``None``.

    The bundle does not carry the vault directory's *path* -- ``vault/`` is
    copied relative-path for relative-path and the name is rebuilt from the
    vault id -- so the only record of where it came from is
    ``library_vault.root_path`` inside the snapshotted database. A person
    restoring onto another machine needs to see that before they commit, which
    is why verify opens the bundle's database for this one row.
    """
    if not manifest.get("vault_id"):
        return None
    database = Path(bundle) / DB_NAME
    if not database.is_file():
        return None
    try:
        probe = sqlite3.connect(str(database))
    except sqlite3.Error:
        return None
    try:
        row = probe.execute(
            "SELECT root_path FROM library_vault WHERE singleton=1").fetchone()
    except sqlite3.Error:
        # A bundle whose database has no vault table at all is a bundle with no
        # vault to place; the file checks above have already had their say.
        return None
    finally:
        probe.close()
    return str(row[0]) if row and row[0] else None


def describe_vault_destination(bundle: Path, manifest: dict) -> dict | None:
    """Where a restore would put the vault *here*, and whether that can work.

    Reported, never a problem: a parent that is missing on this machine is the
    ordinary case when a backup moves between machines, and the answer to it is
    to choose another parent rather than to refuse the bundle.
    """
    root = bundle_vault_root(bundle, manifest)
    if root is None:
        return None
    root_path = Path(root)
    parent = root_path.parent
    exists = parent.is_dir()
    return {
        "root_path": str(root_path),
        "parent": str(parent),
        "name": root_path.name,
        "parent_exists": exists,
        "parent_writable": bool(exists and os.access(parent, os.W_OK | os.X_OK)),
    }


def validate_vault_parent(vault_parent: str, *, bundle: Path, vault_id) -> Path:
    """Refuse a chosen vault parent before anything is staged, or return it resolved.

    Every refusal here is a reason in :data:`VAULT_PARENT_REFUSALS`, and the
    order is the order of the checks: a path that does not exist cannot be
    asked whether it is a directory. ``different_vault`` is the same refusal
    ``_restore_vault`` makes on the next start, moved forward to the request so
    the user hears it while they can still choose somewhere else.
    """
    parent = Path(vault_parent).expanduser()
    if not parent.is_absolute():
        raise BackupError(
            "vault_parent_not_absolute",
            f"{vault_parent} is not an absolute path; choose a folder rather than "
            "a name relative to wherever resmon happens to be running.")
    if not parent.exists():
        raise BackupError("vault_parent_missing", f"{parent} does not exist on this machine.")
    if not parent.is_dir():
        raise BackupError("vault_parent_not_a_directory", f"{parent} is not a folder.")
    if not os.access(parent, os.W_OK | os.X_OK):
        raise BackupError("vault_parent_not_writable",
                          f"resmon cannot write into {parent}.")
    resolved = parent.resolve()
    bundle_root = Path(bundle).resolve()
    if resolved == bundle_root or bundle_root in resolved.parents:
        raise BackupError(
            "vault_parent_inside_bundle",
            f"{resolved} is inside the backup itself. The vault would be restored "
            "into the bundle it is being read from; choose a folder outside it.")
    target = resolved / vault_dir_name(vault_id)
    marker = target / "vault.json"
    if marker.is_file():
        try:
            existing = (json.loads(marker.read_text()) or {}).get("vault_id")
        except (ValueError, OSError):
            existing = None
        if existing is not None and str(existing) != str(vault_id):
            raise BackupError(
                "different_vault",
                f"{target} already holds vault {existing}, and this backup carries "
                f"vault {vault_id}. resmon will not overwrite another vault's "
                "retained files; move or rename that directory first.")
    return resolved


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
    fk_listed = list(manifest.get("fk_violations", []) or [])
    fk_total = int(manifest.get("fk_violations_total") or 0)
    raw_rows = manifest.get("fk_violations_rows")
    # Absent on a bundle written before the field existed. ``None`` travels all
    # the way to the card, which then says what the old bundle said and no more.
    fk_rows = int(raw_rows) if isinstance(raw_rows, int) else None
    return {
        "path": str(bundle),
        "manifest": manifest,
        "manifest_sha256": sha256_file(bundle / MANIFEST_NAME),
        "files_checked": checked,
        "files_in_manifest": len(manifest.get("files", [])),
        "schema_relation": schema_relation,
        "vault_relation": vault_relation,
        "problems": problems,
        # Orphan rows are reported, never a problem: they do not make the
        # bundle unreadable, and refusing here is exactly the trap that put a
        # user's only backup out of reach. The restore asks them to accept it.
        "fk_violations": fk_listed,
        "fk_violations_total": fk_total,
        "fk_violations_rows": fk_rows,
        "fk_violations_message": describe_fk_violations(fk_listed, fk_total, fk_rows),
        "needs_fk_acceptance": fk_total > 0,
        "vault_destination": describe_vault_destination(bundle, manifest),
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


def stage_restore(bundle: Path, state_dir: Path, report: dict,
                  *, accept_fk_violations: bool = False,
                  vault_parent: str | None = None) -> dict:
    """Write the pointer the next start will act on. Nothing is moved here.

    A bundle carrying orphan rows is staged only when the caller says so: the
    user is told what they are keeping before they keep it, and the decision
    travels in the pointer so the start that acts on it does not have to guess.

    *vault_parent* travels the same way. The start that acts on the pointer has
    no request to ask, so a vault that is to land somewhere other than the path
    recorded in the bundle's database has to be told here; the caller validates
    it first (:func:`validate_vault_parent`).
    """
    state_dir = Path(state_dir)
    if report.get("needs_fk_acceptance") and not accept_fk_violations:
        raise BackupError(
            "fk_violations_not_accepted",
            report.get("fk_violations_message")
            or "This backup contains rows that reference a parent that is not there.")
    state_dir.mkdir(parents=True, exist_ok=True)
    pointer = {
        "bundle": str(Path(bundle).resolve()),
        "manifest_sha256": report["manifest_sha256"],
        "accept_fk_violations": bool(accept_fk_violations),
        "vault_parent": str(vault_parent) if vault_parent else None,
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

    **Runs after ``init_db``, and raises.** It used to run before, against the
    bundle's own schema, and swallow ``sqlite3.Error``: on a v2.2.0-era bundle
    that is "no such table: deliveries", and the restore carried on and
    reported success while every ``delivering`` row it was meant to requeue was
    still owned by a process on another machine. A failure here is a failure of
    the restore and is treated like one -- the undo copy goes back.

    ``awaiting_review`` is deliberately untouched: it describes a *decision the
    user has not made*, not a process, and requeueing it would deliver
    something they were still looking at.
    """
    result = {"executions_interrupted": 0, "deliveries_requeued": 0}
    cur = conn.execute(
        "UPDATE executions SET status='interrupted', interrupted_reason='unknown', "
        "owner_pid=NULL, owner_runtime_id=NULL WHERE status='running'")
    result["executions_interrupted"] = cur.rowcount
    conn.execute("UPDATE executions SET owner_pid=NULL, owner_runtime_id=NULL")
    cur = conn.execute(
        "UPDATE deliveries SET state='queued', owner_pid=NULL, owner_runtime_id=NULL "
        "WHERE state='delivering'")
    result["deliveries_requeued"] = cur.rowcount
    conn.execute("UPDATE deliveries SET owner_pid=NULL, owner_runtime_id=NULL")
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


def _restore_vault(bundle: Path, manifest: dict, target_root: Path,
                   *, undo_dir: Path | None = None,
                   moved_aside: list | None = None) -> dict:
    """Put the vault bytes back beside the rows that describe them.

    Refuses to overwrite a *different* vault: a directory named for another
    vault_id holds someone's retained files, and the pair rule means this
    restore's database could never describe them.

    A vault that *is* replaced is **moved aside, not deleted**, into the same
    ``restore-undo/<stamp>/`` directory as the database files of the same
    restore -- which is what makes the undo cover both halves of the pair. It
    used to be removed outright, so a restore that failed after this point put
    the database back and left the user's retained bytes gone.

    ``shutil.move`` renames within a volume and copies between them, so a vault
    on a different volume from the state directory costs a full copy of every
    retained byte and the disk to hold it twice. That is the right trade: the
    alternative is deleting the only copy of the user's files and hoping the
    rest of the restore succeeds. The copy finishes before the original is
    removed, so a failure during it leaves the original where it was.
    """
    source = Path(bundle) / VAULT_DIR
    if not source.is_dir():
        return {"restored": False, "reason": "no_vault_in_backup"}
    replaced: str | None = None
    expected_name = vault_dir_name(manifest.get("vault_id"))
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
        if undo_dir is None:
            shutil.rmtree(target_root)
        else:
            kept = Path(undo_dir) / VAULT_UNDO_NAME
            Path(undo_dir).mkdir(parents=True, exist_ok=True)
            try:
                shutil.move(str(target_root), str(kept))
            except BaseException:
                # Recorded only when the original is demonstrably gone from
                # where it was: ``shutil.move`` removes the source only after
                # the copy completed, so a copy interrupted here leaves the
                # original intact and the half copy must not be mistaken for it.
                if kept.exists() and not target_root.exists() and moved_aside is not None:
                    moved_aside.append((target_root, kept))
                raise
            if moved_aside is not None:
                moved_aside.append((target_root, kept))
            replaced = str(kept)
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
    return {"restored": True, "root_path": str(target_root), "replaced_kept_at": replaced}


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
    vault_parent = pointer.get("vault_parent") or None
    undo = state_dir / UNDO_DIR_NAME / utc_stamp()
    undo.mkdir(parents=True, exist_ok=True)
    moved: list[tuple[Path, Path]] = []
    #: The vault this restore replaced, if it replaced one: (where it was,
    #: where it is being kept). Filled in by ``_restore_vault`` *before* it
    #: copies anything over, so a failure after that point can put it back.
    vault_moved: list[tuple[Path, Path]] = []
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
        for root, kept in vault_moved:
            if not kept.exists():
                # The move never reached the point of removing the original, so
                # what is at *root* is still the user's own vault.
                continue
            if root.exists():
                shutil.rmtree(root, ignore_errors=True)
            root.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(kept), str(root))

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
            # Where the vault goes: the path the bundle's own database records,
            # unless the person staging the restore said otherwise -- which is
            # the case where that path names a machine they no longer have.
            if vault_parent:
                target_root = Path(vault_parent) / vault_dir_name(manifest["vault_id"])
            else:
                target_root = Path(row["root_path"])
            vault_result = _restore_vault(bundle, manifest, target_root,
                                          undo_dir=undo, moved_aside=vault_moved)

        # ``init_db`` first, and before anything writes a row. The migrations
        # bring an older bundle to today's schema, and every statement below
        # assumes today's tables and today's CHECK vocabularies -- a v2.2.0-era
        # bundle has no ``deliveries`` table at all and no
        # ``interrupted_reason`` column to write ``unknown`` into.
        init_db(str(db_path))

        conn = sqlite3.connect(str(db_path))
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA foreign_keys=ON;")
            if vault_parent and vault_result.get("restored"):
                # After ``init_db`` -- the row is written against today's schema
                # -- and inside the same envelope as everything else, so a
                # failure below still puts both halves of the pair back.
                # ``library.vault_row`` checks the directory *name* against the
                # vault id, so only the parent may differ from the bundle.
                conn.execute("UPDATE library_vault SET root_path=? WHERE singleton=1",
                             (vault_result["root_path"],))
                conn.commit()
            rewrites = _strip_process_state(conn)
            # After the migrations, because ``init_db`` may have created the FTS
            # table for the first time on an older bundle; the index then
            # answers for exactly the rows that were restored.
            _rebuild_fts(conn)
            integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
            fk_problems = conn.execute("PRAGMA foreign_key_check").fetchall()
        finally:
            conn.close()
        if integrity != "ok":
            raise BackupError("integrity_check_failed",
                              f"The restored database failed integrity_check: {integrity}")
        if fk_problems and not pointer.get("accept_fk_violations"):
            raise BackupError(
                "foreign_key_check_failed",
                f"The restored database has {len(fk_problems)} rows referencing a parent "
                "that is not there, and the restore was not staged to accept them.")
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
        # Both halves of the pair live in this one directory, so it is the undo
        # copy whenever either half was set aside.
        "undo_copy": str(undo) if (moved or vault_moved) else None,
        "undo_includes_vault": bool(vault_moved),
        "schema_relation": report["schema_relation"],
        "vault": vault_result,
        "vault_parent": str(vault_parent) if vault_parent else None,
        "rewrites": rewrites,
        "credentials_to_reenter": report["will_not_restore"]["credentials"],
        "fk_violations": report["fk_violations"],
        "fk_violations_total": report["fk_violations_total"],
        "fk_violations_rows": report["fk_violations_rows"],
        "fk_violations_message": report["fk_violations_message"],
        "acknowledged": False,
    }
    if not (moved or vault_moved):
        shutil.rmtree(undo, ignore_errors=True)
    record = _record(state_dir, outcome)
    clear_pending(state_dir)
    return record
