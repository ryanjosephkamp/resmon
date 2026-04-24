"""``GET /api/v2/sync`` — cursor-based pull sync (IMPL-35, §11.1).

Contract
--------

    GET /api/v2/sync?since=<int>&limit=<int, default 200>
    → {
        "routines":              [...],
        "executions":            [...],
        "credentials_presence":  {key_name: True, ...},
        "next_version":          <int>,
        "has_more":              <bool>
      }

All rows are user-scoped. In production the row scope is enforced by
Postgres row-level security via :func:`cloud.db.rls_session`
(``SET LOCAL resmon.user_id = '<uid>'`` inside the transaction); the
in-memory test store filters by ``user_id`` directly. Every write to
``routines`` / ``executions`` / ``credentials`` bumps ``version`` via the
``change_version`` sequence (INSERT default on 0001, UPDATE trigger on
0002), so the monotonic cursor always advances.

The response ``next_version`` is the largest ``version`` among the returned
rows across all three tables, or 0 if the cursor is at the head of an empty
stream. ``has_more`` is ``True`` when more rows exist strictly beyond
``next_version`` that were skipped because of ``limit``.

``credentials_presence`` is a ``{key_name: True}`` dict rather than a row
list so plaintext/ciphertext/DEK material cannot leak through the sync
channel — this mirrors the invariant enforced by
:mod:`cloud.credentials`.
"""

from __future__ import annotations

import copy
import logging
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from .auth import CurrentUser, get_current_user


logger = logging.getLogger(__name__)

_DEFAULT_LIMIT = 200
_MAX_LIMIT = 1000


# ---------------------------------------------------------------------------
# Page data class
# ---------------------------------------------------------------------------


@dataclass
class SyncPage:
    routines: List[dict] = field(default_factory=list)
    executions: List[dict] = field(default_factory=list)
    credentials_presence: Dict[str, bool] = field(default_factory=dict)
    next_version: int = 0
    has_more: bool = False

    def to_public(self) -> dict:
        return {
            "routines": list(self.routines),
            "executions": list(self.executions),
            "credentials_presence": dict(self.credentials_presence),
            "next_version": int(self.next_version),
            "has_more": bool(self.has_more),
        }


# ---------------------------------------------------------------------------
# Versioned-row helpers
# ---------------------------------------------------------------------------


@dataclass
class _VersionedRoutine:
    row: dict
    version: int


@dataclass
class _VersionedExecution:
    row: dict
    version: int


@dataclass
class _VersionedCredential:
    key_name: str
    version: int


# ---------------------------------------------------------------------------
# Storage abstraction
# ---------------------------------------------------------------------------


class SyncStore(ABC):
    """Reads changed rows since a cursor. User-scoped by construction."""

    @abstractmethod
    def fetch_since(
        self, user_id: uuid.UUID, since: int, limit: int
    ) -> SyncPage:
        ...


class InMemorySyncStore(SyncStore):
    """Dict-backed sync store for hermetic tests.

    Mirrors the Postgres contract: every write (``insert_*``, ``update_*``,
    ``upsert_credential``) bumps ``version`` from an internal monotonic
    counter that stands in for the ``change_version`` sequence. The store
    keeps its own row-space independent of :class:`InMemoryRoutineStore`
    and :class:`InMemoryExecutionStore` so tests can drive the sync surface
    without coupling to the other stores' internal state.
    """

    def __init__(self) -> None:
        self._lock = RLock()
        self._counter = 0
        self._routines: Dict[uuid.UUID, _VersionedRoutine] = {}
        self._executions: Dict[uuid.UUID, _VersionedExecution] = {}
        # Credentials keyed on ``(user_id, key_name)``.
        self._credentials: Dict[tuple, _VersionedCredential] = {}
        # ``user_id -> {routine_id: ...}``. We do **not** cross-index in a
        # fancy way because hermetic test sizes are tiny; a linear scan in
        # ``fetch_since`` is fine and keeps the code obvious.
        self._row_user: Dict[uuid.UUID, uuid.UUID] = {}

    # -- Write surface used by tests ----------------------------------------

    def _next_version(self) -> int:
        self._counter += 1
        return self._counter

    def insert_routine(
        self, user_id: uuid.UUID, row: dict
    ) -> _VersionedRoutine:
        with self._lock:
            rid = uuid.UUID(str(row["routine_id"]))
            v = self._next_version()
            stored = _VersionedRoutine(row=dict(row), version=v)
            self._routines[rid] = stored
            self._row_user[rid] = user_id
            return _VersionedRoutine(row=dict(row), version=v)

    def update_routine(
        self, user_id: uuid.UUID, routine_id: uuid.UUID, **fields: Any
    ) -> Optional[_VersionedRoutine]:
        with self._lock:
            stored = self._routines.get(routine_id)
            if stored is None or self._row_user.get(routine_id) != user_id:
                return None
            stored.row.update(fields)
            stored.version = self._next_version()
            return _VersionedRoutine(row=dict(stored.row), version=stored.version)

    def insert_execution(
        self, user_id: uuid.UUID, row: dict
    ) -> _VersionedExecution:
        with self._lock:
            eid = uuid.UUID(str(row["execution_id"]))
            v = self._next_version()
            stored = _VersionedExecution(row=dict(row), version=v)
            self._executions[eid] = stored
            self._row_user[eid] = user_id
            return _VersionedExecution(row=dict(row), version=v)

    def update_execution(
        self, user_id: uuid.UUID, execution_id: uuid.UUID, **fields: Any
    ) -> Optional[_VersionedExecution]:
        with self._lock:
            stored = self._executions.get(execution_id)
            if stored is None or self._row_user.get(execution_id) != user_id:
                return None
            stored.row.update(fields)
            stored.version = self._next_version()
            return _VersionedExecution(row=dict(stored.row), version=stored.version)

    def upsert_credential(
        self, user_id: uuid.UUID, key_name: str
    ) -> _VersionedCredential:
        with self._lock:
            v = self._next_version()
            cred = _VersionedCredential(key_name=key_name, version=v)
            self._credentials[(user_id, key_name)] = cred
            return _VersionedCredential(key_name=key_name, version=v)

    # -- Read surface ------------------------------------------------------

    def fetch_since(
        self, user_id: uuid.UUID, since: int, limit: int
    ) -> SyncPage:
        with self._lock:
            changed: list[tuple[int, str, Any]] = []
            for rid, stored in self._routines.items():
                if stored.version > since and self._row_user.get(rid) == user_id:
                    changed.append(
                        (stored.version, "routine", copy.deepcopy(stored.row))
                    )
            for eid, stored in self._executions.items():
                if stored.version > since and self._row_user.get(eid) == user_id:
                    changed.append(
                        (stored.version, "execution", copy.deepcopy(stored.row))
                    )
            for (uid, key_name), cred in self._credentials.items():
                if uid == user_id and cred.version > since:
                    changed.append((cred.version, "credential", cred.key_name))

            changed.sort(key=lambda t: t[0])
            paged = changed[:limit]
            has_more = len(changed) > limit

            page = SyncPage(has_more=has_more)
            for v, kind, payload in paged:
                if kind == "routine":
                    page.routines.append(payload)
                elif kind == "execution":
                    page.executions.append(payload)
                elif kind == "credential":
                    page.credentials_presence[payload] = True
                if v > page.next_version:
                    page.next_version = v
            return page


