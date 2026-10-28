"""Bug B (Update 2 / Batch 2) — desktop notification tests.

Two layers of coverage:

1. ``test_desktop_notifier`` block — pure unit tests for the
   per-platform routing inside
   :mod:`implementation_scripts.desktop_notifier`. ``_run`` is patched
   so no real subprocess is spawned.

2. ``test_dispatch_decision`` block — pure unit tests for
   :func:`resmon._should_dispatch_desktop_notification` (matches the
   in-renderer policy in ``ExecutionContext.maybeNotifyCompletion``).

3. ``test_dispatch_hook`` block — integration tests that exercise the
   ``_launch_execution`` completion hook end-to-end with
   ``desktop_notifier.notify`` mocked. Verifies the hook fires for
   manual + routine runs that opt in, and stays silent for opted-out
   runs / unknown execution types.

No real OS notifications are emitted by these tests.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database, desktop_notifier  # noqa: E402
from implementation_scripts.admission import admission  # noqa: E402
from implementation_scripts.progress import progress_store  # noqa: E402


# ---------------------------------------------------------------------------
# desktop_notifier — the app as the poster
# ---------------------------------------------------------------------------


class _Listener:
    """The app's notification listener, as a loopback server that records what it took."""

    def __init__(self, status: int = 204) -> None:
        import http.server
        import threading

        listener = self
        self.received: list[dict] = []
        self.status = status

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                listener.received.append({
                    "authorization": self.headers.get("Authorization"),
                    "body": json.loads(self.rfile.read(length) or b"{}"),
                })
                self.send_response(listener.status)
                self.end_headers()

            def log_message(self, *args):  # quiet
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/notify"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def hosted(monkeypatch):
    listener = _Listener()
    monkeypatch.setenv(desktop_notifier.HOST_URL_ENV, listener.url)
    monkeypatch.setenv(desktop_notifier.HOST_TOKEN_ENV, "t" * 43)
    assert desktop_notifier.configure_host_from_environment() is True
    yield listener
    listener.close()
    desktop_notifier._host = None


def test_a_hosted_backend_hands_the_notification_to_the_app_and_runs_no_tool(hosted):
    with patch.object(desktop_notifier, "_run", side_effect=AssertionError("a tool ran")):
        assert desktop_notifier.notify("resmon: Execution Completed", "6 new of 1,500", execution_id=141) is True
    [taken] = hosted.received
    assert taken["authorization"] == "Bearer " + "t" * 43
    assert taken["body"] == {"title": "resmon: Execution Completed", "body": "6 new of 1,500",
                             "execution_id": 141}


def test_the_listener_address_and_token_leave_the_environment(hosted):
    # Nothing the backend starts later (an agent CLI, its MCP servers) inherits them.
    import os
    assert desktop_notifier.HOST_URL_ENV not in os.environ
    assert desktop_notifier.HOST_TOKEN_ENV not in os.environ


def test_a_notification_the_app_does_not_take_is_posted_the_old_way(hosted):
    # The app stopped answering: the notification is not lost.
    hosted.close()
    with patch.object(desktop_notifier, "_run", return_value=True) as tool, \
         patch.object(desktop_notifier.shutil, "which", return_value="/usr/bin/tool"):
        ok = desktop_notifier.notify("t", "b", execution_id=1)
    if desktop_notifier.is_supported():
        assert ok is True and tool.call_count == 1


def test_a_refusal_from_the_app_is_posted_the_old_way(monkeypatch):
    listener = _Listener(status=401)
    try:
        monkeypatch.setenv(desktop_notifier.HOST_URL_ENV, listener.url)
        monkeypatch.setenv(desktop_notifier.HOST_TOKEN_ENV, "wrong")
        desktop_notifier.configure_host_from_environment()
        with patch.object(desktop_notifier, "_run", return_value=True) as tool, \
             patch.object(desktop_notifier.shutil, "which", return_value="/usr/bin/tool"):
            desktop_notifier.notify("t", "b")
        assert len(listener.received) == 1
        if desktop_notifier.is_supported():
            assert tool.call_count == 1
    finally:
        listener.close()
        desktop_notifier._host = None


