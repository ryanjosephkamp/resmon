"""IMPL-32 verification — cloud routines CRUD + scheduler + worker + reaper.

Covers the two V-gates in §10.4:

* **V-E1** — a scheduled cloud routine fires without desktop interaction;
  the resulting ``executions`` row lands in state ``succeeded`` with an
  ``artifact_uri`` populated.
* **V-E2** — the five-minute reaper correctly repossesses stale ``running``
  rows, marking them ``failed`` with ``cancel_reason='node_restart'``.

Also exercises the CRUD surface, the SSE event stream, and the cancel
endpoint — the plumbing that V-E1 + V-E2 depend on.

Hermetic: uses the pytest JWT/JWKS harness pattern established in
``test_cloud_auth.py``, :class:`InMemoryRoutineStore` /
:class:`InMemoryExecutionStore`, :class:`BackgroundScheduler` + ``MemoryJobStore``,
and an injected stub sweep runner so no repository APIs or live Postgres
are touched.
"""

from __future__ import annotations

import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import jwt
import pytest
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.date import DateTrigger
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from cloud import auth as cloud_auth
from cloud.app import create_app
from cloud.config import CloudConfig
from cloud.credentials import InMemoryCredentialStore
from cloud.crypto import DEK_BYTES, LocalKMSClient
from cloud.executions import (
    Execution,
    InMemoryExecutionStore,
    cloud_progress_store,
)
from cloud.routines import InMemoryRoutineStore
from cloud.worker import (
    WorkerContext,
    build_scheduler,
    reap_stuck_executions,
    register_worker_context,
    run_routine_job,
    schedule_reaper,
    unregister_worker_context,
)


ISSUER = "https://idp.test.invalid/"
AUDIENCE = "resmon-cloud-test"
JWKS_URL = "https://idp.test.invalid/.well-known/jwks.json"
PRIMARY_KID = "test-key-1"


# ---------------------------------------------------------------------------
# JWT harness (mirrors test_cloud_credentials.py)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def primary_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def jwks_doc(primary_key) -> dict:
    import json as _json

    raw = jwt.algorithms.RSAAlgorithm.to_jwk(primary_key.public_key())
    jwk = _json.loads(raw) if isinstance(raw, str) else raw
    jwk["kid"] = PRIMARY_KID
    jwk["alg"] = "RS256"
    jwk["use"] = "sig"
    return {"keys": [jwk]}


@pytest.fixture(autouse=True)
def _patch_jwks(monkeypatch, jwks_doc):
    cloud_auth.reset_jwks_cache()
    monkeypatch.setattr(cloud_auth, "_fetch_jwks_raw", lambda url: jwks_doc)
    yield
    cloud_auth.reset_jwks_cache()


def _config() -> CloudConfig:
    return CloudConfig(
        database_url="sqlite:///:memory:",
        redis_url=None,
        object_store_endpoint="http://minio:9000",
        object_store_bucket="resmon-artifacts",
        kms_key_id="test-kek-id",
        jwt_issuer=ISSUER,
        jwt_audience=AUDIENCE,
        jwks_url=JWKS_URL,
        allowed_origins=(),
        log_level="INFO",
    )


def _token(private_key: rsa.RSAPrivateKey, *, sub: str = "user-sub-abc") -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": sub,
            "iss": ISSUER,
            "aud": AUDIENCE,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=15)).timestamp()),
            "beta": True,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": PRIMARY_KID},
    )


def _auth(private_key, *, sub: str = "user-sub-abc") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(private_key, sub=sub)}"}


# ---------------------------------------------------------------------------
# App fixture
# ---------------------------------------------------------------------------


@pytest.fixture
def built_app():
    """Build the app with in-memory stores, local KMS, and stub sweep runner."""
    app = create_app(config=_config())

    users: dict[str, uuid.UUID] = {}

    def fake_upsert(_cfg, sub, _claims):
        users.setdefault(sub, uuid.uuid4())
        return users[sub]

    app.state.user_upsert = fake_upsert
    app.state.routine_store = InMemoryRoutineStore()
    app.state.execution_store = InMemoryExecutionStore()
    app.state.credential_store = InMemoryCredentialStore()
    app.state.kms_client = LocalKMSClient(master_key=b"\x01" * DEK_BYTES)
    yield app, users


