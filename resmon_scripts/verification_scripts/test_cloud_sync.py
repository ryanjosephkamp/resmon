"""IMPL-35 verification — ``/api/v2/sync`` cursor endpoint.

Covers V-F1, V-F2, V-F3 from ``resmon_routines_and_accounts.md`` §11.3:

* **V-F1** — empty DB → ``{routines:[], executions:[], credentials_presence:{},
  next_version:0, has_more:false}``.
* **V-F2** — after inserts, ``/sync?since=0`` returns exactly the new rows;
  a follow-up call with ``since=next_version`` returns empty.
* **V-F3** — ``limit`` is respected; ``has_more`` flips to ``True`` when
  more rows exist beyond the page cap, and the next call with the returned
  cursor drains the tail.

Also covers the Alembic 0002 invariants (trigger function + three ``BEFORE
UPDATE`` triggers) and the auth-gate on ``/sync``. Hermetic — no live
Postgres, no network, reuses the RS256 JWKS harness from
``test_cloud_routines_worker.py``.
"""

from __future__ import annotations

import importlib
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
from cloud.sync import (
    InMemorySyncStore,
    PostgresSyncStore,
    SyncPage,
    SyncStore,
    build_sync_router,
)


ISSUER = "https://idp.test.invalid/"
AUDIENCE = "resmon-cloud-test"
JWKS_URL = "https://idp.test.invalid/.well-known/jwks.json"
PRIMARY_KID = "test-key-1"
MIGRATION_MODULE = "cloud.migrations.versions.rev_0002_sync_version_triggers"


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


def _token(private_key: rsa.RSAPrivateKey, *, sub: str = "user-sync") -> str:
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


def _auth(private_key, *, sub: str = "user-sync") -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(private_key, sub=sub)}"}


# ---------------------------------------------------------------------------
# App fixture
# ---------------------------------------------------------------------------


@pytest.fixture
def built_app():
    app = create_app(config=_config())
    users: dict[str, uuid.UUID] = {}

    def fake_upsert(_cfg, sub, _claims):
        users.setdefault(sub, uuid.uuid4())
        return users[sub]

    app.state.user_upsert = fake_upsert
    app.state.sync_store = InMemorySyncStore()
    yield app, users


def _user_id(users: dict, sub: str, private_key, client) -> uuid.UUID:
    # A cheap way to make sure the upsert has run before we seed rows for
    # the user: hit ``/me`` once so ``fake_upsert`` assigns a UUID.
    client.get("/api/v2/me", headers=_auth(private_key, sub=sub))
    return users[sub]


# ---------------------------------------------------------------------------
# Migration module — offline invariants for the UPDATE trigger
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def migration_0002():
    return importlib.import_module(MIGRATION_MODULE)


def test_migration_metadata(migration_0002):
    assert migration_0002.revision == "0002_sync_version_triggers"
    assert migration_0002.down_revision == "0001_initial_schema"


def test_upgrade_sql_defines_trigger_function_and_three_triggers(migration_0002):
    sql = migration_0002.UPGRADE_SQL
    assert "CREATE OR REPLACE FUNCTION bump_change_version()" in sql
    assert "NEW.version := nextval('change_version')" in sql
    for tbl in ("routines", "executions", "credentials"):
        assert f"BEFORE UPDATE ON {tbl}" in sql, f"missing trigger on {tbl}"


def test_downgrade_drops_triggers_then_function(migration_0002):
    sql = migration_0002.DOWNGRADE_SQL
    # Triggers dropped before the function they depend on.
    assert sql.index("DROP TRIGGER") < sql.index("DROP FUNCTION")
    for tbl in ("routines", "executions", "credentials"):
        assert f"trg_{tbl}_bump_version" in sql


# ---------------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------------


def test_sync_requires_auth(built_app):
    app, _ = built_app
    client = TestClient(app)
    assert client.get("/api/v2/sync").status_code == 401


# ---------------------------------------------------------------------------
# V-F1 — empty DB
# ---------------------------------------------------------------------------


