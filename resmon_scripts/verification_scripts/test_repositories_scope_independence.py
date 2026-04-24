"""IMPL-38 verification — Repositories Page scope independence.

This test asserts the *backend* invariant that the local-keyring credential
endpoint (``/api/credentials/{name}``) and the cloud envelope-encrypted
endpoint (``/api/v2/credentials/{name}``) are independent stores. The UI
scope selector in :file:`resmon_scripts/frontend/src/pages/RepositoriesPage.tsx`
relies on this property so that switching between "This device (keyring)"
and "Cloud account" surfaces only the credentials saved in the active
scope.

Coverage matches the IMPL-38 verification matrix in
``resmon_routines_and_accounts.md`` §12.1 and the prompt's Playwright
scenario (transcribed to a hermetic FastAPI ``TestClient`` round-trip
because the desktop app has no JS test runner installed yet — Playwright
remains a CI-gated future task per the IMPL-37 precedent):

1.  Save key under **local** scope → local presence flips to True; cloud
    presence remains empty.
2.  Save (a different) key under **cloud** scope → cloud presence flips
    to True for that name; local presence is untouched.
3.  Delete on one scope leaves the other scope intact.
"""

from __future__ import annotations

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

import resmon as resmon_mod
from cloud import auth as cloud_auth
from cloud.app import create_app
from cloud.config import CloudConfig
from cloud.credentials import InMemoryCredentialStore
from cloud.crypto import DEK_BYTES, LocalKMSClient


ISSUER = "https://idp.test.invalid/"
AUDIENCE = "resmon-cloud-test"
JWKS_URL = "https://idp.test.invalid/.well-known/jwks.json"
PRIMARY_KID = "test-key-1"


# ---------------------------------------------------------------------------
# Local (keyring) test client — in-memory keyring stub
# ---------------------------------------------------------------------------


class _MemoryKeyring:
    """Drop-in replacement for the OS keyring during the test."""

    def __init__(self) -> None:
        self._store: dict[str, str] = {}

    def get(self, name: str) -> str | None:
        return self._store.get(name)

    def set(self, name: str, value: str) -> None:
        self._store[name] = value

    def delete(self, name: str) -> None:
        self._store.pop(name, None)


@pytest.fixture
def local_client(monkeypatch):
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    keyring = _MemoryKeyring()
    monkeypatch.setattr(resmon_mod, "get_credential", lambda n: keyring.get(n))
    monkeypatch.setattr(resmon_mod, "store_credential", lambda n, v: keyring.set(n, v))
    monkeypatch.setattr(resmon_mod, "delete_credential", lambda n: keyring.delete(n))
    from resmon import app
    return TestClient(app), keyring


# ---------------------------------------------------------------------------
# Cloud test client — JWKS-stubbed, in-memory credential store + local KMS
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


def _cloud_config() -> CloudConfig:
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
def cloud_client(primary_key):
    app = create_app(config=_cloud_config())
    users: dict[str, uuid.UUID] = {}

    def fake_upsert(_cfg, sub, _claims):
        users.setdefault(sub, uuid.uuid4())
        return users[sub]

    app.state.user_upsert = fake_upsert
    app.state.credential_store = InMemoryCredentialStore()
    app.state.kms_client = LocalKMSClient(master_key=b"\x07" * DEK_BYTES)

    now = datetime.now(timezone.utc)
    token = jwt.encode(
        {
            "sub": "user-impl38",
            "iss": ISSUER,
            "aud": AUDIENCE,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=15)).timestamp()),
            "beta": True,
        },
        primary_key,
        algorithm="RS256",
        headers={"kid": PRIMARY_KID},
    )
    headers = {"Authorization": f"Bearer {token}"}
    return TestClient(app), headers


# ---------------------------------------------------------------------------
# Scope-independence assertions
# ---------------------------------------------------------------------------


def test_local_save_does_not_appear_in_cloud(local_client, cloud_client):
    """Saving under "This device" must not flip cloud presence."""
    lc, _ = local_client
    cc, headers = cloud_client

    # 1) Save under local scope.
    put = lc.put("/api/credentials/openai_api_key", json={"value": "sk-LOCAL-only"})
    assert put.status_code in (200, 204)

    local_pres = lc.get("/api/credentials").json()
    assert local_pres["openai_api_key"]["present"] is True

    # 2) Cloud presence remains empty for this user.
    cloud_pres = cc.get("/api/v2/credentials", headers=headers).json()
    assert cloud_pres == {}, f"cloud scope leaked local key: {cloud_pres}"


def test_cloud_save_does_not_appear_in_local(local_client, cloud_client):
    """Saving under "Cloud account" must not flip local presence."""
    lc, _ = local_client
    cc, headers = cloud_client

    # 1) Save under cloud scope.
    put = cc.put(
        "/api/v2/credentials/openai_api_key",
        json={"value": "sk-CLOUD-only"},
        headers=headers,
    )
    assert put.status_code == 204

    cloud_pres = cc.get("/api/v2/credentials", headers=headers).json()
    assert cloud_pres == {"openai_api_key": True}

    # 2) Local presence stays False for the same name.
    local_pres = lc.get("/api/credentials").json()
    assert local_pres["openai_api_key"]["present"] is False, (
        f"local scope leaked cloud key: {local_pres['openai_api_key']}"
    )


def test_round_trip_independence_per_prompt(local_client, cloud_client):
    """Verbatim prompt scenario:
       (a) save under "This device", switch to "Cloud account" → no presence;
       (b) save under "Cloud account", switch back → independence preserved.
    """
    lc, _ = local_client
    cc, headers = cloud_client

    # (a) Save key under "This device" then check cloud presence is empty.
    lc.put("/api/credentials/core_api_key", json={"value": "core-LOCAL"})
    assert lc.get("/api/credentials").json()["core_api_key"]["present"] is True
    assert cc.get("/api/v2/credentials", headers=headers).json() == {}

    # (b) Save under cloud, then switch back and verify both scopes
    # independently report only their own keys.
    cc.put(
        "/api/v2/credentials/core_api_key",
        json={"value": "core-CLOUD"},
        headers=headers,
    )
    cloud_pres = cc.get("/api/v2/credentials", headers=headers).json()
    local_pres = lc.get("/api/credentials").json()
    assert cloud_pres == {"core_api_key": True}
    assert local_pres["core_api_key"]["present"] is True

    # Deleting from the cloud must leave the local copy intact.
    delc = cc.delete("/api/v2/credentials/core_api_key", headers=headers)
    assert delc.status_code in (200, 204)
    assert cc.get("/api/v2/credentials", headers=headers).json() == {}
    assert lc.get("/api/credentials").json()["core_api_key"]["present"] is True

    # And the inverse — deleting locally must leave the cloud free of leakage.
    cc.put(
        "/api/v2/credentials/core_api_key",
        json={"value": "core-CLOUD-2"},
        headers=headers,
    )
    dell = lc.delete("/api/credentials/core_api_key")
    assert dell.status_code in (200, 204)
    assert lc.get("/api/credentials").json()["core_api_key"]["present"] is False
    assert cc.get("/api/v2/credentials", headers=headers).json() == {"core_api_key": True}
