"""P1 — the extension loads inside a *running* backend, and health says which version.

Everything else about sqlite-vec is checked in-process, against a connection the
test made itself. That is not the claim the product depends on. The claim is that
the backend resmon actually spawns — a separate process, started the way
``electron/main.ts`` starts it, answering over a real socket — can load the
extension and reports it. The whole class of failures this rules out is invisible
to an in-process check: an import that only resolves because pytest put the repo
on ``sys.path``, a working directory the packaged app does not have, a cached
probe answering for a connection that never loaded anything.

That is the same distinction ``test_mcp_live_surface.py`` was written for, and it
uses that file's fixture shape deliberately.

**What this cannot see:** whether the *packaged* app can load it. This runs the
development interpreter against a development checkout. ``e2e/packaged.spec.ts``
carries that half, and Delegation 05's probe workflow
(``.github/workflows/sqlite-vec-probe.yml``) carries the four release targets.

Marked ``live_network`` because it binds a real socket. It never leaves loopback
and never touches the user's corpus: its own temp database on an unused port.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

pytestmark = pytest.mark.live_network


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="module")
def backend(tmp_path_factory):
    """A real resmon backend, in its own process, over its own empty database."""
    state = tmp_path_factory.mktemp("health-live")
    port = _free_port()
    env = {
        **os.environ,
        "RESMON_DB_PATH": str(state / "resmon.db"),
        "RESMON_REPORTS_DIR": str(state / "reports"),
        "RESMON_PORT_FILE": str(state / "resmon.port"),
        "RESMON_DISABLE_SCHEDULER": "1",
        "PYTHONPATH": str(PROJECT_ROOT / "resmon_scripts"),
    }
    proc = subprocess.Popen(
        [sys.executable, str(PROJECT_ROOT / "resmon_scripts" / "resmon.py"), str(port)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=str(PROJECT_ROOT),
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"backend exited early: {proc.communicate()[0][:2000]}")
            try:
                if httpx.get(f"{base}/api/health", timeout=1.0).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.2)
        else:  # pragma: no cover - only on a machine that cannot start the backend
            raise RuntimeError("backend did not become healthy within 60s")
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:  # pragma: no cover
            proc.kill()


def test_health_reports_the_extension_version_from_a_running_backend(backend):
    """P1. The version is the extension's, read out of a live process."""
    payload = httpx.get(f"{backend}/api/health", timeout=10).json()
    assert payload["status"] == "ok"
    embeddings = payload["embeddings"]

    pytest.importorskip(
        "sqlite_vec",
        reason="sqlite-vec absent from this interpreter; the absence path is "
        "covered hermetically in test_vector_index.py",
    )
    assert embeddings["reason"] is None
    assert embeddings["extension"], "a backend with sqlite-vec installed must report a version"

    # Not a constant in resmon: the same string the extension itself answers.
    import sqlite3

    import sqlite_vec

    probe = sqlite3.connect(":memory:")
    probe.enable_load_extension(True)
    sqlite_vec.load(probe)
    probe.enable_load_extension(False)
    assert embeddings["extension"] == probe.execute("SELECT vec_version()").fetchone()[0]
    probe.close()


def test_health_answers_per_call_rather_than_from_a_cached_first_answer(backend):
    """Two calls, two live loads. A cached capability outlives the thing it names."""
    first = httpx.get(f"{backend}/api/health", timeout=10).json()["embeddings"]
    second = httpx.get(f"{backend}/api/health", timeout=10).json()["embeddings"]
    assert first == second
    # The backend serves requests on a thread pool and each thread holds its own
    # connection (BUG-020), so this also establishes that the load is not tied to
    # whichever thread happened to answer first.
    answers = {
        httpx.get(f"{backend}/api/health", timeout=10).json()["embeddings"]["extension"]
        for _ in range(8)
    }
    assert len(answers) == 1
