"""The copy of the database kept before a schema upgrade changes it.

Each schema step runs inside a savepoint, which protects a database from a step
that stops half way, not from one that finishes wrong. So before the first step
of an upgrade, ``database.init_db`` keeps a copy of the database beside it, named
from the database's own file: ``<name>-before-schema-<n>.db``, where ``<name>``
is the file's name without ``.db`` and ``n`` is the schema the database was at.
For resmon's ``resmon.db`` at schema 24 that is ``resmon-before-schema-24.db``.
Only the most recent copy is kept: an older one is deleted once the new one is
complete.

* The copy is taken with SQLite's backup API from the open connection, so it
  holds what the write-ahead log holds too, and is switched to rollback-journal
  mode, one file with no sidecars. It is written under a temporary name and
  renamed into place, so a file under the final name is a complete copy.
* It is skipped, with one logged line, when the database's disk does not have
  room for it with ``library.FREE_SPACE_FLOOR`` to spare, or when writing it
  fails. The upgrade goes on either way.
* While an upgrade runs, a small file beside the database
  (``<file>-upgrade-unfinished``) names the copy taken before it. An upgrade
  that does not finish (a step raised, or the process was stopped) leaves it
  there, and the next start carries on with that copy kept, rather than
  replacing it with a copy of the half-upgraded database. ``init_db`` removes
  the file once every step has run. It is a file and not a row so that an
  upgrade that fails leaves the database exactly as the failed step left it.

A database with no tables yet, one already at the schema this code ships, and
one with no file (``:memory:``) get no copy.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from . import library
from .library_folder import _words as size_words

logger = logging.getLogger(__name__)

COPY_INFIX = "-before-schema-"
#: The name a copy is written under until it is complete.
PARTIAL_SUFFIX = ".partial"
#: Beside the database while an upgrade it began has not finished, holding
#: the file name of the copy taken before it.
UNFINISHED_SUFFIX = "-upgrade-unfinished"
#: The files SQLite may leave beside a database file.
_SIDECARS = ("-journal", "-wal", "-shm")


def database_file(conn: sqlite3.Connection) -> Path | None:
    """The file *conn*'s main database lives in, or ``None`` for one with no file."""
    for row in conn.execute("PRAGMA database_list"):
        if row[1] == "main" and row[2]:
            return Path(row[2])
    return None


def _name(db_file: Path) -> str:
    name = db_file.name
    return name[:-3] if name.endswith(".db") else name


def copy_path(db_file: Path, version: int) -> Path:
    """Where the copy of *db_file* at schema *version* goes: beside it."""
    return db_file.with_name(f"{_name(db_file)}{COPY_INFIX}{int(version)}.db")


def copies(db_file: Path) -> list[tuple[int, Path]]:
    """Every complete copy beside *db_file*: its schema and its path."""
    pattern = re.compile(re.escape(_name(db_file) + COPY_INFIX) + r"(\d+)\.db\Z")
    try:
        names = os.listdir(db_file.parent)
    except OSError:
        return []
    found = []
    for name in sorted(names):
        matched = pattern.match(name)
        if matched:
            found.append((int(matched.group(1)), db_file.parent / name))
    return found


def _partials(db_file: Path) -> list[Path]:
    pattern = re.compile(re.escape(_name(db_file) + COPY_INFIX) + r"\d+\.db" + re.escape(PARTIAL_SUFFIX) + r"\Z")
    try:
        return [db_file.parent / name for name in os.listdir(db_file.parent) if pattern.match(name)]
    except OSError:
        return []


def free_bytes(folder: Path) -> int:
    """The bytes free to this user on the disk that holds *folder*."""
    return shutil.disk_usage(folder).free


def _bytes_held(db_file: Path) -> int:
    """What a copy of *db_file* can take at most: the file and its write-ahead log."""
    total = 0
    for suffix in ("", "-wal"):
        try:
            total += os.path.getsize(f"{db_file}{suffix}")
        except OSError:
            pass
    return total


def _remove(path: Path) -> bool:
    """Delete *path* and any sidecar SQLite left beside it. Whether *path* was there and is gone.

    A file that cannot be deleted is logged and left, rather than stopping the
    upgrade or the erasure that asked.
    """
    try:
        for sidecar in _SIDECARS:
            Path(f"{path}{sidecar}").unlink(missing_ok=True)
        path.unlink()
    except FileNotFoundError:
        return False
    except OSError as exc:
        logger.warning("Could not delete %s (%s); it is still there.", path, exc)
        return False
    return True


def unfinished_marker(db_file: Path) -> Path:
    """The file that says an upgrade of *db_file* began and has not finished."""
    return Path(f"{db_file}{UNFINISHED_SUFFIX}")


def _unfinished(db_file: Path) -> str | None:
    try:
        named = unfinished_marker(db_file).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return named or None


