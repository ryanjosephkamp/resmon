# resmon_scripts/implementation_scripts/ai_errors.py
"""Structured AI failures: what broke, in which lane, and whether the lane survives.

Before this module an AI failure became a string in the task log. That is enough
for a human reading one run and not enough for anything else: the watchdog could
not tell that every summary in a run had failed, the report could not say which
provider actually produced the summaries it shows, and a fallback chain had no
way to decide whether trying the next lane was the right response or a waste.

The distinction that does the work here is **lane-fatal versus document-local**.

*Lane-fatal* means this lane cannot work for the rest of this run — a rejected
key, an exhausted quota, a model that does not exist, a CLI that is not
installed. Retrying it once per paper burns the whole execution discovering the
same thing two hundred times.

*Document-local* means the lane is fine and this particular paper is not — an
abstract past the context window, content the provider declined, a one-off
upstream blip. Abandoning a working lane over one long abstract silently
downgrades every summary after it.

Both mistakes are expensive and they are opposite mistakes, which is why the
classification is a first-class thing rather than an if-statement at the call
site. It is the same discipline the watchdog applies in holding ``broken`` (a
recorded fact) apart from ``unusual`` (an inference).

**No credential value ever reaches an AIError.** ``sanitize`` is applied in the
constructor path, not left to callers to remember.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

__all__ = [
    "AIErrorKind",
    "AIError",
    "classify_exception",
    "sanitize",
    "LANE_FATAL_KINDS",
]


class AIErrorKind(str, Enum):
    """Why an AI call failed, at the granularity a caller can act on."""

    # Lane-fatal — the lane is done for this run.
    AUTH = "auth"                 # key rejected, missing, or revoked
    QUOTA = "quota"               # rate limited or usage exhausted
    NETWORK = "network"           # provider unreachable at all
    UNSUPPORTED = "unsupported"   # model does not exist for this key
    CLI_MISSING = "cli_missing"   # subscription lane: binary not found
    CLI_AUTH = "cli_auth"         # subscription lane: CLI not logged in

    # Document-local — this paper failed, the lane did not.
    CONTEXT = "context"           # input longer than the context window
    CONTENT = "content"           # provider declined the content
    UNKNOWN = "unknown"           # unrecognised; recorded rather than guessed


LANE_FATAL_KINDS: frozenset[AIErrorKind] = frozenset({
    AIErrorKind.AUTH,
    AIErrorKind.QUOTA,
    AIErrorKind.NETWORK,
    AIErrorKind.UNSUPPORTED,
    AIErrorKind.CLI_MISSING,
    AIErrorKind.CLI_AUTH,
})


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------
#
# Two layers, because they fail differently. The exact-value replacement is
# reliable but only works when the caller knows the key. The shape patterns
# catch a key that arrived from somewhere the caller did not expect -- an
# upstream echoing a header back, say -- at the cost of occasionally redacting
# something that merely looks like a key. That trade is deliberate: a
# false-positive redaction is a cosmetic loss, a leaked key is not.

_KEY_SHAPES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"),        # OpenAI and lookalikes
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}"),    # Anthropic
    re.compile(r"\bAIza[A-Za-z0-9_\-]{20,}"),       # Google
    re.compile(r"\bxai-[A-Za-z0-9_\-]{16,}"),       # xAI
    re.compile(r"\bBearer\s+[A-Za-z0-9._\-]{16,}", re.IGNORECASE),
)

_REDACTED = "[REDACTED]"


def sanitize(message: Any, secret: str | None = None) -> str:
    """Return *message* as a string with any credential material removed."""
    text = "" if message is None else str(message)
    if secret:
        text = text.replace(secret, _REDACTED)
    for pattern in _KEY_SHAPES:
        text = pattern.sub(_REDACTED, text)
    return text


# ---------------------------------------------------------------------------
# The error
# ---------------------------------------------------------------------------

@dataclass
class AIError(RuntimeError):
    """A classified AI failure carrying everything a report needs and no secrets.

    Inherits ``RuntimeError`` rather than ``Exception`` because that is what the
    remote client raised before 1.8. Anything already catching ``RuntimeError``
    from a summarize call keeps working -- an exception type is part of a
    contract, and functionality never decreases.

    ``credential_alias`` is the *name* of a keyring slot (``anthropic_api_key``),
    never its contents. Nothing in this class holds a credential value.
    """

    kind: AIErrorKind
    message: str
    lane_label: str = ""
    provider: str = ""
    model: str = ""
    credential_alias: Optional[str] = None
    http_status: Optional[int] = None
    retry_after: Optional[float] = None
    detail: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Sanitising here rather than at call sites means a new caller cannot
        # forget. The shape patterns run even when no secret was passed.
        self.message = sanitize(self.message)
        super().__init__(self.message)

    @property
    def lane_fatal(self) -> bool:
        """True when the lane should be demoted for the rest of the run."""
        return self.kind in LANE_FATAL_KINDS

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.message

    def to_record(self) -> dict:
        """Flatten to the columns ``execution_ai`` stores."""
        return {
            "error_kind": self.kind.value,
            "http_status": self.http_status,
            "safe_message": self.message,
        }


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

_CONTEXT_MARKERS = (
    "context_length_exceeded",
    "context length",
    "prompt is too long",
    "maximum context",
    "too many tokens",
    "reduce the length",
)

_CONTENT_MARKERS = (
    "content_filter",
    "content policy",
    "safety",
    "responsible ai",
    "blocked by",
)

_AUTH_MARKERS = (
    "invalid api key",
    "incorrect api key",
    "unauthorized",
    "authentication",
    "invalid_api_key",
    "permission denied",
)

_QUOTA_MARKERS = (
    "rate limit",
    "rate_limit",
    "quota",
    "insufficient_quota",
    "too many requests",
    "usage limit",
)

_MODEL_MARKERS = (
    "model not found",
    "does not exist",
    "unknown model",
    "invalid model",
    "model_not_found",
)


def _haystack(exc: BaseException) -> str:
    """Lowercased message plus response body, when there is one."""
    parts = [str(exc)]
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            parts.append(response.text)
        except Exception:  # pragma: no cover - defensive; .text can raise
            pass
    return "\n".join(parts).lower()


def _retry_after_from(exc: BaseException) -> Optional[float]:
    response = getattr(exc, "response", None)
    if response is None:
        return None
    try:
        raw = response.headers.get("retry-after")
    except Exception:  # pragma: no cover - defensive
        return None
    if not raw:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def classify_exception(
    exc: BaseException,
    *,
    lane_label: str = "",
    provider: str = "",
    model: str = "",
    credential_alias: Optional[str] = None,
    secret: Optional[str] = None,
) -> AIError:
    """Turn any exception from a client into a classified :class:`AIError`.

    An ``AIError`` passed in is returned unchanged apart from lane details it
    was missing, so classification is idempotent and a client that already
    classified precisely is never second-guessed by a caller that knows less.
    """
    if isinstance(exc, AIError):
        # Fill in lane context the raising layer could not know.
        if lane_label and not exc.lane_label:
            exc.lane_label = lane_label
        if provider and not exc.provider:
            exc.provider = provider
        if model and not exc.model:
            exc.model = model
        if credential_alias and exc.credential_alias is None:
            exc.credential_alias = credential_alias
        return exc

    text = _haystack(exc)
    status: Optional[int] = None
    response = getattr(exc, "response", None)
    if response is not None:
        status = getattr(response, "status_code", None)

    kind = _kind_for(exc, text, status)

    return AIError(
        kind=kind,
        message=sanitize(exc, secret),
        lane_label=lane_label,
        provider=provider,
        model=model,
        credential_alias=credential_alias,
        http_status=status,
        retry_after=_retry_after_from(exc) if kind is AIErrorKind.QUOTA else None,
    )


def _kind_for(exc: BaseException, text: str, status: Optional[int]) -> AIErrorKind:
    """Pick a kind from the status code first, then the message text.

    Status codes are checked first because they are the provider's own
    structured statement; message matching is the fallback for clients that
    raise before an HTTP response exists, and for providers whose bodies say
    more than their codes do.
    """
    # A context-window error is a 400 on most providers. Check it before the
    # generic 400 branch, and before status at all, because it is
    # document-local and getting it wrong costs a working lane.
    if any(marker in text for marker in _CONTEXT_MARKERS):
        return AIErrorKind.CONTEXT

    if status is not None:
        if status in (401, 403):
            return AIErrorKind.AUTH
        if status == 429:
            return AIErrorKind.QUOTA
        if status == 404:
            return AIErrorKind.UNSUPPORTED
        if status >= 500:
            # Transient far more often than not. Recorded, but the lane
            # survives -- a provider genuinely down will show up as every
            # document failing, which the stored counts make visible without
            # having to guess here.
            return AIErrorKind.UNKNOWN

    if _is_connection_error(exc):
        return AIErrorKind.NETWORK

    if any(marker in text for marker in _AUTH_MARKERS):
        return AIErrorKind.AUTH
    if any(marker in text for marker in _QUOTA_MARKERS):
        return AIErrorKind.QUOTA
    if any(marker in text for marker in _MODEL_MARKERS):
        return AIErrorKind.UNSUPPORTED
    if any(marker in text for marker in _CONTENT_MARKERS):
        return AIErrorKind.CONTENT

    return AIErrorKind.UNKNOWN


def _is_connection_error(exc: BaseException) -> bool:
    """True for "could not reach the provider at all" failures.

    Imported lazily and by name so this module does not hard-depend on httpx
    being importable -- the subscription lane raises OSError-family failures
    from subprocess handling and needs the same classification.
    """
    try:
        import httpx

        if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout,
                            httpx.ReadTimeout, httpx.TimeoutException)):
            return True
    except Exception:  # pragma: no cover - httpx is a hard dependency today
        pass
    return isinstance(exc, (ConnectionError, TimeoutError))
