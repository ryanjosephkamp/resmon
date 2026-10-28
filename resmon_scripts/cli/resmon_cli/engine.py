"""Finding the running resmon, and asking it things.

Where this looks
----------------
Three things name a running resmon, and they are read in this order:

1. ``RESMON_PORT``. When it is set it is the only place looked: a named port
   that does not answer is reported as such and never widened to another port.
   The MCP server learned that rule the hard way (``mcp_server._candidate_ports``):
   falling through from a named port to a default one attached it to a
   different installation, which then answered every question truthfully about
   the wrong corpus.
2. ``daemon.lock`` in the state folder, which the background service writes
   with its port and pid. That process owns the schedule, so it is preferred:
   the app attaches to it the same way (``electron/main.ts``,
   ``tryAttachToDaemon``), and asking it means nothing here ever runs a second
   scheduler.
3. The port file the app's own engine writes when no service is attached:
   ``RESMON_PORT_FILE``, else ``resmon.port`` beside ``RESMON_DB_PATH``, else
   ``resmon.port`` in the state folder, which is where the packaged app keeps
   its database.

Each candidate's token is read from ``api-token-<port>`` in the state folder,
the file the engine writes owner-only at start (``docs/local-api-security.md``).
A port with no token file is not probed at all; a token the engine refuses is
one left behind by an earlier run on that port.

Why it never starts an engine of its own
----------------------------------------
A command line could start the engine itself for one command when none is up.
This one does not, because starting resmon's engine is not a read. Its startup
(``resmon._lifespan``) applies a staged restore, which replaces the database
file; migrates the schema to *this* copy's version, which a command line
installed from a newer checkout than the app would do to the person's real
corpus; turns any ``running`` row whose owner it judges gone into
``interrupted``; and re-queues and starts the delivery drain, which sends
queued emails and webhooks. It would also have to choose a database to open, and with no running
resmon to ask, that is a guess about a path -- the wrong-corpus hazard above.
So when nothing answers, the command says so, says where it looked, and stops.
"""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional
from urllib.parse import urlencode

from resmon_cli import __version__

APP_DIR_NAME = "resmon"
LOCK_FILE_NAME = "daemon.lock"
TOKEN_FILE_PREFIX = "api-token-"
PORT_FILE_NAME = "resmon.port"

# The shape ``api_auth.valid_token`` accepts. A file holding anything else is
# not a token this command will send.
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43,128}")

PROBE_TIMEOUT = 3.0
REQUEST_TIMEOUT = 120.0

# Exit statuses. 2 is argparse's own for a usage error.
FAILED = 1
NOT_RUNNING = 3


