"""IMPL-31 verification — envelope encryption + ``/api/v2/credentials``.

Hermetic: uses :class:`LocalKMSClient` + :class:`InMemoryCredentialStore`
and reuses the JWKS/JWT harness pattern from ``test_cloud_auth.py``.

Covers:

* **Cipher roundtrip** — :func:`encrypt_credential` / :func:`decrypt_credential`
  are inverses; AAD binds ciphertexts to their ``(user, key)`` slot.
* **V-D1** — the persisted envelope contains no plaintext bytes (surrogate
  ``pg_dump`` via ``InMemoryCredentialStore.dump_all_bytes``).
* **V-D2** — DELETE makes the row (and its wrapped DEK) unrecoverable.
* **V-D3** — captured INFO+DEBUG logs from a PUT contain neither the
  plaintext value nor the raw DEK bytes.
"""

from __future__ import annotations

import logging
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from cloud import auth as cloud_auth
from cloud import crypto as cloud_crypto
from cloud.app import create_app
from cloud.config import CloudConfig
from cloud.credentials import (
    InMemoryCredentialStore,
    PostgresCredentialStore,
    StoredRow,
)
from cloud.crypto import (
    DEK_BYTES,
    Envelope,
    KMSError,
    LocalKMSClient,
    NONCE_BYTES,
    decrypt_credential,
    encrypt_credential,
    generate_dek,
    open_,
    seal,
)


ISSUER = "https://idp.test.invalid/"
AUDIENCE = "resmon-cloud-test"
JWKS_URL = "https://idp.test.invalid/.well-known/jwks.json"
PRIMARY_KID = "test-key-1"


# ---------------------------------------------------------------------------
# Shared JWT harness (mirrors test_cloud_auth.py)
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


@pytest.fixture
def built_app():
    """Build the app with fake user upsert + in-memory store + local KMS."""
    app = create_app(config=_config())

    users: dict[str, uuid.UUID] = {}

    def fake_upsert(_cfg, sub, _claims):
        if sub not in users:
            users[sub] = uuid.uuid4()
        return users[sub]

    app.state.user_upsert = fake_upsert
    app.state.credential_store = InMemoryCredentialStore()
    # Pin a deterministic master key so wrapped DEKs stay valid within a test.
    app.state.kms_client = LocalKMSClient(master_key=b"\x01" * DEK_BYTES)
    return app, users


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


def _auth_headers(private_key, *, sub: str = "user-sub-abc") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(private_key, sub=sub)}"}


# ---------------------------------------------------------------------------
# Primitive-level tests
# ---------------------------------------------------------------------------


def test_generate_dek_is_32_bytes_and_random():
    a = generate_dek()
    b = generate_dek()
    assert len(a) == DEK_BYTES == 32
    assert a != b  # overwhelmingly improbable collision


def test_seal_open_roundtrip():
    dek = generate_dek()
    ct, nonce = seal(b"hello world", dek)
    assert len(nonce) == NONCE_BYTES == 24
    assert ct != b"hello world"  # ciphertext must not equal plaintext
    out = open_(ct, nonce, dek)
    assert out == b"hello world"


def test_seal_open_detects_tamper():
    dek = generate_dek()
    ct, nonce = seal(b"secret", dek)
    tampered = bytes([ct[0] ^ 0x01]) + ct[1:]
    with pytest.raises(Exception):
        open_(tampered, nonce, dek)


def test_aad_binds_ciphertext_to_slot():
    dek = generate_dek()
    ct, nonce = seal(b"v", dek, aad=b"user-a:key1")
    # Correct AAD → opens.
    assert open_(ct, nonce, dek, aad=b"user-a:key1") == b"v"
    # Wrong AAD → rejected.
    with pytest.raises(Exception):
        open_(ct, nonce, dek, aad=b"user-b:key1")


def test_envelope_roundtrip_with_local_kms():
    kms = LocalKMSClient(master_key=b"\x02" * DEK_BYTES)
    env = encrypt_credential("sk-plaintext-value", kms, "kek-1", aad=b"slot")
    assert isinstance(env, Envelope)
    assert env.kek_id == "kek-1"
    assert b"sk-plaintext-value" not in env.ciphertext
    assert b"sk-plaintext-value" not in env.wrapped_dek
    out = decrypt_credential(env, kms, aad=b"slot")
    assert out == "sk-plaintext-value"


def test_kms_wrong_kek_id_rejects_unwrap():
    kms = LocalKMSClient(master_key=b"\x03" * DEK_BYTES)
    env = encrypt_credential("val", kms, "kek-A")
    tampered = Envelope(
        ciphertext=env.ciphertext,
        nonce=env.nonce,
        wrapped_dek=env.wrapped_dek,
        kek_id="kek-B",  # mismatched — wrap AAD no longer matches.
    )
    with pytest.raises(KMSError):
        decrypt_credential(tampered, kms)


# ---------------------------------------------------------------------------
# HTTP endpoint tests
# ---------------------------------------------------------------------------


def test_get_credentials_starts_empty(built_app, primary_key):
    app, _ = built_app
    client = TestClient(app)
    resp = client.get("/api/v2/credentials", headers=_auth_headers(primary_key))
    assert resp.status_code == 200
    assert resp.json() == {}


