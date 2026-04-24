"""resmon-cloud service package (Phase 2E-B skeleton).

This package holds the server-side FastAPI app that mirrors a subset of the
local backend's surface and runs cloud-scheduled routines. It is intentionally
decoupled from the desktop-local code at the module boundary:

* ``keyring`` **must not** be imported here (enforced by CI grep).
* All configuration is loaded from environment variables (12-factor).
* Database, object-store, and KMS clients are constructed from ``config.py``
  and never hard-coded.

Modules in this package at the skeleton stage:

* :mod:`resmon_scripts.cloud.app`       — FastAPI factory + ``/api/v2/health``.
* :mod:`resmon_scripts.cloud.config`    — typed, env-driven config loader.
* :mod:`resmon_scripts.cloud.db`        — SQLAlchemy engine placeholder.
* :mod:`resmon_scripts.cloud.worker`    — APScheduler wire-up placeholder.
* :mod:`resmon_scripts.cloud.sync`      — sync-cursor endpoints (stub).
* :mod:`resmon_scripts.cloud.artifacts` — S3/R2 upload helpers (stub).
* :mod:`resmon_scripts.cloud.auth`      — JWKS verification (stub).
* :mod:`resmon_scripts.cloud.crypto`    — envelope encryption helpers (stub).
"""

from __future__ import annotations

__version__ = "0.1.0"