class CliError(Exception):
    """A refusal or failure, with a sentence for people and a code for scripts."""

    def __init__(self, code: str, message: str, *, exit_status: int = FAILED,
                 detail: Optional[dict] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_status = exit_status
        self.detail = detail or {}

    def payload(self) -> dict:
        return {"error": self.code, "message": self.message, **self.detail}


def display_path(path: Path) -> str:
    """``path`` with the home folder written as ``~``, for sentences only."""
    try:
        return "~/" + Path(path).relative_to(Path.home()).as_posix()
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------
# The files a running resmon leaves
# ---------------------------------------------------------------------------

def state_dir(env: Mapping[str, str], *, platform: Optional[str] = None,
              home: Optional[Path] = None) -> Path:
    """The per-user state folder. Mirrors ``daemon.state_dir``; a test holds them equal."""
    override = env.get("RESMON_STATE_DIR")
    if override:
        return Path(override)
    platform = platform or sys.platform
    home = home or Path.home()
    if platform == "darwin":
        return home / "Library" / "Application Support" / APP_DIR_NAME
    if platform == "win32":
        base = env.get("LOCALAPPDATA") or str(home / "AppData" / "Local")
        return Path(base) / APP_DIR_NAME
    base = env.get("XDG_STATE_HOME") or str(home / ".local" / "state")
    return Path(base) / APP_DIR_NAME


def port_file(env: Mapping[str, str], state: Path) -> Path:
    """Where the app's own engine writes its port (``config.PORT_FILE``, as packaged)."""
    if env.get("RESMON_PORT_FILE"):
        return Path(env["RESMON_PORT_FILE"])
    if env.get("RESMON_DB_PATH"):
        return Path(env["RESMON_DB_PATH"]).parent / PORT_FILE_NAME
    return state / PORT_FILE_NAME


def read_token(state: Path, port: int) -> Optional[str]:
    try:
        text = (state / f"{TOKEN_FILE_PREFIX}{int(port)}").read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return text if _TOKEN_RE.fullmatch(text) else None


def _valid_port(value: object) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 < value < 65536 else None


def _read_lock(path: Path) -> tuple[Optional[dict], str]:
    """The lock's payload, or None and the reason it is not usable."""
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None, "not there"
    except OSError as exc:
        return None, f"could not be read ({type(exc).__name__})"
    try:
        data = json.loads(raw) if raw else None
    except ValueError:
        data = None
    if not isinstance(data, dict) or _valid_port(data.get("port")) is None:
        return None, "names no port"
    return data, ""


def _read_port_file(path: Path) -> tuple[Optional[int], str]:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None, "not there"
    except OSError as exc:
        return None, f"could not be read ({type(exc).__name__})"
    port = _valid_port(int(text)) if text.isdigit() else None
    return (port, "") if port else (None, "names no port")


# ---------------------------------------------------------------------------
# Talking to it
# ---------------------------------------------------------------------------

@dataclass
class Reply:
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8")) if self.body else None

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


def _send(port: int, token: str, method: str, path: str, *, body: Optional[bytes] = None,
          timeout: float) -> Reply:
    """One request. No ``Origin``: like the MCP server, this is not a browser and
    is judged on the token alone; ``Host`` is ``127.0.0.1:<port>``, which the
    guard requires."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json",
               "User-Agent": f"resmon-cli/{__version__}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    try:
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        data = response.read()
        return Reply(response.status, {k.lower(): v for k, v in response.getheaders()}, data)
    finally:
        conn.close()


def _detail(reply: Reply) -> str:
    """The engine's own sentence from an error body, whichever shape it took."""
    try:
        data = reply.json()
    except ValueError:
        return reply.text().strip()[:500]
    detail = data.get("detail") if isinstance(data, dict) else None
    if isinstance(detail, str):
        return detail
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("reason") or detail)
    if isinstance(detail, list):  # FastAPI's validation list
        parts = []
        for item in detail:
            if isinstance(item, dict):
                where = ".".join(str(p) for p in item.get("loc", []) if p != "body")
                parts.append(f"{where}: {item.get('msg')}" if where else str(item.get("msg")))
        return "; ".join(parts)
    return reply.text().strip()[:500]


