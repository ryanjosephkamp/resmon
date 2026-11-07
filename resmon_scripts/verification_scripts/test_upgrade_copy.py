"""The copy of the database kept before a schema upgrade changes it.

A schema step's savepoint protects a database from a step that stops half way,
not from one that finishes wrong. Before the first step of an upgrade,
``init_db`` keeps a copy of the database beside it, named from the database's
own file (``resmon-before-schema-<n>.db`` for ``resmon.db`` at schema ``n``), and
only the most recent one. These hold it to that, from databases resmon's own
code wrote at older schemas (the fixtures ``test_cumulative_upgrade.py`` walks):

* an upgrade leaves the copy, which opens at the old schema with every row;
* a later upgrade replaces it, and only the most recent copy is kept;
* a fresh install, an up-to-date start, and a database with no file make none;
* a disk without room, or a copy that cannot be written, makes none, says so in
  one line, and the upgrade runs anyway;
* an upgrade that stops and is finished by the next start keeps the copy from
  before it began, rather than a copy of the half-upgraded database;
* a restore makes none, erasing the papers removes it, and Settings › Backup's
  route says where it is.

Every database here is in the test's own temporary folder.
"""

from __future__ import annotations

import logging
import os
import re
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import database, library, upgrade_copy  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def _fixtures_below_the_schema() -> list[tuple[int, Path]]:
    """Every committed corpus fixture at a schema today's code upgrades from."""
    found = []
    for corpus in sorted(FIXTURES.glob("schema-*/corpus.sql")):
        version = int(re.fullmatch(r"schema-(\d+)", corpus.parent.name).group(1))
        if version < database.SCHEMA_VERSION:
            found.append((version, corpus))
    return found


BELOW = _fixtures_below_the_schema()
NEWEST_BELOW = max(BELOW)


def _app_tables(conn: sqlite3.Connection) -> list[str]:
    return sorted(
        name for (name,) in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL "
            "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'documents_fts%'"))


def _counts(conn: sqlite3.Connection) -> dict[str, int]:
    return {t: conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in _app_tables(conn)}


def _written(folder: Path, corpus: Path, name: str = "resmon.db") -> Path:
    """A file-backed database in WAL mode, as resmon runs it, holding *corpus*."""
    path = folder / name
    conn = sqlite3.connect(path)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(corpus.read_text(encoding="utf-8"))
        conn.commit()
    finally:
        conn.close()
    return path


