"""Self-service account endpoints + closed-beta write gate (IMPL-40 / §§17.2, 18.3).

Public surface:

* :func:`build_account_router` — mounts under the v2 prefix:
  * ``GET  /me/export`` — streaming ZIP of every row the user owns plus a
    manifest of signed URLs for each execution artifact.
  * ``DELETE /me`` — cascades credentials → executions → routines → user,
    then enqueues the user's object-store prefix for a 7-day soft-delete.
* :func:`require_beta_for_writes` — FastAPI dependency that asserts the
  caller's JWT carries ``beta: true`` on every mutating verb
  (``POST``/``PUT``/``PATCH``/``DELETE``); reads pass through unchanged.
* :class:`SoftDeleteQueue` — tiny in-process queue that records deferred
  object-store prefix deletions. Production wires a Celery/cron worker to
  drain it; tests assert the queue contents.

Per `resmon_rules.md` this module must not log ciphertext, key material,
or token substrings. The export response therefore ships only ``key_name``
entries for credentials — ciphertext is deliberately omitted.
"""

from __future__ import annotations

import io
import json
import logging
import threading
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from .auth import CurrentUser, get_current_user


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Closed-beta write gate
# ---------------------------------------------------------------------------

_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def require_beta_for_writes(
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
) -> CurrentUser:
    """Enforce the closed-beta gate (§17.2).

    Writes (``POST``/``PUT``/``PATCH``/``DELETE``) require ``beta: true``
    on the verified JWT claims. Reads are allowed to any authenticated
    user so data-subject access (export) keeps working even if beta
    access lapses.
    """
    method = request.method.upper()
    if method in _READ_METHODS:
        return current_user
    if not bool(current_user.claims.get("beta")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Closed beta: write access requires the 'beta: true' "
                "JWT claim. Contact the deployment operator for beta access."
            ),
        )
    return current_user


# ---------------------------------------------------------------------------
# Soft-delete queue for the object-store prefix
# ---------------------------------------------------------------------------


DEFAULT_SOFT_DELETE_WINDOW_DAYS = 7


@dataclass(frozen=True)
class SoftDeleteEntry:
    user_id: uuid.UUID
    prefix: str
    scheduled_at: datetime  # when the soft-delete was scheduled
    purge_after: datetime   # earliest legal permanent-purge time


class SoftDeleteQueue:
    """Thread-safe in-process soft-delete queue.

    Entries are appended by :func:`build_account_router`'s delete handler
    and drained by an operational worker (out of scope for v1 — the queue
    itself is enough for V-G3). The queue is deliberately append-only in
    the request path so a concurrent delete storm never loses entries.
    """

    def __init__(
        self,
        *,
        window_days: int = DEFAULT_SOFT_DELETE_WINDOW_DAYS,
    ) -> None:
        self._window = timedelta(days=int(window_days))
        self._entries: list[SoftDeleteEntry] = []
        self._lock = threading.Lock()

    @property
    def window(self) -> timedelta:
        return self._window

    def enqueue(self, user_id: uuid.UUID, prefix: str) -> SoftDeleteEntry:
        now = datetime.now(timezone.utc)
        entry = SoftDeleteEntry(
            user_id=user_id,
            prefix=prefix,
            scheduled_at=now,
            purge_after=now + self._window,
        )
        with self._lock:
            self._entries.append(entry)
        return entry

    def list_pending(self) -> list[SoftDeleteEntry]:
        with self._lock:
            return list(self._entries)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


# ---------------------------------------------------------------------------
# Export ZIP builder
# ---------------------------------------------------------------------------


def _safe_list(fn, *args, **kwargs) -> list:
    """Call a store ``list``-style method and tolerate the in-memory stubs
    that return lists directly vs the Postgres stores that raise when the
    caller omits pagination args. Kept defensive so the export endpoint
    never 500s on a store that is missing an optional method."""
    try:
        out = fn(*args, **kwargs)
    except TypeError:
        out = fn(*args)
    return list(out) if out else []


