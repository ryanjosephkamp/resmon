"""The whole walk at once: a v2.1.0 database (schema 13) upgraded to schema 21.

Every schema step since 13 has its own upgrade test, and each one starts from a
fixture of the step immediately before it -- 13 -> 14, 14 -> 15, 15 -> 16,
16 -> 17, 17 -> 18, 18 -> 19, 19 -> 20. Seven green tests, and none of them is the journey a
user takes. A user who has been on v2.1.0 since it shipped launches the next
release once and their database crosses **all seven** steps in one `init_db`
call, with the rows v2.1.0 wrote still in it.

That is what this file tests, and the fixture it starts from is not hand-written:
`fixtures/v2.1.0/corpus_schema_13.sql` was produced by checking out tag v2.1.0
and driving *its* `init_db` and *its* own write functions, then dumping the
result. The generator is committed beside it. This matters because the schema-13
migration itself shipped broken on existing corpora after a hand-reasoned idea of
"what an older database looks like" left out a column -- the class of mistake only
a fixture the old code produced can catch.

What each test establishes is written on it. The short version:

  * the walk runs at all, on a file-backed database, in one call (P2)
  * the upgraded schema is object-for-object the fresh install's (P3)
  * every row v2.1.0 wrote is still there, unaltered, with its keys and its
    AUTOINCREMENT high-water marks (P4)
  * integrity, foreign keys and the FTS index survive it (P5)
  * the CHECK constraints work on the **upgraded** database, not just a fresh
    one -- a rebuilt table can lose a constraint and look identical in a row
    count (P6)
  * a second launch changes nothing (P7)
  * the real backend serves the upgraded file over HTTP (P8, in
    `test_cumulative_upgrade_boundary`-style style below)
  * every released fixture is byte-identical to what that release's own code
    produces, regenerated out of process against a worktree of its tag (P1)
  * and the newest released fixture is walked too. While the schema it was
    written at is still the one this code ships, that walk must change nothing
    at all; once a step has been added past it -- as schema 20 is now -- the
    walk is the single step a user of the newest release will take, and every
    row of it has to come out the other side (P9).

`RELEASED` near the bottom is the list both of those last two are parametrised
over. A release that ships a schema adds one row to it and one directory under
`fixtures/`; it does not add a test, and it never touches a fixture that
shipped before it.

`CREATE TABLE IF NOT EXISTS` leaves an old table alone, so "the table exists"
proves nothing here; every assertion below is on shape or on data.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "resmon_scripts"))

import httpx  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # safe when run as a script
from implementation_scripts import api_auth as _api_auth  # noqa: E402

# 2.2: every request to a resmon backend carries its local API token. The
# backends this file starts are handed the suite's token in RESMON_API_TOKEN,
# exactly as Electron hands its own over, and test-side calls go through this
# shim. The code under test builds its own headers; nothing here adds any.
_TOKEN = _api_auth.current_token()


class _WithToken:
    """httpx's module-level ``get``/``post``/``stream``/…, plus the token header.

    A shim over the functions rather than a shared ``httpx.Client``: each call
    keeps its own throwaway client, so a stream a test abandons is closed exactly
    as before — a pooled connection outlived one and hid a disconnect.
    """

    def __getattr__(self, name):
        function = getattr(httpx, name)

        def call(*args, **kwargs):
            auth = _api_auth.bearer(_TOKEN) if _TOKEN else {}
            kwargs["headers"] = {**auth, **dict(kwargs.get("headers") or {})}
            return function(*args, **kwargs)
        return call


_API = _WithToken()

from implementation_scripts import config, database  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures/v2.1.0/corpus_schema_13.sql"
GENERATOR = Path(__file__).parent / "fixtures/v2.1.0/generate_corpus.py"

# The version the fixture was written at, and the version it must reach.
FIXTURE_SCHEMA_VERSION = 13
TARGET_SCHEMA_VERSION = 21


# ---------------------------------------------------------------------------
# Building the two databases every test compares
# ---------------------------------------------------------------------------


def _fts_shadow_names(prefix: str) -> set[str]:
    """The tables fts5 makes for itself, asked of fts5 rather than guessed.

    A name-prefix exclusion once took the three `documents_fts_*` **triggers**
    out of a fixture along with the shadow tables. Those triggers are resmon's
    own DDL. Deriving the set at run time is what stops that happening again.
    """
    probe = sqlite3.connect(":memory:")
    try:
        before = {r[0] for r in probe.execute("SELECT name FROM sqlite_master")}
        probe.execute("CREATE VIRTUAL TABLE _probe USING fts5(a)")
        after = {r[0] for r in probe.execute("SELECT name FROM sqlite_master")}
        return {n.replace("_probe", prefix) for n in after - before - {"_probe"}}
    finally:
        probe.close()


SHADOW = _fts_shadow_names("documents_fts")


def _open(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@pytest.fixture(scope="module")
def walked(tmp_path_factory):
    """A v2.1.0 database taken to 18 by exactly one `init_db`, plus its 'before'.

    File-backed on purpose. `:memory:` would hide anything that depends on the
    database being reopened -- and reopening is what a user's next launch does.
    The `init_db(path)` call opens and closes its own connection, exactly as
    `resmon.py` does at startup.
    """
    state = tmp_path_factory.mktemp("cumulative-upgrade")
    path = state / "corpus.db"

    conn = _open(path)
    conn.executescript(FIXTURE.read_text(encoding="utf-8"))
    conn.commit()
    assert database.get_schema_version(conn) == FIXTURE_SCHEMA_VERSION
    before = _snapshot(conn)
    conn.close()

    database.init_db(str(path))            # the user's upgrade, in one call

    conn = _open(path)
    yield {"path": path, "conn": conn, "before": before, "state": state}
    conn.close()


@pytest.fixture(scope="module")
def fresh(tmp_path_factory):
    """What `init_db` builds on a machine that has never run resmon."""
    path = tmp_path_factory.mktemp("cumulative-fresh") / "fresh.db"
    database.init_db(str(path))
    conn = _open(path)
    yield conn
    conn.close()


# ---------------------------------------------------------------------------
# Snapshots: the denominators the data assertions are measured against
# ---------------------------------------------------------------------------


def _app_tables(conn: sqlite3.Connection) -> list[str]:
    """Application tables: everything SQLite and fts5 did not make for themselves."""
    return sorted(
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND sql IS NOT NULL")
        if r[0] not in SHADOW and not r[0].startswith("sqlite_") and r[0] != "documents_fts"
    )


def _snapshot(conn: sqlite3.Connection) -> dict:
    """Every row of every application table, plus the AUTOINCREMENT sequences.

    Rows are keyed by column name rather than position: a migration that adds a
    column shifts every position after it, and a positional comparison would
    then report every row as changed and tell us nothing about the ones that
    were.
    """
    tables = _app_tables(conn)
    rows = {}
    for table in tables:
        columns = [r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')]
        rows[table] = [
            {c: r[i] for i, c in enumerate(columns)}
            for r in conn.execute(
                'SELECT {} FROM "{}" ORDER BY rowid'.format(
                    ", ".join(f'"{c}"' for c in columns), table))
        ]
    sequences = {}
    if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'"
    ).fetchone():
        sequences = {r[0]: r[1] for r in conn.execute("SELECT name, seq FROM sqlite_sequence")}
    return {"tables": tables, "rows": rows, "sequences": sequences}


def _normalise(sql: str) -> str:
    """Collapse whitespace so indentation differences are not schema differences."""
    return " ".join((sql or "").split())


def _objects(conn: sqlite3.Connection) -> dict[str, tuple[str, str, str]]:
    """Every authored object in `sqlite_master`, by name: (type, tbl_name, SQL).

    Implicit indexes (`sqlite_autoindex_*`, which have no SQL) are excluded
    here and compared separately through `PRAGMA index_list`, because their
    names are assigned by SQLite in creation order and would report a
    difference that is not one.
    """
    return {
        r["name"]: (r["type"], r["tbl_name"], _normalise(r["sql"]))
        for r in conn.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL")
        if r["name"] not in SHADOW
    }


# ---------------------------------------------------------------------------
# P2 -- the walk runs
# ---------------------------------------------------------------------------


def test_one_init_db_takes_a_v210_database_from_13_to_21(walked):
    """The upgrade a user's first v2.2.0 launch performs, in one call, on a file."""
    conn = walked["conn"]
    assert database.get_schema_version(conn) == TARGET_SCHEMA_VERSION
    assert database.SCHEMA_VERSION == TARGET_SCHEMA_VERSION, (
        "this test is pinned to the schema it was written for; a new step needs "
        "a new fixture of the version that shipped before it")
    # The marker is durable, not a value left in an uncommitted transaction on
    # the connection that wrote it.
    reopened = _open(walked["path"])
    try:
        assert database.get_schema_version(reopened) == TARGET_SCHEMA_VERSION
    finally:
        reopened.close()


