"""Which install of ``resmon`` answered, and what version it is.

Two installs can be on one machine, and whichever is first on ``PATH`` wins: the
command line that ships inside the app (``resmon.pyz``, run by the app's own
interpreter) and one installed from source (``pipx install ./resmon_scripts/cli``).
The app's build writes ``_build.py`` into the archive it makes, so a command line
that finds it is the app's, and says which app and which version. One installed
from source has no such file.
"""

from __future__ import annotations

import re
from typing import Optional

from resmon_cli import __version__

# Everything up to and including the last ``.app`` folder of a macOS path.
_MAC_BUNDLE = re.compile(r"^(.*\.app)(?:[/\\]|$)", re.IGNORECASE)
# The folder above ``resources`` on Windows, where the bundle is ``<install>\resources\backend``.
_RESOURCES = re.compile(r"^(.*?)[/\\]resources[/\\]backend[/\\]", re.IGNORECASE)
_ARCHIVE = re.compile(r"^(.*?\.pyz)(?:[/\\]|$)", re.IGNORECASE)


def archive_of(package_file: str) -> str:
    """The ``.pyz`` a module was imported from, or the path itself outside one."""
    found = _ARCHIVE.match(package_file)
    return found.group(1) if found else package_file


def app_folder(archive: str) -> str:
    """The app the archive sits in: the ``.app`` bundle, the Windows install folder, or the archive."""
    mac = _MAC_BUNDLE.match(archive)
    if mac:
        return mac.group(1)
    windows = _RESOURCES.match(archive)
    if windows:
        return windows.group(1)
    return archive


def describe(package_file: str, app_version: Optional[str] = None) -> str:
    """The line ``resmon --version`` prints.

    *package_file* is the folder ``resmon_cli`` was imported from. *app_version* is the
    version the app's build wrote into the archive, or ``None`` for an install from
    source.
    """
    if app_version is None:
        return f"resmon {__version__} (installed from source: {package_file})"
    archive = archive_of(package_file)
    folder = app_folder(archive)
    if folder == archive:
        # A copy kept outside the app (the Linux install): not inside it, so it does not say so.
        return f"resmon {app_version} (the resmon app's command line: {archive})"
    return f"resmon {app_version} (the command line inside the resmon app: {folder})"


def app_version() -> Optional[str]:
    """The app version stamped into this archive at build time, or ``None``."""
    try:
        from resmon_cli import _build  # type: ignore[attr-defined]
    except ImportError:
        return None
    return str(_build.APP_VERSION)
