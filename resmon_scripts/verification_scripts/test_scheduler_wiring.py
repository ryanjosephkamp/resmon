"""Tests for IMPL-R3: scheduler callback refactor + coalesce/misfire grace.

Covers:
    (a) set_dispatcher + fire calls dispatcher exactly once
    (b) add_routine idempotent with replace_existing=True
    (c) remove_routine idempotent (second call does not raise)
    (d) coalesce=True present on the registered job
    (e) misfire_grace_time=60 present on the registered job
    (f) _routine_callback with no dispatcher installed logs and returns
    (g) dispatcher exception is swallowed and logged
"""

import logging
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import pytest

from implementation_scripts.scheduler import (
    ResmonScheduler,
    _routine_callback,
    set_dispatcher,
)


@pytest.fixture
def sched():
    s = ResmonScheduler(db_url="sqlite:///:memory:")
    s.start()
    yield s
    s.shutdown()
    # Restore clean module-level dispatcher between tests.
    set_dispatcher(None)


# ---------------------------------------------------------------------------
# (a) set_dispatcher + fire calls dispatcher exactly once
# ---------------------------------------------------------------------------

def test_dispatcher_invoked_once_per_fire():
    calls: list[tuple[int, str]] = []

    def dispatcher(routine_id: int, parameters: str) -> None:
        calls.append((routine_id, parameters))

    set_dispatcher(dispatcher)
    try:
        _routine_callback(routine_id=7, parameters='{"q":"x"}')
    finally:
        set_dispatcher(None)
    assert calls == [(7, '{"q":"x"}')]


# ---------------------------------------------------------------------------
# (b) add_routine idempotent with replace_existing
# ---------------------------------------------------------------------------

def test_add_routine_replace_existing(sched):
    sched.add_routine({
        "id": 1, "name": "r1-v1",
        "schedule_cron": "0 8 * * *", "parameters": '{"q":"a"}',
    })
    # Re-adding the same id must not raise; it replaces the job.
    sched.add_routine({
        "id": 1, "name": "r1-v2",
        "schedule_cron": "0 9 * * *", "parameters": '{"q":"b"}',
    })
    jobs = sched.get_active_jobs()
    assert len(jobs) == 1
    assert jobs[0]["id"] == "1"
    assert jobs[0]["name"] == "r1-v2"


# ---------------------------------------------------------------------------
# (c) remove_routine idempotent
# ---------------------------------------------------------------------------

def test_remove_routine_idempotent(sched):
    sched.add_routine({
        "id": 42, "name": "r42",
        "schedule_cron": "0 8 * * *", "parameters": "{}",
    })
    sched.remove_routine(42)
    # Second removal logs a warning but does not raise.
    sched.remove_routine(42)
    assert sched.get_active_jobs() == []


# ---------------------------------------------------------------------------
# (d) + (e) coalesce=True and misfire_grace_time=60 present on the job
# ---------------------------------------------------------------------------

def test_coalesce_and_misfire_grace_time_set(sched):
    sched.add_routine({
        "id": 5, "name": "r5",
        "schedule_cron": "*/5 * * * *", "parameters": "{}",
    })
    job = sched._scheduler.get_job("5")
    assert job is not None
    assert job.coalesce is True
    assert job.misfire_grace_time == 60


# ---------------------------------------------------------------------------
# (f) No dispatcher installed: callback logs an error and returns.
# ---------------------------------------------------------------------------

def test_callback_without_dispatcher_logs_error(caplog):
    set_dispatcher(None)
    with caplog.at_level(logging.ERROR, logger="implementation_scripts.scheduler"):
        _routine_callback(routine_id=99, parameters="{}")
    assert any(
        "no dispatcher installed" in rec.getMessage().lower() and "99" in rec.getMessage()
        for rec in caplog.records
        if rec.levelno == logging.ERROR
    )


# ---------------------------------------------------------------------------
# (g) Dispatcher exception is caught and logged; does not propagate.
# ---------------------------------------------------------------------------

def test_dispatcher_exception_swallowed(caplog):
    def boom(routine_id: int, parameters: str) -> None:
        raise RuntimeError("boom")

    set_dispatcher(boom)
    try:
        with caplog.at_level(logging.ERROR, logger="implementation_scripts.scheduler"):
            # Must not raise.
            _routine_callback(routine_id=11, parameters="{}")
    finally:
        set_dispatcher(None)

    assert any(
        "dispatcher raised" in rec.getMessage().lower() and "11" in rec.getMessage()
        for rec in caplog.records
    )