def _read_only(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def _state(path: Path) -> tuple[dict[str, int], list[str]]:
    """Row counts per table and the whole logical dump, read without writing anything."""
    conn = _read_only(path)
    try:
        return _counts(conn), list(conn.iterdump())
    finally:
        conn.close()


def _schema(path: Path) -> int:
    conn = _read_only(path)
    try:
        return database.get_schema_version(conn)
    finally:
        conn.close()


def _unfinished(path: Path) -> str | None:
    """The copy the file beside the database names, while an upgrade has not finished."""
    marker = upgrade_copy.unfinished_marker(path)
    return marker.read_text(encoding="utf-8") if marker.exists() else None


def _copies_in(folder: Path) -> list[str]:
    return sorted(name for name in os.listdir(folder) if "-before-schema-" in name)


def _beside(path: Path) -> list[str]:
    """What is in the database's folder other than the database and its own sidecars."""
    return sorted(name for name in os.listdir(path.parent)
                  if name != path.name and not name.startswith(path.name + "-"))


# ---------------------------------------------------------------------------
# An upgrade keeps the database as it was
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("version,corpus", BELOW, ids=[f"schema-{v}" for v, _ in BELOW])
def test_an_upgrade_keeps_a_copy_of_the_database_as_it_was(version, corpus, tmp_path):
    path = _written(tmp_path, corpus)
    counts, dump = _state(path)
    assert _schema(path) == version

    database.init_db(str(path))

    assert _schema(path) == database.SCHEMA_VERSION
    copy = tmp_path / f"resmon-before-schema-{version}.db"
    assert _beside(path) == [copy.name], (
        "the copy is the one file an upgrade adds beside the database, with no sidecar")
    assert _schema(copy) == version
    copied_counts, copied_dump = _state(copy)
    assert copied_counts == counts and sum(counts.values()) > 0
    assert copied_dump == dump, "the copy is not the database as it was before the upgrade"
    conn = _read_only(copy)
    try:
        # One self-contained file: opening it later leaves no -wal or -shm beside it.
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        conn.close()
    assert _beside(path) == [copy.name]
    # The upgrade finished, so nothing says it is under way.
    assert _unfinished(path) is None
    assert upgrade_copy.latest(path)["path"] == str(copy)


def test_a_later_upgrade_replaces_the_copy(tmp_path, monkeypatch):
    """Only the most recent copy is kept: the next release's upgrade takes a new one and deletes the old."""
    oldest, corpus = min(BELOW)
    path = _written(tmp_path, corpus)
    database.init_db(str(path))
    first = tmp_path / f"resmon-before-schema-{oldest}.db"
    assert _copies_in(tmp_path) == [first.name]
    counts, dump = _state(path)

    # The next release: a schema one past today's, whose step has nothing to do here.
    monkeypatch.setattr(database, "SCHEMA_VERSION", database.SCHEMA_VERSION + 1)
    database.init_db(str(path))

    second = tmp_path / f"resmon-before-schema-{database.SCHEMA_VERSION - 1}.db"
    assert _copies_in(tmp_path) == [second.name], "an older copy outlived the new one"
    assert _schema(second) == database.SCHEMA_VERSION - 1
    assert _state(second) == (counts, dump)
    assert upgrade_copy.latest(path)["schema_version"] == database.SCHEMA_VERSION - 1


def test_the_copy_is_named_from_the_databases_own_file(tmp_path):
    """Two databases in one folder each keep their own copy, and one's upgrade leaves the other's alone."""
    version, corpus = NEWEST_BELOW
    corpus_db = _written(tmp_path, corpus, "corpus.db")
    other = _written(tmp_path, corpus, "other.db")
    database.init_db(str(other))
    database.init_db(str(corpus_db))
    assert _copies_in(tmp_path) == [f"corpus-before-schema-{version}.db", f"other-before-schema-{version}.db"]
    assert upgrade_copy.latest(corpus_db)["path"] == str(tmp_path / f"corpus-before-schema-{version}.db")


# ---------------------------------------------------------------------------
# Starts that make no copy
# ---------------------------------------------------------------------------


def test_a_fresh_install_and_an_up_to_date_start_make_no_copy(tmp_path):
    path = tmp_path / "resmon.db"
    database.init_db(str(path))
    assert _beside(path) == []
    database.init_db(str(path))
    assert _beside(path) == []
    assert upgrade_copy.latest(path) is None


def test_an_upgraded_databases_next_start_leaves_its_copy_alone(tmp_path):
    version, corpus = NEWEST_BELOW
    path = _written(tmp_path, corpus)
    database.init_db(str(path))
    copy = tmp_path / f"resmon-before-schema-{version}.db"
    before = copy.stat()
    database.init_db(str(path))
    after = copy.stat()
    assert _copies_in(tmp_path) == [copy.name]
    assert (after.st_ino, after.st_mtime_ns, after.st_size) == (before.st_ino, before.st_mtime_ns, before.st_size)


def test_a_database_with_no_file_makes_no_copy(tmp_path, monkeypatch):
    """``sqlite3``'s own ``:memory:``: upgraded, with nowhere beside it to put a copy and none put anywhere."""
    version, corpus = NEWEST_BELOW
    monkeypatch.chdir(tmp_path)
    conn = sqlite3.connect(":memory:")
    try:
        conn.executescript(corpus.read_text(encoding="utf-8"))
        conn.commit()
        assert database.get_schema_version(conn) == version
        database.init_db(conn=conn)
        assert database.get_schema_version(conn) == database.SCHEMA_VERSION
        assert upgrade_copy.database_file(conn) is None
    finally:
        conn.close()
    assert os.listdir(tmp_path) == []


def test_the_engines_memory_database_makes_no_copy():
    """The engine's ``:memory:`` is a temporary file; it is a throwaway, and keeps no copy of itself."""
    import resmon as resmon_mod

    version, corpus = NEWEST_BELOW
    saved = resmon_mod._db_path
    resmon_mod.close_db()
    resmon_mod._db_path = ":memory:"
    try:
        # The file the next ``_get_db`` opens, written first at the old schema.
        upcoming = Path(resmon_mod._ephemeral_db_path(resmon_mod._db_generation + 1))
        assert not upcoming.exists()
        _written(upcoming.parent, corpus, upcoming.name)
        conn = resmon_mod._get_db()
        assert os.path.realpath(conn.execute("PRAGMA database_list").fetchone()["file"]) == os.path.realpath(upcoming)
        assert database.get_schema_version(conn) == database.SCHEMA_VERSION
        assert _copies_in(upcoming.parent) == []
    finally:
        resmon_mod.close_db()
        resmon_mod._db_path = saved


def test_a_restore_makes_no_copy_and_keeps_the_last_one(tmp_path, monkeypatch):
    """The backup a restore puts in place is that database's copy from before its upgrade."""
    import resmon as resmon_mod

    version, corpus = NEWEST_BELOW
    path = _written(tmp_path, corpus)
    kept = tmp_path / "resmon-before-schema-3.db"
    kept.write_bytes(b"the copy from before an earlier update")
    handed: dict = {}

    def capture(state_dir, db_path, *, this_schema_version, init_db, daemon_lock_held):
        handed["init_db"] = init_db
        return None

    monkeypatch.setattr(resmon_mod, "_db_path", str(path))
    monkeypatch.setattr(resmon_mod.backup_module, "apply_pending_restore", capture)
    resmon_mod._apply_pending_restore_on_startup()
    handed["init_db"](str(path))            # what the restore runs on the database it put in place

    assert _schema(path) == database.SCHEMA_VERSION
    assert _copies_in(tmp_path) == [kept.name]
    assert kept.read_bytes() == b"the copy from before an earlier update"


# ---------------------------------------------------------------------------
# A copy that cannot be made: one line, and the upgrade goes on
# ---------------------------------------------------------------------------


def _upgrade_copy_lines(caplog) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == upgrade_copy.logger.name and r.levelno >= logging.WARNING]


