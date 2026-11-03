"""Keyword arguments every child process the engine starts must be given.

A Windows program started from a process that has no console of its own (the
packaged engine has none) is given a new console window unless the caller says
otherwise, and a console flashes on the screen for the life of the child. Every
``subprocess`` call the engine makes passes ``**hidden_window_kwargs()`` so none
of them does. ``test_child_process_windows.py`` fails when a call in
``implementation_scripts/`` or ``resmon_scripts/*.py`` leaves it out.
"""

from __future__ import annotations

import subprocess
import sys
from typing import Any


def hidden_window_kwargs() -> dict[str, Any]:
    """``creationflags=CREATE_NO_WINDOW`` on Windows, and nothing elsewhere."""
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}
