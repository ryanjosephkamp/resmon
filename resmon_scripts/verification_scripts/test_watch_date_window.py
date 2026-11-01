"""A watch's window that moves: papers published since its previous run, or in
the last N days, turned into real dates when it fires.

A watch with fixed dates asked for the same days for ever, and one with no
dates asked each source for its own order, which for a relevance-ranked source
is the most relevant papers of all years, mostly the same ones every run. These
cases hold the third choice to what it promises: the dates are computed at the
fire (scheduled or Run now, one code path), from the previous run in which a
source actually answered, with a stated overlap, and written into the run's own
parameters so every account of the run states the dates it asked.
"""

from __future__ import annotations

import json
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database, date_window, search_record  # noqa: E402
from implementation_scripts.admission import admission  # noqa: E402
from implementation_scripts.progress import progress_store  # noqa: E402
from implementation_scripts.repo_catalog import REPOSITORY_CATALOG  # noqa: E402
from implementation_scripts.report_generator import generate_report  # noqa: E402

UTC = timezone.utc
NOW = datetime(2026, 10, 30, 14, 0, tzinfo=UTC)


def _reset_state() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    resmon_mod._get_db()
    with admission._lock:
        admission._active.clear()
        admission._queue.clear()
    admission.set_max(3)
    admission.set_queue_limit(16)


def _fast_run_prepared(self, exec_id: int) -> dict:
    progress_store.emit(exec_id, {"type": "execution_start", "execution_id": exec_id})
    progress_store.mark_complete(exec_id)
    database.update_execution_status(self.db, exec_id, "completed")
    return {"execution_id": exec_id, "status": "completed"}


@pytest.fixture(autouse=True)
def _fresh():
    _reset_state()
    yield
    resmon_mod.close_db()


@pytest.fixture
def client():
    return TestClient(resmon_mod.app)


@pytest.fixture
def conn():
    return resmon_mod._get_db()


def _routine(conn, parameters: dict) -> int:
    return database.insert_routine(conn, {
        "name": "window-test", "schedule_cron": "0 8 * * *",
        "parameters": json.dumps(parameters), "is_active": 0,
    })


def _run(conn, routine_id: int, start: str, sources: list[tuple[str, str, int, str | None]],
         status: str = "completed") -> int:
    """A past run of the watch: its start, and what each source did."""
    exec_id = database.insert_execution(conn, {
        "execution_type": "automated_sweep", "routine_id": routine_id,
        "parameters": json.dumps({"repositories": [s[0] for s in sources]}), "start_time": start,
    })
    for slug, source_status, count, reason in sources:
        database.record_execution_source(conn, exec_id, slug, source_status,
                                         result_count=count, zero_reason=reason)
    database.update_execution_status(conn, exec_id, status)
    return exec_id


ANSWERED = [("arxiv", "ok", 4, None)]


# ---------------------------------------------------------------------------
# What a watch may store
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw, stored", [
    ({"since": "previous_run"}, {"since": "previous_run"}),
    ({"last_days": 30}, {"last_days": 30}),
    ({"last_days": 1}, {"last_days": 1}),
    (None, None),
])
def test_the_two_shapes_a_window_is_stored_in(raw, stored):
    assert date_window.normalized(raw) == stored


@pytest.mark.parametrize("raw", [
    {"since": "yesterday"}, {"last_days": 0}, {"last_days": 3651}, {"last_days": 7.5},
    {"last_days": True}, {"last_days": "7"}, {}, {"since": "previous_run", "last_days": 7},
    "previous_run", ["previous_run"],
])
def test_a_window_the_engine_would_read_differently_is_refused(raw):
    with pytest.raises(date_window.WindowError):
        date_window.normalized(raw)


def test_a_moving_window_and_fixed_dates_together_are_refused():
    with pytest.raises(date_window.WindowError, match="not both"):
        date_window.validate_parameters({"date_window": {"since": "previous_run"}, "date_from": "2026-01-01"})
    # Blank dates are no dates: the editor sends the empty strings it always has.
    assert date_window.validate_parameters(
        {"date_window": {"since": "previous_run"}, "date_from": "", "date_to": ""}) == {"since": "previous_run"}


