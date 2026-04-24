"""Per-user rate limiting and polite User-Agent construction for the cloud
worker path (IMPL-33 / §10.3).

This module is only imported by cloud-side code (worker, routines,
executions). Local desktop execution paths are unaffected: the contextvar
hook installed on :mod:`implementation_scripts.api_base` defaults to
``None`` and :func:`safe_request` preserves its existing behavior unless a
cloud hook is explicitly installed via :func:`use_cloud_hook`.

Design
------

* **User-Agent.** Per §10.3 the cloud worker emits
  ``resmon-cloud/<version> (+mailto:<hash>@resmon.invalid)`` where ``hash``
  is ``hashlib.sha256(user_id_str).hexdigest()[:12]`` — an opaque 12-hex
  handle upstream maintainers can use to identify abuse without exposing
  the user's real email.

* **Per-user token bucket.** An additional limiter stacked **on top of**
  ``api_base.RateLimiter`` so a single user running 10 concurrent cloud
  executions cannot exhaust a shared upstream quota (e.g. arXiv polite
  use). Buckets are keyed ``user:<uid>:repo:<slug>`` in Redis (or a
  thread-safe in-memory backend for tests and REDIS_URL-less dev).

The backend is a minimal classical token bucket:
``capacity`` tokens, refilling at ``refill_per_sec`` per second. Calling
:meth:`TokenBucketBackend.take` atomically withdraws one token, returning
the number of seconds the caller should ``time.sleep`` before proceeding
(``0.0`` if a token was available immediately).
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable, Dict, Optional, Protocol, Tuple
from urllib.parse import urlparse


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# User-Agent construction
# ---------------------------------------------------------------------------

#: Bundled version used in the polite User-Agent. Bumped in lockstep with
#: ``pyproject.toml`` / the docs; kept as a module constant so tests can
#: assert the exact string without importing the whole package.
CLOUD_USER_AGENT_VERSION = "1.0"


def opaque_user_hash(user_id_str: str) -> str:
    """Return the first 12 hex chars of ``sha256(user_id_str)`` (§10.3).

    The input is stringified by the caller — UUIDs must be passed as their
    canonical string form so the hash is stable across processes.
    """
    return hashlib.sha256(user_id_str.encode("utf-8")).hexdigest()[:12]


def build_user_agent(
    user_id_str: str, *, version: str = CLOUD_USER_AGENT_VERSION
) -> str:
    """Construct the §10.3 per-user polite User-Agent header value."""
    return (
        f"resmon-cloud/{version} "
        f"(+mailto:{opaque_user_hash(user_id_str)}@resmon.invalid)"
    )


# ---------------------------------------------------------------------------
# Token bucket backends
# ---------------------------------------------------------------------------


class TokenBucketBackend(Protocol):
    """Pluggable backing store for the per-user token bucket."""

    def take(
        self, key: str, *, capacity: float, refill_per_sec: float
    ) -> float:
        """Withdraw one token. Return seconds the caller must sleep (>=0)."""
        ...


class InMemoryTokenBucket:
    """Thread-safe in-memory token bucket.

    Used in tests and whenever ``REDIS_URL`` is unset. Identical math to
    the Redis implementation so the pytest harness is a faithful proxy.
    """

    def __init__(self) -> None:
        self._state: Dict[str, Tuple[float, float]] = {}
        self._lock = threading.Lock()

    def take(
        self, key: str, *, capacity: float, refill_per_sec: float
    ) -> float:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._state.get(key, (capacity, now))
            # Refill based on time elapsed since last observation.
            tokens = min(capacity, tokens + (now - last) * refill_per_sec)
            if tokens >= 1.0:
                self._state[key] = (tokens - 1.0, now)
                return 0.0
            # Not enough; compute wait, reserve token for the caller by
            # advancing ``last`` so concurrent callers queue in order.
            wait = (1.0 - tokens) / refill_per_sec
            self._state[key] = (tokens - 1.0, now)
            return wait


class RedisTokenBucket:
    """Redis-backed token bucket using a Lua script for atomicity.

    Instantiated lazily by :func:`build_backend` only when a real
    ``REDIS_URL`` is configured; the ``redis`` package is imported inside
    the constructor so it is never a hard dependency of the test suite.
    """

    _LUA = """
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refill = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local data = redis.call('HMGET', key, 'tokens', 'ts')
    local tokens = tonumber(data[1])
    local ts = tonumber(data[2])
    if tokens == nil then
        tokens = capacity
        ts = now
    end
    local delta = math.max(0, now - ts)
    tokens = math.min(capacity, tokens + delta * refill)
    local wait = 0
    if tokens >= 1 then
        tokens = tokens - 1
    else
        wait = (1 - tokens) / refill
        tokens = tokens - 1
    end
    redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
    redis.call('EXPIRE', key, 3600)
    return tostring(wait)
    """

    def __init__(self, redis_url: str) -> None:
        import redis  # type: ignore

        self._client = redis.Redis.from_url(redis_url)
        self._script = self._client.register_script(self._LUA)

    def take(
        self, key: str, *, capacity: float, refill_per_sec: float
    ) -> float:
        wait = self._script(
            keys=[key],
            args=[capacity, refill_per_sec, time.time()],
        )
        return float(wait)


def build_backend(redis_url: Optional[str]) -> TokenBucketBackend:
    """Return a Redis-backed bucket when ``redis_url`` is set; else in-memory."""
    if redis_url:
        try:
            return RedisTokenBucket(redis_url)
        except Exception as exc:  # pragma: no cover - operational fallback
            logger.warning(
                "Falling back to in-memory token bucket; Redis init failed: %s",
                exc,
            )
    return InMemoryTokenBucket()


# ---------------------------------------------------------------------------
# Per-user gate
# ---------------------------------------------------------------------------


#: Conservative default per-repo allowance (tokens/sec). Individual repos
#: may override via the ``repo_limits`` map on :class:`CloudRequestHook`.
DEFAULT_REPO_RATE = 1.0
DEFAULT_REPO_CAPACITY = 3.0


@dataclass
class CloudRequestHook:
    """Attached to a contextvar in :mod:`api_base` for the duration of a
    cloud worker's sweep. ``safe_request`` consults the active hook to
    (a) override the User-Agent, and (b) ``acquire`` a per-user token
    before each outbound attempt.
    """

    user_id: str
    user_agent: str
    backend: TokenBucketBackend
    repo_limits: Dict[str, Tuple[float, float]] = field(default_factory=dict)
    default_capacity: float = DEFAULT_REPO_CAPACITY
    default_refill: float = DEFAULT_REPO_RATE

    @classmethod
    def build(
        cls,
        user_id: str,
        *,
        backend: TokenBucketBackend,
        repo_limits: Optional[Dict[str, Tuple[float, float]]] = None,
    ) -> "CloudRequestHook":
        return cls(
            user_id=user_id,
            user_agent=build_user_agent(user_id),
            backend=backend,
            repo_limits=dict(repo_limits or {}),
        )

    def _key(self, repo_slug: str) -> str:
        return f"user:{self.user_id}:repo:{repo_slug}"

    def acquire(self, repo_slug: str) -> None:
        """Block until a token is available for (user, repo_slug)."""
        capacity, refill = self.repo_limits.get(
            repo_slug, (self.default_capacity, self.default_refill)
        )
        wait = self.backend.take(
            self._key(repo_slug), capacity=capacity, refill_per_sec=refill
        )
        if wait > 0:
            time.sleep(wait)

    # ------------------------------------------------------------------
    # URL-based adapter used by ``safe_request`` (which only has the URL)
    # ------------------------------------------------------------------

    def acquire_for_url(self, url: str) -> None:
        self.acquire(_slug_from_url(url))


def _slug_from_url(url: str) -> str:
    """Derive a repo slug from an outbound URL.

    ``safe_request`` is a generic helper — it does not know which client
    issued the call. Using the parsed hostname as the repo slug keeps the
    Redis key stable across requests to the same upstream (arXiv's
    ``export.arxiv.org``, CrossRef's ``api.crossref.org``, …) and matches
    the §10.3 intent of "per-repository" limits.
    """
    try:
        host = urlparse(url).hostname or ""
    except Exception:  # pragma: no cover
        host = ""
    return host or "unknown"


# ---------------------------------------------------------------------------
# Contextvar installation
# ---------------------------------------------------------------------------


@contextmanager
def use_cloud_hook(hook: Optional[CloudRequestHook]):
    """Install ``hook`` on :mod:`api_base` for the duration of the block.

    Imported lazily to avoid a cycle at module load time.
    """
    from resmon_scripts.implementation_scripts import api_base  # local import

    token = api_base.set_cloud_request_hook(hook)
    try:
        yield hook
    finally:
        api_base.reset_cloud_request_hook(token)


# ---------------------------------------------------------------------------
# Convenience factory used by the worker
# ---------------------------------------------------------------------------


def build_hook_for_user(
    user_id: str,
    *,
    redis_url: Optional[str],
    repo_limits: Optional[Dict[str, Tuple[float, float]]] = None,
) -> CloudRequestHook:
    """One-shot construction used by :func:`cloud.worker.run_routine_job`."""
    return CloudRequestHook.build(
        user_id=user_id,
        backend=build_backend(redis_url),
        repo_limits=repo_limits,
    )
