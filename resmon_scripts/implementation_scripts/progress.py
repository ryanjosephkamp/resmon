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
        # Executions past their last cancellation check, and the lock that
        # makes "a stop was accepted" and "the run is finishing" exclusive.
        self._finishing: set[int] = set()
        self._gate = threading.Lock()
        self._sources: dict[int, dict[str, threading.Event]] = {}
        self._sources_done: dict[int, set[str]] = {}
        self._sources_answered: dict[int, set[str]] = {}

    # ------------------------------------------------------------------
    # Registration / lifecycle
    # ------------------------------------------------------------------

    def register(self, exec_id: int) -> None:
        """Register a new execution for progress tracking.

        Establishes a clean slate. Touching only the ``defaultdict`` entry would
        let an id that still had events in the store inherit them: the new
        execution's progress log would begin with a previous run's events, and
        the Monitor page would replay them as if they were live.

        That is reachable. ``cleanup`` is skipped whenever the persist step at
        the end of an execution raises, and ``POST /api/admin/erase-executions``
        deletes the ``executions`` row for ``sqlite_sequence``, which restarts
        AUTOINCREMENT at 1 - so the next execution can be handed an id whose
        stale events are still in memory.
        """
        self._events[exec_id] = []
        self._cancel_flags[exec_id] = threading.Event()
        self._completed[exec_id] = False
        self._finishing.discard(exec_id)
        self._sources.pop(exec_id, None)
        self._sources_done.pop(exec_id, None)
        self._sources_answered.pop(exec_id, None)

    def mark_complete(self, exec_id: int) -> None:
        """Mark execution as complete (no more events will be emitted)."""
        self._completed[exec_id] = True

    def cleanup(self, exec_id: int) -> None:
        """Remove an execution from the active store (after persisting to DB)."""
        self._events.pop(exec_id, None)
        self._locks.pop(exec_id, None)
        self._cancel_flags.pop(exec_id, None)
        self._completed.pop(exec_id, None)
        self._finishing.discard(exec_id)
        self._sources.pop(exec_id, None)
        self._sources_done.pop(exec_id, None)
        self._sources_answered.pop(exec_id, None)

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

    def register_sources(self, exec_id: int, sources: list[str]) -> None:
        """Declare the selected sources before starting any search."""
        with self._gate:
            self._sources[exec_id] = {slug: threading.Event() for slug in sources}
            self._sources_done[exec_id] = set()
            self._sources_answered[exec_id] = set()
            self._source_controls_locked(exec_id)

    def _source_controls_locked(self, exec_id: int) -> None:
        """Publish admission facts while holding the same gate as a stop."""
        available = self.is_active(exec_id) and exec_id not in self._finishing and not self.should_cancel(exec_id)
        done = self._sources_done.get(exec_id, set())
        sources = {slug: {"stoppable": available and slug not in done and not flag.is_set()}
                   for slug, flag in self._sources.get(exec_id, {}).items()}
        self.emit(exec_id, {"type": "source_controls", "sources": sources,
                            "can_stop_unfinished": bool(self._sources_answered.get(exec_id))
                            and any(row["stoppable"] for row in sources.values())})

    def note_source_answered(self, exec_id: int, slug: str) -> None:
        """A recorded answer enables the bulk control; a stop or skip does not."""
        with self._gate:
            self._sources_answered.setdefault(exec_id, set()).add(slug)
            self._source_controls_locked(exec_id)

    def source_stop_flag(self, exec_id: int, slug: str) -> threading.Event:
        """The cooperative signal shared with one search's outcome channel."""
        with self._gate:
            return self._sources.get(exec_id, {}).get(slug, threading.Event())

    def finish_source(self, exec_id: int, slug: str, expected: threading.Event | None = None, *, answered: bool = False) -> bool:
        """Close admission to stops; return whether a stop was already accepted.

        Called where the search returns, before its result is queued. A stop
        and a returned answer cannot both win this gate. An accepted stop is
        kept even if the client returned a complete page at the same moment.
        """
        with self._gate:
            flag = self._sources.get(exec_id, {}).get(slug)
            # A canceled run can release its store while a synchronous request
            # is still returning. Its worker cannot finish a later run that
            # reused the id after the execution history was erased.
            if expected is not None and flag is not expected:
                return expected.is_set()
            self._sources_done.setdefault(exec_id, set()).add(slug)
            if answered and (flag is None or not flag.is_set()):
                self._sources_answered.setdefault(exec_id, set()).add(slug)
            self._source_controls_locked(exec_id)
            return flag.is_set() if flag is not None else False

    def request_source_stop(self, exec_id: int, sources: list[str] | None) -> tuple[bool, str, list[str]]:
        """Stop the named sources atomically, or all still unfinished when omitted."""
        with self._gate:
            if not self.is_active(exec_id):
                return False, f"Execution {exec_id} is not active; its sources cannot be stopped.", []
            if exec_id in self._finishing:
                return False, f"Execution {exec_id} is finishing; it is too late to stop its sources.", []
            if self.should_cancel(exec_id):
                return False, f"Execution {exec_id} is stopping; the whole run was canceled.", []
            flags = self._sources.get(exec_id, {})
            done = self._sources_done.get(exec_id, set())
            if sources is not None:
                if not sources:
                    raise ValueError("sources must name at least one source.")
                unknown = [slug for slug in dict.fromkeys(sources) if slug not in flags]
                if unknown:
                    raise ValueError(f"Unknown sources in this run: {', '.join(unknown)}.")
            wanted = list(dict.fromkeys(sources)) if sources is not None else [s for s in flags if s not in done and not flags[s].is_set()]
            if not wanted:
                return False, "No unfinished sources remain to stop.", []
            for slug in wanted:
                if slug not in flags:
                    return False, f"{slug} is not a source in this run.", []
                if slug in done:
                    return False, f"{slug} has finished; it is too late to stop this source.", []
            for slug in wanted:
                flags[slug].set()
            self._source_controls_locked(exec_id)
            return True, stop_sentence(wanted, named=sources is not None), wanted

    def request_cancel(self, exec_id: int) -> bool:
        """Ask the execution to stop; ``False`` if it is too late to.

        ``True`` is a promise: the run reads the flag at ``begin_finishing``,
        its last check, so a request answered ``True`` ends the run canceled.
        ``False`` means the run is past that check and will finish as it is.
        """
        with self._gate:
            if exec_id in self._finishing:
                return False
            flag = self._cancel_flags.get(exec_id)
            if flag is not None:
                flag.set()
                self._source_controls_locked(exec_id)
            return True

    def begin_finishing(self, exec_id: int) -> bool:
        """The run's last cancellation check, taken once, just before it is recorded as finished.

        Returns ``False`` if a stop was requested, and the run must end
        canceled. Otherwise the run is committed to finishing, and any later
        ``request_cancel`` is refused.
        """
        with self._gate:
            flag = self._cancel_flags.get(exec_id)
            if flag is not None and flag.is_set():
                return False
            self._finishing.add(exec_id)
            self._source_controls_locked(exec_id)
            return True

    def should_cancel(self, exec_id: int) -> bool:
        """Check whether cancellation has been requested."""
        flag = self._cancel_flags.get(exec_id)
        return flag.is_set() if flag else False


def _joined(names: list[str]) -> str:
    """"A", "A and B", "A, B, and C": three or more take the serial comma."""
    if len(names) <= 2:
        return " and ".join(names)
    return f"{', '.join(names[:-1])}, and {names[-1]}"


def stop_sentence(slugs: list[str], *, named: bool) -> str:
    """What a stop of some of a run's sources says, naming them as a person knows them.

    "arXiv will stop at its next safe point; the run will keep going." Up to
    three are named; more are counted. ``named`` says whether the request
    named them, or asked for every source still unfinished.
    """
    from .source_coverage import _name  # noqa: PLC0415 - the catalog is read late, as there

    names = [_name(slug) for slug in slugs]
    keep = "; the run will keep going."
    if len(names) == 1:
        return f"{names[0]} will stop at its next safe point{keep}"
    if len(names) <= 3:
        return f"{_joined(names)} will stop at their next safe points{keep}"
    if named:
        return f"These {len(names)} sources will stop at their next safe points{keep}"
    return f"The {len(names)} unfinished sources will stop at their next safe points{keep}"


# Module-level singleton
progress_store = ProgressStore()
