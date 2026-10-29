"""A schedule the scheduler cannot read is refused, not stored.

``POST /api/routines`` and ``PUT /api/routines/{id}`` took ``schedule_cron`` as
any string. The scheduler builds the routine's trigger afterwards, and a failure
there is logged (``_sched_add_routine``) while the request still answers 201; the
calendar skips the routine the same way. So ``0 25 * * *`` made a routine that
said it was active, showed no next fire anywhere, and never ran — the
plausible-and-wrong shape this app refuses. The renderer, the CLI and the MCP
surface all reach the same two routes, so the check is at the seam.

**The property:** a create or an update that sets a schedule is accepted only if
``scheduler._build_trigger`` can build the trigger the scheduler will use, from
the schedule and the parameters as they will be stored; otherwise it is a 400
naming the expression, and nothing changes. An update that touches no schedule
is not checked, so a routine stored before this check can still be paused,
renamed or deleted.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402


def _client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app
    return TestClient(app)


def _body(cron: str, **extra) -> dict:
    body = {
        "name": "nightly",
        "schedule_cron": cron,
        "parameters": {"query": "perovskite", "keywords": ["perovskite"], "repositories": ["arxiv"]},
        "is_active": False,
    }
    body.update(extra)
    return body


UNREADABLE = [
    "0 25 * * *",          # no 25th hour
    "61 8 * * *",          # no 61st minute
    "0 8 * *",             # four fields
    "every morning",       # words
    "0 8 32 * *",          # no 32nd day
]


@pytest.mark.parametrize("cron", UNREADABLE)
def test_a_schedule_the_scheduler_cannot_read_is_refused_on_create(cron: str):
    client = _client()
    refused = client.post("/api/routines", json=_body(cron, is_active=True))
    assert refused.status_code == 400, refused.text
    detail = refused.json()["detail"]
    assert f"“{cron}”" in detail
    assert "five fields" in detail
    # Nothing was stored: the list is as it was.
    assert client.get("/api/routines").json() == []


@pytest.mark.parametrize("cron", ["0 8 * * *", "*/15 * * * *", "0 8 * * 1-5", "30 7 * * 0", "0 9 1 * *", "0 6 * * 7"])
def test_the_schedules_people_write_are_accepted(cron: str):
    client = _client()
    created = client.post("/api/routines", json=_body(cron))
    assert created.status_code == 201, created.text
    assert client.get(f"/api/routines/{created.json()['id']}").json()["schedule_cron"] == cron


def test_a_structured_schedule_is_what_is_checked_when_it_is_the_one_that_runs():
    # The scheduler prefers a valid `_schedule` block to the cron string, so
    # that block is the schedule; the string beside it is not read.
    client = _client()
    body = _body("not read")
    body["parameters"]["_schedule"] = {"type": "interval", "unit": "hours", "every": 6, "hour": 0, "minute": 0}
    assert client.post("/api/routines", json=body).status_code == 201


def test_an_update_that_sets_an_unreadable_schedule_is_refused_and_changes_nothing():
    client = _client()
    rid = client.post("/api/routines", json=_body("0 8 * * *")).json()["id"]
    refused = client.put(f"/api/routines/{rid}", json={"schedule_cron": "0 8 * * 9", "name": "renamed"})
    assert refused.status_code == 400, refused.text
    assert "“0 8 * * 9”" in refused.json()["detail"]
    after = client.get(f"/api/routines/{rid}").json()
    assert (after["schedule_cron"], after["name"]) == ("0 8 * * *", "nightly")


def test_new_parameters_are_checked_against_the_stored_schedule():
    # Removing a valid `_schedule` hands the routine back to its cron string,
    # so an update to the parameters alone is checked too.
    client = _client()
    body = _body("not read")
    body["parameters"]["_schedule"] = {"type": "interval", "unit": "days", "every": 1, "hour": 8, "minute": 0}
    rid = client.post("/api/routines", json=body).json()["id"]
    refused = client.put(f"/api/routines/{rid}", json={"parameters": {"keywords": ["perovskite"], "repositories": ["arxiv"]}})
    assert refused.status_code == 400, refused.text
    assert "“not read”" in refused.json()["detail"]


def test_an_update_that_touches_no_schedule_is_not_checked():
    # A routine stored before this check, with a schedule nothing can read, can
    # still be paused, renamed, switched or deleted.
    client = _client()
    rid = client.post("/api/routines", json=_body("0 8 * * *")).json()["id"]
    conn = resmon_mod._get_db()
    try:
        conn.execute("UPDATE routines SET schedule_cron = ? WHERE id = ?", ("0 25 * * *", rid))
        conn.commit()
    finally:
        resmon_mod._close_db(conn)
    for change in ({"notify_on_complete": True}, {"name": "renamed"}, {"is_active": False}, {"intent": "papers on tandem cells"}):
        assert client.put(f"/api/routines/{rid}", json=change).status_code == 200, change
    assert client.delete(f"/api/routines/{rid}").status_code == 200