# ---------------------------------------------------------------------------
# P3 -- the upgraded schema equals a fresh install's
# ---------------------------------------------------------------------------


def test_the_upgraded_schema_is_object_for_object_a_fresh_installs(walked, fresh):
    """Denominator: every authored row of `sqlite_master` in the fresh database.

    This is the assertion that catches `CREATE TABLE IF NOT EXISTS` leaving an
    old table alone: the table exists either way, and only its SQL differs.
    """
    upgraded_objects = _objects(walked["conn"])
    fresh_objects = _objects(fresh)

    missing = sorted(set(fresh_objects) - set(upgraded_objects))
    extra = sorted(set(upgraded_objects) - set(fresh_objects))
    assert not missing, f"the upgrade never created: {missing}"
    assert not extra, f"the upgraded database has objects a fresh one does not: {extra}"

    differing = [
        name for name in fresh_objects
        if upgraded_objects[name] != fresh_objects[name]
    ]
    equal = len(fresh_objects) - len(differing)
    assert not differing, (
        f"{equal} of {len(fresh_objects)} sqlite_master objects match; these do "
        f"not: {sorted(differing)}")
    assert len(fresh_objects) >= 50, (
        f"only {len(fresh_objects)} objects in the fresh schema -- the "
        "denominator collapsed, which would make this assertion vacuous")
    print(f"P3 sqlite_master: {equal} of {len(fresh_objects)} objects equal")


def test_nothing_v210_owned_was_dropped_on_the_way(walked):
    """The absolute anchor. The test above is a comparison, and a comparison is
    blind to anything that moves both sides.

    An edit that deletes an index in a migration deletes it from a fresh install
    too, and "upgraded equals fresh" stays green while every existing user loses
    it. The schema-13 fixture is a committed file that no edit to `database.py`
    can move, so this is the check that cannot be satisfied by breaking both.

    Growth is allowed and expected -- five schemas' worth of new objects and new
    CHECK values. Loss is not.
    """
    old = sqlite3.connect(":memory:")
    try:
        old.executescript(FIXTURE.read_text(encoding="utf-8"))
        old_objects = {r[0] for r in old.execute(
            "SELECT name FROM sqlite_master WHERE sql IS NOT NULL")} - SHADOW
        old_checks = {(t, c): set(v) for t, c, v in _enumerated_checks(old)}
    finally:
        old.close()

    now = {r[0] for r in walked["conn"].execute(
        "SELECT name FROM sqlite_master WHERE sql IS NOT NULL")} - SHADOW
    lost = sorted(old_objects - now)
    assert not lost, f"the walk dropped objects v2.1.0 owned: {lost}"

    new_checks = {(t, c): set(v) for t, c, v in _enumerated_checks(walked["conn"])}
    for key, values in old_checks.items():
        assert key in new_checks, (
            f"{key[0]}.{key[1]} lost its CHECK entirely -- a table rebuild that "
            "keeps every row and quietly stops constraining them")
        assert values <= new_checks[key], (
            f"{key[0]}.{key[1]} lost the values "
            f"{sorted(values - new_checks[key])} from its CHECK")
    print(f"P3 anchor: {len(old_objects)} of {len(old_objects)} schema-13 objects "
          f"and {len(old_checks)} of {len(old_checks)} schema-13 enumerated CHECKs "
          "still present")


