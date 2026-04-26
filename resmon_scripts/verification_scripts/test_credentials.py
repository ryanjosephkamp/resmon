# resmon_scripts/verification_scripts/test_credentials.py
"""Credential validation and whitelist tests (IMPL-AI6)."""

from unittest.mock import MagicMock, patch

import httpx

from resmon_scripts.implementation_scripts import credential_manager as cm


def _mock_http_client(response=None, exception=None):
    """Return a MagicMock compatible with ``with httpx.Client(...) as c:`` usage."""
    cm_ctx = MagicMock()
    request = MagicMock()
    if exception is not None:
        request.side_effect = exception
    else:
        request.return_value = response
    cm_ctx.__enter__.return_value.request = request
    return cm_ctx


def test_whitelist_contains_all_ai_providers():
    """AI_CREDENTIAL_NAMES covers every BYOK provider added in IMPL-AI5 (ADQ-AI9)."""
    expected = {
        "openai_api_key",
        "anthropic_api_key",
        "google_api_key",
        "xai_api_key",
        "meta_api_key",
        "deepseek_api_key",
        "alibaba_api_key",
        "custom_llm_api_key",
    }
    assert expected <= cm.AI_CREDENTIAL_NAMES


def test_validate_returns_false_for_bad_openai_key():
    resp = MagicMock()
    resp.status_code = 401
    with patch(
        "resmon_scripts.implementation_scripts.credential_manager.httpx.Client",
        return_value=_mock_http_client(response=resp),
    ):
        assert cm.validate_api_key("openai", "sk-invalid") is False


def test_validate_returns_false_on_network_error():
    err = httpx.TransportError("connection refused")
    with patch(
        "resmon_scripts.implementation_scripts.credential_manager.httpx.Client",
        return_value=_mock_http_client(exception=err),
    ):
        assert cm.validate_api_key("xai", "xai-whatever") is False


def test_validate_returns_false_on_timeout():
    err = httpx.TimeoutException("read timed out")
    with patch(
        "resmon_scripts.implementation_scripts.credential_manager.httpx.Client",
        return_value=_mock_http_client(exception=err),
    ):
        assert cm.validate_api_key("deepseek", "ds-whatever") is False


def test_validate_returns_false_for_unknown_provider():
    assert cm.validate_api_key("no_such_provider", "x") is False


def test_new_credential_names_accepted(monkeypatch):
    """Store/get/delete round-trip for a new AI provider credential name."""
    store: dict[tuple[str, str], str] = {}

    def fake_set(service, name, value):
        store[(service, name)] = value

    def fake_get(service, name):
        return store.get((service, name))

    def fake_delete(service, name):
        store.pop((service, name), None)

    monkeypatch.setattr(cm.keyring, "set_password", fake_set)
    monkeypatch.setattr(cm.keyring, "get_password", fake_get)
    monkeypatch.setattr(cm.keyring, "delete_password", fake_delete)

    cm.store_credential("xai_api_key", "xai-test-value")
    assert cm.get_credential("xai_api_key") == "xai-test-value"
    cm.delete_credential("xai_api_key")
    assert cm.get_credential("xai_api_key") is None


def test_google_validation_uses_query_param_key():
    """Google's probe must pass the key as a ``?key=`` query param, not a header."""
    captured: dict[str, object] = {}

    def fake_request(method, url, headers=None, params=None):
        captured["method"] = method
        captured["url"] = url
        captured["headers"] = headers
        captured["params"] = params
        resp = MagicMock()
        resp.status_code = 401  # doesn't matter for this assertion
        return resp

    cm_ctx = MagicMock()
    cm_ctx.__enter__.return_value.request.side_effect = fake_request
    with patch(
        "resmon_scripts.implementation_scripts.credential_manager.httpx.Client",
        return_value=cm_ctx,
    ):
        cm.validate_api_key("google", "goog-test")

    assert captured["url"] == "https://generativelanguage.googleapis.com/v1beta/models"
    assert captured["params"] == {"key": "goog-test"}
    assert "Authorization" not in (captured["headers"] or {})


