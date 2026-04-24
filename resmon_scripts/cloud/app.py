"""FastAPI application factory for the ``resmon-cloud`` service.

Skeleton surface (IMPL-27) plus IMPL-39 observability wiring:

* :func:`create_app` returns a configured FastAPI instance.
* ``GET /api/v2/health`` returns ``{"status": "ok", "version": <str>}``.
* ``GET /status`` returns the public liveness snapshot (§13).
* ``GET /metrics`` returns Prometheus text exposition.
* Every ``/api/v2/*`` request is passed through the per-user rate
  limiter middleware.

Auth, sync, artifacts, worker, and credential endpoints are wired in by
IMPL-28..IMPL-40.
"""

from __future__ import annotations

import time
from typing import Callable, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .auth import build_v2_router
from .config import CloudConfig, load_config
from .limits import ConcurrencySemaphore, RateLimitMiddleware, RateLimiter
from .metrics import CloudMetrics, build_metrics_router
from .observability import configure_json_logging


def create_app(config: Optional[CloudConfig] = None) -> FastAPI:
    """Build the FastAPI app. Config may be injected by tests."""
    cfg = config if config is not None else load_config()

    # Install JSON logs + redactor before any middleware/endpoint code runs
    # so the very first request emits structured output.
    configure_json_logging(cfg.log_level)

    app = FastAPI(title="resmon-cloud", version=__version__)
    app.state.config = cfg
    app.state.started_at = time.monotonic()
    app.state.metrics = CloudMetrics()
    app.state.rate_limiter = RateLimiter(
        reads_per_min=cfg.rate_limit_reads_per_min,
        writes_per_min=cfg.rate_limit_writes_per_min,
    )
    app.state.concurrency = ConcurrencySemaphore(
        max_concurrent=cfg.rate_limit_concurrent_executions,
    )

    if cfg.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(cfg.allowed_origins),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # Per-user rate limiter — skips the exempt paths listed in limits.py
    # (``/api/v2/health``, ``/status``, ``/metrics``).
    app.add_middleware(RateLimitMiddleware, limiter=app.state.rate_limiter)

    # Unauthenticated liveness probe — deliberately registered on the app,
    # NOT on the v2 router, so it bypasses ``get_current_user`` (§8.5 V-C1).
    @app.get("/api/v2/health")
    def health() -> dict:
        return {"status": "ok", "version": __version__}

    # Public status endpoint (§13). No auth, no JWT — surfaces the same
    # health-check the desktop Cloud Account tab consumes.
    @app.get("/status")
    def status_endpoint() -> dict:
        uptime = max(0.0, time.monotonic() - app.state.started_at)
        return {
            "version": __version__,
            "uptime_seconds": round(uptime, 3),
            "db_ok": _probe(getattr(app.state, "db_probe", None)),
            "redis_ok": _probe(getattr(app.state, "redis_probe", None)),
            "object_store_ok": _probe(getattr(app.state, "object_store_probe", None)),
            "global_execution_disabled": bool(cfg.global_execution_disable),
        }

    # Prometheus scrape endpoint — no auth (scrape is authed at the edge).
    app.include_router(build_metrics_router(app.state.metrics))

    # Every other ``/api/v2/*`` endpoint is auth-gated via the v2 router.
    app.include_router(build_v2_router())

    return app


def _probe(fn: Optional[Callable[[], bool]]) -> bool:
    """Run a health probe safely. Missing probe → ``True`` by convention
    (the single-node skeleton has no DB/Redis/object-store wired by default;
    tests inject real probes via ``app.state.<name>_probe``)."""
    if fn is None:
        return True
    try:
        return bool(fn())
    except Exception:
        return False