class PostgresSyncStore(SyncStore):  # pragma: no cover - live PG only
    """Postgres-backed sync store scoped via RLS.

    Reads from ``routines``, ``executions``, and ``credentials`` with
    ``version > :since`` and merges the three streams in ``version`` order,
    taking the first ``limit`` rows. The RLS session guarantees every
    query only sees the caller's rows.
    """

    def __init__(self, rls_session_factory: Callable):
        self._rls_session = rls_session_factory

    def fetch_since(
        self, user_id: uuid.UUID, since: int, limit: int
    ) -> SyncPage:
        from sqlalchemy import text

        # Fetch ``limit + 1`` per table then merge, so we can detect
        # ``has_more`` without a second round-trip.
        cap = limit + 1
        with self._rls_session(user_id) as conn:
            r_rows = conn.execute(
                text(
                    "SELECT routine_id, name, parameters, cron, enabled, "
                    "created_at, updated_at, version "
                    "FROM routines WHERE version > :since "
                    "ORDER BY version ASC LIMIT :cap"
                ),
                {"since": since, "cap": cap},
            ).all()
            e_rows = conn.execute(
                text(
                    "SELECT execution_id, routine_id, status, started_at, "
                    "finished_at, cancel_reason, artifact_uri, stats, version "
                    "FROM executions WHERE version > :since "
                    "ORDER BY version ASC LIMIT :cap"
                ),
                {"since": since, "cap": cap},
            ).all()
            c_rows = conn.execute(
                text(
                    "SELECT key_name, version FROM credentials "
                    "WHERE version > :since "
                    "ORDER BY version ASC LIMIT :cap"
                ),
                {"since": since, "cap": cap},
            ).all()

        merged: list[tuple[int, str, Any]] = []
        for r in r_rows:
            merged.append(
                (
                    int(r.version),
                    "routine",
                    {
                        "routine_id": str(r.routine_id),
                        "name": r.name,
                        "parameters": dict(r.parameters or {}),
                        "cron": r.cron,
                        "enabled": bool(r.enabled),
                        "created_at": r.created_at.isoformat(),
                        "updated_at": r.updated_at.isoformat(),
                    },
                )
            )
        for r in e_rows:
            merged.append(
                (
                    int(r.version),
                    "execution",
                    {
                        "execution_id": str(r.execution_id),
                        "routine_id": (
                            str(r.routine_id) if r.routine_id else None
                        ),
                        "status": r.status,
                        "started_at": r.started_at.isoformat(),
                        "finished_at": (
                            r.finished_at.isoformat() if r.finished_at else None
                        ),
                        "cancel_reason": r.cancel_reason,
                        "artifact_uri": r.artifact_uri,
                        "stats": (dict(r.stats) if r.stats else None),
                    },
                )
            )
        for r in c_rows:
            merged.append((int(r.version), "credential", r.key_name))

        merged.sort(key=lambda t: t[0])
        paged = merged[:limit]
        has_more = len(merged) > limit

        page = SyncPage(has_more=has_more)
        for v, kind, payload in paged:
            if kind == "routine":
                page.routines.append(payload)
            elif kind == "execution":
                page.executions.append(payload)
            elif kind == "credential":
                page.credentials_presence[payload] = True
            if v > page.next_version:
                page.next_version = v
        return page


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------


def _get_sync_store(request: Request) -> SyncStore:
    store = getattr(request.app.state, "sync_store", None)
    if store is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Sync store not configured",
        )
    return store


def build_sync_router() -> APIRouter:
    """Return the ``/sync`` router (mounted under ``/api/v2`` by the caller)."""

    router = APIRouter()

    @router.get("/sync")
    def sync(
        request: Request,
        since: int = Query(0, ge=0),
        limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
        current_user: CurrentUser = Depends(get_current_user),
    ) -> dict:
        store = _get_sync_store(request)
        page = store.fetch_since(current_user.user_id, since, limit)
        return page.to_public()

    return router