# ---------------------------------------------------------------------------
# Update 2 — Feature 1: legacy global-AI-key migration
# ---------------------------------------------------------------------------

def _install_fake_keyring(monkeypatch, initial=None):
    """Install a fake keyring backend backed by an in-memory dict.

    Returns the dict so tests can inspect / pre-seed slots.
    """
    store: dict[tuple[str, str], str] = dict(initial or {})

    def fake_set(service, name, value):
        store[(service, name)] = value

    def fake_get(service, name):
        return store.get((service, name))

    def fake_delete(service, name):
        if (service, name) not in store:
            raise cm.keyring.errors.PasswordDeleteError("not found")
        store.pop((service, name), None)

    monkeypatch.setattr(cm.keyring, "set_password", fake_set)
    monkeypatch.setattr(cm.keyring, "get_password", fake_get)
    monkeypatch.setattr(cm.keyring, "delete_password", fake_delete)
    return store


def test_migrate_legacy_key_noop_when_absent(monkeypatch):
    store = _install_fake_keyring(monkeypatch)
    assert cm.migrate_legacy_global_ai_key("openai") is False
    assert store == {}


def test_migrate_legacy_key_moves_to_provider_slot(monkeypatch):
    svc = cm._SERVICE
    store = _install_fake_keyring(monkeypatch, {(svc, "ai_api_key"): "sk-legacy"})
    assert cm.migrate_legacy_global_ai_key("openai") is True
    # Legacy slot cleared, target slot populated.
    assert (svc, "ai_api_key") not in store
    assert store[(svc, "openai_api_key")] == "sk-legacy"


def test_migrate_legacy_key_uses_custom_slot_for_custom_provider(monkeypatch):
    svc = cm._SERVICE
    store = _install_fake_keyring(monkeypatch, {(svc, "ai_api_key"): "sk-legacy"})
    assert cm.migrate_legacy_global_ai_key("custom") is True
    assert store[(svc, "custom_llm_api_key")] == "sk-legacy"
    assert (svc, "ai_api_key") not in store


def test_migrate_legacy_key_no_provider_leaves_slot(monkeypatch):
    svc = cm._SERVICE
    store = _install_fake_keyring(monkeypatch, {(svc, "ai_api_key"): "sk-legacy"})
    # Provider not yet chosen — migration must not silently lose the key.
    assert cm.migrate_legacy_global_ai_key("") is False
    assert cm.migrate_legacy_global_ai_key(None) is False
    assert cm.migrate_legacy_global_ai_key("local") is False
    assert store[(svc, "ai_api_key")] == "sk-legacy"


def test_migrate_legacy_key_idempotent(monkeypatch):
    svc = cm._SERVICE
    store = _install_fake_keyring(monkeypatch, {(svc, "ai_api_key"): "sk-legacy"})
    assert cm.migrate_legacy_global_ai_key("anthropic") is True
    # Second call is a no-op once the legacy slot is gone.
    assert cm.migrate_legacy_global_ai_key("anthropic") is False
    assert store[(svc, "anthropic_api_key")] == "sk-legacy"


def test_migrate_legacy_key_preserves_existing_target(monkeypatch):
    """If target slot already has a value, the legacy slot is cleared but
    the existing per-provider key is preserved (no clobber)."""
    svc = cm._SERVICE
    store = _install_fake_keyring(monkeypatch, {
        (svc, "ai_api_key"): "sk-legacy",
        (svc, "openai_api_key"): "sk-existing",
    })
    assert cm.migrate_legacy_global_ai_key("openai") is False
    assert store[(svc, "openai_api_key")] == "sk-existing"
    # Legacy slot cleared so we don't keep migrating on every startup.
    assert (svc, "ai_api_key") not in store
