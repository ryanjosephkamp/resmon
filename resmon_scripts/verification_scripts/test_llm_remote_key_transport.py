# resmon_scripts/verification_scripts/test_llm_remote_key_transport.py
"""Where ``llm_remote`` puts a BYOK credential on the wire.

``assistant_api_runtime`` was fixed for this: Google's v1beta endpoint accepts
``?key=<secret>`` and the runtime used to send it that way. ``llm_remote`` is
its sibling and had the same line, in ``_google_request``.

**There is no log leak in this module**, which is why nobody caught it. Every
raise path goes through ``_as_ai_error`` or ``_sanitize_error``, both of which
strip the key by exact value before anything is logged. What a sanitizer cannot
reach is the request itself: a query string is written down by every proxy
between here and the provider, lands in any access log along the way, and is
quoted back by anything that reports the URL it tried. ``x-goog-api-key`` is the
header the Generative Language API documents for this same endpoint.

**These tests assert on the request object ``httpx`` actually builds.** Two of
the five builders are driven through a real ``httpx.Client`` over
``httpx.MockTransport`` -- real URL parsing, real header assembly, real
``Request`` -- and the other three through the real ``anthropic`` SDK over a
real loopback socket, so the SDK's own transport decides where the key goes
rather than this file assuming it. A ``MagicMock`` standing in for
``httpx.Client`` would have recorded the f-string the module passed it and told
us nothing about the request.

What this cannot see: whether Google honors ``x-goog-api-key`` for the models
``llm_remote`` names. That is a live-network fact and no test here spends a
token. ``test_assistant_api_key_boundary`` makes the same argument for the
runtime and has the same hole.
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import llm_remote  # noqa: E402

# Shaped like a real Google key on purpose, so a redaction layer that works by
# *shape* cannot make a URL assertion pass for the wrong reason. The opaque one
# matches no shape at all.
GOOGLE_SHAPED_KEY = "AIzaSyCANARY0000000000000000000000000000"
OPAQUE_KEY = "canary-llm-remote-9c41-not-a-real-key"

# Every place this module puts a credential on the wire, read off the source.
# The list is the denominator for "no builder puts the key in a URL": three
# ``httpx`` calls and two through the ``anthropic`` SDK.
#
#   1. _openai_compatible_request   client.post(.../chat/completions)
#   2. _google_request              client.post(<generateContent>)
#   3. list_available_models        client.get(.../models)      [openai-compatible]
#   4. list_available_models        self._anthropic.models.list()
#   5. _call_anthropic              self._anthropic.messages.create()
#
# ``list_available_models`` on provider=google returns ``[self.model]`` without
# a request at all, so it is not a sixth.
REQUEST_BUILDERS = 5

_OPENAI_COMPAT_OK = {"choices": [{"message": {"content": "ok"}}]}
_GOOGLE_OK = {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
_MODELS_OK = {"data": [{"id": "some-model"}]}


# ---------------------------------------------------------------------------
# The two httpx builders: a real client over a mock transport
# ---------------------------------------------------------------------------

class _RecordingTransport(httpx.MockTransport):
    """A real transport that keeps the ``httpx.Request`` it was handed.

    ``httpx`` has already parsed the URL and assembled the headers by the time
    a transport sees the request, so ``recorded[0].url`` and
    ``recorded[0].headers`` are what would have gone out on the socket. A
    transport can also fail the way the network fails -- raise
    ``httpx.ConnectError``, answer 404 -- which a ``MagicMock`` cannot.
    """

    def __init__(self, payload: dict[str, Any], status: int = 200) -> None:
        self.recorded: list[httpx.Request] = []

        def _handle(request: httpx.Request) -> httpx.Response:
            self.recorded.append(request)
            return httpx.Response(status, json=payload)

        super().__init__(_handle)


@pytest.fixture
def through_mock_transport(monkeypatch):
    """Make ``llm_remote``'s ``httpx.Client(...)`` a real client on a transport."""
    real_client = httpx.Client

    def _install(payload: dict[str, Any], status: int = 200) -> _RecordingTransport:
        transport = _RecordingTransport(payload, status)

        def _factory(*args, **kwargs):
            kwargs.pop("transport", None)
            return real_client(*args, transport=transport, **kwargs)

        monkeypatch.setattr(llm_remote.httpx, "Client", _factory)
        return transport

    return _install


def test_google_summarize_sends_the_key_in_the_header_not_the_query_string(
    through_mock_transport,
):
    """The defect: ``f"{model}:generateContent?key={api_key}"``.

    Asserting the key is absent from the URL is half of it. A key moved to a
    header resmon invented would leave the call unauthenticated and the failure
    would read as a bad key, so the slot is named too.
    """
    transport = through_mock_transport(_GOOGLE_OK)
    client = llm_remote.RemoteLLMClient(
        provider="google", api_key=GOOGLE_SHAPED_KEY, model="gemini-1.5-flash")
    client.summarize("sample text", {"length": "standard"})

    assert len(transport.recorded) == 1
    request = transport.recorded[0]

    assert GOOGLE_SHAPED_KEY not in str(request.url), (
        f"the key rode in the request line: {request.url}")
    assert "key=" not in (request.url.query.decode() or "")
    assert request.headers.get("x-goog-api-key") == GOOGLE_SHAPED_KEY
    # One slot, not several: a key copied into a second header is a second
    # place it can leak from.
    assert request.headers.get("authorization") is None
    assert request.headers.get("x-api-key") is None