@dataclass
class Engine:
    """A running resmon that answered ``/api/health`` with the token found for it."""

    port: int
    token: str = field(repr=False)
    how: str  # "service" (daemon.lock), "app" (port file) or "named" (RESMON_PORT)
    state: Path
    health: dict
    lock_pid: Optional[int] = None

    @property
    def version(self) -> str:
        return str(self.health.get("version") or "of an unreported version")

    @property
    def pid(self) -> Optional[int]:
        pid = self.health.get("pid")
        return pid if isinstance(pid, int) else None

    @property
    def is_service(self) -> bool:
        """The lock named this port *and* the process answering is the one it names.

        A lock outlives a service that crashed, and a later resmon can hold the
        port it names; matching the pid is what makes "the background service"
        a fact rather than an inference from a file."""
        return self.how == "service" and self.lock_pid is not None and self.pid == self.lock_pid

    def describe(self) -> str:
        if self.is_service:
            return "the background service"
        if self.how == "service":
            return (f"the resmon on port {self.port}, which daemon.lock names, though its "
                    f"process ({self.pid}) is not the one the lock records ({self.lock_pid})")
        if self.how == "app":
            return "the engine the resmon app started for its window"
        return f"the resmon on port {self.port}, as RESMON_PORT names"

    def request(self, method: str, path: str, *, params: Optional[Mapping[str, Any]] = None,
                body: Any = None, timeout: float = REQUEST_TIMEOUT) -> Reply:
        query = {k: v for k, v in (params or {}).items() if v is not None}
        url = path + (f"?{urlencode(query, doseq=True)}" if query else "")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        try:
            reply = _send(self.port, self.token, method, url, body=data, timeout=timeout)
        except socket.timeout:
            raise CliError("timeout", f"resmon did not answer {method} {path} within "
                           f"{timeout:.0f} seconds.") from None
        except (OSError, http.client.HTTPException):
            raise CliError("not_running", "resmon stopped answering during the request.",
                           exit_status=NOT_RUNNING) from None
        if reply.status < 400:
            return reply
        message = _detail(reply)
        if reply.status == 401:
            raise CliError("token_refused", "resmon refused this command's token. It has "
                           "probably restarted since the command found it; run the command again.")
        if reply.status == 404 and message == "Not Found":
            # FastAPI's own answer for a path it has no route for. A missing
            # *item* comes back with the route's sentence ("Execution not found").
            raise CliError("missing_route", f"This resmon ({self.version}) has no {method} {path}. "
                           "It is older than this command line.", detail={"route": f"{method} {path}"})
        code = {404: "not_found", 400: "invalid", 422: "invalid", 409: "conflict",
                429: "conflict"}.get(reply.status, "engine_error")
        if reply.status >= 500:
            message = f"resmon reported an internal error: {message}"
        raise CliError(code, message, detail={"status": reply.status})

    def get(self, path: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("GET", path, params=params).json()

    def post(self, path: str, body: Any = None) -> Any:
        return self.request("POST", path, body=body if body is not None else {}).json()


# ---------------------------------------------------------------------------
# Finding it
# ---------------------------------------------------------------------------

@dataclass
class Looked:
    """One place this command looked for a running resmon, and what it found there."""

    what: str
    path: Optional[str]
    port: Optional[int]
    found: str

    def as_dict(self) -> dict:
        return {"what": self.what, "path": self.path, "port": self.port, "found": self.found}


def _probe(port: int, token: str) -> tuple[Optional[dict], str]:
    """``/api/health`` on ``port``: the body, or None and what happened instead."""
    try:
        reply = _send(port, token, "GET", "/api/health", timeout=PROBE_TIMEOUT)
    except socket.timeout:
        return None, f"port {port} did not answer within {PROBE_TIMEOUT:.0f} seconds"
    except (OSError, http.client.HTTPException):
        return None, f"nothing answered on port {port}"
    if reply.status == 401:
        return None, (f"the resmon on port {port} refused the token in {TOKEN_FILE_PREFIX}{port}, "
                      "which an earlier run left behind")
    if reply.status != 200:
        return None, f"port {port} answered HTTP {reply.status}, not resmon's health"
    try:
        health = reply.json()
    except ValueError:
        health = None
    if not isinstance(health, dict) or health.get("status") != "ok":
        return None, f"something answered on port {port}, but not as resmon"
    return health, ""


def find(env: Optional[Mapping[str, str]] = None) -> Engine:
    """The running resmon these files name, or a :class:`CliError` saying where it looked."""
    env = os.environ if env is None else env
    state = state_dir(env)
    looked: list[Looked] = []
    candidates: list[tuple[str, int, Optional[int], str, str]] = []  # how, port, pid, what, path

    named = (env.get("RESMON_PORT") or "").strip()
    if named:
        port = _valid_port(int(named)) if named.isdigit() else None
        if port is None:
            raise CliError("invalid_port", f"RESMON_PORT is set to {named!r}, which is not a port.",
                           exit_status=2)
        candidates.append(("named", port, None, "RESMON_PORT", ""))
    else:
        lock_path = state / LOCK_FILE_NAME
        lock, why = _read_lock(lock_path)
        if lock is None:
            looked.append(Looked("daemon.lock", str(lock_path), None, why))
        else:
            pid = lock.get("pid") if isinstance(lock.get("pid"), int) else None
            candidates.append(("service", int(lock["port"]), pid, "daemon.lock", str(lock_path)))
        pf = port_file(env, state)
        port, why = _read_port_file(pf)
        if port is None:
            looked.append(Looked("port file", str(pf), None, why))
        elif port not in {c[1] for c in candidates}:
            candidates.append(("app", port, None, "port file", str(pf)))

    for how, port, pid, what, path in candidates:
        token = read_token(state, port)
        if token is None:
            looked.append(Looked(what, path or None, port,
                                 f"names port {port}, but the state folder holds no token for it"))
            continue
        health, why = _probe(port, token)
        if health is None:
            looked.append(Looked(what, path or None, port, f"names port {port}; {why}"))
            continue
        return Engine(port=port, token=token, how=how, state=state, health=health, lock_pid=pid)

    raise CliError("not_running", _not_running_message(state, looked, bool(named)),
                   exit_status=NOT_RUNNING,
                   detail={"state_dir": str(state), "looked": [x.as_dict() for x in looked]})


_LOOKED_LABELS = {
    "daemon.lock": "daemon.lock (the background service)",
    "port file": "resmon.port (the app's own engine)",
}


def _not_running_message(state: Path, looked: list[Looked], named: bool) -> str:
    lines = [f"No resmon is running for the state folder {display_path(state)}."]
    for item in looked:
        label = _LOOKED_LABELS.get(item.what, item.what)
        if item.path and Path(item.path).parent != state:
            label += f" at {display_path(Path(item.path))}"
        lines.append(f"  {label}: {item.found}")
    if named:
        lines.append("RESMON_PORT names one port, so no other place was tried.")
    lines.append("Open resmon, or turn on Settings → Advanced → Run resmon in the background.")
    lines.append("This command does not start resmon itself.")
    return "\n".join(lines)
