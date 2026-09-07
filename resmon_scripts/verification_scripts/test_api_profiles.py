"""The profiles API — P8's real-API half, and the route order that nearly bit.

Real FastAPI over a real (temp-file-backed in-memory) database. The renderer's
half of P8 is jsdom and the real-browser spec; this is the half that says the
*API* carries the warning, which is what a harness and the assistant get.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient      # noqa: E402

import resmon as resmon_mod                     # noqa: E402
from implementation_scripts import watch_profiles as wp   # noqa: E402


@pytest.fixture
def client() -> TestClient:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    return TestClient(resmon_mod.app)


def _create(client: TestClient, **body) -> dict:
    body.setdefault("kind", "person")
    response = client.post("/api/profiles", json=body)
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# P8 — the warning is in the response
# ---------------------------------------------------------------------------

def test_creating_a_profile_with_no_identifier_returns_the_warning(client):
    profile = _create(client, display_name="John Smith")
    assert profile["basis_warning"]
    assert "name-only" in profile["basis_warning"]


def test_the_warning_is_on_every_read_of_the_profile_not_only_at_creation(client):
    """A warning that appeared once is a warning a user scrolled past once."""
    created = _create(client, display_name="John Smith")
    assert client.get(f"/api/profiles/{created['id']}").json()["basis_warning"]
    listed = client.get("/api/profiles").json()["profiles"]
    assert all(p["basis_warning"] for p in listed)


def test_an_identifier_retires_the_warning_over_the_api(client):
    profile = _create(
        client, display_name="Jane Doe",
        identifiers={"orcid": {"value": "0000-0002-1825-0097", "cited": "her site"}})
    assert profile["basis_warning"] is None


def test_a_bad_orcid_is_a_400_with_an_example_rather_than_a_500(client):
    response = client.post("/api/profiles",
                           json={"display_name": "X",
                                 "identifiers": {"orcid": {"value": "nonsense"}}})
    assert response.status_code == 400
    assert "0000-0002-1825-0097" in response.json()["detail"]


# ---------------------------------------------------------------------------
# The route order, which is a real trap and not a hypothetical
# ---------------------------------------------------------------------------

def test_the_starter_route_is_not_swallowed_by_the_id_route(client):
    """`/api/profiles/starter` must be declared before `/api/profiles/{id}`.

    FastAPI matches in declaration order, so the id route would otherwise take
    "starter" as a profile id, fail to coerce it to an int, and answer 422 — a
    feature broken by the order of two functions in a file, with nothing else to
    show for it.
    """
    response = client.get("/api/profiles/starter")
    assert response.status_code == 200, response.text
    profiles = response.json()["profiles"]
    assert profiles, "the shipped starter directory is not empty"
    assert all(p.get("source_file", "").endswith(".json") for p in profiles)


def test_the_starter_set_is_not_yet_anybody_s_profile(client):
    """Showing them is not storing them."""
    assert client.get("/api/profiles/starter").json()["profiles"]
    assert client.get("/api/profiles").json()["profiles"] == []


# ---------------------------------------------------------------------------
# P7 — export / import over the API
# ---------------------------------------------------------------------------

def test_export_then_import_round_trips_over_the_api(client):
    created = _create(
        client, display_name="Jane Doe", names=["Jane Doe", "J. Doe"],
        identifiers={"orcid": {"value": "0000-0002-1825-0097", "cited": "her site"}},
        affiliations=["Somewhere"], field_hints=["astronomy"], notes="A note.")

    exported = client.get(f"/api/profiles/{created['id']}/export").json()
    assert exported["schema"] == wp.JSON_SCHEMA_VERSION
    assert "id" not in exported

    result = client.post("/api/profiles/import", json={"profiles": [exported]}).json()
    assert result["failed"] == []
    imported = result["imported"][0]
    for field in ("kind", "display_name", "names", "identifiers", "affiliations",
                  "field_hints", "notes"):
        assert imported[field] == created[field], field


def test_one_bad_profile_in_a_file_does_not_lose_the_good_ones(client):
    """A batch that fails whole is a user editing JSON to find the bad line."""
    good = {"schema": 1, "kind": "person", "display_name": "Fine"}
    bad = {"schema": 1, "kind": "person", "names": []}
    result = client.post("/api/profiles/import",
                         json={"profiles": [good, bad]}).json()
    assert [p["display_name"] for p in result["imported"]] == ["Fine"]
    assert result["failed"] == [{"index": 1, "reason": "A profile needs at least one name."}]


def test_every_starter_profile_imports_over_the_api(client):
    starters = client.get("/api/profiles/starter").json()["profiles"]
    result = client.post("/api/profiles/import", json={"profiles": [
        {**wp.profile_to_json(p)} for p in starters]}).json()
    assert result["failed"] == []
    assert len(result["imported"]) == len(starters)


# ---------------------------------------------------------------------------
# Matches
# ---------------------------------------------------------------------------

def test_matches_carry_their_basis_and_a_count_per_basis(client):
    profile = _create(client, display_name="Jane Doe")
    conn = resmon_mod._get_db()
    try:
        for index, basis in enumerate(("identifier", "name+affiliation", "name_only")):
            conn.execute(
                "INSERT INTO documents (source_repository, external_id, title, "
                "metadata_hash) VALUES ('arxiv', ?, ?, ?)",
                (f"D{index}", f"Paper {index}", f"h{index}"))
            doc_id = conn.execute(
                "SELECT id FROM documents WHERE external_id = ?", (f"D{index}",)
            ).fetchone()["id"]
            conn.execute(
                "INSERT INTO watch_profile_matches (document_id, profile_id, basis, "
                "matched_author, evidence) VALUES (?, ?, ?, ?, ?)",
                (doc_id, profile["id"], basis, "Jane Doe", "why"))
        conn.commit()
    finally:
        resmon_mod._close_db(conn)

    body = client.get(f"/api/profiles/{profile['id']}/matches").json()
    assert body["total"] == 3
    assert body["by_basis"] == {"identifier": 1, "name+affiliation": 1, "name_only": 1}
    assert all(m["basis"] for m in body["matches"]), (
        "a match row without its basis is the claim resmon refuses to make")
    assert all("title" in m for m in body["matches"])


def test_matches_for_a_profile_that_does_not_exist_is_a_404(client):
    assert client.get("/api/profiles/999/matches").status_code == 404


def test_deleting_a_profile_leaves_the_corpus_alone(client):
    profile = _create(client, display_name="Jane Doe")
    conn = resmon_mod._get_db()
    try:
        conn.execute(
            "INSERT INTO documents (source_repository, external_id, title, "
            "metadata_hash) VALUES ('arxiv', 'D1', 'A paper', 'h')")
        doc_id = conn.execute("SELECT id FROM documents").fetchone()["id"]
        conn.execute(
            "INSERT INTO watch_profile_matches (document_id, profile_id, basis, "
            "matched_author) VALUES (?, ?, 'name_only', 'Jane Doe')",
            (doc_id, profile["id"]))
        conn.commit()
    finally:
        resmon_mod._close_db(conn)

    assert client.delete(f"/api/profiles/{profile['id']}").status_code == 200
    conn = resmon_mod._get_db()
    try:
        assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) FROM watch_profile_matches").fetchone()[0] == 0
    finally:
        resmon_mod._close_db(conn)


def test_a_saved_configuration_is_still_not_a_profile(client):
    """Decision 10: `config_type` is not widened, and this is why it stays that way."""
    conn = resmon_mod._get_db()
    try:
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'saved_configurations'"
        ).fetchone()["sql"]
    finally:
        resmon_mod._close_db(conn)
    assert "profile" not in sql.lower()
