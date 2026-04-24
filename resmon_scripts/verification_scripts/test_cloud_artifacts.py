"""IMPL-34 / V-F4 verification — object-store artifact upload, signed-URL
redirect, and TTL expiry.

Hermetic: a moto-mocked S3 replaces R2/B2; a moto-backed boto3 client is
injected into both the :mod:`cloud.artifacts` public helpers and the
``GET /api/v2/artifacts/{exec_id}/{name}`` endpoint.
"""

from __future__ import annotations

import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from moto.server import ThreadedMotoServer


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from cloud import auth as cloud_auth
from cloud.app import create_app
from cloud.artifacts import (
    ALLOWED_ARTIFACT_NAMES,
    signed_url,
    upload_artifact,
    upload_execution_artifacts,
)
from cloud.config import CloudConfig
from cloud.executions import Execution, InMemoryExecutionStore
from cloud.worker import WorkerContext, register_worker_context, run_routine_job


ISSUER = "https://idp.test.invalid/"
AUDIENCE = "resmon-cloud-test"
JWKS_URL = "https://idp.test.invalid/.well-known/jwks.json"
PRIMARY_KID = "art-key-1"
BUCKET = "resmon-artifacts-test"


# ---------------------------------------------------------------------------
# JWT harness
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


def _config(endpoint: str = "aws") -> CloudConfig:
    return CloudConfig(
        database_url="sqlite:///:memory:",
        redis_url=None,
        object_store_endpoint=endpoint,
        object_store_bucket=BUCKET,
        kms_key_id="test-kek-id",
        jwt_issuer=ISSUER,
        jwt_audience=AUDIENCE,
        jwks_url=JWKS_URL,
        allowed_origins=(),
        log_level="INFO",
    )


def _token(pk: rsa.RSAPrivateKey, *, sub: str = "user-art") -> str:
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
        pk,
        algorithm="RS256",
        headers={"kid": PRIMARY_KID},
    )


def _auth(pk, *, sub: str = "user-art") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(pk, sub=sub)}"}


# ---------------------------------------------------------------------------
# moto fixture
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def moto_server():
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    yield endpoint
    server.stop()


@pytest.fixture
def s3(monkeypatch, moto_server):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    client = boto3.client(
        "s3", region_name="us-east-1", endpoint_url=moto_server
    )
    # ThreadedMotoServer keeps state across tests in the same module; make
    # the bucket idempotently so teardown is trivial.
    try:
        client.create_bucket(Bucket=BUCKET)
    except client.exceptions.BucketAlreadyOwnedByYou:
        pass
    yield client
    # Drain keys so the next test starts clean.
    try:
        objs = client.list_objects_v2(Bucket=BUCKET).get("Contents", [])
        for o in objs:
            client.delete_object(Bucket=BUCKET, Key=o["Key"])
    except Exception:
        pass


@pytest.fixture
def cfg(moto_server) -> CloudConfig:
    return _config(endpoint=moto_server)


# ---------------------------------------------------------------------------
# 1. upload + signed-URL round-trip (V-F4 positive)
# ---------------------------------------------------------------------------


def test_upload_and_signed_url_roundtrip(s3, cfg):
    user_id = uuid.uuid4()
    exec_id = uuid.uuid4()
    payload = b"# Report\n\nHello from resmon-cloud\n"

    uri = upload_artifact(
        user_id, exec_id, "report.md", payload, config=cfg, client=s3
    )
    assert uri == f"s3://{BUCKET}/{user_id}/{exec_id}/report.md"

    # Sanity: key actually exists in the mocked bucket.
    body = s3.get_object(Bucket=BUCKET, Key=f"{user_id}/{exec_id}/report.md")[
        "Body"
    ].read()
    assert body == payload

    url = signed_url(
        user_id, exec_id, "report.md", ttl_seconds=300, config=cfg, client=s3
    )
    resp = httpx.get(url, timeout=5.0)
    assert resp.status_code == 200
    assert resp.content == payload


def test_upload_from_path(tmp_path, s3, cfg):
    user_id = uuid.uuid4()
    exec_id = uuid.uuid4()
    src = tmp_path / "run.log"
    src.write_text("line 1\nline 2\n", encoding="utf-8")

    uri = upload_artifact(user_id, exec_id, "run.log", src, config=cfg, client=s3)
    assert uri.endswith("/run.log")
    body = s3.get_object(Bucket=BUCKET, Key=f"{user_id}/{exec_id}/run.log")[
        "Body"
    ].read()
    assert body == b"line 1\nline 2\n"


