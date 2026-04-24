# resmon_scripts/implementation_scripts/progress.py
"""Thread-safe in-memory progress event store for execution monitoring."""

import threading
from collections import defaultdict


class ProgressStore:
    """Thread-safe in-memory store for execution progress events.

    Each execution ID has its own lock, event list, cancellation flag, and
    completion status.  The SSE endpoint reads events via ``get_events`` while
    the ``SweepEngine`` background thread writes via ``emit``.
    """

    def __init__(self) -> None:
        self._events: dict[int, list[dict]] = defaultdict(list)
        self._locks: dict[int, threading.Lock] = defaultdict(threading.Lock)
        self._cancel_flags: dict[int, threading.Event] = {}
        self._completed: dict[int, bool] = {}

    # ------------------------------------------------------------------
    # Registration / lifecycle
    # ------------------------------------------------------------------

    def register(self, exec_id: int) -> None:
        """Register a new execution for progress tracking."""
        self._events[exec_id]  # initialize defaultdict entry
        self._cancel_flags[exec_id] = threading.Event()
        self._completed[exec_id] = False

    def mark_complete(self, exec_id: int) -> None:
        """Mark execution as complete (no more events will be emitted)."""
        self._completed[exec_id] = True

    def cleanup(self, exec_id: int) -> None:
        """Remove an execution from the active store (after persisting to DB)."""
        self._events.pop(exec_id, None)
        self._locks.pop(exec_id, None)
        self._cancel_flags.pop(exec_id, None)
        self._completed.pop(exec_id, None)

    # ------------------------------------------------------------------
    # Event emission / retrieval
    # ------------------------------------------------------------------

    def emit(self, exec_id: int, event: dict) -> None:
        """Append a progress event for the given execution (thread-safe)."""
        with self._locks[exec_id]:
            self._events[exec_id].append(event)

    def get_events(self, exec_id: int, since: int = 0) -> list[dict]:
        """Return events for *exec_id* starting from index *since*."""
        with self._locks[exec_id]:
            return list(self._events[exec_id][since:])

    # ------------------------------------------------------------------
    # Status queries
    # ------------------------------------------------------------------

    def is_active(self, exec_id: int) -> bool:
        """Return ``True`` if the execution is registered and not yet complete."""
        return exec_id in self._events and not self._completed.get(exec_id, False)

    def is_registered(self, exec_id: int) -> bool:
        """Return ``True`` if the execution is in the live store (not yet cleaned up)."""
        return exec_id in self._events

    def get_active_ids(self) -> list[int]:
        """Return IDs of all currently active (non-complete) executions."""
        return [eid for eid, done in self._completed.items() if not done]

    # ------------------------------------------------------------------
    # Cooperative cancellation
    # ------------------------------------------------------------------

    def request_cancel(self, exec_id: int) -> None:
        """Set the cancellation flag for the given execution."""
        flag = self._cancel_flags.get(exec_id)
        if flag is not None:
            flag.set()

    def should_cancel(self, exec_id: int) -> bool:
        """Check whether cancellation has been requested."""
        flag = self._cancel_flags.get(exec_id)
        return flag.is_set() if flag else False


# Module-level singleton
progress_store = ProgressStore()
