"""Object-store artifact upload + signed-URL helpers (IMPL-34 / §11.2).

Uses a **boto3-compatible** S3 client. The production deployment targets
Cloudflare R2 (primary) or Backblaze B2 (fallback) per ADQ-13; both expose
a fully S3-compatible API, so the same ``boto3.client('s3', ...)``
construction works against either (and against MinIO / moto in tests) —
only ``OBJECT_STORE_ENDPOINT`` + credentials change.

Public surface (§11.2):

* :func:`upload_artifact(user_id, exec_id, name, path_or_bytes) -> str`
  uploads a file (or in-memory bytes) under ``<user_id>/<execution_id>/<name>``
  and returns the canonical ``s3://<bucket>/<user_id>/<exec_id>/<name>``
  URI that the cloud ``executions`` row stores in ``artifact_uri``.

* :func:`signed_url(user_id, exec_id, name, ttl_seconds=300) -> str`
  issues a 5-minute (default) presigned GET URL that the desktop's
  ``cloud-cache`` then fetches directly from the object store, bypassing
  the API entirely.

* :func:`build_artifacts_router` — mounts
  ``GET /api/v2/artifacts/{execution_id}/{name}`` which verifies the
  caller owns ``execution_id`` and returns a 307 redirect to the signed
  URL. Only a whitelisted set of artifact names is accepted so path
  traversal through ``{name}`` is impossible (OWASP A01).
"""

from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Any, Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse

from .auth import CurrentUser, get_current_user
from .config import CloudConfig, load_config


logger = logging.getLogger(__name__)


#: Artifact names the desktop cache is allowed to pull. Anything else is
#: rejected at the HTTP layer to prevent ``{name}`` being abused as a
#: path-traversal vector even though S3 treats the key as opaque.
ALLOWED_ARTIFACT_NAMES: frozenset[str] = frozenset(
    {"report.md", "run.log", "progress.json"}
)


DEFAULT_SIGNED_URL_TTL_SECONDS = 300


# ---------------------------------------------------------------------------
# boto3 client
# ---------------------------------------------------------------------------


def _resolve_config(config: Optional[CloudConfig]) -> CloudConfig:
    return config if config is not None else load_config()


def _build_s3_client(config: CloudConfig):
    """Return a boto3 S3 client pointed at ``config.object_store_endpoint``.

    The ``boto3`` import is deliberately lazy so the cloud package can be
    imported in test processes that never touch the object store.
    Credentials are sourced from the process environment exactly as
    :mod:`botocore` documents (``AWS_ACCESS_KEY_ID`` /
    ``AWS_SECRET_ACCESS_KEY`` / ``AWS_SESSION_TOKEN`` / ``AWS_REGION`` /
    instance IAM role) — never persisted to disk or logged.
    """
    try:
        import boto3  # type: ignore
        from botocore.config import Config as BotoConfig  # type: ignore
    except ModuleNotFoundError as exc:  # pragma: no cover
        raise RuntimeError(
            "boto3 is required for cloud artifact storage. "
            "Install with `pip install boto3`."
        ) from exc

    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    kwargs: dict[str, Any] = {
        "service_name": "s3",
        # R2 / B2 / MinIO / moto all use virtual-host-or-path addressing
        # via an explicit endpoint_url.
        "config": BotoConfig(signature_version="s3v4"),
    }
    if config.object_store_endpoint and config.object_store_endpoint != "aws":
        kwargs["endpoint_url"] = config.object_store_endpoint
    if region:
        kwargs["region_name"] = region
    return boto3.client(**kwargs)


def _object_key(user_id: Any, exec_id: Any, name: str) -> str:
    """Return the canonical ``<user>/<exec>/<name>`` key (§11.2)."""
    return f"{user_id}/{exec_id}/{name}"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


PathOrBytes = Union[str, Path, bytes, bytearray]