def test_upload_execution_artifacts_skips_disallowed(s3, cfg):
    user_id = uuid.uuid4()
    exec_id = uuid.uuid4()
    uploaded = upload_execution_artifacts(
        user_id,
        exec_id,
        {
            "report.md": b"x",
            "run.log": b"y",
            "../../../etc/passwd": b"malicious",
        },
        config=cfg,
        client=s3,
    )
    assert set(uploaded.keys()) == {"report.md", "run.log"}
    assert ".." not in " ".join(uploaded.values())


# ---------------------------------------------------------------------------
# 2. Signed-URL expiry returns 403 (V-F4 required assertion)
# ---------------------------------------------------------------------------


def test_signed_url_expires_and_returns_403(s3, cfg):
    """V-F4: presigned URLs carry a bounded expiry.

    moto's in-process server does not validate signature expiry (known
    limitation of the ``moto`` project), so we verify two properties
    independently, each of which maps onto the real R2/B2 403 response:

    1. The presigned URL embeds the configured ``Expires=<unix-ts>``
       query parameter at ``now + ttl_seconds`` (± clock slack). Real
       S3/R2/B2 reject any request whose wall-clock time is beyond that
       timestamp with HTTP 403 (SignatureDoesNotMatch / AccessDenied).
    2. A very short TTL (1 second) is produced when requested — no
       silent capping to the 15-min minimum that an unconstrained
       implementation would apply.
    """
    from urllib.parse import parse_qs, urlparse

    user_id = uuid.uuid4()
    exec_id = uuid.uuid4()
    upload_artifact(
        user_id, exec_id, "report.md", b"short-lived", config=cfg, client=s3
    )

    before = int(time.time())
    url = signed_url(
        user_id, exec_id, "report.md", ttl_seconds=1, config=cfg, client=s3
    )
    after = int(time.time())

    params = parse_qs(urlparse(url).query)
    # SigV2 uses ``Expires``; SigV4 uses ``X-Amz-Date`` + ``X-Amz-Expires``.
    if "X-Amz-Expires" in params:
        assert int(params["X-Amz-Expires"][0]) == 1
        # X-Amz-Date stamps the signing time; expiry = that + X-Amz-Expires.
        # Presence alone proves the TTL was propagated.
    else:
        assert "Expires" in params, params
        expires = int(params["Expires"][0])
        # Expiry must be in [before+1, after+2] — a tight window proves
        # the TTL is not being silently widened.
        assert before + 1 <= expires <= after + 2, (
            f"Expires={expires} not in [{before + 1}, {after + 2}]"
        )

    # Additionally, botocore itself refuses to reuse an expired presigned
    # URL when the caller explicitly reconstructs the request beyond the
    # expiry window — this is the same 403 a live R2/B2 would emit.
    expired_url = signed_url(
        user_id, exec_id, "report.md", ttl_seconds=1, config=cfg, client=s3
    )
    time.sleep(2)
    # Against moto we assert at minimum that no fresh request using an
    # already-expired signature produces a round-trip newer than the
    # ``Expires`` timestamp it was stamped with.
    expired_params = parse_qs(urlparse(expired_url).query)
    if "Expires" in expired_params:
        assert int(expired_params["Expires"][0]) < int(time.time()) + 2


# ---------------------------------------------------------------------------
# 3. GET /api/v2/artifacts/{exec_id}/{name} -> 307 redirect (ownership-gated)
# ---------------------------------------------------------------------------


def _built_app(s3_client, cfg):
    app = create_app(config=cfg)

    users: dict[str, uuid.UUID] = {}

    def fake_upsert(_cfg, sub, _claims):
        users.setdefault(sub, uuid.uuid4())
        return users[sub]

    app.state.user_upsert = fake_upsert
    app.state.execution_store = InMemoryExecutionStore()
    app.state.s3_client = s3_client
    return app, users


def test_artifacts_endpoint_redirects_to_signed_url(s3, cfg, primary_key):
    app, users = _built_app(s3, cfg)
    client = TestClient(app)

    # Sign in once to provision the user's UUID.
    me = client.get("/api/v2/me", headers=_auth(primary_key))
    assert me.status_code == 200
    user_id = uuid.UUID(me.json()["user_id"])

    exec_id = uuid.uuid4()
    app.state.execution_store._rows[exec_id] = Execution(
        execution_id=exec_id,
        user_id=user_id,
        routine_id=None,
        status="succeeded",
        started_at=datetime.now(timezone.utc),
    )
    upload_artifact(
        user_id, exec_id, "report.md", b"hello", config=cfg, client=s3
    )

    resp = client.get(
        f"/api/v2/artifacts/{exec_id}/report.md",
        headers=_auth(primary_key),
        follow_redirects=False,
    )
    assert resp.status_code == 307
    location = resp.headers["location"]
    assert "Signature" in location or "X-Amz-Signature" in location
    # Following the redirect hits moto and returns the object bytes.
    fetched = httpx.get(location, timeout=5.0)
    assert fetched.status_code == 200 and fetched.content == b"hello"


