"""Routine ``execution_location`` after the cloud service was removed.

``execution_location`` used to choose between the local daemon and the
resmon-cloud scheduler. The cloud service is gone, so ``'local'`` is the only
value that means anything. The column itself stays: dropping it would mean
rebuilding ``routines`` on every existing install to remove a field nothing
reads.

Two things have to hold, and only one of them is about fresh installs:

1.  Nothing can create or update a routine to ``'cloud'`` any more. A routine
    marked that way would show as active in the UI and never fire, because the
    scheduler that was supposed to run it no longer exists.
2.  A database that *already* has such a routine is repaired on upgrade. This
    is the half CI cannot catch on its own -- every other test starts from an
    empty database -- and it is the same gap that let the 1.5.0 upgrade P0
    through. See ``test_schema_upgrade.py``.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database  # noqa: E402


def _reset_db():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


def _client() -> TestClient:
    _reset_db()
    from resmon import app
    return TestClient(app)


def _routine_body(name: str, **extra) -> dict:
    body = {
        "name": name,
        "schedule_cron": "0 8 * * *",
        "parameters": {"query": "cardiac regeneration", "repositories": ["arxiv"]},
    }
    body.update(extra)
    return body


# ---------------------------------------------------------------------------
# The column survives; the second value does not
# ---------------------------------------------------------------------------


def test_execution_location_column_exists_with_correct_default():
    client = _client()
    client.get("/api/health")
    conn = resmon_mod._get_db()
    cols = {row[1]: row for row in conn.execute("PRAGMA table_info(routines)").fetchall()}
    assert "execution_location" in cols, "execution_location column missing"
    # Column 3 is notnull, column 4 is dflt_value.
    col = cols["execution_location"]
    assert col[3] == 1, "execution_location must be NOT NULL"
    assert "local" in str(col[4]), f"default must be 'local', got {col[4]!r}"


def test_schema_version_tracks_the_constant():
    client = _client()
    client.get("/api/health")
    conn = resmon_mod._get_db()
    assert database.get_schema_version(conn) == database.SCHEMA_VERSION
    # 5 removed the four cloud-mirror tables.
    assert database.SCHEMA_VERSION >= 5


def test_create_routine_is_local():
    client = _client()
    resp = client.post("/api/routines", json=_routine_body("Plain"))
    assert resp.status_code == 201
    rid = resp.json()["id"]
    row = client.get(f"/api/routines/{rid}").json()
    assert row["execution_location"] == "local"


def test_execution_location_is_not_a_request_field():
    """A stray ``execution_location`` in the body cannot make a routine cloud.

    Pydantic ignores unknown fields by default, so this asserts the outcome
    rather than a 422: whatever a caller sends, the routine lands local and
    therefore actually runs.
    """
    client = _client()
    resp = client.post(
        "/api/routines", json=_routine_body("Sneaky", execution_location="cloud"),
    )
    assert resp.status_code == 201
    rid = resp.json()["id"]
    assert client.get(f"/api/routines/{rid}").json()["execution_location"] == "local"

    resp = client.put(f"/api/routines/{rid}", json={"execution_location": "cloud"})
    assert resp.status_code == 200
    assert client.get(f"/api/routines/{rid}").json()["execution_location"] == "local"


def test_database_layer_rejects_cloud_directly():
    """The guard lives in ``database``, not only in the request model."""
    client = _client()
    client.get("/api/health")
    conn = resmon_mod._get_db()

    with pytest.raises(ValueError, match="must be 'local'"):
        database.insert_routine(conn, {
            "name": "direct", "schedule_cron": "0 8 * * *",
            "parameters": "{}", "execution_location": "cloud",
        })

    rid = database.insert_routine(conn, {
        "name": "ok", "schedule_cron": "0 8 * * *", "parameters": "{}",
    })
    with pytest.raises(ValueError, match="must be 'local'"):
        database.update_routine(conn, rid, {"execution_location": "cloud"})


def test_active_local_routine_is_scheduled():
    """The scheduler used to skip cloud routines. Nothing is skipped now."""
    client = _client()
    resp = client.post("/api/routines", json=_routine_body("Runs", is_active=True))
    rid = resp.json()["id"]
    if resmon_mod.scheduler is not None:
        assert str(rid) in [j["id"] for j in resmon_mod.scheduler.get_active_jobs()]


# ---------------------------------------------------------------------------
# Upgrading a database that still has a cloud routine in it
# ---------------------------------------------------------------------------

# ``routines`` as an install from before this release would have it: the
# CHECK constraint still admits 'cloud', and a row may be sitting on it.
LEGACY_ROUTINES_SCHEMA = """
CREATE TABLE routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    schedule_cron TEXT NOT NULL,
    parameters TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    email_enabled INTEGER NOT NULL DEFAULT 0,
    email_ai_summary_enabled INTEGER NOT NULL DEFAULT 0,
    ai_enabled INTEGER NOT NULL DEFAULT 0,
    ai_settings TEXT,
    storage_settings TEXT,
    last_executed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    notify_on_complete INTEGER NOT NULL DEFAULT 0,
    execution_location TEXT NOT NULL DEFAULT 'local'
        CHECK (execution_location IN ('local', 'cloud'))
);
"""


@pytest.fixture
def legacy_conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.executescript(LEGACY_ROUTINES_SCHEMA)
    c.executemany(
        "INSERT INTO routines (name, schedule_cron, parameters, is_active, "
        "execution_location) VALUES (?,?,?,?,?)",
        [
            ("stranded-on-cloud", "0 6 * * *", "{}", 1, "cloud"),
            ("already-local", "0 7 * * *", "{}", 1, "local"),
            ("inactive-cloud", "0 8 * * *", "{}", 0, "cloud"),
        ],
    )
    c.commit()
    return c


def test_upgrade_repoints_cloud_routines_at_the_local_scheduler(legacy_conn):
    before = {
        r["name"]: r["execution_location"]
        for r in legacy_conn.execute(
            "SELECT name, execution_location FROM routines"
        ).fetchall()
    }
    assert before["stranded-on-cloud"] == "cloud", "fixture should start dirty"

    database.init_db(conn=legacy_conn)

    after = {
        r["name"]: r["execution_location"]
        for r in legacy_conn.execute(
            "SELECT name, execution_location FROM routines"
        ).fetchall()
    }
    assert after == {
        "stranded-on-cloud": "local",
        "already-local": "local",
        "inactive-cloud": "local",
    }


def test_upgrade_preserves_everything_else_about_the_routine(legacy_conn):
    database.init_db(conn=legacy_conn)
    row = legacy_conn.execute(
        "SELECT * FROM routines WHERE name = 'stranded-on-cloud'"
    ).fetchone()
    assert row["schedule_cron"] == "0 6 * * *"
    assert row["is_active"] == 1
    assert row["parameters"] == "{}"


def test_upgrade_is_idempotent(legacy_conn):
    database.init_db(conn=legacy_conn)
    database.init_db(conn=legacy_conn)
    locations = [
        r["execution_location"]
        for r in legacy_conn.execute("SELECT execution_location FROM routines").fetchall()
    ]
    assert locations == ["local", "local", "local"]


def test_upgrade_drops_no_cloud_mirror_data_it_finds(legacy_conn):
    """Old databases keep their mirror tables; the upgrade just stops using them.

    The cloud service never ran, so these tables are empty everywhere in
    practice. Leaving them alone is still the right call -- an upgrade should
    not drop tables it no longer understands.
    """
    legacy_conn.executescript(
        "CREATE TABLE cloud_routines (routine_id TEXT PRIMARY KEY, name TEXT);"
    )
    legacy_conn.execute(
        "INSERT INTO cloud_routines (routine_id, name) VALUES ('abc', 'leftover')"
    )
    legacy_conn.commit()

    database.init_db(conn=legacy_conn)

    still_there = legacy_conn.execute(
        "SELECT name FROM cloud_routines WHERE routine_id = 'abc'"
    ).fetchone()
    assert still_there is not None and still_there["name"] == "leftover"


def test_fresh_database_has_no_cloud_mirror_tables():
    client = _client()
    client.get("/api/health")
    conn = resmon_mod._get_db()
    tables = {
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    for gone in ("cloud_executions", "cloud_routines", "cloud_cache_meta", "sync_state"):
        assert gone not in tables, f"{gone} should not be created any more"
    # The Google Drive table is a different feature and stays.
    assert "cloud_sync" in tables
