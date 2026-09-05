"""The embedding settings, driven through the real endpoints.

This file exists because of **Ledger 33**, and it is shaped by how that one
escaped. Three subscription-lane settings were reachable through
``PUT /api/settings/ai`` in the renderer's mind only: absent from
``_AI_SETTING_KEYS`` and from ``_SETTINGS_GROUPS["ai"]``, the PUT dropped them
before they were stored and no run ever read them. **A setting is only real when
it appears in both places.** It survived a release because
``test_api_ai_cli_status.py`` monkeypatched ``_get_settings_group``, so the test
could not see the gap it was standing in.

So nothing here patches a settings reader. Everything goes through
``TestClient`` — the real routing, the real Pydantic model, the real
``app_settings`` table — and the structural guard below asserts the two lists
against each other by construction rather than by enumeration, so a key added to
one and not the other fails without anyone remembering to add a case.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient  # noqa: E402

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import embeddings  # noqa: E402

from embedding_server import DEFAULT_DIMS, EmbeddingServer  # noqa: E402


@pytest.fixture
def client():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app

    return TestClient(app)


@pytest.fixture
def server():
    with EmbeddingServer() as running:
        yield running


# ---------------------------------------------------------------------------
# The Ledger 33 guard — structural, not enumerated
# ---------------------------------------------------------------------------


def test_the_storable_keys_and_the_readable_keys_are_the_same_list():
    """One tuple, two uses. The gap that cost 1.8.5 a release cannot open here.

    ``_SETTINGS_GROUPS["embeddings"]`` is built *from*
    ``EMBEDDING_SETTING_KEYS`` and ``_load_embedding_settings`` iterates the same
    tuple, so this asserts the construction rather than a copy of it. A key added
    to the tuple is storable and readable in the same commit or in neither.
    """
    assert set(resmon_mod._SETTINGS_GROUPS["embeddings"]) == set(
        embeddings.EMBEDDING_SETTING_KEYS
    )
    # And the read path really iterates it, rather than a list that happens to
    # match today.
    import inspect

    source = inspect.getsource(resmon_mod._load_embedding_settings)
    assert "EMBEDDING_SETTING_KEYS" in source


def test_every_key_survives_a_put_and_comes_back_from_the_get(client):
    """The whole tuple, not a sample. The two 1.8.5 keys that vanished were the
    ones nobody wrote a case for."""
    payload = {
        "embedding_enabled": "true",
        "embedding_provider": "local",
        "embedding_model": "nomic-embed-text",
        "embedding_endpoint": "http://127.0.0.1:11434",
        "embedding_base_url": "",
        "embedding_batch_size": "16",
        "embedding_dims": "768",
        "embedding_input_limit": "2048",
    }
    assert set(payload) == set(embeddings.EMBEDDING_SETTING_KEYS), (
        "this test must cover the whole tuple; a new key needs a value here"
    )

    assert client.put("/api/settings/embeddings", json={"settings": payload}).status_code == 200
    stored = client.get("/api/settings/embeddings").json()["settings"]
    for key, value in payload.items():
        assert stored[key] == value, f"{key} did not survive the round trip"


def test_the_stored_settings_actually_build_the_lane_a_run_would_use(client):
    """Storage is half of it; Ledger 33's other half was the loader never reading."""
    client.put("/api/settings/embeddings", json={"settings": {
        "embedding_enabled": "true",
        "embedding_provider": "local",
        "embedding_model": "nomic-embed-text",
        "embedding_endpoint": "http://example.invalid:11434",
        "embedding_batch_size": "16",
    }})
    lane = client.get("/api/settings/embeddings").json()["lane"]
    assert lane is not None
    assert lane["kind"] == "local"
    assert lane["model"] == "nomic-embed-text"
    assert lane["endpoint"] == "http://example.invalid:11434"
    assert lane["batch_size"] == 16


def test_no_lane_is_built_until_the_feature_is_switched_on(client):
    client.put("/api/settings/embeddings", json={"settings": {
        "embedding_provider": "local", "embedding_model": "nomic-embed-text",
    }})
    assert client.get("/api/settings/embeddings").json()["lane"] is None


# ---------------------------------------------------------------------------
# P8 at the endpoint — refused at configuration, not at backfill
# ---------------------------------------------------------------------------


def test_a_provider_that_cannot_embed_is_refused_by_the_put_with_the_sentence(client):
    response = client.put("/api/settings/embeddings", json={"settings": {
        "embedding_enabled": "true",
        "embedding_provider": "anthropic",
        "embedding_model": "anything",
    }})
    assert response.status_code == 400
    assert "does not offer an embeddings API" in response.json()["detail"]


@pytest.mark.parametrize(
    "provider",
    sorted(n for n, a in embeddings.PROVIDER_EMBEDDING.items() if a.state == "no"),
)
def test_each_provider_that_cannot_embed_is_refused_at_configuration(client, provider):
    """Denominator: every ``no`` in PROVIDER_EMBEDDING, from the table itself."""
    response = client.put("/api/settings/embeddings", json={"settings": {
        "embedding_enabled": "true", "embedding_provider": provider, "embedding_model": "m",
    }})
    assert response.status_code == 400
    assert response.json()["detail"] == embeddings.can_embed(provider).reason


