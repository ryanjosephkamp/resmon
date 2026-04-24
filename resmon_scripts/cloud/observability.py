"""Structured JSON logging with a secret-redacting filter (IMPL-39 / §13).

Replaces uvicorn's default human-formatted logs with one JSON object per
line so a log aggregator (Fly/Railway/Render forward stdout) can parse
them trivially. Every record carries the four standard resmon-cloud tags
when they are available via :class:`logging.LogRecord` ``extra``:

* ``user_id``
* ``execution_id``
* ``routine_id``
* ``repo_slug``

Tags missing from ``extra`` are omitted rather than emitted as ``null``
so downstream parsers can rely on field presence.

The :class:`SecretRedactingFilter` is attached to the root logger and
strips the following keys from any dict-shaped LogRecord payload before
it reaches the formatter:

* ``value`` — plaintext credential values (§13 invariant).
* ``access_token`` / ``refresh_token`` — IdP JWT/refresh tokens.
* ``Authorization`` / ``authorization`` — raw bearer headers.

The filter also walks args dicts and ``getMessage()`` strings for
obvious ``Bearer <jwt>`` substrings and redacts them in place. It is
deliberately conservative: logging a credential by accident should
produce a redacted placeholder rather than silently stripping the entire
record.
"""

from __future__ import annotations

import logging
import re
import sys
from typing import Any, Iterable

from pythonjsonlogger import jsonlogger


# Keys whose values must never appear in an emitted log record.
REDACTED_KEYS: frozenset[str] = frozenset(
    {"value", "access_token", "refresh_token", "Authorization", "authorization"}
)

# Tags that propagate from ``extra`` into the JSON record. A missing tag is
# omitted entirely.
STRUCTURED_TAGS: tuple[str, ...] = (
    "user_id",
    "execution_id",
    "routine_id",
    "repo_slug",
)

REDACTED_PLACEHOLDER = "***REDACTED***"

_BEARER_RE = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+")


def _redact_any(obj: Any) -> Any:
    """Walk ``obj`` recursively, replacing redacted-key values in dicts.

    Lists and tuples are processed element-wise. Strings are scanned for
    ``Bearer <jwt>`` patterns. All other types pass through unchanged.
    """
    if isinstance(obj, dict):
        out: dict = {}
        for k, v in obj.items():
            if isinstance(k, str) and k in REDACTED_KEYS:
                out[k] = REDACTED_PLACEHOLDER
            else:
                out[k] = _redact_any(v)
        return out
    if isinstance(obj, (list, tuple)):
        ctor = type(obj)
        return ctor(_redact_any(v) for v in obj)
    if isinstance(obj, str):
        return _BEARER_RE.sub(r"\1" + REDACTED_PLACEHOLDER, obj)
    return obj


class SecretRedactingFilter(logging.Filter):
    """Mutate LogRecords in-place so no redacted value reaches the formatter."""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D401
        # The formatted message (covers f-strings and ``%`` args).
        try:
            raw_msg = record.getMessage()
        except Exception:
            raw_msg = str(record.msg)
        record.msg = _redact_any(raw_msg)
        record.args = ()  # msg now holds the fully-rendered string

        # Structured ``extra`` payloads often land as attributes directly on
        # the record. Walk the ``__dict__`` and redact any keys by name.
        for key in list(record.__dict__.keys()):
            if key in REDACTED_KEYS:
                record.__dict__[key] = REDACTED_PLACEHOLDER
        return True


class ResmonJsonFormatter(jsonlogger.JsonFormatter):
    """Emit ``{timestamp, level, logger, message, <tags>...}`` JSON lines."""

    def add_fields(self, log_record, record, message_dict):  # type: ignore[override]
        super().add_fields(log_record, record, message_dict)
        log_record.setdefault("timestamp", self.formatTime(record, self.datefmt))
        log_record["level"] = record.levelname
        log_record["logger"] = record.name
        # Copy structured tags from ``extra`` if present.
        for tag in STRUCTURED_TAGS:
            val = getattr(record, tag, None)
            if val is not None:
                log_record[tag] = str(val)
        # Defensive second-pass redaction: strip any redacted keys that may
        # have leaked into ``message_dict`` via ``logger.info(..., extra=...)``.
        for key in list(log_record.keys()):
            if key in REDACTED_KEYS:
                log_record[key] = REDACTED_PLACEHOLDER


def configure_json_logging(
    level: str = "INFO",
    *,
    stream: Any = None,
    extra_loggers: Iterable[str] = ("uvicorn", "uvicorn.access", "uvicorn.error"),
) -> logging.Handler:
    """Install the JSON handler + redactor on the root logger.

    Returns the installed :class:`logging.Handler` so callers can uninstall
    it in a teardown. The function is idempotent against repeated calls
    in the same process — each call first removes any handler it
    previously installed (tagged via the ``_resmon_json_handler`` flag).
    """
    root = logging.getLogger()
    for existing in list(root.handlers):
        if getattr(existing, "_resmon_json_handler", False):
            root.removeHandler(existing)

    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setFormatter(
        ResmonJsonFormatter(
            fmt="%(timestamp)s %(level)s %(name)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        )
    )
    handler.addFilter(SecretRedactingFilter())
    setattr(handler, "_resmon_json_handler", True)

    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Align the uvicorn family so the access/error logs land in the same
    # JSON stream under the same redactor.
    for name in extra_loggers:
        sub = logging.getLogger(name)
        sub.handlers = [handler]
        sub.propagate = False
        sub.setLevel(getattr(logging, level.upper(), logging.INFO))

    return handler
