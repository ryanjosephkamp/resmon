"""The local API lock-down (2.2), observed at the socket.

Every check here that matters talks to a **real backend process** — ``python
resmon.py <port>`` or the daemon entry point — on an ephemeral loopback port
with its own state directory, through a real HTTP client. ``TestClient`` is not
used for any property: it is an in-process double whose ``Host`` and
``server`` a test chooses, which is exactly what the guard must not trust.

The backend processes run inside a small wrapper that refuses non-loopback
connections, the same rule ``conftest.py`` applies in-process, because
``run_sweep`` and ``run_routine`` are among the MCP tools driven below and a
sweep would otherwise reach arXiv from a subprocess the conftest cannot see.

Denominators are read from the code: ``resmon.app.routes`` for P1 and
``mcp_server.TOOLS`` (with ``test_mcp_routes_resolve.TOOL_ARGS``) for P6.
"""

from __future__ import annotations

import json
import os
import re
import signal
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

RESMON_SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RESMON_SCRIPTS))

import mcp_server  # noqa: E402
import resmon  # noqa: E402
from implementation_scripts import api_auth  # noqa: E402
from starlette.routing import Mount, WebSocketRoute  # noqa: E402

from test_mcp_routes_resolve import TOOL_ARGS  # noqa: E402

RENDERER_ORIGIN = "http://127.0.0.1:12346"

_LOOPBACK_ONLY = r'''
import runpy, socket, sys
_real_connect, _real_connect_ex = socket.socket.connect, socket.socket.connect_ex
def _host(address):
    return address[0] if isinstance(address, tuple) else str(address)
def _check(address):
    if _host(address) not in ("127.0.0.1", "::1", "localhost", ""):
        raise OSError("non-loopback connection refused in this test backend: " + _host(address))
def connect(self, address, *a, **k):
    _check(address); return _real_connect(self, address, *a, **k)
def connect_ex(self, address, *a, **k):
    _check(address); return _real_connect_ex(self, address, *a, **k)
socket.socket.connect, socket.socket.connect_ex = connect, connect_ex
mode, target, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
if mode == "script":
    sys.argv = [target, *rest]
    runpy.run_path(target, run_name="__main__")
else:
    sys.argv = [target, *rest]
    runpy.run_module(target, run_name="__main__", alter_sys=True)
'''


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    assert port != 8742
    return port


class Backend:
    """One real backend process in its own state directory."""

    def __init__(self, state: Path, *, daemon: bool = False, env: dict | None = None,
                 port: int | None = None) -> None:
        self.state = state
        state.mkdir(parents=True, exist_ok=True)
        (state / "reports").mkdir(exist_ok=True)
        self.port = port or _free_port()
        self.log = state / f"backend-{self.port}-{time.time_ns()}.log"
        base = {k: v for k, v in os.environ.items() if not k.startswith("RESMON_")}
        base.update({
            "RESMON_STATE_DIR": str(state),
            "RESMON_DB_PATH": str(state / "resmon.db"),
            "RESMON_REPORTS_DIR": str(state / "reports"),
            "RESMON_PORT_FILE": str(state / "resmon.port"),
            "RESMON_DISABLE_SCHEDULER": "1",
            "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
            "PYTHONPATH": str(RESMON_SCRIPTS),
        })
        base.update(env or {})
        if daemon:
            argv = ["module", "implementation_scripts.daemon", f"--port={self.port}"]
        else:
            argv = ["script", str(RESMON_SCRIPTS / "resmon.py"), str(self.port)]
        self.argv = [sys.executable, "-c", _LOOPBACK_ONLY, *argv]
        with self.log.open("w") as out:
            self.proc = subprocess.Popen(self.argv, cwd=RESMON_SCRIPTS, env=base,
                                         stdout=out, stderr=subprocess.STDOUT)
        self.token = self._wait_ready()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _wait_ready(self) -> str:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            assert self.proc.poll() is None, self.log.read_text()
            token = api_auth.read_token_file(self.port, self.state)
            if token:
                try:
                    r = httpx.get(f"{self.base}/api/health", headers=api_auth.bearer(token), timeout=2)
                    if r.status_code == 200:
                        return token
                except httpx.HTTPError:
                    pass
            time.sleep(0.05)
        raise AssertionError("backend never became ready:\n" + self.log.read_text())

    def client(self, token: str | None = "own") -> httpx.Client:
        headers = api_auth.bearer(self.token if token == "own" else token) if token else {}
        return httpx.Client(base_url=self.base, headers=headers, timeout=15)

    def stop(self, sig: int = signal.SIGTERM) -> int:
        if self.proc.poll() is None:
            self.proc.send_signal(sig)
        return self.proc.wait(timeout=30)


