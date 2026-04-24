# resmon_scripts/implementation_scripts/logger.py
"""Logging infrastructure: per-task TaskLogger and application-level rotating logger."""

import logging
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .utils import now_iso


# ---------------------------------------------------------------------------
# Application-level logger
# ---------------------------------------------------------------------------

def setup_app_logger(
    log_dir: Path,
    *,
    name: str = "resmon",
    max_bytes: int = 5 * 1024 * 1024,  # 5 MB
    backup_count: int = 3,
    level: int = logging.INFO,
) -> logging.Logger:
    """Configure and return an application-level logger with a rotating file handler.

    Creates the log directory if it does not exist.
    """
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "resmon.log"

    app_logger = logging.getLogger(name)
    app_logger.setLevel(level)

    # Avoid adding duplicate handlers if called multiple times
    if not any(isinstance(h, RotatingFileHandler) for h in app_logger.handlers):
        handler = RotatingFileHandler(
            str(log_file),
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
        )
        formatter = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        handler.setFormatter(formatter)
        app_logger.addHandler(handler)

    return app_logger


# ---------------------------------------------------------------------------
# Per-task logger
# ---------------------------------------------------------------------------

class TaskLogger:
    """Per-task log writer that produces formatted log.txt files.

    Usage::

        tl = TaskLogger(path, operation_type="deep_dive", params={"query": "test"})
        tl.log("Query started.")
        tl.log("Found 10 results.")
        tl.finalize(status="COMPLETED", stats={"total": 10, "new": 8})
    """

    def __init__(
        self,
        log_path: Path,
        *,
        operation_type: str = "unknown",
        routine_name: str | None = None,
        execution_id: int | None = None,
        params: dict | None = None,
    ) -> None:
        self._path = Path(log_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._start_time = time.monotonic()
        self._start_iso = now_iso()
        self._operation_type = operation_type
        self._entries: list[str] = []

        # Write header
        header_lines = [
            "=== resmon Task Log ===",
            f"Operation Type: {operation_type}",
        ]
        if routine_name:
            header_lines.append(f"Routine Name: {routine_name}")
        if execution_id is not None:
            header_lines.append(f"Execution ID: {execution_id}")
        header_lines.append(f"Start Time: {self._start_iso}")
        if params:
            param_str = ", ".join(f"{k}={v}" for k, v in params.items())
            header_lines.append(f"Parameters: {param_str}")
        header_lines.append("")  # blank line before entries

        self._header = "\n".join(header_lines)

    def log(self, message: str) -> None:
        """Append a timestamped message to the task log."""
        ts = now_iso()
        # Use HH:MM:SS portion for inline timestamps
        short_ts = ts[11:19] if len(ts) >= 19 else ts
        self._entries.append(f"[{short_ts}] {message}")

    def finalize(
        self,
        status: str = "COMPLETED",
        stats: dict | None = None,
    ) -> None:
        """Write the complete log file with header, entries, and footer."""
        end_iso = now_iso()
        elapsed_seconds = time.monotonic() - self._start_time

        # Build footer
        footer_lines = [
            "",
            f"End Time: {end_iso}",
            f"Elapsed Time: {_format_elapsed(elapsed_seconds)}",
            f"Status: {status}",
        ]
        if stats:
            for key, value in stats.items():
                label = key.replace("_", " ").title()
                footer_lines.append(f"{label}: {value}")

        full_text = (
            self._header
            + "\n".join(self._entries)
            + "\n"
            + "\n".join(footer_lines)
            + "\n"
        )
        self._path.write_text(full_text, encoding="utf-8")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _format_elapsed(seconds: float) -> str:
    """Format elapsed seconds into a human-readable string like '1m 45s'."""
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes = int(seconds // 60)
    remaining = int(seconds % 60)
    if minutes < 60:
        return f"{minutes}m {remaining}s"
    hours = minutes // 60
    remaining_min = minutes % 60
    return f"{hours}h {remaining_min}m {remaining}s"