def upload_artifact(
    user_id: Any,
    exec_id: Any,
    name: str,
    path_or_bytes: PathOrBytes,
    *,
    config: Optional[CloudConfig] = None,
    client: Any = None,
) -> str:
    """Upload ``path_or_bytes`` to ``<user_id>/<exec_id>/<name>``.

    Returns the canonical ``s3://<bucket>/<key>`` URI stored on the
    ``executions`` row's ``artifact_uri`` column. The ``client`` kwarg is
    provided so tests can inject a moto-mocked boto3 client without
    touching the filesystem-wide ``_build_s3_client`` construction.
    """
    cfg = _resolve_config(config)
    s3 = client if client is not None else _build_s3_client(cfg)
    key = _object_key(user_id, exec_id, name)

    if isinstance(path_or_bytes, (bytes, bytearray)):
        s3.put_object(
            Bucket=cfg.object_store_bucket,
            Key=key,
            Body=bytes(path_or_bytes),
        )
    else:
        src = Path(path_or_bytes)
        if not src.exists():
            raise FileNotFoundError(f"Artifact source not found: {src}")
        s3.upload_file(str(src), cfg.object_store_bucket, key)

    uri = f"s3://{cfg.object_store_bucket}/{key}"
    logger.info(
        "Uploaded artifact: user_id=%s exec_id=%s name=%s uri=%s",
        user_id, exec_id, name, uri,
    )
    return uri


def signed_url(
    user_id: Any,
    exec_id: Any,
    name: str,
    ttl_seconds: int = DEFAULT_SIGNED_URL_TTL_SECONDS,
    *,
    config: Optional[CloudConfig] = None,
    client: Any = None,
) -> str:
    """Return a presigned GET URL valid for ``ttl_seconds`` (default 5 min).

    Per §11.2 the desktop follows the redirect directly to the object
    store — the API never proxies artifact bytes.
    """
    if ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be positive")
    cfg = _resolve_config(config)
    s3 = client if client is not None else _build_s3_client(cfg)
    key = _object_key(user_id, exec_id, name)
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": cfg.object_store_bucket, "Key": key},
        ExpiresIn=int(ttl_seconds),
    )


# ---------------------------------------------------------------------------
# Worker helper
# ---------------------------------------------------------------------------


def upload_execution_artifacts(
    user_id: Any,
    exec_id: Any,
    artifact_files: dict,
    *,
    config: Optional[CloudConfig] = None,
    client: Any = None,
) -> dict[str, str]:
    """Upload every ``{name: path_or_bytes}`` pair and return ``{name: uri}``.

    Unknown names (not in :data:`ALLOWED_ARTIFACT_NAMES`) are skipped with
    a warning so a runaway sweep runner cannot pollute the bucket with
    arbitrary keys.
    """
    out: dict[str, str] = {}
    for name, body in artifact_files.items():
        if name not in ALLOWED_ARTIFACT_NAMES:
            logger.warning(
                "Skipping disallowed artifact name %r for exec %s",
                name, exec_id,
            )
            continue
        out[name] = upload_artifact(
            user_id, exec_id, name, body, config=config, client=client,
        )
    return out


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------


def _get_execution_store(request: Request):
    """Mirror :func:`cloud.executions._get_execution_store` without the cycle."""
    store = getattr(request.app.state, "execution_store", None)
    if store is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Execution store not configured",
        )
    return store


def _validate_artifact_name(name: str) -> None:
    if name not in ALLOWED_ARTIFACT_NAMES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported artifact name: {name!r}",
        )


def build_artifacts_router() -> APIRouter:
    """Return the ``/artifacts/{execution_id}/{name}`` router."""
    router = APIRouter()

    @router.get("/artifacts/{execution_id}/{name}")
    def get_artifact(
        execution_id: str,
        name: str,
        request: Request,
        ttl: Optional[int] = None,
        current_user: CurrentUser = Depends(get_current_user),
    ) -> RedirectResponse:
        _validate_artifact_name(name)

        try:
            eid = uuid.UUID(execution_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid execution_id")

        store = _get_execution_store(request)
        row = store.get(current_user.user_id, eid)
        if row is None:
            # Ownership check + not-found collapse into one response per
            # OWASP guidance (no existence oracle for other users' data).
            raise HTTPException(status_code=404, detail="Execution not found")

        config: CloudConfig = request.app.state.config
        ttl_seconds = (
            int(ttl) if ttl and ttl > 0 else DEFAULT_SIGNED_URL_TTL_SECONDS
        )

        client = getattr(request.app.state, "s3_client", None)
        url = signed_url(
            current_user.user_id,
            eid,
            name,
            ttl_seconds=ttl_seconds,
            config=config,
            client=client,
        )
        return RedirectResponse(
            url=url, status_code=status.HTTP_307_TEMPORARY_REDIRECT
        )

    return router
