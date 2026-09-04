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

from . import config

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
    max_retries: int = config.DEFAULT_MAX_RETRIES,
    backoff_base: float = config.DEFAULT_BACKOFF_BASE,
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
# SearchOutcome — the channel a search uses to say why it came back empty
# ---------------------------------------------------------------------------
#
# A source that returns zero and a source that could not be reached are the
# same thing to every caller in this codebase: ``search()`` returns ``[]`` and
# the engine records ``ok / 0``. A 503 and an empty result field are
# byte-identical by the time anyone can look at them, which is why resmon has
# never been able to tell a user why nothing came back.
#
# This channel carries the one fact that is missing: what the *last* HTTP call
# a search made actually did. It is written here, inside ``safe_request``, so
# no client needs editing for an outage to be recorded -- every client routes
# its HTTP through this function. Clients only speak up for the things the
# HTTP status cannot say: a window the source cannot answer at all, a reply
# that would not parse, records dropped on their rights statement.
#
# Thread-local rather than a parameter because ``client.search()`` is a public
# contract with 25 implementations and threading an out-parameter through all
# of them (and through each client's own pagination loop) is a larger change
# with more places to get it wrong. The sweep engine runs exactly one search
# per thread -- ``_search_with_heartbeat`` starts a fresh thread per source --
# and resets the channel at the top of that thread, so a stale value from
# ``lifecycle.py`` (which also calls ``safe_request``, outside any search)
# cannot leak into a search's outcome. ``ContextVar`` would work identically
# here; the guard is the same either way and is a test, not the mechanism.


@dataclass
class SearchOutcome:
    """What the HTTP calls of one ``search()`` did.

    ``attempts`` and ``failures`` count every call the search made; the
    ``last_*`` fields describe only the **most recent** one, because that is
    the call whose outcome explains the empty list. A paginated search whose
    third page 503s has both a success and a failure on record, and the
    failure is the one that ended it.
    """

    attempts: int = 0
    failures: int = 0
    last_call_failed: bool = False
    last_detail: str | None = None
    last_status: int | None = None
    explicit_reason: str | None = None
    explicit_detail: dict | None = None

    def reset(self) -> None:
        self.attempts = 0
        self.failures = 0
        self.last_call_failed = False
        self.last_detail = None
        self.last_status = None
        self.explicit_reason = None
        self.explicit_detail = None

    # -- written by safe_request ------------------------------------------

    def note_attempt(self) -> None:
        self.attempts += 1
        self.last_call_failed = False
        self.last_detail = None
        self.last_status = None

    def note_failure(self, status_or_exc, url: str = "") -> None:
        """Record that the call that just finished did not answer.

        ``url`` is accepted so call sites read naturally and is deliberately
        **not stored**: several sources take their API key as a query
        parameter, so a URL kept in the database and rendered into a search
        record would put a user's credential on screen and into an export.
        """
        self.failures += 1
        self.last_call_failed = True
        if isinstance(status_or_exc, int):
            self.last_status = status_or_exc
            # 429 is its own fact -- the source answered and refused on rate
            # -- and a user can act on it differently from a 500.
            self.last_detail = "rate_limited" if status_or_exc == 429 else f"http_{status_or_exc}"
        elif isinstance(status_or_exc, httpx.TimeoutException):
            self.last_status = None
            self.last_detail = "timeout"
        elif isinstance(status_or_exc, httpx.ConnectError):
            self.last_status = None
            self.last_detail = "connect"
        else:
            self.last_status = None
            self.last_detail = "request_error"

    # -- written by clients, for what the status code cannot say -----------

    def note_unanswerable(self, why: str) -> None:
        """The source cannot answer this window at all, and was not asked."""
        self.explicit_reason = "window_unanswerable"
        self.explicit_detail = {"detail": why}

    def note_parse_failure(self, why: str = "parse_error") -> None:
        """The source answered and resmon could not read the reply."""
        self.explicit_reason = "parse_failure"
        self.explicit_detail = {"detail": why}

    def note_filtered(self, matched: int, kept: int, why: str, **counts) -> None:
        """The source answered with records resmon is not allowed to keep."""
        self.explicit_reason = (
            "rights_filtered" if why == "rights" else "records_unusable"
        )
        detail = {"detail": why, "matched": int(matched), "kept": int(kept)}
        detail.update({k: int(v) for k, v in counts.items()})
        self.explicit_detail = detail

    def snapshot(self) -> dict:
        """A plain dict of the channel, safe to hand across threads."""
        return {
            "attempts": self.attempts,
            "failures": self.failures,
            "last_call_failed": self.last_call_failed,
            "last_detail": self.last_detail,
            "last_status": self.last_status,
            "explicit_reason": self.explicit_reason,
            "explicit_detail": dict(self.explicit_detail) if self.explicit_detail else None,
        }


