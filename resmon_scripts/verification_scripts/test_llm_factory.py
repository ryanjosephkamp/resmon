# resmon_scripts/verification_scripts/test_llm_factory.py
"""Prompt-assembly tests for LLM clients (IMPL-AI4).

Verifies that ``prompt_params`` propagates to the outgoing prompt and that
an empty/absent ``prompt_params`` falls back to ``length="standard"``
rather than the former ``"short"`` default.
"""

from unittest.mock import MagicMock, patch

from resmon_scripts.implementation_scripts.llm_local import LocalLLMClient


def _captured_prompt(prompt_params):
    """Invoke LocalLLMClient.summarize and return the outgoing prompt string."""
    client = LocalLLMClient(model="llama3.1:8b")

    mock_response = MagicMock()
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {"response": "ok"}

    mock_http = MagicMock()
    mock_http.__enter__.return_value.post.return_value = mock_response

    with patch(
        "resmon_scripts.implementation_scripts.llm_local.httpx.Client",
        return_value=mock_http,
    ):
        client.summarize("sample abstract text", prompt_params)

    post_call = mock_http.__enter__.return_value.post.call_args
    payload = post_call.kwargs.get("json") or post_call.args[1]
    return payload["prompt"]


def test_detailed_length_reaches_prompt():
    prompt = _captured_prompt({"length": "detailed"})
    assert "Target length: detailed" in prompt


def test_empty_prompt_params_keeps_defaults():
    prompt_none = _captured_prompt(None)
    prompt_empty = _captured_prompt({})
    prompt_blank = _captured_prompt({"length": ""})
    for prompt in (prompt_none, prompt_empty, prompt_blank):
        assert "Target length: standard" in prompt


# ---------------------------------------------------------------------------
# IMPL-AI5 — Provider expansion and retry behavior
# ---------------------------------------------------------------------------

import httpx  # noqa: E402

from resmon_scripts.implementation_scripts.llm_remote import RemoteLLMClient  # noqa: E402


def _make_post_mock(responses):
    """Return (mock_http_cm, post_mock) where post returns/raises from *responses* in order.

    Each entry may be a MagicMock (returned) or an Exception (raised).
    """
    post_mock = MagicMock()
    post_mock.side_effect = responses
    cm = MagicMock()
    cm.__enter__.return_value.post = post_mock
    return cm, post_mock


def _ok_response(payload):
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = payload
    return resp


_OPENAI_COMPAT_OK = {"choices": [{"message": {"content": "ok"}}]}
_GOOGLE_OK = {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}


def test_xai_hits_x_ai_base_url():
    cm, post = _make_post_mock([_ok_response(_OPENAI_COMPAT_OK)])
    with patch(
        "resmon_scripts.implementation_scripts.llm_remote.httpx.Client",
        return_value=cm,
    ):
        client = RemoteLLMClient(provider="xai", api_key="xai-test", model="grok-2-latest")
        client.summarize("sample text", {"length": "standard"})
    url = post.call_args.args[0]
    assert url == "https://api.x.ai/v1/chat/completions"


def test_google_hits_generativelanguage_endpoint():
    cm, post = _make_post_mock([_ok_response(_GOOGLE_OK)])
    with patch(
        "resmon_scripts.implementation_scripts.llm_remote.httpx.Client",
        return_value=cm,
    ):
        client = RemoteLLMClient(provider="google", api_key="g-test", model="gemini-1.5-flash")
        client.summarize("sample text", {"length": "standard"})
    url = post.call_args.args[0]
    assert url.startswith(
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "gemini-1.5-flash:generateContent"
    )
    assert "key=g-test" in url


def test_max_tokens_band_matches_length():
    expected = {"brief": 256, "standard": 512, "detailed": 1024}
    for length, tokens in expected.items():
        cm, post = _make_post_mock([_ok_response(_OPENAI_COMPAT_OK)])
        with patch(
            "resmon_scripts.implementation_scripts.llm_remote.httpx.Client",
            return_value=cm,
        ):
            client = RemoteLLMClient(provider="xai", api_key="xai-test", model="grok-2-latest")
            client.summarize("sample text", {"length": length})
        payload = post.call_args.kwargs["json"]
        assert payload["max_tokens"] == tokens, f"length={length} expected={tokens} got={payload['max_tokens']}"


def test_retry_halves_chunk_size_on_context_error():
    # Build a synthetic 400 with a context-length error body.
    err_response = MagicMock(spec=httpx.Response)
    err_response.status_code = 400
    err_response.text = '{"error": {"message": "context_length_exceeded: too long"}}'
    err_response.request = MagicMock()
    http_error = httpx.HTTPStatusError(
        "400 Bad Request",
        request=err_response.request,
        response=err_response,
    )

    cm, post = _make_post_mock([http_error, _ok_response(_OPENAI_COMPAT_OK)])
    with patch(
        "resmon_scripts.implementation_scripts.llm_remote.httpx.Client",
        return_value=cm,
    ):
        client = RemoteLLMClient(provider="xai", api_key="xai-test", model="grok-2-latest")
        original = "X" * 400
        result = client.summarize(original, {"length": "standard"})

    assert result == "ok"
    assert post.call_count == 2
    first_messages = post.call_args_list[0].kwargs["json"]["messages"]
    second_messages = post.call_args_list[1].kwargs["json"]["messages"]
    first_user = next(m["content"] for m in first_messages if m["role"] == "user")
    second_user = next(m["content"] for m in second_messages if m["role"] == "user")
    # Count occurrences of the sentinel "X" character in the rendered prompt's
    # Abstract body; the retry must halve the original input.
    assert first_user.count("X") == 400
    assert second_user.count("X") == 200


