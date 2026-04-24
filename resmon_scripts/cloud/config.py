"""12-factor configuration loader for ``resmon-cloud``.

Every setting is loaded from an environment variable — there is no on-disk
config file, no ``keyring`` dependency, and no implicit default that reaches
out to a user profile path. Tests inject values by setting ``os.environ``
(or a ``.env`` file consumed by the deployment platform) before calling
:func:`load_config`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# Required / optional env vars (documented in §7.2 of the routines plan)
# ---------------------------------------------------------------------------

REQUIRED_ENV_VARS: tuple[str, ...] = (
    "DATABASE_URL",
    "OBJECT_STORE_ENDPOINT",
    "OBJECT_STORE_BUCKET",
    "JWT_ISSUER",
    "JWT_AUDIENCE",
    "JWKS_URL",
)

OPTIONAL_ENV_VARS: tuple[str, ...] = (
    "REDIS_URL",
    "KMS_KEY_ID",
    "ALLOWED_ORIGINS",
    "LOG_LEVEL",
    # IMPL-39 observability / abuse-prevention knobs (§13).
    "GLOBAL_EXECUTION_DISABLE",
    "RATE_LIMIT_READS_PER_MIN",
    "RATE_LIMIT_WRITES_PER_MIN",
    "RATE_LIMIT_CONCURRENT_EXECUTIONS",
    "RATE_LIMIT_MAX_ROUTINES",
)


@dataclass(frozen=True)
class CloudConfig:
    """Typed, immutable snapshot of the cloud service's runtime config."""

    database_url: str
    redis_url: Optional[str]
    object_store_endpoint: str
    object_store_bucket: str
    kms_key_id: Optional[str]
    jwt_issuer: str
    jwt_audience: str
    jwks_url: str
    allowed_origins: tuple[str, ...]
    log_level: str
    # IMPL-39 (§13).
    global_execution_disable: bool = False
    rate_limit_reads_per_min: int = 300
    rate_limit_writes_per_min: int = 60
    rate_limit_concurrent_executions: int = 10
    rate_limit_max_routines: int = 100

    @property
    def allow_origins_list(self) -> list[str]:
        return list(self.allowed_origins)


class ConfigError(RuntimeError):
    """Raised when required environment variables are missing."""


def _split_origins(raw: Optional[str]) -> tuple[str, ...]:
    if not raw:
        return ()
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _truthy(raw: Optional[str]) -> bool:
    return (raw or "").strip().lower() in {"1", "true", "yes", "on"}


def _int_or(raw: Optional[str], default: int) -> int:
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"Invalid integer env var value: {raw!r}") from exc


def load_config(env: Optional[dict[str, str]] = None) -> CloudConfig:
    """Build a :class:`CloudConfig` from the given environment mapping.

    Parameters
    ----------
    env:
        Environment dictionary to read from. Defaults to ``os.environ``.
        Passing an explicit dict is the documented way for tests to inject a
        fake configuration without mutating the real process environment.

    Raises
    ------
    ConfigError
        If any variable listed in :data:`REQUIRED_ENV_VARS` is absent.
    """
    src = dict(os.environ if env is None else env)
    missing = [name for name in REQUIRED_ENV_VARS if not src.get(name)]
    if missing:
        raise ConfigError(
            "Missing required environment variables: " + ", ".join(missing)
        )
    return CloudConfig(
        database_url=src["DATABASE_URL"],
        redis_url=src.get("REDIS_URL") or None,
        object_store_endpoint=src["OBJECT_STORE_ENDPOINT"],
        object_store_bucket=src["OBJECT_STORE_BUCKET"],
        kms_key_id=src.get("KMS_KEY_ID") or None,
        jwt_issuer=src["JWT_ISSUER"],
        jwt_audience=src["JWT_AUDIENCE"],
        jwks_url=src["JWKS_URL"],
        allowed_origins=_split_origins(src.get("ALLOWED_ORIGINS")),
        log_level=(src.get("LOG_LEVEL") or "INFO").upper(),
        global_execution_disable=_truthy(src.get("GLOBAL_EXECUTION_DISABLE")),
        rate_limit_reads_per_min=_int_or(src.get("RATE_LIMIT_READS_PER_MIN"), 300),
        rate_limit_writes_per_min=_int_or(src.get("RATE_LIMIT_WRITES_PER_MIN"), 60),
        rate_limit_concurrent_executions=_int_or(
            src.get("RATE_LIMIT_CONCURRENT_EXECUTIONS"), 10
        ),
        rate_limit_max_routines=_int_or(src.get("RATE_LIMIT_MAX_ROUTINES"), 100),
    )