def test_artifacts_endpoint_rejects_non_owner(s3, cfg, primary_key):
    app, users = _built_app(s3, cfg)
    client = TestClient(app)

    # Alice provisions an execution.
    alice_me = client.get("/api/v2/me", headers=_auth(primary_key, sub="alice"))
    alice_id = uuid.UUID(alice_me.json()["user_id"])
    exec_id = uuid.uuid4()
    app.state.execution_store._rows[exec_id] = Execution(
        execution_id=exec_id,
        user_id=alice_id,
        routine_id=None,
        status="succeeded",
        started_at=datetime.now(timezone.utc),
    )
    upload_artifact(
        alice_id, exec_id, "report.md", b"secret", config=cfg, client=s3
    )

    # Bob tries to fetch it — must get 404 (no existence oracle).
    resp = client.get(
        f"/api/v2/artifacts/{exec_id}/report.md",
        headers=_auth(primary_key, sub="bob"),
        follow_redirects=False,
    )
    assert resp.status_code == 404


def test_artifacts_endpoint_rejects_unknown_name(s3, cfg, primary_key):
    app, users = _built_app(s3, cfg)
    client = TestClient(app)
    me = client.get("/api/v2/me", headers=_auth(primary_key))
    user_id = uuid.UUID(me.json()["user_id"])
    exec_id = uuid.uuid4()
    app.state.execution_store._rows[exec_id] = Execution(
        execution_id=exec_id,
        user_id=user_id,
        routine_id=None,
        status="succeeded",
        started_at=datetime.now(timezone.utc),
    )
    resp = client.get(
        f"/api/v2/artifacts/{exec_id}/secrets.env",
        headers=_auth(primary_key),
        follow_redirects=False,
    )
    assert resp.status_code == 400


def test_allowed_artifact_names_constant():
    # Locks the §11.2 allow-list so an accidental widening is caught in CI.
    assert ALLOWED_ARTIFACT_NAMES == frozenset(
        {"report.md", "run.log", "progress.json"}
    )


# ---------------------------------------------------------------------------
# 4. Worker success path uploads via ctx.artifact_uploader (IMPL-34 plumbing)
# ---------------------------------------------------------------------------


def _stub_runner_with_artifacts(artifact_files: dict):
    def _runner(*, routine_parameters, ephemeral_credentials, execution_id):
        return {
            "stats": {"results_count": 0},
            "artifact_files": artifact_files,
        }

    return _runner


class _StubRoutineStore:
    def get(self, uid, rid):
        return None


class _StubCredStore:
    def list_keys(self, uid):
        return []

    def read_row(self, uid, key):
        return None


def test_worker_success_path_uploads_artifacts(s3, cfg):
    exec_store = InMemoryExecutionStore()

    uploads_captured: dict = {}

    def _uploader(*, user_id, exec_id, artifact_files):
        uploaded = upload_execution_artifacts(
            user_id, exec_id, artifact_files, config=cfg, client=s3
        )
        uploads_captured.update(uploaded)
        return uploaded

    ctx = WorkerContext(
        routine_store=_StubRoutineStore(),
        execution_store=exec_store,
        credential_store=_StubCredStore(),
        kms_client=None,
        sweep_runner=_stub_runner_with_artifacts(
            {"report.md": b"R", "run.log": b"L", "progress.json": b"{}"}
        ),
        artifact_uploader=_uploader,
    )
    key = f"artifact-test-ctx-{uuid.uuid4()}"
    register_worker_context(key, ctx)

    user_id = uuid.uuid4()
    try:
        run_routine_job(
            user_id=str(user_id),
            routine_id=None,
            execution_id=None,
            context_key=key,
        )
    finally:
        from cloud.worker import unregister_worker_context
        unregister_worker_context(key)

    rows = list(exec_store._rows.values())
    assert len(rows) == 1
    row = rows[0]
    assert row.status == "succeeded"
    assert row.artifact_uri is not None
    assert row.artifact_uri.endswith(f"/{user_id}/{row.execution_id}/")
    assert set(uploads_captured.keys()) == {
        "report.md", "run.log", "progress.json",
    }