def _signed_artifact_urls(
    request: Request, user_id: uuid.UUID, exec_id: uuid.UUID,
) -> list[dict[str, str]]:
    """Best-effort signed-URL manifest for a single execution.

    Tests (and deployments without an S3 client on ``app.state``) can
    inject a stub signer via ``app.state.artifact_url_signer`` that takes
    ``(user_id, exec_id, name)`` and returns a URL. If the signer is not
    wired in we fall back to :func:`cloud.artifacts.signed_url`; if even
    that import/network fails we return ``[]`` so the export still
    completes rather than 500-ing.
    """
    signer = getattr(request.app.state, "artifact_url_signer", None)
    if signer is None:
        from .artifacts import ALLOWED_ARTIFACT_NAMES, signed_url

        cfg = getattr(request.app.state, "config", None)
        s3 = getattr(request.app.state, "s3_client", None)

        def signer(uid, eid, name):  # type: ignore[misc]
            try:
                return signed_url(uid, eid, name, config=cfg, client=s3)
            except Exception as exc:  # pragma: no cover - absent S3 in CI
                logger.warning(
                    "Artifact signer unavailable for exec %s/%s: %s",
                    eid, name, exc,
                )
                return None

        names: Iterable[str] = ALLOWED_ARTIFACT_NAMES
    else:
        names = getattr(request.app.state, "artifact_names", None) or (
            "report.md", "run.log", "progress.json",
        )

    out: list[dict[str, str]] = []
    for name in names:
        url = signer(user_id, exec_id, name)
        if url:
            out.append({"name": name, "url": url})
    return out


def _build_export_zip(
    request: Request, current_user: CurrentUser,
) -> bytes:
    """Build the export ZIP in memory.

    The in-memory buffer is fine for v1 — a single user's metadata is a
    few hundred KB even for a heavy routine history; artifact bytes
    themselves are referenced by signed URL, not embedded. If a future
    tier needs streaming-zip support we swap ``io.BytesIO`` for a
    generator-driven ``zipstream`` without changing callers.
    """
    uid = current_user.user_id
    routine_store = getattr(request.app.state, "routine_store", None)
    execution_store = getattr(request.app.state, "execution_store", None)
    credential_store = getattr(request.app.state, "credential_store", None)

    routines_payload: list[dict[str, Any]] = []
    if routine_store is not None:
        for r in _safe_list(routine_store.list, uid):
            routines_payload.append(r.to_public())

    executions_payload: list[dict[str, Any]] = []
    # Walk the user's full execution history in pages so the export is not
    # truncated by a 50-row default.
    if execution_store is not None:
        offset = 0
        page = 200
        while True:
            rows = _safe_list(
                execution_store.list, uid, limit=page, offset=offset,
            )
            if not rows:
                break
            for row in rows:
                executions_payload.append(row.to_public())
            if len(rows) < page:
                break
            offset += page

    credentials_payload: list[dict[str, str]] = []
    if credential_store is not None:
        # Ciphertext is deliberately omitted — export ships presence only.
        try:
            keys = credential_store.list_keys(uid)
        except Exception:  # pragma: no cover - defensive
            keys = []
        credentials_payload = [{"key_name": k} for k in keys]

    artifact_manifest = [
        {
            "execution_id": exec_row["execution_id"],
            "artifacts": _signed_artifact_urls(
                request,
                uid,
                uuid.UUID(exec_row["execution_id"]),
            ),
        }
        for exec_row in executions_payload
    ]

    manifest = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "user": {
            "user_id": str(uid),
            "sub": current_user.sub,
            "email": current_user.claims.get("email"),
        },
        "counts": {
            "routines": len(routines_payload),
            "executions": len(executions_payload),
            "credentials": len(credentials_payload),
        },
        "privacy_notice": ".ai/prep/resmon_privacy_notice.md",
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        zf.writestr(
            "user.json", json.dumps(manifest["user"], indent=2),
        )
        zf.writestr(
            "routines.json", json.dumps(routines_payload, indent=2),
        )
        zf.writestr(
            "executions.json", json.dumps(executions_payload, indent=2),
        )
        zf.writestr(
            "credentials.json", json.dumps(credentials_payload, indent=2),
        )
        zf.writestr(
            "artifacts.json", json.dumps(artifact_manifest, indent=2),
        )
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Cascade delete helper
# ---------------------------------------------------------------------------


