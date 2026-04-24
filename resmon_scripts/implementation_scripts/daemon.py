"""resmon-daemon — long-lived headless backend process.

This module is the entry point for the headless daemon that owns the
scheduler and the backend REST API independently of the Electron window.
Responsibilities:

* Acquire a platform-appropriate exclusive lock file so that at most one
  daemon instance runs at a time.
* Write ``{pid, port, version}`` into the lock file so the Electron main
  process can decide whether to attach to a live daemon or spawn a new one.
* Install a SIGTERM/SIGINT handler that cooperatively cancels running
  executions, flushes the APScheduler SQLAlchemy jobstore (when one is
  registered), and closes the shared SQLite connection before exit.

This file is intentionally small; the REST API and database logic live in
``resmon.resmon`` and are reused verbatim via ``create_app()``.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import sys
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Platform-appropriate state directory and lock path
# ---------------------------------------------------------------------------

APP_DIR_NAME = "resmon"
LOCK_FILE_NAME = "daemon.lock"


def state_dir() -> Path:
    """Return the OS-appropriate per-user state directory for resmon.

    * macOS:   ``~/Library/Application Support/resmon``
    * Linux:   ``$XDG_STATE_HOME/resmon`` (falls back to ``~/.local/state/resmon``)
    * Windows: ``%LOCALAPPDATA%\\resmon`` (falls back to ``~\\AppData\\Local\\resmon``)
    """
    override = os.environ.get("RESMON_STATE_DIR")
    if override:
        return Path(override)

    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_DIR_NAME
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_DIR_NAME
    # Linux / other POSIX
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / APP_DIR_NAME


def lock_path() -> Path:
    """Return the absolute path of the daemon lock file."""
    return state_dir() / LOCK_FILE_NAME


# ---------------------------------------------------------------------------
# Daemon lock
# ---------------------------------------------------------------------------


class DaemonLockError(RuntimeError):
    """Raised when the lock file is already held by another live daemon."""


class DaemonLock:
    """Exclusive file lock with embedded ``{pid, port, version}`` metadata.

    Uses ``fcntl.flock`` on POSIX and ``msvcrt.locking`` on Windows. The lock
    file is kept open for the lifetime of the daemon; closing the handle
    releases the lock.
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path: Path = path or lock_path()
        self._fh = None  # type: ignore[assignment]

    def acquire(self, *, pid: int, port: int, version: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Open in read/write, create if missing. Do not truncate yet so that
        # if another process currently holds the lock we do not clobber its
        # metadata before failing.
        fh = open(self.path, "a+")
        try:
            self._platform_lock(fh)
        except DaemonLockError:
            fh.close()
            raise
        # Lock acquired: now it is safe to overwrite the metadata.
        fh.seek(0)
        fh.truncate()
        payload = {
            "pid": int(pid),
            "port": int(port),
            "version": str(version),
            "started_at": datetime.now(timezone.utc).isoformat(),
        }
        fh.write(json.dumps(payload))
        fh.flush()
        try:
            os.fsync(fh.fileno())
        except OSError:
            pass
        self._fh = fh

    def release(self) -> None:
        if self._fh is None:
            return
        try:
            self._platform_unlock(self._fh)
        finally:
            try:
                self._fh.close()
            finally:
                self._fh = None
        # Best-effort cleanup. Safe even if another instance has since
        # re-acquired the lock because that instance re-created its own
        # handle; removing the pathname only unlinks the directory entry.
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass

    # ------------------------------------------------------------------
    # Platform-specific implementations
    # ------------------------------------------------------------------

    @staticmethod
    def _platform_lock(fh) -> None:
        if sys.platform == "win32":
            import msvcrt  # type: ignore[import-not-found]

            try:
                # Lock the first byte, non-blocking.
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise DaemonLockError(
                    f"Another resmon daemon already holds the lock at {fh.name}"
                ) from exc
        else:
            import fcntl

            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (BlockingIOError, OSError) as exc:
                raise DaemonLockError(
                    f"Another resmon daemon already holds the lock at {fh.name}"
                ) from exc

    @staticmethod
    def _platform_unlock(fh) -> None:
        try:
            if sys.platform == "win32":
                import msvcrt  # type: ignore[import-not-found]

                fh.seek(0)
                try:
                    msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            else:
                import fcntl

                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        except Exception:
            pass


@contextmanager
def daemon_lock(*, pid: int, port: int, version: str, path: Optional[Path] = None) -> Iterator[DaemonLock]:
    lock = DaemonLock(path=path)
    lock.acquire(pid=pid, port=port, version=version)
    try:
        yield lock
    finally:
        lock.release()


def read_lock(path: Optional[Path] = None) -> Optional[dict]:
    """Return the parsed lock-file payload, or ``None`` if unreadable/missing."""
    p = path or lock_path()
    try:
        raw = p.read_text(encoding="utf-8").strip()
    except (FileNotFoundError, OSError):
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data


# ---------------------------------------------------------------------------
# Shutdown coordination
# ---------------------------------------------------------------------------


# Scheduler registration hook. When a scheduler is instantiated inside the
# daemon it should call ``register_scheduler(scheduler)`` so the signal
# handler can flush the jobstore on exit. This keeps daemon.py decoupled
# from the scheduler module itself.

_registered_scheduler = None  # type: ignore[var-annotated]
_shutdown_lock = threading.Lock()
_shutdown_done = False


def register_scheduler(scheduler) -> None:  # type: ignore[no-untyped-def]
    """Register a live scheduler so its jobstore is flushed on shutdown."""
    global _registered_scheduler
    _registered_scheduler = scheduler


def perform_graceful_shutdown(reason: str = "daemon_restart") -> dict:
    """Run the shutdown sequence exactly once.

    Returns a dict summarizing the shutdown for logging/testing.
    """
    global _shutdown_done
    with _shutdown_lock:
        if _shutdown_done:
            return {"already_shut_down": True}
        _shutdown_done = True

    summary = {"flushed_executions": 0, "scheduler_shutdown": False, "db_closed": False}

    # 1. Flush any `running` executions to `failed` with the cancel_reason.
    try:
        # Imported lazily so daemon.py is importable without a DB.
        from resmon import flush_running_executions, close_db  # type: ignore
        summary["flushed_executions"] = flush_running_executions(reason=reason)
    except Exception as exc:
        logger.exception("flush_running_executions failed: %s", exc)

    # 2. Shut the scheduler down (best effort).
    if _registered_scheduler is not None:
        try:
            _registered_scheduler.shutdown()
            summary["scheduler_shutdown"] = True
        except Exception as exc:
            logger.exception("scheduler shutdown failed: %s", exc)

    # 3. Close the shared DB connection.
    try:
        from resmon import close_db  # type: ignore
        close_db()
        summary["db_closed"] = True
    except Exception as exc:
        logger.exception("close_db failed: %s", exc)

    return summary


def install_signal_handlers(on_shutdown: Optional[Callable[[], None]] = None) -> None:
    """Install SIGTERM/SIGINT handlers that invoke the shutdown sequence."""

    def _handler(signum, _frame):  # type: ignore[no-untyped-def]
        logger.info("resmon-daemon received signal %s; shutting down", signum)
        try:
            perform_graceful_shutdown(reason="daemon_restart")
        finally:
            if on_shutdown is not None:
                try:
                    on_shutdown()
                except Exception:
                    logger.exception("on_shutdown callback raised")

    signal.signal(signal.SIGTERM, _handler)
    signal.signal(signal.SIGINT, _handler)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _parse_port(argv: list[str], default: int = 8742) -> int:
    for arg in argv[1:]:
        if arg.startswith("--port="):
            return int(arg.split("=", 1)[1])
        if arg.isdigit():
            return int(arg)
    env = os.environ.get("RESMON_DAEMON_PORT")
    if env and env.isdigit():
        return int(env)
    return default


def run(argv: Optional[list[str]] = None) -> int:
    """Run the daemon. Blocks until uvicorn exits. Returns an exit code."""
    argv = list(argv) if argv is not None else list(sys.argv)
    port = _parse_port(argv)

    # Ensure ``resmon_scripts`` is on sys.path so ``import resmon`` works when
    # daemon.py is invoked as ``python -m implementation_scripts.daemon`` from
    # any cwd.
    pkg_parent = Path(__file__).resolve().parent.parent
    if str(pkg_parent) not in sys.path:
        sys.path.insert(0, str(pkg_parent))

    import uvicorn  # local import — daemon may be imported from tests without uvicorn configured
    from resmon import create_app  # type: ignore
    from implementation_scripts.config import APP_NAME, APP_VERSION  # type: ignore

    try:
        with daemon_lock(pid=os.getpid(), port=port, version=APP_VERSION):
            app = create_app()
            install_signal_handlers()
            logger.info("%s daemon v%s listening on 127.0.0.1:%d (pid=%d)",
                        APP_NAME, APP_VERSION, port, os.getpid())
            config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="info")
            server = uvicorn.Server(config)
            try:
                server.run()
            finally:
                perform_graceful_shutdown(reason="daemon_restart")
    except DaemonLockError as exc:
        print(f"resmon-daemon: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
