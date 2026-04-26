# resmon_scripts/implementation_scripts/config.py
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = PROJECT_ROOT / "resmon_scripts"
IMPL_DIR = SCRIPTS_DIR / "implementation_scripts"
VERIFY_DIR = SCRIPTS_DIR / "verification_scripts"
EXPERIMENTS_DIR = PROJECT_ROOT / "resmon_experiments"
REPORTS_DIR = PROJECT_ROOT / "resmon_reports"
PRINTOUTS_DIR = PROJECT_ROOT / "resmon_printouts"

# Database
DEFAULT_DB_PATH = PROJECT_ROOT / "resmon.db"

# Application metadata
APP_NAME = "resmon"
APP_VERSION = "1.1.0"

# API Client defaults
DEFAULT_REQUEST_TIMEOUT = 30  # seconds
DEFAULT_MAX_RETRIES = 3
DEFAULT_BACKOFF_BASE = 2  # seconds
