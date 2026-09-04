"""A transport failure is not an answer.

Phase 1.8.6 gave every zero a reason, and the reason that matters most is the
distinction between *the source answered and had nothing* and *the source did
not answer*. ``zero_reason.DID_NOT_ANSWER`` is that line, the watchdog reads
it, and the search record renders a different sentence on each side of it.

``safe_request`` recorded a failure for exactly two exceptions --
``TimeoutException`` and ``ConnectError`` -- because those are the two it
retries. Every other transport failure ``httpx`` can raise fell through
``note_failure`` entirely, so the outcome channel held one attempt and zero
failures, and ``derive`` read that as an answer. The user was then told:

    arXiv answered (HTTP 200) and resmon found no records in the reply.

about a source that never answered. That is the overclaim the whole phase
exists to prevent, and it survived 1.8.6 because every test of the channel
went through a mock transport that raises only the two exceptions the code
already handled -- **a test double cannot fail the way the real dependency
fails**, which is Ledger 23 for the fourth time.

So these tests use a **real socket**. The server is in-process and the
upstream is not real, but the connection, the TLS attempt and the httpx stack
underneath are, and they are what produce the exception types the mock could
not.
"""

from __future__ import annotations

import socket
import threading

import httpx
import pytest

from implementation_scripts import zero_reason
from implementation_scripts.api_base import (
    reset_search_outcome,
    safe_request,
    search_outcome,
)


class _Server:
    """A loopback listener with a chosen way of being unhelpful."""

    def __init__(self, behaviour: str) -> None:
        self.behaviour = behaviour
        self._sock = socket.socket()
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(8)
        self.port = self._sock.getsockname()[1]
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self._sock.accept()
            except OSError:
                return
            if self.behaviour == "close":
                # Accept, then hang up without a byte. httpx maps this to a
                # ReadError or a RemoteProtocolError depending on timing.
                conn.close()
            elif self.behaviour == "garbage":
                conn.sendall(b"not http at all\r\n\r\n")
                conn.close()
            else:  # "ok"
                conn.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
                    b"Content-Type: text/plain\r\n\r\nhi"
                )
                conn.close()

    def close(self) -> None:
        try:
            self._sock.close()
        except OSError:
            pass


@pytest.fixture
def closed_port() -> int:
    """A port nothing is listening on. Reliably refuses."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _reason_for(url: str) -> tuple[str, dict]:
    """Make the call the way a client does, then ask what the run would say."""
    reset_search_outcome()
    try:
        safe_request("GET", url, max_retries=0)
    except httpx.HTTPError:
        pass  # every client swallows this and returns [] -- that is the contract
    return zero_reason.derive(search_outcome().snapshot())


def test_a_refused_connection_is_recorded_as_a_failure(closed_port: int) -> None:
    reason, detail = _reason_for(f"http://127.0.0.1:{closed_port}/search")
    assert reason == "upstream_failure"
    assert detail["detail"] == "connect"
    assert reason in zero_reason.DID_NOT_ANSWER


def test_a_server_that_hangs_up_is_not_an_answer() -> None:
    """The regression. Before the fix this returned ``answered_empty``."""
    server = _Server("close")
    try:
        reason, _ = _reason_for(f"http://127.0.0.1:{server.port}/search")
    finally:
        server.close()
    assert reason == "upstream_failure", (
        "a connection closed before any reply was recorded as an answer"
    )
    assert reason in zero_reason.DID_NOT_ANSWER
    # And the sentence a user reads says the source did not answer.
    sentence = zero_reason.sentence("arXiv", reason, {"detail": "request_error", "attempts": 1})
    assert "did not answer" in sentence
    assert "answered (HTTP 200)" not in sentence


def test_a_malformed_reply_line_is_not_an_answer() -> None:
    server = _Server("garbage")
    try:
        reason, _ = _reason_for(f"http://127.0.0.1:{server.port}/search")
    finally:
        server.close()
    assert reason == "upstream_failure"
    assert reason in zero_reason.DID_NOT_ANSWER


def test_a_real_200_with_nothing_in_it_still_reads_as_an_answer() -> None:
    """The control. Widening the recorded failures must not swallow the
    honest case: a source that really did reply, with nothing in it, is
    ``answered_empty`` and stays outside ``DID_NOT_ANSWER``."""
    server = _Server("ok")
    try:
        reason, detail = _reason_for(f"http://127.0.0.1:{server.port}/search")
    finally:
        server.close()
    assert reason == "answered_empty"
    assert detail["attempts"] == 1
    assert reason not in zero_reason.DID_NOT_ANSWER


def test_every_httpx_transport_error_is_recorded(monkeypatch) -> None:
    """The denominator: httpx's transport-error family, from httpx itself.

    A future httpx that adds a transport error would otherwise reintroduce the
    same hole one exception at a time. ``httpx.HTTPError`` is the base the
    handler catches, so this asserts the relationship rather than a list.
    """
    family = [
        cls for cls in vars(httpx).values()
        if isinstance(cls, type)
        and issubclass(cls, httpx.TransportError)
    ]
    assert len(family) >= 8, family
    for cls in family:
        assert issubclass(cls, httpx.HTTPError), (
            f"{cls.__name__} is a TransportError that safe_request would not record"
        )

    # And the handler really is reached for one that is neither of the two the
    # retry clause names.
    def _boom(*_a, **_k):
        raise httpx.ReadError("reset")

    monkeypatch.setattr(httpx.Client, "request", _boom)
    reset_search_outcome()
    with pytest.raises(httpx.ReadError):
        safe_request("GET", "http://127.0.0.1:1/x", max_retries=0)
    snapshot = search_outcome().snapshot()
    assert snapshot["failures"] == 1
    assert snapshot["last_call_failed"] is True
