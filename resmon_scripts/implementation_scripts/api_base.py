# resmon_scripts/implementation_scripts/api_base.py
"""API client framework: NormalizedResult, BaseAPIClient, RateLimiter, retry, safe_request."""

import logging
import threading
import time
import functools
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

import httpx

from .config import DEFAULT_REQUEST_TIMEOUT, DEFAULT_MAX_RETRIES, DEFAULT_BACKOFF_BASE

logger = logging.getLogger(__name__)

# Transient HTTP status codes eligible for retry
_TRANSIENT_CODES = {429, 500, 502, 503, 504}


# ---------------------------------------------------------------------------
# NormalizedResult
# ---------------------------------------------------------------------------

@dataclass
class NormalizedResult:
    """Common internal schema for all repository results."""
    source_repository: str
    external_id: str
    doi: str | None
    title: str
    authors: list[str]
    abstract: str | None
    publication_date: str | None
    url: str
    categories: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# BaseAPIClient
# ---------------------------------------------------------------------------

class BaseAPIClient(ABC):
    """Abstract base class for all repository API clients."""

    # Per-execution scope id, set by the sweep engine before dispatching a
    # search.  Client implementations should use
    # ``credential_manager.get_credential_for(self._exec_id, name)`` so that
    # per-execution (ephemeral) keys are honored.  ``None`` means no
    # execution context, in which case credential lookup falls back to the
    # persisted keyring.
    _exec_id: int | None = None

    @abstractmethod
    def search(
        self,
        query: str,
        date_from: str | None = None,
        date_to: str | None = None,
        max_results: int = 100,
        **kwargs,
    ) -> list[NormalizedResult]:
        """Execute a search query and return normalized results."""
        ...

    @abstractmethod
    def get_name(self) -> str:
        """Return the human-readable repository name."""
        ...


# ---------------------------------------------------------------------------
# RateLimiter — token-bucket
# ---------------------------------------------------------------------------

class RateLimiter:
    """Token-bucket rate limiter with configurable requests per second.

    Thread-safe. Each ``api_*`` module holds one module-level limiter shared by
    every client for that source, so concurrent executions genuinely contend on
    the same object: resmon admits up to 8 executions at once and each one can
    be sweeping the same repository.

    The lock is load-bearing. Without it, every waiting thread read the same
    ``_last_call``, computed the same delay, slept the same amount, and then
    fired together - so the effective request rate was multiplied by the number
    of concurrent sweeps. Measured against arXiv's 0.33 req/s setting, four
    concurrent sweeps issued all four requests within 0.00 s of each other
    (1.32 req/s, four times the advertised ceiling) instead of spacing them
    three seconds apart. Providers answer that with 429s and, on repeat, a
    temporary IP block.

    The sleep is held inside the lock deliberately: the point is to serialize
    callers, so a thread must not be able to claim a slot while another is
    still waiting for its own.
    """

    def __init__(self, requests_per_second: float = 1.0):
        self._interval = 1.0 / requests_per_second
        self._last_call: float = 0.0
        self._lock = threading.Lock()

    def acquire(self) -> None:
        """Block until the next request is permitted."""
        with self._lock:
            elapsed = time.monotonic() - self._last_call
            if elapsed < self._interval:
                time.sleep(self._interval - elapsed)
            self._last_call = time.monotonic()


# ---------------------------------------------------------------------------
# retry_with_backoff
# ---------------------------------------------------------------------------

def retry_with_backoff(
    func=None,
    *,
    max_retries: int = DEFAULT_MAX_RETRIES,
    backoff_base: float = DEFAULT_BACKOFF_BASE,
    transient_codes: set[int] = _TRANSIENT_CODES,
):
    """Decorator for exponential backoff on transient HTTP errors.

    Can be used as ``@retry_with_backoff`` or ``@retry_with_backoff(max_retries=5)``.
    The decorated function must return an ``httpx.Response``.
    """
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            last_exc: Exception | None = None
            for attempt in range(max_retries + 1):
                try:
                    response = fn(*args, **kwargs)
                    if isinstance(response, httpx.Response) and response.status_code in transient_codes:
                        if attempt < max_retries:
                            wait = backoff_base ** attempt
                            logger.warning(
                                "Transient %d from %s — retry %d/%d in %.1fs",
                                response.status_code, response.url, attempt + 1, max_retries, wait,
                            )
                            time.sleep(wait)
                            continue
                    return response
                except (httpx.TimeoutException, httpx.ConnectError) as exc:
                    last_exc = exc
                    if attempt < max_retries:
                        wait = backoff_base ** attempt
                        logger.warning(
                            "%s — retry %d/%d in %.1fs", exc, attempt + 1, max_retries, wait,
                        )
                        time.sleep(wait)
                    else:
                        raise
            raise last_exc  # type: ignore[misc]
        return wrapper

    # Support bare @retry_with_backoff (no parentheses)
    if func is not None:
        return decorator(func)
    return decorator


# ---------------------------------------------------------------------------
# safe_request
# ---------------------------------------------------------------------------

def safe_request(
    method: str,
    url: str,
    *,
    rate_limiter: RateLimiter | None = None,
    timeout: float = DEFAULT_REQUEST_TIMEOUT,
    max_retries: int = DEFAULT_MAX_RETRIES,
    backoff_base: float = DEFAULT_BACKOFF_BASE,
    **kwargs,
) -> httpx.Response:
    """HTTP request wrapper integrating rate limiting, retries, and error logging.

    Parameters
    ----------
    method : str
        HTTP method (``"GET"``, ``"POST"``, etc.).
    url : str
        Target URL.
    rate_limiter : RateLimiter | None
        If provided, ``acquire()`` is called before each attempt.
    timeout : float
        Request timeout in seconds.
    max_retries : int
        Number of retry attempts for transient errors.
    backoff_base : float
        Base for exponential backoff calculation.
    **kwargs
        Forwarded to ``httpx.Client.request()``.

    Returns
    -------
    httpx.Response
    """
    last_exc: Exception | None = None

    # Ensure a descriptive User-Agent — several scholarly APIs (notably
    # arXiv and CORE) return 5xx or 403 for requests with the default
    # httpx user agent.
    headers = dict(kwargs.pop("headers", {}) or {})
    if not any(k.lower() == "user-agent" for k in headers):
        headers["User-Agent"] = "resmon/1.0 (+https://github.com/rkamp-research/resmon)"

    for attempt in range(max_retries + 1):
        if rate_limiter is not None:
            rate_limiter.acquire()
        try:
            with httpx.Client(timeout=timeout, follow_redirects=True) as client:
                response = client.request(method, url, headers=headers, **kwargs)

            if response.status_code in _TRANSIENT_CODES and attempt < max_retries:
                wait = backoff_base ** attempt
                logger.warning(
                    "safe_request: transient %d from %s — retry %d/%d in %.1fs",
                    response.status_code, url, attempt + 1, max_retries, wait,
                )
                time.sleep(wait)
                continue

            return response

        except (httpx.TimeoutException, httpx.ConnectError) as exc:
            last_exc = exc
            if attempt < max_retries:
                wait = backoff_base ** attempt
                logger.warning(
                    "safe_request: %s for %s — retry %d/%d in %.1fs",
                    exc, url, attempt + 1, max_retries, wait,
                )
                time.sleep(wait)
            else:
                logger.error("safe_request: exhausted retries for %s: %s", url, exc)
                raise

    raise last_exc  # type: ignore[misc]
