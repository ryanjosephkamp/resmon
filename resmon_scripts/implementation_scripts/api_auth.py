"""Local API lock-down: one secret per backend instance, a loopback Host, one renderer Origin.

Until 2.2 the backend answered anything that could reach ``127.0.0.1``: every
origin was allowed (``allow_origins=["*"]``), every response carried
``Access-Control-Allow-Private-Network: true``, no Host header was checked and
no credential was asked for. A web page open in any browser on the machine
could therefore drive the whole API, and a DNS-rebinding page could read the
answers. Only the Library and Evidence routes had a guard, and it trusted any
``http://127.0.0.1:<port>`` origin, which every other local web server has.

A request is now served only when all three of these hold, checked by
:class:`LocalApiGuard` before any route body, body parser or CORS handling:

* **Host** names this instance: ``127.0.0.1:<own port>`` or
  ``localhost:<own port>``. That is the DNS-rebinding defence; it runs even on a
  request carrying a valid token, because a rebound page presents the victim's
  address under the attacker's name.
* **Origin**, when present, is this instance's renderer, exactly. A request with
  no Origin (the MCP server, curl, Electron's main process) is not a browser
  request and is judged on the token alone.
* **Authorization: Bearer <token>** carries this instance's secret, compared in
  constant time.

What it does not defend, stated plainly: a process running as the same OS user
can read the token file (it is ``0600`` to that user) and can read the
Electron-spawned backend's environment. Same-user code already owns the corpus
on disk, so the token is a boundary against *other* principals — web pages,
other local users — not against the user's own processes.

**Where the token comes from.** Exactly one per backend process, never stored in
SQLite:

* Electron mints it and passes it in the child's environment (``RESMON_API_TOKEN``,
  never argv — argv is world-readable in ``ps``). The backend removes it from
  its own environment on start so nothing it spawns inherits it.
* A daemon, or a bare ``python resmon.py <port>``, mints its own.

Either way the backend writes it to ``<state dir>/api-token-<port>`` (``0600``)
so that clients that did not start it — ``mcp_server.py`` under a harness,
Electron attaching to a daemon — can find it, and removes the file on clean
shutdown. The file is keyed by port because the daemon and an Electron-spawned
fallback can share one state directory, and a single name would let one
clobber the other's. A file left behind by a crash never authenticates
anything: every start mints afresh, so a stale file only makes its reader get
``token_invalid``.
"""

from __future__ import annotations

import hmac
import os
import re
import secrets
import sys
import threading
from pathlib import Path
from typing import Iterable, Optional

from starlette.datastructures import Headers
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

TOKEN_ENV = "RESMON_API_TOKEN"
RENDERER_ORIGIN_ENV = "RESMON_RENDERER_ORIGIN"
TOKEN_FILE_PREFIX = "api-token-"

# The paths served without a token. **Empty, and a test fails if it grows**
# (``test_local_api_auth.py``). ``/api/health`` was the candidate — Electron's
# attach probe and the MCP server's discovery both call it — but both now read
# the token file first and probe with it, so health discloses pid, version and
# runtime identity to nobody who could not already read the token.
AUTH_EXEMPT_PATHS: frozenset[str] = frozenset()

# The paths that carry their own proof instead of the token. **One entry, and a
# test fails if it grows** (``test_local_api_auth.py``).
#
# The delivery bundle download exists for a webhook *receiver*: a program the
# user pointed a routine at, which is not resmon's renderer and has no business
# holding a credential that opens every route in this app. So the guard lets
# the request past the token check and the route checks a per-destination HMAC
# over the delivery id and an expiry instead. What the guard still enforces on
# it is everything else -- Host must be this backend's own 127.0.0.1 address,
# and a browser Origin must be the renderer's -- so this widens exactly one
# route to one holder of one time-limited signature, and nothing else.
#
# This is *not* an exemption from authentication. A request here with no
# signature, a wrong one or an expired one is refused by the route.
AUTH_SIGNED_PATHS: tuple["re.Pattern[str]", ...] = (
    re.compile(r"\A/api/deliveries/[0-9]+/bundle\Z"),
)

# 32 bytes from a CSPRNG, URL-safe base64 without padding: 43 characters. A
# presented token from the environment must look like one; anything shorter is
# refused at start rather than silently accepted as a weak secret.
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43,128}")
_ORIGIN_RE = re.compile(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})")

# An attached daemon outlives the renderers that register with it. Bounded so a
# long-lived daemon does not accumulate every origin it has ever been shown; a
# window older than this many registrations re-registers when it next starts.
_MAX_RENDERER_ORIGINS = 8


def mint_token() -> str:
    """A fresh secret: 32 bytes from ``secrets`` (the OS CSPRNG)."""
    return secrets.token_urlsafe(32)


def valid_token(value: object) -> bool:
    return isinstance(value, str) and _TOKEN_RE.fullmatch(value) is not None


