"""The background service's engine knows the port it serves, and Evidence works on it.

Evidence and its selected answers once refused port 8742, the service's
default, a rule from when every window ran its own engine. Since windows use the
service's engine, that refusal meant Evidence never worked with the service,
and the service never recorded its own port, so an answer was bound to whatever
port a window's engine had last written to the port file.

These tests read the port logic as values. Nothing here binds a socket, and
nothing is sent to 8742: uvicorn's server is replaced before ``daemon.run``
could start it, on a port no test uses.
"""
from __future__ import annotations

import contextlib
import uuid

import pytest

import resmon as resmon_mod
from implementation_scripts import api_auth, daemon, evidence, selected_evidence_runtime as lane


def test_the_service_records_the_port_it_serves_before_the_app_starts(monkeypatch: pytest.MonkeyPatch) -> None:
    port = 45991  # a value; uvicorn never runs, so nothing binds it
    # Both fallbacks name another port, as a window's engine leaves them.
    monkeypatch.setenv("RESMON_PORT", "45992")
    monkeypatch.setattr(resmon_mod, "_serving_port", None)
    seen: dict[str, object] = {}

    def create_app() -> object:
        seen["at_start"] = resmon_mod.serving_port()
        return object()

    class Server:
        def __init__(self, config: object) -> None:
            seen["config"] = config

        def run(self) -> None:
            seen["ran"] = True

    import uvicorn
    monkeypatch.setattr(uvicorn, "Server", Server)
    monkeypatch.setattr(uvicorn, "Config", lambda app, **kwargs: kwargs)
    monkeypatch.setattr(resmon_mod, "create_app", create_app)
    monkeypatch.setattr(daemon, "daemon_lock", lambda **_: contextlib.nullcontext())
    monkeypatch.setattr(daemon, "_start_service_log", lambda argv: None)
    monkeypatch.setattr(daemon, "install_signal_handlers", lambda *a, **k: None)
    monkeypatch.setattr(daemon, "perform_graceful_shutdown", lambda **_: {})
    # The process's own token stays as the suite configured it.
    monkeypatch.setattr(api_auth, "configure_from_environment", lambda: "unused")
    monkeypatch.setattr(api_auth, "write_token_file", lambda *a, **k: None)
    monkeypatch.setattr(api_auth, "remove_token_file", lambda *a, **k: None)

    assert daemon.run(["daemon", f"--port={port}"]) == 0
    assert seen.get("ran") is True
    assert seen["config"]["port"] == port  # type: ignore[index]
    assert seen["at_start"] == port
    assert resmon_mod.serving_port() == port


def test_a_selected_answer_lane_takes_the_service_port_as_a_value(tmp_path) -> None:
    from implementation_scripts import database

    db = tmp_path / "resmon.db"
    database.init_db(str(db))
    value = lane.Lane(str(db), str(uuid.uuid4()), 8742, lambda conn: {})
    try:
        assert value.port == 8742
    finally:
        value.shutdown()


def test_selected_answers_start_on_the_service_port(monkeypatch: pytest.MonkeyPatch) -> None:
    made: list[int] = []

    class Recorded:
        def __init__(self, db_path: str, runtime_id: str, port: int, settings: object) -> None:
            made.append(port)

        def shutdown(self) -> None:
            pass

    monkeypatch.setattr(resmon_mod.selected_evidence_runtime, "Lane", Recorded)
    monkeypatch.setattr(resmon_mod, "_serving_port", 8742)
    monkeypatch.setattr(resmon_mod, "_selected_lanes", {})
    resmon_mod._selected_lane(resmon_mod._get_db())
    assert made == [8742]


def test_selected_answers_refuse_a_port_that_is_not_known(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(resmon_mod, "serving_port", lambda: None)
    monkeypatch.setattr(resmon_mod, "_selected_lanes", {})
    with pytest.raises(evidence.EvidenceError) as refused:
        resmon_mod._selected_lane(resmon_mod._get_db())
    assert refused.value.reason == "invalid_port" and refused.value.status == 409