def test_the_routes_refuse_what_cannot_be_stored(client):
    bad = client.post("/api/routines", json={
        "name": "w", "schedule_cron": "0 8 * * *", "is_active": False,
        "parameters": {"keywords": ["a"], "date_window": {"last_days": 0}}})
    assert bad.status_code == 400
    assert "1 to 3650" in bad.json()["detail"]
    both = client.post("/api/routines", json={
        "name": "w", "schedule_cron": "0 8 * * *", "is_active": False,
        "parameters": {"keywords": ["a"], "date_window": {"since": "previous_run"}, "date_to": "2026-05-04"}})
    assert both.status_code == 400
    made = client.post("/api/routines", json={
        "name": "w", "schedule_cron": "0 8 * * *", "is_active": False,
        "parameters": {"keywords": ["a"], "date_window": {"since": "previous_run"}, "date_from": "", "date_to": ""}})
    assert made.status_code == 201
    rid = made.json()["id"]
    changed = client.put(f"/api/routines/{rid}", json={"parameters": {"keywords": ["a"], "date_window": {"weeks": 2}}})
    assert changed.status_code == 400


def test_saved_keeps_the_window_with_its_copy_of_the_watch(client, conn):
    rid = client.post("/api/routines", json={
        "name": "w", "schedule_cron": "0 8 * * *", "is_active": False,
        "parameters": {"keywords": ["a"], "date_window": {"last_days": 14}}}).json()["id"]
    mirror = resmon_mod._find_routine_config(conn, rid)
    assert json.loads(mirror["parameters"])["parameters"]["date_window"] == {"last_days": 14}


# ---------------------------------------------------------------------------
# The window, computed
# ---------------------------------------------------------------------------

def test_a_first_run_asks_for_the_default_window_and_says_why(conn):
    rid = _routine(conn, {"date_window": {"since": "previous_run"}})
    record = date_window.resolve(conn, rid, {"since": "previous_run"}, now=NOW, tz=UTC)
    assert record["basis"] == "no_previous_run"
    assert record["default_days"] == date_window.DEFAULT_DAYS == 7
    assert record["date_from"] == "2026-10-23"
    assert record["date_to"] is None
    assert record["previous_execution_id"] is None
    assert record["sentence"] == (
        "Papers published since the previous run. This watch has no earlier run in which a "
        "source answered, so this run asks for the last 7 days: from October 23, 2026, with no end date.")


def test_the_window_starts_at_the_previous_run_less_the_overlap(conn):
    rid = _routine(conn, {"date_window": {"since": "previous_run"}})
    _run(conn, rid, "2026-10-20T08:00:00Z", ANSWERED)
    previous = _run(conn, rid, "2026-10-29T08:00:00Z", ANSWERED)
    record = date_window.resolve(conn, rid, {"since": "previous_run"}, now=NOW, tz=UTC)
    assert record["basis"] == "previous_run"
    assert record["previous_execution_id"] == previous
    assert record["previous_start_time"] == "2026-10-29T08:00:00Z"
    assert record["overlap_days"] == date_window.OVERLAP_DAYS == 3
    assert record["date_from"] == "2026-10-26"
    assert "from October 26, 2026, with no end date" in record["sentence"]
    assert f"Run {previous}, the latest earlier run in which a source answered, started on October 29, 2026" \
        in record["sentence"]
    assert "starts 3 days before that" in record["sentence"]


def test_the_overlap_is_counted_in_this_computers_days():
    """A run that started at 01:00 UTC started the evening before in New York,
    and the days a person sees the run on are the ones the window counts."""
    from zoneinfo import ZoneInfo
    conn = resmon_mod._get_db()
    rid = _routine(conn, {"date_window": {"since": "previous_run"}})
    _run(conn, rid, "2026-10-29T01:00:00Z", ANSWERED)
    new_york = date_window.resolve(conn, rid, {"since": "previous_run"}, now=NOW, tz=ZoneInfo("America/New_York"))
    utc = date_window.resolve(conn, rid, {"since": "previous_run"}, now=NOW, tz=UTC)
    assert new_york["date_from"] == "2026-10-25"
    assert utc["date_from"] == "2026-10-26"


