"""Schema 14 on a database an earlier resmon actually built.

CI creates every database from scratch, so on its own it can only ever say that
a *fresh* install works. Schema 13 shipped an index over a column its migration
had not added yet: fresh databases were fine and every existing corpus refused
to start. That is the failure this file exists to catch, one version later.

The baseline here is not "a current database with its version marker changed".
It is `fixtures/reading_queue/schema_13.sql`, dumped from a database built by
the code at commit a1a377b — the last public `main` before this feature — and
then filled with rows the way a real corpus is filled. What is asserted is not
only that the upgrade does not raise: it is that **every row that was there
before is there afterwards, field for field**, that the new table arrives
empty, and that a migration which fails does not leave the marker claiming it
succeeded.

The fixture also carries resmon's own `documents_fts_insert` / `_update` /
`_delete` triggers. The first version of this file did not: it filtered the
dump on the prefix `documents_fts`, which is how SQLite names the shadow tables
it creates for itself *and* how resmon names those three triggers, so all six
were dropped together. Reconciliation found it by comparing against a database
built by the old code. `test_the_fixture_holds_every_object_the_application_owns`
now derives the shadow-name set at run time and compares against a fresh
database, so the fixture cannot silently lose an object again.

Boundary: a real SQLite database and the real `init_db`. Nothing is doubled.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import database, reading_queue  # noqa: E402

SCHEMA_13_SQL = Path(__file__).parent / "fixtures" / "reading_queue" / "schema_13.sql"

#: Every table the fixture fills, so the preservation check has a denominator
#: that is not "the tables I remembered to look at". Compared against the
#: database's own table list in
#: ``test_the_fixture_fills_every_table_the_preservation_check_reads``.
POPULATED_TABLES = (
    "app_settings", "assistant_messages", "assistant_sessions", "document_authors",
    "cloud_sync", "document_categories", "document_embeddings", "document_lifecycle",
    "document_lifecycle_checks", "document_links", "documents", "execution_ai",
    "execution_documents", "execution_sources", "executions", "routines",
    "saved_configurations", "watch_profile_matches", "watch_profile_members",
    "watch_profiles", "watchdog_mutes",
)


def contents(conn: sqlite3.Connection, tables=POPULATED_TABLES) -> dict:
    """Every named column of every row, in a stable order.

    Row *contents*, not counts: a migration that rewrote a title or nulled a
    column would keep every count identical, and counts are what a preservation
    check usually settles for.
    """
    result = {}
    for table in tables:
        columns = [row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')]
        order = ", ".join(f'"{c}"' for c in columns)
        result[table] = {
            "columns": columns,
            "rows": [tuple(r) for r in conn.execute(
                f'SELECT {order} FROM "{table}" ORDER BY {order}')],
        }
    return result


def build_schema_13(path: Path) -> sqlite3.Connection:
    """A populated schema-13 corpus: the fixture's DDL plus real rows."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.executescript(SCHEMA_13_SQL.read_text())

    conn.executemany(
        "INSERT INTO documents (source_repository, external_id, doi, title, authors, "
        "abstract, publication_date, url, categories, metadata_hash, first_seen_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
            ("arxiv", "legacy-1", "10.0000/legacy-1", "Legacy diffusion models",
             "Ada Lovelace, Alan Turing", "About diffusion.", "2026-01-15",
             "https://example.invalid/1", "cs.LG, stat.ML", "legacy-h1",
             "2026-01-16 09:00:00"),
            ("pubmed", "legacy-2", None, "Legacy protein folding", "Grace Hopper",
             "About folding.", "2025-11-02", "https://example.invalid/2", "q-bio",
             "legacy-h2", "2026-01-16 09:00:01"),
            ("openalex", "legacy-3", None, "Legacy protein folding", "Grace Hopper",
             None, None, "https://example.invalid/3", None, "legacy-h3",
             "2026-01-16 09:00:02"),
        ],
    )
    # Author identity is schema 13's own addition; the upgrade must not touch
    # it, including the NULLs that mean "the source gave no identifier".
    conn.executemany(
        "INSERT INTO document_authors (document_id, author, orcid, affiliation, "
        "source_author_id) VALUES (?,?,?,?,?)",
        [(1, "Ada Lovelace", "0000-0002-9322-3515", "MIT", "A1"),
         (1, "Alan Turing", None, None, None),
         (2, "Grace Hopper", None, None, None),
         (3, "Grace Hopper", None, None, None)],
    )
    conn.executemany(
        "INSERT INTO document_categories (document_id, category) VALUES (?,?)",
        [(1, "cs.LG"), (1, "stat.ML"), (2, "q-bio")],
    )
    # The search index is *not* seeded here. The fixture carries resmon's own
    # `documents_fts_insert` trigger, so the three inserts above already
    # populated it — writing the rows again by hand would index each paper
    # twice, and a fixture that needs hand-feeding is a fixture whose triggers
    # are missing. That is exactly what the first version of this file hid.
    conn.execute(
        "INSERT INTO saved_configurations (name, config_type, parameters, created_at, "
        "updated_at) VALUES ('Weekly arXiv', 'manual_sweep', ?, '2026-01-10 08:00:00', "
        "'2026-01-10 08:00:00')",
        (json.dumps({"keywords": ["diffusion"]}),),
    )
    conn.execute(
        "INSERT INTO routines (name, schedule_cron, parameters, is_active, intent, "
        "execution_location, created_at, updated_at) VALUES ('Diffusion watch', "
        "'0 8 * * 1', ?, 1, 'anything on diffusion models', 'local', "
        "'2026-01-11 08:00:00', '2026-01-11 08:00:00')",
        (json.dumps({"keywords": ["diffusion"], "repositories": ["arxiv"]}),),
    )
    conn.executemany(
        "INSERT INTO executions (execution_type, routine_id, parameters, start_time, "
        "end_time, status, result_count, new_result_count, dedup_total, dedup_new, "
        "dedup_cross_source) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [("deep_dive", None,
          json.dumps({"keywords": ["diffusion"], "repositories": ["arxiv"]}),
          "2026-01-16 09:00:00", "2026-01-16 09:01:00", "completed", 2, 2, 2, 2, None),
         ("automated_sweep", 1,
          json.dumps({"keywords": ["folding"], "repositories": ["pubmed"]}),
          "2026-01-17 09:00:00", "2026-01-17 09:02:00", "completed", 2, 1, 2, 1, 1)],
    )
    conn.executemany(
        "INSERT INTO execution_documents (execution_id, document_id, is_new) VALUES (?,?,?)",
        [(1, 1, 1), (1, 2, 1), (2, 2, 0), (2, 3, 1)],
    )
    conn.executemany(
        "INSERT INTO execution_sources (execution_id, source, status, result_count, "
        "error_message, zero_reason, zero_detail, recorded_at) VALUES (?,?,?,?,?,?,?,?)",
        [(1, "arxiv", "ok", 2, None, None, None, "2026-01-16 09:01:00"),
         (2, "pubmed", "error", 0, "HTTP 503", "could_not_answer",
          "The source replied 503.", "2026-01-17 09:02:00")],
    )
    conn.execute(
        "INSERT INTO execution_ai (execution_id, lane_index, lane_label, lane_kind, "
        "provider, model, outcome, docs_attempted, docs_succeeded, started_at, ended_at) "
        "VALUES (1, 0, 'Local summariser', 'local', 'ollama', 'llama3', 'ok', 2, 2, "
        "'2026-01-16 09:01:00', '2026-01-16 09:01:30')")
    conn.execute(
        "INSERT INTO document_lifecycle (document_id, kind, severity, notice_key, label, "
        "notice_doi, notice_url, notice_date, detail, provider, provider_source, "
        "first_seen_at) VALUES (1, 'retraction', 'critical', 'notice-1', 'Retracted', "
        "'10.0000/notice-1', 'https://example.invalid/notice-1', '2026-02-01', "
        "'Synthetic retraction notice.', 'crossref', 'crossref-api', "
        "'2026-02-01 10:00:00')")
    conn.execute(
        "INSERT INTO document_lifecycle_checks (document_id, checked_at, status, "
        "error_message, providers) VALUES (1, '2026-02-01 10:00:00', 'ok', NULL, ?)",
        (json.dumps(["crossref"]),))
    conn.execute(
        "INSERT INTO document_links (document_a, document_b, kind, score, method, "
        "created_at) VALUES (2, 3, 'near_duplicate', 0.98, 'title', '2026-02-02 11:00:00')")
    conn.execute(
        "INSERT INTO document_embeddings (document_id, model, dims, vector, fields, "
        "embedded_at) VALUES (1, 'nomic-embed-text', 4, ?, 'title+abstract', "
        "'2026-02-03 12:00:00')",
        (b"\x00\x01\x02\x03",))
    conn.executemany(
        "INSERT INTO watch_profiles (kind, display_name, names, identifiers, orcid, "
        "affiliations, field_hints, notes, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        [("person", "Grace Hopper", json.dumps([{"value": "Grace Hopper", "script": "Latn"}]),
          json.dumps({}), None, json.dumps(["Yale"]), json.dumps([]), None,
          "2026-01-05 07:00:00", "2026-01-05 07:00:00"),
         ("group", "Folding group", json.dumps([{"value": "Folding group", "script": "Latn"}]),
          json.dumps({}), None, json.dumps([]), json.dumps([]), None,
          "2026-01-05 07:00:01", "2026-01-05 07:00:01")],
    )
    conn.execute(
        "INSERT INTO watch_profile_members (profile_id, member_profile_id) VALUES (2, 1)")
    conn.execute(
        "INSERT INTO watch_profile_matches (document_id, profile_id, basis, "
        "matched_author, evidence, first_seen_at) VALUES (2, 1, 'name_only', "
        "'Grace Hopper', ?, '2026-01-17 09:02:00')",
        (json.dumps({"matched_on": "name"}),))
    conn.execute(
        "INSERT INTO watchdog_mutes (finding_key, muted_at, note) "
        "VALUES ('source:pubmed', '2026-02-04 13:00:00', 'known outage')")
    conn.execute(
        "INSERT INTO cloud_sync (provider, account_info, is_linked, auto_backup_enabled, "
        "last_sync_at, sync_status) VALUES ('google_drive', ?, 1, 1, "
        "'2026-02-05 06:00:00', 'idle')",
        (json.dumps({"email": "someone@example.invalid"}),))
    sid = conn.execute(
        "INSERT INTO assistant_sessions (runtime, cli_session_id, model, title, "
        "created_at, updated_at) VALUES ('claude_cli', 'sess-1', 'opus', "
        "'Weekly arXiv', '2026-02-05 14:00:00', '2026-02-05 14:05:00')").lastrowid
    conn.executemany(
        "INSERT INTO assistant_messages (session_id, role, content, tool_calls, "
        "tool_results, input_tokens, output_tokens, cost_usd, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        [(sid, "user", "set one up", None, None, None, None, None, "2026-02-05 14:00:00"),
         (sid, "assistant", "done", json.dumps([{"name": "create_routine"}]),
          json.dumps([{"routine": {"id": 1}}]), 120, 40, 0.012, "2026-02-05 14:05:00")],
    )
    conn.executemany(
        "INSERT INTO app_settings (key, value) VALUES (?,?)",
        # The two ``*_backfilled`` markers are what a real schema-13 database
        # holds: schema 6 and schema 8 wrote them when their one-time backfills
        # ran, and their absence would make those migrations run again here
        # against data that is already in its final shape. A fixture missing
        # them is not a schema-13 corpus, it is a corpus that skipped two
        # upgrades.
        [("schema_version", "13"), ("dedup_columns_backfilled", "1"),
         ("execution_sources_backfilled", "1"), ("export_directory", "/tmp/exports"),
         ("email_enabled", "true"), ("pdf_policy", "keep")],
    )
    conn.commit()
    return conn