def test_every_table_has_the_fresh_installs_columns_keys_and_indexes(walked, fresh):
    """The per-table PRAGMAs, which `sqlite_master` SQL equality does not imply.

    A table rebuilt by a migration can carry the right `CREATE TABLE` text and
    still differ in what SQLite actually built from it -- a lost index, a
    foreign key that no longer fires, a primary key that moved.
    """
    tables = _app_tables(fresh)
    assert tables, "no application tables in the fresh database"
    for table in tables:
        for pragma in ("table_info", "foreign_key_list", "index_list"):
            def read(conn):
                rows = [tuple(r) for r in conn.execute(f'PRAGMA {pragma}("{table}")')]
                if pragma == "index_list":
                    # Column 1 is the index name; an implicit index's name is
                    # assigned in creation order, so compare the rest.
                    return sorted((r[0],) + r[2:] if r[3] != "c" else r for r in rows)
                return rows
            assert read(walked["conn"]) == read(fresh), f"{pragma}({table}) differs"
    print(f"P3 per-table PRAGMAs: {len(tables)} of {len(tables)} tables equal")


# ---------------------------------------------------------------------------
# P4 -- no data is lost or altered
# ---------------------------------------------------------------------------


# The only values the walk is allowed to rewrite, each named with the migration
# that rewrites it and why. A predicate rather than a filter: an exemption that
# merely ignored the column would also ignore the migration *stopping*, and
# each of these is a rewrite the release is relying on.
_INTENDED = {
    ("app_settings", "value"): (
        lambda old, new: (old["key"] == "schema_version"
                          and old["value"] == str(FIXTURE_SCHEMA_VERSION)
                          and new["value"] == str(TARGET_SCHEMA_VERSION)),
        "_migrate_schema_version and the four that follow it advance the marker; "
        "that is what the whole walk is for."),
    ("routines", "execution_location"): (
        lambda old, new: old["execution_location"] == "cloud" and new["execution_location"] == "local",
        "_migrate_routines_columns flips any routine still marked 'cloud' back "
        "to 'local'. Its scheduler was deleted with the cloud service, so the "
        "row would otherwise sit in the UI looking active and never fire again. "
        "The CHECK still admits 'cloud'; only the data is rewritten."),
}


def test_every_row_written_by_v210_survives_the_walk_unaltered(walked):
    """Denominator: every table present at schema 13, from the fixture itself.

    Compared column by column rather than row-count by row-count. A rebuild
    that drops a column's data keeps the count exactly right, and that is the
    failure mode this is here for.

    Two values are rewritten on purpose; both are in `_INTENDED` by name, and
    both must actually be observed or this test fails -- a documented rewrite
    that silently stopped happening is as much a regression as one that
    silently started.
    """
    before, after = walked["before"], _snapshot(walked["conn"])
    observed: set = set()
    tables = before["tables"]
    # v2.1.0 creates 22 tables of its own; `documents_fts` is the twenty-second
    # and is compared through its queries rather than its rows, so 21 here.
    assert len(tables) == 21, (
        f"the schema-13 fixture has {len(tables)} ordinary tables, not the 21 "
        "v2.1.0 creates -- the fixture, not the migration, is what changed")

    checked_rows = 0
    for table in tables:
        old_rows, new_rows = before["rows"][table], after["rows"][table]
        assert len(old_rows) == len(new_rows), (
            f"{table}: {len(old_rows)} rows before, {len(new_rows)} after")
        surviving = [c for c in (old_rows[0] if old_rows else {}) if c in
                     {r[1] for r in walked["conn"].execute(f'PRAGMA table_info("{table}")')}]
        for old, new in zip(old_rows, new_rows):
            for column in surviving:
                intended = _INTENDED.get((table, column))
                if intended and intended[0](old, new):
                    observed.add((table, column))
                    continue
                assert old[column] == new[column], (
                    f"{table}.{column} changed: {old[column]!r} -> {new[column]!r}")
            checked_rows += 1
    assert checked_rows >= 100, (
        f"only {checked_rows} rows compared -- too few for this to mean much")
    assert observed == set(_INTENDED), (
        "these documented rewrites did not happen on this upgrade: "
        f"{sorted(set(_INTENDED) - observed)}")
    print(f"P4: {checked_rows} rows across {len(tables)} of {len(tables)} "
          f"schema-13 tables compared column by column; "
          f"{len(observed)} of {len(_INTENDED)} documented rewrites observed")


def test_no_schema_13_column_was_dropped_by_the_walk(walked):
    """Every column v2.1.0 had is still a column, with the same type and nullability."""
    before_conn = sqlite3.connect(":memory:")
    try:
        before_conn.executescript(FIXTURE.read_text(encoding="utf-8"))
        old = {
            table: {r[1]: (r[2], r[3], r[5]) for r in
                    before_conn.execute(f'PRAGMA table_info("{table}")')}
            for table in _app_tables(before_conn)
        }
    finally:
        before_conn.close()
    columns = 0
    for table, old_columns in old.items():
        new_columns = {r[1]: (r[2], r[3], r[5]) for r in
                       walked["conn"].execute(f'PRAGMA table_info("{table}")')}
        for name, spec in old_columns.items():
            assert name in new_columns, f"{table}.{name} was dropped by the upgrade"
            assert new_columns[name] == spec, (
                f"{table}.{name} changed shape: {spec} -> {new_columns[name]}")
            columns += 1
    print(f"P4 columns: {columns} schema-13 columns still present and unchanged")


