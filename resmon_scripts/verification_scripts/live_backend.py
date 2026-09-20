"""Reaching a backend a test started itself, with the token that backend minted.

Two live modules spawn their own ``resmon.py`` and talk to it over a real
socket. Since 2.2 every route refuses a request that does not carry that
instance's token, and ``AUTH_EXEMPT_PATHS`` is empty -- ``/api/health``
included. A readiness poll written before the lock-down therefore never sees a
200: it sees 401 after 401 until its deadline runs out and then reports that the
backend never became ready. The backend was ready the whole time; it was
refusing an anonymous caller. That one sentence was all forty errors in the
weekly live run of 2026-09-20.

Two things follow, and they are why this module exists rather than a header
added in two places.

**The wait belongs in one place.** ``resmon.py`` writes ``api-token-<port>``
into its state directory *before* uvicorn binds, so a caller that waits for the
file and then polls with it can never be told "wait longer" about a credential
problem.

**The three ways a start can fail are three different sentences.** The process
died; the token never appeared; the token was refused. "did not become ready"
covers all three and points at none of them, and a reader who believed it spent
the morning in startup code looking for a fault that lived in a header.

Nothing here is a test double. The subprocess, the socket and the token file are
all real; the only thing a caller supplies is which process to watch.
"""

from __future__ import annotations

import socket
import sys
import time
from pathlib import Path
from typing import Callable, Optional

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import api_auth  # noqa: E402

#: How long :func:`await_backend` waits for a first authenticated 200. The
#: modules that call it used 60s before the lock-down and a cold import of the
#: backend is the slow part, so the budget is unchanged.
DEFAULT_TIMEOUT = 60.0


class BackendStartFailed(RuntimeError):
    """A backend this process started never became reachable. Base class."""


class BackendExited(BackendStartFailed):
    """The subprocess was gone before it answered."""


class TokenNeverPublished(BackendStartFailed):
    """No ``api-token-<port>`` file appeared, so nothing could authenticate."""


class TokenRefused(BackendStartFailed):
    """The backend answered 401 to the token it had just published."""


class NeverAnswered(BackendStartFailed):
    """Authenticated polls ran out of time without a 200."""


def free_port() -> int:
    """An unused loopback port. Never 8742, which is the user's own daemon."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 8742, "refusing a port that belongs to the user's daemon"
    return port


def await_backend(
    base: str,
    port: int,
    state: Path,
    *,
    alive: Optional[Callable[[], bool]] = None,
    diagnosis: Optional[Callable[[], str]] = None,
    timeout: float = DEFAULT_TIMEOUT,
    poll: float = 0.2,
) -> str:
    """Block until ``GET {base}/api/health`` answers 200 to its own token.

    Returns the token, which is what the caller needs for every later request
    and for ``mcp_server.Backend.pin``.

    ``alive`` is asked, between polls, whether the process is still running;
    ``diagnosis`` supplies whatever the caller captured of its output when it is
    not. Both are optional so a caller with no subprocess -- the hermetic guard
    -- can drive exactly this code against a stub on a real socket.

    Every failure raises a :class:`BackendStartFailed` naming which of the three
    things went wrong. The token itself never reaches a message: a refusal that
    printed the credential would put it in CI logs, which is the one place it
    must not be.
    """
    path = api_auth.token_file(port, state)
    deadline = time.monotonic() + timeout
    token: Optional[str] = None
    last_status: Optional[int] = None

    while time.monotonic() < deadline:
        if alive is not None and not alive():
            detail = diagnosis() if diagnosis is not None else "no output captured"
            raise BackendExited(
                f"The backend on port {port} exited before it answered: {detail}"
            )

        if token is None:
            token = api_auth.read_token_file(port, state)
            if token is None:
                time.sleep(poll)
                continue

        try:
            response = httpx.get(
                f"{base}/api/health", headers=api_auth.bearer(token), timeout=1.0
            )
        except httpx.HTTPError:
            # Not listening yet. The token file is written before uvicorn binds,
            # so this is the ordinary shape of a cold start.
            time.sleep(poll)
            continue

        last_status = response.status_code
        if response.status_code == 200:
            return token

        if response.status_code == 401:
            # Not a race: the file exists before the socket does. Re-read it
            # once in case a successor on this port rewrote it, and otherwise
            # say what actually happened rather than asking for more patience.
            fresh = api_auth.read_token_file(port, state)
            if fresh is not None and fresh != token:
                token = fresh
                continue
            raise TokenRefused(
                f"The backend on port {port} refused the API token published in "
                f"{path}: GET /api/health answered 401 ({_reason(response)}). The "
                "backend is up; this is a credential problem, not a slow start."
            )

        time.sleep(poll)

    if token is None:
        raise TokenNeverPublished(
            f"The backend on port {port} published no API token within "
            f"{timeout:.0f}s: {path} never appeared. Every route needs that "
            "token, so no caller can reach this backend."
        )
    raise NeverAnswered(
        f"The backend on port {port} did not answer an authenticated "
        f"GET /api/health within {timeout:.0f}s (last status: "
        f"{last_status if last_status is not None else 'no response'})."
    )


def _reason(response: httpx.Response) -> str:
    """The refusal code the guard names, or the status line when it is absent."""
    try:
        detail = response.json().get("detail")
    except ValueError:
        return "unparseable body"
    if isinstance(detail, dict) and detail.get("reason"):
        return str(detail["reason"])
    return "no reason given"


class TokenedHttpx:
    """``httpx``'s module-level functions, with the current backend's bearer.

    A shim over the functions rather than one shared ``httpx.Client``, for the
    reason ``test_mcp_settings_boundary.py`` gives: each call keeps its own
    throwaway client, so a stream a test abandons is closed exactly as it was
    before -- a pooled connection once outlived one and hid a disconnect.

    The token is an attribute rather than a constructor argument because the
    module-level instance is built at import and the fixture only learns the
    token when the backend it started publishes one. Calling before then is a
    mistake in the test, so it raises rather than sending an anonymous request
    that would come back as an inscrutable 401.
    """

    def __init__(self, token: Optional[str] = None) -> None:
        self.token = token

    def __getattr__(self, name: str):
        function = getattr(httpx, name)

        def call(*args, **kwargs):
            token = self.token
            if not token:
                raise RuntimeError(
                    f"httpx.{name} was called with no backend token in play; the "
                    "fixture that starts the backend sets one."
                )
            kwargs["headers"] = {
                **api_auth.bearer(token),
                **dict(kwargs.get("headers") or {}),
            }
            return function(*args, **kwargs)

        return call
