"""The API-key assistant's credential boundary: R6, on the log and on the wire.

Two properties, both about a value the user never typed into a conversation and
must never find written down anywhere.

**The key does not reach a log handler.** ``run_turn``'s catch-all used to call
``logger.exception`` before building its sanitized sentence. ``logger.exception``
writes the raw traceback, an ``httpx.HTTPStatusError``'s message carries the
request URL, and the backend installs no root handler at all — so the record
fell through to ``logging.lastResort`` and onto stderr, which Electron pipes
into the main process' console. The user-facing sentence was always clean; only
the log was not.

**The key does not ride in a URL.** Google's v1beta endpoint accepts
``?key=<secret>``, which is how this runtime sent it. A query string is the one
part of a request that is written down by every proxy in between and echoed
back in the error messages of anything that quotes the URL — including the
exception above. The provider offers ``x-goog-api-key`` for exactly this reason.

Both are checked against a real socket (``provider_server.ProviderServer``): a
real ``httpx`` request, a real status code, a real exception. What that cannot
see is whether Google itself honors ``x-goog-api-key`` for the model this
runtime names — that is a live-network fact and no test here spends a token.

The tests assert on **what reaches the log handler**, not on what reaches the
user. The existing canary that reads ``backend.log``
(``test_assistant_live.test_a_credential_value_never_reaches_the_conversation``)
is ``needs_agent_cli`` and covers the CLI runtime only, so nothing in the merge
gate watched this path.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from implementation_scripts import assistant_api_runtime as ak  # noqa: E402
from provider_server import ProviderServer                      # noqa: E402

# One provider per family, so a family cannot be checked through the same
# provider twice and a family without one cannot hide. Mirrors
# ``test_assistant_api_runtime.PROVIDER_FOR_FAMILY``.
PROVIDER_FOR_FAMILY = {"anthropic": "anthropic", "openai": "openai", "google": "google"}

# Shaped like the real thing on purpose. ``ai_errors._KEY_SHAPES`` would redact
# an ``AIza…`` string even if nobody passed the exact value, so the first case
# below would pass for the wrong reason; ``OPAQUE_KEY`` matches no shape at all
# and is the one that proves the exact-value path.
GOOGLE_SHAPED_KEY = "AIzaSyCANARY0000000000000000000000000000"
OPAQUE_KEY = "canary-7f3a-not-a-real-key-6b21"


class _Capture(logging.Handler):
    """Every record the runtime's logger emits, formatted as a handler sees it.

    Formatting matters: ``logger.exception`` puts the leak in ``exc_info``
    rather than in ``record.msg``, and only a formatter renders it. Asserting
    on ``record.getMessage()`` alone would have passed over the defect this
    file exists for.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []
        self.formatter = logging.Formatter("%(levelname)s %(name)s %(message)s")

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    @property
    def text(self) -> str:
        return "\n".join(self.format(record) for record in self.records)


@pytest.fixture
def captured_logs():
    """Attach to the runtime's own logger, not to root.

    The backend installs no root handler — that absence is half of the defect —
    so a fixture that only watched root would be watching the same nothing.
    """
    handler = _Capture()
    logger = logging.getLogger(ak.__name__)
    previous = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    try:
        yield handler
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous)


def _runtime(family: str, base_url: str, key: str) -> ak.ApiKeyRuntime:
    return ak.ApiKeyRuntime(
        provider=PROVIDER_FOR_FAMILY[family], model="test-model",
        base_url=base_url, api_key=key,
    )


def _run(runtime: ak.ApiKeyRuntime) -> list[dict]:
    return list(runtime.run_turn(1, "what is new this week?"))


# ---------------------------------------------------------------------------
# The log
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("family", sorted(PROVIDER_FOR_FAMILY))
@pytest.mark.parametrize("mode", ["unauthorized", "error_500"])
def test_a_failed_turn_writes_no_key_and_no_traceback_to_a_log_handler(
    family, mode, captured_logs,
):
    """R6: the record a handler receives carries the classified sentence only.

    Driven over every family and both failure shapes a provider actually sends,
    because the defect was a single ``logger.exception`` on the one path that
    every family's failure unwinds through.
    """
    key = GOOGLE_SHAPED_KEY if family == "google" else OPAQUE_KEY
    with ProviderServer(family) as server:
        server.mode = mode
        events = _run(_runtime(family, server.base_url, key))

    assert any(event["type"] == "error" for event in events), events
    assert captured_logs.records, (
        "a failed turn that logs nothing at all is not the fix either: the "
        "operator still needs to know the turn failed"
    )
    assert key not in captured_logs.text
    for record in captured_logs.records:
        assert record.exc_info is None, (
            "logger.exception writes the raw traceback, and an "
            "HTTPStatusError's message carries the request URL"
        )