@pytest.fixture(scope="module")
def backend(tmp_path_factory):
    b = Backend(tmp_path_factory.mktemp("lockdown") / "state",
                env={"RESMON_RENDERER_ORIGIN": RENDERER_ORIGIN})
    yield b
    b.stop()


def _refusal(response: httpx.Response) -> tuple[int, str]:
    body = response.json()
    assert set(body) == {"detail"} and set(body["detail"]) == {"reason", "message"}, body
    return response.status_code, body["detail"]["reason"]


# ---------------------------------------------------------------------------
# The allowlist and the order
# ---------------------------------------------------------------------------

def test_no_route_is_exempt_from_the_token():
    """The exemption list is empty. Growing it is a decision, and this is where it is made."""
    assert api_auth.AUTH_EXEMPT_PATHS == frozenset()


#: The one route that answers without the token because it carries its own
#: proof. Named here so the sweep below can require a *different* refusal from
#: it rather than skipping it.
SIGNED_PATH = "/api/deliveries/{delivery_id}/bundle"


def test_exactly_one_route_proves_itself_instead_of_presenting_the_token():
    """``AUTH_SIGNED_PATHS`` has one member and it is the webhook bundle link.

    The delivery bundle is fetched by a webhook receiver, which is not resmon
    and must not hold resmon's token. Adding a second pattern here widens the
    surface that answers an unauthenticated caller, so it is a decision, and
    this is where it is made.
    """
    assert len(api_auth.AUTH_SIGNED_PATHS) == 1
    pattern = api_auth.AUTH_SIGNED_PATHS[0]
    assert pattern.match("/api/deliveries/12/bundle")
    for near_miss in ("/api/deliveries/12/bundle/", "/api/deliveries//bundle",
                      "/api/deliveries/12/bundle?x=1", "/api/deliveries/x/bundle",
                      "/api/routines", "/api/deliveries/12/retry"):
        assert not pattern.match(near_miss), near_miss


def test_the_guard_is_the_outermost_layer():
    """Registered last, so it wraps CORS, the Library guard and every body parser."""
    assert resmon.app.user_middleware[0].cls is api_auth.LocalApiGuard
    assert [m.cls for m in resmon.app.user_middleware].count(api_auth.LocalApiGuard) == 1


# ---------------------------------------------------------------------------
# P1 — every route refuses a missing or wrong token, before its body runs
# ---------------------------------------------------------------------------

def _route_pairs() -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for route in resmon.app.routes:
        if isinstance(route, WebSocketRoute):
            pairs.append((route.path, "WEBSOCKET"))
        elif isinstance(route, Mount):
            pairs.append((route.path.rstrip("/") + "/probe", "GET"))
        else:
            pairs.extend((route.path, method) for method in sorted(route.methods or ()))
    return pairs


ROUTE_PAIRS = _route_pairs()


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", path)


def test_the_route_denominator_is_the_whole_app():
    """Every (path, method) the app registers is below; none is a websocket or mount today."""
    methods = sum(len(getattr(r, "methods", None) or ()) for r in resmon.app.routes)
    assert len(ROUTE_PAIRS) == methods == len(set(ROUTE_PAIRS))
    assert len(resmon.app.routes) >= 170
    assert not any(m == "WEBSOCKET" for _, m in ROUTE_PAIRS)