@pytest.mark.parametrize("what_happened", [
    # Failed before querying: no source was ever recorded.
    [],
    # Every source failed: asked, and not one answered (offline, say).
    [("arxiv", "error", 0, "upstream_failure"), ("crossref", "ok", 0, "upstream_failure")],
    # The only source was never asked for want of a key.
    [("springer", "skipped_missing_key", 0, "missing_key")],
    # A zero whose reason resmon did not record is not an answer.
    [("arxiv", "ok", 0, None)],
])
def test_a_run_in_which_no_source_answered_is_passed_over(conn, what_happened):
    rid = _routine(conn, {"date_window": {"since": "previous_run"}})
    answered = _run(conn, rid, "2026-10-27T08:00:00Z", ANSWERED)
    _run(conn, rid, "2026-10-29T08:00:00Z", what_happened, status="failed")
    record = date_window.resolve(conn, rid, {"since": "previous_run"}, now=NOW, tz=UTC)
    assert record["previous_execution_id"] == answered
    assert record["date_from"] == "2026-10-24"


def test_a_run_that_answered_with_nothing_still_answered(conn):
    rid = _routine(conn, {"date_window": {"since": "previous_run"}})
    quiet = _run(conn, rid, "2026-10-29T08:00:00Z", [("arxiv", "ok", 0, "answered_empty")])
    assert date_window.previous_run(conn, rid)["execution_id"] == quiet


def test_with_no_run_that_answered_the_default_window_is_used(conn):
    rid = _routine(conn, {"date_window": {"since": "previous_run"}})
    _run(conn, rid, "2026-10-29T08:00:00Z", [], status="failed")
    record = date_window.resolve(conn, rid, {"since": "previous_run"}, now=NOW, tz=UTC)
    assert record["basis"] == "no_previous_run"
    assert record["date_from"] == "2026-10-23"


def test_another_watchs_runs_are_not_its_previous_run(conn):
    rid = _routine(conn, {"date_window": {"since": "previous_run"}})
    other = _routine(conn, {})
    _run(conn, other, "2026-10-29T08:00:00Z", ANSWERED)
    assert date_window.previous_run(conn, rid) is None


def test_in_the_last_n_days(conn):
    rid = _routine(conn, {"date_window": {"last_days": 30}})
    _run(conn, rid, "2026-10-29T08:00:00Z", ANSWERED)
    record = date_window.resolve(conn, rid, {"last_days": 30}, now=NOW, tz=UTC)
    assert record["basis"] == "last_days"
    assert record["date_from"] == "2026-09-30"
    assert record["previous_execution_id"] is None
    assert record["sentence"] == "Papers published in the last 30 days: from September 30, 2026, with no end date."


def test_the_upcoming_sentence_is_worded_for_the_watchs_page(conn):
    rid = _routine(conn, {"date_window": {"since": "previous_run"}})
    first = date_window.resolve(conn, rid, {"since": "previous_run"}, now=NOW, tz=UTC, upcoming=True)
    assert first["sentence"].startswith("This watch has no run yet in which a source answered, so its next run asks for the last 7 days: from October 23, 2026")
    run = _run(conn, rid, "2026-10-29T08:00:00Z", ANSWERED)
    after = date_window.resolve(conn, rid, {"since": "previous_run"}, now=NOW, tz=UTC, upcoming=True)
    assert after["sentence"].startswith(f"The next run asks for papers published from October 26, 2026, with no end date: run {run}")
    days = date_window.resolve(conn, rid, {"last_days": 14}, now=NOW, tz=UTC, upcoming=True)
    assert days["sentence"] == ("Each run asks for papers published in the 14 days before it starts: a run today "
                                "asks from October 16, 2026, with no end date.")


# ---------------------------------------------------------------------------
# At the fire: Run now, the recorded dates, and every account of them
# ---------------------------------------------------------------------------

def _execution(conn, exec_id: int) -> dict:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        row = database.get_execution_by_id(conn, exec_id)
        if row and row.get("status") != "running":
            return row
        time.sleep(0.05)
    raise AssertionError(f"execution {exec_id} did not settle")