def test_not_enough_free_space_skips_the_copy_and_the_upgrade_runs(tmp_path, monkeypatch, caplog):
    version, corpus = NEWEST_BELOW
    path = _written(tmp_path, corpus)
    needed = upgrade_copy._bytes_held(path) + library.FREE_SPACE_FLOOR
    assert needed > library.FREE_SPACE_FLOOR
    asked: list[Path] = []

    def short(folder):
        asked.append(Path(folder))
        return needed - 1

    monkeypatch.setattr(upgrade_copy, "free_bytes", short)
    with caplog.at_level(logging.INFO, logger=upgrade_copy.logger.name):
        database.init_db(str(path))

    assert asked == [tmp_path], "the free space read was not of the database's own folder"
    assert _schema(path) == database.SCHEMA_VERSION, "the upgrade did not run without its copy"
    assert _copies_in(tmp_path) == []
    lines = _upgrade_copy_lines(caplog)
    assert len(lines) == 1, [r.getMessage() for r in lines]
    said = lines[0].getMessage()
    assert said.startswith(f"Not keeping a copy of the database before its upgrade from schema {version}: ")
    assert "with 512 MB to spare. The upgrade goes on without one." in said
    assert _unfinished(path) is None


def test_exactly_enough_free_space_is_room(tmp_path, monkeypatch):
    version, corpus = NEWEST_BELOW
    path = _written(tmp_path, corpus)
    needed = upgrade_copy._bytes_held(path) + library.FREE_SPACE_FLOOR
    monkeypatch.setattr(upgrade_copy, "free_bytes", lambda folder: needed)
    database.init_db(str(path))
    assert _copies_in(tmp_path) == [f"resmon-before-schema-{version}.db"]


def test_a_copy_that_cannot_be_written_is_skipped_and_leaves_nothing(tmp_path, monkeypatch, caplog):
    """A failure while writing (here, the final rename) leaves no half-written file, and the upgrade runs."""
    version, corpus = NEWEST_BELOW
    path = _written(tmp_path, corpus)
    earlier = tmp_path / "resmon-before-schema-3.db"
    earlier.write_bytes(b"the copy from before an earlier update")

    def refuse(source, destination):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(upgrade_copy.os, "replace", refuse)
    with caplog.at_level(logging.INFO, logger=upgrade_copy.logger.name):
        database.init_db(str(path))

    assert _schema(path) == database.SCHEMA_VERSION
    # The earlier copy is deleted only once a new one is complete, and none was.
    assert _copies_in(tmp_path) == [earlier.name]
    lines = _upgrade_copy_lines(caplog)
    assert len(lines) == 1 and "No space left on device" in lines[0].getMessage(), [r.getMessage() for r in lines]


# ---------------------------------------------------------------------------
# An upgrade that stops, and the start that finishes it
# ---------------------------------------------------------------------------