def canonical_renderer_origin(value: object) -> Optional[str]:
    """``value`` if it is exactly ``http://127.0.0.1:<port>``, else ``None``.

    The renderer is served by Electron's own static server on 127.0.0.1, so its
    origin always has this form. No trailing slash, no path, no userinfo, no
    ``localhost`` spelling: an origin is compared byte for byte, and one
    canonical spelling is what keeps that comparison honest.
    """
    if not isinstance(value, str):
        return None
    match = _ORIGIN_RE.fullmatch(value)
    if not match or not 1 <= int(match.group(1)) <= 65535:
        return None
    return value


# ---------------------------------------------------------------------------
# The token file
# ---------------------------------------------------------------------------

def state_dir() -> Path:
    """The per-user state directory, the one ``daemon.lock`` lives in."""
    from implementation_scripts.daemon import state_dir as _state_dir

    return _state_dir()


def token_file(port: int, directory: Optional[Path] = None) -> Path:
    return Path(directory or state_dir()) / f"{TOKEN_FILE_PREFIX}{int(port)}"


def write_token_file(port: int, token: str, directory: Optional[Path] = None) -> Path:
    """Write the token for ``port``, readable by this user only, atomically.

    Created ``0600`` through ``os.open`` rather than chmodded afterwards, so there
    is no moment at which the file exists with the umask's wider mode. Written
    to a temporary name and renamed, so a reader never sees half a token.

    On Windows the mode bits are advisory: the file inherits the state
    directory's ACL, which under ``%LOCALAPPDATA%`` is the user's own profile.
    That is the limit of what this does there; it sets no explicit ACL.
    """
    path = token_file(port, directory)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.unlink()
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, token.encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    if sys.platform != "win32":
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return path


def read_token_file(port: int, directory: Optional[Path] = None) -> Optional[str]:
    """The token recorded for ``port``, or ``None`` when there is none usable."""
    try:
        text = token_file(port, directory).read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return text if valid_token(text) else None


def remove_token_file(port: int, token: str, directory: Optional[Path] = None) -> None:
    """Delete the token file on the way out, if it is still ours. Never raises.

    "Still ours" matters: a successor on the same port may already have written
    its own, and deleting that would strand its clients.
    """
    path = token_file(port, directory)
    try:
        if hmac.compare_digest(path.read_text(encoding="ascii").strip(), token):
            path.unlink()
    except (OSError, UnicodeDecodeError, TypeError):
        pass


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def redact(text: str, token: Optional[str]) -> str:
    """``text`` with every occurrence of ``token`` replaced. For relayed errors."""
    if token and isinstance(text, str):
        return text.replace(token, "[redacted]")
    return text


# ---------------------------------------------------------------------------
# This process's configuration
# ---------------------------------------------------------------------------

class _Config:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.token: Optional[str] = None
        self.origins: list[str] = []


_config = _Config()


def configure(token: str, renderer_origins: Iterable[str] = ()) -> None:
    """Install this process's token and its renderer origin(s).

    Called once by each launcher before it serves. Until it is called the guard
    refuses every request: there is no unauthenticated mode to fall into.
    """
    if not valid_token(token):
        raise ValueError("The API token must be 43 or more URL-safe base64 characters.")
    origins: list[str] = []
    for origin in renderer_origins:
        canonical = canonical_renderer_origin(origin)
        if canonical is None:
            raise ValueError(f"Not a renderer origin: {origin!r}")
        if canonical not in origins:
            origins.append(canonical)
    with _config.lock:
        _config.token = token
        _config.origins = origins[-_MAX_RENDERER_ORIGINS:]


def current_token() -> Optional[str]:
    return _config.token


def register_renderer_origin(origin: str) -> str:
    """Allow one more exact renderer origin. Returns it, canonical.

    For a daemon, which starts before any renderer exists and so cannot be told
    the origin at spawn. Electron's main process calls this — authenticated by
    the token, with no Origin header — after it has bound its renderer server.
    """
    canonical = canonical_renderer_origin(origin)
    if canonical is None:
        raise ValueError("Origin must be exactly http://127.0.0.1:<port>.")
    with _config.lock:
        if canonical in _config.origins:
            _config.origins.remove(canonical)
        _config.origins.append(canonical)
        del _config.origins[:-_MAX_RENDERER_ORIGINS]
    return canonical


def renderer_origins() -> tuple[str, ...]:
    with _config.lock:
        return tuple(_config.origins)


def origin_allowed(origin: Optional[str]) -> bool:
    return origin is not None and origin in renderer_origins()


def token_matches(presented: Optional[str]) -> bool:
    expected = _config.token
    if expected is None or presented is None:
        return False
    return hmac.compare_digest(presented.encode("latin-1", "replace"), expected.encode("ascii"))