def test_sync_empty_db_returns_zero_cursor(built_app, primary_key):
    app, _ = built_app
    client = TestClient(app)
    r = client.get("/api/v2/sync?since=0", headers=_auth(primary_key))
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "routines": [],
        "executions": [],
        "credentials_presence": {},
        "next_version": 0,
        "has_more": False,
    }


# ---------------------------------------------------------------------------
# V-F2 — cursor advances, second call returns empty
# ---------------------------------------------------------------------------


def test_sync_advances_after_inserts_and_drains(built_app, primary_key):
    app, users = built_app
    client = TestClient(app)
    uid = _user_id(users, "user-sync", primary_key, client)

    store: InMemorySyncStore = app.state.sync_store
    rid = uuid.uuid4()
    store.insert_routine(
        uid,
        {
            "routine_id": str(rid),
            "name": "alpha",
            "parameters": {"query": "llm"},
            "cron": "0 9 * * *",
            "enabled": True,
        },
    )
    eid = uuid.uuid4()
    store.insert_execution(
        uid,
        {
            "execution_id": str(eid),
            "routine_id": str(rid),
            "status": "succeeded",
            "artifact_uri": "s3://bucket/users/x/executions/y/report.md",
        },
    )
    store.upsert_credential(uid, "openai_api_key")

    first = client.get("/api/v2/sync?since=0", headers=_auth(primary_key)).json()
    assert len(first["routines"]) == 1
    assert first["routines"][0]["routine_id"] == str(rid)
    assert len(first["executions"]) == 1
    assert first["executions"][0]["execution_id"] == str(eid)
    assert first["credentials_presence"] == {"openai_api_key": True}
    assert first["next_version"] == 3  # three monotonic writes
    assert first["has_more"] is False

    # Second call with the advanced cursor returns empty.
    second = client.get(
        f"/api/v2/sync?since={first['next_version']}",
        headers=_auth(primary_key),
    ).json()
    assert second == {
        "routines": [],
        "executions": [],
        "credentials_presence": {},
        "next_version": 0,
        "has_more": False,
    }


# ---------------------------------------------------------------------------
# V-F2 (cont.) — updates bump the cursor
# ---------------------------------------------------------------------------


def test_sync_cursor_advances_on_update(built_app, primary_key):
    app, users = built_app
    client = TestClient(app)
    uid = _user_id(users, "user-sync", primary_key, client)

    store: InMemorySyncStore = app.state.sync_store
    rid = uuid.uuid4()
    store.insert_routine(
        uid,
        {
            "routine_id": str(rid),
            "name": "alpha",
            "parameters": {},
            "cron": "* * * * *",
            "enabled": True,
        },
    )
    first = client.get("/api/v2/sync?since=0", headers=_auth(primary_key)).json()
    cursor = first["next_version"]

    # An UPDATE bumps the version (the Postgres BEFORE UPDATE trigger; in
    # the in-memory store the ``update_routine`` helper emulates it).
    store.update_routine(uid, rid, enabled=False)
    second = client.get(
        f"/api/v2/sync?since={cursor}", headers=_auth(primary_key)
    ).json()
    assert len(second["routines"]) == 1
    assert second["routines"][0]["enabled"] is False
    assert second["next_version"] > cursor


# ---------------------------------------------------------------------------
# V-F3 — limit respected, has_more flips
# ---------------------------------------------------------------------------