@pytest.mark.parametrize("path,method", ROUTE_PAIRS, ids=[f"{m} {p}" for p, m in ROUTE_PAIRS])
def test_every_route_refuses_a_missing_or_wrong_token(backend, path, method):
    url = _concrete(path)
    # An unparseable body: a 422 here would mean the body was read before the guard.
    body = b"{not json" if method in ("POST", "PUT", "PATCH", "DELETE") else None
    with backend.client(token=None) as c:
        missing = c.request(method, url, content=body)
        wrong = c.request(method, url, content=body, headers=api_auth.bearer(api_auth.mint_token()))
        malformed = c.request(method, url, content=body, headers={"Authorization": f"Basic {backend.token}"})
    if method == "HEAD":
        assert (missing.status_code, wrong.status_code, malformed.status_code) == (401, 401, 401)
        return
    if path == SIGNED_PATH:
        # The one route the guard lets past the token check. It still refuses
        # all three of these requests -- with or without a token, none of them
        # carries a valid signature -- and the refusal has the same shape.
        for response in (missing, wrong, malformed):
            assert _refusal(response) == (403, "signature_invalid")
        return
    assert _refusal(missing) == (401, "token_missing")
    assert _refusal(wrong) == (401, "token_invalid")
    assert _refusal(malformed) == (401, "token_invalid")
    assert missing.headers["www-authenticate"].startswith("Bearer")


def test_refused_writes_left_no_effect(backend):
    """After every route was hit without a token, nothing was created. Runs after the sweep above."""
    with backend.client(token=None) as c:
        for path in ("/api/routines", "/api/configurations", "/api/search/dive", "/api/profiles"):
            c.post(path, json={"name": "x", "keywords": ["x"], "repositories": ["arxiv"],
                               "repository": "arxiv", "query": "x"})
    with backend.client() as c:
        assert c.get("/api/routines").json() == []
        assert c.get("/api/executions").json() == []
        assert c.get("/api/configurations").json() == []
        assert c.get("/api/health").status_code == 200


# ---------------------------------------------------------------------------
# P2 — Host is checked even with a valid token
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("host", ["evil.example", "evil.example:{port}", "127.0.0.1:{other}",
                                  "localhost:{other}", "127.0.0.1", "[::1]:{port}", "127.0.0.1.nip.io:{port}"])
def test_a_foreign_host_is_refused_with_a_valid_token(backend, host):
    host = host.format(port=backend.port, other=backend.port + 1 if backend.port < 65535 else 1024)
    with backend.client() as c:
        response = c.get("/api/health", headers={"Host": host})
    assert _refusal(response) == (403, "host_refused")


@pytest.mark.parametrize("host", ["127.0.0.1:{port}", "localhost:{port}"])
def test_the_instances_own_host_is_served(backend, host):
    with backend.client() as c:
        assert c.get("/api/health", headers={"Host": host.format(port=backend.port)}).status_code == 200


def test_host_is_checked_on_a_raw_socket(backend):
    """No client library in the way: the bytes a rebinding page's browser would send."""
    def raw(host: str) -> bytes:
        with socket.create_connection(("127.0.0.1", backend.port), timeout=5) as s:
            s.sendall((f"GET /api/health HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {backend.token}\r\n"
                       "Connection: close\r\n\r\n").encode())
            return b"".join(iter(lambda: s.recv(65536), b""))
    assert raw("attacker.example").startswith(b"HTTP/1.1 403")
    assert raw(f"127.0.0.1:{backend.port}").startswith(b"HTTP/1.1 200")


# ---------------------------------------------------------------------------
# P3 — Origin, when present, is the renderer's, exactly
# ---------------------------------------------------------------------------

FOREIGN_ORIGINS = ["https://evil.example", "null", "http://127.0.0.1:{wrong}", "http://localhost.evil.example",
                   "http://localhost:{wrong}", "http://127.0.0.1:12346/", "http://user@127.0.0.1:12346",
                   "HTTP://127.0.0.1:12346", "file://"]


@pytest.mark.parametrize("origin", FOREIGN_ORIGINS)
def test_a_foreign_origin_is_refused_and_given_no_cors(backend, origin):
    origin = origin.format(wrong=12347)
    with backend.client() as c:
        response = c.get("/api/routines", headers={"Origin": origin})
    assert _refusal(response) == (403, "origin_refused")
    assert "access-control-allow-origin" not in response.headers
    assert "access-control-allow-private-network" not in response.headers


def test_two_origin_headers_are_refused(backend):
    with backend.client() as c:
        response = c.get("/api/routines", headers=[("Origin", RENDERER_ORIGIN), ("Origin", "https://evil.example")])
    assert _refusal(response) == (403, "origin_refused")