def test_the_log_line_names_the_provider_and_the_classified_kind(captured_logs):
    """What replaces the traceback has to be worth reading.

    ``llm_remote._as_ai_error`` logs provider and kind beside the sanitized
    message so a support question can be answered without the stack; this path
    now reports the same three things.
    """
    with ProviderServer("google") as server:
        server.mode = "unauthorized"
        _run(_runtime("google", server.base_url, GOOGLE_SHAPED_KEY))

    text = captured_logs.text
    assert "provider=google" in text
    assert "kind=auth" in text, (
        "a 401 is AIErrorKind.AUTH; the log says which kind so the sentence "
        "and the record agree about what happened"
    )
    assert GOOGLE_SHAPED_KEY not in text


def test_a_key_echoed_back_by_the_provider_is_redacted_in_the_log(captured_logs):
    """The second redaction layer, on the path that needs it.

    An upstream that quotes the request back — a proxy's 502 page, a gateway
    that logs and returns the URL it tried — hands this process a key it never
    put in the message itself. ``ai_errors.sanitize`` strips it by exact value
    as well as by shape, and the log goes through the same function as the
    sentence rather than around it.
    """
    with ProviderServer("openai") as server:
        server.mode = "error_500"
        runtime = _runtime("openai", server.base_url, OPAQUE_KEY)
        # The exception the loop sees is raised by the runtime itself here, so
        # the message is authored rather than scraped: this checks the
        # sanitizer is on the path, not that httpx leaks.
        original = runtime._post

        def _echoing_post(url, *, headers, payload):
            # Deliberately not "Bearer <key>": that shape is caught by the
            # pattern layer, and a test the pattern layer passes says nothing
            # about whether the exact-value layer ran.
            raise RuntimeError(f"upstream refused: POST {url}?trace={OPAQUE_KEY}")

        runtime._post = _echoing_post
        try:
            events = _run(runtime)
        finally:
            runtime._post = original

    assert any(event["type"] == "error" for event in events)
    assert OPAQUE_KEY not in captured_logs.text
    assert OPAQUE_KEY not in json.dumps(events)


# ---------------------------------------------------------------------------
# The wire
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("family", sorted(PROVIDER_FOR_FAMILY))
def test_no_family_puts_the_key_in_the_request_line(family):
    """Denominator: all three families in ``assistant_tool_calling.FAMILIES``.

    A key in a query string is written down by every proxy between here and the
    provider, and is quoted back by anything that reports the URL it tried.
    Headers are the only place a secret belongs.
    """
    key = GOOGLE_SHAPED_KEY if family == "google" else OPAQUE_KEY
    with ProviderServer(family) as server:
        server.script = [{"text": "an answer", "calls": []}]
        _run(_runtime(family, server.base_url, key))
        calls = list(server.calls)

    assert len(calls) == 1, calls
    assert key not in calls[0]["path"], (
        f"{family} sent the key in the request line: {calls[0]['path']}")
    assert "key=" not in calls[0]["path"]


def test_google_sends_the_key_in_the_header_the_provider_documents():
    """Not merely "out of the URL" — in the slot Google reads it from.

    Moving the key to a header resmon invented would leave the turn
    unauthenticated and the failure would look like a bad key. ``x-goog-api-key``
    is the header the Generative Language API documents for this endpoint.
    """
    with ProviderServer("google") as server:
        server.script = [{"text": "an answer", "calls": []}]
        _run(_runtime("google", server.base_url, GOOGLE_SHAPED_KEY))
        call = server.calls[0]

    assert call["x_goog_api_key"] == GOOGLE_SHAPED_KEY
    assert "?" not in call["path"], call["path"]
    assert call["authorization"] is None and call["x_api_key"] is None, (
        "one slot, not several: a key copied into a second header is a second "
        "place it can leak from"
    )