@pytest.mark.parametrize("url", [
    "https://127.0.0.1:9/notify",          # not plain http
    "http://localhost:9/notify",           # a name, which resolves however the machine says
    "http://10.0.0.5:9/notify",            # not loopback
    "http://127.0.0.1/notify",             # no port
])
def test_only_a_loopback_listener_is_accepted(monkeypatch, url):
    monkeypatch.setenv(desktop_notifier.HOST_URL_ENV, url)
    monkeypatch.setenv(desktop_notifier.HOST_TOKEN_ENV, "t" * 43)
    assert desktop_notifier.configure_host_from_environment() is False
    assert desktop_notifier._host is None


# ---------------------------------------------------------------------------
# desktop_notifier — per-platform routing
# ---------------------------------------------------------------------------


def test_notify_returns_false_for_non_string_inputs():
    assert desktop_notifier.notify(None, "body") is False  # type: ignore[arg-type]
    assert desktop_notifier.notify("title", 123) is False  # type: ignore[arg-type]


def test_notify_macos_invokes_osascript():
    if sys.platform != "darwin":
        pytest.skip("macOS-specific test")
    captured = {}

    def fake_run(cmd, env=None):
        captured["cmd"] = cmd
        return True

    with patch.object(desktop_notifier, "_run", side_effect=fake_run), \
         patch.object(desktop_notifier.shutil, "which", return_value="/usr/bin/osascript"):
        ok = desktop_notifier.notify("Hello", "World")
    assert ok is True
    assert captured["cmd"][0] == "osascript"
    assert "-e" in captured["cmd"]
    script = captured["cmd"][-1]
    assert "Hello" in script
    assert "World" in script


def test_notify_macos_escapes_quotes_and_backslashes():
    if sys.platform != "darwin":
        pytest.skip("macOS-specific test")
    captured = {}

    def fake_run(cmd, env=None):
        captured["cmd"] = cmd
        return True

    with patch.object(desktop_notifier, "_run", side_effect=fake_run), \
         patch.object(desktop_notifier.shutil, "which", return_value="/usr/bin/osascript"):
        desktop_notifier.notify('A"B', "C\\D")
    script = captured["cmd"][-1]
    # Both characters must be escaped before reaching osascript so the
    # AppleScript literal cannot be broken out of.
    assert '\\"' in script
    assert "\\\\" in script


def test_notify_returns_false_when_helper_missing():
    """If the platform helper is not on PATH, notify must report failure."""
    with patch.object(desktop_notifier.shutil, "which", return_value=None):
        assert desktop_notifier.notify("t", "b") is False


def test_run_returns_false_on_nonzero_exit():
    class FakeResult:
        returncode = 1
        stderr = "boom"
        stdout = ""

    with patch.object(desktop_notifier.subprocess, "run", return_value=FakeResult()):
        assert desktop_notifier._run(["false"]) is False


def test_run_returns_false_on_filenotfound():
    with patch.object(
        desktop_notifier.subprocess, "run",
        side_effect=FileNotFoundError("missing"),
    ):
        assert desktop_notifier._run(["nope"]) is False


# ---------------------------------------------------------------------------
# _should_dispatch_desktop_notification — policy unit tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "execution_type,notify_manual,mode,routine_flag,expected",
    [
        # Manual runs follow notify_manual.
        ("deep_dive", True, "none", False, True),
        ("deep_dive", False, "all", False, False),
        ("deep_sweep", True, "none", False, True),
        ("deep_sweep", False, "all", False, False),
        # Automated runs: per-routine flag wins.
        ("automated_sweep", False, "none", True, True),
        ("automated_sweep", False, "selected", True, True),
        # Falls back to global mode when per-routine is off.
        ("automated_sweep", False, "all", False, True),
        ("automated_sweep", False, "selected", False, False),
        ("automated_sweep", False, "none", False, False),
        # Unknown execution types never notify.
        ("import", True, "all", True, False),
        ("", True, "all", True, False),
    ],
)
def test_dispatch_decision(execution_type, notify_manual, mode, routine_flag, expected):
    assert (
        resmon_mod._should_dispatch_desktop_notification(
            execution_type=execution_type,
            notify_manual=notify_manual,
            notify_automatic_mode=mode,
            routine_notify_on_complete=routine_flag,
        )
        is expected
    )


