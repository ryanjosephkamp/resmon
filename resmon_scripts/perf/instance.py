"""An isolated resmon backend, started and stopped by the harness.

Isolation is the whole point of this file. ``RESMON_STATE_DIR`` alone does not
isolate a run: the database comes from ``RESMON_DB_PATH`` and
falls back to one inside the checkout, the reports folder from
``RESMON_REPORTS_DIR``, the port file from ``RESMON_PORT_FILE``. Every one of
them is set here, the keyring is the null backend -- a local test run once
erased a developer's real API keys -- and port 8742, where an installed
resmon's background service listens, is refused rather than probed.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx

SCRIPTS = Path(__file__).resolve().parent.parent
REPO = SCRIPTS.parent

# The installed service's port. Nothing here binds it, connects to it, or
# accepts a backend that reports it.
SERVICE_PORT = 8742


def free_port() -> int:
    """A loopback port nothing is listening on, never the service's."""
    for _ in range(20):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        if port != SERVICE_PORT:
            return port
    raise RuntimeError("could not find a free loopback port")


def isolated_env(state: Path, *, scheduler: bool = False, extra: Optional[dict] = None) -> dict:
    """The environment of every process the harness starts over ``state``."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("RESMON_")}
    env.update({
        "RESMON_STATE_DIR": str(state),
        "RESMON_DB_PATH": str(state / "resmon.db"),
        "RESMON_REPORTS_DIR": str(state / "reports"),
        "RESMON_PORT_FILE": str(state / "resmon.port"),
        "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
        # An AI command only where one is configured: never the person's own
        # signed-in `claude` or `codex`, found on this machine.
        "RESMON_AI_CLI_DISCOVERY": "configured-only",
        "PYTHONPATH": str(SCRIPTS),
    })
    if not scheduler:
        env["RESMON_DISABLE_SCHEDULER"] = "1"
    if extra:
        env.update(extra)
    return env


@dataclass
class Backend:
    """A running backend process and how to reach it."""

    proc: subprocess.Popen
    port: int
    state: Path
    log_path: Path
    started_at: float
    healthy_at: float
    _token: Optional[str] = field(default=None, repr=False)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def token(self) -> str:
        if self._token is None:
            self._token = (self.state / f"api-token-{self.port}").read_text("ascii").strip()
        return self._token

    def client(self, timeout: float = 120.0) -> httpx.Client:
        return httpx.Client(
            base_url=self.base, timeout=timeout,
            headers={"Authorization": f"Bearer {self.token}"},
        )

    def get(self, path: str, **kwargs: Any) -> Any:
        with self.client() as client:
            response = client.get(path, **kwargs)
            response.raise_for_status()
            return response.json()

    def post(self, path: str, body: Any = None, **kwargs: Any) -> Any:
        with self.client() as client:
            response = client.post(path, json=body, **kwargs)
            response.raise_for_status()
            return response.json()

    def put(self, path: str, body: Any = None) -> Any:
        with self.client() as client:
            response = client.put(path, json=body)
            response.raise_for_status()
            return response.json()

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)


def start_backend(
    state: Path,
    *,
    python: Optional[str] = None,
    replay: Optional[dict] = None,
    scheduler: bool = False,
    daemon: bool = False,
    extra_env: Optional[dict] = None,
    timeout: float = 120.0,
) -> Backend:
    """Start a backend over ``state`` and wait until ``/api/health`` answers.

    ``replay`` -- ``{"mode": "replay"|"record", "dir": ..., "latency": ...}``
    -- starts it through ``perf.backend``, which installs the recorded-reply
    transport before resmon imports anything that talks to the network.
    ``daemon`` starts the background service's entry point instead of the
    window's backend, as launchd would.
    """
    state.mkdir(parents=True, exist_ok=True)
    port = free_port()
    # Handed over the way Electron hands one over, so the harness can probe
    # /api/health (which is not exempt from the token) from the first moment
    # rather than waiting for the token file to appear.
    token = secrets.token_urlsafe(32)
    extra = {"RESMON_API_TOKEN": token, **dict(extra_env or {})}
    if replay:
        extra["RESMON_PERF_REPLAY"] = replay["mode"]
        extra["RESMON_PERF_REPLIES"] = str(replay["dir"])
        extra["RESMON_PERF_LATENCY"] = str(replay.get("latency", "recorded"))
    env = isolated_env(state, scheduler=scheduler, extra=extra)
    interpreter = python or sys.executable
    if daemon:
        args = [interpreter, "-m", "perf.backend", "--daemon", str(port),
                f"--db-path={state / 'resmon.db'}", f"--reports-dir={state / 'reports'}"]
    else:
        args = [interpreter, "-m", "perf.backend", str(port)]
    log_path = state / f"backend-{port}.log"
    log = open(log_path, "ab")
    started = time.perf_counter()
    proc = subprocess.Popen(args, cwd=SCRIPTS, env=env, stdout=log, stderr=subprocess.STDOUT)
    log.close()
    deadline = started + timeout
    with httpx.Client(timeout=1.0, headers={"Authorization": f"Bearer {token}"}) as probe:
        while True:
            if proc.poll() is not None:
                raise RuntimeError(
                    f"backend exited with {proc.returncode}:\n"
                    + log_path.read_text(errors="replace")[-3000:]
                )
            try:
                response = probe.get(f"http://127.0.0.1:{port}/api/health")
                if response.status_code == 200:
                    healthy = time.perf_counter()
                    break
            except httpx.HTTPError:
                pass
            if time.perf_counter() > deadline:
                proc.kill()
                raise RuntimeError("backend did not answer /api/health in time")
            time.sleep(0.01)
    health = response.json()
    if int(health.get("port") or port) == SERVICE_PORT:
        proc.kill()
        raise RuntimeError("a backend reported the installed service's port; refusing")
    return Backend(proc=proc, port=port, state=state, log_path=log_path,
                   started_at=started, healthy_at=healthy, _token=token)


def fresh_state(root: Path, name: str, *, seed_db: Optional[Path] = None) -> Path:
    """An empty state directory, optionally holding a copy of a seeded database."""
    state = root / name
    if state.exists():
        shutil.rmtree(state)
    state.mkdir(parents=True)
    if seed_db is not None:
        clone_file(seed_db, state / "resmon.db")
    return state


def clone_file(src: Path, dst: Path) -> None:
    """Copy ``src`` to ``dst``, as an APFS clone where the filesystem allows it.

    A 100,000-paper database is a few hundred megabytes; cloning it for every
    run costs nothing on APFS and a plain copy elsewhere.
    """
    if sys.platform == "darwin":
        result = subprocess.run(["cp", "-c", str(src), str(dst)], capture_output=True)
        if result.returncode == 0:
            return
    shutil.copyfile(src, dst)


def wait_for_execution(backend: Backend, exec_id: int, *, timeout: float = 900.0,
                       poll: float = 0.05) -> tuple[dict, list[tuple[float, dict]]]:
    """Poll a run until it ends; return its row and its events, timestamped here.

    The engine stamps its stage events to the second, which is too coarse for a
    stage that takes 300 ms, so every event is stamped with this process's
    clock when it is first seen. Resolution is the poll interval.
    """
    seen: list[tuple[float, dict]] = []
    deadline = time.perf_counter() + timeout
    with backend.client() as client:
        while True:
            events = client.get(f"/api/executions/{exec_id}/progress/events").json()
            now = time.perf_counter()
            for event in events[len(seen):]:
                seen.append((now, event))
            row = client.get(f"/api/executions/{exec_id}").json()
            if row.get("status") in ("completed", "failed", "cancelled", "interrupted"):
                events = client.get(f"/api/executions/{exec_id}/progress/events").json()
                now = time.perf_counter()
                for event in events[len(seen):]:
                    seen.append((now, event))
                return row, seen
            if time.perf_counter() > deadline:
                raise TimeoutError(f"execution {exec_id} did not finish in {timeout} s")
            time.sleep(poll)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
