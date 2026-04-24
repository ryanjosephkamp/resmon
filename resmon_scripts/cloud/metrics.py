"""Prometheus instrumentation + ``/metrics`` endpoint (IMPL-39 / §13).

The four counters prescribed by §13 of ``resmon_routines_and_accounts.md``:

* ``executions_total`` — every cloud execution fired, labeled by
  terminal ``status`` (``succeeded``/``failed``/``cancelled``).
* ``executions_failed_total`` — mirror of the ``failed`` slice for
  alerting convenience.
* ``api_call_latency_seconds`` — per-repository upstream HTTP call
  latency histogram. Labeled by ``repo_slug``.
* ``scheduler_missed_fires_total`` — APScheduler ``EVENT_JOB_MISSED``
  counter.

A dedicated ``CollectorRegistry`` is used so that hermetic pytest runs
do not collide with the global default registry (which would raise
``Duplicated timeseries`` on test-module re-imports).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter
from fastapi.responses import Response
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
)


# ---------------------------------------------------------------------------
# Metric objects
# ---------------------------------------------------------------------------


class CloudMetrics:
    """Bundle of the four required Prometheus metrics.

    A single :class:`CollectorRegistry` scopes the metrics to this
    instance so tests can build a fresh registry per app without
    ``Duplicated timeseries`` errors from the global default registry.
    """

    def __init__(self, registry: Optional[CollectorRegistry] = None) -> None:
        self.registry = registry or CollectorRegistry(auto_describe=True)

        self.executions_total = Counter(
            "executions_total",
            "Number of cloud executions fired, labeled by terminal status."
            labelnames=("status",),
            registry=self.registry,
        )
        self.executions_failed_total = Counter(
            "executions_failed_total",
            "Number of cloud executions that terminated in the ``failed`` state.",
            registry=self.registry,
        )
        self.api_call_latency_seconds = Histogram(
            "api_call_latency_seconds",
            "Upstream HTTP call latency by repository.",
            labelnames=("repo_slug",),
            # Buckets tuned for typical scholarly API response times: most
            # return in <1 s, the long tail runs to ~30 s under load.
            buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0),
            registry=self.registry,
        )
        self.scheduler_missed_fires_total = Counter(
            "scheduler_missed_fires_total",
            "APScheduler ``EVENT_JOB_MISSED`` events (tally only).",
            registry=self.registry,
        )

    # ---- Convenience hooks -------------------------------------------------

    def record_execution_terminal(self, status: str) -> None:
        self.executions_total.labels(status=status).inc()
        if status == "failed":
            self.executions_failed_total.inc()

    def record_scheduler_missed_fire(self) -> None:
        self.scheduler_missed_fires_total.inc()


def build_metrics_router(metrics: CloudMetrics) -> APIRouter:
    """Return a router exposing ``GET /metrics`` for Prometheus scraping.

    Registered directly on the app (not under ``/api/v2``) so it bypasses
    the JWT dependency — Prometheus scrapers authenticate via network
    policy / mTLS at the platform edge, not via user tokens.
    """
    router = APIRouter()

    @router.get("/metrics", include_in_schema=False)
    def metrics_endpoint() -> Response:
        payload = generate_latest(metrics.registry)
        return Response(content=payload, media_type=CONTENT_TYPE_LATEST)

    return router
