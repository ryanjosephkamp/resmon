"""JWKS-backed JWT verification and ``users`` upsert for ``resmon-cloud``.

IMPL-29 deliverables:

* :func:`fetch_jwks` — fetch the IdP's JWKS from :attr:`CloudConfig.jwks_url`
  with a documented in-process TTL cache (default 600 s, override via
  ``RESMON_JWKS_TTL`` env var or :func:`set_jwks_ttl`).
* :func:`verify_jwt` — verify the bearer token's RS256/ES256 signature
  against the cached JWKS and check ``iss`` / ``aud`` / ``exp``.
* :class:`CurrentUser` — frozen dataclass returned by the dependency.
* :func:`get_current_user` — FastAPI dependency that reads the
  ``Authorization: Bearer <jwt>`` header, verifies it, upserts the
  ``users`` row on first sighting of ``sub``, and returns a
  :class:`CurrentUser`.
* :func:`build_v2_router` — APIRouter with the auth dependency applied to
  every ``/api/v2/*`` endpoint that is not ``/health``.

Per the no-keyring constitution (§7.2 of the routines plan) this module
**must not** import :mod:`keyring`. CI greps for that string under
``resmon_scripts/cloud/`` and fails the build if present.
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass, field
from threading import Lock
from typing import Any, Callable, Dict, Optional

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import (
    ExpiredSignatureError,
    InvalidAudienceError,
    InvalidIssuerError,
    InvalidTokenError,
    PyJWK,
)

from .config import CloudConfig


# ---------------------------------------------------------------------------
# JWKS cache
# ---------------------------------------------------------------------------

_DEFAULT_TTL_SECONDS = 600

_jwks_cache: Dict[str, tuple[float, dict]] = {}
_jwks_lock = Lock()
_ttl_seconds: float = float(os.environ.get("RESMON_JWKS_TTL", _DEFAULT_TTL_SECONDS))


def set_jwks_ttl(seconds: float) -> None:
    """Override the JWKS cache TTL (test hook + operational override)."""
    global _ttl_seconds
    _ttl_seconds = float(seconds)


def reset_jwks_cache() -> None:
    """Drop every cached JWKS entry. Tests call this between cases."""
    with _jwks_lock:
        _jwks_cache.clear()


def _fetch_jwks_raw(jwks_url: str) -> dict:
    """Network fetch of the JWKS document. Test seam — patched in tests."""
    resp = httpx.get(jwks_url, timeout=5.0)
    resp.raise_for_status()
    return resp.json()


def fetch_jwks(jwks_url: str) -> dict:
    """Return the JWKS document for ``jwks_url``, cached for ``_ttl_seconds``."""
    now = time.monotonic()
    with _jwks_lock:
        cached = _jwks_cache.get(jwks_url)
        if cached is not None and (now - cached[0]) < _ttl_seconds:
            return cached[1]
    doc = _fetch_jwks_raw(jwks_url)
    with _jwks_lock:
        _jwks_cache[jwks_url] = (now, doc)
    return doc


def _select_jwk(jwks: dict, kid: Optional[str]) -> dict:
    keys = jwks.get("keys") or []
    if not keys:
        raise InvalidTokenError("JWKS document contains no keys")
    if kid is None:
        if len(keys) == 1:
            return keys[0]
        raise InvalidTokenError("Token header missing 'kid' and JWKS has multiple keys")
    for jwk in keys:
        if jwk.get("kid") == kid:
            return jwk
    raise InvalidTokenError(f"No JWK with kid={kid!r} in JWKS document")


# ---------------------------------------------------------------------------
# JWT verification
# ---------------------------------------------------------------------------

_ALLOWED_ALGORITHMS = ("RS256", "RS384", "RS512", "ES256", "ES384")


def verify_jwt(token: str, config: CloudConfig) -> dict[str, Any]:
    """Verify ``token`` against ``config``'s JWKS, issuer, and audience.

    Raises :class:`jwt.InvalidTokenError` (or one of its subclasses) on any
    failure. The caller is responsible for translating those into HTTP 401.
    """
    try:
        header = jwt.get_unverified_header(token)
    except InvalidTokenError:
        raise
    except Exception as exc:
        raise InvalidTokenError(f"Malformed JWT header: {exc}") from exc

    alg = header.get("alg")
    if alg not in _ALLOWED_ALGORITHMS:
        raise InvalidTokenError(f"Disallowed JWT algorithm: {alg!r}")

    jwks = fetch_jwks(config.jwks_url)
    jwk_dict = _select_jwk(jwks, header.get("kid"))
    public_key = PyJWK(jwk_dict).key

    return jwt.decode(
        token,
        key=public_key,
        algorithms=[alg],
        audience=config.jwt_audience,
        issuer=config.jwt_issuer,
        options={"require": ["exp", "iss", "aud", "sub"]},
    )


# ---------------------------------------------------------------------------
# User identity
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CurrentUser:
    """Authenticated user identity attached to the request."""

    user_id: uuid.UUID
    sub: str
    claims: dict = field(default_factory=dict)


def _default_user_upsert(config: CloudConfig, sub: str, claims: dict) -> uuid.UUID:
    """Upsert a ``users`` row keyed on ``idp_sub`` and return ``user_id``.

    Uses Postgres' ``INSERT ... ON CONFLICT ... DO UPDATE`` so the statement
    is idempotent under concurrent first-sightings.
    """
    from sqlalchemy import text

    from .db import get_engine

    engine = get_engine(config)
    email = claims.get("email")
    with engine.begin() as conn:
        row = conn.execute(
            text(
                """
                INSERT INTO users (idp_sub, email)
                VALUES (:sub, :email)
                ON CONFLICT (idp_sub) DO UPDATE SET email = EXCLUDED.email
                RETURNING user_id
                """
            ),
            {"sub": sub, "email": email},
        ).first()
    if row is None:  # pragma: no cover - RETURNING always yields a row
        raise RuntimeError("users upsert returned no row")
    return uuid.UUID(str(row[0]))


# Pluggable upsert function — tests override via ``app.state.user_upsert``.
UserUpsertFn = Callable[[CloudConfig, str, dict], uuid.UUID]


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

_bearer_scheme = HTTPBearer(auto_error=False)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    request: Request,
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
) -> CurrentUser:
    """Validate the bearer token and return :class:`CurrentUser`."""
    if creds is None or not creds.credentials:
        raise _unauthorized("Missing bearer token")

    config: Optional[CloudConfig] = getattr(request.app.state, "config", None)
    if config is None:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail="Cloud config not initialized")

    try:
        claims = verify_jwt(creds.credentials, config)
    except ExpiredSignatureError:
        raise _unauthorized("Token expired")
    except InvalidIssuerError:
        raise _unauthorized("Invalid token issuer")
    except InvalidAudienceError:
        raise _unauthorized("Invalid token audience")
    except InvalidTokenError as exc:
        raise _unauthorized(f"Invalid token: {exc}")

    sub = str(claims.get("sub") or "")
    if not sub:
        raise _unauthorized("Token missing 'sub' claim")

    upsert: UserUpsertFn = getattr(
        request.app.state, "user_upsert", _default_user_upsert
    )
    try:
        user_id = upsert(config, sub, claims)
    except Exception as exc:  # pragma: no cover - DB failures bubble as 500
        raise HTTPException(status_code=500, detail=f"User upsert failed: {exc}")

    return CurrentUser(user_id=user_id, sub=sub, claims=claims)


def build_v2_router() -> APIRouter:
    """Return an APIRouter mounted at ``/api/v2`` with auth on every route.

    ``/api/v2/health`` is **not** part of this router; it is registered
    directly on the app in :func:`cloud.app.create_app` so it stays
    unauthenticated per §8.5 V-C1.

    IMPL-40: every mutating verb (``POST``/``PUT``/``PATCH``/``DELETE``)
    is further gated behind :func:`cloud.accounts.require_beta_for_writes`
    so the closed beta can restrict writes while leaving reads — including
    ``GET /me/export`` — open to any authenticated user (§17.2).
    """
    from .accounts import require_beta_for_writes

    router = APIRouter(
        prefix="/api/v2",
        dependencies=[
            Depends(get_current_user),
            Depends(require_beta_for_writes),
        ],
    )

    @router.get("/me")
    def me(current_user: CurrentUser = Depends(get_current_user)) -> dict:
        return {
            "user_id": str(current_user.user_id),
            "sub": current_user.sub,
        }

    # IMPL-31 credential endpoints. Imported locally so ``cloud.crypto`` (and
    # its ``nacl`` dependency) is only loaded when the v2 router is built.
    from .credentials import build_credentials_router

    router.include_router(build_credentials_router())

    # IMPL-32 routine + execution endpoints.
    from .routines import build_routines_router
    from .executions import build_executions_router

    router.include_router(build_routines_router())
    router.include_router(build_executions_router())

    # IMPL-34 artifact redirect endpoint.
    from .artifacts import build_artifacts_router

    router.include_router(build_artifacts_router())

    # IMPL-35 cursor sync endpoint.
    from .sync import build_sync_router

    router.include_router(build_sync_router())

    # IMPL-40 self-service export + delete endpoints.
    from .accounts import build_account_router

    router.include_router(build_account_router())

    return router
