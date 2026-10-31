"""What the engine imports to start, and what it leaves until it is used.

Every start pays for every module ``resmon.py`` imports, and so does every
idle background service, in memory. Three heavy libraries are needed only
later: numpy when the collection map or shared wording is first asked for,
the Anthropic SDK when a summary runs on an Anthropic key, and SQLAlchemy only
in the process that runs the scheduler. Each was once imported at start; this
holds the engine to importing them where they are used.

The engine is built and started in a child interpreter, because this one has
already imported everything the rest of the suite needed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent

DEFERRED = ("numpy", "anthropic", "sqlalchemy")

BUILD_AND_START_THE_ENGINE = r"""
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("resmon_app", "resmon.py")
module = importlib.util.module_from_spec(spec)
sys.argv = ["resmon.py"]
spec.loader.exec_module(module)
from fastapi.testclient import TestClient
with TestClient(module.app):  # runs the startup hooks, and the shutdown ones after
    pass
deferred = set(json.loads('__DEFERRED__'))
print(json.dumps(sorted(name for name in sys.modules if name in deferred)))
"""


def _loaded_after_starting_the_engine(tmp_path: Path, *, scheduler: bool) -> list[str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("RESMON_")}
    env.update({
        "RESMON_STATE_DIR": str(tmp_path),
        "RESMON_DB_PATH": str(tmp_path / "resmon.db"),
        "RESMON_REPORTS_DIR": str(tmp_path / "reports"),
        "RESMON_PORT_FILE": str(tmp_path / "resmon.port"),
        "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
        "RESMON_AI_CLI_DISCOVERY": "configured-only",
    })
    if not scheduler:
        env["RESMON_DISABLE_SCHEDULER"] = "1"
    script = BUILD_AND_START_THE_ENGINE.replace("__DEFERRED__", json.dumps(list(DEFERRED)))
    done = subprocess.run([sys.executable, "-c", script], cwd=SCRIPTS, env=env,
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr[-2000:]
    return json.loads(done.stdout.strip().splitlines()[-1])


def test_an_engine_started_as_a_window_starts_it_imports_none_of_them(tmp_path):
    # A window's own engine runs no scheduler.
    loaded = _loaded_after_starting_the_engine(tmp_path, scheduler=False)
    assert loaded == [], (
        f"starting the engine imported {loaded}; import it where it is used (see resmon.py's imports)")


def test_the_background_service_imports_sqlalchemy_for_its_scheduler_and_nothing_else(tmp_path):
    loaded = _loaded_after_starting_the_engine(tmp_path, scheduler=True)
    assert loaded == ["sqlalchemy"], (
        f"the service imported {loaded} to start; only its scheduler's job store needs SQLAlchemy")


def test_the_deferred_libraries_are_still_there_when_used():
    # The other half: deferring an import must not mean losing it. Each module
    # that defers one still reaches it on first use.
    from implementation_scripts import collection_map, shared_wording  # noqa: F401
    from implementation_scripts.llm_remote import RemoteLLMClient
    from implementation_scripts.scheduler import ResmonScheduler

    assert "numpy" in sys.modules
    client = RemoteLLMClient(provider="anthropic", api_key="not-a-real-key", model="claude-test")
    assert type(client._anthropic).__module__.startswith("anthropic")
    scheduler = ResmonScheduler(db_url="sqlite://")
    assert type(scheduler._jobstore).__module__ == "apscheduler.jobstores.sqlalchemy"