# ---------------------------------------------------------------------------
# CRUD / router surface
# ---------------------------------------------------------------------------


def test_routines_crud_roundtrip(built_app, primary_key):
    app, _ = built_app
    client = TestClient(app)

    # Empty list.
    r = client.get("/api/v2/routines", headers=_auth(primary_key))
    assert r.status_code == 200 and r.json() == []

    # Create.
    create = client.post(
        "/api/v2/routines",
        headers=_auth(primary_key),
        json={
            "name": "morning sweep",
            "cron": "0 9 * * *",
            "parameters": {"query": "llm", "repositories": ["arxiv"]},
        },
    )
    assert create.status_code == 201
    rid = create.json()["routine_id"]
    uuid.UUID(rid)  # must parse

    # List now has one.
    lst = client.get("/api/v2/routines", headers=_auth(primary_key)).json()
    assert len(lst) == 1 and lst[0]["routine_id"] == rid

    # Patch.
    patched = client.patch(
        f"/api/v2/routines/{rid}",
        headers=_auth(primary_key),
        json={"enabled": False, "cron": "0 10 * * *"},
    ).json()
    assert patched["enabled"] is False and patched["cron"] == "0 10 * * *"

    # Delete.
    assert (
        client.delete(f"/api/v2/routines/{rid}", headers=_auth(primary_key))
        .status_code
        == 204
    )
    assert (
        client.get(f"/api/v2/routines/{rid}", headers=_auth(primary_key))
        .status_code
        == 404
    )


def test_routines_reject_bad_cron(built_app, primary_key):
    app, _ = built_app
    client = TestClient(app)
    resp = client.post(
        "/api/v2/routines",
        headers=_auth(primary_key),
        json={"name": "bad", "cron": "tuesday at noon", "parameters": {}},
    )
    assert resp.status_code == 422


def test_routines_user_scoped(built_app, primary_key):
    app, _ = built_app
    client = TestClient(app)
    client.post(
        "/api/v2/routines",
        headers=_auth(primary_key, sub="alice"),
        json={"name": "a", "cron": "* * * * *", "parameters": {}},
    )
    bob = client.get(
        "/api/v2/routines", headers=_auth(primary_key, sub="bob")
    ).json()
    assert bob == []


def test_executions_require_auth(built_app):
    app, _ = built_app
    client = TestClient(app)
    assert client.get("/api/v2/executions").status_code == 401
    assert client.get("/api/v2/routines").status_code == 401


# ---------------------------------------------------------------------------
# Scheduler + worker — V-E1
# ---------------------------------------------------------------------------


def _stub_runner_factory(calls: list):
    def _runner(*, routine_parameters, ephemeral_credentials, execution_id):
        calls.append(
            {
                "execution_id": str(execution_id),
                "parameters": dict(routine_parameters),
                "creds_present": sorted(ephemeral_credentials.keys()),
            }
        )
        return {
            "artifact_uri": f"memory://artifacts/{execution_id}/report.md",
            "stats": {"result_count": 0, "new_count": 0},
        }
    return _runner


