"""Authored source exchanges exercise the production transport and sweep path."""

from __future__ import annotations

import base64
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator
from urllib.parse import quote, quote_plus

import httpx
import pytest

from implementation_scripts import (api_base, api_biorxiv, api_crossref, api_hal, api_ndl_search,
                                    config, database, date_window, search_record)
from implementation_scripts.source_tape import REDACTED, SourceTape, TapeMiss
from implementation_scripts.sweep_engine import SweepEngine

URL = "http://127.0.0.1:19371/works"
UTC = timezone.utc
Wire = tuple[list[httpx.Response | Exception], list[httpx.Request]]


@pytest.fixture(autouse=True)
def isolated(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(api_base, "_SOURCE_TAPE", None)
    monkeypatch.setattr(config, "DEFAULT_MAX_RETRIES", 0)
    api_base.reset_search_outcome()
    yield
    api_base.reset_search_outcome()


@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch) -> Wire:
    """HTTPX's in-process transport: real Response bytes, no sockets or sources."""
    replies: list[httpx.Response | Exception] = []
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        reply = replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    client, async_client = httpx.Client, httpx.AsyncClient
    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(httpx, "Client", lambda **kw: client(transport=transport, **kw))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: async_client(transport=transport, **kw))
    return replies, seen


def _enable(monkeypatch: pytest.MonkeyPatch, root: Path, mode: str) -> SourceTape:
    tape = SourceTape(f"{mode}:{root}")
    monkeypatch.setattr(api_base, "_SOURCE_TAPE", tape)
    api_base.reset_search_outcome()
    return tape


def _no_wire(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(**kwargs: object) -> None:
        pytest.fail("replay constructed a live HTTP client")
    monkeypatch.setattr(httpx, "Client", forbidden)
    monkeypatch.setattr(httpx, "AsyncClient", forbidden)


@pytest.mark.parametrize("bounded", [False, True])
def test_unset_tape_never_reaches_tape_code_or_rereads_setting(monkeypatch: pytest.MonkeyPatch, wire: Wire, bounded: bool) -> None:
    def forbidden(*args: object, **kwargs: object) -> None:
        pytest.fail("disabled request reached tape code")
    monkeypatch.setattr(api_base, "_taped_request", forbidden)
    monkeypatch.setattr(SourceTape, "exchange", forbidden)
    # A variable changed after engine import has no effect on that engine.
    monkeypatch.setenv("RESMON_SOURCE_TAPE", "replay:/does-not-exist")
    wire[0].append(httpx.Response(200, content=b"unchanged"))
    response = api_base.safe_request("GET", URL, deadline=time.monotonic() + 3 if bounded else None)
    assert response.content == b"unchanged"
    assert len(wire[1]) == 1
    assert api_base.search_outcome().attempts == 1


def test_setting_is_read_once_at_import(tmp_path: Path) -> None:
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
           "RESMON_SOURCE_TAPE": f"record:{tmp_path / 'tape'}",
           "RESMON_AI_CLI_DISCOVERY": "configured-only"}
    script = ("import os; from implementation_scripts import api_base; "
              "assert api_base._SOURCE_TAPE.mode == 'record'; "
              "os.environ['RESMON_SOURCE_TAPE'] = 'replay:/missing'; "
              "assert api_base._SOURCE_TAPE.mode == 'record'")
    result = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert json.loads((tmp_path / "tape/tape.json").read_text())["version"] == 1


@pytest.mark.parametrize("bounded", [False, True])
def test_record_and_replay_bytes_request_identity_and_headers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire, bounded: bool) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    body = b"\xff\x00<html>authored reply</html>"
    wire[0].append(httpx.Response(200, content=body, headers={"Content-Type": "text/html; charset=iso-8859-1"}))
    options = {"params": {"q": "graph", "page": 2}, "json": {"query": "graph", "limit": 4},
               "headers": {"Accept": "text/html"}}
    deadline = lambda: time.monotonic() + 3 if bounded else None
    actual = api_base.safe_request("POST", URL, deadline=deadline(), **options)
    saved = json.loads(next(root.glob("exchange-*.json")).read_text())
    assert saved["request"]["method"] == "POST"
    assert saved["request"]["json"] == options["json"]
    assert base64.b64decode(saved["response"]["body"]) == body
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    replay = api_base.safe_request("POST", URL, deadline=deadline(), **options)
    assert replay.content == actual.content
    assert replay.text == actual.text
    assert replay.headers["content-type"] == actual.headers["content-type"]
    assert api_base.search_outcome().attempts == 1
    assert len(wire[1]) == 1