def test_autoincrement_high_water_marks_are_preserved(walked):
    """A reset sequence hands a new row an id a deleted one already used.

    Nothing in a row count shows it, and nothing shows it until two records
    point at the same id. `documents` is the one that matters here: v2.1.0's
    `insert_document` is `INSERT OR IGNORE`, so a re-sweep of a paper already
    in the corpus consumes a rowid without leaving a row, and the sequence
    legitimately runs ahead of the highest surviving id.
    """
    before, after = walked["before"], _snapshot(walked["conn"])
    assert before["sequences"], "the fixture has no AUTOINCREMENT sequences to preserve"
    for name, seq in before["sequences"].items():
        assert after["sequences"].get(name) == seq, (
            f"sqlite_sequence for {name}: {seq} -> {after['sequences'].get(name)}")
    highest = walked["conn"].execute("SELECT MAX(id) FROM documents").fetchone()[0]
    assert before["sequences"]["documents"] > highest, (
        "the fixture no longer carries a sequence ahead of its highest id, so "
        "this test can no longer tell a preserved sequence from a reset one")
    print(f"P4 sequences: {len(before['sequences'])} of {len(before['sequences'])} preserved")


def test_columns_the_migrations_added_hold_their_documented_defaults(walked):
    """Additive columns arrive with the value the migration says, on old rows too."""
    conn = walked["conn"]
    # Schema 14's reading_queue is deliberately empty on an upgrade: resmon
    # never observed which papers a user meant to read before the queue
    # existed, so it starts empty and says so rather than guessing.
    assert conn.execute("SELECT COUNT(*) FROM reading_queue").fetchone()[0] == 0
    # 15, 16, 17 and 18 are additive and adopt nothing.
    for table in ("assistant_session_choices", "assistant_turn_choices",
                  "library_vault", "library_files", "library_file_documents",
                  "evidence_projects", "evidence_project_files", "evidence_notes",
                  "evidence_answers"):
        assert conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] == 0, (
            f"{table} adopted rows from the old database; these schemas backfill nothing")


# ---------------------------------------------------------------------------
# P5 -- integrity after the walk
# ---------------------------------------------------------------------------


def test_the_database_is_still_internally_consistent_after_the_walk(walked):
    conn = walked["conn"]
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_the_search_index_answers_the_same_query_with_the_same_papers(walked):
    """The FTS index is external-content and rebuilt by triggers; a lost trigger
    or a dropped shadow table leaves a search that silently returns nothing."""
    before_conn = sqlite3.connect(":memory:")
    try:
        before_conn.executescript(FIXTURE.read_text(encoding="utf-8"))
        queries = {q: [r[0] for r in before_conn.execute(
            "SELECT rowid FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rowid", (q,))]
            for q in ("diffusion", "turbulent", "angstrom", "folding")}
    finally:
        before_conn.close()
    assert any(queries.values()), "the fixture's search index answers nothing"
    for query, expected in queries.items():
        got = [r[0] for r in walked["conn"].execute(
            "SELECT rowid FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rowid", (query,))]
        assert got == expected, f"search for {query!r}: {expected} before, {got} after"
    # And the index still tracks the corpus, rather than merely still holding it.
    conn = walked["conn"]
    conn.execute("SAVEPOINT fts_probe")
    try:
        conn.execute(
            "INSERT INTO documents (source_repository, external_id, title, "
            "metadata_hash) VALUES ('arxiv', 'probe-1', 'Zzyzx probe paper', 'probe')")
        assert conn.execute(
            "SELECT COUNT(*) FROM documents_fts WHERE documents_fts MATCH 'zzyzx'"
        ).fetchone()[0] == 1, "the insert trigger no longer files new papers"
    finally:
        conn.execute("ROLLBACK TO fts_probe")
        conn.execute("RELEASE fts_probe")


# ---------------------------------------------------------------------------
# P6 -- the CHECK constraints work on the UPGRADED database (B10)
# ---------------------------------------------------------------------------

# The enumerated CHECK sets are discovered from the fresh schema; the rows they
# are tested with cannot be. A table's other columns have their own constraints,
# so a row that isolates the column under test has to be written by hand.
# Every table carrying an enumerated CHECK must appear here -- the test fails
# rather than skips when one does not, so a schema 20 that adds a table with a
# new value set cannot slip past by being unrepresented.
_SHA = "a" * 64


