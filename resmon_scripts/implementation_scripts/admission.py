"""Execution admission controller for manual and routine-fired executions.

Implements ADQ-R3 from resmon_routines.md: a single global semaphore gates
concurrent executions. Past the cap, a routine fire and a manual run (a Deep
Dive, a Deep Sweep, a restart, a run asked for again) both wait in one bounded
FIFO queue that drains as slots free; only when the queue is full too is a
manual run refused (the REST layer answers 429).

Thread-safety: all public methods take ``_lock`` while mutating state.
Queue drains spawn a fresh daemon thread per dispatch so the call site that
triggered ``note_finished`` (typically a pipeline thread's ``finally``) is
never blocked by a second pipeline starting.

A queued fire is handed to the dispatcher as ``dispatcher(routine_id,
params_json, run_now=..., queued_at=...)``: ``run_now`` says a person asked for
this run (Run now), so it runs even if the routine is paused, and
``queued_at`` is when the fire joined the queue, which for a scheduled fire is
when it came due.

A queued manual run carries its own ``start``, which prepares and launches it.
Its slot is **reserved** when it is drained: a placeholder (a negative id) is
counted as active until the run's own id takes its place
(``release_reservation``), so a search asked in that moment cannot take the
slot the waiting run was given.
"""

from __future__ import annotations

import itertools
import logging
import threading
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Literal, Optional

#: What ``admit_routine`` decided: started now, waiting in the queue for a
#: slot, or turned away because the queue was full too.
RoutineAdmission = Literal["admitted", "queued", "dropped"]

#: What ``admit_manual`` decided: start now, wait in the queue, or refused
#: because the queue is full too.
ManualAdmission = Literal["admitted", "queued", "full"]


