"""``/api/v2/routines`` CRUD + ``/run-now`` (IMPL-32, §10).

The endpoints are user-scoped via the JWT dependency + Postgres row-level
security (``SET LOCAL resmon.user_id``). Persistence is abstracted behind
:class:`RoutineStore` so hermetic tests can inject an
:class:`InMemoryRoutineStore` while production wires in
:class:`PostgresRoutineStore` (RLS-scoped via :mod:`cloud.db`).

This module is intentionally thin: the scheduler wiring (AsyncIOScheduler +
SQLAlchemyJobStore + reaper) lives in :mod:`cloud.worker`. The ``run-now``
endpoint delegates to the worker callable registered on ``app.state``.
"""

from __future__ import annotations

import copy
import logging
import re
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Callable, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator

from .auth import CurrentUser, get_current_user


logger = logging.getLogger(__name__)

_CRON_FIELD_COUNT = 5
_MAX_NAME_LEN = 200


# ---------------------------------------------------------------------------
# Data class
# ---------------------------------------------------------------------------


@dataclass
class Routine:
    routine_id: uuid.UUID
    user_id: uuid.UUID
    name: str
    parameters: Dict[str, Any]
    cron: str
    enabled: bool = True
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_public(self) -> dict:
        return {
            "routine_id": str(self.routine_id),
            "name": self.name,
            "parameters": self.parameters,
            "cron": self.cron,
            "enabled": self.enabled,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


# ---------------------------------------------------------------------------
# Body models
# ---------------------------------------------------------------------------


def _validate_cron(expr: str) -> str:
    parts = expr.strip().split()
    if len(parts) != _CRON_FIELD_COUNT:
        raise ValueError(
            f"cron must have exactly {_CRON_FIELD_COUNT} whitespace-separated fields"
        )
    return expr.strip()


class RoutineCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=_MAX_NAME_LEN)
    parameters: Dict[str, Any] = Field(default_factory=dict)
    cron: str = Field(..., min_length=1)
    enabled: bool = True

    @field_validator("cron")
    @classmethod
    def _check_cron(cls, v: str) -> str:
        return _validate_cron(v)


class RoutineUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=_MAX_NAME_LEN)
    parameters: Optional[Dict[str, Any]] = None
    cron: Optional[str] = None
    enabled: Optional[bool] = None

    @field_validator("cron")
    @classmethod
    def _check_cron(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        return _validate_cron(v)


# ---------------------------------------------------------------------------
# Storage abstraction
# ---------------------------------------------------------------------------


class RoutineStore(ABC):
    @abstractmethod
    def list(self, user_id: uuid.UUID) -> list[Routine]:
        ...

    @abstractmethod
    def get(self, user_id: uuid.UUID, routine_id: uuid.UUID) -> Optional[Routine]:
        ...

    @abstractmethod
    def create(self, user_id: uuid.UUID, data: RoutineCreate) -> Routine:
        ...

    @abstractmethod
    def update(
        self,
        user_id: uuid.UUID,
        routine_id: uuid.UUID,
        data: RoutineUpdate,
    ) -> Optional[Routine]:
        ...

    @abstractmethod
    def delete(self, user_id: uuid.UUID, routine_id: uuid.UUID) -> bool:
        ...


class InMemoryRoutineStore(RoutineStore):
    """Dict-backed store for hermetic tests."""

    def __init__(self) -> None:
        self._rows: Dict[uuid.UUID, Routine] = {}
        self._lock = RLock()

    def list(self, user_id: uuid.UUID) -> list[Routine]:
        with self._lock:
            return [
                copy.deepcopy(r) for r in self._rows.values() if r.user_id == user_id
            ]

    def get(self, user_id: uuid.UUID, routine_id: uuid.UUID) -> Optional[Routine]:
        with self._lock:
            r = self._rows.get(routine_id)
            if r is None or r.user_id != user_id:
                return None
            return copy.deepcopy(r)

    def create(self, user_id: uuid.UUID, data: RoutineCreate) -> Routine:
        now = datetime.now(timezone.utc)
        routine = Routine(
            routine_id=uuid.uuid4(),
            user_id=user_id,
            name=data.name,
            parameters=dict(data.parameters),
            cron=data.cron,
            enabled=data.enabled,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._rows[routine.routine_id] = routine
        return copy.deepcopy(routine)

    def update(
        self,
        user_id: uuid.UUID,
        routine_id: uuid.UUID,
        data: RoutineUpdate,
    ) -> Optional[Routine]:
        with self._lock:
            r = self._rows.get(routine_id)
            if r is None or r.user_id != user_id:
                return None
            if data.name is not None:
                r.name = data.name
            if data.parameters is not None:
                r.parameters = dict(data.parameters)
            if data.cron is not None:
                r.cron = data.cron
            if data.enabled is not None:
                r.enabled = data.enabled
            r.updated_at = datetime.now(timezone.utc)
            return copy.deepcopy(r)

    def delete(self, user_id: uuid.UUID, routine_id: uuid.UUID) -> bool:
        with self._lock:
            r = self._rows.get(routine_id)
            if r is None or r.user_id != user_id:
                return False
            del self._rows[routine_id]
            return True


class PostgresRoutineStore(RoutineStore):  # pragma: no cover - requires live PG
    """Postgres-backed store using the RLS session context."""

    def __init__(self, rls_session_factory: Callable):
        self._rls_session = rls_session_factory

    def _row_to_routine(self, row) -> Routine:
        return Routine(
            routine_id=uuid.UUID(str(row.routine_id)),
            user_id=uuid.UUID(str(row.user_id)),
            name=row.name,
            parameters=dict(row.parameters or {}),
            cron=row.cron,
            enabled=bool(row.enabled),
            created_at=row.created_at,
            updated_at=row.updated_at,
        )

    def list(self, user_id: uuid.UUID) -> list[Routine]:
        from sqlalchemy import text

        with self._rls_session(user_id) as conn:
            rows = conn.execute(
                text(
                    "SELECT routine_id, user_id, name, parameters, cron, enabled, "
                    "created_at, updated_at FROM routines ORDER BY created_at DESC"
                )
            ).all()
        return [self._row_to_routine(r) for r in rows]

    def get(self, user_id, routine_id):
        from sqlalchemy import text

        with self._rls_session(user_id) as conn:
            row = conn.execute(
                text(
                    "SELECT routine_id, user_id, name, parameters, cron, enabled, "
                    "created_at, updated_at FROM routines WHERE routine_id = :rid"
                ),
                {"rid": str(routine_id)},
            ).first()
        return self._row_to_routine(row) if row else None

    def create(self, user_id, data):
        from sqlalchemy import text
        import json

        with self._rls_session(user_id) as conn:
            row = conn.execute(
                text(
                    """
                    INSERT INTO routines (user_id, name, parameters, cron, enabled)
                    VALUES (:uid, :name, :params::jsonb, :cron, :enabled)
                    RETURNING routine_id, user_id, name, parameters, cron, enabled,
                              created_at, updated_at
                    """
                ),
                {
                    "uid": str(user_id),
                    "name": data.name,
                    "params": json.dumps(dict(data.parameters)),
                    "cron": data.cron,
                    "enabled": data.enabled,
                },
            ).first()
        return self._row_to_routine(row)

    def update(self, user_id, routine_id, data):
        from sqlalchemy import text
        import json

        sets = []
        params: dict = {"rid": str(routine_id)}
        if data.name is not None:
            sets.append("name = :name")
            params["name"] = data.name
        if data.parameters is not None:
            sets.append("parameters = :params::jsonb")
            params["params"] = json.dumps(dict(data.parameters))
        if data.cron is not None:
            sets.append("cron = :cron")
            params["cron"] = data.cron
        if data.enabled is not None:
            sets.append("enabled = :enabled")
            params["enabled"] = data.enabled
        if not sets:
            return self.get(user_id, routine_id)
        sets.append("updated_at = now()")
        with self._rls_session(user_id) as conn:
            row = conn.execute(
                text(
                    "UPDATE routines SET " + ", ".join(sets)
                    + " WHERE routine_id = :rid "
                    + "RETURNING routine_id, user_id, name, parameters, cron, enabled,"
                    + " created_at, updated_at"
                ),
                params,
            ).first()
        return self._row_to_routine(row) if row else None

    def delete(self, user_id, routine_id):
        from sqlalchemy import text

        with self._rls_session(user_id) as conn:
            res = conn.execute(
                text("DELETE FROM routines WHERE routine_id = :rid"),
                {"rid": str(routine_id)},
            )
            return (res.rowcount or 0) > 0


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def _get_routine_store(request: Request) -> RoutineStore:
    store = getattr(request.app.state, "routine_store", None)
    if store is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Routine store not configured",
        )
    return store


def _parse_routine_id(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid routine_id",
        )


def build_routines_router() -> APIRouter:
    router = APIRouter()

    @router.get("/routines")
    def list_routines(
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> list[dict]:
        store = _get_routine_store(request)
        return [r.to_public() for r in store.list(current_user.user_id)]

    @router.post("/routines", status_code=status.HTTP_201_CREATED)
    def create_routine(
        body: RoutineCreate,
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> dict:
        store = _get_routine_store(request)
        # IMPL-39 §13: per-user max-routines cap (429 when exceeded).
        cfg = getattr(request.app.state, "config", None)
        max_routines = getattr(cfg, "rate_limit_max_routines", None) if cfg else None
        if max_routines is not None:
            from .limits import enforce_max_routines
            enforce_max_routines(
                len(store.list(current_user.user_id)), int(max_routines),
            )
        routine = store.create(current_user.user_id, body)
        logger.info(
            "Routine created: user_id=%s routine_id=%s",
            current_user.user_id, routine.routine_id,
        )
        # Notify the scheduler (best-effort).
        scheduler_attach = getattr(request.app.state, "routine_scheduler_attach", None)
        if scheduler_attach is not None:
            try:
                scheduler_attach(routine)
            except Exception:  # pragma: no cover - scheduler failures must not
                logger.exception("Scheduler attach failed for routine %s", routine.routine_id)
        return routine.to_public()

    @router.get("/routines/{routine_id}")
    def get_routine(
        routine_id: str,
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> dict:
        rid = _parse_routine_id(routine_id)
        store = _get_routine_store(request)
        routine = store.get(current_user.user_id, rid)
        if routine is None:
            raise HTTPException(status_code=404, detail="Routine not found")
        return routine.to_public()

    @router.patch("/routines/{routine_id}")
    def patch_routine(
        routine_id: str,
        body: RoutineUpdate,
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> dict:
        rid = _parse_routine_id(routine_id)
        store = _get_routine_store(request)
        routine = store.update(current_user.user_id, rid, body)
        if routine is None:
            raise HTTPException(status_code=404, detail="Routine not found")
        scheduler_reattach = getattr(
            request.app.state, "routine_scheduler_reattach", None
        )
        if scheduler_reattach is not None:
            try:
                scheduler_reattach(routine)
            except Exception:  # pragma: no cover
                logger.exception("Scheduler reattach failed for %s", routine.routine_id)
        return routine.to_public()

    @router.delete("/routines/{routine_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_routine(
        routine_id: str,
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ):
        rid = _parse_routine_id(routine_id)
        store = _get_routine_store(request)
        existed = store.delete(current_user.user_id, rid)
        if not existed:
            raise HTTPException(status_code=404, detail="Routine not found")
        scheduler_detach = getattr(request.app.state, "routine_scheduler_detach", None)
        if scheduler_detach is not None:
            try:
                scheduler_detach(rid)
            except Exception:  # pragma: no cover
                logger.exception("Scheduler detach failed for %s", rid)
        logger.info(
            "Routine deleted: user_id=%s routine_id=%s",
            current_user.user_id, rid,
        )
        return None

    @router.post("/routines/{routine_id}/run-now", status_code=status.HTTP_202_ACCEPTED)
    def run_now(
        routine_id: str,
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> dict:
        rid = _parse_routine_id(routine_id)
        store = _get_routine_store(request)
        routine = store.get(current_user.user_id, rid)
        if routine is None:
            raise HTTPException(status_code=404, detail="Routine not found")
        run_now_fn = getattr(request.app.state, "routine_run_now", None)
        if run_now_fn is None:
            raise HTTPException(
                status_code=503, detail="Scheduler not configured for run-now",
            )
        execution_id = run_now_fn(routine)
        return {"execution_id": str(execution_id)}

    return router