# ---------------------------------------------------------------------------
# _launch_execution dispatch hook — integration with mocked notifier
# ---------------------------------------------------------------------------


def _reset_state() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    with admission._lock:
        admission._active.clear()
        admission._queue.clear()
    admission.set_max(3)
    admission.set_queue_limit(16)


def _fast_run_prepared(self, exec_id: int) -> dict:
    progress_store.emit(exec_id, {"type": "execution_start", "execution_id": exec_id})
    progress_store.emit(exec_id, {"type": "execution_complete", "execution_id": exec_id})
    progress_store.mark_complete(exec_id)
    database.update_execution_status(self.db, exec_id, "completed")
    return {"execution_id": exec_id, "status": "completed"}


def _wait_for_completion(exec_id: int, timeout: float = 5.0) -> None:
    conn = resmon_mod._get_db()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = database.get_execution_by_id(conn, exec_id)
        if row and row.get("status") in ("completed", "failed", "cancelled"):
            time.sleep(0.1)
            return
        time.sleep(0.05)


def _set_notify_settings(*, notify_manual: bool, mode: str) -> None:
    conn = resmon_mod._get_db()
    resmon_mod._set_settings_group(
        conn,
        "notifications",
        {
            "notify_manual": "1" if notify_manual else "0",
            "notify_automatic_mode": mode,
        },
    )


def _make_routine(*, notify_on_complete: int) -> int:
    conn = resmon_mod._get_db()
    body = {
        "name": "notify-hook-test",
        "schedule_cron": "0 8 * * *",
        "parameters": '{"query":"x","repositories":[]}',
        "is_active": 1,
        "email_enabled": 0,
        "email_ai_summary_enabled": 0,
        "ai_enabled": 0,
        "ai_settings": None,
        "storage_settings": None,
        "notify_on_complete": notify_on_complete,
        "execution_location": "local",
    }
    return database.insert_routine(conn, body)


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch("implementation_scripts.desktop_notifier.notify", return_value=True)
def test_notification_fires_for_manual_dive_when_enabled(mock_notify):
    _reset_state()
    _set_notify_settings(notify_manual=True, mode="none")
    conn = resmon_mod._get_db()
    from implementation_scripts.sweep_engine import SweepEngine

    engine = SweepEngine(
        db_conn=conn,
        config={"ai_enabled": False, "ai_settings": None},
    )
    exec_id = engine.prepare_execution("deep_dive", [], {"query": "x"})
    progress_store.register(exec_id)
    resmon_mod._launch_execution(engine, exec_id, conn)
    _wait_for_completion(exec_id)

    assert mock_notify.call_count == 1, mock_notify.call_args_list
    title, body = mock_notify.call_args.args
    assert "resmon" in title.lower()
    assert "Deep Dive" in body
    # The run it is about, so the app can open that run when it is clicked.
    assert mock_notify.call_args.kwargs == {"execution_id": exec_id}


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch("implementation_scripts.desktop_notifier.notify", return_value=True)
def test_notification_skipped_for_manual_dive_when_disabled(mock_notify):
    _reset_state()
    _set_notify_settings(notify_manual=False, mode="all")
    conn = resmon_mod._get_db()
    from implementation_scripts.sweep_engine import SweepEngine

    engine = SweepEngine(
        db_conn=conn,
        config={"ai_enabled": False, "ai_settings": None},
    )
    exec_id = engine.prepare_execution("deep_dive", [], {"query": "x"})
    progress_store.register(exec_id)
    resmon_mod._launch_execution(engine, exec_id, conn)
    _wait_for_completion(exec_id)

    assert mock_notify.call_count == 0


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch("implementation_scripts.desktop_notifier.notify", return_value=True)
def test_notification_fires_for_routine_when_per_routine_optin(mock_notify):
    _reset_state()
    # Global mode is 'none' — per-routine opt-in should still fire.
    _set_notify_settings(notify_manual=False, mode="none")
    rid = _make_routine(notify_on_complete=1)
    resmon_mod._dispatch_routine_fire(rid, '{"query":"x","repositories":[]}')

    conn = resmon_mod._get_db()
    rows = database.get_executions(conn)
    assert len(rows) == 1
    _wait_for_completion(rows[0]["id"])

    assert mock_notify.call_count == 1, mock_notify.call_args_list
    title, body = mock_notify.call_args.args
    assert body.startswith("notify-hook-test: ")


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch("implementation_scripts.desktop_notifier.notify", return_value=True)
def test_notification_skipped_for_routine_when_global_mode_none(mock_notify):
    _reset_state()
    _set_notify_settings(notify_manual=True, mode="none")
    rid = _make_routine(notify_on_complete=0)
    resmon_mod._dispatch_routine_fire(rid, '{"query":"x","repositories":[]}')

    conn = resmon_mod._get_db()
    rows = database.get_executions(conn)
    _wait_for_completion(rows[0]["id"])

    assert mock_notify.call_count == 0


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch(
    "implementation_scripts.desktop_notifier.notify",
    side_effect=RuntimeError("notifier boom"),
)
def test_notification_failure_does_not_fail_execution(mock_notify):
    _reset_state()
    _set_notify_settings(notify_manual=True, mode="none")
    conn = resmon_mod._get_db()
    from implementation_scripts.sweep_engine import SweepEngine

    engine = SweepEngine(
        db_conn=conn,
        config={"ai_enabled": False, "ai_settings": None},
    )
    exec_id = engine.prepare_execution("deep_dive", [], {"query": "x"})
    progress_store.register(exec_id)
    resmon_mod._launch_execution(engine, exec_id, conn)
    _wait_for_completion(exec_id)

    final = database.get_execution_by_id(conn, exec_id)
    assert final["status"] == "completed"
    assert mock_notify.call_count == 1


