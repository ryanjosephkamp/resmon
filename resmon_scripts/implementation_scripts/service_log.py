"""Size-capped logs for the background service.

launchd and ``systemd --user`` open the service's ``StandardOutPath`` /
``StandardErrorPath`` (``StandardOutput=append:``) once, hand the descriptors
to the process, and never rotate them. Neither offers rotation for a user
agent: launchd's ``newsyslog`` needs root, and systemd only rotates its own
journal. So the files grew for as long as the service lived. One user's
``resmon-daemon.err.log`` reached 231 MB, most of it 166,736 copies of one
"Too many open files" traceback from an episode nobody could date, because
nothing in the file carried a time.

The service therefore rotates its own output. Every ``CHECK_SECONDS`` it looks
at the size of the file behind standard output and standard error and, past
``max_bytes``, moves it aside and points the descriptor at a fresh file at the
same path. The path is read from the descriptor itself, so a unit installed by
an older resmon -- which knows nothing of this -- is covered too, and the logs
stay exactly where the unit says they are.

* **POSIX** (launchd, systemd): the file is renamed to ``.1`` and a new one is
  opened and ``dup2``-ed onto the descriptor. Nothing is lost: the rename
  happens under the descriptor, which keeps writing to the renamed file until
  the ``dup2``.
* **Windows**: Task Scheduler gives the process no output at all, so the unit
  passes ``--log-dir`` and the service opens its own files there. An open file
  cannot be renamed on Windows, so it is copied to ``.1`` and truncated; the
  file is opened for append, so the next write lands at the start. Lines
  written between the copy and the truncate are lost, which is a window of
  microseconds once every ``max_bytes``.

A rotated file more than twice ``max_bytes`` -- the 231 MB one, on the first
start of a resmon that rotates, or a storm of tracebacks between two checks --
keeps only its last ``max_bytes``, cut at a line boundary, and says how much it
dropped. The most recent lines are the ones a bug report needs. An ordinary
rotation, a little past the cap, keeps every line.

Every new file starts with a UTC timestamped line saying where the earlier
lines went, and the service writes a timestamped line when it starts, so a
log always says when it was written even where its tracebacks do not.
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# 5 MB a file and two older copies: at most 15 MB for each of the two streams.
# The error log of a healthy service grows by kilobytes a day; the output log
# carries uvicorn's access lines, about 44 MB over six months on the machine
# that measured it. 5 MB of either is weeks of history.
DEFAULT_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_BACKUPS = 2
CHECK_SECONDS = 60.0

# Lets a test exercise rotation on a real service process without writing
# megabytes first. Not a user setting.
MAX_BYTES_ENV = "RESMON_SERVICE_LOG_MAX_BYTES"

STREAM_NAMES = {1: "out", 2: "err"}


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fd_path(fd: int) -> Optional[Path]:
    """The regular file behind ``fd``, or ``None`` for a pipe, terminal or socket.

    A service whose output goes to the journal, a pipe or ``/dev/null`` has
    nothing to rotate, and that is the answer for any descriptor whose path
    cannot be read.
    """
    try:
        import stat

        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
    except OSError:
        return None
    try:
        if sys.platform == "darwin":
            import fcntl

            raw = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024))
            return Path(os.fsdecode(raw.split(b"\0", 1)[0]))
        if sys.platform.startswith("linux"):
            target = os.readlink(f"/proc/self/fd/{fd}")
            # A file deleted while open reads as "path (deleted)"; rotating it
            # would recreate a file the user removed.
            return None if target.endswith(" (deleted)") else Path(target)
    except (OSError, AttributeError, ValueError):
        return None
    return None


def _trim_to_tail(path: Path, max_bytes: int) -> None:
    """Keep only the last ``max_bytes`` of ``path``, starting at a whole line."""
    try:
        size = path.stat().st_size
    except OSError:
        return
    if size <= max_bytes:
        return
    tmp = path.with_name(path.name + ".trim")
    try:
        with open(path, "rb") as src:
            src.seek(size - max_bytes)
            tail = src.read()
        cut = tail.find(b"\n")
        if 0 <= cut < len(tail) - 1:
            tail = tail[cut + 1:]
        header = (
            f"{_utc_now()} resmon-daemon: the {size - len(tail):,} bytes before "
            f"this line were dropped when the log was rotated\n"
        ).encode("utf-8")
        with open(tmp, "wb") as dst:
            dst.write(header)
            dst.write(tail)
        os.replace(tmp, path)
    except OSError:
        logger.warning("could not trim rotated log %s", path, exc_info=True)
        try:
            tmp.unlink()
        except OSError:
            pass


@dataclass
class _Stream:
    fds: list[int]
    path: Path
    owned: bool  # True where this process opened the file (Windows)


class ServiceLog:
    """The service's output files, and the rotation that keeps them bounded."""

    def __init__(
        self,
        streams: list[_Stream],
        *,
        max_bytes: int = DEFAULT_MAX_BYTES,
        backups: int = DEFAULT_BACKUPS,
        copy_truncate: Optional[bool] = None,
    ) -> None:
        self.streams = streams
        self.max_bytes = max(1, int(max_bytes))
        self.backups = max(1, int(backups))
        self.copy_truncate = (
            sys.platform == "win32" if copy_truncate is None else copy_truncate
        )
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    @property
    def paths(self) -> list[Path]:
        return [s.path for s in self.streams]

    def rotate_if_needed(self) -> list[Path]:
        """Rotate every stream past ``max_bytes``; return the paths rotated."""
        rotated = []
        with self._lock:
            for stream in self.streams:
                try:
                    size = os.fstat(stream.fds[0]).st_size
                except OSError:
                    continue
                if size > self.max_bytes and self._rotate(stream):
                    rotated.append(stream.path)
        return rotated

    def _backup(self, n: int, path: Path) -> Path:
        return path.with_name(f"{path.name}.{n}")

    def _rotate(self, stream: _Stream) -> bool:
        path = stream.path
        for sink in (sys.stdout, sys.stderr):
            try:
                if sink is not None:
                    sink.flush()
            except (OSError, ValueError):
                pass
        try:
            for n in range(self.backups - 1, 0, -1):
                older = self._backup(n, path)
                if older.exists():
                    os.replace(older, self._backup(n + 1, path))
            first = self._backup(1, path)
            if self.copy_truncate:
                shutil.copyfile(path, first)
                os.ftruncate(stream.fds[0], 0)
            else:
                os.replace(path, first)
                fresh = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
                try:
                    for fd in stream.fds:
                        os.dup2(fresh, fd)
                finally:
                    os.close(fresh)
        except OSError:
            # A failed rotation leaves the stream writing where it was. The
            # warning goes to that same stream, which is the one place a
            # person reading this log will look.
            logger.warning("could not rotate service log %s", path, exc_info=True)
            return False
        try:
            oversized = first.stat().st_size > 2 * self.max_bytes
        except OSError:
            oversized = False
        if oversized:
            _trim_to_tail(first, self.max_bytes)
        marker = (
            f"{_utc_now()} resmon-daemon: log rotated; earlier lines are in "
            f"{first.name}\n"
        ).encode("utf-8")
        try:
            os.write(stream.fds[0], marker)
        except OSError:
            pass
        return True

    def start(self, interval: float = CHECK_SECONDS) -> None:
        """Rotate now if needed, then check every ``interval`` seconds."""
        self.rotate_if_needed()
        if self._thread is not None:
            return

        def _watch() -> None:
            while not self._stop.wait(interval):
                try:
                    self.rotate_if_needed()
                except Exception:  # never let the watcher take the service down
                    logger.debug("service log check raised", exc_info=True)

        self._thread = threading.Thread(
            target=_watch, daemon=True, name="service-log-rotation",
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None


def _open_owned(fd: int, path: Path) -> None:
    """Point ``fd`` at ``path``, opened for append, and rebuild the Python stream.

    Under Task Scheduler a Python process may start with no usable standard
    streams at all (``sys.stdout`` is ``None``), so the stream object is made
    afresh rather than flushed and reused.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fresh = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.dup2(fresh, fd)
    finally:
        os.close(fresh)
    stream = open(  # noqa: SIM115 - lives as long as the process
        fd, "w", buffering=1, encoding="utf-8", errors="backslashreplace",
        closefd=False,
    )
    if fd == 1:
        sys.stdout = stream
    elif fd == 2:
        sys.stderr = stream


def attach(
    log_dir: Optional[Path] = None,
    *,
    max_bytes: Optional[int] = None,
    backups: int = DEFAULT_BACKUPS,
) -> Optional[ServiceLog]:
    """Find (or, given ``log_dir``, open) the files behind stdout and stderr.

    Returns ``None`` when neither stream is a file this process can rotate,
    which is the case for a service whose output goes to a pipe or the
    journal, and for any process started from a terminal.
    """
    if max_bytes is None:
        raw = os.environ.get(MAX_BYTES_ENV, "")
        max_bytes = int(raw) if raw.isdigit() and int(raw) > 0 else DEFAULT_MAX_BYTES

    streams: list[_Stream] = []
    for fd, name in STREAM_NAMES.items():
        path = _fd_path(fd)
        owned = False
        if path is None and log_dir is not None:
            path = Path(log_dir) / f"resmon-daemon.{name}.log"
            try:
                _open_owned(fd, path)
                owned = True
            except OSError:
                logger.warning("could not open service log %s", path, exc_info=True)
                continue
        if path is None:
            continue
        # systemd may send both streams to one file; rotate it once and move
        # both descriptors.
        for existing in streams:
            try:
                if os.path.samestat(os.fstat(existing.fds[0]), os.fstat(fd)):
                    existing.fds.append(fd)
                    break
            except OSError:
                pass
        else:
            streams.append(_Stream(fds=[fd], path=path, owned=owned))

    if not streams:
        return None
    return ServiceLog(streams, max_bytes=max_bytes, backups=backups)