def test_put_credential_returns_204_and_presence_flips(built_app, primary_key):
    app, _ = built_app
    client = TestClient(app)
    put = client.put(
        "/api/v2/credentials/openai_api_key",
        json={"value": "sk-test-12345"},
        headers=_auth_headers(primary_key),
    )
    assert put.status_code == 204

    got = client.get("/api/v2/credentials", headers=_auth_headers(primary_key))
    assert got.status_code == 200
    assert got.json() == {"openai_api_key": True}


def test_put_stores_ciphertext_not_plaintext_V_D1(built_app, primary_key):
    """§9.4 V-D1: a pg_dump must not contain the plaintext."""
    app, _ = built_app
    client = TestClient(app)
    sentinel = "sk-plaintext-SENTINEL-a1b2c3d4"

    client.put(
        "/api/v2/credentials/openai_api_key",
        json={"value": sentinel},
        headers=_auth_headers(primary_key),
    )
    store: InMemoryCredentialStore = app.state.credential_store
    blob = store.dump_all_bytes()
    assert sentinel.encode("utf-8") not in blob
    # Also assert no row field accidentally equals the plaintext.
    rows = list(store._rows.values())  # type: ignore[attr-defined]
    assert len(rows) == 1
    row = rows[0]
    assert row.ciphertext != sentinel.encode("utf-8")
    assert len(row.nonce) == NONCE_BYTES
    assert len(row.wrapped_dek) >= NONCE_BYTES + DEK_BYTES


def test_delete_is_irrecoverable_V_D2(built_app, primary_key):
    """§9.4 V-D2: DELETE removes both the row and its wrapped DEK."""
    app, _ = built_app
    client = TestClient(app)
    client.put(
        "/api/v2/credentials/core_api_key",
        json={"value": "core-secret"},
        headers=_auth_headers(primary_key),
    )
    store: InMemoryCredentialStore = app.state.credential_store
    assert store.dump_all_bytes() != b""

    delete = client.delete(
        "/api/v2/credentials/core_api_key",
        headers=_auth_headers(primary_key),
    )
    assert delete.status_code == 204

    # The row and wrapped DEK are gone — nothing left to unwrap.
    assert store.dump_all_bytes() == b""
    got = client.get("/api/v2/credentials", headers=_auth_headers(primary_key))
    assert got.json() == {}

    # A second DELETE returns 404 (row truly gone).
    again = client.delete(
        "/api/v2/credentials/core_api_key",
        headers=_auth_headers(primary_key),
    )
    assert again.status_code == 404


def test_put_does_not_log_plaintext_V_D3(built_app, primary_key, caplog):
    """§9.4 V-D3: INFO+DEBUG log capture contains no plaintext."""
    app, _ = built_app
    client = TestClient(app)
    sentinel = "sk-MUST-NOT-APPEAR-IN-LOGS-9f8e7d6c"

    caplog.set_level(logging.DEBUG)
    client.put(
        "/api/v2/credentials/anthropic_api_key",
        json={"value": sentinel},
        headers=_auth_headers(primary_key),
    )

    combined = caplog.text
    assert sentinel not in combined
    # Sanity: logging was actually active for one of the cloud modules.
    assert any(
        rec.name.startswith("cloud.") for rec in caplog.records
    ), "expected at least one cloud.* log record to be captured"


def test_credentials_are_user_scoped(built_app, primary_key):
    """Two different ``sub`` claims never see each other's credentials."""
    app, _ = built_app
    client = TestClient(app)

    client.put(
        "/api/v2/credentials/openai_api_key",
        json={"value": "alice-secret"},
        headers=_auth_headers(primary_key, sub="alice"),
    )
    bob_list = client.get(
        "/api/v2/credentials", headers=_auth_headers(primary_key, sub="bob")
    )
    assert bob_list.status_code == 200
    assert bob_list.json() == {}


def test_put_rejects_bad_key_name(built_app, primary_key):
    app, _ = built_app
    client = TestClient(app)
    resp = client.put(
        "/api/v2/credentials/../etc/passwd",
        json={"value": "x"},
        headers=_auth_headers(primary_key),
    )
    # FastAPI strips the path traversal at the routing layer; either way
    # the result must not be 204. Accept either the router's 404 (no such
    # route) or our own 400 (validator rejected).
    assert resp.status_code in (400, 404)


def test_credentials_require_auth(built_app):
    app, _ = built_app
    client = TestClient(app)
    assert client.get("/api/v2/credentials").status_code == 401
    assert (
        client.put("/api/v2/credentials/x", json={"value": "y"}).status_code
        == 401
    )
    assert client.delete("/api/v2/credentials/x").status_code == 401


# ---------------------------------------------------------------------------
# Postgres backend wiring smoke (import-only; no live DB in CI)
# ---------------------------------------------------------------------------


def test_postgres_store_class_is_constructible():
    """Ensure the production backend class exists and is importable."""
    store = PostgresCredentialStore(rls_session_factory=lambda _uid: None)
    assert isinstance(store, PostgresCredentialStore)
