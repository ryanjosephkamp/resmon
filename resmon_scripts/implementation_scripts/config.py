# resmon_scripts/implementation_scripts/config.py
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = PROJECT_ROOT / "resmon_scripts"
IMPL_DIR = SCRIPTS_DIR / "implementation_scripts"
VERIFY_DIR = SCRIPTS_DIR / "verification_scripts"
EXPERIMENTS_DIR = PROJECT_ROOT / "resmon_experiments"

# State locations. Checkout-relative by default, overridable for a packaged
# app, whose bundle is replaced wholesale on update (and may even run from a
# read-only translocated path under Gatekeeper) — Electron main points these
# at ~/Library/Application Support/resmon (or the platform equivalent).
REPORTS_DIR = Path(os.environ.get("RESMON_REPORTS_DIR") or PROJECT_ROOT / "resmon_reports")
PRINTOUTS_DIR = PROJECT_ROOT / "resmon_printouts"

# Database
DEFAULT_DB_PATH = Path(os.environ.get("RESMON_DB_PATH") or PROJECT_ROOT / "resmon.db")

# The port the running backend is actually listening on, written at startup and
# removed at shutdown.
#
# The MCP server needs it. It talks to the backend over 127.0.0.1, and the
# default port is only a guess: a user can run the packaged app and a dev build
# at the same time, and the dev launcher deliberately uses its own port and its
# own state directory so it never attaches to the daemon. Guessing 8742 in that
# situation connects a harness to whichever process happens to hold the port,
# which is worse than failing.
#
# It lives beside the database because that is the truest "state directory" —
# RESMON_DB_PATH is what Electron repoints at Application Support, so the port
# file follows the state it describes rather than the checkout it was launched
# from.
PORT_FILE = Path(
    os.environ.get("RESMON_PORT_FILE") or DEFAULT_DB_PATH.parent / "resmon.port"
)

# Application metadata
APP_NAME = "resmon"
APP_VERSION = "1.8.3"

# API Client defaults
DEFAULT_REQUEST_TIMEOUT = 30  # seconds
DEFAULT_MAX_RETRIES = 3
DEFAULT_BACKOFF_BASE = 2  # seconds
