"""IMPL-39 verification — observability, kill-switch, rate limits (§13).

Covers the six V-gates mandated by Step 39 of the implementation guide:

* **/metrics** exposes all four required counters (``executions_total``,
  ``executions_failed_total``, ``api_call_latency_seconds``,
  ``scheduler_missed_fires_total``).
* **/status** returns ``version``, ``uptime_seconds``, ``db_ok``,
  ``redis_ok``, ``object_store_ok``, and ``global_execution_disabled``.
* ``GLOBAL_EXECUTION_DISABLE=true`` short-circuits the worker: no
  credential decryption, no sweep runner invocation, and the execution
  lands in ``status='cancelled'`` with ``cancel_reason='globally_disabled'``.
* ``RateLimitMiddleware`` returns HTTP 429 after the per-user write budget
  is exhausted.
* ``enforce_max_routines`` / the create-routine handler rejects the
  (max+1)-th POST with HTTP 429.
* ``SecretRedactingFilter`` strips ``value``, ``access_token``,
  ``refresh_token``, ``Authorization``, and ``Bearer <jwt>`` substrings.

All tests are hermetic — in-memory stores, local KMS, JWT/JWKS harness
pattern from ``test_cloud_routines_worker.py``.
"""

from __future__ import annotations

import io
import json
import logging
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from cloud import auth as cloud_auth
from cloud.app import create_app
from cloud.config import CloudConfig
from cloud.credentials import InMemoryCredentialStore
from cloud.crypto import DEK_BYTES, LocalKMSClient
from cloud.executions import InMemoryExecutionStore, cloud_progress_store
from cloud.limits import RateLimiter, enforce_max_routines
from cloud.observability import (
    REDACTED_PLACEHOLDER,
    SecretRedactingFilter,
    configure_json_logging,
)
from cloud.routines import InMemoryRoutineStore
from cloud.worker import (
    WorkerContext,
    register_worker_context,
    run_routine_job,
    unregister_worker_context,
)


ISSUER = "https://idp.test.invalid/"
AUDIENCE = "resmon-cloud-test"
JWKS_URL = "https://idp.test.invalid/.well-known/jwks.json"
PRIMARY_KID = "test-obs-key"


# ---------------------------------------------------------------------------
# JWT harness
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def primary_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def jwks_doc(primary_key) -> dict:
    raw = jwt.algorithms.RSAAlgorithm.to_jwk(primary_key.public_key())
    jwk = json.loads(raw) if isinstance(raw, str) else raw
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


def _token(private_key: rsa.RSAPrivateKey, *, sub: str = "obs-user") -> str:
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


def _auth(private_key, *, sub: str = "obs-user") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(private_key, sub=sub)}"}


def _config(
    *,
    global_execution_disable: bool = False,
    writes_per_min: int = 60,
    reads_per_min: int = 300,
    concurrent_executions: int = 10,
    max_routines: int = 100,
) -> CloudConfig:
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
        global_execution_disable=global_execution_disable,
        rate_limit_reads_per_min=reads_per_min,
        rate_limit_writes_per_min=writes_per_min,
        rate_limit_concurrent_executions=concurrent_executions,
        rate_limit_max_routines=max_routines,
    )


@pytest.fixture
def built_app():
    def _factory(**kwargs):
        app = create_app(config=_config(**kwargs))
        users: dict[str, uuid.UUID] = {}

        def fake_upsert(_cfg, sub, _claims):
            users.setdefault(sub, uuid.uuid4())
            return users[sub]

        app.state.user_upsert = fake_upsert
        app.state.routine_store = InMemoryRoutineStore()
        app.state.execution_store = InMemoryExecutionStore()
        app.state.credential_store = InMemoryCredentialStore()
        app.state.kms_client = LocalKMSClient(master_key=b"\x02" * DEK_BYTES)
        return app, users

    return _factory


# ---------------------------------------------------------------------------
# /metrics exposition
# ---------------------------------------------------------------------------


