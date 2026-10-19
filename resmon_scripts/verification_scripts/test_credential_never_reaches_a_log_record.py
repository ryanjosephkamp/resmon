# resmon_scripts/verification_scripts/test_credential_never_reaches_a_log_record.py
"""A sentinel provider key reaches no log record, on the **root** logger.

Why root rather than the module's own logger. The original leak was not
resmon's log line -- that line was already sanitized. It was ``httpx``, which
logs every request at INFO as ``HTTP Request: POST <url> "HTTP/1.1 404 ..."``
with the URL intact, and ``httpcore``, which writes the request target at
DEBUG. Neither is a resmon logger, both propagate to root, and the backend
installs no root handler, so those records go out through
``logging.lastResort`` to stderr, which Electron pipes into the main process
console. A fixture attached to ``implementation_scripts.*`` watches the one
place that was never the problem.

What stood here before. Exactly one test in the merge gate holds this
property: ``test_assistant_api_key_boundary``'s
``test_a_key_echoed_back_by_the_provider_is_redacted_in_the_log``, and it
reaches the sanitizer by replacing ``_post`` with a function that raises a
message it authored -- deliberately, to prove the exact-value layer runs, but
it therefore never drives ``httpx`` at all. The natural second hold, the
``backend.log`` canary in ``test_assistant_live``, is ``needs_agent_cli``, so
CI never runs it.

What this file drives. Four failure shapes, because a 4xx is the one that is
easy to think of and the other three unwind through different code:

    connection refused · read timeout · HTTP 404 · a 200 that is not JSON

against both modules that hold a BYOK key -- ``assistant_api_runtime`` over a
real loopback socket (so ``httpcore`` is in scope as well as ``httpx``) and
``llm_remote`` over a real ``httpx.Client`` on a mock transport, which is the
only way to reach a module whose endpoint host is hard-coded. Every record any
logger emits is captured and formatted, ``exc_info`` included, and the sentinel
must appear in none of them.

``test_the_capture_sees_a_key_that_is_really_there`` plants the leak and
watches this harness catch it. Without that case the file would pass equally
well if the handler were attached to nothing.

**Made to go red.** Putting the key back in the query string in both modules
-- ``llm_remote._google_request`` and ``assistant_api_runtime._call_google``
-- fails 4 of the 21 cases here: the two ``google`` server failures and the
two ``google`` ``llm_remote`` ones. The record that fails them is
``INFO httpx HTTP Request: POST …?key=<sentinel>``, while resmon's own line in
the same run reads ``?key=[REDACTED]`` -- which is the whole argument for
watching root rather than ``implementation_scripts``.

What this does not establish. The **refused-connection and read-timeout cases
cannot catch a key in a URL**: ``httpx`` writes its request line only once a
response has arrived, and ``httpcore``'s trace records carry no URL, so those
cases hold the resmon-authored sentence and nothing more. They stay because
they are different unwind paths through ``_sentence_for``, not because they
watch the query string. Beyond that: only the records emitted during these
four failures are read, so this says nothing about any other library on the
path; nothing here reads ``backend.log``, so it says nothing about what a
running backend writes to disk -- that remains the ``needs_agent_cli``
canary's job; and it says nothing about a key reaching a log by some route
other than a failed provider call.
"""

from __future__ import annotations

import json
import logging
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import assistant_api_runtime as ak  # noqa: E402
from implementation_scripts import llm_remote  # noqa: E402

# Matches none of ``ai_errors._KEY_SHAPES``. A key shaped like a real one
# would be scrubbed by the pattern layer wherever it appeared, and every
# assertion below would then pass without the exact-value layer or the
# header move having anything to do with it.
SENTINEL = "canary-root-logger-5d81-not-a-real-key"

# The families ``assistant_tool_calling`` dispatches on, one provider each --
# the same mapping ``test_assistant_api_runtime`` and
# ``test_assistant_api_key_boundary`` use, so a family cannot be checked twice
# and a family without a provider cannot hide.
PROVIDER_FOR_FAMILY = {"anthropic": "anthropic", "openai": "openai", "google": "google"}


# ---------------------------------------------------------------------------
# Every record, from every logger
# ---------------------------------------------------------------------------