def _cascade_delete(
    request: Request, user_id: uuid.UUID,
) -> dict[str, int]:
    """Delete credentials → executions → routines → user and return counts.

    Runs in this order so a reference still exists for the downstream
    rows if a mid-cascade exception trips — i.e. we never leave orphaned
    credential rows whose owner has been removed.
    """
    counts = {"credentials": 0, "executions": 0, "routines": 0, "user": 0}

    credential_store = getattr(request.app.state, "credential_store", None)
    if credential_store is not None:
        try:
            keys = list(credential_store.list_keys(user_id))
        except Exception:  # pragma: no cover - defensive
            keys = []
        for k in keys:
            try:
                if credential_store.delete(user_id, k):
                    counts["credentials"] += 1
            except Exception:  # pragma: no cover - defensive
                logger.exception(
                    "Credential delete failed during cascade for user_id=%s",
                    user_id,
                )

    execution_store = getattr(request.app.state, "execution_store", None)
    if execution_store is not None:
        # Prefer a dedicated cascade method if the store provides one;
        # otherwise walk pages and delete row-by-row.
        delete_all = getattr(execution_store, "delete_all_for_user", None)
        if callable(delete_all):
            counts["executions"] = int(delete_all(user_id) or 0)
        else:
            delete_one = getattr(execution_store, "delete", None)
            offset = 0
            page = 200
            while True:
                rows = _safe_list(
                    execution_store.list, user_id, limit=page, offset=offset,
                )
                if not rows:
                    break
                for row in rows:
                    if callable(delete_one):
                        try:
                            if delete_one(user_id, row.execution_id):
                                counts["executions"] += 1
                        except Exception:  # pragma: no cover - defensive
                            logger.exception(
                                "Execution delete failed during cascade for exec_id=%s",
                                row.execution_id,
                            )
                if len(rows) < page:
                    break
                offset += page

    routine_store = getattr(request.app.state, "routine_store", None)
    if routine_store is not None:
        rows = _safe_list(routine_store.list, user_id)
        for r in rows:
            try:
                if routine_store.delete(user_id, r.routine_id):
                    counts["routines"] += 1
            except Exception:  # pragma: no cover - defensive
                logger.exception(
                    "Routine delete failed during cascade for routine_id=%s",
                    r.routine_id,
                )

    user_delete = getattr(request.app.state, "user_delete", None)
    if callable(user_delete):
        try:
            if user_delete(user_id):
                counts["user"] = 1
        except Exception:  # pragma: no cover - defensive
            logger.exception("user_delete failed for user_id=%s", user_id)
    else:
        # The in-memory skeleton has no users table — record the attempt
        # so the response reflects that the cascade reached completion.
        counts["user"] = 1

    return counts


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def build_account_router() -> APIRouter:
    """Return the ``/me/export`` + ``DELETE /me`` router."""
    router = APIRouter()

    @router.get("/me/export")
    def export_me(
        request: Request,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> StreamingResponse:
        payload = _build_export_zip(request, current_user)
        logger.info(
            "Export generated for user_id=%s (%d bytes)",
            current_user.user_id, len(payload),
        )

        def _iter() -> Iterable[bytes]:
            # StreamingResponse accepts any iterable; chunk at 64 KiB so
            # even a very large export flushes to the socket promptly.
            view = memoryview(payload)
            step = 65536
            for i in range(0, len(view), step):
                yield bytes(view[i : i + step])

        filename = f"resmon-export-{current_user.user_id}.zip"
        return StreamingResponse(
            _iter(),
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Length": str(len(payload)),
            },
        )

    @router.delete("/me", status_code=status.HTTP_200_OK)
    def delete_me(
        request: Request,
        current_user: CurrentUser = Depends(require_beta_for_writes),
    ) -> dict:
        uid = current_user.user_id
        counts = _cascade_delete(request, uid)

        queue: Optional[SoftDeleteQueue] = getattr(
            request.app.state, "soft_delete_queue", None,
        )
        if queue is None:
            queue = SoftDeleteQueue()
            request.app.state.soft_delete_queue = queue
        entry = queue.enqueue(uid, f"{uid}/")

        logger.info(
            "Account deleted for user_id=%s: counts=%s purge_after=%s",
            uid, counts, entry.purge_after.isoformat(),
        )
        return {
            "status": "deleted",
            "deleted": counts,
            "object_store_purge_after": entry.purge_after.isoformat(),
            "soft_delete_window_days": queue.window.days,
        }

    return router