def test_metrics_exposes_four_required_counters(built_app):
    app, _ = built_app()
    client = TestClient(app)
    resp = client.get("/metrics")
    assert resp.status_code == 200
    body = resp.text
    for name in (
        "executions_total",
        "executions_failed_total",
        "api_call_latency_seconds",
        "scheduler_missed_fires_total",
    ):
        assert name in body, f"Prometheus counter missing: {name}"


def test_metrics_counters_bump_on_terminal_events(built_app):
    app, _ = built_app()
    metrics = app.state.metrics
    metrics.record_execution_terminal("succeeded")
    metrics.record_execution_terminal("failed")
    metrics.record_execution_terminal("failed")

    client = TestClient(app)
    body = client.get("/metrics").text
    assert 'executions_total{status="succeeded"} 1.0' in body
    assert 'executions_total{status="failed"} 2.0' in body
    assert "executions_failed_total 2.0" in body


# ---------------------------------------------------------------------------
# /status public endpoint
# ---------------------------------------------------------------------------


def test_status_shape(built_app):
    app, _ = built_app()
    client = TestClient(app)
    resp = client.get("/status")
    assert resp.status_code == 200
    body = resp.json()
    for key in (
        "version",
        "uptime_seconds",
        "db_ok",
        "redis_ok",
        "object_store_ok",
        "global_execution_disabled",
    ):
        assert key in body, f"/status missing key: {key}"
    assert body["global_execution_disabled"] is False
    assert isinstance(body["uptime_seconds"], (int, float))


def test_status_reflects_kill_switch(built_app):
    app, _ = built_app(global_execution_disable=True)
    client = TestClient(app)
    assert client.get("/status").json()["global_execution_disabled"] is True


# ---------------------------------------------------------------------------
# Kill-switch short-circuit in the worker
# ---------------------------------------------------------------------------


def test_kill_switch_cancels_without_upstream(built_app, primary_key):
    app, users = built_app(global_execution_disable=True)
    client = TestClient(app)

    # Provoke user row.
    client.get("/api/v2/me", headers=_auth(primary_key, sub="disabled-user"))
    user_id = users["disabled-user"]

    create = client.post(
        "/api/v2/routines",
        headers=_auth(primary_key, sub="disabled-user"),
        json={"name": "noop", "cron": "* * * * *", "parameters": {}},
    ).json()
    routine_id = uuid.UUID(create["routine_id"])

    sweep_calls: list = []

    def _runner(**_):
        sweep_calls.append(1)
        return {"artifact_uri": "memory://nope", "stats": {}}

    class _FailingCredStore:
        """Any call here fails the test — kill-switch must skip decryption."""

        def list_keys(self, *_a, **_kw):
            raise AssertionError("credential_store accessed while disabled")

        def read_row(self, *_a, **_kw):
            raise AssertionError("credential_store accessed while disabled")

    ctx_key = f"test-killed-{uuid.uuid4()}"
    register_worker_context(
        ctx_key,
        WorkerContext(
            routine_store=app.state.routine_store,
            execution_store=app.state.execution_store,
            credential_store=_FailingCredStore(),
            kms_client=app.state.kms_client,
            sweep_runner=_runner,
            global_execution_disable=True,
            metrics=app.state.metrics,
        ),
    )
    try:
        run_routine_job(
            str(user_id), str(routine_id), None, context_key=ctx_key,
        )
    finally:
        unregister_worker_context(ctx_key)

    assert sweep_calls == [], "sweep runner must not be invoked when disabled"
    rows = app.state.execution_store.list(user_id)
    assert len(rows) == 1
    assert rows[0].status == "cancelled"
    assert rows[0].cancel_reason == "globally_disabled"

    # The cancelled terminal counter must have incremented.
    body = TestClient(app).get("/metrics").text
    assert 'executions_total{status="cancelled"} 1.0' in body


# ---------------------------------------------------------------------------
# Rate-limit middleware — HTTP 429 on write bucket exhaustion
# ---------------------------------------------------------------------------


