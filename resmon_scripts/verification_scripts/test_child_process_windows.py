"""Every child process the engine starts is started without a console window.

On Windows a console program started by a process that has no console of its own
gets a new one, and it stays on the screen as long as the child runs. The packaged
engine has no console, so a map fit, a PDF worker, an AI command line, or a
``schtasks`` call that forgot ``creationflags=CREATE_NO_WINDOW`` flashes a black
window at the person. ``implementation_scripts/child_process.py`` returns the
keyword arguments for that, and these cases fail when a call does not pass them.

The scan is syntactic: it covers ``implementation_scripts/*.py`` and
``resmon_scripts/*.py``, finds every call that starts a process (``subprocess``'s
own functions under any import alias, ``os.system``, ``os.popen``, and the
``os.spawn*`` family), and requires ``**hidden_window_kwargs()`` among its
arguments. A function that takes a runner as a parameter whose default is a
``subprocess`` function (so a test can replace it) is held to the same rule where
it calls that parameter.
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent.parent
SCANNED = sorted([*SCRIPTS.glob("*.py"), *(SCRIPTS / "implementation_scripts").glob("*.py")])

SPAWNERS = {"Popen", "run", "call", "check_call", "check_output", "getoutput", "getstatusoutput"}
OS_SPAWNERS = {"system", "popen"}
HELPER = "hidden_window_kwargs"

# The helper builds the flag itself; it is the one place that names it.
EXEMPT = {"child_process.py"}


def _splats_helper(call: ast.Call) -> bool:
    for keyword in call.keywords:
        value = keyword.value
        if (keyword.arg is None and isinstance(value, ast.Call)
                and isinstance(value.func, (ast.Name, ast.Attribute))
                and getattr(value.func, "id", getattr(value.func, "attr", None)) == HELPER):
            return True
    return False


def _aliases(tree: ast.AST) -> tuple[set[str], set[str], set[str]]:
    """Names bound to the ``subprocess`` module, to the ``os`` module, and to a spawner."""
    subprocess_names, os_names, spawner_names = set(), set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "subprocess":
                    subprocess_names.add(alias.asname or "subprocess")
                elif alias.name == "os":
                    os_names.add(alias.asname or "os")
        elif isinstance(node, ast.ImportFrom) and node.module == "subprocess":
            for alias in node.names:
                if alias.name in SPAWNERS:
                    spawner_names.add(alias.asname or alias.name)
    return subprocess_names, os_names, spawner_names


def _is_spawner_reference(node: ast.AST, subprocess_names: set[str], spawner_names: set[str]) -> bool:
    if isinstance(node, ast.Attribute):
        return (isinstance(node.value, ast.Name) and node.value.id in subprocess_names
                and node.attr in SPAWNERS)
    return isinstance(node, ast.Name) and node.id in spawner_names


def violations(source: str, filename: str = "<source>") -> list[str]:
    """Each call in *source* that starts a process without the helper, as ``file:line``."""
    tree = ast.parse(source, filename)
    subprocess_names, os_names, spawner_names = _aliases(tree)
    found: list[str] = []

    def starts_process(call: ast.Call, runners: set[str]) -> bool:
        func = call.func
        if _is_spawner_reference(func, subprocess_names, spawner_names):
            return True
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in os_names:
            return (func.attr in OS_SPAWNERS or func.attr.startswith(("spawn", "exec"))
                    or func.attr in {"startfile", "posix_spawn", "posix_spawnp"})
        return isinstance(func, ast.Name) and func.id in runners

    def visit(node: ast.AST, runners: set[str]) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = node.args
            positional = [*args.posonlyargs, *args.args]
            defaults = [None] * (len(positional) - len(args.defaults)) + list(args.defaults)
            pairs = list(zip(positional, defaults)) + list(zip(args.kwonlyargs, args.kw_defaults))
            runners = runners | {a.arg for a, d in pairs
                                 if d is not None and _is_spawner_reference(d, subprocess_names, spawner_names)}
        if isinstance(node, ast.Call) and starts_process(node, runners) and not _splats_helper(node):
            found.append(f"{filename}:{node.lineno}")
        for child in ast.iter_child_nodes(node):
            visit(child, runners)

    visit(tree, set())
    return found


@pytest.mark.parametrize("path", SCANNED, ids=lambda p: p.name)
def test_every_child_process_is_started_without_a_console_window(path):
    if path.name in EXEMPT:
        pytest.skip("the helper itself")
    found = violations(path.read_text(encoding="utf-8"), path.name)
    assert not found, (
        "these calls start a process without `**hidden_window_kwargs()` "
        "(from implementation_scripts.child_process), so on Windows each opens a console window: "
        + ", ".join(found)
    )


def test_the_scan_sees_the_calls_it_is_meant_to_police():
    """A scan that finds nothing to check passes by being blind, so count what it covers."""
    sites = 0
    for path in SCANNED:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        names, _, spawners = _aliases(tree)
        sites += sum(1 for n in ast.walk(tree)
                     if isinstance(n, ast.Call) and _is_spawner_reference(n.func, names, spawners))
    assert sites >= 12


@pytest.mark.parametrize("source", [
    "import subprocess\nsubprocess.run(['x'])\n",
    "import subprocess as sp\nsp.Popen(['x'])\n",
    "from subprocess import check_output\ncheck_output(['x'])\n",
    "import os\nos.system('x')\n",
    "import subprocess\ndef f(run=subprocess.run):\n    run(['x'])\n",
    "import subprocess\nsubprocess.run(['x'], **other())\n",
])
def test_the_scan_catches_a_call_without_the_helper(source):
    assert len(violations(source)) == 1


@pytest.mark.parametrize("source", [
    "import subprocess\nsubprocess.run(['x'], **hidden_window_kwargs())\n",
    "import subprocess\nsubprocess.Popen(['x'], **child_process.hidden_window_kwargs())\n",
    "import subprocess\ndef f(run=subprocess.run):\n    run(['x'], **hidden_window_kwargs())\n",
    "import subprocess\nx = subprocess.PIPE\nsubprocess.list2cmdline(['x'])\n",
])
def test_the_scan_accepts_a_call_with_the_helper(source):
    assert violations(source) == []


def test_the_helper_asks_for_no_window_on_windows_only(monkeypatch):
    from implementation_scripts import child_process

    monkeypatch.setattr(sys, "platform", "linux")
    assert child_process.hidden_window_kwargs() == {}
    monkeypatch.setattr(sys, "platform", "darwin")
    assert child_process.hidden_window_kwargs() == {}
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    assert child_process.hidden_window_kwargs() == {"creationflags": 0x08000000}
