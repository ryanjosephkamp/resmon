# resmon_scripts/implementation_scripts/ai_cli.py
"""Finding the agent CLI a subscription lane drives.

The subscription lane runs the CLI the user already installed and logged into,
so AI work draws on the Claude Max or ChatGPT plan they already pay for instead
of a metered API key. Before it can run anything it has to find the binary, and
that is harder than it looks in a packaged desktop app.

**PATH is the wrong place to look first, and this is measured rather than
assumed.** ``launchctl getenv PATH`` is unset on a stock macOS install, so a
Finder-launched app inherits the minimal default ``/usr/bin:/bin:/usr/sbin:/sbin``
— which contains neither binary. On the machine this was written on, ``claude``
lives under ``~/.local/bin`` (a symlink into ``~/.local/share/claude/versions/``)
and ``codex`` lives *inside an application bundle* at
``/Applications/ChatGPT.app/Contents/Resources/codex``, where it will never be on
anyone's PATH. Both are found instantly from a terminal and neither is found from
a double-clicked app.

That asymmetry is exactly the shape of the 1.6.0 bug — an environment assumption
that held in development and broke on shipped machines — so the order is:

1. **An explicit path** the user set in Settings. Always wins; it is the escape
   hatch for every layout this table does not know.
2. **Known install locations** for the platform.
3. **PATH**, last, because it is the least likely to work where it matters.

The result says which of the three found it. "Found on PATH" and "found where the
installer puts it" are different facts, and a user debugging a lane that works in
one launch mode and not the other needs to be told which.
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

__all__ = [
    "CLIDiscovery",
    "SUPPORTED_CLI_PROVIDERS",
    "discover_cli",
    "known_locations",
]

SUPPORTED_CLI_PROVIDERS = ("claude_code", "codex")

# The executable name to look for on PATH, per provider.
_BINARY_NAMES = {
    "claude_code": "claude",
    "codex": "codex",
}

# Known install locations, per platform, most likely first.
#
# Honesty about provenance, because these are load-bearing and a wrong entry is
# invisible until someone's lane silently falls through to the next one:
#
#   VERIFIED   — observed on the macOS machine this was developed on.
#   INFERRED   — the documented or conventional location for that platform,
#                not verified on real hardware here. Cross-platform verification
#                is an open item; the explicit-path setting covers the gap in
#                the meantime, which is why it is first in the order.
#
# `~` is expanded at lookup time. Missing entries are skipped, not errors.
_KNOWN_LOCATIONS: dict[str, dict[str, tuple[str, ...]]] = {
    "darwin": {
        "claude_code": (
            "~/.local/bin/claude",                 # VERIFIED — installer prefix
            "/opt/homebrew/bin/claude",            # INFERRED — Apple-silicon brew
            "/usr/local/bin/claude",               # INFERRED — Intel brew
        ),
        "codex": (
            # VERIFIED — the ChatGPT desktop app ships codex-cli inside its
            # bundle. Never on PATH, which is the whole reason this table exists.
            "/Applications/ChatGPT.app/Contents/Resources/codex",
            "~/Applications/ChatGPT.app/Contents/Resources/codex",  # INFERRED
            "/opt/homebrew/bin/codex",             # INFERRED
            "/usr/local/bin/codex",                # INFERRED
        ),
    },
    "linux": {
        "claude_code": (
            "~/.local/bin/claude",                 # INFERRED — same installer
            "/usr/local/bin/claude",               # INFERRED
        ),
        "codex": (
            "~/.local/bin/codex",                  # INFERRED
            "/usr/local/bin/codex",                # INFERRED
        ),
    },
    "win32": {
        "claude_code": (
            r"~\AppData\Local\Programs\claude\claude.exe",   # INFERRED
            r"~\.local\bin\claude.exe",                      # INFERRED
        ),
        "codex": (
            r"~\AppData\Local\Programs\ChatGPT\resources\codex.exe",  # INFERRED
            r"~\.local\bin\codex.exe",                               # INFERRED
        ),
    },
}


@dataclass(frozen=True)
class CLIDiscovery:
    """Where a provider's CLI was found, and how — or that it was not.

    ``how`` is one of ``configured`` / ``known-location`` / ``path`` /
    ``not-found``. ``tried`` lists every candidate examined, so the UI can show
    the user what was looked at rather than only that the search failed.
    """

    provider: str
    path: Optional[str]
    how: str
    tried: tuple[str, ...] = ()

    @property
    def found(self) -> bool:
        return self.path is not None

    def describe(self) -> str:
        """One sentence, for the interface and for an error report."""
        if not self.found:
            return (
                f"No {_BINARY_NAMES.get(self.provider, self.provider)} executable "
                f"was found. Set its full path in Settings if it is installed "
                f"somewhere this list does not cover."
            )
        if self.how == "configured":
            return f"Using the path you set: {self.path}"
        if self.how == "known-location":
            return f"Found where the installer puts it: {self.path}"
        return (
            f"Found on PATH: {self.path}. Note that a packaged app launched from "
            f"the Finder inherits a much smaller PATH than a terminal does, so "
            f"set the full path in Settings if this lane works in one and not "
            f"the other."
        )

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "path": self.path,
            "how": self.how,
            "found": self.found,
            "tried": list(self.tried),
            "detail": self.describe(),
        }


def known_locations(provider: str, platform: Optional[str] = None) -> tuple[str, ...]:
    """The candidate paths for *provider* on *platform* (default: this one)."""
    key = platform or sys.platform
    # Any Linux-ish platform that is not macOS or Windows gets the linux table;
    # a wrong guess here costs one failed stat, not a wrong answer.
    table = _KNOWN_LOCATIONS.get(key) or _KNOWN_LOCATIONS["linux"]
    return table.get(provider, ())


def _usable(candidate: Path) -> bool:
    """True when *candidate* is a file resmon may execute.

    ``os.access`` rather than a mode-bit check so the answer reflects this
    process's actual permissions. A path that exists but is not executable is
    not a find — reporting it as one would send the user off debugging the CLI
    instead of the permission.
    """
    try:
        return candidate.is_file() and os.access(candidate, os.X_OK)
    except OSError:
        return False


def discover_cli(
    provider: str,
    explicit_path: Optional[str] = None,
    *,
    platform: Optional[str] = None,
) -> CLIDiscovery:
    """Locate the CLI for *provider*. Never raises; never runs the binary.

    Finding the file does not establish that the CLI is installed correctly or
    that anyone is logged into it. Those are separate failures with their own
    error kinds (``CLI_MISSING`` and ``CLI_AUTH``), discovered when it is run.
    """
    provider = (provider or "").strip().lower()
    tried: list[str] = []

    if provider not in SUPPORTED_CLI_PROVIDERS:
        return CLIDiscovery(provider=provider, path=None, how="not-found")

    # 1. What the user told us. An explicit path that does not work is reported
    #    as not-found rather than quietly skipped -- silently falling through to
    #    a different binary than the one they named would be worse than failing.
    if explicit_path and explicit_path.strip():
        candidate = Path(explicit_path.strip()).expanduser()
        tried.append(str(candidate))
        if _usable(candidate):
            return CLIDiscovery(provider, str(candidate), "configured", tuple(tried))
        logger.info(
            "Configured %s CLI path is not an executable file: %s",
            provider, candidate,
        )
        return CLIDiscovery(provider, None, "not-found", tuple(tried))

    # 2. Where the installers put it.
    for raw in known_locations(provider, platform):
        candidate = Path(raw).expanduser()
        tried.append(str(candidate))
        if _usable(candidate):
            return CLIDiscovery(provider, str(candidate), "known-location", tuple(tried))

    # 3. PATH, last.
    binary = _BINARY_NAMES[provider]
    found = shutil.which(binary)
    tried.append(f"PATH ({binary})")
    if found:
        return CLIDiscovery(provider, found, "path", tuple(tried))

    return CLIDiscovery(provider, None, "not-found", tuple(tried))
