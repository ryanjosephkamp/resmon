# resmon_scripts/implementation_scripts/api_base.py
"""API client framework: NormalizedResult, BaseAPIClient, RateLimiter, retry, safe_request."""

import logging
import time
import functools
from abc import ABC, abstractmethod
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from .config import DEFAULT_REQUEST_TIMEOUT, DEFAULT_MAX_RETRIES, DEFAULT_BACKOFF_BASE

logger = logging.getLogger(__name__)

# Transient HTTP status codes eligible for retry
_TRANSIENT_CODES = {429, 500, 502, 503, 504}


# ---------------------------------------------------------------------------
# Cloud request hook (IMPL-33 / §10.3)
#
# When the cloud worker installs a hook via ``cloud.rate_limit.use_cloud_hook``
# each outbound ``safe_request`` (a) acquires a per-user / per-repo token
# from the hook's bucket before every attempt and (b) overrides the
# User-Agent with the polite ``resmon-cloud/...`` string so upstream
# maintainers can identify abusive users without exposing their email.
#
# Default is ``None``; local desktop execution paths are unaffected.
# ``Any`` avoids a circular import with ``cloud.rate_limit``.
# ---------------------------------------------------------------------------

_cloud_request_hook: ContextVar[Optional[Any]] = ContextVar(
    "resmon_cloud_request_hook", default=None
)


def set_cloud_request_hook(hook: Optional[Any]) -> Token:
    """Install a cloud request hook in the current context; return its token."""
    return _cloud_request_hook.set(hook)


def reset_cloud_request_hook(token: Token) -> None:
    """Restore the previous hook using the token from :func:`set_cloud_request_hook`."""
    _cloud_request_hook.reset(token)


def get_cloud_request_hook() -> Optional[Any]:
    return _cloud_request_hook.get()


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
    """Token-bucket rate limiter with configurable requests per second."""

    def __init__(self, requests_per_second: float = 1.0):
        self._interval = 1.0 / requests_per_second
        self._last_call: float = 0.0

    def acquire(self) -> None:
        """Block until the next request is permitted."""
        now = time.monotonic()
        elapsed = now - self._last_call
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
    # httpx user agent.  When a cloud request hook is installed the
    # per-user polite User-Agent (§10.3) takes precedence over any caller-
    # supplied UA so upstream rate-limit attribution remains stable.
    headers = dict(kwargs.pop("headers", {}) or {})
    hook = _cloud_request_hook.get()
    if hook is not None and getattr(hook, "user_agent", None):
        headers["User-Agent"] = hook.user_agent
    elif not any(k.lower() == "user-agent" for k in headers):
        headers["User-Agent"] = "resmon/1.0 (+https://github.com/rkamp-research/resmon)"

    for attempt in range(max_retries + 1):
        if hook is not None:
            # Per-user token bucket, acquired BEFORE the per-client base
            # limiter so a noisy single user cannot starve another.
            hook.acquire_for_url(url)
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