# ---------------------------------------------------------------------------
# IMPL-AI7 — llm_factory.build_llm_client_from_settings
# ---------------------------------------------------------------------------

import pytest  # noqa: E402

from resmon_scripts.implementation_scripts import llm_factory  # noqa: E402
from resmon_scripts.implementation_scripts.llm_factory import (  # noqa: E402
    build_llm_client_from_settings,
)
from resmon_scripts.implementation_scripts.llm_local import LocalLLMClient as _LocalLLMClient  # noqa: E402


def test_returns_none_when_provider_empty(monkeypatch):
    monkeypatch.setattr(llm_factory, "get_credential", lambda _n: None)
    assert build_llm_client_from_settings({}) is None
    assert build_llm_client_from_settings({"ai_provider": ""}) is None
    assert build_llm_client_from_settings({"ai_provider": "   "}) is None


def test_returns_none_when_key_missing(monkeypatch):
    monkeypatch.setattr(llm_factory, "get_credential", lambda _n: None)
    settings = {"ai_provider": "openai", "ai_model": "gpt-4o-mini"}
    assert build_llm_client_from_settings(settings) is None


def test_constructs_openai_compat_for_xai(monkeypatch):
    monkeypatch.setattr(llm_factory, "get_credential", lambda name: "xai-key" if name == "xai_api_key" else None)
    settings = {"ai_provider": "xai", "ai_model": "grok-2-latest"}
    client = build_llm_client_from_settings(settings)
    assert isinstance(client, RemoteLLMClient)
    assert client.provider == "xai"
    assert client.model == "grok-2-latest"


def test_constructs_google_branch(monkeypatch):
    monkeypatch.setattr(llm_factory, "get_credential", lambda name: "goog-key" if name == "google_api_key" else None)
    settings = {"ai_provider": "google", "ai_model": "gemini-1.5-flash"}
    client = build_llm_client_from_settings(settings)
    assert isinstance(client, RemoteLLMClient)
    assert client.provider == "google"
    assert client.model == "gemini-1.5-flash"


def test_constructs_local_from_ai_local_model(monkeypatch):
    monkeypatch.setattr(llm_factory, "get_credential", lambda _n: None)
    settings = {"ai_provider": "local", "ai_local_model": "llama3.1:8b"}
    client = build_llm_client_from_settings(settings)
    assert isinstance(client, _LocalLLMClient)
    assert client.model == "llama3.1:8b"


def test_ephemeral_key_preferred_over_keyring(monkeypatch):
    monkeypatch.setattr(llm_factory, "get_credential", lambda _n: "stored-key")
    settings = {"ai_provider": "deepseek", "ai_model": "deepseek-chat"}
    client = build_llm_client_from_settings(
        settings, ephemeral={"deepseek_api_key": "ephemeral-key"}
    )
    assert isinstance(client, RemoteLLMClient)
    # Accessing the private attribute only to prove the ephemeral value won;
    # it is never surfaced by any public API.
    assert client._api_key == "ephemeral-key"


def test_custom_refuses_http_non_localhost(monkeypatch):
    monkeypatch.setattr(llm_factory, "get_credential", lambda _n: "k")
    settings = {
        "ai_provider": "custom",
        "ai_model": "custom-model",
        "ai_custom_base_url": "http://evil.example.com/v1",
    }
    with pytest.raises(ValueError) as exc_info:
        build_llm_client_from_settings(settings)
    # Error message must not contain the credential value.
    assert "k" not in str(exc_info.value) or "key" in str(exc_info.value).lower()
    assert "HTTPS" in str(exc_info.value) or "https" in str(exc_info.value)


def test_custom_allows_http_localhost(monkeypatch):
    monkeypatch.setattr(
        llm_factory, "get_credential",
        lambda name: "custom-key" if name == "custom_llm_api_key" else None,
    )
    settings = {
        "ai_provider": "custom",
        "ai_model": "custom-model",
        "ai_custom_base_url": "http://localhost:8080/v1",
    }
    client = build_llm_client_from_settings(settings)
    assert isinstance(client, RemoteLLMClient)
    assert client.provider == "custom"


def test_custom_allows_https_remote(monkeypatch):
    monkeypatch.setattr(
        llm_factory, "get_credential",
        lambda name: "custom-key" if name == "custom_llm_api_key" else None,
    )
    settings = {
        "ai_provider": "custom",
        "ai_model": "custom-model",
        "ai_custom_base_url": "https://example.com/v1",
    }
    client = build_llm_client_from_settings(settings)
    assert isinstance(client, RemoteLLMClient)