def test_middleware_returns_429_after_write_budget(built_app, primary_key):
    app, _ = built_app(writes_per_min=2)
    client = TestClient(app)

    headers = _auth(primary_key, sub="rl-user")
    body = {"name": "rl", "cron": "* * * * *", "parameters": {}}

    # First two writes succeed (201) — third hits the bucket.
    assert client.post("/api/v2/routines", headers=headers, json=body).status_code == 201
    assert client.post("/api/v2/routines", headers=headers, json=body).status_code == 201
    resp = client.post("/api/v2/routines", headers=headers, json=body)
    assert resp.status_code == 429
    assert "Rate limit exceeded" in resp.json()["detail"]


def test_rate_limiter_token_bucket_unit():
    limiter = RateLimiter(reads_per_min=2, writes_per_min=2)
    assert limiter.take("u", "write") is True
    assert limiter.take("u", "write") is True
    assert limiter.take("u", "write") is False
    # Different user has an independent bucket.
    assert limiter.take("v", "write") is True


# ---------------------------------------------------------------------------
# Max-routines quota
# ---------------------------------------------------------------------------


def test_create_routine_rejects_beyond_max(built_app, primary_key):
    app, _ = built_app(max_routines=2, writes_per_min=20)
    client = TestClient(app)
    headers = _auth(primary_key, sub="quota-user")
    body = {"name": "q", "cron": "* * * * *", "parameters": {}}

    assert client.post("/api/v2/routines", headers=headers, json=body).status_code == 201
    assert client.post("/api/v2/routines", headers=headers, json=body).status_code == 201
    resp = client.post("/api/v2/routines", headers=headers, json=body)
    assert resp.status_code == 429
    assert "routine cap" in resp.json()["detail"].lower()


def test_enforce_max_routines_unit():
    enforce_max_routines(0, 1)  # no-op
    with pytest.raises(Exception) as ei:
        enforce_max_routines(5, 5)
    assert getattr(ei.value, "status_code", None) == 429


# ---------------------------------------------------------------------------
# Secret redactor
# ---------------------------------------------------------------------------


def _capture_json_logs(capture_stream: io.StringIO) -> list[dict]:
    lines = [ln for ln in capture_stream.getvalue().splitlines() if ln.strip()]
    out: list[dict] = []
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except json.JSONDecodeError:
            # The redactor must never emit invalid JSON.
            raise AssertionError(f"Non-JSON log line emitted: {ln!r}")
    return out


def test_redactor_scrubs_dict_keys_and_bearer_tokens():
    buf = io.StringIO()
    handler = configure_json_logging("INFO", stream=buf)
    try:
        log = logging.getLogger("resmon.test.redactor")
        log.info(
            "auth check",
            extra={
                "value": "sk-leak-123",
                "access_token": "eyJa.bbb.ccc",
                "refresh_token": "refresh-secret",
                "Authorization": "Bearer aaa.bbb.ccc",
                "user_id": "user-42",
            },
        )
        log.info("Token landed: Authorization: Bearer abc.def.ghi tail")
    finally:
        logging.getLogger().removeHandler(handler)

    records = _capture_json_logs(buf)
    assert records, "no log records emitted"

    joined = json.dumps(records)
    # No plaintext secret may remain.
    for forbidden in ("sk-leak-123", "eyJa.bbb.ccc", "refresh-secret", "aaa.bbb.ccc", "abc.def.ghi"):
        assert forbidden not in joined, f"secret leaked: {forbidden}"
    assert REDACTED_PLACEHOLDER in joined
    # Structured tag must propagate.
    assert any(r.get("user_id") == "user-42" for r in records)


def test_redactor_filter_unit():
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.addFilter(SecretRedactingFilter())
    root = logging.getLogger("resmon.test.filter-unit")
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    try:
        root.info("token: Bearer aaa.bbb.ccc")
    finally:
        root.removeHandler(handler)
    out = buf.getvalue()
    assert "aaa.bbb.ccc" not in out
    assert REDACTED_PLACEHOLDER in out
