"""Provider-specific "list available models" helpers.

Given a BYOK credential plus provider-specific configuration, return the
sorted list of model IDs the user has access to. Used by the Settings →
AI tab to populate the Model dropdown so the user does not have to type
model names by hand.

Network calls are performed via ``httpx`` so tests can monkeypatch
``httpx.Client`` / ``httpx.get``. No credential is logged.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .llm_remote import _PROVIDER_SPECS

logger = logging.getLogger(__name__)

# Timeout used for every list-models HTTP call. Kept short so a slow or
# unreachable provider cannot stall the Settings UI.
_HTTP_TIMEOUT = 15.0


class ModelListError(Exception):
    """Raised when a provider's list-models call fails."""


# ---------------------------------------------------------------------------
# Response normalization helpers
# ---------------------------------------------------------------------------

def _extract_openai_style(payload: Any) -> list[str]:
    """Extract model IDs from an OpenAI/Together-shaped response.

    Handles three response shapes observed across compatible providers:
      1. ``{"data": [{"id": "..."}, ...]}`` (OpenAI, xAI, DeepSeek,
         Alibaba compat-mode).
      2. ``[{"id": "..."}, ...]`` (Together.ai / Meta branch).
      3. ``["id1", "id2", ...]`` (rare OpenAI-compatible servers).
    """
    if isinstance(payload, dict):
        items = payload.get("data", []) or payload.get("models", [])
    elif isinstance(payload, list):
        items = payload
    else:
        return []

    ids: list[str] = []
    for item in items:
        if isinstance(item, str):
            if item:
                ids.append(item)
        elif isinstance(item, dict):
            model_id = item.get("id") or item.get("name") or item.get("model")
            if isinstance(model_id, str) and model_id:
                ids.append(model_id)
    return ids


# ---------------------------------------------------------------------------
# Per-provider implementations
# ---------------------------------------------------------------------------

def _list_openai_compatible(
    base_url: str,
    key: str,
    header_prefix: str = "Bearer",
) -> list[str]:
    headers = {
        "Authorization": f"{header_prefix} {key}",
        "Accept": "application/json",
    }
    url = f"{base_url.rstrip('/')}/models"
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        resp = client.get(url, headers=headers)
        resp.raise_for_status()
        return _extract_openai_style(resp.json())


def _list_anthropic(key: str) -> list[str]:
    """Anthropic uses ``x-api-key`` + ``anthropic-version`` headers."""
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Accept": "application/json",
    }
    url = "https://api.anthropic.com/v1/models"
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        resp = client.get(url, headers=headers)
        resp.raise_for_status()
        return _extract_openai_style(resp.json())


def _list_google(key: str) -> list[str]:
    """Google Generative Language API lists models under ``models[]``
    with ``name`` fields like ``"models/gemini-2.5-flash"``.
    """
    url = "https://generativelanguage.googleapis.com/v1beta/models"
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        resp = client.get(url, params={"key": key})
        resp.raise_for_status()
        payload = resp.json()
    ids: list[str] = []
    for item in payload.get("models", []) or []:
        name = item.get("name", "")
        if not isinstance(name, str) or not name:
            continue
        # Strip the "models/" prefix; the chat endpoint accepts either
        # form but the short form matches what users expect to see.
        if name.startswith("models/"):
            name = name[len("models/"):]
        # Filter to generative text models where we can tell.
        methods = item.get("supportedGenerationMethods") or []
        if methods and "generateContent" not in methods:
            continue
        ids.append(name)
    return ids


def _list_ollama(endpoint: str) -> list[str]:
    """Local ollama server: ``GET {endpoint}/api/tags``."""
    url = f"{endpoint.rstrip('/')}/api/tags"
    with httpx.Client(timeout=_HTTP_TIMEOUT) as client:
        resp = client.get(url)
        resp.raise_for_status()
        data = resp.json()
    return [m.get("name", "") for m in data.get("models", []) if m.get("name")]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def list_available_models(
    provider: str,
    key: str | None = None,
    base_url: str | None = None,
    header_prefix: str = "Bearer",
    endpoint: str | None = None,
) -> list[str]:
    """Return the sorted, de-duplicated list of model IDs for *provider*.

    Parameters
    ----------
    provider
        One of ``openai``, ``anthropic``, ``google``, ``xai``, ``meta``,
        ``deepseek``, ``alibaba``, ``custom``, ``local``.
    key
        API key. Required for every provider except ``local``.
    base_url
        Required for ``custom``. Ignored for other providers.
    header_prefix
        Auth header prefix for ``custom`` (default ``Bearer``).
    endpoint
        Required for ``local`` (e.g. ``http://localhost:11434``).

    Raises
    ------
    ModelListError
        If required arguments are missing or the upstream call fails.
    """
    provider = (provider or "").strip().lower()
    if not provider:
        raise ModelListError("Provider is required.")

    try:
        if provider == "local":
            if not endpoint:
                raise ModelListError("Local endpoint is required.")
            ids = _list_ollama(endpoint)
        elif provider == "anthropic":
            if not key:
                raise ModelListError("API key is required.")
            ids = _list_anthropic(key)
        elif provider == "google":
            if not key:
                raise ModelListError("API key is required.")
            ids = _list_google(key)
        elif provider == "custom":
            if not key:
                raise ModelListError("API key is required.")
            if not base_url:
                raise ModelListError("Custom base URL is required.")
            ids = _list_openai_compatible(base_url, key, header_prefix or "Bearer")
        elif provider in _PROVIDER_SPECS:
            if not key:
                raise ModelListError("API key is required.")
            spec = _PROVIDER_SPECS[provider]
            ids = _list_openai_compatible(spec.base_url, key, "Bearer")
        else:
            raise ModelListError(f"Unsupported provider: {provider}")
    except ModelListError:
        raise
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        logger.warning("list_models(%s) HTTP %s", provider, status)
        raise ModelListError(f"Provider returned HTTP {status}.") from exc
    except httpx.HTTPError as exc:
        logger.warning("list_models(%s) network error: %s", provider, exc)
        raise ModelListError("Network error contacting provider.") from exc
    except Exception as exc:  # pragma: no cover - unexpected upstream shape
        logger.warning("list_models(%s) unexpected error: %s", provider, exc)
        raise ModelListError("Unexpected error parsing provider response.") from exc

    # De-duplicate while preserving sort order.
    return sorted({m for m in ids if isinstance(m, str) and m})
