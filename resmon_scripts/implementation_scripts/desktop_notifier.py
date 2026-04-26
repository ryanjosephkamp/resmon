"""Cross-platform desktop notification dispatcher.

Posts an OS-level notification on macOS, Linux, and Windows using only
the Python standard library plus per-platform tools that ship with the
operating system (``osascript`` on macOS, ``notify-send`` on Linux,
PowerShell + WinRT on Windows). No third-party Python packages are
required, so the headless daemon path can fire notifications without
adding install-time dependencies.

This module is intentionally side-effect-light: every call is wrapped
in ``try/except``, returns a boolean, and never raises. Callers that
fail to notify must not abort the surrounding execution.

Routine completions are dispatched from the headless-daemon path
(``resmon.py::_launch_execution``) so that notifications fire even when
the Electron renderer is not running. Manual runs reach this code path
too, providing a backend safety net for the in-renderer browser
``Notification`` API.

Tests stub ``_run`` so they exercise routing logic without spawning
real subprocesses.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from typing import List, Optional

logger = logging.getLogger(__name__)

# Per-call timeout (seconds) for the subprocess invocation. Notifications
# are user-facing fire-and-forget; we never want a hung helper to block
# execution completion.
_SUBPROCESS_TIMEOUT_SEC = 5.0


def _run(cmd: List[str], *, env: Optional[dict] = None) -> bool:
    """Run a notifier command. Returns True on exit code 0."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=_SUBPROCESS_TIMEOUT_SEC,
            env=env,
            check=False,
        )
        if result.returncode != 0:
            logger.debug(
                "Notifier exited %s: stderr=%r",
                result.returncode,
                (result.stderr or "")[:200],
            )
            return False
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        logger.debug("Notifier subprocess failed: %s", exc)
        return False
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("Notifier subprocess raised: %s", exc)
        return False


def _escape_applescript(value: str) -> str:
    """Escape a string for safe interpolation inside an AppleScript literal."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _escape_powershell(value: str) -> str:
    """Escape a string for safe interpolation inside a PowerShell literal."""
    # PowerShell single-quoted strings escape single quotes by doubling them.
    return value.replace("'", "''")


def _notify_macos(title: str, body: str) -> bool:
    if not shutil.which("osascript"):
        return False
    safe_title = _escape_applescript(title)
    safe_body = _escape_applescript(body)
    script = f'display notification "{safe_body}" with title "{safe_title}"'
    return _run(["osascript", "-e", script])


def _linux_env() -> dict:
    """Return an env dict with DBUS_SESSION_BUS_ADDRESS injected if missing.

    ``systemd --user`` services typically inherit the user's DBus session
    address, but a defensive default of ``/run/user/<uid>/bus`` is set
    when the variable is absent so ``notify-send`` can reach the user's
    session bus.
    """
    env = os.environ.copy()
    if "DBUS_SESSION_BUS_ADDRESS" not in env:
        try:
            uid = os.getuid()  # type: ignore[attr-defined]
            candidate = f"/run/user/{uid}/bus"
            if os.path.exists(candidate):
                env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={candidate}"
        except Exception:
            pass
    return env


def _notify_linux(title: str, body: str) -> bool:
    if not shutil.which("notify-send"):
        return False
    return _run(
        ["notify-send", "--app-name=resmon", title, body],
        env=_linux_env(),
    )


def _notify_windows(title: str, body: str) -> bool:
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        return False
    safe_title = _escape_powershell(title)
    safe_body = _escape_powershell(body)
    # WinRT toast via PowerShell. Available on Windows 10+ without any
    # additional modules (uses built-in Windows.UI.Notifications classes).
    script = (
        "[Windows.UI.Notifications.ToastNotificationManager,"
        "Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null;"
        "$template = "
        "[Windows.UI.Notifications.ToastNotificationManager]"
        "::GetTemplateContent("
        "[Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
        f"$template.GetElementsByTagName('text')[0].InnerText = '{safe_title}';"
        f"$template.GetElementsByTagName('text')[1].InnerText = '{safe_body}';"
        "$toast = [Windows.UI.Notifications.ToastNotification]::new($template);"
        "[Windows.UI.Notifications.ToastNotificationManager]"
        "::CreateToastNotifier('resmon').Show($toast);"
    )
    return _run([powershell, "-NoProfile", "-Command", script])


def is_supported() -> bool:
    """Return True if the current OS has a known notification backend."""
    if sys.platform == "darwin":
        return shutil.which("osascript") is not None
    if sys.platform == "win32":
        return (
            shutil.which("powershell.exe") is not None
            or shutil.which("powershell") is not None
        )
    if sys.platform.startswith("linux"):
        return shutil.which("notify-send") is not None
    return False


def notify(title: str, body: str) -> bool:
    """Post a desktop notification. Returns True on success.

    Never raises. Failure modes (helper missing, helper non-zero exit,
    sandboxed environment without GUI access) all result in ``False``
    and a debug log line.
    """
    if not isinstance(title, str) or not isinstance(body, str):
        return False
    title = title.strip() or "resmon"
    body = body.strip()
    if sys.platform == "darwin":
        return _notify_macos(title, body)
    if sys.platform == "win32":
        return _notify_windows(title, body)
    if sys.platform.startswith("linux"):
        return _notify_linux(title, body)
    return False
