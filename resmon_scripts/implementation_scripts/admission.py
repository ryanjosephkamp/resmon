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

        **Idempotent, and the drain is the half that had to be made so.**
        Releasing the slot always was -- ``discard`` on a set does not care
        whether the id is there. The drain did not: a second call for an id
        already released would find the queue non-empty and the active count
        still below the cap, because a fire dispatched a moment earlier does
        not join ``_active`` until *its* thread reaches ``note_admitted``, and
        would hand out a second fire for one freed slot. That matters now that
        the execution worker calls this from two nested ``finally`` blocks --
        the pipeline's own, and the outer one that covers the statements before
        the pipeline's ``try`` -- so the ordinary path calls it twice. A drain
        therefore happens only when this call is the one that actually removed
        the id.
        """
        drained: Optional[Tuple[int, str]] = None
        dispatcher: Optional[Callable[[int, str], None]] = None
        with self._lock:
            was_active = int(exec_id) in self._active
            self._active.discard(int(exec_id))
            if (
                was_active
                and self._queue
                and len(self._active) < self._max
                and self._dispatcher is not None
            ):
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


class RoutineAlreadyRunning(Exception):
    """One routine, one run. Carries the execution id that holds the claim.

    Raised by the dispatcher only where a caller asked to be told -- the
    scheduler's own callback treats a held claim as a fire to log and skip,
    because a scheduled fire arriving while the previous one is still going is
    an ordinary Tuesday, not an error anyone needs to see as a traceback.
    """

    def __init__(self, routine_id: int, execution_id: Optional[int]) -> None:
        self.routine_id = int(routine_id)
        self.execution_id = execution_id
        super().__init__(
            f"Routine {routine_id} is already running"
            + (f" as execution {execution_id}." if execution_id is not None
               else ".")
        )


class RoutineClaimRegistry:
    """One claim per routine id, taken before the worker thread starts.

    **Why a claim and not a query.** The obvious guard is
    ``SELECT 1 FROM executions WHERE routine_id = ? AND status = 'running'``,
    and it is wrong twice over. It is wrong late: the row does not exist until
    ``prepare_execution`` writes it, so two fires a millisecond apart both see
    nothing and both start. And it is wrong long after: a backend that was
    SIGKILLed leaves ``running`` rows behind that no process owns, and until the
    next start reconciles them (schema 19) that query would refuse every fire of
    the routine forever -- a crash on Monday silencing a routine until somebody
    noticed. ``SessionBus.try_open`` in ``assistant_runtime`` learned the same
    lesson about assistant turns; this is that shape.

    **What the claim is, exactly.** An entry in this process's memory, held from
    before the execution thread starts until that thread's ``finally``. It is
    therefore a statement about *this* backend and no other, and it does not
    survive the process -- which is the honest answer to the crash case rather
    than a defect: a claim held by a process that no longer exists is not
    evidence that anything is running, and resmon is a desktop app where one
    backend owns the scheduler (``RESMON_DISABLE_SCHEDULER`` keeps the
    renderer-spawned fallback out of it). The durable half of the question --
    what happened to the *rows* a dead backend left behind -- is schema 19's
    startup reconciliation, and it is not duplicated here.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # routine_id -> execution id, or None between the claim and the moment
        # the execution row exists. "Claimed, id not known yet" is a real state
        # and conflating it with "not claimed" is the window this class closes.
        self._claims: dict[int, Optional[int]] = {}

    def try_claim(self, routine_id: int) -> bool:
        """Claim a routine for one run. False when it is already claimed."""
        with self._lock:
            rid = int(routine_id)
            if rid in self._claims:
                return False
            self._claims[rid] = None
            return True

    def bind(self, routine_id: int, exec_id: int) -> None:
        """Name the execution holding the claim, once its row exists."""
        with self._lock:
            rid = int(routine_id)
            if rid in self._claims:
                self._claims[rid] = int(exec_id)

    def holder(self, routine_id: int) -> Optional[int]:
        """The execution id holding the claim, or None.

        ``None`` is ambiguous on purpose -- not claimed, or claimed a moment ago
        by a fire whose row does not exist yet -- so callers ask
        ``is_claimed`` when the question is whether to refuse.
        """
        with self._lock:
            return self._claims.get(int(routine_id))

    def is_claimed(self, routine_id: int) -> bool:
        with self._lock:
            return int(routine_id) in self._claims

    def release(self, routine_id: int) -> None:
        """Release the claim. Idempotent; safe from a ``finally``."""
        with self._lock:
            self._claims.pop(int(routine_id), None)

    def claimed_routines(self) -> dict[int, Optional[int]]:
        with self._lock:
            return dict(self._claims)


# Module-level singleton, beside ``admission`` because they gate the same door:
# ``admission`` answers "has resmon room for another execution at all", and this
# answers "is *this* routine already running".
routine_claims = RoutineClaimRegistry()


# Module-level singleton. resmon.py hydrates ``_max`` / ``_queue_limit`` from
# app_settings at FastAPI startup and mutates them via PUT /api/settings/execution.
admission = ExecutionAdmissionController()
