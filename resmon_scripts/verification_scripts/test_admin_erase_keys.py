"""The Danger Zone's key erasures count the keys they removed, not the names they asked about.

Each eraser used to answer with the length of its list of names, so on a
computer with no key stored "Erase all AI API keys" said it removed 8 and the
source-key erase said 6, and every composite erase repeated both. A count is a
claim about what was there; these tests pin it to what was actually stored and
is now gone, through the routes a person reaches.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import keyring
import pytest
from keyring.backends import null

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts import credential_manager as cm  # noqa: E402
from implementation_scripts.repo_catalog import credential_names  # noqa: E402

CONFIRM = {"confirm": "CONFIRM"}


def _client():
    import resmon as resmon_mod
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from fastapi.testclient import TestClient
    from resmon import app
    return TestClient(app)


def _every_name() -> list[str]:
    return sorted(cm.AI_CREDENTIAL_NAMES | cm.SMTP_CREDENTIAL_NAMES | credential_names()) + ["ai_api_key"]


@pytest.fixture(autouse=True)
def _empty_keyring():
    """Each test starts and ends with no resmon credential in conftest's in-memory keyring."""
    cm._reset_breaker()
    for name in _every_name():
        cm.delete_credential(name)
    yield
    cm._reset_breaker()
    for name in _every_name():
        cm.delete_credential(name)


def _store(client, *names: str) -> None:
    for name in names:
        r = client.put(f"/api/credentials/{name}", json={"value": "a-stored-key"})
        assert r.status_code == 200, r.text


def test_two_stored_ai_keys_count_two_and_a_second_erase_counts_none():
    client = _client()
    _store(client, "openai_api_key", "anthropic_api_key")

    first = client.post("/api/admin/erase-ai-keys")
    assert first.status_code == 200, first.text
    assert first.json() == {"success": True, "ai_keys_removed": 2}
    assert cm.probe_credential("openai_api_key") == cm.ABSENT

    again = client.post("/api/admin/erase-ai-keys")
    assert again.json() == {"success": True, "ai_keys_removed": 0}


def test_the_legacy_global_ai_key_counts_as_an_ai_key():
    client = _client()
    cm.store_credential("ai_api_key", "a-key-from-an-early-build")

    assert client.post("/api/admin/erase-ai-keys").json()["ai_keys_removed"] == 1
    assert cm.probe_credential("ai_api_key") == cm.ABSENT


def test_source_keys_count_what_was_stored():
    client = _client()
    _store(client, "core_api_key", "springer_api_key")

    assert client.post("/api/admin/erase-repo-keys").json() == {"success": True, "repo_keys_removed": 2}
    assert client.post("/api/admin/erase-repo-keys").json() == {"success": True, "repo_keys_removed": 0}


def test_every_composite_erase_counts_keys_found_and_counts_the_email_password_apart():
    client = _client()
    _store(client, "openai_api_key", "core_api_key")
    app_data = client.post("/api/admin/erase-app-data", json=CONFIRM).json()
    assert (app_data["ai_keys_removed"], app_data["repo_keys_removed"]) == (1, 1)
    assert "smtp_credentials_removed" not in app_data, "erasing app data keeps the email password"

    _store(client, "google_api_key", "smtp_password")
    reset = client.post("/api/admin/reset-settings", json=CONFIRM).json()
    assert (reset["ai_keys_removed"], reset["repo_keys_removed"], reset["smtp_credentials_removed"]) == (1, 0, 1)
    assert cm.probe_credential("smtp_password") == cm.ABSENT

    _store(client, "xai_api_key", "nasa_ads_api_key", "smtp_password")
    factory = client.post("/api/admin/factory-reset", json=CONFIRM).json()
    assert (factory["ai_keys_removed"], factory["repo_keys_removed"], factory["smtp_credentials_removed"]) == (1, 1, 1)


def test_a_factory_reset_after_an_erase_finds_no_keys():
    client = _client()
    _store(client, "openai_api_key", "core_api_key", "smtp_password")
    client.post("/api/admin/erase-app-data", json=CONFIRM)
    client.post("/api/admin/reset-settings", json=CONFIRM)

    factory = client.post("/api/admin/factory-reset", json=CONFIRM)
    assert factory.status_code == 200, factory.text
    body = factory.json()
    assert (body["ai_keys_removed"], body["repo_keys_removed"], body["smtp_credentials_removed"]) == (0, 0, 0)


def test_the_null_keyring_holds_nothing_so_every_count_is_zero():
    """The backend a disposable instance runs with deletes without complaint; it still removed nothing."""
    client = _client()
    previous = keyring.get_keyring()
    keyring.set_keyring(null.Keyring())
    try:
        assert client.post("/api/admin/erase-ai-keys").json()["ai_keys_removed"] == 0
        assert client.post("/api/admin/erase-repo-keys").json()["repo_keys_removed"] == 0
        body = client.post("/api/admin/factory-reset", json=CONFIRM).json()
        assert (body["ai_keys_removed"], body["repo_keys_removed"], body["smtp_credentials_removed"]) == (0, 0, 0)
    finally:
        keyring.set_keyring(previous)


# ---------------------------------------------------------------------------
# delete_credential's answer
# ---------------------------------------------------------------------------

def test_delete_answers_whether_it_removed_a_stored_credential():
    cm.store_credential("openai_api_key", "a-stored-key")
    assert cm.delete_credential("openai_api_key") is True
    assert cm.delete_credential("openai_api_key") is False


def test_a_timed_out_delete_raises_and_is_never_counted(monkeypatch):
    monkeypatch.setattr(cm, "_KEYRING_TIMEOUT_SEC", 0.05)
    cm.store_credential("openai_api_key", "a-stored-key")
    monkeypatch.setattr(cm.keyring, "delete_password", lambda s, n: time.sleep(30))

    with pytest.raises(cm.KeyringTimeout):
        cm.delete_credential("openai_api_key")
    with pytest.raises(cm.KeyringTimeout):
        _client().post("/api/admin/erase-ai-keys")


def test_an_unanswered_read_leaves_the_delete_to_decide(monkeypatch):
    """A keyring that will not say whether a key is there is not taken to mean it is not."""
    monkeypatch.setattr(cm, "_KEYRING_TIMEOUT_SEC", 0.05)
    store = {"openai_api_key": "a-stored-key"}

    def delete(service, name):
        if store.pop(name, None) is None:
            raise keyring.errors.PasswordDeleteError(name)

    monkeypatch.setattr(cm.keyring, "get_password", lambda s, n: time.sleep(30))
    monkeypatch.setattr(cm.keyring, "delete_password", delete)

    assert cm.delete_credential("openai_api_key") is True
    assert cm.delete_credential("openai_api_key") is False