# ---------------------------------------------------------------------------
# What the notification says. The tests above check that one fires; these
# check its sentence, end to end from the row the hook really reads. Before
# they existed every completed run's background notification said "0 results
# (0 new)", because the body read the renderer's field names off the raw row.
# ---------------------------------------------------------------------------

_FOUR_SOURCES = ["arxiv", "crossref", "openalex", "pubmed"]


def _recording_run_prepared(
    *,
    status: str,
    result_count: int | None,
    new_result_count: int | None,
    sources: list[tuple[str, str, int, str | None]],
):
    """A ``run_prepared`` that leaves the record a real run would have left."""

    def _run(self, exec_id: int) -> dict:
        for slug, source_status, count, reason in sources:
            database.record_execution_source(
                self.db, exec_id, slug, source_status,
                result_count=count, zero_reason=reason,
            )
        database.update_execution_status(
            self.db, exec_id, status,
            result_count=result_count, new_result_count=new_result_count,
        )
        progress_store.mark_complete(exec_id)
        return {"execution_id": exec_id, "status": status}

    return _run


def _fire_named_routine_and_read_body(run_prepared, *, repositories=None) -> str:
    _reset_state()
    _set_notify_settings(notify_manual=False, mode="all")
    params = json.dumps({
        "query": "agents",
        "repositories": list(repositories or _FOUR_SOURCES),
    })
    conn = resmon_mod._get_db()
    rid = database.insert_routine(conn, {
        "name": "daily_agents",
        "schedule_cron": "0 16 * * *",
        "parameters": params,
        "is_active": 1,
        "notify_on_complete": 1,
        "execution_location": "local",
    })
    with patch("resmon.SweepEngine.run_prepared", run_prepared), \
         patch("implementation_scripts.desktop_notifier.notify",
               return_value=True) as mock_notify:
        resmon_mod._dispatch_routine_fire(rid, params)
        rows = database.get_executions(conn)
        assert len(rows) == 1
        _wait_for_completion(rows[0]["id"])
    assert mock_notify.call_count == 1, mock_notify.call_args_list
    return mock_notify.call_args.args[1]


def test_completed_routine_body_names_routine_counts_and_coverage():
    body = _fire_named_routine_and_read_body(_recording_run_prepared(
        status="completed", result_count=1500, new_result_count=6,
        sources=[("arxiv", "ok", 900, None), ("crossref", "ok", 400, None),
                 ("openalex", "ok", 200, None), ("pubmed", "ok", 0, "answered_empty")],
    ))
    assert body == "daily_agents: 6 new of 1,500 results; all 4 sources answered."


