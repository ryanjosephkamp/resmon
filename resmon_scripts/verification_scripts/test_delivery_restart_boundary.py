"""P4 at its own boundary: two real backends, one corpus, one SIGKILL.

Everything in `test_delivery.py` runs inside this interpreter, which
establishes what `delivery.requeue_orphaned` does when it is handed a dead pid
and nothing about what a real killed backend leaves behind: whether a
`delivering` row survives the kill as it was written, whether `_lifespan` runs
the re-queue at all, and whether the drain the second process starts actually
finishes the delivery. Those are the claims a user's force-quit depends on and
they are only observable out of process.

The arrangement is `test_executions_interrupted_boundary.py`'s, narrowed: two
real `resmon.py` processes on ephemeral ports in an isolated state directory,
over one corpus. Port 8742 and the daemon's state directory belong to the
maintainer's live corpus and are never touched.

The channel under test is **folder** -- a real directory, written by the real
adapter -- so this file needs no mail server and no credential. The execution
and its delivery row are written straight into the corpus rather than produced
by a sweep: what is being established here is the restart, and a real sweep
would only add an upstream to stub.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "resmon_scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from implementation_scripts import api_auth as _api_auth  # noqa: E402
from implementation_scripts import database  # noqa: E402

_TOKEN = _api_auth.current_token()
_HEADERS = _api_auth.bearer(_TOKEN) if _TOKEN else {}

_LAUNCHER = '''
import sys
sys.path.insert(0, {scripts!r})
import resmon
resmon.main()
'''


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 8742, "8742 is the maintainer's live daemon"
    return port


def _env(state: Path, db: Path) -> dict:
    return {
        **os.environ,
        **({"RESMON_API_TOKEN": _TOKEN} if _TOKEN else {}),
        "RESMON_STATE_DIR": str(state),
        "RESMON_DB_PATH": str(db),
        "RESMON_REPORTS_DIR": str(state / "reports"),
        "RESMON_PORT_FILE": str(state / "backend.port"),
        "RESMON_CHROMIUM_PROFILE": str(state / "chromium"),
        "RESMON_DISABLE_SCHEDULER": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
    }


class Backend:
    """One real `resmon.py`, started and waited for on its own port."""

    def __init__(self, state: Path, db: Path, tag: str) -> None:
        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.log_path = state / f"{tag}.log"
        launcher = state / f"{tag}_launch.py"
        launcher.write_text(_LAUNCHER.format(scripts=str(ROOT / "resmon_scripts")))
        self._log = self.log_path.open("w")
        self.proc = subprocess.Popen(
            [sys.executable, str(launcher), str(self.port)],
            cwd=state, env=_env(state, db), stdout=self._log,
            stderr=subprocess.STDOUT)

    def wait_until_serving(self, seconds: float = 40.0) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                pytest.fail(f"backend exited early:\n{self.log_path.read_text()}")
            try:
                httpx.get(self.base + "/api/health", headers=_HEADERS,
                          timeout=2).raise_for_status()
                return
            except (httpx.HTTPError, ValueError):
                time.sleep(0.2)
        pytest.fail(f"backend never served:\n{self.log_path.read_text()}")

    def get(self, path: str) -> httpx.Response:
        return httpx.get(self.base + path, headers=_HEADERS, timeout=15)

    def sigkill(self) -> None:
        """No handler runs, no `finally`, no graceful shutdown. A force-quit."""
        os.kill(self.proc.pid, signal.SIGKILL)
        self.proc.wait(timeout=20)

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        self._log.close()


def _seed(db: Path, reports: Path, outbox: Path, owner_pid: int) -> dict:
    """A finished routine run with one folder delivery stuck `delivering`.

    Written with the shipped helpers over a plain connection, which is what a
    second process reading the same file will see.
    """
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        database.init_db(conn=conn)
        routine_id = database.insert_routine(conn, {
            "name": "Restart watch", "schedule_cron": "0 8 * * *",
            "parameters": json.dumps({"query": "diffusion", "repositories": []}),
            "is_active": 0, "email_enabled": 0, "email_ai_summary_enabled": 0,
            "ai_enabled": 0, "notify_on_complete": 0, "execution_location": "local",
        })
        reports.mkdir(parents=True, exist_ok=True)
        report = reports / "report_restart.md"
        report.write_text("# Restart watch\n\nOne new paper.\n", encoding="utf-8")
        exec_id = database.insert_execution(conn, {
            "execution_type": "automated_sweep", "routine_id": routine_id,
            "parameters": "{}", "start_time": database.utc_now_iso(),
        })
        database.update_execution_status(conn, exec_id, "completed",
                                         result_path=str(report))
        target_id = conn.execute(
            "INSERT INTO routine_delivery_targets "
            "(routine_id, channel, target, enabled, mode, created_at_utc, "
            " updated_at_utc) VALUES (?, 'folder', ?, 1, 'automatic', ?, ?)",
            (routine_id, str(outbox), database.utc_now_iso(),
             database.utc_now_iso()),
        ).lastrowid
        delivery_id = conn.execute(
            "INSERT INTO deliveries (execution_id, target_id, channel, "
            " target_snapshot, state, attempts, owner_pid, owner_runtime_id, "
            " queued_at_utc) "
            "VALUES (?, ?, 'folder', ?, 'delivering', 1, ?, ?, ?)",
            (exec_id, target_id, str(outbox), owner_pid,
             "00000000-0000-4000-8000-000000000000", database.utc_now_iso()),
        ).lastrowid
        conn.commit()
        return {"routine_id": routine_id, "exec_id": exec_id,
                "delivery_id": delivery_id}
    finally:
        conn.close()


def _delivery(db: Path, delivery_id: int) -> dict:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return dict(conn.execute("SELECT * FROM deliveries WHERE id = ?",
                                 (delivery_id,)).fetchone())
    finally:
        conn.close()


def test_a_sigkilled_backend_leaves_a_delivering_row_the_next_start_finishes(tmp_path):
    """Kill the owner mid-delivery; the next backend re-queues it and sends it.

    Three claims that are only true together: the kill leaves the row exactly
    as it was (`delivering`, with the dead process's pid on it -- nothing
    graceful ran); the next start adopts it, because that owner can be
    established to be gone; and the drain that start begins actually writes the
    bundle into the user's folder, exactly once, without anybody asking it to.
    """
    state = tmp_path / "state"
    state.mkdir()
    db = state / "corpus.db"
    outbox = tmp_path / "Dropbox"
    outbox.mkdir()

    first = Backend(state, db, "first")
    try:
        first.wait_until_serving()
        # Seeded with the live backend's own pid, so the row's owner is a
        # process that really exists right up to the moment it is killed.
        seeded = _seed(db, state / "reports", outbox, first.proc.pid)
        assert _delivery(db, seeded["delivery_id"])["state"] == "delivering"
        first.sigkill()
    finally:
        first.stop()

    row = _delivery(db, seeded["delivery_id"])
    assert row["state"] == "delivering", (
        "a SIGKILLed backend leaves the row as it was; if this has changed, "
        "something ran that should not have")
    assert row["owner_pid"] == first.proc.pid
    assert not (outbox / "resmon").exists()

    second = Backend(state, db, "second")
    try:
        second.wait_until_serving()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            row = _delivery(db, seeded["delivery_id"])
            if row["state"] in ("delivered", "failed"):
                break
            time.sleep(0.2)
        assert row["state"] == "delivered", row["last_error"]
        assert row["attempts"] == 2, (
            "the attempt the dead process made is counted, and this is the "
            "second")
        assert row["delivered_at_utc"]
        assert row["artifact_sha256"], "the report it wrote is identified"

        written = list((outbox / "resmon" / "restart-watch").iterdir())
        assert len(written) == 1, written
        assert (written[0] / "delivery.json").exists()
        assert not any(p.name.startswith(".") for p in
                       (outbox / "resmon" / "restart-watch").iterdir()), (
            "no half-written directory is left behind")

        # And the second process serves the record over the API the app reads.
        served = second.get(f"/api/executions/{seeded['exec_id']}/deliveries")
        assert served.status_code == 200, served.text
        body = served.json()["deliveries"]
        assert len(body) == 1 and body[0]["state"] == "delivered", body
    finally:
        second.stop()