def test_credentials_are_absent_from_every_file_and_do_not_change_the_key(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    secret = "authored-credential+/never-save"
    address = "authored-contact@example.invalid"
    reflected = f"{secret} {quote(secret, safe='')} {quote_plus(secret)} {address}".encode()
    wire[0].append(httpx.Response(200, content=reflected, headers={"Content-Type": "text/plain", "X-API-Key": secret}))
    api_base.safe_request("POST", URL + "?API_KEY=" + quote(secret, safe=""),
                         params={"apikey": secret, "key": secret, "token": secret, "email": address, "q": "graph"},
                         headers={"Authorization": "Bearer " + secret, "X-API-Key": secret, "X-Auth-Token": secret},
                         json={"query": "graph", "api_key": secret})
    for path in root.iterdir():
        contents = path.read_bytes()
        assert secret.encode() not in contents and address.encode() not in contents
        assert quote(secret, safe="").encode() not in contents
        value = json.loads(contents)
        if "response" in value:
            decoded = base64.b64decode(value["response"]["body"])
            assert secret.encode() not in decoded and address.encode() not in decoded
            assert REDACTED.encode() in decoded
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    response = api_base.safe_request("POST", URL, params={"q": "graph"}, json={"query": "graph"})
    assert response.status_code == 200


@pytest.mark.parametrize("change", ["method", "url", "params", "json", "header", "exhausted"])
def test_replay_miss_never_constructs_transport(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire, change: str) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    wire[0].append(httpx.Response(200, json={"ok": True}))
    api_base.safe_request("POST", URL, params={"q": "graph"}, json={"limit": 1}, headers={"Accept": "application/json"})
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    args = {"params": {"q": "graph"}, "json": {"limit": 1}, "headers": {"Accept": "application/json"}}
    if change == "params":
        args["params"] = {"q": "different"}
    elif change == "json":
        args["json"] = {"limit": 2}
    elif change == "header":
        args["headers"] = {"Accept": "text/xml"}
    elif change == "exhausted":
        api_base.safe_request("POST", URL, **args)
    with pytest.raises(TapeMiss, match="not on the tape"):
        api_base.safe_request("GET" if change == "method" else "POST",
                              URL + "/different" if change == "url" else URL, **args)
    assert api_base.search_outcome().last_call_failed
    assert api_base.search_outcome().tape_misses == 1


@pytest.mark.parametrize("failure", [httpx.ReadTimeout, httpx.ConnectError, httpx.ReadError,
                                     httpx.RemoteProtocolError, api_base.RequestDeadlineExceeded])
def test_transport_failures_are_recorded_and_replayed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire, failure: type[httpx.RequestError]) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    wire[0].append(failure("authored failure"))
    with pytest.raises(failure):
        api_base.safe_request("GET", URL, deadline=time.monotonic() + 2)
    before = api_base.search_outcome().snapshot()
    assert json.loads(next(root.glob("exchange-*.json")).read_text())["failure"] == failure.__name__
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    with pytest.raises(failure, match="Recorded source transport failure"):
        api_base.safe_request("GET", URL, deadline=time.monotonic() + 2)
    assert api_base.search_outcome().snapshot() == before