def _take(conn: sqlite3.Connection, db_file: Path, version: int, target: int) -> Path | None:
    """Write the copy of *conn*'s database at schema *version*. The copy, or ``None`` with the reason logged."""
    folder = db_file.parent
    held = _bytes_held(db_file)
    try:
        free = free_bytes(folder)
    except OSError as exc:
        logger.warning(
            "Not keeping a copy of the database before its upgrade from schema %d: the free space in %s "
            "could not be read (%s). The upgrade goes on without one.", version, folder, exc)
        return None
    if free < held + library.FREE_SPACE_FLOOR:
        logger.warning(
            "Not keeping a copy of the database before its upgrade from schema %d: %s has %s free, and the "
            "copy needs %s with %s to spare. The upgrade goes on without one.",
            version, folder, size_words(free), size_words(held), size_words(library.FREE_SPACE_FLOOR))
        return None
    final = copy_path(db_file, version)
    partial = final.with_name(final.name + PARTIAL_SUFFIX)
    try:
        _remove(partial)
        written = sqlite3.connect(str(partial))
        try:
            conn.backup(written)
            # The pages carry the live database's WAL setting; a copy that is
            # one self-contained file needs the rollback journal instead.
            written.execute("PRAGMA journal_mode=DELETE")
        finally:
            written.close()
        os.replace(partial, final)
    except (OSError, sqlite3.Error) as exc:
        _remove(partial)
        logger.warning(
            "Not keeping a copy of the database before its upgrade from schema %d: writing %s failed (%s). "
            "The upgrade goes on without one.", version, final, exc)
        return None
    logger.info("Kept a copy of the database before its upgrade from schema %d to %d: %s",
                version, target, final)
    return final


def before_upgrade(conn: sqlite3.Connection, *, stored: int | None, target: int, keep: bool = True) -> bool:
    """Keep the copy an upgrade from schema *stored* to *target* needs, before its first step.

    *stored* is ``None`` for a database with no tables. With *keep* false, no
    copy is made. Returns whether the unfinished-upgrade file is there, for
    ``after_upgrade`` to remove once every step has run.
    """
    db_file = database_file(conn)
    if db_file is None:
        return False
    unfinished = _unfinished(db_file)
    if stored is None or stored >= target or not keep:
        return unfinished is not None
    kept = {path.name: path for _, path in copies(db_file)}
    if unfinished in kept:
        logger.info("Finishing the upgrade an earlier start began; keeping %s from before it.",
                    kept[unfinished])
        return True
    final = _take(conn, db_file, stored, target)
    if final is None:
        return unfinished is not None
    try:
        unfinished_marker(db_file).write_text(final.name, encoding="utf-8")
        marked = True
    except OSError as exc:
        # The copy is kept; an upgrade that then stops would be copied again
        # at the next start, as if this file had never been written.
        logger.warning("Could not write %s (%s).", unfinished_marker(db_file), exc)
        marked = unfinished is not None
    for _, older in copies(db_file):
        if older != final:
            _remove(older)
    for partial in _partials(db_file):
        _remove(partial)
    return marked


def after_upgrade(conn: sqlite3.Connection, marked: bool) -> None:
    """Every step has run and been committed: the upgrade is no longer unfinished."""
    db_file = database_file(conn) if marked else None
    if db_file is not None:
        _remove(unfinished_marker(db_file))


def latest(db_file: Path | None) -> dict | None:
    """The most recent copy beside *db_file*: its path, schema, size, and when it was written."""
    if db_file is None:
        return None
    found = []
    for version, path in copies(db_file):
        try:
            stat = path.stat()
        except OSError:
            continue
        found.append((stat.st_mtime, version, path, stat.st_size))
    if not found:
        return None
    mtime, version, path, size = max(found)
    return {
        "path": str(path),
        "schema_version": version,
        "written_at_utc": datetime.fromtimestamp(mtime, timezone.utc).isoformat(),
        "bytes": size,
    }


def remove_all(db_file: Path | None) -> int:
    """Delete this database's copies, partial writes, sidecars, and upgrade marker.

    Unlike upgrade housekeeping, an erasure must stop if any retained data
    cannot be removed. Listing and deletion errors reach the caller; an
    unreadable folder is not evidence that there were no copies in it.
    Returns how many complete copies were found.
    """
    if db_file is None:
        return 0
    pattern = re.compile(re.escape(_name(db_file) + COPY_INFIX)
                         + r"\d+\.db(?P<partial>\.partial)?(?P<sidecar>-journal|-wal|-shm)?\Z")
    removed = 0
    for name in sorted(os.listdir(db_file.parent)):
        matched = pattern.fullmatch(name)
        if matched:
            (db_file.parent / name).unlink(missing_ok=True)
            if not matched.group("partial") and not matched.group("sidecar"):
                removed += 1
    unfinished_marker(db_file).unlink(missing_ok=True)
    return removed
