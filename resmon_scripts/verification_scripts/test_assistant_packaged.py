"""P13 — the packaged app can start its own MCP servers for the CLI.

The risk is specific and has bitten this project before. The packaged app ships
a bundled interpreter and spawns the backend with it (`main.ts` builds
``Contents/Resources/backend/python/bin/python3`` explicitly), so
``sys.executable`` inside the backend *is* that interpreter. resmon then hands
the CLI an MCP config naming a command and two scripts — and if that command
were ``python3``, it would resolve against the PATH a Finder-launched app
inherits, which is ``/usr/bin:/bin:/usr/sbin:/sbin`` and contains no resmon
environment at all. The same class of failure as 1.8's CLI discovery, one layer
down.

Two halves, and they run in different circumstances:

* **Always** — the config's shape: an absolute interpreter, absolute script
  paths, and files that exist.
* **When a packaged app is present under ``release/``** — the servers really
  started, over stdio, under the really-bundled interpreter, from the really
  packaged copies of the scripts. It **skips rather than passes** when there is
  no packaged app or when the one there predates the assistant, and the skip
  says which. A stale bundle reporting a pass would be worse than no check:
  ``packaged.spec.ts`` learned that when a months-old 1.6.0 build was walked and
  called verified.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import assistant_runtime as ar  # noqa: E402

RELEASE = PROJECT_ROOT / "resmon_scripts" / "frontend" / "release"
SERVERS = ("mcp_server.py", "assistant_permission_server.py")


def _packaged_backend() -> Path | None:
    """The ``Resources/backend`` of a packaged app, if one is built."""
    candidates = [
        RELEASE / "mac-arm64" / "resmon.app" / "Contents" / "Resources" / "backend",
        RELEASE / "mac" / "resmon.app" / "Contents" / "Resources" / "backend",
        RELEASE / "linux-unpacked" / "resources" / "backend",
        RELEASE / "win-unpacked" / "resources" / "backend",
    ]
    return next((c for c in candidates if c.is_dir()), None)


def _bundled_interpreter(backend: Path) -> Path:
    if os.name == "nt":
        return backend / "python" / "python.exe"
    return backend / "python" / "bin" / "python3"


# ---------------------------------------------------------------------------
# The half that always runs
# ---------------------------------------------------------------------------

def test_the_interpreter_the_config_names_is_this_backends_own():
    """``sys.executable``, which in the packaged app *is* the bundled Python.

    Never a bare ``python3``: a Finder-launched app inherits
    ``/usr/bin:/bin:/usr/sbin:/sbin``, so a PATH lookup would find either
    nothing or a system interpreter with none of resmon's dependencies.
    """
    assert ar._bundled_python() == sys.executable
    assert Path(ar._bundled_python()).is_absolute()


def test_the_mcp_config_names_files_that_exist_by_absolute_path():
    config = ar.ClaudeCliRuntime(backend_port=1234).mcp_config(1, "/tmp/wd")
    for name, server in config["mcpServers"].items():
        assert Path(server["command"]).is_absolute(), name
        script = Path(server["args"][0])
        assert script.is_absolute(), name
        assert script.is_file(), f"{name} names a script that does not exist: {script}"
        assert Path(server["env"]["PYTHONPATH"]).is_absolute(), name


# ---------------------------------------------------------------------------
# The half that needs a packaged app
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def packaged() -> tuple[Path, Path]:
    backend = _packaged_backend()
    if backend is None:
        pytest.skip("no packaged app under release/ — run `npm run dist` first")

    interpreter = _bundled_interpreter(backend)
    if not interpreter.exists():
        pytest.skip(f"the packaged app has no bundled interpreter at {interpreter}")

    scripts = backend / "resmon_scripts"
    missing = [s for s in SERVERS if not (scripts / s).is_file()]
    if missing:
        pytest.skip(
            f"the packaged app under release/ predates the assistant (missing "
            f"{', '.join(missing)}) — run `npm run dist` to rebuild it"
        )
    return interpreter, scripts


def _speak(interpreter: Path, scripts: Path, script: str) -> list[dict]:
    """initialize + tools/list over stdio, under the bundled interpreter."""
    stdin = "\n".join([
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
        json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
    ]) + "\n"
    completed = subprocess.run(
        [str(interpreter), str(scripts / script)],
        input=stdin, capture_output=True, text=True, timeout=90,
        env={**os.environ, "PYTHONPATH": str(scripts)},
        cwd=str(scripts),
    )
    assert completed.returncode == 0, (
        f"{script} exited {completed.returncode} under the bundled interpreter: "
        f"{completed.stderr[:2000]}"
    )
    return [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]


@pytest.mark.parametrize("script", SERVERS)
def test_a_packaged_server_starts_under_the_bundled_interpreter(packaged, script):
    """P13. Both servers, from the shipped tree, under the shipped Python.

    ``tools/list`` rather than a tool call: what is under test is that the
    packaged interpreter can import what these modules need (``httpx`` is the
    one that matters — it is not in the standard library and it is what a
    mis-staged environment loses). A tool call would additionally need a running
    backend, which is not what P13 is about.
    """
    interpreter, scripts = packaged
    messages = _speak(interpreter, scripts, script)

    initialize = next(m for m in messages if m.get("id") == 1)
    assert initialize["result"]["protocolVersion"]

    listed = next(m for m in messages if m.get("id") == 2)
    names = [t["name"] for t in listed["result"]["tools"]]
    assert names, f"{script} advertised no tools"

    if script == "mcp_server.py":
        # The packaged copy is the shipped surface. If it and the checkout
        # disagree, the app ships a different set of tools from the one every
        # other test in this phase measured.
        import mcp_server  # noqa: PLC0415

        assert set(names) == {t["name"] for t in mcp_server.TOOLS}
    else:
        assert names == ["ask"]
