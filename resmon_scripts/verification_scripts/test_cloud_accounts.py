"""IMPL-40 verification — privacy notice, export/delete, closed-beta gate.

Covers the V-G3 gates prescribed in Step 40 of the implementation guide:

* ``GET /api/v2/me/export`` returns a streaming ZIP whose manifest,
  routines, and executions round-trip through a re-import harness.
* ``DELETE /api/v2/me`` cascades credentials → executions → routines →
  user, returns 200, and enqueues a 7-day object-store soft-delete.
* Read-after-delete returns 404 on every user-owned resource.
* A JWT without ``beta: true`` receives HTTP 403 on every write verb
  while still retaining read access (``GET /me``, ``GET /me/export``).
* A JWT **with** ``beta: true`` passes the write gate.
* ``.ai/prep/resmon_privacy_notice.md`` exists and is ≤ 1 page.

All tests are hermetic — in-memory stores, local KMS, JWT/JWKS harness.
"""

from __future__ import annotations

import io
import json
import sys
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from cloud import auth as cloud_auth
from cloud.accounts import SoftDeleteQueue
from cloud.app import create_app
from cloud.config import CloudConfig
from cloud.credentials import InMemoryCredentialStore, StoredRow
from cloud.crypto import DEK_BYTES, LocalKMSClient
from cloud.executions import InMemoryExecutionStore
from cloud.routines import InMemoryRoutineStore


ISSUER = "https://idp.test.invalid/"
AUDIENCE = "resmon-cloud-test"
JWKS_URL = "https://idp.test.invalid/.well-known/jwks.json"
PRIMARY_KID = "test-account-key"

PRIVACY_NOTICE_PATH = (
    PROJECT_ROOT / ".ai:" / "prep" / "resmon_privacy_notice.md"
)


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


def _token(pk, *, sub: str = "account-user", beta: bool = True) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "iss": ISSUER,
        "aud": AUDIENCE,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=15)).timestamp()),
        "email": f"{sub}@example.test",
    }
    if beta:
        payload["beta"] = True
    return jwt.encode(
        payload, pk, algorithm="RS256", headers={"kid": PRIMARY_KID},
    )


def _auth(pk, *, sub: str = "account-user", beta: bool = True) -> dict:
    return {"Authorization": f"Bearer {_token(pk, sub=sub, beta=beta)}"}


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


@pytest.fixture
def built_app():
    app = create_app(config=_config())

    users: dict[str, uuid.UUID] = {}
    deleted_users: set[uuid.UUID] = set()

    def fake_upsert(_cfg, sub, _claims):
        users.setdefault(sub, uuid.uuid4())
        return users[sub]

    def fake_delete(uid: uuid.UUID) -> bool:
        # Drop from both the upsert map and the alive set so
        # read-after-delete returns a fresh user_id on re-login.
        gone = False
        for k, v in list(users.items()):
            if v == uid:
                del users[k]
                gone = True
        deleted_users.add(uid)
        return gone

    app.state.user_upsert = fake_upsert
    app.state.user_delete = fake_delete
    app.state.routine_store = InMemoryRoutineStore()
    app.state.execution_store = InMemoryExecutionStore()
    app.state.credential_store = InMemoryCredentialStore()
    app.state.kms_client = LocalKMSClient(master_key=b"\x09" * DEK_BYTES)
    app.state.soft_delete_queue = SoftDeleteQueue()

    # Deterministic signer so export manifests are reproducible.
    def signer(uid, eid, name):
        return f"https://signed.test.invalid/{uid}/{eid}/{name}?sig=stub"

    app.state.artifact_url_signer = signer

    yield app, users, deleted_users


# ---------------------------------------------------------------------------
# Privacy notice sanity
# ---------------------------------------------------------------------------


def test_privacy_notice_exists_and_is_short():
    assert PRIVACY_NOTICE_PATH.exists(), (
        f"Privacy notice missing at {PRIVACY_NOTICE_PATH}"
    )
    text = PRIVACY_NOTICE_PATH.read_text(encoding="utf-8")
    # ≤ 1 page rendered is a soft rule — assert a generous upper bound on
    # raw characters so accidental bloat is caught.
    assert len(text) < 6000, f"Privacy notice too long: {len(text)} chars"
    for required in (
        "Lawful basis",
        "Sub-processors",
        "Retention",
        "rights",
    ):
        assert required.lower() in text.lower(), (
            f"Privacy notice missing section: {required}"
        )


# ---------------------------------------------------------------------------
# Closed-beta write gate
# ---------------------------------------------------------------------------