class _RootCapture(logging.Handler):
    """Formatted records from the whole tree, ``exc_info`` rendered.

    Formatting is the point. ``logger.exception`` puts the leak in
    ``exc_info`` rather than in ``record.msg``, and only a formatter renders
    it, so a fixture asserting on ``getMessage()`` would pass over the defect
    this file exists for. ``record.args`` is checked separately because a
    handler that never formats -- a queue handler, a structured-log sink --
    pickles the args instead.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.NOTSET)
        self.records: list[logging.LogRecord] = []
        self.formatter = logging.Formatter("%(levelname)s %(name)s %(message)s")

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    @property
    def text(self) -> str:
        rendered = []
        for record in self.records:
            rendered.append(self.format(record))
            if record.exc_info:
                rendered.append(logging.Formatter().formatException(record.exc_info))
            rendered.append(repr(record.args))
        return "\n".join(rendered)

    @property
    def loggers(self) -> set[str]:
        return {record.name for record in self.records}


@pytest.fixture
def root_logs():
    """Attach to root at DEBUG and make sure ``httpx``/``httpcore`` get there.

    Both default to propagating, but a level set anywhere above them would
    drop the records before a handler saw them, and a file that silently
    captured nothing would pass every assertion below.
    """
    handler = _RootCapture()
    root = logging.getLogger()
    previous_root_level = root.level
    previous_disable = logging.root.manager.disable

    touched: dict[str, tuple[int, bool]] = {}
    for name in ("httpx", "httpcore", "implementation_scripts"):
        logger = logging.getLogger(name)
        touched[name] = (logger.level, logger.propagate)
        logger.setLevel(logging.DEBUG)
        logger.propagate = True

    logging.disable(logging.NOTSET)
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        yield handler
    finally:
        root.removeHandler(handler)
        root.setLevel(previous_root_level)
        logging.disable(previous_disable)
        for name, (level, propagate) in touched.items():
            logger = logging.getLogger(name)
            logger.setLevel(level)
            logger.propagate = propagate


# ---------------------------------------------------------------------------
# The four failures, as a real server and a real transport produce them
# ---------------------------------------------------------------------------


class _FailingServer:
    """A loopback server that answers one way: ``status_404``, ``not_json``
    or ``never`` (accept the connection and read nothing, so the client's read
    deadline is what ends the call).
    """

    def __init__(self, mode: str) -> None:
        assert mode in ("status_404", "not_json", "never"), mode
        self.mode = mode
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "_FailingServer":
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # noqa: A003
                pass

            def _drain(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)

            def _answer(self, status: int, body: bytes, ctype: str) -> None:
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):  # noqa: N802
                self._drain()
                if outer.mode == "status_404":
                    self._answer(404, b'{"error":{"message":"no such model"}}',
                                 "application/json")
                elif outer.mode == "not_json":
                    # A gateway's HTML error page with a 200, which is how a
                    # captive proxy answers and how the DBLP challenge
                    # arrives: the client raises a JSON decode error and never
                    # sees a status at all.
                    self._answer(200, b"<html><body>not json</body></html>",
                                 "text/html")
                else:
                    # Accept, answer nothing. The client's read deadline ends it.
                    outer._stall.wait(timeout=30)

            def do_GET(self):  # noqa: N802
                self.do_POST()

        self._stall = threading.Event()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True, name="failing-server")
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stall.set()
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"


def _closed_port() -> int:
    """A loopback port with nothing listening on it.

    Bound and released, so the number is one the kernel just handed out rather
    than one guessed -- and so this never touches a port another process owns.
    """
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


# ``_post`` reads ``REQUEST_TIMEOUT`` at call time, so the read deadline is
# shortened rather than waiting out the shipped 180 seconds.
_SHORT = httpx.Timeout(5.0, connect=2.0, read=0.4)


def _runtime(family: str, base_url: str) -> ak.ApiKeyRuntime:
    return ak.ApiKeyRuntime(
        provider=PROVIDER_FOR_FAMILY[family], model="test-model",
        base_url=base_url, api_key=SENTINEL,
    )


def _drive(runtime: ak.ApiKeyRuntime) -> list[dict]:
    return list(runtime.run_turn(1, "what is new this week?"))


# ---------------------------------------------------------------------------
# assistant_api_runtime, over a real socket
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("family", sorted(PROVIDER_FOR_FAMILY))
@pytest.mark.parametrize("mode", ["status_404", "not_json", "never"])
def test_a_server_failure_puts_no_key_in_any_log_record(family, mode, root_logs,
                                                        monkeypatch):
    """Three of the four shapes, over every family, against a real server."""
    monkeypatch.setattr(ak, "REQUEST_TIMEOUT", _SHORT)
    with _FailingServer(mode) as server:
        events = _drive(_runtime(family, server.base_url))

    assert any(event["type"] == "error" for event in events), events
    assert root_logs.records, (
        "a failed turn that logs nothing at all is not the fix either: the "
        "operator still needs to know the turn failed"
    )
    # ``httpx``'s request line is written once a response has arrived, so the
    # read-timeout case never reaches it -- ``httpcore``'s trace is what is in
    # scope there, and it is the other half of the original leak. Asserting
    # the right one per mode keeps "this run exercised the third-party
    # loggers" an assertion rather than a hope.
    expected_logger = "httpcore" if mode == "never" else "httpx"
    assert any(name.split(".")[0] == expected_logger for name in root_logs.loggers), (
        f"{expected_logger} logged nothing, so this run did not exercise the "
        f"logger the original leak came from: {sorted(root_logs.loggers)}"
    )
    assert SENTINEL not in root_logs.text, root_logs.text
    assert SENTINEL not in json.dumps(events)


@pytest.mark.parametrize("family", sorted(PROVIDER_FOR_FAMILY))
def test_a_refused_connection_puts_no_key_in_any_log_record(family, root_logs,
                                                            monkeypatch):
    """The fourth shape. No server, so the failure is in the connect.

    Worth its own case: nothing ever reaches ``raise_for_status``, the
    exception type is ``httpx.ConnectError`` rather than ``HTTPStatusError``,
    and it is raised from inside ``httpcore``'s own frames.
    """
    monkeypatch.setattr(ak, "REQUEST_TIMEOUT", _SHORT)
    events = _drive(_runtime(family, f"http://127.0.0.1:{_closed_port()}"))

    assert any(event["type"] == "error" for event in events), events
    assert SENTINEL not in root_logs.text, root_logs.text
    assert SENTINEL not in json.dumps(events)


# ---------------------------------------------------------------------------
# llm_remote, over a real httpx.Client on a mock transport
# ---------------------------------------------------------------------------


def _transport(behavior: Callable[[httpx.Request], Any]) -> httpx.MockTransport:
    return httpx.MockTransport(behavior)


_LLM_FAILURES: dict[str, Callable[[httpx.Request], Any]] = {
    # Raised by the transport rather than constructed above it, so each
    # carries the request ``httpx`` built -- URL included, which is the thing
    # under test.
    "connect_refused": lambda request: (_ for _ in ()).throw(
        httpx.ConnectError("[Errno 61] Connection refused", request=request)),
    "read_timeout": lambda request: (_ for _ in ()).throw(
        httpx.ReadTimeout("timed out", request=request)),
    "status_404": lambda request: httpx.Response(
        404, json={"error": {"message": "no such model"}}, request=request),
    "not_json": lambda request: httpx.Response(
        200, text="<html><body>not json</body></html>", request=request),
}


@pytest.mark.parametrize("failure", sorted(_LLM_FAILURES))
@pytest.mark.parametrize("provider", ["google", "openai"])
def test_llm_remote_puts_no_key_in_any_log_record(failure, provider, root_logs,
                                                  monkeypatch):
    """The summary lane's client, whose endpoint host cannot be redirected.

    ``_google_request`` names ``generativelanguage.googleapis.com`` in the
    module, so a loopback server cannot stand in for it. A real
    ``httpx.Client`` on a mock transport is the next-best thing and keeps the
    part that matters: ``httpx`` builds the request, parses the URL and logs
    it exactly as it would on a socket.
    """
    real_client = httpx.Client
    transport = _transport(_LLM_FAILURES[failure])

    def _factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr(llm_remote.httpx, "Client", _factory)

    client = llm_remote.RemoteLLMClient(
        provider=provider, api_key=SENTINEL, model="some-model")
    with pytest.raises(Exception) as caught:
        client.summarize("sample abstract text", {"length": "standard"})

    assert SENTINEL not in str(caught.value), (
        "the exception resmon raises carries the key to whatever logs it")
    assert root_logs.records, "no record at all means nothing was exercised"
    assert SENTINEL not in root_logs.text, root_logs.text


# ---------------------------------------------------------------------------
# The harness can see a leak
# ---------------------------------------------------------------------------


def test_the_capture_sees_a_key_that_is_really_there(root_logs):
    """Without this, every case above would pass with the handler unattached.

    A plain ``httpx`` request with the key in the query string, which is the
    exact shape both modules used to send: ``httpx`` logs the request line at
    INFO, the record propagates to root, and the capture has to find it.
    """
    with _FailingServer("status_404") as server:
        with httpx.Client(timeout=_SHORT) as client:
            response = client.post(
                f"{server.base_url}/v1beta/models/m:generateContent?key={SENTINEL}",
                json={"contents": []},
            )
            with pytest.raises(httpx.HTTPStatusError):
                response.raise_for_status()

    assert "httpx" in root_logs.loggers
    assert SENTINEL in root_logs.text, (
        "the capture did not see a key that httpx definitely logged, so every "
        "other case in this file is passing on an empty record list"
    )
