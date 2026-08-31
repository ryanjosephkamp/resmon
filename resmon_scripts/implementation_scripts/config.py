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

# Application metadata
APP_NAME = "resmon"
APP_VERSION = "1.8.1"

# API Client defaults
DEFAULT_REQUEST_TIMEOUT = 30  # seconds
DEFAULT_MAX_RETRIES = 3
DEFAULT_BACKOFF_BASE = 2  # seconds