def _wait_for(predicate, *, timeout=5.0, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def test_scheduled_cloud_routine_fires_and_succeeds_V_E1(built_app, primary_key):
    """V-E1: routine scheduled to fire quickly ends in state ``succeeded``."""
    app, users = built_app
    client = TestClient(app)

    create = client.post(
        "/api/v2/routines",
        headers=_auth(primary_key, sub="alice-ve1"),
        json={
            "name": "ve1-routine",
            "cron": "0 0 * * *",
            "parameters": {"query": "physics"},
        },
    ).json()
    routine_id = uuid.UUID(create["routine_id"])
    user_id = users["alice-ve1"]

    # Hermetic scheduler: BackgroundScheduler + MemoryJobStore, same
    # misfire_grace_time policy as production.
    sched = build_scheduler(
        _config(),
        jobstore=MemoryJobStore(),
        scheduler_cls=BackgroundScheduler,
    )

    calls: list = []
    ctx_key = f"test-ctx-{uuid.uuid4()}"
    register_worker_context(
        ctx_key,
        WorkerContext(
            routine_store=app.state.routine_store,
            execution_store=app.state.execution_store,
            credential_store=app.state.credential_store,
            kms_client=app.state.kms_client,
            sweep_runner=_stub_runner_factory(calls),
        ),
    )

    sched.start()
    try:
        fire_at = datetime.now(timezone.utc) + timedelta(milliseconds=200)
        sched.add_job(
            run_routine_job,
            trigger=DateTrigger(run_date=fire_at),
            args=(str(user_id), str(routine_id), None),
            kwargs={"context_key": ctx_key},
            id=f"ve1-{routine_id}",
        )

        assert _wait_for(lambda: len(calls) >= 1, timeout=5.0)
    finally:
        sched.shutdown(wait=True)
        unregister_worker_context(ctx_key)

    # An executions row exists, status == succeeded, artifact_uri populated.
    rows = app.state.execution_store.list(user_id)
    assert len(rows) == 1
    row = rows[0]
    assert row.status == "succeeded"
    assert row.artifact_uri is not None
    assert row.artifact_uri.startswith("memory://artifacts/")
    assert row.routine_id == routine_id
    assert row.finished_at is not None

    # The HTTP surface agrees.
    listing = client.get(
        "/api/v2/executions", headers=_auth(primary_key, sub="alice-ve1")
    ).json()
    assert listing["items"][0]["status"] == "succeeded"
    assert listing["items"][0]["artifact_uri"] == row.artifact_uri

    # Progress events were emitted for the SSE channel.
    events = cloud_progress_store.get_events(str(row.execution_id))
    assert any(e["type"] == "execution_start" for e in events)
    assert any(
        e["type"] == "complete" and e.get("status") == "succeeded"
        for e in events
    )


def test_worker_decrypts_credentials_and_passes_to_runner(built_app, primary_key):
    """Worker path loads + decrypts credentials into the ``ephemeral`` dict."""
    app, users = built_app
    client = TestClient(app)

    # Sign alice in and store a credential.
    uid_resp = client.get(
        "/api/v2/me", headers=_auth(primary_key, sub="alice-creds")
    )
    assert uid_resp.status_code == 200
    user_id = users["alice-creds"]

    put = client.put(
        "/api/v2/credentials/arxiv_api_key",
        headers=_auth(primary_key, sub="alice-creds"),
        json={"value": "cred-plaintext-xyz"},
    )
    assert put.status_code == 204

    # Create a routine and run the worker directly (bypass scheduler).
    create = client.post(
        "/api/v2/routines",
        headers=_auth(primary_key, sub="alice-creds"),
        json={"name": "x", "cron": "* * * * *", "parameters": {}},
    ).json()
    routine_id = uuid.UUID(create["routine_id"])

    calls: list = []
    ctx_key = f"test-creds-{uuid.uuid4()}"
    register_worker_context(
        ctx_key,
        WorkerContext(
            routine_store=app.state.routine_store,
            execution_store=app.state.execution_store,
            credential_store=app.state.credential_store,
            kms_client=app.state.kms_client,
            sweep_runner=_stub_runner_factory(calls),
        ),
    )
    try:
        run_routine_job(
            str(user_id), str(routine_id), None, context_key=ctx_key,
        )
    finally:
        unregister_worker_context(ctx_key)

    assert len(calls) == 1
    assert calls[0]["creds_present"] == ["arxiv_api_key"]


def test_sse_events_delivered(built_app, primary_key):
    """``GET /executions/{id}/events`` streams the worker's progress events."""
    app, users = built_app
    client = TestClient(app)

    # Seed a succeeded execution by running the worker directly.
    _ = client.get("/api/v2/me", headers=_auth(primary_key, sub="alice-sse"))
    user_id = users["alice-sse"]
    create = client.post(
        "/api/v2/routines",
        headers=_auth(primary_key, sub="alice-sse"),
        json={"name": "s", "cron": "* * * * *", "parameters": {}},
    ).json()
    routine_id = uuid.UUID(create["routine_id"])

    calls: list = []
    ctx_key = f"test-sse-{uuid.uuid4()}"
    register_worker_context(
        ctx_key,
        WorkerContext(
            routine_store=app.state.routine_store,
            execution_store=app.state.execution_store,
            credential_store=app.state.credential_store,
            kms_client=app.state.kms_client,
            sweep_runner=_stub_runner_factory(calls),
        ),
    )
    try:
        run_routine_job(
            str(user_id), str(routine_id), None, context_key=ctx_key,
        )
    finally:
        unregister_worker_context(ctx_key)

    rows = app.state.execution_store.list(user_id)
    eid = rows[0].execution_id

    with client.stream(
        "GET",
        f"/api/v2/executions/{eid}/events",
        headers=_auth(primary_key, sub="alice-sse"),
    ) as resp:
        assert resp.status_code == 200
        payload = b""
        for chunk in resp.iter_raw():
            payload += chunk
            if b"succeeded" in payload:
                break
    text = payload.decode("utf-8")
    assert "execution_start" in text
    assert "succeeded" in text


def test_cancel_endpoint_sets_flag(built_app, primary_key):
    app, users = built_app
    client = TestClient(app)
    _ = client.get("/api/v2/me", headers=_auth(primary_key, sub="alice-cx"))
    user_id = users["alice-cx"]

    # Manually insert a running row (no scheduler needed).
    row = app.state.execution_store.insert(user_id, None, status="running")
    resp = client.post(
        f"/api/v2/executions/{row.execution_id}/cancel",
        headers=_auth(primary_key, sub="alice-cx"),
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["cancel_requested"] is True
    assert cloud_progress_store.should_cancel(str(row.execution_id))


# ---------------------------------------------------------------------------
# Reaper — V-E2
# ---------------------------------------------------------------------------


def test_reaper_marks_stuck_running_rows_failed_V_E2(built_app, primary_key):
    """V-E2: reaper moves stale ``running`` rows → ``failed`` / ``node_restart``."""
    app, users = built_app
    client = TestClient(app)
    _ = client.get("/api/v2/me", headers=_auth(primary_key, sub="alice-ve2"))
    user_id = users["alice-ve2"]

    # Insert two rows: one stale (heartbeat 30 min ago) + one fresh (now).
    stale = app.state.execution_store.insert(user_id, None, status="running")
    fresh = app.state.execution_store.insert(user_id, None, status="running")
    # Back-date the stale row's heartbeat by hand (it's the canonical
    # "container crashed mid-execution" scenario that V-E2 models).
    stale_row = app.state.execution_store._rows[stale.execution_id]
    stale_row.heartbeat_at = datetime.now(timezone.utc) - timedelta(minutes=30)

    reaped = reap_stuck_executions(
        app.state.execution_store,
        threshold_seconds=600,
    )
    assert reaped == [stale.execution_id]

    after_stale = app.state.execution_store.get(user_id, stale.execution_id)
    assert after_stale is not None
    assert after_stale.status == "failed"
    assert after_stale.cancel_reason == "node_restart"
    assert after_stale.finished_at is not None

    after_fresh = app.state.execution_store.get(user_id, fresh.execution_id)
    assert after_fresh is not None
    assert after_fresh.status == "running"  # still fresh
    assert after_fresh.cancel_reason is None

    # §10.4 V-E2 final clause: after a reaper sweep, NO rows remain stuck
    # in ``running`` when they exceed the threshold — verified by running
    # the reaper again and observing an empty reap list.
    second_sweep = reap_stuck_executions(
        app.state.execution_store,
        threshold_seconds=600,
    )
    assert second_sweep == []


def test_reaper_integrates_with_scheduler(built_app, primary_key):
    """``schedule_reaper`` registers a recurring job that invokes the reaper."""
    app, _ = built_app

    sched = build_scheduler(
        _config(),
        jobstore=MemoryJobStore(),
        scheduler_cls=BackgroundScheduler,
    )
    sched.start(paused=True)
    try:
        schedule_reaper(
            sched, app.state.execution_store,
            interval_seconds=3600, threshold_seconds=600,
        )
        jobs = sched.get_jobs()
        assert any(j.id == "resmon-cloud-reaper" for j in jobs)
    finally:
        sched.shutdown(wait=False)


def test_scheduler_uses_misfire_grace_time_3600(built_app):
    """§10.1: job defaults include ``misfire_grace_time=3600``."""
    sched = build_scheduler(
        _config(),
        jobstore=MemoryJobStore(),
        scheduler_cls=BackgroundScheduler,
    )
    # Accessing internal defaults via the attribute set by APScheduler on
    # construction; this is how the library exposes merged job defaults.
    assert sched._job_defaults.get("misfire_grace_time") == 3600