def test_google_summarize_still_reaches_the_documented_endpoint(through_mock_transport):
    """Moving the key must not move the call."""
    transport = through_mock_transport(_GOOGLE_OK)
    client = llm_remote.RemoteLLMClient(
        provider="google", api_key=GOOGLE_SHAPED_KEY, model="gemini-1.5-flash")
    client.summarize("sample text", {"length": "standard"})

    url = str(transport.recorded[0].url)
    assert url == (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "gemini-1.5-flash:generateContent"
    )


@pytest.mark.parametrize("provider", sorted(llm_remote._PROVIDER_SPECS))
def test_no_openai_compatible_builder_puts_the_key_in_a_url(provider, through_mock_transport):
    """Builder 1 and builder 3, over every spec in ``_PROVIDER_SPECS``.

    Denominator: ``llm_remote._PROVIDER_SPECS``, read from the module rather
    than listed here, so a provider added later is covered without an edit.
    """
    transport = through_mock_transport(_OPENAI_COMPAT_OK)
    client = llm_remote.RemoteLLMClient(
        provider=provider, api_key=OPAQUE_KEY,
        model=llm_remote._PROVIDER_SPECS[provider].default_model)
    client.summarize("sample text", {"length": "standard"})

    transport_models = through_mock_transport(_MODELS_OK)
    client.list_available_models()

    recorded = transport.recorded + transport_models.recorded
    assert len(recorded) == 2, recorded
    for request in recorded:
        assert OPAQUE_KEY not in str(request.url), (
            f"{provider} sent the key in the request line: {request.url}")
        assert request.headers.get("authorization") == f"Bearer {OPAQUE_KEY}"


def test_custom_provider_builder_puts_the_key_in_a_header(through_mock_transport):
    """The ``custom`` provider builds its own spec from a user-supplied URL.

    It is the one spec that is not in ``_PROVIDER_SPECS``, so the parametrized
    case above cannot reach it.
    """
    transport = through_mock_transport(_OPENAI_COMPAT_OK)
    client = llm_remote.RemoteLLMClient(
        provider="custom", api_key=OPAQUE_KEY, model="some-model",
        custom_base_url="https://example.invalid/v1/")
    client.summarize("sample text", {"length": "standard"})

    request = transport.recorded[0]
    assert OPAQUE_KEY not in str(request.url)
    assert request.headers.get("authorization") == f"Bearer {OPAQUE_KEY}"


# ---------------------------------------------------------------------------
# The two SDK builders: the real anthropic client over a real loopback socket
# ---------------------------------------------------------------------------

class _RecordingAnthropicServer:
    """A loopback server that answers the two Anthropic routes and records both.

    The ``anthropic`` SDK owns its own transport, so the only honest way to say
    where it puts the key is to read what arrives. ``ANTHROPIC_BASE_URL`` is the
    SDK's own override (``Anthropic.__init__`` reads it when ``base_url`` is
    ``None``), which is how ``llm_remote`` constructs it.
    """

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "_RecordingAnthropicServer":
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # noqa: A003
                pass

            def _record(self) -> None:
                outer.calls.append({
                    "method": self.command,
                    "path": self.path,
                    "x_api_key": self.headers.get("x-api-key"),
                    "authorization": self.headers.get("Authorization"),
                })

            def _send(self, body: dict) -> None:
                payload = json.dumps(body).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):  # noqa: N802
                self._record()
                self._send({"data": [{"id": "claude-test", "type": "model"}],
                            "has_more": False, "first_id": None, "last_id": None})

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                self._record()
                self._send({
                    "id": "msg_test", "type": "message", "role": "assistant",
                    "model": "claude-test", "stop_reason": "end_turn",
                    "stop_sequence": None,
                    "content": [{"type": "text", "text": "ok"}],
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                })

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True,
            name="llm-remote-anthropic-server")
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
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


def test_anthropic_sdk_builders_put_the_key_in_a_header(monkeypatch):
    """Builders 4 and 5, through the real SDK and a real socket.

    ``llm_remote`` hands the key to ``anthropic.Anthropic(api_key=...)`` and
    never sees the request again; this is the only way to establish that the
    SDK does not spend it in a query string.
    """
    with _RecordingAnthropicServer() as server:
        monkeypatch.setenv("ANTHROPIC_BASE_URL", server.base_url)
        client = llm_remote.RemoteLLMClient(
            provider="anthropic", api_key=OPAQUE_KEY, model="claude-test")
        client.summarize("sample text", {"length": "standard"})
        client.list_available_models()
        calls = list(server.calls)

    assert len(calls) == 2, calls
    assert {call["method"] for call in calls} == {"POST", "GET"}
    for call in calls:
        assert OPAQUE_KEY not in call["path"], (
            f"the SDK sent the key in the request line: {call['path']}")
        assert "key=" not in call["path"]
        assert call["x_api_key"] == OPAQUE_KEY


def test_the_module_has_no_other_place_to_put_a_key():
    """The denominator is five, and it is checked against the source.

    If a sixth builder appears, this fails and whoever added it has to say
    whether the cases above still cover the module.
    """
    source = Path(llm_remote.__file__).read_text(encoding="utf-8")
    httpx_calls = [
        line.strip() for line in source.splitlines()
        if ("client.post(" in line or "client.get(" in line)
        and not line.strip().startswith("#")
    ]
    sdk_calls = [
        line.strip() for line in source.splitlines()
        if "self._anthropic." in line and not line.strip().startswith("#")
    ]
    assert len(httpx_calls) + len(sdk_calls) == REQUEST_BUILDERS, (
        f"llm_remote now has {len(httpx_calls) + len(sdk_calls)} request "
        f"builders, not {REQUEST_BUILDERS}: {httpx_calls + sdk_calls}"
    )