def test_retry_order_and_waits_are_the_same_and_reset_for_each_search(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    waits: list[float] = []
    monkeypatch.setattr(api_base.time, "sleep", waits.append)
    wire[0].extend([httpx.Response(503), httpx.Response(429, headers={"Retry-After": "0"}), httpx.Response(200, content=b"done")])
    api_base.safe_request("GET", URL, max_retries=2)
    before, original_waits = api_base.search_outcome().snapshot(), list(waits)
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    for _ in range(2):
        api_base.reset_search_outcome()
        waits.clear()
        assert api_base.safe_request("GET", URL, max_retries=2).content == b"done"
        assert api_base.search_outcome().snapshot() == before
        assert waits == original_waits == [1, 2]


@pytest.mark.parametrize("http_date", [False, True])
def test_retry_after_retains_cooldown_with_a_deadline(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire, http_date: bool) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    retry_after = ((datetime.now(UTC) + timedelta(seconds=120)).strftime("%a, %d %b %Y %H:%M:%S GMT")
                   if http_date else "120")
    wire[0].append(httpx.Response(429, headers={"Retry-After": retry_after}))
    monkeypatch.setattr(api_base.time, "sleep", lambda seconds: None)
    def ask() -> None:
        with pytest.raises(api_base.ServerCooldownActive):
            api_base.safe_request("GET", URL, max_retries=1, rate_limiter=api_base.RateLimiter(1000),
                                  deadline=time.monotonic() + 2)
    ask()
    before = api_base.search_outcome().snapshot()
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.now(tz) + timedelta(days=365)
    monkeypatch.setattr(api_base, "datetime", Later)
    ask()
    assert api_base.search_outcome().snapshot() == before


def test_expired_deadline_reads_nothing_and_rate_limit_still_admits_replay(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    wire[0].append(httpx.Response(200))
    api_base.safe_request("GET", URL)
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    with pytest.raises(api_base.RequestDeadlineExceeded):
        api_base.safe_request("GET", URL, deadline=time.monotonic() - 1)
    assert api_base.search_outcome().attempts == 0
    limiter = api_base.RateLimiter(100)
    calls: list[object] = []
    monkeypatch.setattr(limiter, "acquire", lambda **kw: calls.append(kw))
    assert api_base.safe_request("GET", URL, rate_limiter=limiter).status_code == 200
    assert calls == [{}]


def test_atomic_write_keeps_completed_exchanges_readable_after_interruption(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    wire[0].extend([httpx.Response(200, content=b"first"), httpx.Response(200, content=b"second")])
    api_base.safe_request("GET", URL)
    def interrupted(*args: object) -> None:
        raise OSError("authored interrupted replacement")
    monkeypatch.setattr(os, "replace", interrupted)
    with pytest.raises(httpx.TransportError, match="could not record"):
        api_base.safe_request("GET", URL + "/second")
    assert len(list(root.glob("exchange-*.json"))) == 1
    assert not list(root.glob(".exchange-*"))
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    assert api_base.safe_request("GET", URL).content == b"first"


@pytest.fixture
def conn() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(":memory:")
    database.init_db(conn=connection)
    yield connection
    connection.close()


def _previous(conn: sqlite3.Connection, routine: int, start: str) -> int:
    execution = database.insert_execution(conn, {"execution_type": "automated_sweep", "routine_id": routine,
                                                "start_time": start, "parameters": "{}"})
    database.record_execution_source(conn, execution, "crossref", "ok", result_count=1)
    database.update_execution_status(conn, execution, "completed")
    return execution


def test_since_previous_watch_reuses_recorded_dates_and_real_pipeline(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire, conn: sqlite3.Connection) -> None:
    root = tmp_path / "tape"
    monkeypatch.setattr(api_crossref, "_CROSSREF_API_URL", URL)
    monkeypatch.setattr(api_crossref, "_RATE_LIMITER", api_base.RateLimiter(10000))
    params = {"query": "graph", "keywords": ["graph"], "repositories": ["crossref"],
              "max_results": 2, "date_window": {"since": "previous_run"}}
    routine = database.insert_routine(conn, {"name": "authored watch", "schedule_cron": "0 8 * * *",
                                             "parameters": json.dumps(params), "is_active": 0})
    _previous(conn, routine, "2026-11-07T08:00:00Z")
    recorded_params = dict(params)
    date_window.apply(conn, routine, recorded_params, now=datetime(2026, 11, 9, tzinfo=UTC), tz=UTC)
    assert recorded_params["date_from"] == "2026-11-04"
    _enable(monkeypatch, root, "record")
    wire[0].append(httpx.Response(200, json={"message": {"items": [{
        "DOI": "10.0000/authored-graph", "title": ["Authored graph paper"],
        "abstract": "An authored abstract.", "published": {"date-parts": [[2026, 11, 8]]}, "author": []}]}}))
    result = SweepEngine(db_conn=conn, config={}).execute_sweep(["crossref"], recorded_params)
    assert result["result_count"] == 1
    original_sources = database.get_execution_sources(conn, result["execution_id"])
    _previous(conn, routine, "2026-12-07T08:00:00Z")
    later_params = dict(params)
    date_window.apply(conn, routine, later_params, now=datetime(2026, 12, 9, tzinfo=UTC), tz=UTC)
    assert later_params["date_from"] == "2026-12-04"
    tape = _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    for _ in range(2):
        engine = SweepEngine(db_conn=conn, config={})
        execution = engine.prepare_execution("automated_sweep", ["crossref"], later_params, routine_id=routine)
        result = engine.run_prepared(execution)
        row = database.get_execution_by_id(conn, execution)
        stored = json.loads(row["parameters"])
        assert stored["date_from"] == "2026-11-04"
        assert stored["source_tape"]["mode"] == "replay"
        assert stored["source_tape"]["recorded_at"] == tape.recorded_at
        assert row["status"] == "completed" and row["result_count"] == 1
        assert result["new_count"] == 0  # The production deduplicator recognized the stored paper.
        sources = database.get_execution_sources(conn, execution)
        assert [(s["source"], s["status"], s["result_count"], s["zero_reason"]) for s in sources] == [
            (s["source"], s["status"], s["result_count"], s["zero_reason"]) for s in original_sources]
        assert tape.message in Path(row["log_path"]).read_text()
        record = search_record.build(conn, execution)
        assert tape.message in record["coverage"]["summary"]
        markdown = search_record.to_markdown(record)
        assert "Source replay uses a recording made on November" in markdown
        assert "from 2026-11-04" in markdown
    assert len(wire[1]) == 1


def test_a_missing_replay_is_a_failed_source_in_the_run_record_and_log(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire, conn: sqlite3.Connection) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    monkeypatch.setattr(api_crossref, "_CROSSREF_API_URL", URL)
    result = SweepEngine(db_conn=conn, config={}).execute_sweep(["crossref"], {"query": "not recorded"})
    row = database.get_execution_by_id(conn, result["execution_id"])
    sources = database.get_execution_sources(conn, result["execution_id"])
    assert row["status"] == "failed"
    assert sources[0]["zero_reason"] == "upstream_failure"
    assert "not on the tape" in Path(row["log_path"]).read_text()


def test_fixed_dates_remain_exact_and_live_restart_clears_replay_marker(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire, conn: sqlite3.Connection) -> None:
    root = tmp_path / "tape"
    tape = _enable(monkeypatch, root, "record")
    first = {"query": "graph", "date_from": "2026-11-01", "date_to": "2026-11-09"}
    tape.prepare_run(first)
    replay = _enable(monkeypatch, root, "replay")
    changed = {"query": "graph", "date_from": "2026-12-01", "date_to": "2026-12-09"}
    replay.prepare_run(changed)
    assert changed["date_from"] == "2026-12-01"
    assert changed["source_tape"]["scope"] != first["source_tape"]["scope"]
    monkeypatch.setattr(api_base, "_SOURCE_TAPE", None)
    engine = SweepEngine(db_conn=conn, config={})
    execution = engine.prepare_execution("deep_sweep", [], changed)
    assert "source_tape" not in json.loads(database.get_execution_by_id(conn, execution)["parameters"])


@pytest.mark.parametrize("setting", ["invalid:/tmp/tape", "record:relative", "record:",
                                    "record:" + str(Path(__file__).resolve().parents[2] / "tapes")])
def test_invalid_settings_refuse_to_start(setting: str) -> None:
    with pytest.raises(ValueError):
        SourceTape(setting)


@pytest.mark.parametrize("header", ["Authorization", "X-API-Key", "X-Auth-Token", "Cookie", "Proxy-Authorization"])
def test_header_only_credentials_are_scrubbed_even_when_echoed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire, header: str) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    secret = "authored-header-credential"
    wire[0].append(httpx.Response(200, content=secret))
    api_base.safe_request("GET", URL, headers={header: "Bearer " + secret if "Authorization" in header else secret})
    saved = json.loads(next(root.glob("exchange-*.json")).read_text())
    assert secret not in json.dumps(saved)
    assert secret.encode() not in base64.b64decode(saved["response"]["body"])


def test_form_body_xml_and_query_order_replay_without_losing_keyword_identity(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    wire[0].append(httpx.Response(200, content=b"<results><title>Authored</title></results>",
                                   headers={"Content-Type": "application/xml"}))
    api_base.safe_request("POST", URL + "?ignored=1", params={"keyword": "graph", "limit": 4, "page": 1},
                         data={"q": "graph", "api_key": "authored-form-key"})
    saved = json.loads(next(root.glob("exchange-*.json")).read_text())
    assert "authored-form-key" not in json.dumps(saved)
    assert saved["request"]["data"]["api_key"] == REDACTED
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    response = api_base.safe_request("POST", URL, params={"limit": 4, "page": 1, "keyword": "graph"}, data={"q": "graph"})
    assert response.text == "<results><title>Authored</title></results>"
    api_base.reset_search_outcome()
    with pytest.raises(TapeMiss):
        api_base.safe_request("POST", URL, params={"limit": 4, "page": 1, "keyword": "different"}, data={"q": "graph"})


def test_implicit_source_calendar_days_are_frozen_without_changing_live_clock(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    root = tmp_path / "tape"
    tape = _enable(monkeypatch, root, "record")
    original = (api_hal._utc_today(), api_ndl_search._utc_today(), api_biorxiv._local_today())
    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2030, 1, 1, tzinfo=tz)

        @classmethod
        def today(cls):
            return datetime(2030, 1, 1).date()
    monkeypatch.setattr(api_hal, "datetime", Later)
    monkeypatch.setattr(api_ndl_search, "datetime", Later)
    monkeypatch.setattr(api_biorxiv, "date", Later)
    _enable(monkeypatch, root, "replay")
    assert (api_hal._utc_today(), api_ndl_search._utc_today(), api_biorxiv._local_today()) == original
    assert original[0] == datetime.fromisoformat(tape.recorded_at).date()
    monkeypatch.setattr(api_base, "_SOURCE_TAPE", None)
    assert api_hal._utc_today().isoformat() == "2030-01-01"
    assert api_ndl_search._utc_today().isoformat() == "2030-01-01"
    assert api_biorxiv._local_today().isoformat() == "2030-01-01"


def test_corrupt_exchange_fails_closed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    wire[0].append(httpx.Response(200))
    api_base.safe_request("GET", URL)
    next(root.glob("exchange-*.json")).write_text("{unfinished")
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    with pytest.raises(TapeMiss, match="not on the tape"):
        api_base.safe_request("GET", URL)


@pytest.mark.parametrize("bounded", [False, True])
def test_real_loopback_exchange_replays_the_bytes_given_to_parsers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, bounded: bool) -> None:
    payload = b"<papers><title>Authored graph paper</title></papers>"
    encoded = gzip.compress(payload)
    seen: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            seen.append(self.path)
            self.send_response(200)
            self.send_header("Content-Type", "application/xml")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    root = tmp_path / "tape"
    url = f"http://127.0.0.1:{server.server_port}/papers"
    _enable(monkeypatch, root, "record")
    try:
        actual = api_base.safe_request("GET", url, params={"q": "graph"},
                                       deadline=time.monotonic() + 3 if bounded else None)
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=3)
    assert actual.content == payload and seen == ["/papers?q=graph"]
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    replay = api_base.safe_request("GET", url, params={"q": "graph"},
                                   deadline=time.monotonic() + 3 if bounded else None)
    assert replay.content == payload
    assert replay.text == actual.text


@pytest.mark.parametrize("option", [{"data": "key=authored-key"}, {"content": b"authored bytes"},
                                   {"auth": ("authored-user", "authored-key")}])
def test_unrepresented_body_or_credentials_fail_before_transport(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire, option: dict[str, object]) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    with pytest.raises(httpx.TransportError, match="could not record"):
        api_base.safe_request("POST", URL, **option)
    assert wire[1] == [] and not list(root.glob("exchange-*.json"))


def test_repeated_exchange_cannot_replace_an_earlier_reply_with_a_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, wire: Wire) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    wire[0].extend([httpx.Response(200, content=b"first"), httpx.ConnectError("authored failure")])
    api_base.safe_request("GET", URL)
    api_base.reset_search_outcome()
    with pytest.raises(httpx.ConnectError, match="authored failure"):
        api_base.safe_request("GET", URL)
    saved = [json.loads(path.read_text()) for path in root.glob("exchange-*.json")]
    assert len(saved) == 2
    assert sum(value.get("failure") == "ConnectError" for value in saved) == 1
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    assert api_base.safe_request("GET", URL).content == b"first"


def test_key_follows_httpx_query_replacement_instead_of_merging(monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
                                                             wire: Wire) -> None:
    root = tmp_path / "tape"
    _enable(monkeypatch, root, "record")
    wire[0].append(httpx.Response(200, content=b"authored"))
    api_base.safe_request("GET", URL + "?ignored=1", params={"q": "graph"})
    assert str(wire[1][0].url) == URL + "?q=graph"
    _enable(monkeypatch, root, "replay")
    _no_wire(monkeypatch)
    assert api_base.safe_request("GET", URL + "?q=graph").content == b"authored"
    api_base.reset_search_outcome()
    with pytest.raises(TapeMiss):
        api_base.safe_request("GET", URL + "?ignored=1&q=graph")
