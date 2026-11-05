"""The suite never searches for, or starts, the person's own AI command.

``conftest.py`` sets ``RESMON_AI_CLI_DISCOVERY=configured-only`` for the whole
run, before the engine is imported, so ``ai_cli.discover_cli`` finds only a
path a test names. Without it, discovery on a developer's machine finds the
``claude`` or ``codex`` they installed, and the code that asked runs it: a
summary lane, an Ask turn, Settings' sign-in check, or Codex's model list.
These fail if the pin is dropped or loosened, whatever the shell that started
the run exported.

A command run by name skips discovery altogether, so ``conftest.py`` also
refuses to start a ``claude`` or ``codex`` that is not a fake, and fails the
test that tried. The last tests here hold it to that.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from implementation_scripts.ai_cli import SUPPORTED_CLI_PROVIDERS, discover_cli

# Read when this module is imported at collection, before any test has run.
DISCOVERY_AT_COLLECTION = os.environ.get("RESMON_AI_CLI_DISCOVERY")

CONFTEST = Path(__file__).resolve().parent / "conftest.py"


def test_discovery_was_pinned_before_any_test_ran():
    assert DISCOVERY_AT_COLLECTION == "configured-only", (
        "conftest.py must set RESMON_AI_CLI_DISCOVERY=configured-only before collection; "
        f"it was {DISCOVERY_AT_COLLECTION!r}, so discovery could find the person's own CLI")


@pytest.mark.parametrize("provider", SUPPORTED_CLI_PROVIDERS)
def test_a_test_that_names_no_command_finds_none(provider):
    assert os.environ.get("RESMON_AI_CLI_DISCOVERY") == "configured-only"
    found = discover_cli(provider)
    assert not found.found
    assert found.tried == (
        "known locations and PATH not searched (RESMON_AI_CLI_DISCOVERY=configured-only)",)


# conftest.py, loaded in a child interpreter as pytest loads it at the start
# of a run, then the setting it leaves. The child searches for nothing, so a
# conftest that lost the pin fails here without looking for a CLI.
_LOAD_CONFTEST = r"""
import json, os, runpy, sys
runpy.run_path(sys.argv[1])
print(json.dumps(os.environ.get("RESMON_AI_CLI_DISCOVERY")))
"""


@pytest.mark.parametrize("exported", [None, "", "path-only"],
                         ids=["unset", "empty", "path-only"])
def test_conftest_pins_discovery_whatever_the_shell_exported(exported, tmp_path):
    env = {k: v for k, v in os.environ.items() if k != "RESMON_AI_CLI_DISCOVERY"}
    if exported is not None:
        env["RESMON_AI_CLI_DISCOVERY"] = exported
    (tmp_path / "home").mkdir()
    env["HOME"] = str(tmp_path / "home")
    env["PYTHON_KEYRING_BACKEND"] = "keyring.backends.null.Keyring"
    done = subprocess.run(
        [sys.executable, "-c", _LOAD_CONFTEST, str(CONFTEST)],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120,
    )
    assert done.returncode == 0, done.stderr[-2000:]
    assert json.loads(done.stdout.strip().splitlines()[-1]) == "configured-only", (
        f"with RESMON_AI_CLI_DISCOVERY={exported!r} in the shell, conftest.py left it "
        f"{done.stdout.strip()!r}; it must set configured-only for every run")


class _Item:
    """Just enough of a pytest item for ``pytest_runtest_setup``."""

    def __init__(self, *markers: str) -> None:
        self._markers = set(markers)

    def get_closest_marker(self, name):
        return object() if name in self._markers else None


def _loaded_conftest():
    """The conftest module this run loaded, not a second copy of it."""
    return next(module for module in list(sys.modules.values())
                if getattr(module, "__file__", None)
                and Path(module.__file__).resolve() == CONFTEST)


def test_each_test_starts_pinned_and_only_a_live_agent_cli_test_may_search(monkeypatch):
    conftest = _loaded_conftest()
    monkeypatch.setitem(conftest._allow_network, "value", False)
    monkeypatch.setattr(conftest, "_FORCE_HERMETIC", False)
    monkeypatch.setenv("RESMON_AI_CLI_DISCOVERY", "configured-only")

    # Whatever the test before it left behind, the next one starts pinned.
    for left_behind in ("path-only", ""):
        os.environ["RESMON_AI_CLI_DISCOVERY"] = left_behind
        conftest.pytest_runtest_setup(_Item())
        assert os.environ["RESMON_AI_CLI_DISCOVERY"] == "configured-only"
    os.environ.pop("RESMON_AI_CLI_DISCOVERY")
    conftest.pytest_runtest_setup(_Item())
    assert os.environ["RESMON_AI_CLI_DISCOVERY"] == "configured-only"

    # The marker alone is not enough: a default run selects a test that is
    # not also live_network, and it must stay pinned.
    conftest.pytest_runtest_setup(_Item("needs_agent_cli"))
    assert os.environ["RESMON_AI_CLI_DISCOVERY"] == "configured-only"
    conftest.pytest_runtest_setup(_Item("live_network"))
    assert os.environ["RESMON_AI_CLI_DISCOVERY"] == "configured-only"

    # A test that exists to run the person's own CLI, run on purpose.
    conftest.pytest_runtest_setup(_Item("live_network", "needs_agent_cli"))
    assert "RESMON_AI_CLI_DISCOVERY" not in os.environ

    # Not when the run asked for no network at all.
    monkeypatch.setattr(conftest, "_FORCE_HERMETIC", True)
    conftest.pytest_runtest_setup(_Item("live_network", "needs_agent_cli"))
    assert os.environ["RESMON_AI_CLI_DISCOVERY"] == "configured-only"


# ---------------------------------------------------------------------------
# A real AI command never starts
# ---------------------------------------------------------------------------

def _fake_command(folder: Path, name: str) -> Path:
    """A ``claude`` or ``codex`` that only records that it ran."""
    folder.mkdir(parents=True, exist_ok=True)
    command = folder / name
    command.write_text(f'#!/bin/sh\necho ran >> "{folder / "ran.txt"}"\n')
    command.chmod(0o755)
    return command


def test_a_fake_command_runs(tmp_path):
    fake = _fake_command(tmp_path / "bin", "claude")
    assert subprocess.run([str(fake)], timeout=30).returncode == 0
    assert (tmp_path / "bin" / "ran.txt").read_text() == "ran\n"


def test_a_command_outside_the_fakes_folders_is_refused_before_it_starts(tmp_path, monkeypatch):
    conftest = _loaded_conftest()
    elsewhere = tmp_path / "elsewhere"
    codex = _fake_command(elsewhere, "codex")
    _fake_command(elsewhere, "claude")
    # Stands in for the person's own install: outside every folder fakes live in.
    monkeypatch.setattr(conftest, "_FAKE_COMMAND_ROOTS", (tmp_path / "fakes-only-here",))
    monkeypatch.setenv("PATH", f"{elsewhere}{os.pathsep}/usr/bin{os.pathsep}/bin")
    before = len(conftest._ai_commands_refused)
    try:
        for how in ([str(codex), "exec"], ["claude", "-p", "hi"], "codex login status"):
            with pytest.raises(PermissionError):
                subprocess.run(how, shell=isinstance(how, str), timeout=30)
        assert not (elsewhere / "ran.txt").exists()
        assert conftest._ai_commands_refused[before:] == [str(codex), str(elsewhere / "claude"),
                                                          str(codex)]
        # A test that exists to run the person's own CLI is let through.
        monkeypatch.setitem(conftest._allow_agent_cli, "value", True)
        assert subprocess.run([str(codex)], timeout=30).returncode == 0
        assert (elsewhere / "ran.txt").exists()
    finally:
        del conftest._ai_commands_refused[before:]


_SWALLOWS_THE_REFUSAL = '''
import os, subprocess

def test_catches_the_error():
    try:
        subprocess.run([os.environ["OUTSIDE_COMMAND"]], timeout=30)
    except OSError:
        pass
'''


def test_a_test_that_catches_the_refusal_still_fails(tmp_path):
    """The code under test may catch the error; the test fails at teardown anyway."""
    outside = _fake_command(tmp_path / "outside", "claude")
    child_tmp = tmp_path / "child-tmp"
    child_tmp.mkdir()
    (tmp_path / "run").mkdir()
    (tmp_path / "run" / "test_swallow.py").write_text(_SWALLOWS_THE_REFUSAL)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("RESMON_", "PYTEST_"))}
    env.update({
        # The child's temporary folder is elsewhere, so the command above is
        # outside every folder its fakes may live in.
        "TMPDIR": str(child_tmp),
        "PYTHONPATH": os.pathsep.join([str(CONFTEST.parent), str(CONFTEST.parents[1])]),
        "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
        "OUTSIDE_COMMAND": str(outside),
    })
    done = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-p", "conftest",
         "--rootdir", str(tmp_path / "run"), str(tmp_path / "run" / "test_swallow.py")],
        cwd=tmp_path / "run", env=env, capture_output=True, text=True, timeout=120,
    )
    assert done.returncode == 1, done.stdout[-3000:] + done.stderr[-2000:]
    assert f"This test tried to start {outside}, a real AI command" in done.stdout
    assert "1 passed, 1 error" in done.stdout
    assert not (tmp_path / "outside" / "ran.txt").exists()