def test_completed_routine_body_counts_a_source_that_did_not_answer():
    body = _fire_named_routine_and_read_body(_recording_run_prepared(
        status="completed", result_count=1500, new_result_count=6,
        sources=[("arxiv", "ok", 1100, None), ("crossref", "ok", 400, None),
                 ("openalex", "ok", 0, "upstream_failure"),
                 ("pubmed", "ok", 0, "answered_empty")],
    ))
    assert body == (
        "daily_agents: 6 new of 1,500 results; 1 of 4 sources did not answer."
    )


def test_completed_body_says_unrecorded_sources_are_unknown_not_failed():
    # Only two of the four selected sources left a row. The other two are
    # not failures and not answers; the record cannot say which.
    body = _fire_named_routine_and_read_body(_recording_run_prepared(
        status="completed", result_count=12, new_result_count=3,
        sources=[("arxiv", "ok", 12, None), ("crossref", "ok", 0, "upstream_failure")],
    ))
    assert body == (
        "daily_agents: 3 new of 12 results; 1 of 4 sources did not answer; "
        "whether 2 answered is unknown."
    )


def test_completed_body_never_prints_an_absent_count_as_zero():
    # ``executions.result_count`` defaults to 0 and the engine writes both
    # counts when a run completes, so a row read from the table always has
    # them. A row that lacks them must still not be rounded to zero.
    conn = resmon_mod._get_db()
    row = {
        "id": 999_999, "execution_type": "deep_dive", "status": "completed",
        "parameters": json.dumps({"query": "x", "repository": "arxiv"}),
        "result_count": None, "new_result_count": None,
    }
    body = resmon_mod._desktop_notification_body(conn, row, None)
    assert body == (
        "Deep Dive: result count not recorded; whether the source answered is unknown."
    )


def test_failed_routine_body_says_failed_and_why():
    body = _fire_named_routine_and_read_body(_recording_run_prepared(
        status="failed", result_count=None, new_result_count=None,
        sources=[(slug, "ok", 0, "upstream_failure") for slug in _FOUR_SOURCES],
    ))
    assert body == "daily_agents failed; 4 of 4 sources did not answer."


@pytest.mark.parametrize(
    "coverage,expected",
    [
        ({"total": 0, "counts": {}, "selection_known": True},
         "no source outcome was recorded"),
        ({"total": 1, "counts": {"answered": 1}, "selection_known": True},
         "the source answered"),
        ({"total": 1, "counts": {"non_answer": 1}, "selection_known": True},
         "the source did not answer"),
        ({"total": 1, "counts": {"unknown": 1}, "selection_known": True},
         "whether the source answered is unknown"),
        ({"total": 3, "counts": {"unknown": 2, "answered": 1}, "selection_known": True},
         "whether 2 of 3 sources answered is unknown"),
        # The saved selection could not be read, so the count is of the
        # sources that left a record and the sentence says so.
        ({"total": 3, "counts": {"answered": 3}, "selection_known": False},
         "all 3 recorded sources answered"),
        ({"total": 3, "counts": {"answered": 3, "partial": 1}, "selection_known": True},
         "all 3 sources answered (1 only in part)"),
    ],
)
def test_coverage_phrase(coverage, expected):
    assert resmon_mod._notification_coverage_phrase(coverage) == expected


# ---------------------------------------------------------------------------
# Linux service unit must inject DBUS_SESSION_BUS_ADDRESS
# ---------------------------------------------------------------------------


def test_linux_service_unit_sets_dbus_env():
    """systemd --user services must have DBus session bus reachable so
    notify-send can post to the user's desktop session."""
    unit = (
        PROJECT_ROOT
        / "resmon_scripts"
        / "service_units"
        / "resmon-daemon.service"
    )
    text = unit.read_text(encoding="utf-8")
    assert "DBUS_SESSION_BUS_ADDRESS" in text
    assert "/run/user/%U/bus" in text


# ---------------------------------------------------------------------------
# Renderer-facing GET /api/routines/{id} round-trip — regression for the
# 'selected' notification mode bug. The renderer fetches this endpoint to
# read ``notify_on_complete`` per routine; without it the per-routine
# opt-in silently degrades to ``false`` and 'selected' mode never fires.
# ---------------------------------------------------------------------------