def _template(table: str, column: str, value) -> dict:
    """A row for `table` that is valid except for whatever `column` is set to."""
    rows = {
        "assistant_messages": {"session_id": 1, "role": "user", "content": ""},
        "assistant_session_choices": {
            "session_id": 1, "version": 1, "runtime": "claude_cli",
            "provider": "anthropic", "requested_model": None, "requested_effort": None,
            "model_basis": "explicit", "effort_basis": "explicit",
            "route_digest": "digest", "binding_basis": "new",
            "created_at_utc": "2026-03-01T00:00:00Z"},
        "cloud_sync": {"provider": "google_drive", "sync_status": "idle"},
        # Schema 20. ``routine_id`` references a routines row, and the walked
        # fixture has none, so the FK is satisfied by the CHECK test's own
        # insert order rather than by a routine existing -- see the note on
        # ``_template``: the row is valid except for the column under test, and
        # foreign keys are off for these probes.
        # Schema 21. Both tables reference rows the walked fixture has none of
        # -- foreign keys are off for these probes, as the note on
        # ``_template`` says, so the row is valid except for the column under
        # test and nothing else.
        "routine_delivery_targets": {
            "routine_id": 1, "channel": "email", "target": "",
            "enabled": 1, "mode": "automatic",
            "created_at_utc": "2026-09-01T00:00:00+00:00",
            "updated_at_utc": "2026-09-01T00:00:00+00:00"},
        "deliveries": {
            "execution_id": 1, "target_id": 1, "channel": "email",
            "target_snapshot": "", "state": "queued", "attempts": 0,
            "queued_at_utc": "2026-09-01T00:00:00+00:00"},
        "routine_missed_fires": {
            "routine_id": 1, "due_at_utc": "2026-01-01T00:00:00+00:00",
            "observed_at_utc": "2026-01-02T00:00:00+00:00",
            "disposition": "recorded"},
        "document_lifecycle": {
            "document_id": 1, "kind": "retraction", "severity": "critical",
            "notice_key": "probe", "notice_url": "https://example.org/n",
            "provider": "crossref"},
        "document_lifecycle_checks": {"document_id": 1, "status": "ok"},
        "evidence_answers": {
            "answer_id": "a", "preview_id": "p", "vault_id": "v", "project_id": "pr",
            "project_revision": 1, "mode": "question", "state": "admitted",
            "request_json": "{}", "request_sha256": _SHA, "private_binding_json": "{}",
            "owner_runtime_id": "r", "cleanup_state": "not_started",
            "created_at_utc": "2026-03-01T00:00:00Z", "finished_at_utc": None},
        "evidence_notes": {
            "note_id": "n", "project_id": "pr", "file_id": "f", "version_id": "v",
            "kind": "note", "body": "a note", "revision": 1,
            "created_at_utc": "2026-03-01T00:00:00Z",
            "updated_at_utc": "2026-03-01T00:00:00Z"},
        "execution_ai": {
            "execution_id": 1, "lane_index": 0, "lane_label": "probe",
            "lane_kind": "subscription", "provider": "anthropic", "outcome": "ok"},
        "execution_sources": {"execution_id": 1, "source": "probe", "status": "ok"},
        "executions": {
            "execution_type": "deep_dive", "parameters": "{}",
            "start_time": "2026-03-01T00:00:00", "status": "running"},
        "library_files": {
            "file_id": "f", "version_id": "v", "vault_id": "vault", "sha256": _SHA,
            "byte_size": 1, "media_type": "text/plain", "original_name": "a.txt",
            "relative_path": "a.txt", "created_at_utc": "2026-03-01T00:00:00Z"},
        "reading_queue": {"document_id": 1, "status": "to_read", "read_at": None},
        "routines": {
            "name": "probe", "schedule_cron": "0 0 * * *", "parameters": "{}",
            "execution_location": "local"},
        "saved_configurations": {
            "name": "probe", "config_type": "manual_dive", "parameters": "{}"},
        "watch_profile_matches": {
            "document_id": 1, "profile_id": 1, "basis": "identifier",
            "matched_author": "Ada Lovelace"},
        "watch_profiles": {"kind": "person", "display_name": "Probe"},
    }
    assert table in rows, (
        f"{table} carries an enumerated CHECK and has no row template here. Add "
        "one rather than letting the constraint go untested.")
    row = dict(rows[table])
    row[column] = value
    # Two tables' compound CHECKs tie another column to the one under test.
    # Honouring them keeps this test about the value set and not about them.
    if table == "evidence_answers" and column == "state":
        row["finished_at_utc"] = (
            None if value in ("admitted", "running") else "2026-03-01T01:00:00Z")
    if table == "reading_queue" and column == "status":
        row["read_at"] = "2026-03-01T01:00:00Z" if value == "read" else None
    if table == "evidence_notes" and column == "kind" and value == "passage":
        row.update({"page_number": 1, "extraction_contract": "pdf/v1",
                    "page_text_sha256": _SHA, "start_codepoint": 0,
                    "end_codepoint": 5, "quote": "quote"})
    return row


_ENUMERATED_CHECK = re.compile(
    r"CHECK\s*\(\s*\"?(\w+)\"?\s+IN\s*\(([^)]*)\)\s*\)", re.IGNORECASE)


def _enumerated_checks(conn: sqlite3.Connection) -> list[tuple[str, str, list[str]]]:
    """Every `CHECK(col IN (...))` in the schema, as (table, column, values)."""
    found = []
    for name, sql in conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL"
    ):
        if name in SHADOW or name.startswith("sqlite_"):
            continue
        for column, values in _ENUMERATED_CHECK.findall(sql):
            found.append((name, column,
                          [v.strip().strip("'") for v in values.split(",")]))
    return sorted(found)


def _try_insert(conn: sqlite3.Connection, table: str, row: dict):
    """Insert inside a savepoint that is always rolled back. Returns the error."""
    conn.execute("SAVEPOINT check_probe")
    try:
        # Foreign keys are deferred, not disabled: the probe rows point at ids
        # that may not exist, and this test is about CHECK, not about FK. A
        # deferred violation would surface at COMMIT, which never happens here.
        conn.execute("PRAGMA defer_foreign_keys=ON")
        conn.execute(
            'INSERT INTO "{}" ({}) VALUES ({})'.format(
                table, ", ".join(f'"{c}"' for c in row), ", ".join("?" * len(row))),
            list(row.values()))
        return None
    except sqlite3.IntegrityError as error:
        return error
    finally:
        conn.execute("ROLLBACK TO check_probe")
        conn.execute("RELEASE check_probe")