@pytest.fixture
def legacy(tmp_path):
    conn = build_schema_13(tmp_path / "legacy.db")
    yield conn
    conn.close()


def test_the_fixture_is_really_schema_13(legacy):
    """Guard the guard: a fixture that already had the table proves nothing."""
    assert database.get_schema_version(legacy) == 13
    tables = {r[0] for r in legacy.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "reading_queue" not in tables
    assert "documents" in tables and "document_authors" in tables
    # Schema 13's own columns, so a fixture regenerated from the wrong commit
    # fails here rather than passing an upgrade it never really performed.
    author_columns = {r[1] for r in legacy.execute("PRAGMA table_info(document_authors)")}
    assert {"orcid", "affiliation", "source_author_id"} <= author_columns


def test_the_fixture_fills_every_table_the_preservation_check_reads(legacy):
    """`POPULATED_TABLES` is the denominator; nothing in it may be empty.

    The list is checked against the database's own table list, so a table added
    to the schema and not to the fixture is visible here rather than silently
    outside every preservation assertion below.
    """
    real = {r[0] for r in legacy.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    real -= {"sqlite_sequence"}                                  # SQLite creates this itself
    real -= {t for t in real if t.startswith("documents_fts")}   # FTS5 and its shadows
    assert real == set(POPULATED_TABLES), (
        "every table in the schema must be populated by the fixture, so the "
        "preservation check covers it")
    for table in POPULATED_TABLES:
        assert legacy.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] > 0, table


def test_upgrading_adds_the_queue_and_changes_nothing_else(legacy):
    before = contents(legacy)

    database.init_db(conn=legacy)

    assert database.get_schema_version(legacy) == 16
    tables = {r[0] for r in legacy.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "reading_queue" in tables

    after = contents(legacy)
    # app_settings is the one table the upgrade is allowed to touch, and only
    # in the schema_version row.
    assert after["app_settings"]["rows"] != before["app_settings"]["rows"]
    assert (dict(before["app_settings"]["rows"]) | {"schema_version": "16"}
            == dict(after["app_settings"]["rows"]))
    for table in POPULATED_TABLES:
        if table == "app_settings":
            continue
        assert after[table] == before[table], f"{table} was modified by the upgrade"


def test_the_upgraded_queue_starts_empty_and_infers_no_history(legacy):
    """Three papers, two runs, and not one guess about what the user meant to read."""
    database.init_db(conn=legacy)
    assert legacy.execute("SELECT COUNT(*) FROM reading_queue").fetchone()[0] == 0
    assert reading_queue.counts(legacy) == {"to_read": 0, "read": 0, "all": 0}
    assert reading_queue.list_entries(legacy)["entries"] == []


def test_the_index_the_listing_needs_exists_after_an_upgrade(legacy):
    database.init_db(conn=legacy)
    indexes = {r[0] for r in legacy.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reading_queue'")}
    assert "idx_reading_queue_status_saved" in indexes
    plan = " ".join(str(r[3]) for r in legacy.execute(
        "EXPLAIN QUERY PLAN SELECT document_id FROM reading_queue "
        "WHERE status = 'to_read' ORDER BY saved_at DESC, document_id DESC"))
    assert "idx_reading_queue_status_saved" in plan, plan


def test_upgrading_twice_more_is_a_no_op(legacy):
    """Every launch runs init_db. The second and third must change nothing."""
    database.init_db(conn=legacy)
    reading_queue.save(legacy, 1)
    reading_queue.set_status(legacy, 1, "read")
    settled = contents(legacy, POPULATED_TABLES + ("reading_queue",))

    database.init_db(conn=legacy)
    database.init_db(conn=legacy)

    assert contents(legacy, POPULATED_TABLES + ("reading_queue",)) == settled
    assert database.get_schema_version(legacy) == 16


def test_a_failed_migration_does_not_claim_to_have_succeeded(legacy):
    """The marker is written last, and a retry after the cause is cleared works.

    Provoked by putting a *view* called `reading_queue` in the way:
    `CREATE TABLE IF NOT EXISTS` skips an existing table of that name but
    refuses an object of another type, which is a real way for a migration to
    abort halfway. If the version were bumped first, or in the same breath,
    this database would report schema 14 with no queue table in it and would
    never be repaired — the daemon would simply fail on every read.
    """
    legacy.execute("CREATE VIEW reading_queue AS SELECT 1 AS document_id")
    legacy.commit()

    with pytest.raises(sqlite3.OperationalError):
        database.init_db(conn=legacy)
    assert database.get_schema_version(legacy) == 13, (
        "a migration that raised must not leave the marker at the new version")

    legacy.execute("DROP VIEW reading_queue")
    legacy.commit()
    database.init_db(conn=legacy)

    assert database.get_schema_version(legacy) == 16
    assert reading_queue.counts(legacy) == {"to_read": 0, "read": 0, "all": 0}


def test_a_fresh_database_gets_the_same_table_as_an_upgraded_one(tmp_path, legacy):
    """Two paths, one schema. A fresh install and an upgrade must not diverge."""
    database.init_db(conn=legacy)
    fresh = sqlite3.connect(tmp_path / "fresh.db")
    fresh.row_factory = sqlite3.Row
    database.init_db(conn=fresh)

    def shape(conn):
        return {
            "table": conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='reading_queue'"
            ).fetchone()[0],
            "indexes": sorted(
                r[0] for r in conn.execute(
                    "SELECT sql FROM sqlite_master WHERE type='index' "
                    "AND tbl_name='reading_queue' AND sql IS NOT NULL")),
        }

    assert shape(legacy) == shape(fresh)
    assert database.get_schema_version(fresh) == 16
    fresh.close()


def fts5_shadow_suffixes() -> set:
    """The table names SQLite invents for an fts5 virtual table, measured.

    Derived from a throwaway index rather than written down, because the
    written-down version is what went wrong: the fixture was filtered on the
    prefix ``documents_fts``, which matched SQLite's shadow tables *and*
    resmon's three triggers, and dropped all six.
    """
    probe = sqlite3.connect(":memory:")
    try:
        probe.execute("CREATE VIRTUAL TABLE probe_fts USING fts5(a)")
        return {
            row[0][len("probe_fts"):]
            for row in probe.execute(
                "SELECT name FROM sqlite_master WHERE name LIKE 'probe_fts%' "
                "AND name != 'probe_fts'")
        }
    finally:
        probe.close()


def application_objects(conn: sqlite3.Connection) -> dict:
    """Every schema object resmon itself declares, keyed by name.

    Excludes only what the engine creates on its own: the fts5 shadow tables
    for ``documents_fts`` and ``sqlite_sequence``.
    """
    generated = {"documents_fts" + suffix for suffix in fts5_shadow_suffixes()}
    generated.add("sqlite_sequence")
    return {
        row["name"]: (row["type"], row["tbl_name"])
        for row in conn.execute(
            "SELECT type, name, tbl_name FROM sqlite_master WHERE sql IS NOT NULL")
        if row["name"] not in generated and not row["name"].startswith("sqlite_")
    }


#: What schemas 14, 15 and 16 add. Everything else in a fresh database must already be in
#: the schema-13 fixture, or the fixture is not schema 13.
SCHEMA_14_TO_16_OBJECTS = {"reading_queue", "idx_reading_queue_status_saved",
                            "assistant_session_choices", "assistant_turn_choices",
                            "idx_assistant_turn_choices_assistant_message",
                            "library_vault", "library_files", "library_file_documents",
                            "idx_library_file_documents_document"}


def test_the_fixture_holds_every_object_the_application_owns(legacy, tmp_path):
    """The check reconciliation had to make by hand, now in the suite.

    A fresh database built by the current code is the denominator: subtract
    schemas 14, 15 and 16's own objects and what is left is precisely what an upgrading
    schema-13 corpus must already have. Comparing against that, rather than
    against a list in this file, is what makes a silently dropped trigger fail
    here instead of passing for another phase.
    """
    fresh = sqlite3.connect(tmp_path / "fresh-for-compare.db")
    fresh.row_factory = sqlite3.Row
    try:
        database.init_db(conn=fresh)
        expected = {name: kind for name, kind in application_objects(fresh).items()
                    if name not in SCHEMA_14_TO_16_OBJECTS}
    finally:
        fresh.close()

    assert application_objects(legacy) == expected

    # Named explicitly as well, because these three are the ones that went
    # missing and a set comparison alone would not say so in the failure.
    triggers = {name for name, (kind, _) in application_objects(legacy).items()
                if kind == "trigger"}
    assert {"documents_fts_insert", "documents_fts_update",
            "documents_fts_delete"} <= triggers


def test_the_search_index_survives_the_upgrade_and_stays_live(legacy):
    """Search worked before; it works after, and the triggers still fire.

    Row preservation is not enough here. A migration could keep every
    ``documents`` row and leave the full-text index stale or unmaintained, and
    the user would find that their corpus had stopped being searchable — which
    is the same class of failure as schema 13's index-over-a-missing-column.
    """
    def search(term):
        return sorted(row[0] for row in legacy.execute(
            "SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?", (term,)))

    assert search("diffusion") == [1]
    assert search("folding") == [2, 3]

    database.init_db(conn=legacy)

    assert search("diffusion") == [1], "an existing paper stopped being searchable"
    assert search("folding") == [2, 3]

    # INSERT trigger
    legacy.execute(
        "INSERT INTO documents (source_repository, external_id, title, abstract, "
        "metadata_hash) VALUES ('arxiv', 'post-upgrade', 'Post upgrade crystallography', "
        "'About crystals.', 'post-h1')")
    new_id = legacy.execute(
        "SELECT id FROM documents WHERE external_id = 'post-upgrade'").fetchone()[0]
    assert search("crystallography") == [new_id]

    # UPDATE trigger: the old term goes, the new term arrives.
    legacy.execute("UPDATE documents SET title = 'Post upgrade spectroscopy' WHERE id = ?",
                   (new_id,))
    assert search("crystallography") == []
    assert search("spectroscopy") == [new_id]

    # DELETE trigger
    legacy.execute("DELETE FROM documents WHERE id = ?", (new_id,))
    assert search("spectroscopy") == []
    assert search("diffusion") == [1], "the other papers were not disturbed"


def test_the_settings_a_user_had_survive_the_upgrade(legacy):
    """Everything in app_settings except the marker is the user's, not ours."""
    before = dict(legacy.execute("SELECT key, value FROM app_settings"))
    database.init_db(conn=legacy)
    after = dict(legacy.execute("SELECT key, value FROM app_settings"))
    assert after.pop("schema_version") == "16"
    assert before.pop("schema_version") == "13"
    assert after == before
