"""IMPL-29 verification — JWKS verification, user upsert, auth dependency.

Hermetic offline tests only — no network, no real JWKS URL. A static
RSA key pair is generated per session, exposed as a JWKS dict, and
:func:`cloud.auth._fetch_jwks_raw` is monkeypatched to return it.

Covers V-C1 (missing token → 401), V-C2 (wrong issuer → 401, plus
tampered signature → 401), V-C3 (expired exp → 401), and the happy
path (valid token → 200 + sub-keyed upsert returns the same user_id
on second sighting).

V-C4 (cross-user RLS) is asserted in :file:`test_cloud_migrations.py`
under the ``@pg_required`` gate; documenting the cross-reference here
satisfies the IMPL-29 prompt's "combine with Step 28 tests" clause.
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
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from cloud import auth as cloud_auth
from cloud.app import create_app
from cloud.config import CloudConfig


ISSUER = "https://idp.test.invalid/"
AUDIENCE = "resmon-cloud-test"
JWKS_URL = "https://idp.test.invalid/.well-known/jwks.json"
PRIMARY_KID = "test-key-1"
FOREIGN_KID = "foreign-key-1"


# ---------------------------------------------------------------------------
# Key + JWKS fixtures
# ---------------------------------------------------------------------------


def _gen_rsa() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwk_for(private_key: rsa.RSAPrivateKey, kid: str) -> dict:
    """Return a JWK dict for the public half of ``private_key``."""
    import json

    raw = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key())
    jwk = json.loads(raw) if isinstance(raw, str) else raw
    jwk["kid"] = kid
    jwk["alg"] = "RS256"
    jwk["use"] = "sig"
    return jwk


@pytest.fixture(scope="module")
def primary_key() -> rsa.RSAPrivateKey:
    return _gen_rsa()


@pytest.fixture(scope="module")
def foreign_key() -> rsa.RSAPrivateKey:
    return _gen_rsa()


@pytest.fixture(scope="module")
def jwks_doc(primary_key) -> dict:
    return {"keys": [_jwk_for(primary_key, PRIMARY_KID)]}


@pytest.fixture(autouse=True)
def _patch_jwks(monkeypatch, jwks_doc):
    """Replace the network fetcher with a static dict for every test."""
    cloud_auth.reset_jwks_cache()
    monkeypatch.setattr(cloud_auth, "_fetch_jwks_raw", lambda url: jwks_doc)
    yield
    cloud_auth.reset_jwks_cache()


# ---------------------------------------------------------------------------
# App fixture
# ---------------------------------------------------------------------------


def _config() -> CloudConfig:
    return CloudConfig(
        database_url="sqlite:///:memory:",
        redis_url=None,
        object_store_endpoint="http://minio:9000",
        object_store_bucket="resmon-artifacts",
        kms_key_id=None,
        jwt_issuer=ISSUER,
        jwt_audience=AUDIENCE,
        jwks_url=JWKS_URL,
        allowed_origins=(),
        log_level="INFO",
    )


@pytest.fixture
def app_and_upserts():
    """Build the app with an in-memory upsert that records every sub seen."""
    app = create_app(config=_config())
    seen: dict[str, uuid.UUID] = {}

    def fake_upsert(_cfg, sub, _claims):
        if sub not in seen:
            seen[sub] = uuid.uuid4()
        return seen[sub]

    app.state.user_upsert = fake_upsert
    return app, seen


# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------


def _make_token(
    private_key: rsa.RSAPrivateKey,
    *,
    kid: str = PRIMARY_KID,
    sub: str = "user-sub-abc",
    iss: str = ISSUER,
    aud: str = AUDIENCE,
    exp_delta: timedelta = timedelta(minutes=15),
    extra: dict[str, Any] | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": sub,
        "iss": iss,
        "aud": aud,
        "iat": int(now.timestamp()),
        "exp": int((now + exp_delta).timestamp()),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, private_key, algorithm="RS256", headers={"kid": kid})


# ---------------------------------------------------------------------------
# /health remains unauthenticated
# ---------------------------------------------------------------------------


def test_health_is_unauthenticated(app_and_upserts):
    app, _ = app_and_upserts
    resp = TestClient(app).get("/api/v2/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ---------------------------------------------------------------------------
# 401 paths (V-C1, V-C2, V-C3)
# ---------------------------------------------------------------------------


def test_missing_token_returns_401(app_and_upserts):
    app, _ = app_and_upserts
    resp = TestClient(app).get("/api/v2/me")
    assert resp.status_code == 401


def test_tampered_signature_returns_401(app_and_upserts, primary_key):
    app, _ = app_and_upserts
    token = _make_token(primary_key)
    # Flip the last character of the signature segment.
    head, payload, sig = token.split(".")
    tampered_sig = ("A" if sig[-1] != "A" else "B") + sig[:-1]
    bad = ".".join([head, payload, tampered_sig])
    resp = TestClient(app).get("/api/v2/me", headers={"Authorization": f"Bearer {bad}"})
    assert resp.status_code == 401


def test_token_signed_by_foreign_key_returns_401(app_and_upserts, foreign_key):
    app, _ = app_and_upserts
    # Foreign key is not in the JWKS, but reuses the published kid.
    token = _make_token(foreign_key, kid=PRIMARY_KID)
    resp = TestClient(app).get(
        "/api/v2/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 401


def test_wrong_issuer_returns_401(app_and_upserts, primary_key):
    app, _ = app_and_upserts
    token = _make_token(primary_key, iss="https://attacker.example/")
    resp = TestClient(app).get(
        "/api/v2/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 401


def test_wrong_audience_returns_401(app_and_upserts, primary_key):
    app, _ = app_and_upserts
    token = _make_token(primary_key, aud="some-other-audience")
    resp = TestClient(app).get(
        "/api/v2/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 401


def test_expired_exp_returns_401(app_and_upserts, primary_key):
    app, _ = app_and_upserts
    token = _make_token(primary_key, exp_delta=timedelta(seconds=-30))
    resp = TestClient(app).get(
        "/api/v2/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 401


def test_unknown_kid_returns_401(app_and_upserts, primary_key):
    app, _ = app_and_upserts
    token = _make_token(primary_key, kid="no-such-kid")
    resp = TestClient(app).get(
        "/api/v2/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Happy path + upsert (V-C2 inverted)
# ---------------------------------------------------------------------------


def test_valid_token_returns_200_and_upserts(app_and_upserts, primary_key):
    app, seen = app_and_upserts
    token = _make_token(primary_key, sub="user-sub-happy")
    client = TestClient(app)

    resp = client.get("/api/v2/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["sub"] == "user-sub-happy"
    uid_first = uuid.UUID(body["user_id"])
    assert seen["user-sub-happy"] == uid_first

    # Second call with the same sub must return the same user_id.
    resp2 = client.get("/api/v2/me", headers={"Authorization": f"Bearer {token}"})
    assert resp2.status_code == 200
    assert uuid.UUID(resp2.json()["user_id"]) == uid_first
    assert len(seen) == 1


# ---------------------------------------------------------------------------
# JWKS cache TTL behavior
# ---------------------------------------------------------------------------


def test_jwks_cache_respects_ttl(monkeypatch, jwks_doc):
    cloud_auth.reset_jwks_cache()
    cloud_auth.set_jwks_ttl(60)
    calls = {"n": 0}

    def counting_fetch(url):
        calls["n"] += 1
        return jwks_doc

    monkeypatch.setattr(cloud_auth, "_fetch_jwks_raw", counting_fetch)
    cloud_auth.fetch_jwks(JWKS_URL)
    cloud_auth.fetch_jwks(JWKS_URL)
    cloud_auth.fetch_jwks(JWKS_URL)
    assert calls["n"] == 1, "JWKS should be cached within its TTL window"

    # Force expiry and confirm a refetch occurs.
    cloud_auth.set_jwks_ttl(0.0)
    time.sleep(0.001)
    cloud_auth.fetch_jwks(JWKS_URL)
    assert calls["n"] == 2

    # Restore default for subsequent tests.
    cloud_auth.set_jwks_ttl(600)


def test_no_keyring_import_in_auth_module():
    src = (PROJECT_ROOT / "resmon_scripts" / "cloud" / "auth.py").read_text()
    assert "import keyring" not in src
    assert "from keyring" not in src
