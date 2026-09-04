"""The watchdog: does it alarm when it should, and stay quiet when it should not.

The failure mode this suite exists to prevent is the one named in the proposal:
a watchdog that cries wolf gets muted, and then the real failure is missed too.
So the most load-bearing test here is not one that fires an alarm — it is
``test_a_healthy_install_produces_no_alarms``, which builds a busy, entirely
normal install and asserts silence.

The rest pin each rule at its threshold from both sides: one run short of the
threshold must produce nothing, and the threshold itself must produce exactly
one finding of the right severity. ``broken`` and ``unusual`` are held apart
deliberately — the first is a recorded fact, the second an inference — and a
rule that promoted an inference to a fact would be a regression even though
both are "an alarm".
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import watchdog  # noqa: E402
from implementation_scripts.database import (  # noqa: E402
    get_execution_sources,
    init_db,
    insert_document,
    insert_execution,
    insert_routine,
    record_execution_source,
    sources_from_progress_events,
    update_execution_status,
)

NOW = datetime(2026, 8, 20, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_db(conn=c)
    yield c
    c.close()


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _ts(days_ago: float) -> str:
    return (NOW - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _run(
    conn,
    *,
    days_ago: float,
    sources: dict[str, dict] | None = None,
    routine_id: int | None = None,
    new_results: int = 0,
    status: str = "completed",
):
    """One execution, with whatever each of its sources did."""
    exec_id = insert_execution(conn, {
        "execution_type": "automated_sweep" if routine_id else "deep_sweep",
        "routine_id": routine_id,
        "parameters": json.dumps({"query": "x"}),
        "start_time": _ts(days_ago),
        "status": "running",
    })
    for source, outcome in (sources or {}).items():
        record_execution_source(
            conn, exec_id, source,
            outcome.get("status", "ok"),
            result_count=outcome.get("result_count", 0),
            error_message=outcome.get("error_message"),
            credential_name=outcome.get("credential_name"),
            zero_reason=outcome.get("zero_reason"),
            zero_detail=(
                json.dumps(outcome["zero_detail"])
                if outcome.get("zero_detail") else None
            ),
        )
    update_execution_status(
        conn, exec_id, status,
        end_time=_ts(days_ago),
        new_result_count=new_results,
        result_count=sum(
            (o.get("result_count", 0) for o in (sources or {}).values()), 0,
        ),
    )
    return exec_id


def _routine(conn, name="Nightly arXiv", sources=("arxiv",), active=True):
    return insert_routine(conn, {
        "name": name,
        "schedule_cron": "0 3 * * *",
        "parameters": json.dumps({"query": "x", "repositories": list(sources)}),
        "is_active": 1 if active else 0,
    })


def _keys(report) -> set[str]:
    return {f["key"] for f in report["findings"]}


def _by_kind(report, kind) -> list[dict]:
    return [f for f in report["findings"] if f["kind"] == kind]


# ---------------------------------------------------------------------------
# The quiet cases — what must NOT alarm
# ---------------------------------------------------------------------------


def test_an_empty_install_says_nothing_to_check_not_all_clear(conn):
    """No history is not a clean bill of health, and must not read as one."""
    report = watchdog.report(conn, now=NOW)

    assert report["sufficient"] is False
    assert report["findings"] == []
    assert report["counts"]["alarms"] == 0


def test_a_healthy_install_produces_no_alarms(conn):
    """A busy, normal install: twenty runs, two sources, results every time.

    If this ever starts producing findings, the watchdog has become the thing
    the proposal warned about and every other test here is worthless.
    """
    routine_id = _routine(conn, sources=("arxiv", "pubmed"))
    for i in range(20):
        _run(
            conn,
            days_ago=i,
            routine_id=routine_id,
            new_results=3,
            sources={
                "arxiv": {"status": "ok", "result_count": 40 + i},
                "pubmed": {"status": "ok", "result_count": 12},
            },
        )

    report = watchdog.report(conn, now=NOW)

    assert report["sufficient"] is True
    assert report["counts"]["alarms"] == 0, report["findings"]
    assert report["counts"]["broken"] == 0
    assert report["counts"]["unusual"] == 0


def test_a_single_bad_run_is_not_a_finding(conn):
    """One error is weather, not climate."""
    for i in range(8):
        outcome = (
            {"status": "error", "error_message": "503"} if i == 0
            else {"status": "ok", "result_count": 20}
        )
        _run(conn, days_ago=i, sources={"arxiv": outcome})

    assert _by_kind(watchdog.report(conn, now=NOW), "source_errors") == []


def test_a_paused_routine_is_never_reported_as_overdue(conn):
    """Not firing is the point of pausing it."""
    routine_id = _routine(conn, active=False)
    for i in range(5):
        _run(conn, days_ago=90 + i, routine_id=routine_id,
             sources={"arxiv": {"status": "ok", "result_count": 10}})

    assert _by_kind(watchdog.report(conn, now=NOW), "routine_overdue") == []


def test_a_cancelled_run_is_not_held_against_a_source(conn):
    """The user stopped it; that says nothing about the source."""
    for i in range(6):
        _run(conn, days_ago=i, sources={
            "arxiv": {"status": "cancelled", "error_message": "cancelled by user"},
        })

    report = watchdog.report(conn, now=NOW)
    assert report["counts"]["alarms"] == 0


def test_a_run_still_in_flight_is_not_counted(conn):
    """Half its sources are recorded; treating the rest as absent would lie."""
    for i in range(1, 8):
        _run(conn, days_ago=i, sources={
            "arxiv": {"status": "ok", "result_count": 20},
            "pubmed": {"status": "ok", "result_count": 5},
        })
    # A sweep in progress: arXiv has answered, pubmed has not been reached.
    _run(conn, days_ago=0, status="running",
         sources={"arxiv": {"status": "ok", "result_count": 20}})

    report = watchdog.report(conn, now=NOW)
    assert report["counts"]["alarms"] == 0


# ---------------------------------------------------------------------------
# Rule: consecutive errors → broken
# ---------------------------------------------------------------------------


def test_two_consecutive_errors_are_below_the_threshold(conn):
    for i in range(8):
        outcome = (
            {"status": "error", "error_message": "503"} if i < 2
            else {"status": "ok", "result_count": 20}
        )
        _run(conn, days_ago=i, sources={"arxiv": outcome})

    assert _by_kind(watchdog.report(conn, now=NOW), "source_errors") == []


def test_three_consecutive_errors_are_reported_as_broken(conn):
    for i in range(8):
        outcome = (
            {"status": "error", "error_message": "HTTP 503 from arxiv.org"}
            if i < watchdog.CONSECUTIVE_ERRORS
            else {"status": "ok", "result_count": 20}
        )
        _run(conn, days_ago=i, sources={"arxiv": outcome})

    findings = _by_kind(watchdog.report(conn, now=NOW), "source_errors")
    assert len(findings) == 1
    finding = findings[0]
    assert finding["severity"] == "broken"
    assert finding["evidence"]["consecutive_errors"] == 3
    # The actual error is quoted, not paraphrased — the user has to be able to
    # act on it without opening a log file.
    assert "HTTP 503 from arxiv.org" in finding["detail"]
    assert finding["evidence"]["last_success_at"] is not None


def test_an_error_streak_that_has_recovered_is_not_reported(conn):
    """Newest first: a good run on top of three bad ones ends the streak."""
    _run(conn, days_ago=0, sources={"arxiv": {"status": "ok", "result_count": 20}})
    for i in range(1, 4):
        _run(conn, days_ago=i, sources={
            "arxiv": {"status": "error", "error_message": "503"},
        })

    assert _by_kind(watchdog.report(conn, now=NOW), "source_errors") == []


# ---------------------------------------------------------------------------
# Rule: a required key is missing → broken
# ---------------------------------------------------------------------------


def test_a_missing_key_is_reported_as_a_fact_not_an_inference(conn):
    _routine(conn, name="ADS watch", sources=("nasa_ads",))
    _run(conn, days_ago=1, sources={
        "nasa_ads": {
            "status": "skipped_missing_key",
            "credential_name": "nasa_ads_api_key",
            "result_count": 0,
        },
    })

    findings = _by_kind(watchdog.report(conn, now=NOW), "source_missing_key")
    assert len(findings) == 1
    finding = findings[0]
    assert finding["severity"] == "broken"
    assert finding["evidence"]["credential_name"] == "nasa_ads_api_key"
    assert finding["evidence"]["selected_by_active_routines"] == ["ADS watch"]
    # It must say why it is certain rather than implying it worked it out.
    assert "checks for the key before querying" in finding["detail"]


def test_an_old_one_off_sweep_does_not_alarm_forever(conn):
    """A keyless source used once last year is not an ongoing problem."""
    _run(conn, days_ago=200, sources={
        "nasa_ads": {
            "status": "skipped_missing_key",
            "credential_name": "nasa_ads_api_key",
        },
    })

    assert _by_kind(watchdog.report(conn, now=NOW), "source_missing_key") == []


def test_an_old_missing_key_still_alarms_if_a_routine_selects_it(conn):
    """Because that routine is returning nothing from it on every fire."""
    _routine(conn, name="ADS watch", sources=("nasa_ads",))
    _run(conn, days_ago=200, sources={
        "nasa_ads": {
            "status": "skipped_missing_key",
            "credential_name": "nasa_ads_api_key",
        },
    })

    assert len(_by_kind(watchdog.report(conn, now=NOW), "source_missing_key")) == 1


# ---------------------------------------------------------------------------
# Rule: a productive source has gone quiet → unusual
# ---------------------------------------------------------------------------


def _quiet_source(conn, zeros: int, baseline: int = 6, baseline_count: int = 30):
    for i in range(zeros):
        _run(conn, days_ago=i, sources={"arxiv": {"status": "ok", "result_count": 0}})
    for i in range(baseline):
        _run(conn, days_ago=zeros + i,
             sources={"arxiv": {"status": "ok", "result_count": baseline_count}})


def test_three_empty_runs_are_below_the_threshold(conn):
    _quiet_source(conn, zeros=watchdog.CONSECUTIVE_ZEROS - 1)
    assert _by_kind(watchdog.report(conn, now=NOW), "source_quiet") == []


def test_four_empty_runs_after_a_baseline_are_reported_as_unusual(conn):
    _quiet_source(conn, zeros=watchdog.CONSECUTIVE_ZEROS)

    findings = _by_kind(watchdog.report(conn, now=NOW), "source_quiet")
    assert len(findings) == 1
    finding = findings[0]
    # An inference, never a fact. This is the distinction the whole feature
    # rests on: the innocent explanation is genuinely possible.
    assert finding["severity"] == "unusual"
    assert finding["evidence"]["typical_results"] == 30
    assert finding["evidence"]["zero_runs"] == watchdog.CONSECUTIVE_ZEROS
    assert "cannot tell which" in finding["detail"]


def test_a_source_with_no_baseline_is_reported_as_unjudged_not_quiet(conn):
    """Four zeros and nothing before them is not evidence of anything."""
    _quiet_source(conn, zeros=4, baseline=0)

    report = watchdog.report(conn, now=NOW)
    assert _by_kind(report, "source_quiet") == []
    unjudged = [u for u in report["not_enough_data"]
                if u["scope"]["id"] == "arxiv"]
    assert len(unjudged) == 1
    assert unjudged[0]["runs_needed"] == watchdog.MIN_BASELINE_RUNS


def test_a_source_that_was_always_sparse_is_not_called_quiet(conn):
    """Zero is its normal. Only a source that *used to* deliver can go quiet."""
    for i in range(4):
        _run(conn, days_ago=i, sources={"arxiv": {"status": "ok", "result_count": 0}})
    for i in range(6):
        # One productive run in the baseline — below the required minimum.
        count = 5 if i == 0 else 0
        _run(conn, days_ago=4 + i, sources={"arxiv": {"status": "ok", "result_count": count}})

    assert _by_kind(watchdog.report(conn, now=NOW), "source_quiet") == []


# ---------------------------------------------------------------------------
# Rule: a routine is overdue against its own observed cadence → broken
# ---------------------------------------------------------------------------


def test_a_routine_slightly_late_is_not_overdue(conn):
    """Daily, two days silent. Within 3× and not worth waking anyone for."""
    routine_id = _routine(conn)
    for i in range(6):
        _run(conn, days_ago=2 + i, routine_id=routine_id, new_results=2,
             sources={"arxiv": {"status": "ok", "result_count": 20}})

    assert _by_kind(watchdog.report(conn, now=NOW), "routine_overdue") == []


def test_a_daily_routine_silent_for_a_week_is_overdue(conn):
    routine_id = _routine(conn)
    for i in range(6):
        _run(conn, days_ago=7 + i, routine_id=routine_id, new_results=2,
             sources={"arxiv": {"status": "ok", "result_count": 20}})

    findings = _by_kind(watchdog.report(conn, now=NOW), "routine_overdue")
    assert len(findings) == 1
    assert findings[0]["severity"] == "broken"
    assert findings[0]["evidence"]["typical_gap_days"] == pytest.approx(1.0, abs=0.01)
    # It points at the real cause rather than at the routine.
    assert "background service" in findings[0]["detail"]


def test_an_hourly_routine_is_given_the_absolute_floor(conn):
    """3× hourly is three hours. A closed laptop explains three hours."""
    routine_id = _routine(conn)
    for i in range(8):
        _run(conn, days_ago=(4 + i) / 24.0, routine_id=routine_id, new_results=1,
             sources={"arxiv": {"status": "ok", "result_count": 20}})

    assert _by_kind(watchdog.report(conn, now=NOW), "routine_overdue") == []


def test_a_routine_with_two_runs_has_no_cadence_to_judge(conn):
    routine_id = _routine(conn)
    for i in range(2):
        _run(conn, days_ago=60 + i, routine_id=routine_id,
             sources={"arxiv": {"status": "ok", "result_count": 20}})

    report = watchdog.report(conn, now=NOW)
    assert _by_kind(report, "routine_overdue") == []
    unjudged = [u for u in report["not_enough_data"]
                if u["scope"]["type"] == "routine"]
    assert len(unjudged) == 1
    assert unjudged[0]["runs_needed"] == watchdog.MIN_RUNS_FOR_CADENCE


# ---------------------------------------------------------------------------
# Rule: a routine has stopped finding anything new → unusual
# ---------------------------------------------------------------------------


def test_a_routine_that_never_found_anything_is_not_flatlined(conn):
    """Nothing has changed. A new routine with a narrow query looks like this."""
    routine_id = _routine(conn)
    for i in range(9):
        _run(conn, days_ago=i, routine_id=routine_id, new_results=0,
             sources={"arxiv": {"status": "ok", "result_count": 20}})

    assert _by_kind(watchdog.report(conn, now=NOW), "routine_flatlined") == []


def test_a_routine_that_used_to_deliver_and_stopped_is_unusual(conn):
    routine_id = _routine(conn)
    for i in range(watchdog.FLATLINE_RUNS):
        _run(conn, days_ago=i, routine_id=routine_id, new_results=0,
             sources={"arxiv": {"status": "ok", "result_count": 20}})
    for i in range(4):
        _run(conn, days_ago=watchdog.FLATLINE_RUNS + i, routine_id=routine_id,
             new_results=3, sources={"arxiv": {"status": "ok", "result_count": 20}})

    findings = _by_kind(watchdog.report(conn, now=NOW), "routine_flatlined")
    assert len(findings) == 1
    assert findings[0]["severity"] == "unusual"
    # The innocent explanation is offered in the same breath as the finding.
    assert "perfectly healthy" in findings[0]["detail"]


def test_four_quiet_runs_are_below_the_flatline_threshold(conn):
    routine_id = _routine(conn)
    for i in range(watchdog.FLATLINE_RUNS - 1):
        _run(conn, days_ago=i, routine_id=routine_id, new_results=0,
             sources={"arxiv": {"status": "ok", "result_count": 20}})
    for i in range(4):
        _run(conn, days_ago=watchdog.FLATLINE_RUNS + i, routine_id=routine_id,
             new_results=3, sources={"arxiv": {"status": "ok", "result_count": 20}})

    assert _by_kind(watchdog.report(conn, now=NOW), "routine_flatlined") == []


# ---------------------------------------------------------------------------
# Cadence advice
# ---------------------------------------------------------------------------


def _slow_source_corpus(conn, *, lag_days: int, papers: int = 8):
    """Papers whose first_seen_at trails their publication date by ``lag_days``."""
    for i in range(papers):
        doc_id = insert_document(conn, {
            "source_repository": "nasa_ads",
            "external_id": f"ads-{i}",
            "doi": None,
            "title": f"Paper {i}",
            "authors": "A. Author",
            "abstract": "x",
            "publication_date": _ts(30 + i + lag_days)[:10],
            "url": "https://example.org",
            "categories": "astro-ph",
            "metadata_hash": f"h-{i}",
        })
        conn.execute(
            "UPDATE documents SET first_seen_at = ? WHERE id = ?",
            (_ts(30 + i), doc_id),
        )
    conn.commit()


def test_cadence_advice_fires_when_a_source_cannot_keep_up(conn):
    routine_id = _routine(conn, name="ADS daily", sources=("nasa_ads",))
    for i in range(6):
        _run(conn, days_ago=i, routine_id=routine_id, new_results=2,
             sources={"nasa_ads": {"status": "ok", "result_count": 12}})
    _slow_source_corpus(conn, lag_days=6)

    findings = _by_kind(watchdog.report(conn, now=NOW), "cadence_advice")
    assert len(findings) == 1
    finding = findings[0]
    assert finding["severity"] == "advice"
    # The honest caveat travels with the advice: this lag was measured through
    # the very polling interval it is being compared against.
    assert finding["evidence"]["lag_includes_polling_interval"] is True
    assert "at most this, never more" in finding["detail"]


def test_advice_is_not_an_alarm(conn):
    routine_id = _routine(conn, name="ADS daily", sources=("nasa_ads",))
    for i in range(6):
        _run(conn, days_ago=i, routine_id=routine_id, new_results=2,
             sources={"nasa_ads": {"status": "ok", "result_count": 12}})
    _slow_source_corpus(conn, lag_days=6)

    report = watchdog.report(conn, now=NOW)
    assert report["counts"]["advice"] == 1
    assert report["counts"]["alarms"] == 0


def test_no_cadence_advice_when_the_source_keeps_up(conn):
    routine_id = _routine(conn, name="ADS daily", sources=("nasa_ads",))
    for i in range(6):
        _run(conn, days_ago=i, routine_id=routine_id, new_results=2,
             sources={"nasa_ads": {"status": "ok", "result_count": 12}})
    _slow_source_corpus(conn, lag_days=1)

    assert _by_kind(watchdog.report(conn, now=NOW), "cadence_advice") == []


# ---------------------------------------------------------------------------
# Mutes
# ---------------------------------------------------------------------------


def test_a_muted_finding_stays_visible_but_stops_counting(conn):
    _routine(conn, name="ADS watch", sources=("nasa_ads",))
    _run(conn, days_ago=1, sources={
        "nasa_ads": {"status": "skipped_missing_key",
                     "credential_name": "nasa_ads_api_key"},
    })

    before = watchdog.report(conn, now=NOW)
    assert before["counts"]["alarms"] == 1
    key = before["findings"][0]["key"]

    watchdog.mute(conn, key, note="I do not have an ADS account")
    after = watchdog.report(conn, now=NOW)

    assert after["counts"]["alarms"] == 0
    assert after["counts"]["muted"] == 1
    # Still listed — muting is an acknowledgement, not a deletion.
    assert key in _keys(after)
    assert after["findings"][0]["muted"] is True


def test_unmuting_restores_the_alarm(conn):
    _routine(conn, name="ADS watch", sources=("nasa_ads",))
    _run(conn, days_ago=1, sources={
        "nasa_ads": {"status": "skipped_missing_key",
                     "credential_name": "nasa_ads_api_key"},
    })
    key = watchdog.report(conn, now=NOW)["findings"][0]["key"]

    watchdog.mute(conn, key)
    watchdog.unmute(conn, key)

    assert watchdog.report(conn, now=NOW)["counts"]["alarms"] == 1


def test_a_mute_is_dropped_once_its_condition_clears(conn):
    """Otherwise the same source failing again later would be swallowed."""
    for i in range(4):
        _run(conn, days_ago=10 + i, sources={
            "arxiv": {"status": "error", "error_message": "503"},
        })
    key = _by_kind(watchdog.report(conn, now=NOW), "source_errors")[0]["key"]
    watchdog.mute(conn, key)
    assert key in watchdog.get_mutes(conn)

    # arXiv recovers.
    _run(conn, days_ago=0, sources={"arxiv": {"status": "ok", "result_count": 20}})
    watchdog.report(conn, now=NOW)
    assert key not in watchdog.get_mutes(conn)

    # And when it fails again, it is news again.
    for i in range(3):
        _run(conn, days_ago=-1 - i, sources={
            "arxiv": {"status": "error", "error_message": "503"},
        })
    assert watchdog.report(conn, now=NOW + timedelta(days=5))["counts"]["alarms"] >= 1


# ---------------------------------------------------------------------------
# The per-source record itself
# ---------------------------------------------------------------------------


def test_missing_key_outranks_the_error_it_causes(conn):
    """A 401 caused by an absent key must be reported as the absent key.

    Reporting the symptom would send the user hunting for a fault that is not
    there. Precedence is cancelled > skipped_missing_key > error > ok.
    """
    records = sources_from_progress_events([
        {"type": "repo_skipped_missing_key", "repository": "core",
         "credential_name": "core_api_key"},
        {"type": "repo_error", "repository": "core", "error": "HTTP 401"},
    ])

    assert len(records) == 1
    assert records[0]["status"] == "skipped_missing_key"
    assert records[0]["credential_name"] == "core_api_key"
    # The underlying error is still kept — it is just not the headline.
    assert records[0]["error_message"] == "HTTP 401"


def test_a_result_count_survives_promotion_to_a_worse_status(conn):
    records = sources_from_progress_events([
        {"type": "repo_done", "repository": "core", "result_count": 7},
        {"type": "repo_skipped_missing_key", "repository": "core",
         "credential_name": "core_api_key"},
    ])

    assert records[0]["status"] == "skipped_missing_key"
    assert records[0]["result_count"] == 7


def test_a_user_cancellation_outranks_everything(conn):
    records = sources_from_progress_events([
        {"type": "repo_done", "repository": "arxiv", "result_count": 3},
        {"type": "repo_error", "repository": "arxiv", "error": "cancelled by user"},
    ])

    assert records[0]["status"] == "cancelled"


def test_backfill_reads_history_recorded_before_the_table_existed(conn):
    """A user upgrading has months of per-source facts in progress_events.

    Without the backfill the watchdog would report "not enough data" on an
    install with two years of history, which is both useless and untrue.
    """
    exec_id = insert_execution(conn, {
        "execution_type": "deep_sweep",
        "routine_id": None,
        "parameters": "{}",
        "start_time": _ts(3),
        "status": "completed",
    })
    conn.execute(
        "UPDATE executions SET progress_events = ? WHERE id = ?",
        (json.dumps([
            {"type": "repo_done", "repository": "arxiv", "result_count": 41},
            {"type": "repo_error", "repository": "pubmed", "error": "HTTP 500"},
        ]), exec_id),
    )
    # Clear the one-shot guard so the migration runs against this new history.
    conn.execute("DELETE FROM app_settings WHERE key = 'execution_sources_backfilled'")
    conn.execute("DELETE FROM execution_sources")
    conn.commit()

    init_db(conn=conn)

    recorded = {r["source"]: r for r in get_execution_sources(conn, exec_id)}
    assert recorded["arxiv"]["status"] == "ok"
    assert recorded["arxiv"]["result_count"] == 41
    assert recorded["pubmed"]["status"] == "error"
    assert recorded["pubmed"]["error_message"] == "HTTP 500"


def test_the_backfill_does_not_run_twice(conn):
    """It reads every stored blob; on a large install that is not free."""
    assert conn.execute(
        "SELECT value FROM app_settings WHERE key = 'execution_sources_backfilled'"
    ).fetchone()[0] == "1"


# ---------------------------------------------------------------------------
# The sweep engine writes the record as it goes
# ---------------------------------------------------------------------------


def test_a_real_sweep_records_what_each_source_did(monkeypatch):
    """Written per source as the run proceeds, not reconstructed afterwards."""
    from implementation_scripts import sweep_engine as se
    from implementation_scripts import credential_manager as cm
    from implementation_scripts.api_base import BaseAPIClient

    class _Empty(BaseAPIClient):
        def get_name(self):
            return "core"

        def search(self, query, date_from=None, date_to=None, max_results=100, **kw):
            return []

    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    init_db(conn=c)

    monkeypatch.setattr(se, "get_client", lambda _name: _Empty())
    monkeypatch.setattr(cm, "get_credential", lambda _name: None)

    engine = se.SweepEngine(db_conn=c, config={})
    result = engine.execute_dive("core", {"query": "x", "max_results": 1})

    recorded = get_execution_sources(c, result["execution_id"])
    assert len(recorded) == 1
    # CORE requires a key and none is configured, so that — not the empty
    # result — is what the record says.
    assert recorded[0]["source"] == "core"
    assert recorded[0]["status"] == "skipped_missing_key"
    assert recorded[0]["credential_name"] == "core_api_key"
    c.close()


# ---------------------------------------------------------------------------
# The endpoints
# ---------------------------------------------------------------------------


def _client():
    import resmon as resmon_mod
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from fastapi.testclient import TestClient
    from resmon import app
    return TestClient(app), resmon_mod


def test_the_endpoint_answers_on_a_fresh_install():
    client, _ = _client()
    body = client.get("/api/watchdog").json()

    assert body["sufficient"] is False
    assert body["findings"] == []
    # The thresholds travel with the answer so the interface can show its work
    # rather than hard-coding numbers that would drift out of step.
    assert body["thresholds"]["consecutive_errors"] == watchdog.CONSECUTIVE_ERRORS


def test_muting_and_unmuting_round_trip_through_the_api():
    client, resmon_mod = _client()
    conn = resmon_mod._get_db()
    _routine(conn, name="ADS watch", sources=("nasa_ads",))
    _run(conn, days_ago=1, sources={
        "nasa_ads": {"status": "skipped_missing_key",
                     "credential_name": "nasa_ads_api_key"},
    })

    body = client.get("/api/watchdog").json()
    assert body["counts"]["alarms"] == 1
    key = body["findings"][0]["key"]

    assert client.post("/api/watchdog/mute", json={"finding_key": key}).status_code == 200
    assert client.get("/api/watchdog").json()["counts"]["alarms"] == 0

    assert client.post("/api/watchdog/unmute", json={"finding_key": key}).status_code == 200
    assert client.get("/api/watchdog").json()["counts"]["alarms"] == 1


def test_a_freshly_muted_finding_is_not_served_from_a_stale_cache():
    """The watchdog shares the analytics fingerprint; muting must invalidate it."""
    client, resmon_mod = _client()
    conn = resmon_mod._get_db()
    _routine(conn, name="ADS watch", sources=("nasa_ads",))
    _run(conn, days_ago=1, sources={
        "nasa_ads": {"status": "skipped_missing_key",
                     "credential_name": "nasa_ads_api_key"},
    })

    key = client.get("/api/watchdog").json()["findings"][0]["key"]
    client.post("/api/watchdog/mute", json={"finding_key": key})

    assert client.get("/api/watchdog").json()["findings"][0]["muted"] is True


# ---------------------------------------------------------------------------
# 1.8.6 — a zero that was never an answer
# ---------------------------------------------------------------------------
#
# Every client degrades rather than raising, so an upstream that answers 503
# is recorded ``ok / 0`` and, until schema 10, was indistinguishable here from
# a quiet field. These pin the calibrated change: an outage now counts as a
# failure to answer, and no run where the source did not answer can be part of
# a baseline of what it normally returns.


def _outage(attempts: int = 3, status: int = 503) -> dict:
    return {
        "status": "ok", "result_count": 0, "zero_reason": "upstream_failure",
        "zero_detail": {"detail": f"http_{status}", "status": status,
                        "attempts": attempts},
    }


def test_three_consecutive_outages_are_reported_as_a_broken_source(conn):
    """The finding this phase exists to make possible.

    Before schema 10 these three runs were ``ok / 0`` and produced nothing at
    all: not an error finding, because nothing raised, and not a quiet finding
    either, because four zeros are needed and there is a productive baseline
    right behind them.
    """
    for days in (40, 35, 30, 25, 20):
        _run(conn, days_ago=days, sources={"arxiv": {"result_count": 30}})
    for days in (3, 2, 1):
        _run(conn, days_ago=days, sources={"arxiv": _outage()})

    report = watchdog.report(conn, now=NOW)
    findings = _by_kind(report, "source_errors")

    assert len(findings) == 1
    assert findings[0]["severity"] == "broken"
    # The old wording said every counted run "raised an error". A 503 raises
    # nothing, and the sentence must not say it did.
    assert "raised an error" not in findings[0]["detail"]
    assert "resmon got no answer from arxiv" in findings[0]["detail"]
    assert "answered HTTP 503" in findings[0]["detail"]
    # And it last answered 20 days ago, not an hour ago.
    assert "It last answered successfully" in findings[0]["detail"]
    assert findings[0]["evidence"]["last_success_at"] == _ts(20)


def test_last_answered_successfully_does_not_count_a_run_with_no_answer(conn):
    """The half of the fix that is easiest to miss.

    An ``ok / 0`` outage row satisfies ``status == 'ok'``, so the old query
    picked the most recent outage as the last success and told the user the
    source had answered an hour ago while it was in fact down.
    """
    _run(conn, days_ago=30, sources={"arxiv": {"result_count": 30}})
    for days in (3, 2, 1):
        _run(conn, days_ago=days, sources={"arxiv": _outage()})

    findings = _by_kind(watchdog.report(conn, now=NOW), "source_errors")

    assert findings[0]["evidence"]["last_success_at"] == _ts(30)


def test_a_mixed_history_yields_exactly_one_true_finding(conn):
    """[outage, outage, 0, 0, 0, 0 | productive baseline].

    Two outages are one short of the failure threshold, so the consecutive
    rule stays quiet. The four zeros behind them are real answers, and the
    baseline behind those is productive — so this is a `source_quiet`, and its
    sentence must describe the four zeros rather than the six.
    """
    for days in (60, 55, 50, 45, 40):
        _run(conn, days_ago=days, sources={"arxiv": {"result_count": 30}})
    for days in (20, 15, 10, 8):
        _run(conn, days_ago=days, sources={"arxiv": {"result_count": 0}})
    for days in (2, 1):
        _run(conn, days_ago=days, sources={"arxiv": _outage()})

    report = watchdog.report(conn, now=NOW)
    source_findings = [
        f for f in report["findings"] if f["scope"].get("id") == "arxiv"
    ]

    assert len(source_findings) == 1
    finding = source_findings[0]
    assert finding["kind"] == "source_quiet"
    # The two outages are not answers, so they are not part of the streak of
    # zeros the sentence counts.
    assert "its last 4 runs" in finding["title"]
    assert finding["severity"] == "unusual"


def test_an_unanswerable_window_is_not_a_fault_and_never_alarms(conn):
    """ERIC refusing a sub-year window is the source behaving correctly.

    Alarming on it would train people to ignore the watchdog, which is the
    failure this whole file exists to prevent.
    """
    for days in (40, 35, 30, 25, 20, 3, 2, 1):
        _run(conn, days_ago=days, sources={"eric": {
            "status": "ok", "result_count": 0,
            "zero_reason": "window_unanswerable",
            "zero_detail": {"detail": "year_granularity"},
        }})

    report = watchdog.report(conn, now=NOW)

    assert [f for f in report["findings"] if f["scope"].get("id") == "eric"] == []


def test_a_baseline_is_not_built_from_runs_the_source_never_answered(conn):
    """The calibrated change, and the direction it moves in.

    Five outages used to be five baseline runs, and a source that had been
    down for its entire recorded history could satisfy MIN_BASELINE_RUNS. It
    is now `unjudged`, and the reason says how many runs were set aside and
    why rather than claiming there is no history.
    """
    for days in (40, 35, 30, 25, 20):
        _run(conn, days_ago=days, sources={"crossref": _outage()})
    # One real answer, so the consecutive-failure rule does not fire instead.
    _run(conn, days_ago=1, sources={"crossref": {"result_count": 12}})

    report = watchdog.report(conn, now=NOW)
    unjudged = [
        u for u in report["not_enough_data"] if u["scope"].get("id") == "crossref"
    ]

    assert len(unjudged) == 1
    assert unjudged[0]["runs_recorded"] == 1
    assert unjudged[0]["runs_not_a_measurement"] == 5
    assert "not a measurement of the field" in unjudged[0]["reason"]
    assert _by_kind(report, "source_quiet") == []


def test_history_written_before_schema_10_reads_exactly_as_it_used_to(conn):
    """A NULL reason keeps the pre-1.8.6 reading, on purpose.

    Every row in every existing install has one. Treating an unexplained zero
    as an outage would invent findings about runs nobody observed — which is
    the same overclaim as inventing the reason itself.
    """
    for days in (40, 35, 30, 25, 20):
        _run(conn, days_ago=days, sources={"arxiv": {"result_count": 30}})
    for days in (8, 6, 4, 2):
        _run(conn, days_ago=days, sources={"arxiv": {"result_count": 0}})

    report = watchdog.report(conn, now=NOW)
    findings = _by_kind(report, "source_quiet")

    assert len(findings) == 1
    assert _by_kind(report, "source_errors") == []


# ---------------------------------------------------------------------------
# Reconciliation 1 — a reply that cannot be read is a failure to answer
# ---------------------------------------------------------------------------
#
# 1.8.6 shipped with ``parse_failure`` dropped from the baseline but not
# treated as a failure, so a source that returned an unreadable reply on every
# run reached `unjudged` and raised no alarm. The planning session decided
# otherwise on reconciliation, and the reasoning is that this is the shape the
# watchdog most exists to catch: nothing raises, every run reads ``ok``, and
# the user gets nothing for a fortnight.


def _unreadable(kind: str = "parse_error") -> dict:
    return {
        "status": "ok", "result_count": 0, "zero_reason": "parse_failure",
        "zero_detail": {"detail": kind},
    }


def test_three_consecutive_unreadable_replies_are_reported_as_broken(conn):
    for days in (40, 35, 30, 25, 20):
        _run(conn, days_ago=days, sources={"arxiv": {"result_count": 30}})
    for days in (3, 2, 1):
        _run(conn, days_ago=days, sources={"arxiv": _unreadable()})

    report = watchdog.report(conn, now=NOW)
    findings = _by_kind(report, "source_errors")

    assert len(findings) == 1
    assert findings[0]["severity"] == "broken"
    # Nothing raised, and the sentence must not say it did.
    assert "raised an error" not in findings[0]["detail"]
    assert "resmon got no answer from arxiv" in findings[0]["detail"]
    # And it must not say the source was unreachable, which would send the
    # user to check a network that is working. It answered; resmon could not
    # read what it said.
    assert (
        "the source answered and resmon could not read the reply"
        in findings[0]["detail"]
    )
    assert "HTTP" not in findings[0]["detail"]
    assert findings[0]["evidence"]["last_zero_reason"] == "parse_failure"
    assert findings[0]["evidence"]["last_success_at"] == _ts(20)


def test_an_incomplete_page_says_which_kind_of_unreadable_it_was(conn):
    for days in (40, 35, 30):
        _run(conn, days_ago=days, sources={"ndl_search": {"result_count": 8}})
    for days in (3, 2, 1):
        _run(conn, days_ago=days,
             sources={"ndl_search": _unreadable("incomplete_page")})

    findings = _by_kind(watchdog.report(conn, now=NOW), "source_errors")

    assert len(findings) == 1
    assert "the page it returned was incomplete" in findings[0]["detail"]


def test_two_unreadable_replies_are_one_short_of_the_threshold(conn):
    """The threshold is unchanged: CONSECUTIVE_ERRORS is still three."""
    for days in (40, 35, 30, 25, 20):
        _run(conn, days_ago=days, sources={"arxiv": {"result_count": 30}})
    for days in (2, 1):
        _run(conn, days_ago=days, sources={"arxiv": _unreadable()})

    report = watchdog.report(conn, now=NOW)

    assert _by_kind(report, "source_errors") == []


def test_an_outage_and_an_unreadable_reply_count_toward_the_same_streak(conn):
    """Both are failures to get an answer, so they are one streak, not two.

    Counting them separately would let a source alternate between the two
    failure modes forever without ever reaching either threshold.
    """
    for days in (40, 35, 30, 25, 20):
        _run(conn, days_ago=days, sources={"arxiv": {"result_count": 30}})
    _run(conn, days_ago=3, sources={"arxiv": _outage()})
    _run(conn, days_ago=2, sources={"arxiv": _unreadable()})
    _run(conn, days_ago=1, sources={"arxiv": _outage()})

    findings = _by_kind(watchdog.report(conn, now=NOW), "source_errors")

    assert len(findings) == 1
    assert findings[0]["evidence"]["consecutive_errors"] == 3
    # The detail quotes the most recent run, which was the outage.
    assert "the source answered HTTP 503" in findings[0]["detail"]