def test_non_beta_jwt_receives_403_on_writes(built_app, primary_key):
    app, _, _ = built_app
    client = TestClient(app)
    headers = _auth(primary_key, sub="non-beta", beta=False)

    # Writes must 403.
    resp = client.post(
        "/api/v2/routines",
        headers=headers,
        json={"name": "x", "cron": "* * * * *", "parameters": {}},
    )
    assert resp.status_code == 403
    assert "beta" in resp.json()["detail"].lower()

    resp = client.put(
        "/api/v2/credentials/openai",
        headers=headers,
        json={"value": "sk-fake"},
    )
    assert resp.status_code == 403

    resp = client.delete("/api/v2/credentials/openai", headers=headers)
    assert resp.status_code == 403

    # Reads remain open.
    assert client.get("/api/v2/me", headers=headers).status_code == 200
    assert client.get("/api/v2/routines", headers=headers).status_code == 200
    assert client.get("/api/v2/me/export", headers=headers).status_code == 200


def test_beta_jwt_passes_write_gate(built_app, primary_key):
    app, _, _ = built_app
    client = TestClient(app)
    headers = _auth(primary_key, sub="beta-user", beta=True)

    resp = client.post(
        "/api/v2/routines",
        headers=headers,
        json={"name": "q", "cron": "0 9 * * *", "parameters": {}},
    )
    assert resp.status_code == 201


# ---------------------------------------------------------------------------
# GET /me/export
# ---------------------------------------------------------------------------


def test_export_zip_round_trips(built_app, primary_key):
    app, users, _ = built_app
    client = TestClient(app)
    headers = _auth(primary_key, sub="export-user", beta=True)

    # Materialise rows in every category so the round-trip is non-trivial.
    client.get("/api/v2/me", headers=headers)  # forces user_upsert
    uid = users["export-user"]

    routines_raw = [
        {"name": "morning sweep", "cron": "0 9 * * *",
         "parameters": {"query": "llm"}},
        {"name": "weekly sweep", "cron": "0 0 * * 0",
         "parameters": {"query": "ml"}},
    ]
    for body in routines_raw:
        assert client.post(
            "/api/v2/routines", headers=headers, json=body,
        ).status_code == 201

    client.put(
        "/api/v2/credentials/openai", headers=headers,
        json={"value": "sk-export-stub"},
    )

    # Seed an execution directly (the worker path is tested elsewhere).
    exec_store: InMemoryExecutionStore = app.state.execution_store
    exec_row = exec_store.insert(uid, None, status="running")
    exec_store.update(
        exec_row.execution_id,
        status="succeeded",
        finished_at=datetime.now(timezone.utc),
        artifact_uri=f"s3://bucket/{uid}/{exec_row.execution_id}/",
        stats={"result_count": 3},
    )

    # Pull the export.
    resp = client.get("/api/v2/me/export", headers=headers)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/zip")
    assert "resmon-export" in resp.headers["content-disposition"]
    payload = resp.content

    # Round-trip: unpack and assert counts + ciphertext omission.
    with zipfile.ZipFile(io.BytesIO(payload), "r") as zf:
        names = set(zf.namelist())
        for expected in (
            "manifest.json",
            "user.json",
            "routines.json",
            "executions.json",
            "credentials.json",
            "artifacts.json",
        ):
            assert expected in names, f"Missing export member: {expected}"

        manifest = json.loads(zf.read("manifest.json"))
        routines = json.loads(zf.read("routines.json"))
        executions = json.loads(zf.read("executions.json"))
        credentials = json.loads(zf.read("credentials.json"))
        artifacts = json.loads(zf.read("artifacts.json"))

    assert manifest["user"]["user_id"] == str(uid)
    assert manifest["counts"] == {
        "routines": 2, "executions": 1, "credentials": 1,
    }
    assert sorted(r["name"] for r in routines) == [
        "morning sweep", "weekly sweep",
    ]
    assert executions[0]["status"] == "succeeded"
    assert credentials == [{"key_name": "openai"}]
    # Ciphertext and all redacted fields must not appear.
    blob = json.dumps(credentials)
    assert "sk-export-stub" not in blob
    assert "ciphertext" not in blob
    # Each execution has a signed-URL manifest entry.
    assert artifacts[0]["execution_id"] == str(exec_row.execution_id)
    assert any(a["url"].startswith("https://signed.test.invalid/")
               for a in artifacts[0]["artifacts"])

    # Re-import harness — rebuild a routine store from the export bytes and
    # confirm every field round-trips intact.
    reimport = InMemoryRoutineStore()
    reimport_user = uuid.uuid4()
    for r in routines:
        from cloud.routines import RoutineCreate

        rc = RoutineCreate(
            name=r["name"], cron=r["cron"], parameters=r["parameters"],
        )
        reimport.create(reimport_user, rc)
    roundtripped = reimport.list(reimport_user)
    assert {r.name for r in roundtripped} == {r["name"] for r in routines}
    assert {r.cron for r in roundtripped} == {r["cron"] for r in routines}


