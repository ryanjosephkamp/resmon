# resmon_scripts/verification_scripts/test_delivery_email_target_deletion.py
"""Deleting a routine's email destination has to stick across its next run.

Two halves of the same defect, found in order. The first was the schema-21
seed: ``init_db`` re-created an email target for every routine with
``email_enabled = 1`` on *every* launch, so a deletion lasted until the next
start. That is gated on the 20 -> 21 upgrade now, and
``test_startup_idempotence`` holds it.

The second is this one. ``delivery.enqueue_for_execution`` re-creates the same
row on the routine's **next completed run** -- its docstring calls that
deliberate, and for a routine that has never had a target it is: the switch
alone used to be the whole configuration, and a routine created with the switch
on and no target still has to send. But it cannot tell a routine that never had
a target from one whose target the user just deleted, because ``email_enabled``
and the target row are two representations of one intent and nothing kept them
in step. So the delete button worked until the routine next ran, and then the
destination came back.

``email_enabled`` is the Routines page switch; the target row is the
destination. Removing the last destination now turns the switch off in the same
write, so the two cannot disagree and the enqueue path needs no new special
case. The user sees the switch move, which is the honest report of what the
deletion did.

What this does not establish: nothing here drives the Routines page or the
HTTP route. ``resmon.delete_routine_delivery_target`` is a thin wrapper around
``delivery.delete_target`` and is exercised through the route in one case
below; the renderer's own state after the switch moves is a frontend question
and is not checked here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database, delivery  # noqa: E402


def _reset_state() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


@pytest.fixture
def corpus(tmp_path):
    """One routine with the email switch on, and one completed execution."""
    _reset_state()
    conn = resmon_mod._get_db()
    routine_id = database.insert_routine(conn, {
        "name": "Diffusion watch",
        "schedule_cron": "0 8 * * *",
        "parameters": json.dumps({"query": "diffusion", "repositories": ["arxiv"]}),
        "is_active": 1, "email_enabled": 1, "email_ai_summary_enabled": 0,
        "ai_enabled": 0, "notify_on_complete": 0, "execution_location": "local",
    })
    report = tmp_path / "report_automated_sweep_1.md"
    report.write_text("# Diffusion watch\n\nTwo new papers.\n", encoding="utf-8")
    log = tmp_path / "log_automated_sweep_1.txt"
    log.write_text("started\nfinished\n", encoding="utf-8")
    exec_id = database.insert_execution(conn, {
        "execution_type": "automated_sweep",
        "routine_id": routine_id,
        "parameters": json.dumps({"query": "diffusion"}),
        "start_time": database.utc_now_iso(),
    })
    database.update_execution_status(
        conn, exec_id, "completed", log_path=str(log), result_path=str(report))
    return {"conn": conn, "routine_id": routine_id, "exec_id": exec_id,
            "report": report, "log": log}


def _second_execution(corpus) -> int:
    """A second completed run, so the first run's deliveries are not reused.

    ``deliveries`` has ``UNIQUE(execution_id, target_id)``, and the question is
    what the *next* run does -- re-enqueuing the same execution would be
    answered by that constraint rather than by the code under test.
    """
    conn = corpus["conn"]
    exec_id = database.insert_execution(conn, {
        "execution_type": "automated_sweep",
        "routine_id": corpus["routine_id"],
        "parameters": json.dumps({"query": "diffusion"}),
        "start_time": database.utc_now_iso(),
    })
    database.update_execution_status(
        conn, exec_id, "completed",
        log_path=str(corpus["log"]), result_path=str(corpus["report"]))
    return exec_id


def _enqueue(corpus, exec_id: int) -> list[int]:
    conn = corpus["conn"]
    return delivery.enqueue_for_execution(
        conn,
        database.get_execution_by_id(conn, exec_id),
        database.get_routine_by_id(conn, corpus["routine_id"]),
    )


def _email_targets(corpus) -> list[dict]:
    return [t for t in delivery.list_targets(corpus["conn"], corpus["routine_id"])
            if t["channel"] == "email"]


def _switch(corpus) -> int:
    row = database.get_routine_by_id(corpus["conn"], corpus["routine_id"])
    return int(row["email_enabled"])


# ---------------------------------------------------------------------------
# The defect
# ---------------------------------------------------------------------------


def test_a_deleted_email_target_does_not_come_back_on_the_next_run(corpus):
    """The delete button worked until the routine next completed."""
    conn = corpus["conn"]
    target_id = delivery.add_target(
        conn, corpus["routine_id"], channel="email", target="reader@example.org")
    assert _email_targets(corpus), "precondition: the routine has an email target"

    assert delivery.delete_target(conn, target_id) is True
    assert _email_targets(corpus) == []

    _enqueue(corpus, _second_execution(corpus))

    assert _email_targets(corpus) == [], (
        "the next completed run re-created the destination the user deleted")


def test_deleting_the_last_email_target_turns_the_switch_off(corpus):
    """One intent, one representation.

    The switch and the target row are two spellings of "send this routine's
    report by email". Leaving the switch on with no destination is the state
    that made the enqueue path re-create the row, so the delete closes it.
    """
    conn = corpus["conn"]
    target_id = delivery.add_target(
        conn, corpus["routine_id"], channel="email", target="reader@example.org")
    assert _switch(corpus) == 1

    delivery.delete_target(conn, target_id)

    assert _switch(corpus) == 0, (
        "email_enabled still claims the routine emails, with nowhere to send")


def test_deleting_one_of_two_email_targets_leaves_the_switch_on(corpus):
    """Only the *last* one. A routine with a destination still emails."""
    conn = corpus["conn"]
    first = delivery.add_target(
        conn, corpus["routine_id"], channel="email", target="one@example.org")
    delivery.add_target(
        conn, corpus["routine_id"], channel="email", target="two@example.org")

    delivery.delete_target(conn, first)

    assert _switch(corpus) == 1
    assert [t["target"] for t in _email_targets(corpus)] == ["two@example.org"]

    _enqueue(corpus, _second_execution(corpus))
    assert [t["target"] for t in _email_targets(corpus)] == ["two@example.org"], (
        "the surviving target is enough; nothing should be seeded beside it")


@pytest.mark.parametrize("channel", ["folder", "feed"])
def test_deleting_a_non_email_target_leaves_the_switch_alone(
    corpus, tmp_path, channel,
):
    """Denominator: every channel in ``delivery.SHIPPED_CHANNELS`` but email.

    ``webhook`` is in ``database.DELIVERY_CHANNELS``' CHECK and not in
    ``SHIPPED_CHANNELS``, so ``add_target`` refuses it and it cannot be
    deleted either; ``feed`` and ``folder`` both take a directory.
    """
    conn = corpus["conn"]
    destination = tmp_path / channel
    destination.mkdir()
    delivery.add_target(
        conn, corpus["routine_id"], channel="email", target="reader@example.org")
    other = delivery.add_target(
        conn, corpus["routine_id"], channel=channel, target=str(destination))

    delivery.delete_target(conn, other)

    assert _switch(corpus) == 1
    assert len(_email_targets(corpus)) == 1


def test_the_switch_still_seeds_a_target_for_a_routine_that_never_had_one(corpus):
    """The behavior the re-creation exists for, and it has to survive.

    A routine created through the API with ``email_enabled`` on and no target
    is the pre-21 shape, and it still has to send. Nothing above may take that
    away: ``delete_target`` only moves the switch for a routine whose last
    destination the user removed.
    """
    conn = corpus["conn"]
    assert _email_targets(corpus) == []
    assert _switch(corpus) == 1

    _enqueue(corpus, corpus["exec_id"])

    assert len(_email_targets(corpus)) == 1
    assert _email_targets(corpus)[0]["target"] == "", (
        "an empty target means the address configured in Settings -> Email")


def test_the_route_behaves_the_same_as_the_module(corpus):
    """The HTTP seam, since that is the one the delete button goes through."""
    conn = corpus["conn"]
    target_id = delivery.add_target(
        conn, corpus["routine_id"], channel="email", target="reader@example.org")

    from fastapi.testclient import TestClient  # noqa: PLC0415

    with TestClient(resmon_mod.app) as client:
        response = client.delete(
            f"/api/routines/{corpus['routine_id']}/delivery-targets/{target_id}")
    assert response.status_code == 200, response.text

    assert _email_targets(corpus) == []
    assert _switch(corpus) == 0

    _enqueue(corpus, _second_execution(corpus))
    assert _email_targets(corpus) == []