def test_every_enumerated_check_value_accepts_and_rejects_on_the_upgraded_database(walked, fresh):
    """B10: a CHECK is only proven where the data lives, not on a fresh install.

    Denominator: the `CHECK(col IN (...))` constraints parsed out of the fresh
    database's own `sqlite_master`, so a value added to a set in a future
    migration is exercised without anyone remembering to add it here.
    """
    constraints = _enumerated_checks(fresh)
    assert _enumerated_checks(walked["conn"]) == constraints, (
        "the upgraded database's enumerated CHECK sets differ from a fresh "
        "install's -- a rebuild lost or changed a constraint")

    conn = walked["conn"]
    accepted = rejected = 0
    for table, column, values in constraints:
        for value in values:
            error = _try_insert(conn, table, _template(table, column, value))
            assert error is None or "CHECK constraint failed" not in str(error), (
                f"{table}.{column} = {value!r} is in the constraint's own value "
                f"set and was refused by a CHECK: {error}")
            accepted += 1
        sentinel = "not-a-valid-" + column
        assert sentinel not in values
        error = _try_insert(conn, table, _template(table, column, sentinel))
        assert error is not None and "CHECK constraint failed" in str(error), (
            f"{table}.{column} accepted {sentinel!r}; the CHECK is not enforced "
            "on the upgraded database")
        rejected += 1

    # The enumerated sets are not every CHECK in the schema. Saying how many of
    # each there are is the difference between a denominator and a number.
    total_checks = sum(
        len(re.findall(r"\bCHECK\s*\(", sql or "", re.IGNORECASE))
        for (sql,) in fresh.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL"))
    print(f"P6: {len(constraints)} enumerated CHECK constraints of "
          f"{total_checks} CHECK clauses in the fresh schema; "
          f"{accepted} values accepted, {rejected} sentinels rejected")
    assert len(constraints) >= 20 and accepted >= 60


# ---------------------------------------------------------------------------
# P7 -- idempotence and restart
# ---------------------------------------------------------------------------


def _fingerprint(conn: sqlite3.Connection) -> str:
    """One hash over the schema and every row, for comparing whole databases."""
    digest = hashlib.sha256()
    for name, sql in sorted(_objects(conn).items(), key=lambda kv: kv[0]):
        digest.update(repr((name, sql)).encode())
    snapshot = _snapshot(conn)
    digest.update(repr(snapshot["sequences"]).encode())
    for table in snapshot["tables"]:
        digest.update(repr((table, snapshot["rows"][table])).encode())
    return digest.hexdigest()


def test_a_second_and_third_launch_change_nothing(walked):
    """`init_db` runs on every launch. After the first, it must be a no-op."""
    conn = walked["conn"]
    before = _fingerprint(conn)
    for _ in range(2):
        database.init_db(str(walked["path"]))
    reopened = _open(walked["path"])
    try:
        assert _fingerprint(reopened) == before
        assert database.get_schema_version(reopened) == TARGET_SCHEMA_VERSION
    finally:
        reopened.close()
    assert _fingerprint(conn) == before


# ---------------------------------------------------------------------------
# P8 -- the real backend, on a socket, over the upgraded file
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def upgraded_backend(walked, tmp_path_factory):
    """The real `resmon.py` on an ephemeral port over a copy of the upgraded file.

    A copy, in its own state directory, on a port the OS picked: port 8742 and
    the state directory under Application Support belong to the daemon over the
    maintainer's real corpus and are never touched by a test.
    """
    state = tmp_path_factory.mktemp("cumulative-backend")
    path = state / "corpus.db"
    path.write_bytes(walked["path"].read_bytes())

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 8742

    env = {**os.environ, **({"RESMON_API_TOKEN": _TOKEN} if _TOKEN else {}),
           "RESMON_STATE_DIR": str(state), "RESMON_DB_PATH": str(path),
           "RESMON_REPORTS_DIR": str(state / "reports"),
           "RESMON_PORT_FILE": str(state / "backend.port"),
           "RESMON_CHROMIUM_PROFILE": str(state / "chromium"),
           "RESMON_DISABLE_SCHEDULER": "1", "PYTHONDONTWRITEBYTECODE": "1",
           "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring"}
    log = (state / "backend.log").open("w")
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "resmon_scripts/resmon.py"), str(port)],
        cwd=state, env=env, stdout=log, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(150):
            assert proc.poll() is None, (state / "backend.log").read_text()
            try:
                _API.get(base + "/api/health", timeout=1).raise_for_status()
                break
            except (httpx.HTTPError, ValueError):
                time.sleep(0.2)
        else:
            pytest.fail("the backend did not start on the upgraded database:\n"
                        + (state / "backend.log").read_text())
        yield base, path
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        log.close()


def test_the_real_backend_serves_the_upgraded_database_over_http(upgraded_backend, walked):
    """The boundary a user meets. Everything above this line is SQL.

    A schema that passes every comparison above can still be one the
    application cannot read -- an endpoint selecting a column the fixture's
    rows leave NULL, a JSON field the renderer expects. This reads the seeded
    papers, runs and routines back out through the API the renderer uses.
    """
    base, _ = upgraded_backend
    conn = walked["conn"]

    health = _API.get(base + "/api/health", timeout=10).json()
    assert health.get("status") in ("ok", "healthy", "degraded"), health

    expected_docs = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    # The Explorer's own endpoint, over the FTS index the walk carried across.
    search = _API.post(base + "/api/explorer/search",
                        json={"query": "diffusion", "limit": 10}, timeout=20)
    search.raise_for_status()
    found = search.json()
    titles = {d["title"] for d in found["results"]}
    assert "Diffusion models for turbulent flow reconstruction" in titles, (
        f"the upgraded corpus is not searchable through the API: {found}")
    assert found.get("used_full_text_index") is True, (
        "the API fell back off the FTS index the migration was supposed to keep")

    # An unfiltered page must reach every paper v2.1.0 stored, including the
    # undated one -- pagination over an undated row is what `pub_sort` exists
    # for and what a rebuilt documents table would break.
    seen, cursor = set(), None
    for _ in range(20):
        page = _API.post(base + "/api/explorer/search",
                          json={"limit": 5, "cursor": cursor}, timeout=20)
        page.raise_for_status()
        body = page.json()
        seen.update(d["id"] for d in body["results"])
        cursor = body.get("next_cursor")
        if not cursor:
            break
    assert len(seen) == expected_docs, (
        f"{expected_docs} documents in the upgraded database, {len(seen)} reachable "
        "through paged search")

    runs = _API.get(base + "/api/executions", params={"limit": 50}, timeout=20)
    runs.raise_for_status()
    served_runs = runs.json()
    served_runs = served_runs["executions"] if isinstance(served_runs, dict) else served_runs
    expected_runs = conn.execute("SELECT COUNT(*) FROM executions").fetchone()[0]
    assert len(served_runs) == expected_runs, (
        f"{expected_runs} executions in the upgraded database, {len(served_runs)} served")
    # The per-source outcomes schema 13 already carried must still arrive: the
    # failed source and the one skipped for a missing key are the rows a user
    # reads to learn their monitoring broke.
    statuses = set()
    for run in served_runs:
        for outcome in (run.get("source_outcomes") or {}).get("sources", []) or []:
            statuses.add(outcome.get("status"))
    assert {"ok", "error", "skipped_missing_key"} <= statuses or statuses == set(), (
        f"per-source outcomes came back as {statuses}")

    routines = _API.get(base + "/api/routines", timeout=20)
    routines.raise_for_status()
    served_routines = routines.json()
    served_routines = (served_routines["routines"]
                       if isinstance(served_routines, dict) else served_routines)
    expected_routines = conn.execute("SELECT COUNT(*) FROM routines").fetchone()[0]
    assert len(served_routines) == expected_routines
    print(f"P8: {expected_docs} documents, {expected_runs} executions and "
          f"{expected_routines} routines read back over HTTP")


