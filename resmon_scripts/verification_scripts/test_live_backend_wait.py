"""The live fixtures' wait fails closed, and says which thing failed.

``live_backend.await_backend`` is what the two backend-starting live modules use
to decide a backend is reachable. It is only exercised for real in the weekly
live run, and the failure it exists to prevent is precisely the one that hid for
a week: a readiness poll that could not authenticate reported "the backend did
not become ready" forty times over while forty backends were up and refusing it.

So the wait is driven here against a **real loopback server that refuses an
anonymous request exactly as the backend's guard does** -- a real socket, a real
``httpx`` request, a real ``api-token-<port>`` file written by
``api_auth.write_token_file``. The only thing that is not the real thing is the
application behind the socket, and the one behaviour it imitates is the one
under test: 401 without a matching bearer, 200 with one.

No marker: nothing here leaves loopback, which ``conftest.py``'s socket guard
enforces for every test that is not marked ``live_network``.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import live_backend  # noqa: E402
from implementation_scripts import api_auth  # noqa: E402


class _GuardedStub(BaseHTTPRequestHandler):
    """``/api/health`` behind the 2.2 rule: no matching bearer, no answer.

    The refusal body is the guard's own shape (``detail.reason``), because the
    wait reads that reason into its message and a stub that answered a bare 401
    would let a message that named nothing pass.
    """

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's spelling
        presented = self.headers.get("Authorization")
        self.server.seen.append(presented)
        expected = f"Bearer {self.server.accepted_token}"
        if presented == expected:
            body = json.dumps({"status": "ok", "pid": 0}).encode()
            status = 200
        else:
            body = json.dumps(
                {"detail": {"reason": "token_missing" if not presented else "token_invalid",
                            "message": "This request needs resmon's local API token."}}
            ).encode()
            status = 401
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # pragma: no cover - keeps pytest output readable
        pass


@pytest.fixture
def stub():
    """A guarded ``/api/health`` on a loopback port, with what it was shown."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _GuardedStub)
    server.accepted_token = api_auth.mint_token()
    server.seen = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _base(server) -> str:
    return f"http://127.0.0.1:{server.server_address[1]}"


def test_the_wait_reaches_a_guarded_backend_using_the_token_it_published(stub, tmp_path):
    """The happy path, and the header it turns on.

    The first 200 must be an *authenticated* 200: the stub records every
    Authorization header it was shown, and the one that succeeded carries the
    bearer. Without that assertion this case would still pass against a stub
    that answered 200 to anybody.
    """
    port = stub.server_address[1]
    api_auth.write_token_file(port, stub.accepted_token, tmp_path)

    token = live_backend.await_backend(_base(stub), port, tmp_path, timeout=10)

    assert token == stub.accepted_token
    assert stub.seen[-1] == f"Bearer {stub.accepted_token}"
    assert None not in stub.seen, "the wait sent an anonymous poll"


def test_an_anonymous_poll_of_the_same_stub_never_becomes_ready(stub):
    """The regression itself, at this boundary.

    This is the poll the two live modules had before this change. It runs
    against the same server the case above succeeds against, and it never sees a
    200 -- which is what makes that server a fair stand-in for the real guard
    rather than one that cannot fail the way the real thing fails.
    """
    deadline = time.monotonic() + 2
    statuses = set()
    while time.monotonic() < deadline:
        statuses.add(httpx.get(f"{_base(stub)}/api/health", timeout=1.0).status_code)
    assert statuses == {401}


def test_a_token_file_that_never_appears_is_named_as_the_token(stub, tmp_path):
    """No file, no credential -- and the message says so instead of "not ready"."""
    port = stub.server_address[1]

    with pytest.raises(live_backend.TokenNeverPublished) as raised:
        live_backend.await_backend(_base(stub), port, tmp_path, timeout=1.5, poll=0.05)

    message = str(raised.value)
    assert "token" in message.lower()
    assert str(api_auth.token_file(port, tmp_path)) in message
    assert stub.seen == [], "nothing should have been asked before a token existed"


def test_a_refused_token_is_reported_as_a_refusal_inside_the_deadline(stub, tmp_path):
    """A wrong token fails as a credential, promptly, without printing itself.

    Promptly matters: the backend writes its token file before it binds, so a
    401 is never a race, and spending the whole 60s budget on one would put the
    real cause behind a timeout again.
    """
    port = stub.server_address[1]
    wrong = api_auth.mint_token()
    api_auth.write_token_file(port, wrong, tmp_path)

    started = time.monotonic()
    with pytest.raises(live_backend.TokenRefused) as raised:
        live_backend.await_backend(_base(stub), port, tmp_path, timeout=30, poll=0.05)
    elapsed = time.monotonic() - started

    message = str(raised.value)
    assert elapsed < 10, f"a refusal took {elapsed:.1f}s to be reported"
    assert "token" in message.lower() and "401" in message
    assert "token_invalid" in message
    assert wrong not in message, "a refusal must not print the credential"
    assert "ready" not in message.lower()


def test_a_process_that_exited_is_reported_as_an_exit(stub, tmp_path):
    """A process that is gone: whatever the caller captured, not a guess about tokens."""
    port = stub.server_address[1]
    api_auth.write_token_file(port, stub.accepted_token, tmp_path)

    with pytest.raises(live_backend.BackendExited) as raised:
        live_backend.await_backend(
            _base(stub), port, tmp_path, timeout=5,
            alive=lambda: False, diagnosis=lambda: "Traceback: no such table",
        )

    assert "no such table" in str(raised.value)


def test_the_shim_refuses_to_send_a_request_with_no_token_in_play():
    """``TokenedHttpx`` fails loudly rather than sending an anonymous request.

    An anonymous request would come back 401 from somewhere deep in a test body,
    which is the class of confusion this whole change is about.
    """
    api = live_backend.TokenedHttpx()
    with pytest.raises(RuntimeError, match="no backend token"):
        api.get("http://127.0.0.1:1/api/health")
