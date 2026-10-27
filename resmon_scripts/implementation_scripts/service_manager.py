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
from xml.sax.saxutils import escape as xml_escape

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

REQUIRED_PLACEHOLDERS = (
    "{{PYTHON}}", "{{PORT}}", "{{WORKDIR}}", "{{LOG_DIR}}", "{{STATE_ARGS}}",
)

# The variables that say where a backend keeps its state, and the daemon flag
# that carries each one into a service.
#
# A packaged app's Electron main process sets both on the backend it spawns,
# pointing them at the per-user state directory, because the bundle is replaced
# on every update. A service unit is started by the OS, not by Electron, so it
# inherits neither. Before this, a service installed from the packaged app ran
# the bundled daemon with config.py's checkout-relative defaults: a database
# and a reports folder *inside the app bundle*, empty, and wiped by the next
# update. The app then attached to it, because it was the same version, and
# showed that empty database in place of the user's own. Measured on 2.3.0:
# the rendered plist named no database, and the bundled interpreter resolved
# DEFAULT_DB_PATH to ``resmon.app/Contents/Resources/backend/resmon.db``.
#
# Flags rather than environment entries because Task Scheduler's Exec action
# has no environment, and one mechanism on all three platforms is one thing to
# test. A dev checkout's backend sets neither variable, so its unit carries no
# flags and its daemon keeps the checkout database, as before.
STATE_ARGUMENTS = (
    ("RESMON_DB_PATH", "--db-path"),
    ("RESMON_REPORTS_DIR", "--reports-dir"),
)


def state_arguments(environ: Optional[dict[str, str]] = None) -> list[str]:
    """``--flag=path`` for each state variable set in ``environ``.

    Paths are made absolute here, because the daemon's working directory is the
    unit's ``WorkingDirectory``, not the installing process's.
    """
    env = os.environ if environ is None else environ
    args = []
    for variable, flag in STATE_ARGUMENTS:
        value = env.get(variable)
        if value:
            args.append(f"{flag}={os.path.abspath(value)}")
    return args


def _format_state_args(args: list[str], template: Path) -> str:
    """Render daemon arguments in the syntax of the template they go into.

    A packaged app's state directory has a space in it on macOS
    (``Application Support``), so each format has to keep a path one argument.
    """
    if template.name.endswith(".plist"):
        # One <string> per argument; launchd passes each one whole.
        return "".join(f"\n        <string>{xml_escape(a)}</string>" for a in args)
    if template.name.endswith(".service"):
        # systemd splits ExecStart on spaces unless quoted, expands % specifiers
        # and $VARIABLES, and reads backslash escapes inside quotes.
        def quote(a: str) -> str:
            a = a.replace("\\", "\\\\").replace('"', '\\"')
            return '"' + a.replace("%", "%%").replace("$", "$$") + '"'
        return "".join(" " + quote(a) for a in args)
    # Task Scheduler: one command-line string, split by the usual Windows rules.
    # A Windows path cannot contain a double quote, so quoting is enough.
    return "".join(" " + xml_escape(f'"{a}"') for a in args)


def render_template(
    *,
    python: Optional[str] = None,
    port: Optional[int] = None,
    workdir: Optional[Path] = None,
    log_dir: Optional[Path] = None,
    template: Optional[Path] = None,
    state_args: Optional[list[str]] = None,
) -> str:
    """Render the platform-appropriate unit template to a string.

    Every ``{{NAME}}`` placeholder in the template is substituted. It is a
    programming error to leave any placeholder unresolved, so the function
    asserts that none remain. ``state_args`` defaults to the installing
    process's own state, from ``state_arguments()``.
    """
    src = template or template_path()
    raw = src.read_text(encoding="utf-8")
    resolved_log_dir = str(log_dir or _log_dir())
    args = list(state_arguments() if state_args is None else state_args)
    if src.name.endswith(".xml"):
        # Task Scheduler's Exec action cannot redirect output, so the service
        # opens its own log files there; launchd and systemd open them from
        # the unit's {{LOG_DIR}} lines instead (see ``service_log``).
        args.append(f"--log-dir={resolved_log_dir}")
    mapping = {
        "{{PYTHON}}": python or default_python(),
        "{{PORT}}": str(port if port is not None else default_port()),
        "{{WORKDIR}}": str(workdir or _resmon_scripts_dir()),
        "{{LOG_DIR}}": resolved_log_dir,
        "{{STATE_ARGS}}": _format_state_args(args, src),
    }
    out = raw
    for placeholder, value in mapping.items():
        out = out.replace(placeholder, value)
    # The task.xml template has no {{LOG_DIR}} line; its log directory travels
    # in the arguments above. No required placeholder may leak through.
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


# ``launchctl``, ``systemctl --user`` and ``schtasks`` are all reachable from
# the POST /api/service/install and /uninstall endpoints, so an unbounded call
# here blocks an HTTP request - and the ASGI worker thread serving it - for as
# long as the OS takes. A wedged systemd user session is enough. The other
# subprocess sites in this codebase already bound themselves (desktop_notifier
# at 5 s, report_exporter at 180 s); these two were the exception.
_SERVICE_CMD_TIMEOUT_SEC = 30.0


def _run(cmd: list[str], label: str) -> None:
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=_SERVICE_CMD_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"{label} timed out after {_SERVICE_CMD_TIMEOUT_SEC:.0f}s "
            f"(command: {' '.join(cmd)})"
        ) from None
    if result.returncode != 0:
        raise RuntimeError(
            f"{label} failed (exit {result.returncode}): {result.stderr.strip() or result.stdout.strip()}"
        )


def _run_first_successful(cmds: list[list[str]], label: str) -> None:
    last_err: Optional[str] = None
    for cmd in cmds:
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=_SERVICE_CMD_TIMEOUT_SEC,
            )
        except subprocess.TimeoutExpired:
            last_err = f"timed out after {_SERVICE_CMD_TIMEOUT_SEC:.0f}s"
            continue
        if result.returncode == 0:
            return
        last_err = result.stderr.strip() or result.stdout.strip()
    raise RuntimeError(f"{label} failed: {last_err}")