def test_no_origin_with_the_token_is_served(backend):
    """The MCP server, curl and Electron's main process send no Origin."""
    with backend.client() as c:
        response = c.get("/api/routines")
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


def test_the_renderer_origin_with_the_token_is_served_with_cors(backend):
    with backend.client() as c:
        response = c.get("/api/routines", headers={"Origin": RENDERER_ORIGIN})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == RENDERER_ORIGIN
    assert "access-control-allow-private-network" not in response.headers


def test_the_renderer_origin_without_the_token_is_still_refused(backend):
    with backend.client(token=None) as c:
        response = c.get("/api/routines", headers={"Origin": RENDERER_ORIGIN})
    assert _refusal(response) == (401, "token_missing")


# ---------------------------------------------------------------------------
# P4 — preflight
# ---------------------------------------------------------------------------

def _preflight(backend, origin: str, private_network: bool) -> httpx.Response:
    headers = {"Origin": origin, "Access-Control-Request-Method": "POST",
               "Access-Control-Request-Headers": "authorization,content-type"}
    if private_network:
        headers["Access-Control-Request-Private-Network"] = "true"
    with backend.client(token=None) as c:
        return c.options("/api/routines", headers=headers)


@pytest.mark.parametrize("origin", FOREIGN_ORIGINS)
@pytest.mark.parametrize("private_network", [True, False])
def test_a_foreign_preflight_gets_neither_header(backend, origin, private_network):
    response = _preflight(backend, origin.format(wrong=12347), private_network)
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers
    assert "access-control-allow-private-network" not in response.headers


def test_the_renderer_preflight_gets_both_only_as_asked(backend):
    asked = _preflight(backend, RENDERER_ORIGIN, True)
    assert asked.status_code == 200
    assert asked.headers["access-control-allow-origin"] == RENDERER_ORIGIN
    assert asked.headers["access-control-allow-private-network"] == "true"
    assert "authorization" in asked.headers["access-control-allow-headers"].lower()
    not_asked = _preflight(backend, RENDERER_ORIGIN, False)
    assert not_asked.status_code == 200
    assert not_asked.headers["access-control-allow-origin"] == RENDERER_ORIGIN
    assert "access-control-allow-private-network" not in not_asked.headers


def test_cors_second_layer_drops_private_network_for_a_failed_origin():
    """Starlette's stock preflight marks a *failed* origin with the PNA header; ours does not."""
    from starlette.datastructures import Headers

    layer = api_auth.RendererCORSMiddleware(app=None, allow_methods=["*"], allow_headers=["*"],
                                            allow_private_network=True)
    response = layer.preflight_response(Headers({"origin": "https://evil.example",
                                                 "access-control-request-method": "GET",
                                                 "access-control-request-private-network": "true"}))
    assert response.status_code == 400
    assert "access-control-allow-private-network" not in response.headers
    assert "access-control-allow-origin" not in response.headers


# ---------------------------------------------------------------------------
# The preflight carve-out is exactly OPTIONS + the renderer Origin + ACRM
# ---------------------------------------------------------------------------
#
# The guard's one deliberate token exemption: a CORS preflight carries no
# credentials by specification, so it is answered without the token. It is a
# second allowlist beside ``AUTH_EXEMPT_PATHS``, and it is pinned the same way:
# each of its three conditions has a request below that must still be refused
# when that condition alone is not met. ``Origin`` cannot be forged by a page,
# but another local user's process forges it trivially, and the renderer's port
# is visible to it — which is exactly the principal the token keeps out.

@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize("request_method_header", [False, True], ids=["plain", "with-ACRM"])
def test_the_renderer_origin_without_the_token_is_refused_on_every_non_preflight(backend, method,
                                                                                request_method_header):
    """Not OPTIONS, so not a preflight — even with the renderer's Origin and an ACRM header."""
    headers = {"Origin": RENDERER_ORIGIN}
    if request_method_header:
        headers["Access-Control-Request-Method"] = method
    with backend.client(token=None) as c:
        response = c.request(method, "/api/health" if method == "GET" else "/api/routines",
                             headers=headers, content=b"{not json" if method == "POST" else None)
    assert _refusal(response) == (401, "token_missing")
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize("path", ["/api/health", "/api/routines"])
def test_an_options_request_without_an_origin_is_not_a_preflight(backend, path):
    """OPTIONS + ACRM, no Origin, no token: refused — the carve-out requires the renderer's Origin."""
    with backend.client(token=None) as c:
        response = c.options(path, headers={"Access-Control-Request-Method": "GET"})
    assert _refusal(response) == (401, "token_missing")