def test_the_get_states_the_limitation_rather_than_hiding_the_option(client):
    """A user who wonders "why isn't Anthropic here" gets an answer, not a gap."""
    providers = {p["provider"]: p for p in client.get("/api/settings/embeddings").json()["providers"]}
    assert set(providers) == set(embeddings.PROVIDER_EMBEDDING)
    assert providers["anthropic"]["state"] == "no"
    assert providers["anthropic"]["offered"] is False
    assert "does not offer an embeddings API" in providers["anthropic"]["reason"]
    assert "404" in providers["anthropic"]["evidence"]
    assert providers["claude_code"]["state"] == "no"
    assert providers["codex"]["state"] == "no"
    assert providers["deepseek"]["state"] == "unknown"
    assert providers["deepseek"]["offered"] is True


def test_a_backfill_is_refused_before_it_starts_when_the_lane_cannot_embed(client, server):
    """P8's "never at backfill" from the other side: the refusal precedes the run."""
    server.mode = "cannot_embed"
    client.put("/api/settings/embeddings", json={"settings": {
        "embedding_enabled": "true", "embedding_provider": "local",
        "embedding_model": "gemma4:e2b", "embedding_endpoint": server.base_url,
    }})
    response = client.post("/api/embeddings/backfill")
    assert response.status_code == 400
    assert "cannot produce embeddings" in response.json()["detail"]
    # And nothing was started.
    assert client.get("/api/embeddings/status").json()["run"]["running"] is False


def test_a_backfill_with_no_lane_says_what_to_configure(client):
    response = client.post("/api/embeddings/backfill")
    assert response.status_code == 400
    assert "Settings" in response.json()["detail"]


# ---------------------------------------------------------------------------
# The probe endpoint
# ---------------------------------------------------------------------------


def test_the_probe_endpoint_answers_and_persists_the_discovered_width(client, server):
    client.put("/api/settings/embeddings", json={"settings": {
        "embedding_enabled": "true", "embedding_provider": "local",
        "embedding_model": "test-embed", "embedding_endpoint": server.base_url,
    }})
    result = client.post("/api/embeddings/probe", json={}).json()
    assert result["ok"] is True
    assert result["dims"] == DEFAULT_DIMS
    # Persisted, so the tab can say how wide the vectors are before a backfill.
    assert client.get("/api/settings/embeddings").json()["settings"]["embedding_dims"] == str(
        DEFAULT_DIMS
    )


def test_the_probe_can_test_an_unsaved_lane(client, server):
    """A user should be able to try a setting before committing to it."""
    result = client.post("/api/embeddings/probe", json={"settings": {
        "embedding_enabled": "true", "embedding_provider": "local",
        "embedding_model": "unsaved", "embedding_endpoint": server.base_url,
    }}).json()
    assert result["ok"] is True and result["model"] == "unsaved"
    # And nothing was stored by probing.
    assert client.get("/api/settings/embeddings").json()["lane"] is None


def test_probing_a_provider_that_cannot_embed_says_so_without_calling_anything(client):
    result = client.post("/api/embeddings/probe", json={"settings": {
        "embedding_enabled": "true", "embedding_provider": "anthropic", "embedding_model": "m",
    }}).json()
    assert result["ok"] is False
    assert "does not offer an embeddings API" in result["reason"]


# ---------------------------------------------------------------------------
# Status, estimate, capability
# ---------------------------------------------------------------------------


def test_status_reports_n_of_m_with_the_model_named(client, server):
    conn = resmon_mod._get_db()
    for i in range(4):
        conn.execute(
            "INSERT INTO documents (source_repository, external_id, title, abstract, "
            "metadata_hash) VALUES ('arxiv', ?, ?, ?, ?)",
            (f"e{i}", f"Title {i}", f"Abstract {i}", f"h{i}"),
        )
    conn.commit()

    client.put("/api/settings/embeddings", json={"settings": {
        "embedding_enabled": "true", "embedding_provider": "local",
        "embedding_model": "test-embed", "embedding_endpoint": server.base_url,
    }})
    status = client.get("/api/embeddings/status").json()
    assert status["coverage"] == {"embedded": 0, "total": 4, "model": "test-embed"}

    assert client.post("/api/embeddings/backfill").status_code == 200
    from implementation_scripts.embedding_job import backfill_job

    assert backfill_job.join(60)
    status = client.get("/api/embeddings/status").json()
    assert status["coverage"] == {"embedded": 4, "total": 4, "model": "test-embed"}
    assert status["run"]["running"] is False
    assert status["index"]["rows"] == 4


def test_the_estimate_is_computed_from_the_documents_that_will_actually_be_sent(
    client, server
):
    conn = resmon_mod._get_db()
    for i in range(3):
        conn.execute(
            "INSERT INTO documents (source_repository, external_id, title, abstract, "
            "metadata_hash) VALUES ('arxiv', ?, ?, ?, ?)",
            (f"e{i}", "T" * 100, "A" * 300, f"h{i}"),
        )
    conn.commit()
    client.put("/api/settings/embeddings", json={"settings": {
        "embedding_enabled": "true", "embedding_provider": "local",
        "embedding_model": "test-embed", "embedding_endpoint": server.base_url,
    }})
    estimate = client.get("/api/embeddings/estimate").json()
    assert estimate["documents"] == 3
    assert estimate["estimated_tokens"] > 0
    assert estimate["cost_usd"] == 0.0


def test_the_capability_is_unavailable_until_something_is_actually_embedded(client, server):
    """An extension that loaded over an empty index is not a ranking capability.

    The renderer gates the sort control on this single boolean, so it has to mean
    "ranking will work", not "the library is present".
    """
    capability = client.get("/api/settings/embeddings").json()["capability"]
    assert capability["available"] is False
    assert capability["reason"]
