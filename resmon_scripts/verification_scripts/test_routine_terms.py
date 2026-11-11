"""A watch with nothing to search for is refused, not stored.

A routine's ``parameters`` reached the engine as any JSON object, so a watch
saved with no terms was stored, scheduled, and sent every source it named an
empty search on every run. arXiv, DOAJ, and PLOS answer that with HTTP 400, and
the watch's runs read as a row of failing sources when nothing about the
sources was wrong. The editors, the CLI and the MCP surface all reach the same
two routes, so the check is at the seam.

**The property:** a create, or an update that sets ``parameters``, is accepted
only when the routine has a term (in ``query`` or in ``keywords``) or follows a
person (``entity``); otherwise it is a 400 with a sentence, and nothing changes.
An update that does not touch ``parameters`` is not checked, so a terms-less
watch stored before this can still be paused, renamed or deleted.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import database  # noqa: E402


@pytest.fixture
def client():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    yield TestClient(resmon_mod.app)
    resmon_mod.close_db()


def _body(parameters: dict) -> dict:
    return {"name": "nightly", "schedule_cron": "0 8 * * *", "parameters": parameters, "is_active": False}


NO_TERMS = [
    {"repositories": ["arxiv"], "query": "", "keywords": []},
    {"repositories": ["arxiv"], "query": "   ", "keywords": ["", "  "]},
    {"repositories": ["arxiv"]},
    {"repositories": ["arxiv"], "keywords": None, "query": None},
]


@pytest.mark.parametrize("parameters", NO_TERMS)
def test_a_watch_with_no_terms_is_refused_with_a_reason(client, parameters):
    made = client.post("/api/routines", json=_body(parameters))
    assert made.status_code == 400, made.text
    assert "at least one search term" in made.json()["detail"]
    assert client.get("/api/routines").json() == []


@pytest.mark.parametrize("parameters", [
    {"repositories": ["arxiv"], "query": "perovskite", "keywords": ["perovskite"]},
    {"repositories": ["arxiv"], "keywords": ["perovskite"]},
    {"repositories": ["arxiv"], "query": "perovskite"},
])
def test_a_term_in_either_field_is_enough(client, parameters):
    assert client.post("/api/routines", json=_body(parameters)).status_code == 201


def test_a_watch_on_a_person_needs_no_terms(client):
    profile = client.post("/api/profiles", json={"kind": "person", "display_name": "Ada Watched"})
    assert profile.status_code == 201, profile.text
    for mode in ("new_papers", "retractions"):
        made = client.post("/api/routines", json=_body({
            "repositories": ["arxiv"], "query": "", "keywords": [],
            "entity": {"profile_id": profile.json()["id"], "mode": mode}}))
        assert made.status_code == 201, made.text


def test_an_update_that_clears_the_terms_is_refused_and_changes_nothing(client):
    stored = {"repositories": ["arxiv"], "query": "perovskite", "keywords": ["perovskite"]}
    rid = client.post("/api/routines", json=_body(stored)).json()["id"]

    refused = client.put(f"/api/routines/{rid}", json={"parameters": {"repositories": ["arxiv"], "query": "", "keywords": []}})
    assert refused.status_code == 400
    assert json.loads(client.get(f"/api/routines/{rid}").json()["parameters"]) == stored


def test_a_terms_less_watch_stored_before_the_check_can_still_be_paused_and_renamed(client):
    conn = resmon_mod._get_db()
    rid = database.insert_routine(conn, {
        "name": "old", "schedule_cron": "0 8 * * *",
        "parameters": json.dumps({"repositories": ["arxiv"], "query": "", "keywords": []}),
        "is_active": 1, "email_enabled": 0, "email_ai_summary_enabled": 0, "ai_enabled": 0,
        "ai_settings": None, "storage_settings": None, "notify_on_complete": 0,
        "execution_location": "local",
    })
    assert client.put(f"/api/routines/{rid}", json={"name": "renamed"}).status_code == 200
    assert client.post(f"/api/routines/{rid}/deactivate").status_code == 200