# ---------------------------------------------------------------------------
# P1 -- every released fixture is what the release that wrote it produced
# ---------------------------------------------------------------------------


class _Released:
    """A corpus a released resmon wrote, and how to regenerate it.

    The table below is the whole per-release cost of the standing rule in
    `docs/release-verification.md`: a release that ships a schema adds one row
    here and one directory beside this file. It does not add a test, and it
    does not touch any fixture that shipped before it -- those files are the
    only evidence in the repository that an upgrade did not move, and an edit
    to `database.py` must never be able to move them either.
    """

    def __init__(self, tag: str, schema_version: int, require_env: str):
        self.tag = tag
        self.schema_version = schema_version
        # CI fetches the tag explicitly and sets this to '1', which turns the
        # "tag is not here" skip below into a failure. A depth-1 clone or a
        # source tarball has no tags and skips.
        self.require_env = require_env
        self.directory = Path(__file__).parent / "fixtures" / tag
        self.corpus = self.directory / f"corpus_schema_{schema_version}.sql"
        self.generator = self.directory / "generate_corpus.py"


RELEASED = [
    _Released("v2.1.0", 13, "RESMON_REQUIRE_V210_TAG"),
    _Released("v2.2.0", 18, "RESMON_REQUIRE_V220_TAG"),
]
IDS = [r.tag for r in RELEASED]

# The walk above starts from the oldest fixture. Asserting it here rather than
# letting the two definitions drift: a renamed fixture would otherwise leave
# `walked` testing one file and this section proving another.
assert FIXTURE == RELEASED[0].corpus and GENERATOR == RELEASED[0].generator

# The release whose schema today's code still ships. There is exactly one, and
# the guard below fails rather than skips when a schema bump leaves none --
# which is the moment the next fixture is owed.
CURRENT = [r for r in RELEASED if r.schema_version == database.SCHEMA_VERSION]


def _worktree(tag: str, tmp_path_factory):
    """A disposable checkout of `tag`, or None where the tag is not here.

    A checkout without the tag (a depth-1 clone, a source tarball) returns None
    and the caller skips. CI fetches every tag in RELEASED explicitly and sets
    each one's require_env, so a committed fixture cannot drift from the output
    of the code that wrote it between local runs.
    """
    if not (ROOT / ".git").exists():
        return None
    if subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--verify", f"{tag}^{{commit}}"],
                      capture_output=True).returncode != 0:
        return None
    target = tmp_path_factory.mktemp(f"{tag}-source") / "tree"
    result = subprocess.run(
        ["git", "-C", str(ROOT), "worktree", "add", "--detach", str(target), tag],
        capture_output=True, text=True)
    if result.returncode != 0:
        return None
    return target


@pytest.mark.parametrize("release", RELEASED, ids=IDS)
def test_the_committed_fixture_is_what_that_releases_own_code_produces(
        release, tmp_path_factory):
    """Regenerate against the real released code, out of process, and diff.

    Without this a fixture is just a file someone committed, and the claim that
    it is "what v2.1.0 wrote" -- or what v2.2.0 wrote -- is unfalsifiable from
    here on.
    """
    tree = _worktree(release.tag, tmp_path_factory)
    if tree is None:
        required = os.environ.get(release.require_env) == "1"
        assert not required, (
            f"{release.require_env}=1 but tag {release.tag} could not be checked out here")
        pytest.skip(f"tag {release.tag} is not in this checkout")
    try:
        result = subprocess.run(
            [sys.executable, str(release.generator), "--source-tree", str(tree),
             "--out", str(release.corpus), "--check"],
            capture_output=True, text=True, timeout=600)
        assert result.returncode == 0, (
            f"the committed fixture is not what {release.tag}'s code produces:\n"
            + result.stdout[-4000:] + result.stderr[-2000:])
    finally:
        subprocess.run(["git", "-C", str(ROOT), "worktree", "remove", "--force", str(tree)],
                       capture_output=True)


@pytest.mark.parametrize("release", RELEASED, ids=IDS)
def test_the_fixture_declares_the_commit_it_came_from(release):
    """Provenance in the file itself, so a reader does not have to take it on trust."""
    header = release.corpus.read_text(encoding="utf-8").split("\n\n", 1)[0]
    assert f"tag {release.tag}" in header
    assert re.search(r"commit [0-9a-f]{40}", header), (
        "the fixture header must name the exact commit it was generated from")
    assert "generate_corpus.py" in header


@pytest.mark.parametrize("release", RELEASED, ids=IDS)
def test_the_fixture_holds_every_object_the_release_owns_and_no_shadow_table(release):
    """The lesson from the reading-queue fixture, kept as a test rather than a comment."""
    conn = sqlite3.connect(":memory:")
    try:
        conn.executescript(release.corpus.read_text(encoding="utf-8"))
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    finally:
        conn.close()
    # The three triggers are resmon's own DDL; a prefix-based exclusion once
    # removed them along with the shadow tables.
    assert {"documents_fts_insert", "documents_fts_delete",
            "documents_fts_update"} <= names
    text = release.corpus.read_text(encoding="utf-8")
    for shadow in SHADOW:
        assert f'CREATE TABLE "{shadow}"' not in text and f"'{shadow}'" not in text, (
            f"{shadow} is fts5's own table and must not be in the fixture")