def test_get_routine_by_id_returns_notify_on_complete_after_partial_put():
    from fastapi.testclient import TestClient

    _reset_state()
    rid = _make_routine(notify_on_complete=0)

    with TestClient(resmon_mod.app) as client:
        # Seed: GET reflects initial false.
        get1 = client.get(f"/api/routines/{rid}")
        assert get1.status_code == 200
        assert get1.json()["notify_on_complete"] is False

        # The Routines page sends a PARTIAL body with only the toggled
        # field — the PUT handler must merge, not overwrite, and the
        # GET endpoint must reflect the change.
        put = client.put(
            f"/api/routines/{rid}",
            json={"notify_on_complete": True},
        )
        assert put.status_code == 200, put.text

        get2 = client.get(f"/api/routines/{rid}")
        assert get2.status_code == 200
        assert get2.json()["notify_on_complete"] is True


def test_get_routine_by_id_returns_404_for_missing_routine():
    from fastapi.testclient import TestClient

    _reset_state()
    with TestClient(resmon_mod.app) as client:
        resp = client.get("/api/routines/999999")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Renderer-presence heartbeat suppresses backend dispatch (duplicate-
# notification fix). When the Electron renderer pings recently, the
# backend must NOT call ``desktop_notifier.notify``; otherwise macOS
# surfaces a duplicate attributed to ``Script Editor``.
# ---------------------------------------------------------------------------


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch("implementation_scripts.desktop_notifier.notify", return_value=True)
def test_backend_dispatch_suppressed_when_renderer_attached(mock_notify):
    _reset_state()
    _set_notify_settings(notify_manual=True, mode="none")
    # Simulate a fresh renderer heartbeat.
    resmon_mod._renderer_last_heartbeat_ts = time.time()
    try:
        conn = resmon_mod._get_db()
        from implementation_scripts.sweep_engine import SweepEngine

        engine = SweepEngine(
            db_conn=conn,
            config={"ai_enabled": False, "ai_settings": None},
        )
        exec_id = engine.prepare_execution("deep_dive", [], {"query": "x"})
        progress_store.register(exec_id)
        resmon_mod._launch_execution(engine, exec_id, conn)
        _wait_for_completion(exec_id)

        assert mock_notify.call_count == 0, (
            "renderer heartbeat should suppress backend dispatch to avoid "
            "duplicate notifications"
        )
    finally:
        resmon_mod._renderer_last_heartbeat_ts = 0.0


@patch("resmon.SweepEngine.run_prepared", _fast_run_prepared)
@patch("implementation_scripts.desktop_notifier.notify", return_value=True)
def test_backend_dispatch_resumes_when_renderer_heartbeat_stale(mock_notify):
    _reset_state()
    _set_notify_settings(notify_manual=True, mode="none")
    # Stale heartbeat (older than TTL) — backend must resume dispatching.
    resmon_mod._renderer_last_heartbeat_ts = (
        time.time() - resmon_mod._RENDERER_HEARTBEAT_TTL_SEC - 5.0
    )
    try:
        conn = resmon_mod._get_db()
        from implementation_scripts.sweep_engine import SweepEngine

        engine = SweepEngine(
            db_conn=conn,
            config={"ai_enabled": False, "ai_settings": None},
        )
        exec_id = engine.prepare_execution("deep_dive", [], {"query": "x"})
        progress_store.register(exec_id)
        resmon_mod._launch_execution(engine, exec_id, conn)
        _wait_for_completion(exec_id)

        assert mock_notify.call_count == 1
    finally:
        resmon_mod._renderer_last_heartbeat_ts = 0.0


def test_renderer_heartbeat_endpoint_updates_timestamp():
    from fastapi.testclient import TestClient

    _reset_state()
    resmon_mod._renderer_last_heartbeat_ts = 0.0
    assert resmon_mod._renderer_is_attached() is False
    with TestClient(resmon_mod.app) as client:
        resp = client.post("/api/renderer/heartbeat", json={})
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
    assert resmon_mod._renderer_is_attached() is True
    resmon_mod._renderer_last_heartbeat_ts = 0.0
