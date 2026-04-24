"""Service-unit rendering and install/uninstall for the resmon-daemon.

Responsibilities:

* Render the platform-appropriate template (launchd plist on macOS,
  ``systemd --user`` unit on Linux, Task Scheduler XML on Windows).
* Write it to the platform-appropriate user-scoped location and (best-effort)
  register it with the OS service manager so the daemon starts at login.
* Remove the unit on uninstall and (best-effort) deregister it.

The OS-native registration step (``launchctl bootstrap``, ``systemctl --user
enable``, ``schtasks /Create``) is invoked only when ``register=True`` is
passed. Tests pass ``register=False`` so only file-system effects are
exercised, which keeps the verification suite hermetic.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "service_units"


def _resmon_scripts_dir() -> Path:
    """Directory containing resmon.py (used as WorkingDirectory in units)."""
    return Path(__file__).resolve().parent.parent


def _log_dir() -> Path:
    from .daemon import state_dir

    d = state_dir() / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def default_python() -> str:
    """Absolute path to the current Python interpreter."""
    return sys.executable or shutil.which("python3") or "python3"


def default_port() -> int:
    env = os.environ.get("RESMON_DAEMON_PORT")
    if env and env.isdigit():
        return int(env)
    return 8742


# ---------------------------------------------------------------------------
# Per-platform install paths
# ---------------------------------------------------------------------------


def unit_path() -> Path:
    """Return the absolute install path of the unit for the current OS.

    Honors ``RESMON_SERVICE_UNIT_DIR`` if set (used by tests).
    """
    override = os.environ.get("RESMON_SERVICE_UNIT_DIR")
    if override:
        base = Path(override)
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "LaunchAgents"
    elif sys.platform == "win32":
        base = Path.home() / "AppData" / "Local" / "resmon" / "service_units"
    else:
        # Linux / other POSIX: per-user systemd unit path.
        xdg = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
        base = Path(xdg) / "systemd" / "user"

    if sys.platform == "darwin":
        return base / "com.resmon.daemon.plist"
    if sys.platform == "win32":
        return base / "resmon-daemon.task.xml"
    return base / "resmon-daemon.service"


def template_path() -> Path:
    if sys.platform == "darwin":
        return TEMPLATES_DIR / "com.resmon.daemon.plist"
    if sys.platform == "win32":
        return TEMPLATES_DIR / "resmon-daemon.task.xml"
    return TEMPLATES_DIR / "resmon-daemon.service"


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

REQUIRED_PLACEHOLDERS = ("{{PYTHON}}", "{{PORT}}", "{{WORKDIR}}", "{{LOG_DIR}}")


def render_template(
    *,
    python: Optional[str] = None,
    port: Optional[int] = None,
    workdir: Optional[Path] = None,
    log_dir: Optional[Path] = None,
    template: Optional[Path] = None,
) -> str:
    """Render the platform-appropriate unit template to a string.

    Every ``{{NAME}}`` placeholder in the template is substituted. It is a
    programming error to leave any placeholder unresolved, so the function
    asserts that none remain.
    """
    src = template or template_path()
    raw = src.read_text(encoding="utf-8")
    mapping = {
        "{{PYTHON}}": python or default_python(),
        "{{PORT}}": str(port if port is not None else default_port()),
        "{{WORKDIR}}": str(workdir or _resmon_scripts_dir()),
        "{{LOG_DIR}}": str(log_dir or _log_dir()),
    }
    out = raw
    for placeholder, value in mapping.items():
        out = out.replace(placeholder, value)
    # Safety: the task.xml template does not use {{LOG_DIR}}; that is fine.
    # But no required placeholder should leak through unresolved.
    leftover = [p for p in REQUIRED_PLACEHOLDERS if p in out]
    assert not leftover, f"Unresolved placeholders in rendered unit: {leftover}"
    return out


# ---------------------------------------------------------------------------
# Install / uninstall
# ---------------------------------------------------------------------------


def install(
    *,
    python: Optional[str] = None,
    port: Optional[int] = None,
    workdir: Optional[Path] = None,
    log_dir: Optional[Path] = None,
    register: bool = False,
) -> Path:
    """Render the unit and write it to ``unit_path()``.

    If ``register`` is True, additionally try to register the unit with the
    OS service manager (``launchctl``, ``systemctl --user``, or
    ``schtasks``). Registration failures are surfaced as ``RuntimeError``.
    """
    target = unit_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    rendered = render_template(python=python, port=port, workdir=workdir, log_dir=log_dir)
    target.write_text(rendered, encoding="utf-8")
    try:
        os.chmod(target, 0o644)
    except OSError:
        pass

    if register:
        _register_with_os(target)
    return target


def uninstall(*, deregister: bool = False) -> bool:
    """Remove the unit file. Returns True if a file was removed.

    If ``deregister`` is True, first attempt to deregister with the OS
    service manager.
    """
    target = unit_path()
    if deregister and target.exists():
        try:
            _deregister_with_os(target)
        except Exception:
            # Best effort: log but still attempt to remove the file.
            pass
    if target.exists():
        target.unlink()
        return True
    return False


def is_installed() -> bool:
    return unit_path().exists()


# ---------------------------------------------------------------------------
# OS registration (best-effort, never called from tests)
# ---------------------------------------------------------------------------


def _register_with_os(path: Path) -> None:
    if sys.platform == "darwin":
        # ``launchctl bootstrap`` is the modern API; fall back to ``load`` on
        # macOS versions that still accept it.
        uid = os.getuid()
        cmds = [
            ["launchctl", "bootstrap", f"gui/{uid}", str(path)],
            ["launchctl", "load", str(path)],
        ]
        _run_first_successful(cmds, "launchctl register")
        return
    if sys.platform == "win32":
        _run([
            "schtasks", "/Create", "/TN", "resmon-daemon",
            "/XML", str(path), "/F",
        ], "schtasks /Create")
        return
    # Linux / systemd --user
    _run(["systemctl", "--user", "daemon-reload"], "systemctl daemon-reload")
    _run(["systemctl", "--user", "enable", "--now", path.name], "systemctl enable")


def _deregister_with_os(path: Path) -> None:
    if sys.platform == "darwin":
        uid = os.getuid()
        cmds = [
            ["launchctl", "bootout", f"gui/{uid}", str(path)],
            ["launchctl", "unload", str(path)],
        ]
        _run_first_successful(cmds, "launchctl deregister")
        return
    if sys.platform == "win32":
        _run(["schtasks", "/Delete", "/TN", "resmon-daemon", "/F"], "schtasks /Delete")
        return
    _run(["systemctl", "--user", "disable", "--now", path.name], "systemctl disable")
    _run(["systemctl", "--user", "daemon-reload"], "systemctl daemon-reload")


def _run(cmd: list[str], label: str) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"{label} failed (exit {result.returncode}): {result.stderr.strip() or result.stdout.strip()}"
        )


def _run_first_successful(cmds: list[list[str]], label: str) -> None:
    last_err: Optional[str] = None
    for cmd in cmds:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return
        last_err = result.stderr.strip() or result.stdout.strip()
    raise RuntimeError(f"{label} failed: {last_err}")