def test_an_unfinished_upgrade_keeps_the_copy_from_before_it(tmp_path, monkeypatch):
    """A step that raises leaves the database part way; the next start finishes it and keeps the first copy."""
    oldest, corpus = min(BELOW)
    assert oldest < 22, "this case stops the walk at the schema-22 step"
    path = _written(tmp_path, corpus)
    counts, dump = _state(path)
    real_step = database._migrate_metadata_hash_index

    def broken(conn):
        raise RuntimeError("a step that stops part way")

    monkeypatch.setattr(database, "_migrate_metadata_hash_index", broken)
    with pytest.raises(RuntimeError, match="stops part way"):
        database.init_db(str(path))
    copy = tmp_path / f"resmon-before-schema-{oldest}.db"
    assert _schema(path) == 21, "the steps before the broken one were expected to have committed"
    assert _unfinished(path) == copy.name
    assert _copies_in(tmp_path) == [copy.name]
    first = copy.stat()

    # The same step raises again on the next start: still the one copy, untouched.
    with pytest.raises(RuntimeError, match="stops part way"):
        database.init_db(str(path))
    assert _copies_in(tmp_path) == [copy.name]

    monkeypatch.setattr(database, "_migrate_metadata_hash_index", real_step)
    database.init_db(str(path))

    assert _schema(path) == database.SCHEMA_VERSION
    assert _unfinished(path) is None
    assert _copies_in(tmp_path) == [copy.name], "a copy of the half-upgraded database replaced the first"
    now = copy.stat()
    assert (now.st_ino, now.st_mtime_ns) == (first.st_ino, first.st_mtime_ns)
    assert _state(copy) == (counts, dump)


def test_an_unfinished_upgrade_whose_copy_is_gone_takes_a_new_one(tmp_path, monkeypatch):
    oldest, corpus = min(BELOW)
    path = _written(tmp_path, corpus)
    real_step = database._migrate_metadata_hash_index

    def broken(conn):
        raise RuntimeError("stopped")

    monkeypatch.setattr(database, "_migrate_metadata_hash_index", broken)
    with pytest.raises(RuntimeError):
        database.init_db(str(path))
    (tmp_path / f"resmon-before-schema-{oldest}.db").unlink()
    monkeypatch.setattr(database, "_migrate_metadata_hash_index", real_step)
    database.init_db(str(path))
    assert _copies_in(tmp_path) == ["resmon-before-schema-21.db"]
    assert _unfinished(path) is None


# ---------------------------------------------------------------------------
# The engine: Settings › Backup's route, and the Danger zone
# ---------------------------------------------------------------------------


@pytest.fixture
def engine_on_a_file(tmp_path):
    """The engine on an upgraded database in this test's folder, and its copy."""
    import resmon as resmon_mod
    from fastapi.testclient import TestClient

    version, corpus = NEWEST_BELOW
    path = _written(tmp_path, corpus)
    saved = resmon_mod._db_path
    resmon_mod.close_db()
    resmon_mod._db_path = str(path)
    try:
        client = TestClient(resmon_mod.app)
        resmon_mod._get_db()
        copy = tmp_path / f"resmon-before-schema-{version}.db"
        assert copy.is_file()
        yield client, copy
    finally:
        resmon_mod.close_db()
        resmon_mod._db_path = saved


def test_backup_says_where_the_copy_is(engine_on_a_file):
    client, copy = engine_on_a_file
    body = client.get("/api/backup/last").json()
    held = body["pre_upgrade_copy"]
    assert held["path"] == str(copy)
    assert held["schema_version"] == NEWEST_BELOW[0]
    assert held["bytes"] == copy.stat().st_size
    assert held["written_at_utc"].endswith("+00:00")
    assert list(body)[-1] == "pre_upgrade_copy"


@pytest.mark.parametrize("route", ["/api/admin/erase-corpus", "/api/admin/erase-app-data",
                                   "/api/admin/factory-reset"])
def test_whatever_erases_the_papers_removes_the_copy(engine_on_a_file, route):
    client, copy = engine_on_a_file
    answered = client.post(route, json={"confirm": "CONFIRM"})
    assert answered.status_code == 200, answered.text
    assert not copy.exists() and _copies_in(copy.parent) == []
    assert client.get("/api/backup/last").json()["pre_upgrade_copy"] is None


@pytest.mark.parametrize("route", ["/api/admin/erase-executions", "/api/admin/erase-configs",
                                   "/api/admin/erase-execution-data", "/api/admin/reset-settings"])
def test_an_erasure_that_keeps_the_papers_keeps_the_copy(engine_on_a_file, route):
    client, copy = engine_on_a_file
    answered = client.post(route, json={"confirm": "CONFIRM"})
    assert answered.status_code == 200, answered.text
    assert copy.is_file()