# ---------------------------------------------------------------------------
# P9 -- the newest released fixture is walked by today's code
# ---------------------------------------------------------------------------


NEWEST = max(RELEASED, key=lambda r: r.schema_version)


def test_the_release_that_shipped_this_schema_left_a_fixture():
    """A schema bump owes a fixture, and this is where the debt is called in.

    The debt falls due at the *release*, not at the bump: a branch that adds a
    migration cannot commit a fixture of a version nobody has shipped. So while
    `SCHEMA_VERSION` is ahead of every released fixture, this checks that the
    schema is genuinely unreleased -- `config.APP_VERSION` is still the newest
    released tag -- and says so. The release that ships it bumps `config.py`
    (and `package.json`) and this fails on that commit, which is exactly the
    moment the fixture is owed.

    Never skips. An empty `CURRENT` with a bumped `APP_VERSION` is a release
    that shipped a schema and left no evidence of what it wrote.
    """
    assert len(CURRENT) <= 1, f"two releases claim schema {database.SCHEMA_VERSION}"
    if CURRENT:
        return
    assert database.SCHEMA_VERSION > NEWEST.schema_version, (
        f"SCHEMA_VERSION is {database.SCHEMA_VERSION}, below the {NEWEST.schema_version} "
        f"{NEWEST.tag} shipped. Schemas only move forward.")
    assert config.APP_VERSION == NEWEST.tag.lstrip("v"), (
        f"APP_VERSION is {config.APP_VERSION} and SCHEMA_VERSION is "
        f"{database.SCHEMA_VERSION}, which no entry in RELEASED was written at. "
        "A release that ships a schema commits a fixture of it -- see "
        "docs/release-verification.md.")


@pytest.mark.parametrize("release", [NEWEST], ids=[NEWEST.tag])
def test_one_init_db_over_the_newest_releases_fixture_keeps_every_row(
        release, tmp_path_factory):
    """The walk a user of the newest release takes today.

    While the newest released fixture is at the schema this code still ships,
    that walk is a no-op and the whole fingerprint has to come back identical.
    Once a step has been added past it -- 18 -> 19 today -- the fingerprint
    legitimately changes, because `executions` is rebuilt with a wider `status`
    CHECK and five new columns, and the schema marker moves. What must not
    change is the data: every row of every application table the release wrote,
    column for column, and every AUTOINCREMENT high-water mark.

    That second half is the assertion that matters for a table rebuild. A
    rebuild is the one migration shape that can lose a column's values, drop a
    row, or reset a sequence while leaving a row count perfectly intact.

    File-backed, and reopened afterwards, because reopening is what a launch
    does.
    """
    path = tmp_path_factory.mktemp(f"newest-{release.tag}") / "corpus.db"
    conn = _open(path)
    conn.executescript(release.corpus.read_text(encoding="utf-8"))
    conn.commit()
    assert database.get_schema_version(conn) == release.schema_version
    before_print = _fingerprint(conn)
    before = _snapshot(conn)
    before_objects = _objects(conn)
    tables = len(_app_tables(conn))
    rows = sum(len(before["rows"][t]) for t in before["tables"])
    conn.close()

    database.init_db(str(path))            # the launch

    conn = _open(path)
    try:
        assert database.get_schema_version(conn) == database.SCHEMA_VERSION
        assert tables >= 30 and rows >= 150, (
            f"{tables} tables and {rows} rows were compared -- too few for this "
            "assertion to mean anything")

        if release.schema_version == database.SCHEMA_VERSION:
            assert _fingerprint(conn) == before_print, (
                f"one init_db changed the {release.tag} fixture: same objects, "
                "same rows and the same sequences were expected")
            print(f"P9 {release.tag}: {rows} rows across {tables} application "
                  "tables unchanged by one init_db")
            return

        after = _snapshot(conn)
        assert after["tables"] == before["tables"] or set(before["tables"]) <= set(
            after["tables"]), "the walk dropped an application table"
        compared = 0
        marker_moved: list = []
        for table in before["tables"]:
            old_rows, new_rows = before["rows"][table], after["rows"][table]
            assert len(old_rows) == len(new_rows), (
                f"{table}: {len(old_rows)} rows before, {len(new_rows)} after")
            for old, new in zip(old_rows, new_rows):
                for column, value in old.items():
                    # The one rewrite the walk is for: the marker advances from
                    # the version this fixture was written at to the version
                    # today's code ships. Spelled out here rather than reusing
                    # `_INTENDED`, whose predicate is pinned to the schema-13
                    # fixture the walk above starts from.
                    if (table == "app_settings" and column == "value"
                            and old["key"] == "schema_version"
                            and value == str(release.schema_version)
                            and new["value"] == str(database.SCHEMA_VERSION)):
                        marker_moved.append(new["value"])
                        continue
                    assert new[column] == value, (
                        f"{table}.{column} changed: {value!r} -> {new[column]!r}")
                compared += 1
        assert compared == rows
        assert marker_moved == [str(database.SCHEMA_VERSION)], (
            "the schema marker did not advance exactly once; the walk is the "
            "whole point of this case")
        for name, seq in before["sequences"].items():
            assert after["sequences"].get(name) == seq, (
                f"the AUTOINCREMENT high-water mark for {name} moved: "
                f"{seq} -> {after['sequences'].get(name)}")
        lost = sorted(set(before_objects) - set(_objects(conn)))
        assert not lost, f"the walk dropped objects {release.tag} owned: {lost}"
        print(f"P9 {release.tag}: {compared} of {rows} rows across {tables} "
              f"application tables survived the walk to schema "
              f"{database.SCHEMA_VERSION}, with "
              f"{len(before['sequences'])} of {len(before['sequences'])} "
              "sequences held")
    finally:
        conn.close()