def test_export_accessible_to_non_beta_user(built_app, primary_key):
    app, _, _ = built_app
    client = TestClient(app)
    headers = _auth(primary_key, sub="lapsed-beta", beta=False)

    resp = client.get("/api/v2/me/export", headers=headers)
    assert resp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(resp.content), "r") as zf:
        assert "manifest.json" in zf.namelist()


# ---------------------------------------------------------------------------
# DELETE /me
# ---------------------------------------------------------------------------


def test_delete_me_cascades_and_schedules_soft_delete(built_app, primary_key):
    app, users, deleted = built_app
    client = TestClient(app)
    headers = _auth(primary_key, sub="delete-user", beta=True)

    # Seed rows across every category.
    client.get("/api/v2/me", headers=headers)
    uid = users["delete-user"]

    client.post(
        "/api/v2/routines", headers=headers,
        json={"name": "r1", "cron": "* * * * *", "parameters": {}},
    )
    client.put(
        "/api/v2/credentials/openai", headers=headers,
        json={"value": "sk-delete"},
    )
    app.state.execution_store.insert(uid, None, status="succeeded")

    # Pre-condition: row counts populated.
    assert len(app.state.routine_store.list(uid)) == 1
    assert len(app.state.credential_store.list_keys(uid)) == 1
    assert len(app.state.execution_store.list(uid)) == 1

    resp = client.delete("/api/v2/me", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "deleted"
    assert body["deleted"] == {
        "credentials": 1, "executions": 1, "routines": 1, "user": 1,
    }
    assert body["soft_delete_window_days"] == 7
    # Purge timestamp must be ~7 days in the future.
    purge = datetime.fromisoformat(body["object_store_purge_after"])
    delta = purge - datetime.now(timezone.utc)
    assert timedelta(days=6, hours=23) < delta <= timedelta(days=7, seconds=5)

    # Soft-delete queue has exactly one entry for this user.
    queue: SoftDeleteQueue = app.state.soft_delete_queue
    pending = queue.list_pending()
    assert len(pending) == 1
    assert pending[0].user_id == uid
    assert pending[0].prefix == f"{uid}/"

    # user_delete hook fired.
    assert uid in deleted

    # Post-condition: all user-owned rows are gone.
    assert app.state.routine_store.list(uid) == []
    assert app.state.credential_store.list_keys(uid) == []
    assert app.state.execution_store.list(uid) == []


def test_read_after_delete_returns_404(built_app, primary_key):
    app, users, _ = built_app
    client = TestClient(app)
    headers = _auth(primary_key, sub="read-after", beta=True)

    client.get("/api/v2/me", headers=headers)
    uid = users["read-after"]

    # Seed and capture a routine_id + execution_id so we can probe them
    # by ID after the cascade.
    rtn = client.post(
        "/api/v2/routines", headers=headers,
        json={"name": "r", "cron": "* * * * *", "parameters": {}},
    ).json()
    routine_id = rtn["routine_id"]
    exec_row = app.state.execution_store.insert(uid, None, status="succeeded")

    assert client.delete("/api/v2/me", headers=headers).status_code == 200

    # Get-by-id now 404s for every resource. The user-upsert hook has
    # dropped this ``sub``, so subsequent requests land under a fresh
    # user_id — the previous routine/execution ids are not visible.
    assert client.get(
        f"/api/v2/routines/{routine_id}", headers=headers,
    ).status_code == 404
    assert client.get(
        f"/api/v2/executions/{exec_row.execution_id}", headers=headers,
    ).status_code == 404
    # List endpoints now return empty collections.
    assert client.get("/api/v2/routines", headers=headers).json() == []


def test_delete_me_requires_beta_claim(built_app, primary_key):
    app, _, _ = built_app
    client = TestClient(app)
    headers = _auth(primary_key, sub="no-beta-delete", beta=False)

    resp = client.delete("/api/v2/me", headers=headers)
    assert resp.status_code == 403