@dataclass
class _Waiting:
    """One run in the queue: a routine's fire, or a manual run.

    ``ticket`` names the entry: a manual run's is the ``request_id`` it was
    submitted with (or one made for it), which its execution row carries once
    it starts, so whoever submitted it can find the run it became. ``info`` is
    what the queue's readers are shown about a manual run (its kind and its
    search), and ``start`` is what runs it, handed its slot's reservation.
    """

    routine_id: Optional[int]
    params_json: str
    run_now: bool
    queued_at: str
    ticket: str = field(default_factory=lambda: uuid.uuid4().hex)
    kind: Literal["routine", "manual"] = "routine"
    info: dict = field(default_factory=dict)
    start: Optional[Callable[[int], None]] = None

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
        self._queue: deque[_Waiting] = deque()
        self._lock = threading.Lock()
        self._dispatcher: Optional[Callable[..., None]] = None
        # Placeholders for drained manual runs, below every real id.
        self._reservations = itertools.count(-1, -1)

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

    def set_dispatcher(self, fn: Optional[Callable[..., None]]) -> None:
        """Install the routine-fire dispatcher used when draining the queue.

        Until something installs one, a queued fire is never started: the
        drain in ``note_finished`` needs it. resmon.py installs it at startup
        in every process, the scheduler's or not, because Run now queues too.
        """
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
        dropped with a warning and False is returned. ``admit_routine`` says
        which of the two happened.

        When admission succeeds and ``exec_id`` is provided, the id is
        recorded as active immediately. Otherwise the caller is expected to
        call ``note_admitted(exec_id)`` once the id becomes known (e.g.,
        after ``SweepEngine.prepare_execution``).
        """
        if kind == "routine":
            return self.admit_routine(
                -1 if routine_id is None else int(routine_id), params_json or "",
                exec_id=exec_id,
            ) == "admitted"
        with self._lock:
            if len(self._active) < self._max:
                if exec_id is not None:
                    self._active.add(int(exec_id))
                return True
            # Manual rejection — caller surfaces 429.
            return False

    def admit_routine(
        self,
        routine_id: int,
        params_json: str,
        *,
        run_now: bool = False,
        exec_id: Optional[int] = None,
    ) -> RoutineAdmission:
        """Start a routine fire now, queue it for the next free slot, or drop it.

        The answer is the caller's to repeat, and the three are different
        sentences: a Run now that was queued *will* run, and telling the person
        to wait and try again (which ``try_admit``'s bare False once became)
        sends them to start a second one.

        A Run now for a routine already waiting in the queue joins that entry
        rather than queueing the routine twice, and marks it as asked for, so
        it runs even if the routine is paused.
        """
        rid = int(routine_id)
        with self._lock:
            if len(self._active) < self._max:
                if exec_id is not None:
                    self._active.add(int(exec_id))
                return "admitted"
            if run_now:
                for waiting in self._queue:
                    if waiting.kind == "routine" and waiting.routine_id == rid:
                        waiting.run_now = True
                        return "queued"
            if len(self._queue) < self._queue_limit:
                self._queue.append(_Waiting(
                    rid, params_json or "", run_now,
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ))
                logger.info(
                    "Admission at its cap; queued routine_id=%s (depth=%d)",
                    rid, len(self._queue),
                )
                return "queued"
            logger.warning(
                "Admission queue overflow: dropping routine_id=%s "
                "(active=%d, queue=%d/%d)",
                rid, len(self._active), len(self._queue), self._queue_limit,
            )
            return "dropped"

    def queue_position(self, routine_id: int) -> Optional[int]:
        """Where a routine's queued fire stands, 1 for next; None when not queued."""
        with self._lock:
            for at, waiting in enumerate(self._queue, start=1):
                if waiting.kind == "routine" and waiting.routine_id == int(routine_id):
                    return at
        return None

    def admit_manual(
        self, ticket: str, start: Callable[[int], None], info: Optional[dict] = None,
    ) -> ManualAdmission:
        """Start a manual run now, queue it for the next free slot, or refuse it.

        ``admitted`` is the caller's to start at once, as a manual run always
        started: its slot is claimed by ``note_admitted`` on its own thread.
        ``queued`` means ``start`` will be called with a reservation when a
        slot frees, in the order it joined. ``full`` means the queue holds as
        many as it allows, and nothing was queued.
        """
        with self._lock:
            if len(self._active) < self._max:
                return "admitted"
            if len(self._queue) < self._queue_limit:
                self._queue.append(_Waiting(
                    None, "", True,
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    ticket=str(ticket), kind="manual", info=dict(info or {}), start=start,
                ))
                logger.info("Admission at its cap; queued a manual run (depth=%d)", len(self._queue))
                return "queued"
            return "full"

    def ticket_position(self, ticket: str) -> Optional[int]:
        """Where the queued run with this ticket stands, 1 for next; None when not queued."""
        with self._lock:
            for at, waiting in enumerate(self._queue, start=1):
                if waiting.ticket == ticket:
                    return at
        return None

    def withdraw(self, ticket: str) -> Optional[str]:
        """Take a queued run out of the queue, by its ticket.

        Returns the kind of what was withdrawn (``manual``), ``routine`` for a
        routine's fire, which is left where it is (a watch's run is stopped
        by pausing the watch), or None when nothing with that ticket waits.
        """
        with self._lock:
            for waiting in self._queue:
                if waiting.ticket != ticket:
                    continue
                if waiting.kind != "manual":
                    return "routine"
                self._queue.remove(waiting)
                return "manual"
        return None

    def waiting(self) -> list[dict]:
        """What waits in the queue, in order: each entry's kind, place, and what it is.

        A plain copy, read under the lock; ``start`` is never handed out.
        """
        with self._lock:
            return [
                {
                    "ticket": waiting.ticket,
                    "kind": "watch" if waiting.kind == "routine" else "manual",
                    "position": at,
                    "queued_at": waiting.queued_at,
                    "routine_id": waiting.routine_id,
                    "run_now": waiting.run_now if waiting.kind == "routine" else None,
                    **waiting.info,
                }
                for at, waiting in enumerate(self._queue, start=1)
            ]

    def release_reservation(self, token: int) -> None:
        """A drained manual run's own id is active now: drop its placeholder, draining nothing.

        Its slot is still taken, by the run, so nothing new may start for it.
        A token not held (already released) is ignored.
        """
        with self._lock:
            self._active.discard(int(token))

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
        drained: Optional[_Waiting] = None
        dispatcher: Optional[Callable[..., None]] = None
        reservation: Optional[int] = None
        with self._lock:
            was_active = int(exec_id) in self._active
            self._active.discard(int(exec_id))
            if was_active and self._queue and len(self._active) < self._max:
                # A manual run brings its own start; a routine fire needs the
                # dispatcher, and waits for one where none is installed yet.
                if self._queue[0].kind == "manual":
                    drained = self._queue.popleft()
                    reservation = next(self._reservations)
                    self._active.add(reservation)
                elif self._dispatcher is not None:
                    drained = self._queue.popleft()
                    dispatcher = self._dispatcher

        if drained is not None:
            self._hand_over(drained, dispatcher, reservation)

    def _hand_over(
        self, drained: _Waiting, dispatcher: Optional[Callable[..., None]], reservation: Optional[int],
    ) -> None:
        """Start a drained run on a fresh daemon thread, so the caller never waits on it."""
        if drained.kind == "manual":
            threading.Thread(
                target=self._safe_start, args=(drained, reservation),
                daemon=True, name=f"admission-drain-manual-{drained.ticket[:8]}",
            ).start()
        elif dispatcher is not None:
            threading.Thread(
                target=self._safe_dispatch,
                args=(dispatcher, drained),
                daemon=True,
                name=f"admission-drain-routine-{drained.routine_id}",
            ).start()

    def _safe_start(self, waiting: _Waiting, reservation: Optional[int]) -> None:
        """Run a drained manual run's ``start``; on failure give its slot back, which drains the next."""
        try:
            assert waiting.start is not None
            waiting.start(int(reservation) if reservation is not None else 0)
        except Exception:
            logger.exception("Queued manual run %s could not start", waiting.ticket)
            if reservation is not None:
                self.note_finished(reservation)

    @staticmethod
    def _safe_dispatch(dispatcher: Callable[..., None], waiting: _Waiting) -> None:
        try:
            dispatcher(waiting.routine_id, waiting.params_json,
                       run_now=waiting.run_now, queued_at=waiting.queued_at)
        except Exception:
            logger.exception("Queued routine dispatch raised for routine_id=%s", waiting.routine_id)

    def drain_queue(self, dispatch_fn: Callable[..., None]) -> None:
        """Synchronously drain every currently-queued fire.

        Intended for tests and explicit administrative triggers. Respects
        the active cap: stops as soon as no slot is free. Each dispatch
        runs on a daemon thread for symmetry with ``note_finished``.
        """
        while True:
            reservation: Optional[int] = None
            with self._lock:
                if not self._queue or len(self._active) >= self._max:
                    return
                waiting = self._queue.popleft()
                if waiting.kind == "manual":
                    reservation = next(self._reservations)
                    self._active.add(reservation)
            self._hand_over(waiting, dispatch_fn, reservation)


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
            f"Watch {routine_id} is already running"
            + (f" as run {execution_id}." if execution_id is not None
               else ".")
        )


class RoutineFireWaiting(Exception):
    """A fire admission did not start now: ``queued`` for the next free slot,
    or ``dropped`` because the queue was full too.

    Raised by the dispatcher only for a caller that asked to be told (Run now),
    because "it is queued and will run" and "it was turned away" ask different
    things of the person who clicked.
    """

    def __init__(self, routine_id: int, decision: RoutineAdmission) -> None:
        self.routine_id = int(routine_id)
        self.decision = decision
        super().__init__(f"Watch {routine_id} was {decision}, not started.")


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
    noticed. ``SessionBus.try_open`` in ``assistant_runtime`` guards assistant
    turns the same way; this is that shape.

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