def test_sync_respects_limit_and_signals_has_more(built_app, primary_key):
    app, users = built_app
    client = TestClient(app)
    uid = _user_id(users, "user-sync", primary_key, client)

    store: InMemorySyncStore = app.state.sync_store
    # Five routines → limit=2 → page 1 has 2 + has_more=True; page 2 has 2
    # + has_more=True; page 3 has 1 + has_more=False.
    rids = [uuid.uuid4() for _ in range(5)]
    for i, rid in enumerate(rids):
        store.insert_routine(
            uid,
            {
                "routine_id": str(rid),
                "name": f"r{i}",
                "parameters": {},
                "cron": "* * * * *",
                "enabled": True,
            },
        )

    cursor = 0
    seen: list[str] = []
    has_more = True
    while has_more:
        body = client.get(
            f"/api/v2/sync?since={cursor}&limit=2", headers=_auth(primary_key)
        ).json()
        assert len(body["routines"]) <= 2
        seen.extend(r["routine_id"] for r in body["routines"])
        cursor = body["next_version"]
        has_more = body["has_more"]

    assert sorted(seen) == sorted(str(r) for r in rids)
    # After draining, a follow-up call is empty.
    tail = client.get(
        f"/api/v2/sync?since={cursor}", headers=_auth(primary_key)
    ).json()
    assert tail["routines"] == []
    assert tail["has_more"] is False


# ---------------------------------------------------------------------------
# Cross-user isolation (belt-and-braces — RLS mirror in memory)
# ---------------------------------------------------------------------------


def test_sync_is_user_scoped(built_app, primary_key):
    app, users = built_app
    client = TestClient(app)
    alice = _user_id(users, "alice", primary_key, client)
    bob = _user_id(users, "bob", primary_key, client)

    store: InMemorySyncStore = app.state.sync_store
    store.insert_routine(
        alice,
        {
            "routine_id": str(uuid.uuid4()),
            "name": "alices-routine",
            "parameters": {},
            "cron": "* * * * *",
            "enabled": True,
        },
    )
    bob_body = client.get(
        "/api/v2/sync?since=0", headers=_auth(primary_key, sub="bob")
    ).json()
    assert bob_body["routines"] == []
    assert bob_body["next_version"] == 0

    alice_body = client.get(
        "/api/v2/sync?since=0", headers=_auth(primary_key, sub="alice")
    ).json()
    assert len(alice_body["routines"]) == 1


# ---------------------------------------------------------------------------
# Query validation
# ---------------------------------------------------------------------------


def test_sync_rejects_negative_since(built_app, primary_key):
    app, _ = built_app
    client = TestClient(app)
    r = client.get("/api/v2/sync?since=-1", headers=_auth(primary_key))
    assert r.status_code == 422


def test_sync_rejects_limit_out_of_range(built_app, primary_key):
    app, _ = built_app
    client = TestClient(app)
    assert client.get(
        "/api/v2/sync?limit=0", headers=_auth(primary_key)
    ).status_code == 422
    assert client.get(
        "/api/v2/sync?limit=100000", headers=_auth(primary_key)
    ).status_code == 422


# ---------------------------------------------------------------------------
# 503 when store is not configured (defensive)
# ---------------------------------------------------------------------------


def test_sync_returns_503_when_store_missing(primary_key):
    app = create_app(config=_config())
    users: dict[str, uuid.UUID] = {}
    app.state.user_upsert = lambda _c, s, _: users.setdefault(s, uuid.uuid4())
    # Intentionally NOT setting app.state.sync_store.
    client = TestClient(app)
    r = client.get("/api/v2/sync", headers=_auth(primary_key))
    assert r.status_code == 503


# ---------------------------------------------------------------------------
# Abstract-store smoke — PostgresSyncStore is constructible without a live DB
# ---------------------------------------------------------------------------


def test_postgres_sync_store_is_syncstore_subclass():
    assert issubclass(PostgresSyncStore, SyncStore)
    assert issubclass(InMemorySyncStore, SyncStore)


def test_build_sync_router_mounts_sync_route():
    router = build_sync_router()
    paths = {getattr(r, "path", None) for r in router.routes}
    assert "/sync" in paths


def test_sync_page_to_public_roundtrip():
    page = SyncPage(
        routines=[{"routine_id": "r"}],
        executions=[{"execution_id": "e"}],
        credentials_presence={"k": True},
        next_version=42,
        has_more=True,
    )
    assert page.to_public() == {
        "routines": [{"routine_id": "r"}],
        "executions": [{"execution_id": "e"}],
        "credentials_presence": {"k": True},
        "next_version": 42,
        "has_more": True,
    }