def _today() -> date:
    return datetime.now(UTC).astimezone().date()


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_run_now_computes_the_window_and_records_the_dates_it_asked(client, conn):
    rid = client.post("/api/routines", json={
        "name": "since", "schedule_cron": "0 8 * * *", "is_active": False,
        "parameters": {"keywords": ["graph"], "query": "graph", "repositories": ["arxiv"],
                       "date_from": "", "date_to": "", "date_window": {"since": "previous_run"}}}).json()["id"]

    preview = client.get(f"/api/routines/{rid}").json()["date_window_next"]
    assert preview["basis"] == "no_previous_run"
    assert preview["date_from"] == (_today() - timedelta(days=7)).isoformat()

    first = client.post(f"/api/routines/{rid}/run").json()["execution_id"]
    row = _execution(conn, first)
    params = json.loads(row["parameters"])
    assert params["date_from"] == (_today() - timedelta(days=7)).isoformat()
    assert params["date_to"] is None
    assert params["date_window"] == {"since": "previous_run"}
    assert params["date_window_computed"]["basis"] == "no_previous_run"
    # The watch itself is not changed by firing: its stored dates stay blank.
    stored = json.loads(database.get_routine_by_id(conn, rid)["parameters"])
    assert stored["date_from"] == "" and stored["date_to"] == ""

    # The first run's source answered, so the second asks from it.
    database.record_execution_source(conn, first, "arxiv", "ok", result_count=2)
    preview = client.get(f"/api/routines/{rid}").json()["date_window_next"]
    assert preview["previous_execution_id"] == first

    second = client.post(f"/api/routines/{rid}/run").json()["execution_id"]
    params = json.loads(_execution(conn, second)["parameters"])
    started = date_window._instant(row["start_time"]).astimezone().date()
    assert params["date_window_computed"]["basis"] == "previous_run"
    assert params["date_window_computed"]["previous_execution_id"] == first
    assert params["date_from"] == (started - timedelta(days=3)).isoformat()
    assert params["date_to"] is None

    # The search record and its Markdown state those dates, and how.
    record = search_record.build(conn, second)
    assert record["search"]["date_from"] == params["date_from"]
    assert record["search"]["date_to"] is None
    assert record["search"]["date_window"]["previous_execution_id"] == first
    markdown = search_record.to_markdown(record)
    assert f"| Publication window | from {params['date_from']}, with no end date |" in markdown
    assert "| How the dates were set | Papers published since the previous run: from " in markdown


def test_the_report_states_the_dates_and_how_they_were_set():
    window = {"sentence": "Papers published since the previous run: from October 26, 2026, with no end date."}
    text = generate_report([], {"query": "graph", "date_from": "2026-10-26", "date_to": None,
                                "date_window": window, "total": 0, "new": 0})
    assert "**Date Range:** from 2026-10-26, with no end date  " in text
    assert f"**How the dates were set:** {window['sentence']}  " in text
    plain = generate_report([], {"query": "graph", "date_from": "", "date_to": "", "total": 0, "new": 0})
    assert "**Date Range:** no date limit  " in plain
    assert "How the dates were set" not in plain
    fixed = generate_report([], {"query": "graph", "date_from": "2026-05-03", "date_to": "2026-05-04", "total": 0})
    assert "**Date Range:** 2026-05-03 to 2026-05-04  " in fixed


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_a_watch_without_a_window_fires_exactly_as_stored(client, conn):
    """Existing watches are not changed: undated stays undated, dated stays dated."""
    for dates in ({"date_from": "2026-05-03", "date_to": "2026-05-04"}, {"date_from": "", "date_to": ""}, {}):
        rid = _routine(conn, {"keywords": ["graph"], "repositories": ["arxiv"], **dates})
        assert "date_window_next" not in client.get(f"/api/routines/{rid}").json()
        exec_id = client.post(f"/api/routines/{rid}/run").json()["execution_id"]
        params = json.loads(_execution(conn, exec_id)["parameters"])
        assert "date_window_computed" not in params
        for key in ("date_from", "date_to"):
            assert params.get(key) == dates.get(key)


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
def test_a_retractions_watch_searches_no_source_for_papers_and_gets_no_dates(client, conn):
    profile = client.post("/api/profiles", json={
        "kind": "person", "display_name": "Ada Fixture", "names": [{"value": "Ada Fixture"}],
        "identifiers": {}, "affiliations": [], "field_hints": [], "notes": None}).json()["id"]
    rid = client.post("/api/routines", json={
        "name": "r", "schedule_cron": "0 8 * * *", "is_active": False,
        "parameters": {"keywords": [], "entity": {"profile_id": profile, "mode": "retractions"},
                       "date_window": {"since": "previous_run"}}}).json()["id"]
    assert "date_window_next" not in client.get(f"/api/routines/{rid}").json()
    exec_id = client.post(f"/api/routines/{rid}/run").json()["execution_id"]
    assert "date_window_computed" not in json.loads(_execution(conn, exec_id)["parameters"])