_outcome_local = threading.local()


def search_outcome() -> SearchOutcome:
    """This thread's outcome channel, created on first use."""
    outcome = getattr(_outcome_local, "outcome", None)
    if outcome is None:
        outcome = SearchOutcome()
        _outcome_local.outcome = outcome
    return outcome


def reset_search_outcome() -> None:
    search_outcome().reset()


def note_unanswerable(why: str) -> None:
    search_outcome().note_unanswerable(why)


def note_parse_failure(why: str = "parse_error") -> None:
    search_outcome().note_parse_failure(why)


def note_filtered(matched: int, kept: int, why: str, **counts) -> None:
    search_outcome().note_filtered(matched, kept, why, **counts)


def note_parse_failure_unless_transport(exc: BaseException, why: str = "parse_error") -> None:
    """Record a parse failure only when the reply itself was the problem.

    Several clients wrap the request and ``response.json()`` in one ``try``,
    so a single ``except Exception`` covers both "the source never answered"
    and "the source answered with something unreadable". Those are different
    facts and the second must not be written over the first: ``safe_request``
    has already recorded a transport failure, and calling the reply
    unreadable would tell the user the source answered when it did not.
    """
    if isinstance(exc, httpx.HTTPError):
        return
    search_outcome().note_parse_failure(why)


# ---------------------------------------------------------------------------
# safe_request
# ---------------------------------------------------------------------------

def safe_request(
    method: str,
    url: str,
    *,
    rate_limiter: RateLimiter | None = None,
    timeout: float | None = None,
    max_retries: int | None = None,
    backoff_base: float | None = None,
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
    timeout : float | None
        Request timeout in seconds. ``None`` reads ``config`` **at call time**.
    max_retries : int | None
        Retry attempts for transient errors. ``None`` reads ``config`` at call
        time.
    backoff_base : float | None
        Base for exponential backoff. ``None`` reads ``config`` at call time.
    **kwargs
        Forwarded to ``httpx.Client.request()``.

    Returns
    -------
    httpx.Response
    """
    # Read the knobs at call time rather than binding them as default
    # arguments at import time. Bound defaults made the failure paths
    # effectively untestable: a real-loopback test of an exhausted 503 slept
    # 1 + 2 + 4 = 7 s, and an exhausted timeout ~127 s, on every Python in
    # CI's matrix. A test can now shrink them by setting the config values,
    # which is also how a future settings screen would change them.
    if timeout is None:
        timeout = config.DEFAULT_REQUEST_TIMEOUT
    if max_retries is None:
        max_retries = config.DEFAULT_MAX_RETRIES
    if backoff_base is None:
        backoff_base = config.DEFAULT_BACKOFF_BASE

    outcome = search_outcome()
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
        outcome.note_attempt()
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

            # The call that is about to be returned is the one that explains
            # an empty result list, so its outcome is recorded here rather
            # than left to every client to notice. A non-2xx returned to a
            # client is a source that did not answer -- every client breaks
            # out of its loop and returns [], and without this the record
            # would read "answered, zero results".
            if not 200 <= response.status_code < 300:
                outcome.note_failure(response.status_code, url)
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
                outcome.note_failure(exc, url)
                raise

    raise last_exc  # type: ignore[misc]