@pytest.mark.parametrize("path", ["/api/health", "/api/routines"])
def test_an_options_request_without_a_request_method_is_not_a_preflight(backend, path):
    """OPTIONS from the renderer's Origin with no ACRM, no token: refused — the carve-out requires ACRM."""
    with backend.client(token=None) as c:
        response = c.options(path, headers={"Origin": RENDERER_ORIGIN})
    assert _refusal(response) == (401, "token_missing")
    assert "access-control-allow-origin" not in response.headers


def test_the_real_preflight_is_still_answered_without_the_token(backend):
    """The positive control for the three refusals above: all three conditions met → CORS answers."""
    with backend.client(token=None) as c:
        response = c.options("/api/health", headers={"Origin": RENDERER_ORIGIN,
                                                     "Access-Control-Request-Method": "GET"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == RENDERER_ORIGIN


# ---------------------------------------------------------------------------
# The daemon's origin registration
# ---------------------------------------------------------------------------

def test_a_renderer_origin_is_registered_only_by_a_token_holder_without_an_origin(backend):
    late = "http://127.0.0.1:23456"
    assert _preflight(backend, late, True).status_code == 403
    with backend.client() as c:
        from_page = c.post("/api/auth/renderer-origin", json={"origin": late}, headers={"Origin": RENDERER_ORIGIN})
        assert from_page.status_code == 403
        assert c.post("/api/auth/renderer-origin", json={"origin": "http://localhost:23456"}).status_code == 422
        assert c.post("/api/auth/renderer-origin", json={"origin": "https://evil.example"}).status_code == 422
    with backend.client(token=None) as c:
        assert _refusal(c.post("/api/auth/renderer-origin", json={"origin": late})) == (401, "token_missing")
    assert _preflight(backend, late, True).status_code == 403
    with backend.client() as c:
        assert c.post("/api/auth/renderer-origin", json={"origin": late}).json() == {"registered": late}
    registered = _preflight(backend, late, True)
    assert registered.status_code == 200
    assert registered.headers["access-control-allow-origin"] == late


def test_the_registered_origins_are_bounded_and_the_oldest_is_evicted(tmp_path):
    """Eight further registrations evict the first origin; the eight newest are still trusted.

    Its own backend, because this evicts the fixture's renderer origin.
    """
    first = "http://127.0.0.1:30000"
    b = Backend(tmp_path / "state", env={"RESMON_RENDERER_ORIGIN": first})
    try:
        assert _preflight(b, first, False).status_code == 200
        later = [f"http://127.0.0.1:{30001 + i}" for i in range(8)]
        with b.client() as c:
            for origin in later:
                assert c.post("/api/auth/renderer-origin", json={"origin": origin}).status_code == 200
        evicted = _preflight(b, first, False)
        assert evicted.status_code == 403
        assert "access-control-allow-origin" not in evicted.headers
        with b.client() as c:
            assert _refusal(c.get("/api/routines", headers={"Origin": first})) == (403, "origin_refused")
        for origin in later:
            assert _preflight(b, origin, False).status_code == 200
    finally:
        b.stop()


def test_the_library_guard_trusts_only_the_exact_renderer_origin(backend):
    """B4: its header rule stays; its origin rule narrows from any loopback port to this one."""
    with backend.client() as c:
        ok = c.get("/api/library", headers={"Origin": RENDERER_ORIGIN, "X-Resmon-Library": "1"})
        no_header = c.get("/api/library", headers={"Origin": RENDERER_ORIGIN})
        other_port = c.get("/api/library", headers={"Origin": "http://127.0.0.1:12399", "X-Resmon-Library": "1"})
    assert ok.status_code == 200
    assert no_header.status_code == 403
    assert _refusal(other_port) == (403, "origin_refused")


# ---------------------------------------------------------------------------
# D3 / P7 — token files: bare launcher, Electron hand-over, daemon
# ---------------------------------------------------------------------------

def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX mode bits; Windows relies on the profile ACL")
def test_the_bare_launcher_mints_a_token_and_publishes_it_owner_only(backend):
    path = api_auth.token_file(backend.port, backend.state)
    assert _mode(path) == 0o600
    assert api_auth.valid_token(path.read_text())


def test_an_electron_handed_token_is_the_one_served_and_leaves_no_trace_in_argv(tmp_path):
    handed = api_auth.mint_token()
    b = Backend(tmp_path / "state", env={"RESMON_API_TOKEN": handed, "RESMON_RENDERER_ORIGIN": RENDERER_ORIGIN})
    try:
        assert b.token == handed
        assert handed not in " ".join(b.argv)
        # The argv another user would see. Linux: /proc/<pid>/cmdline is exact
        # (``ps`` stops at the first newline, and the wrapper's -c script has
        # several). macOS: ``ps -ww``. Windows: not observed here.
        if sys.platform.startswith("linux"):
            observed = Path(f"/proc/{b.proc.pid}/cmdline").read_bytes().replace(b"\0", b" ").decode()
        elif sys.platform != "win32":
            observed = subprocess.run(["ps", "-ww", "-o", "command=", "-p", str(b.proc.pid)],
                                      capture_output=True, text=True).stdout
        else:
            observed = ""
        assert str(b.port) in observed or sys.platform == "win32", "the observation must include the argv tail"
        assert handed not in observed
    finally:
        code = b.stop()
    # Dies of SIGTERM as it always did (a SystemExit here once let a backend with
    # a live worker thread hang instead of exiting), and cleans up first.
    assert code == -signal.SIGTERM or sys.platform == "win32"
    assert not api_auth.token_file(b.port, b.state).exists(), "a clean shutdown removes the token file"
    assert not (b.state / "resmon.port").exists()


def test_a_malformed_handed_token_refuses_to_start(tmp_path):
    env = {k: v for k, v in os.environ.items() if not k.startswith("RESMON_")}
    env.update({"RESMON_API_TOKEN": "short", "RESMON_STATE_DIR": str(tmp_path),
                "RESMON_DB_PATH": str(tmp_path / "resmon.db"), "PYTHONPATH": str(RESMON_SCRIPTS)})
    done = subprocess.run([sys.executable, "-c", _LOOPBACK_ONLY, "script", str(RESMON_SCRIPTS / "resmon.py"),
                           str(_free_port())], cwd=RESMON_SCRIPTS, env=env, capture_output=True, text=True,
                          timeout=60)
    assert done.returncode != 0
    assert "not a valid token" in done.stderr
    assert not list(tmp_path.glob("api-token-*"))


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM/SIGKILL and POSIX modes")
def test_the_daemon_publishes_rotates_and_retires_its_token(tmp_path):
    state = tmp_path / "state"
    port = _free_port()
    first = Backend(state, daemon=True, port=port)
    path = api_auth.token_file(port, state)
    try:
        assert path.parent == state and (state / "daemon.lock").exists()
        assert _mode(path) == 0o600
        with first.client() as c:
            assert c.get("/api/health").status_code == 200
    finally:
        first.stop(signal.SIGTERM)
    assert not path.exists(), "a clean daemon shutdown removes its token file"

    second = Backend(state, daemon=True, port=port)
    try:
        assert second.token != first.token
        with second.client(token=first.token) as c:
            assert _refusal(c.get("/api/health")) == (401, "token_invalid")
        with second.client() as c:
            assert c.get("/api/health").status_code == 200
    finally:
        second.stop(signal.SIGKILL)
    # A crash leaves the file behind. It must not let anything in later.
    assert path.exists() and path.read_text() == second.token

    third = Backend(state, daemon=True, port=port)
    try:
        assert third.token not in (first.token, second.token)
        with third.client(token=second.token) as c:
            assert _refusal(c.get("/api/health")) == (401, "token_invalid")
    finally:
        third.stop()


def test_a_successors_token_file_is_not_deleted_by_its_predecessor(tmp_path):
    ours, theirs = api_auth.mint_token(), api_auth.mint_token()
    api_auth.write_token_file(40000, theirs, tmp_path)
    api_auth.remove_token_file(40000, ours, tmp_path)
    assert api_auth.read_token_file(40000, tmp_path) == theirs


def test_the_daemon_status_probe_sends_the_daemons_token(tmp_path):
    """resmon.py probes a daemon from inside the backend; it is a client too."""
    daemon_state = tmp_path / "daemon"
    daemon = Backend(daemon_state, daemon=True)
    try:
        # Ask the *daemon* about itself: its lock and token file are in its own state dir.
        with daemon.client() as c:
            status = c.get("/api/service/daemon-status").json()
        assert status["running"] is True and status["is_self"] is True and status["error"] is None
    finally:
        daemon.stop()


# ---------------------------------------------------------------------------
# P6 — the real MCP server, over stdio, against the real guarded backend
# ---------------------------------------------------------------------------

def _run_mcp(state: Path, port: int, calls: list[tuple[str, dict]]) -> tuple[list[dict], str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("RESMON_")}
    env.update({"PYTHONPATH": str(RESMON_SCRIPTS), "RESMON_PORT": str(port), "RESMON_STATE_DIR": str(state),
                "RESMON_PORT_FILE": str(state / "no-such-port-file")})
    lines = [{"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}]
    lines += [{"jsonrpc": "2.0", "id": i + 1, "method": "tools/call", "params": {"name": n, "arguments": a}}
              for i, (n, a) in enumerate(calls)]
    done = subprocess.run([sys.executable, str(RESMON_SCRIPTS / "mcp_server.py")], cwd=RESMON_SCRIPTS, env=env,
                          input="".join(json.dumps(line) + "\n" for line in lines),
                          capture_output=True, text=True, timeout=300)
    responses = [json.loads(line) for line in done.stdout.splitlines() if line.strip()]
    return responses, done.stdout, done.stderr


def _payload(response: dict) -> dict:
    return json.loads(response["result"]["content"][0]["text"])


def test_every_mcp_tool_reaches_the_guarded_backend_over_stdio(backend):
    calls = [(tool["name"], args) for tool in mcp_server.TOOLS for args in TOOL_ARGS[tool["name"]]]
    responses, stdout, stderr = _run_mcp(backend.state, backend.port, calls)
    by_id = {r["id"]: r for r in responses}
    assert len(by_id) == len(calls) + 1
    refused: list[str] = []
    reached: set[str] = set()
    for i, (name, _args) in enumerate(calls):
        payload = _payload(by_id[i + 1])
        if isinstance(payload, dict) and payload.get("error") == "backend_unavailable":
            refused.append(name)
        else:
            reached.add(name)
    # N of M, M from mcp_server.TOOLS.
    assert refused == []
    assert reached == {t["name"] for t in mcp_server.TOOLS}
    assert backend.token not in stdout and backend.token not in stderr


def test_every_mcp_tool_sends_the_token_through_the_one_transport(monkeypatch):
    """Every request every tool makes carries the header — parametrised over TOOLS, not read off the code."""
    token = api_auth.mint_token()
    seen: list[tuple[str, str, dict]] = []

    def _request(method, url, **kwargs):
        seen.append((method, url, dict(kwargs.get("headers") or {})))
        body = {"anything": "x", "id": 1, "settings": {"anything": "x"}, "capability": {}}
        return httpx.Response(200, json=body, request=httpx.Request(method, url))

    mcp_server.backend.pin("http://127.0.0.1:49999", token)
    monkeypatch.setattr(mcp_server.httpx, "request", _request)
    try:
        per_tool: dict[str, int] = {}
        for tool in mcp_server.TOOLS:
            before = len(seen)
            for args in TOOL_ARGS[tool["name"]]:
                mcp_server.call_tool(tool["name"], args)
            per_tool[tool["name"]] = len(seen) - before
    finally:
        mcp_server.backend.pin(None, None)  # type: ignore[arg-type]
    assert all(n > 0 for n in per_tool.values()), per_tool
    assert len(per_tool) == len(mcp_server.TOOLS)
    assert all(h.get("Authorization") == f"Bearer {token}" for _, _, h in seen)
    assert not any(token in url for _, url, _ in seen)


def test_a_named_port_without_a_token_is_an_error_naming_it_never_8742(backend, tmp_path):
    empty = tmp_path / "elsewhere"
    empty.mkdir()
    responses, stdout, _ = _run_mcp(empty, backend.port, [("health", {})])
    payload = _payload(responses[1])
    assert payload["error"] == "backend_unavailable"
    assert payload["detail"]["tried"] == [backend.base]
    assert payload["detail"]["no_token"] == [backend.base]
    assert backend.base in payload["message"]
    assert "8742" not in stdout


def test_a_stale_token_file_is_reported_and_never_echoed(backend, tmp_path):
    stale_dir = tmp_path / "stale"
    stale = api_auth.mint_token()
    api_auth.write_token_file(backend.port, stale, stale_dir)
    responses, stdout, stderr = _run_mcp(stale_dir, backend.port, [("health", {}), ("list_routines", {})])
    for response in responses[1:]:
        payload = _payload(response)
        assert payload["error"] == "backend_unavailable"
        assert payload["detail"]["token_refused"] == [backend.base]
    assert stale not in stdout and stale not in stderr


def test_a_tool_result_that_somehow_carried_the_token_is_redacted():
    token = api_auth.mint_token()
    mcp_server.backend.pin("http://127.0.0.1:49999", token)
    try:
        text = mcp_server._result({"echo": f"x{token}y"})["content"][0]["text"]
    finally:
        mcp_server.backend.pin(None, None)  # type: ignore[arg-type]
    assert token not in text and "[redacted]" in text


# ---------------------------------------------------------------------------
# P8 — the token never lands in argv, config, logs or URLs
# ---------------------------------------------------------------------------

def test_the_backend_access_log_never_contains_the_token(backend):
    with backend.client() as c:
        c.get("/api/health")
        c.get("/api/routines", headers={"Origin": RENDERER_ORIGIN})
    with backend.client(token=None) as c:
        c.get("/api/health", headers=api_auth.bearer(backend.token + "x"))
    log = backend.log.read_text()
    assert "GET /api/health" in log, "access logging is on, so this check is not vacuous"
    assert backend.token not in log


def test_the_cli_assistant_config_and_argv_carry_no_token(tmp_path, monkeypatch):
    from implementation_scripts import assistant_runtime

    token = api_auth.current_token()
    assert token
    monkeypatch.setenv(api_auth.TOKEN_ENV, token)
    runtime = assistant_runtime.ClaudeCliRuntime(backend_port=51234)
    config = runtime.mcp_config(7, str(tmp_path))
    argv = runtime.build_argv("hello", mcp_config_path=str(tmp_path / "c.json"),
                              cli_session_id="00000000-0000-4000-8000-000000000000", resume=False,
                              binary="/bin/echo")
    assert token not in json.dumps(config) and token not in " ".join(argv)
    assert token not in json.dumps(assistant_runtime._child_env())
    for server in config["mcpServers"].values():
        assert server["env"]["RESMON_STATE_DIR"] == str(api_auth.state_dir())
        assert server["env"]["RESMON_PORT"] == "51234"


def test_the_api_key_runtime_pins_tools_with_this_backends_token():
    from implementation_scripts import assistant_api_runtime

    runtime = assistant_api_runtime.ApiKeyRuntime(provider="openai", model="m", api_key="k", backend_port=51234)
    try:
        runtime._point_tools_at_this_backend()
        assert mcp_server.backend.base_url() == "http://127.0.0.1:51234"
        assert mcp_server.backend.token() == api_auth.current_token()
    finally:
        mcp_server.backend.pin(None, None)  # type: ignore[arg-type]


def test_the_backend_removes_the_handed_token_from_its_environment(monkeypatch):
    token = api_auth.mint_token()
    before = api_auth.current_token(), api_auth.renderer_origins()
    monkeypatch.setenv(api_auth.TOKEN_ENV, token)
    monkeypatch.setenv(api_auth.RENDERER_ORIGIN_ENV, RENDERER_ORIGIN)
    try:
        assert api_auth.configure_from_environment() == token
        assert api_auth.TOKEN_ENV not in os.environ and api_auth.RENDERER_ORIGIN_ENV not in os.environ
    finally:
        api_auth.configure(before[0], before[1])