def test_a_window_stored_before_it_was_checked_is_said_on_run_now(client, conn):
    rid = _routine(conn, {"keywords": ["graph"], "date_window": {"since": "last_week"}})
    response = client.post(f"/api/routines/{rid}/run")
    assert response.status_code == 400
    assert "previous_run" in response.json()["detail"]


def test_the_coverage_audit_says_what_its_dates_kept_out(client, conn):
    rid = _routine(conn, {"keywords": ["graph"], "date_window": {"since": "previous_run"}})
    assert date_window.coverage_note(conn, rid, {"date_window": {"since": "previous_run"}}) is None
    for start, first in (("2026-10-29T08:00:00Z", "2026-10-26"), ("2026-10-22T08:00:00Z", "2026-10-15")):
        database.insert_execution(conn, {
            "execution_type": "automated_sweep", "routine_id": rid, "start_time": start,
            "parameters": json.dumps({"date_from": first, "date_window_computed": {"date_from": first}})})
    note = client.get(f"/api/routines/{rid}/coverage").json()["window_note"]
    assert "asked for papers published from October 15, 2026 on" in note
    fixed = _routine(conn, {"keywords": ["graph"], "date_from": "2026-01-01"})
    assert "window_note" not in client.get(f"/api/routines/{fixed}/coverage").json()


# ---------------------------------------------------------------------------
# The catalog fact the editor and the warnings read
# ---------------------------------------------------------------------------

def test_every_entry_states_its_result_order():
    for entry in REPOSITORY_CATALOG:
        assert entry.result_order in ("newest_first", "relevance", "unstated"), entry.slug
        assert entry.result_order_established.strip(), entry.slug
        assert entry.client_module in entry.result_order_established, entry.slug


def test_a_newest_first_entry_is_one_whose_client_reads_newest_first():
    """The class is read from the client: the date sort its request asks for,
    or, for bioRxiv and medRxiv, its reading of a date-sorted list from the end
    back. So the client says it."""
    scripts = PROJECT_ROOT / "resmon_scripts" / "implementation_scripts"
    sorts = {"arxiv": '"sortOrder": "descending"', "hal": '"producedDate_tdate desc"',
             "inspire_hep": '"mostrecent"', "nasa_ads": '"date desc"', "plos": '"publication_date desc"',
             "pubmed": '"sort": "pub_date"', "biorxiv": "def _newest_first(",
             "medrxiv": "def _newest_first("}
    newest = {e.slug: e for e in REPOSITORY_CATALOG if e.result_order == "newest_first"}
    assert set(newest) == set(sorts)
    for slug, param in sorts.items():
        assert param in (scripts / newest[slug].client_module).read_text(encoding="utf-8"), slug
    # And no newest-first source is still described as returning relevance order.
    for entry in newest.values():
        assert "relevance-scored order" not in entry.keyword_combination_notes, entry.slug
        assert not entry.keyword_combination.startswith("Relevance-ranked"), entry.slug


def test_the_catalog_route_carries_the_order(client):
    rows = {row["slug"]: row for row in client.get("/api/repositories/catalog").json()}
    assert rows["arxiv"]["result_order"] == "newest_first"
    assert rows["crossref"]["result_order"] == "relevance"
    assert rows["dryad"]["result_order"] == "unstated"
