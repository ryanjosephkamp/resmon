"""Per-user API rate limiting, concurrency caps, and max-routines quota
(IMPL-39 / §13).

Three independent mechanisms are exposed:

* :class:`RateLimiter` — token-bucket limiter keyed on ``(user_sub, kind)``
  where ``kind`` is ``"read"`` (60 rpm default) or ``"write"`` (300 rpm
  default). Exceeding the budget returns HTTP 429.
* :class:`ConcurrencySemaphore` — in-process semaphore keyed on ``user_sub``
  capping concurrent cloud executions per user (default 10).
* :func:`enforce_max_routines` — a helper called by the routines-create
  endpoint that raises HTTP 429 when the user's live routine count meets
  or exceeds ``rate_limit_max_routines``.

Per §13 the limits are configurable via environment variables
(``RATE_LIMIT_*`` in :mod:`cloud.config`). The implementation is
deliberately in-process: a single-node deployment (ADQ-9) is the v1
target, so a distributed token bucket (Redis) is not required yet. When
the service scales horizontally, the same public surface can be
re-implemented against Redis without touching the call sites.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Dict, Optional, Tuple

from fastapi import HTTPException, Request, status
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


# ---------------------------------------------------------------------------
# Token bucket
# ---------------------------------------------------------------------------


@dataclass
class _Bucket:
    tokens: float
    last_refill: float


class RateLimiter:
    """Classical token-bucket limiter keyed on ``(sub, kind)``.

    ``capacity`` tokens refilled linearly at ``rate_per_sec = capacity / 60``
    so a limit expressed as "N per minute" is enforced on a moving window
    with burst size ``N``. Thread-safe under :class:`threading.Lock`.
    """

    def __init__(self, *, reads_per_min: int, writes_per_min: int) -> None:
        self._caps: Dict[str, int] = {
            "read": int(reads_per_min),
            "write": int(writes_per_min),
        }
        self._buckets: Dict[Tuple[str, str], _Bucket] = {}
        self._lock = threading.Lock()

    def capacity(self, kind: str) -> int:
        return self._caps[kind]

    def _refill(self, bucket: _Bucket, cap: int, now: float) -> None:
        rate = cap / 60.0
        elapsed = max(0.0, now - bucket.last_refill)
        bucket.tokens = min(float(cap), bucket.tokens + elapsed * rate)
        bucket.last_refill = now

    def take(self, sub: str, kind: str) -> bool:
        """Consume one token for ``sub`` under ``kind``; return True on success."""
        cap = self._caps[kind]
        key = (sub, kind)
        now = time.monotonic()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = _Bucket(tokens=float(cap), last_refill=now)
                self._buckets[key] = bucket
            else:
                self._refill(bucket, cap, now)
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return True
            return False


# ---------------------------------------------------------------------------
# Concurrency cap
# ---------------------------------------------------------------------------


class ConcurrencySemaphore:
    """In-process per-user semaphore for bounded concurrent executions."""

    def __init__(self, *, max_concurrent: int) -> None:
        self._cap = int(max_concurrent)
        self._current: Dict[str, int] = {}
        self._lock = threading.Lock()

    @property
    def max_concurrent(self) -> int:
        return self._cap

    def try_acquire(self, sub: str) -> bool:
        with self._lock:
            cur = self._current.get(sub, 0)
            if cur >= self._cap:
                return False
            self._current[sub] = cur + 1
            return True

    def release(self, sub: str) -> None:
        with self._lock:
            cur = self._current.get(sub, 0)
            if cur <= 1:
                self._current.pop(sub, None)
            else:
                self._current[sub] = cur - 1

    def in_flight(self, sub: str) -> int:
        with self._lock:
            return self._current.get(sub, 0)


# ---------------------------------------------------------------------------
# Max-routines quota
# ---------------------------------------------------------------------------


def enforce_max_routines(current_count: int, max_routines: int) -> None:
    """Raise HTTP 429 if the user has reached the per-account routine cap."""
    if current_count >= max_routines:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"Per-user routine cap reached ({max_routines}). "
                "Delete an existing routine before creating a new one."
            ),
        )


# ---------------------------------------------------------------------------
# FastAPI middleware
# ---------------------------------------------------------------------------


# HTTP verbs counted as reads (cheap) versus writes (mutating).
_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# Paths excluded from the limiter entirely.
_EXEMPT_PATHS: Tuple[str, ...] = (
    "/api/v2/health",
    "/status",
    "/metrics",
)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Enforce :class:`RateLimiter` against every ``/api/v2/*`` request.

    Identity extraction:

    * If the request arrives with ``Authorization: Bearer <jwt>``, decode
      **without verification** and use the ``sub`` claim as the key —
      signature verification happens later in :func:`get_current_user`, so
      an unverified decode here is safe (the token will be rejected by
      the auth dependency if it is forged, but we still want to scope
      pre-auth limiter state to the claimed ``sub``).
    * If no token is present, the request is limited under a synthetic
      ``anon:<client-host>`` key using a single shared bucket.
    """

    def __init__(self, app, limiter: RateLimiter) -> None:
        super().__init__(app)
        self._limiter = limiter

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        path = request.url.path
        if not path.startswith("/api/v2") or path in _EXEMPT_PATHS:
            return await call_next(request)

        sub = _identify_sub(request)
        kind = "read" if request.method.upper() in _READ_METHODS else "write"
        if not self._limiter.take(sub, kind):
            cap = self._limiter.capacity(kind)
            return _too_many(
                f"Rate limit exceeded: {cap} {kind}s/min for user {sub[:8]}…"
            )
        return await call_next(request)


def _identify_sub(request: Request) -> str:
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        token = auth.split(None, 1)[1].strip()
        sub = _unverified_sub(token)
        if sub:
            return sub
    client = request.client
    host = client.host if client else "unknown"
    return f"anon:{host}"


def _unverified_sub(token: str) -> Optional[str]:
    """Decode a JWT without verifying the signature, return its ``sub``.

    This is only used to scope the rate-limiter bucket. The full
    signature verification still happens in :func:`auth.get_current_user`.
    """
    try:
        import jwt as _jwt

        claims = _jwt.decode(token, options={"verify_signature": False})
    except Exception:
        return None
    sub = claims.get("sub") if isinstance(claims, dict) else None
    return str(sub) if sub else None


def _too_many(detail: str) -> Response:
    # Return a JSON body identical to FastAPI's default HTTPException shape so
    # clients can parse ``.detail`` regardless of whether the 429 originated
    # in middleware or in a route.
    import json

    return Response(
        content=json.dumps({"detail": detail}),
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        media_type="application/json",
    )