def configure_from_environment() -> str:
    """Read (and remove) the launcher's token and origin; mint when absent.

    Removing them from ``os.environ`` is what keeps the token out of every
    process this backend later spawns — agent CLIs, the MCP servers they start,
    transcription helpers — none of which should inherit a credential they were
    not deliberately handed.
    """
    token = os.environ.pop(TOKEN_ENV, None)
    origin = os.environ.pop(RENDERER_ORIGIN_ENV, None)
    if token is None:
        token = mint_token()
    elif not valid_token(token):
        raise SystemExit(f"{TOKEN_ENV} is set but is not a valid token; refusing to start.")
    configure(token, [origin] if origin else [])
    return token


# ---------------------------------------------------------------------------
# The guard
# ---------------------------------------------------------------------------

def _refusal(status: int, reason: str, message: str) -> Response:
    headers = {"Cache-Control": "no-store"}
    if status == 401:
        headers["WWW-Authenticate"] = 'Bearer realm="resmon"'
    return JSONResponse({"detail": {"reason": reason, "message": message}},
                        status_code=status, headers=headers)


def _single(headers: list[tuple[bytes, bytes]], name: bytes) -> tuple[int, Optional[str]]:
    values = [v for k, v in headers if k.lower() == name]
    return len(values), (values[0].decode("latin-1") if len(values) == 1 else None)


def check(scope: Scope) -> Optional[Response]:
    """The refusal for this request, or ``None`` when it may proceed.

    Order is Host, then Origin, then token. Host first because it is the only
    check that means anything to a DNS-rebinding page, which can present a
    victim's *valid* token if it ever obtained one; Origin before token so a
    foreign page learns nothing about whether a token it guessed was right.
    """
    headers = scope.get("headers") or []
    server = scope.get("server")
    port = server[1] if isinstance(server, (tuple, list)) and len(server) == 2 else None
    count, host = _single(headers, b"host")
    allowed_hosts = () if not isinstance(port, int) else (f"127.0.0.1:{port}", f"localhost:{port}")
    if count != 1 or host not in allowed_hosts:
        return _refusal(403, "host_refused",
                        "resmon answers only requests addressed to 127.0.0.1 or localhost on its own port.")

    count, origin = _single(headers, b"origin")
    if count > 1 or (count == 1 and not origin_allowed(origin)):
        return _refusal(403, "origin_refused",
                        "resmon answers browser requests only from its own window.")

    is_preflight = (scope.get("type") == "http" and scope.get("method") == "OPTIONS"
                    and count == 1 and any(k.lower() == b"access-control-request-method" for k, _ in headers))
    if is_preflight:
        # A CORS preflight carries no credentials, by specification. It is
        # answered without the token, but only for the renderer's own origin,
        # which was checked above; CORSMiddleware writes the answer.
        return None

    if scope.get("path") in AUTH_EXEMPT_PATHS:
        return None

    # A route that proves itself. See ``AUTH_SIGNED_PATHS``: the signature is
    # checked by the route, which knows which destination's secret to check it
    # against; the guard's job here is only to stop refusing the request for
    # want of a token the receiver was never given.
    path = scope.get("path") or ""
    if any(pattern.match(path) for pattern in AUTH_SIGNED_PATHS):
        return None

    count, authorization = _single(headers, b"authorization")
    if count == 0:
        return _refusal(401, "token_missing", "This request needs resmon's local API token.")
    scheme, _, presented = (authorization or "").partition(" ")
    if count != 1 or scheme.lower() != "bearer" or not token_matches(presented.strip()):
        return _refusal(401, "token_invalid", "The local API token on this request is not this resmon's.")
    return None


class LocalApiGuard:
    """Raw ASGI, registered outermost: before CORS, before any body is read.

    Raw rather than ``BaseHTTPMiddleware`` for the reason ``PrivateNetworkMiddleware``
    was: the assistant's turn and the sweep progress feed stream, and a
    ``BaseHTTPMiddleware`` buffers. Outermost because a refusal must not depend
    on anything a later layer does — the Library guard learned that a simple
    cross-origin form POST reaches body parsing unless it is stopped first.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        refusal = check(scope)
        if refusal is None:
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await refusal(scope, receive, send)


class RendererCORSMiddleware(CORSMiddleware):
    """Starlette's CORS, with the allowed origin read live from :func:`renderer_origins`.

    Live because a daemon learns its renderer's origin after it has started.
    Private Network Access is answered only on a preflight that asked for it
    (``allow_private_network=True`` in Starlette 1.0 does exactly that) and —
    the one change — never on a preflight from an origin that failed, which the
    stock class would otherwise still mark with the PNA header. The guard
    refuses such a preflight before it gets here; this is the second layer.
    """

    def is_allowed_origin(self, origin: str) -> bool:
        return origin_allowed(origin)

    def preflight_response(self, request_headers: Headers) -> Response:
        response = super().preflight_response(request_headers)
        if not self.is_allowed_origin(request_headers["origin"]):
            if "access-control-allow-private-network" in response.headers:
                del response.headers["access-control-allow-private-network"]
        return response

