"""Execution admission controller for manual and routine-fired executions.

Implements ADQ-R3 from resmon_routines.md: a single global semaphore gates
concurrent executions. Manual admission is reject-or-pass (the REST layer
raises HTTP 429); routine admission falls through to a bounded FIFO queue
that drains as slots free.

Thread-safety: all public methods take ``_lock`` while mutating state.
Queue drains spawn a fresh daemon thread per dispatch so the call site that
triggered ``note_finished`` (typically a pipeline thread's ``finally``) is
never blocked by a second pipeline starting.
"""

from __future__ import annotations

import logging
import threading
from collections import deque
from typing import Callable, Literal, Optional, Tuple

logger = logging.getLogger(__name__)

DEFAULT_MAX_CONCURRENT = 3
DEFAULT_QUEUE_LIMIT = 16
_MIN_MAX = 1
_MAX_MAX = 8
_MIN_QUEUE_LIMIT = 1
_MAX_QUEUE_LIMIT = 64


class ExecutionAdmissionController:
    """Gate on concurrent execution count and queue overflowing routine fires."""

    def __init__(
        self,
        max_concurrent: int = DEFAULT_MAX_CONCURRENT,
        queue_limit: int = DEFAULT_QUEUE_LIMIT,
    ) -> None:
        self._max = self._clamp_max(max_concurrent)
        self._queue_limit = self._clamp_queue_limit(queue_limit)
        self._active: set[int] = set()
        self._queue: deque[Tuple[int, str]] = deque()
        self._lock = threading.Lock()
        self._dispatcher: Optional[Callable[[int, str], None]] = None

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------

    @staticmethod
    def _clamp_max(n: int) -> int:
        n = int(n)
        if n < _MIN_MAX:
            return _MIN_MAX
        if n > _MAX_MAX:
            return _MAX_MAX
        return n

    @staticmethod
    def _clamp_queue_limit(n: int) -> int:
        n = int(n)
        if n < _MIN_QUEUE_LIMIT:
            return _MIN_QUEUE_LIMIT
        if n > _MAX_QUEUE_LIMIT:
            return _MAX_QUEUE_LIMIT
        return n

    def set_max(self, n: int) -> None:
        """Update the concurrent-execution cap. Applies to subsequent admit decisions."""
        with self._lock:
            self._max = self._clamp_max(n)

    def set_queue_limit(self, n: int) -> None:
        with self._lock:
            self._queue_limit = self._clamp_queue_limit(n)

    def max(self) -> int:
        with self._lock:
            return self._max

    def queue_limit(self) -> int:
        with self._lock:
            return self._queue_limit

    def current_active(self) -> int:
        with self._lock:
            return len(self._active)

    def queue_depth(self) -> int:
        with self._lock:
            return len(self._queue)

    def set_dispatcher(self, fn: Optional[Callable[[int, str], None]]) -> None:
        """Install the routine-fire dispatcher used when draining the queue."""
        with self._lock:
            self._dispatcher = fn

    # ------------------------------------------------------------------
    # Admission
    # ------------------------------------------------------------------

    def try_admit(
        self,
        *,
        kind: Literal["manual", "routine"],
        exec_id: Optional[int] = None,
        routine_id: Optional[int] = None,
        params_json: Optional[str] = None,
    ) -> bool:
        """Decide whether a new execution may start.

        For ``kind="manual"``, returns True iff a slot is free. The REST
        layer raises HTTP 429 when False; there is no enqueue.

        For ``kind="routine"``, returns True iff a slot is free. If no slot
        is free and the queue has room, the fire is enqueued for later drain
        and False is returned. If the queue is also full, the fire is
        dropped with a warning and False is returned.

        When admission succeeds and ``exec_id`` is provided, the id is
        recorded as active immediately. Otherwise the caller is expected to
        call ``note_admitted(exec_id)`` once the id becomes known (e.g.,
        after ``SweepEngine.prepare_execution``).
        """
        with self._lock:
            if len(self._active) < self._max:
                if exec_id is not None:
                    self._active.add(int(exec_id))
                return True

            if kind == "routine":
                if len(self._queue) < self._queue_limit:
                    rid = int(routine_id) if routine_id is not None else -1
                    self._queue.append((rid, params_json or ""))
                    logger.info(
                        "Admission queue full for manual cap; enqueued routine_id=%s (depth=%d)",
                        rid,
                        len(self._queue),
                    )
                    return False
                logger.warning(
                    "Admission queue overflow: dropping routine_id=%s "
                    "(active=%d, queue=%d/%d)",
                    routine_id,
                    len(self._active),
                    len(self._queue),
                    self._queue_limit,
                )
                return False

            # Manual rejection — caller surfaces 429.
            return False

    def note_admitted(self, exec_id: int) -> None:
        """Record a freshly-known exec_id as active. Idempotent."""
        with self._lock:
            self._active.add(int(exec_id))

    def note_finished(self, exec_id: int) -> None:
        """Release a slot and drain one queued routine fire if available.

        The drained fire is dispatched on a fresh daemon thread so the
        calling pipeline's ``finally`` never waits on a second pipeline.
        """
        drained: Optional[Tuple[int, str]] = None
        dispatcher: Optional[Callable[[int, str], None]] = None
        with self._lock:
            self._active.discard(int(exec_id))
            if self._queue and len(self._active) < self._max and self._dispatcher is not None:
                drained = self._queue.popleft()
                dispatcher = self._dispatcher

        if drained is not None and dispatcher is not None:
            routine_id, params_json = drained
            threading.Thread(
                target=self._safe_dispatch,
                args=(dispatcher, routine_id, params_json),
                daemon=True,
                name=f"admission-drain-routine-{routine_id}",
            ).start()

    @staticmethod
    def _safe_dispatch(
        dispatcher: Callable[[int, str], None], routine_id: int, params_json: str
    ) -> None:
        try:
            dispatcher(routine_id, params_json)
        except Exception:
            logger.exception("Queued routine dispatch raised for routine_id=%s", routine_id)

    def drain_queue(self, dispatch_fn: Callable[[int, str], None]) -> None:
        """Synchronously drain every currently-queued fire.

        Intended for tests and explicit administrative triggers. Respects
        the active cap: stops as soon as no slot is free. Each dispatch
        runs on a daemon thread for symmetry with ``note_finished``.
        """
        while True:
            with self._lock:
                if not self._queue or len(self._active) >= self._max:
                    return
                routine_id, params_json = self._queue.popleft()
            threading.Thread(
                target=self._safe_dispatch,
                args=(dispatch_fn, routine_id, params_json),
                daemon=True,
                name=f"admission-drain-routine-{routine_id}",
            ).start()


# Module-level singleton. resmon.py hydrates ``_max`` / ``_queue_limit`` from
# app_settings at FastAPI startup and mutates them via PUT /api/settings/execution.
admission = ExecutionAdmissionController()
