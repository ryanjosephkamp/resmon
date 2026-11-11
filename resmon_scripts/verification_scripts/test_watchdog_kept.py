"""The watchdog's report, served again while nothing it reads has changed.

``GET /api/watchdog`` keeps its last answer and serves it again while the
record it was computed from is unchanged, for at most ``watchdog.KEEP_SECONDS``.
Each case here changes one thing the report depends on and asserts the next
read is computed afresh and says so: a run starting and ending, a mute and an
unmute, a watch's schedule, settings, and switch, a fire skipped, a stored
setting, a run deleted, the clock, and another database. The first case is
the control: with nothing changed, the answer is the kept one.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import watchdog  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    insert_execution,
    insert_routine,
    record_execution_source,
    record_missed_fire,
    set_setting,
    update_execution_status,
    update_routine,
)


@pytest.fixture
def served(monkeypatch):
    """A fresh engine, and a count of the reports it computed (not served again)."""
    import resmon as resmon_mod
    from fastapi.testclient import TestClient

    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod._forget_watchdog_report()
    computed = {"n": 0}
    original = watchdog.report

    def counting(conn, **kwargs):
        computed["n"] += 1
        return original(conn, **kwargs)

    monkeypatch.setattr(resmon_mod.watchdog, "report", counting)
    clock = {"t": 1_000.0}
    monkeypatch.setattr(resmon_mod, "_watchdog_clock", lambda: clock["t"])
    client = TestClient(resmon_mod.app)
    conn = resmon_mod._get_db()

    def read() -> dict:
        response = client.get("/api/watchdog")
        assert response.status_code == 200
        return response.json()

    yield {"client": client, "conn": conn, "read": read, "computed": computed, "clock": clock,
           "module": resmon_mod}
    resmon_mod._forget_watchdog_report()


def _ts(days_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _routine(conn, name="ADS watch", sources=("nasa_ads",), active=True) -> int:
    return insert_routine(conn, {
        "name": name,
        "schedule_cron": "0 3 * * *",
        "parameters": json.dumps({"query": "x", "repositories": list(sources)}),
        "is_active": 1 if active else 0,
    })


def _started(conn, *, routine_id=None, days_ago=1.0) -> int:
    return insert_execution(conn, {
        "execution_type": "automated_sweep" if routine_id else "deep_sweep",
        "routine_id": routine_id,
        "parameters": json.dumps({"query": "x"}),
        "start_time": _ts(days_ago),
        "status": "running",
    })


def _ended(conn, exec_id, *, source="nasa_ads", days_ago=1.0) -> None:
    record_execution_source(conn, exec_id, source, "skipped_missing_key",
                            result_count=0, credential_name="nasa_ads_api_key")
    update_execution_status(conn, exec_id, "completed", end_time=_ts(days_ago),
                            new_result_count=0, result_count=0)


def test_with_nothing_changed_the_kept_answer_is_served(served):
    _routine(served["conn"])
    first = served["read"]()
    second = served["read"]()
    assert served["computed"]["n"] == 1
    assert second == first


def test_a_run_starting_and_a_run_ending_are_each_read_afresh(served):
    conn = served["conn"]
    routine = _routine(conn)
    assert served["read"]()["counts"]["alarms"] == 0
    run = _started(conn, routine_id=routine)
    served["read"]()
    assert served["computed"]["n"] == 2
    _ended(conn, run)
    after = served["read"]()
    assert served["computed"]["n"] == 3
    assert after["counts"]["alarms"] == 1, "the run that ended is in the answer"


def test_a_mute_and_an_unmute_are_each_read_afresh(served):
    conn = served["conn"]
    _ended(conn, _started(conn))
    _routine(conn)
    key = served["read"]()["findings"][0]["key"]
    served["client"].post("/api/watchdog/mute", json={"finding_key": key})
    assert served["read"]()["findings"][0]["muted"] is True
    served["client"].post("/api/watchdog/unmute", json={"finding_key": key})
    assert served["read"]()["findings"][0]["muted"] is False
    assert served["computed"]["n"] == 3


@pytest.mark.parametrize("change", [
    {"schedule_cron": "0 4 * * *"},
    {"parameters": json.dumps({"query": "y", "repositories": ["nasa_ads"]})},
    {"is_active": 0},
    {"name": "Renamed watch"},
])
def test_any_change_to_a_watch_is_read_afresh(served, change):
    conn = served["conn"]
    routine = _routine(conn)
    served["read"]()
    update_routine(conn, routine, change)
    served["read"]()
    assert served["computed"]["n"] == 2


def test_a_fire_skipped_is_read_afresh_and_reported(served):
    conn = served["conn"]
    routine = _routine(conn)
    assert served["read"]()["findings"] == []
    record_missed_fire(conn, routine, (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat(),
                       disposition="skipped")
    after = served["read"]()
    assert served["computed"]["n"] == 2
    assert any(f["kind"] == "routine_fires_skipped" for f in after["findings"])


def test_a_stored_setting_changing_is_read_afresh(served):
    served["read"]()
    set_setting(served["conn"], "ai_provider", "anthropic")
    served["read"]()
    assert served["computed"]["n"] == 2


def test_a_run_deleted_is_read_afresh(served):
    conn = served["conn"]
    _routine(conn)
    run = _started(conn)
    _ended(conn, run)
    assert served["read"]()["counts"]["alarms"] == 1
    conn.execute("DELETE FROM executions WHERE id = ?", (run,))
    conn.commit()
    assert served["read"]()["counts"]["alarms"] == 0
    assert served["computed"]["n"] == 2


def test_after_the_keep_time_the_clock_is_read_again(served):
    _routine(served["conn"])
    served["read"]()
    served["clock"]["t"] += watchdog.KEEP_SECONDS - 1
    served["read"]()
    assert served["computed"]["n"] == 1, "inside the keep time, the kept answer"
    served["clock"]["t"] += 2
    served["read"]()
    assert served["computed"]["n"] == 2, "past it, a fresh one: clock-based findings stay current"


def test_another_database_never_shares_the_kept_answer(served):
    resmon_mod = served["module"]
    _routine(served["conn"])
    served["read"]()
    # A reset (as a restore makes) starts a new database generation.
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod._db_generation += 1
    served["read"]()
    assert served["computed"]["n"] == 2
