"""``/api/v2/executions`` — list, detail, SSE events, cancel (IMPL-32, §10).

The cloud executions endpoints mirror the local daemon's SSE contract so the
frontend's existing ``ExecutionContext`` consumer can treat both transports
identically (same event shape documented in IMPL-17 / IMPL-20).

Storage is abstracted behind :class:`ExecutionStore` and progress is tracked
by :data:`cloud_progress_store` — a separate :class:`ProgressStore` instance
keyed on the execution UUID string so cloud exec IDs (UUID) do not collide
with local daemon exec IDs (int) when a test process hosts both.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from threading import RLock
from typing import Any, Callable, Dict, Iterator, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from .auth import CurrentUser, get_current_user


logger = logging.getLogger(__name__)


# The cloud package is intentionally decoupled from the local daemon
# package (``keyring``-based, SQLite-backed). Rather than reach across
# package boundaries for :class:`implementation_scripts.progress.ProgressStore`
# we ship a lightweight, thread-safe equivalent here. Same event-list /
# cancel-flag / completion-marker contract as the local store — so the
# frontend's ``ExecutionContext`` consumer sees an identical SSE payload
# regardless of which backend it connects to.

import threading
from collections import defaultdict


class _CloudProgressStore:
    """Thread-safe in-memory progress store keyed on execution UUID strings."""

    def __init__(self) -> None:
        self._events: Dict[str, list[dict]] = defaultdict(list)
        self._locks: Dict[str, threading.Lock] = defaultdict(threading.Lock)
        self._cancel: Dict[str, threading.Event] = {}
        self._done: Dict[str, bool] = {}

    def register(self, key: str) -> None:
        self._events[key]
        self._cancel[key] = threading.Event()
        self._done[key] = False

    def emit(self, key: str, event: dict) -> None:
        with self._locks[key]:
            self._events[key].append(event)

    def get_events(self, key: str, since: int = 0) -> list[dict]:
        with self._locks[key]:
            return list(self._events[key][since:])

    def mark_complete(self, key: str) -> None:
        self._done[key] = True

    def is_active(self, key: str) -> bool:
        return key in self._events and not self._done.get(key, False)

    def request_cancel(self, key: str) -> None:
        flag = self._cancel.get(key)
        if flag is None:
            flag = threading.Event()
            self._cancel[key] = flag
            # Touch the event list so ``is_active`` returns True until the
            # worker marks the execution complete.
            self._events[key]
        flag.set()

    def should_cancel(self, key: str) -> bool:
        flag = self._cancel.get(key)
        return flag.is_set() if flag else False

    def cleanup(self, key: str) -> None:
        self._events.pop(key, None)
        self._locks.pop(key, None)
        self._cancel.pop(key, None)
        self._done.pop(key, None)


cloud_progress_store = _CloudProgressStore()


# ---------------------------------------------------------------------------
# Execution row
# ---------------------------------------------------------------------------


_TERMINAL_STATES: frozenset[str] = frozenset(
    {"succeeded", "failed", "cancelled"}
)


@dataclass
class Execution:
    execution_id: uuid.UUID
    user_id: uuid.UUID
    routine_id: Optional[uuid.UUID]
    status: str
    started_at: datetime
    finished_at: Optional[datetime] = None
    cancel_reason: Optional[str] = None
    artifact_uri: Optional[str] = None
    stats: Optional[Dict[str, Any]] = None
    heartbeat_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    def to_public(self) -> dict:
        return {
            "execution_id": str(self.execution_id),
            "routine_id": str(self.routine_id) if self.routine_id else None,
            "status": self.status,
            "started_at": self.started_at.isoformat(),
            "finished_at": (
                self.finished_at.isoformat() if self.finished_at else None
            ),
            "cancel_reason": self.cancel_reason,
            "artifact_uri": self.artifact_uri,
            "stats": self.stats,
        }


# ---------------------------------------------------------------------------
# Storage abstraction
# ---------------------------------------------------------------------------


class ExecutionStore(ABC):
    @abstractmethod
    def list(
        self, user_id: uuid.UUID, *, limit: int = 50, offset: int = 0
    ) -> list[Execution]:
        ...

    @abstractmethod
    def get(
        self, user_id: uuid.UUID, execution_id: uuid.UUID
    ) -> Optional[Execution]:
        ...

    @abstractmethod
    def insert(
        self,
        user_id: uuid.UUID,
        routine_id: Optional[uuid.UUID],
        *,
        status: str = "running",
    ) -> Execution:
        ...

    @abstractmethod
    def update(
        self,
        execution_id: uuid.UUID,
        **fields: Any,
    ) -> Optional[Execution]:
        ...

    @abstractmethod
    def touch(self, execution_id: uuid.UUID) -> None:
        ...

    @abstractmethod
    def reap_stuck(
        self, *, threshold: timedelta, cancel_reason: str = "node_restart"
    ) -> list[uuid.UUID]:
        ...


class InMemoryExecutionStore(ExecutionStore):
    """Dict-backed execution store for hermetic tests and local dev."""

    def __init__(self) -> None:
        self._rows: Dict[uuid.UUID, Execution] = {}
        self._lock = RLock()

    def list(self, user_id, *, limit=50, offset=0):
        with self._lock:
            rows = [r for r in self._rows.values() if r.user_id == user_id]
        rows.sort(key=lambda r: r.started_at, reverse=True)
        return [copy.deepcopy(r) for r in rows[offset : offset + limit]]

    def get(self, user_id, execution_id):
        with self._lock:
            r = self._rows.get(execution_id)
            if r is None or r.user_id != user_id:
                return None
            return copy.deepcopy(r)

    def insert(self, user_id, routine_id, *, status="running"):
        now = datetime.now(timezone.utc)
        row = Execution(
            execution_id=uuid.uuid4(),
            user_id=user_id,
            routine_id=routine_id,
            status=status,
            started_at=now,
            heartbeat_at=now,
        )
        with self._lock:
            self._rows[row.execution_id] = row
        return copy.deepcopy(row)

    def update(self, execution_id, **fields):
        now = datetime.now(timezone.utc)
        with self._lock:
            row = self._rows.get(execution_id)
            if row is None:
                return None
            for k, v in fields.items():
                if not hasattr(row, k):
                    continue
                setattr(row, k, v)
            row.heartbeat_at = now
            return copy.deepcopy(row)

    def touch(self, execution_id):
        now = datetime.now(timezone.utc)
        with self._lock:
            row = self._rows.get(execution_id)
            if row is not None:
                row.heartbeat_at = now

    def reap_stuck(self, *, threshold, cancel_reason="node_restart"):
        now = datetime.now(timezone.utc)
        cutoff = now - threshold
        reaped: list[uuid.UUID] = []
        with self._lock:
            for row in self._rows.values():
                if row.status == "running" and row.heartbeat_at < cutoff:
                    row.status = "failed"
                    row.finished_at = now
                    row.cancel_reason = cancel_reason
                    reaped.append(row.execution_id)
        return reaped

    def delete_all_for_user(self, user_id: uuid.UUID) -> int:
        """Drop every execution row owned by ``user_id`` (IMPL-40 cascade)."""
        with self._lock:
            to_remove = [
                eid for eid, row in self._rows.items()
                if row.user_id == user_id
            ]
            for eid in to_remove:
                del self._rows[eid]
        return len(to_remove)


class PostgresExecutionStore(ExecutionStore):  # pragma: no cover - live PG only
    """Postgres-backed execution store using per-user RLS sessions.

    The ``heartbeat_at`` column is tracked out of band in Redis in production
    (keyed on the execution UUID); the fallback path in this store uses a
    dedicated ``executions.heartbeat_at`` column that migrations add in a
    follow-up revision. Hermetic CI does not exercise this class.
    """

    def __init__(self, rls_session_factory, engine_getter):
        self._rls_session = rls_session_factory
        self._engine_getter = engine_getter

    def list(self, user_id, *, limit=50, offset=0):
        from sqlalchemy import text

        with self._rls_session(user_id) as conn:
            rows = conn.execute(
                text(
                    "SELECT execution_id, user_id, routine_id, status, started_at, "
                    "finished_at, cancel_reason, artifact_uri, stats "
                    "FROM executions ORDER BY started_at DESC "
                    "LIMIT :lim OFFSET :off"
                ),
                {"lim": limit, "off": offset},
            ).all()
        return [self._row(r) for r in rows]

    def _row(self, r) -> Execution:
        return Execution(
            execution_id=uuid.UUID(str(r.execution_id)),
            user_id=uuid.UUID(str(r.user_id)),
            routine_id=(uuid.UUID(str(r.routine_id)) if r.routine_id else None),
            status=r.status,
            started_at=r.started_at,
            finished_at=r.finished_at,
            cancel_reason=r.cancel_reason,
            artifact_uri=r.artifact_uri,
            stats=(dict(r.stats) if r.stats else None),
        )

    def get(self, user_id, execution_id):
        from sqlalchemy import text

        with self._rls_session(user_id) as conn:
            row = conn.execute(
                text(
                    "SELECT execution_id, user_id, routine_id, status, started_at, "
                    "finished_at, cancel_reason, artifact_uri, stats "
                    "FROM executions WHERE execution_id = :eid"
                ),
                {"eid": str(execution_id)},
            ).first()
        return self._row(row) if row else None

    def insert(self, user_id, routine_id, *, status="running"):
        from sqlalchemy import text

        with self._rls_session(user_id) as conn:
            row = conn.execute(
                text(
                    "INSERT INTO executions (user_id, routine_id, status) "
                    "VALUES (:uid, :rid, :status) "
                    "RETURNING execution_id, user_id, routine_id, status, "
                    "started_at, finished_at, cancel_reason, artifact_uri, stats"
                ),
                {
                    "uid": str(user_id),
                    "rid": str(routine_id) if routine_id else None,
                    "status": status,
                },
            ).first()
        return self._row(row)

    def update(self, execution_id, **fields):
        from sqlalchemy import text
        import json as _json

        sets, params = [], {"eid": str(execution_id)}
        for k in (
            "status", "finished_at", "cancel_reason", "artifact_uri",
        ):
            if k in fields:
                sets.append(f"{k} = :{k}")
                params[k] = fields[k]
        if "stats" in fields:
            sets.append("stats = :stats::jsonb")
            params["stats"] = _json.dumps(fields["stats"])
        if not sets:
            return None
        engine = self._engine_getter()
        with engine.begin() as conn:
            row = conn.execute(
                text(
                    "UPDATE executions SET " + ", ".join(sets)
                    + " WHERE execution_id = :eid "
                    "RETURNING execution_id, user_id, routine_id, status, "
                    "started_at, finished_at, cancel_reason, artifact_uri, stats"
                ),
                params,
            ).first()
        return self._row(row) if row else None

    def touch(self, execution_id):
        # Postgres variant stores heartbeat in Redis; noop fallback here.
        pass

    def reap_stuck(self, *, threshold, cancel_reason="node_restart"):
        from sqlalchemy import text

        engine = self._engine_getter()
        cutoff_seconds = int(threshold.total_seconds())
        with engine.begin() as conn:
            rows = conn.execute(
                text(
                    "UPDATE executions "
                    "SET status = 'failed', finished_at = now(), "
                    "    cancel_reason = :reason "
                    "WHERE status = 'running' "
                    "  AND started_at < now() - make_interval(secs => :secs) "
                    "RETURNING execution_id"
                ),
                {"reason": cancel_reason, "secs": cutoff_seconds},
            ).all()
        return [uuid.UUID(str(r.execution_id)) for r in rows]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_execution_store(request: Request) -> ExecutionStore:
    store = getattr(request.app.state, "execution_store", None)
    if store is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Execution store not configured",
        )
    return store


def _parse_execution_id(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid execution_id")


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def build_executions_router() -> APIRouter:
    router = APIRouter()

    @router.get("/executions")
    def list_executions(
        request: Request,
        limit: int = 50,
        offset: int = 0,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> dict:
        limit = max(1, min(limit, 200))
        offset = max(0, offset)
        store = _get_execution_store(request)
        items = store.list(current_user.user_id, limit=limit, offset=offset)
        return {
            "items": [e.to_public() for e in items],
            "limit": limit,
            "offset": offset,
        }

    @router.get("/executions/{execution_id}")
    def get_execution(
        execution_id: str,
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> dict:
        eid = _parse_execution_id(execution_id)
        store = _get_execution_store(request)
        row = store.get(current_user.user_id, eid)
        if row is None:
            raise HTTPException(status_code=404, detail="Execution not found")
        return row.to_public()

    @router.get("/executions/{execution_id}/events")
    def stream_events(
        execution_id: str,
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ):
        eid = _parse_execution_id(execution_id)
        store = _get_execution_store(request)
        if store.get(current_user.user_id, eid) is None:
            raise HTTPException(status_code=404, detail="Execution not found")

        key = str(eid)

        def gen() -> Iterator[bytes]:
            seen = 0
            deadline = time.monotonic() + 30.0  # per-connection cap
            while time.monotonic() < deadline:
                events = cloud_progress_store.get_events(key, since=seen)
                for ev in events:
                    yield f"data: {json.dumps(ev)}\n\n".encode("utf-8")
                    seen += 1
                if not cloud_progress_store.is_active(key):
                    return
                time.sleep(0.1)

        return StreamingResponse(gen(), media_type="text/event-stream")

    @router.post(
        "/executions/{execution_id}/cancel", status_code=status.HTTP_202_ACCEPTED
    )
    def cancel_execution(
        execution_id: str,
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> dict:
        eid = _parse_execution_id(execution_id)
        store = _get_execution_store(request)
        row = store.get(current_user.user_id, eid)
        if row is None:
            raise HTTPException(status_code=404, detail="Execution not found")
        if row.status in _TERMINAL_STATES:
            return {
                "execution_id": str(eid),
                "status": row.status,
                "cancel_requested": False,
            }
        cloud_progress_store.request_cancel(str(eid))
        logger.info(
            "Cancel requested: user_id=%s execution_id=%s",
            current_user.user_id, eid,
        )
        return {
            "execution_id": str(eid),
            "status": row.status,
            "cancel_requested": True,
        }

    return router
