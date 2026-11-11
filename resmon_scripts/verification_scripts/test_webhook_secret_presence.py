"""Whether a webhook destination's signing secret is stored, as ``GET /api/credentials`` says.

A webhook's secret lives in the keyring as ``webhook_secret_<target id>``.
``PUT /api/credentials/{key_name}`` accepted those names, and the delivery
adapter read them, but the presence route listed only the fixed names a build
knows, so it never mentioned one. The destinations list asks that route, and
said "no secret yet" after a secret had been saved. Its renderer test passed
against a mocked answer the engine never gave.

**The property:** for every webhook destination stored, the route reports its
secret's presence by name, and never its value; a destination of another
channel adds no name, and a removed one is no longer asked about.
"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402


def _client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app
    return TestClient(app)


def _watch(client: TestClient) -> int:
    made = client.post("/api/routines", json={
        "name": "hooked", "schedule_cron": "0 8 * * *", "is_active": False,
        "parameters": {"keywords": ["perovskite"], "repositories": ["arxiv"]},
    })
    assert made.status_code == 201, made.text
    return made.json()["id"]


def _target(client: TestClient, rid: int, channel: str, target: str) -> int:
    added = client.post(f"/api/routines/{rid}/delivery-targets", json={"channel": channel, "target": target})
    assert added.status_code == 200, added.text
    return added.json()["id"]


def test_a_saved_webhook_secret_is_reported_and_an_unsaved_one_is_not():
    client = _client()
    rid = _watch(client)
    saved = _target(client, rid, "webhook", "https://example.org/hook")
    unsaved = _target(client, rid, "webhook", "https://example.org/other")
    assert client.put(f"/api/credentials/webhook_secret_{saved}", json={"value": "s3cret-value"}).status_code == 200

    answer = client.get("/api/credentials")
    assert answer.status_code == 200
    credentials = answer.json()["credentials"]
    assert credentials[f"webhook_secret_{saved}"] == {"present": True, "status": "present"}
    assert credentials[f"webhook_secret_{unsaved}"] == {"present": False, "status": "absent"}
    assert "s3cret-value" not in answer.text


def test_only_webhook_destinations_are_asked_about_and_a_removed_one_is_not():
    client = _client()
    rid = _watch(client)
    folder = _target(client, rid, "folder", "/tmp/reports")
    hook = _target(client, rid, "webhook", "https://example.org/hook")
    names = set(client.get("/api/credentials").json()["credentials"])
    assert f"webhook_secret_{hook}" in names
    assert f"webhook_secret_{folder}" not in names

    assert client.delete(f"/api/routines/{rid}/delivery-targets/{hook}").status_code == 200
    names = set(client.get("/api/credentials").json()["credentials"])
    assert not any(name.startswith("webhook_secret_") for name in names)
