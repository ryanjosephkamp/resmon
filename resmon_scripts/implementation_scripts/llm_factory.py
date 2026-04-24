# resmon_scripts/implementation_scripts/llm_factory.py
"""Factory that turns persisted AI settings into a concrete LLM client.

Builds a ``RemoteLLMClient`` or ``LocalLLMClient`` from the ``ai_*`` keys in
``app_settings`` plus an optional per-execution ``ephemeral`` credential
scope. Returns ``None`` — never raises — when the provider is unset or its
credentials are missing; this allows callers to treat "AI unconfigured" as
a silent no-op branch (ADQ-AI7, F6).

The only ``ValueError`` this module raises is for ``ai_provider == "custom"``
when the supplied ``ai_custom_base_url`` is insecure (plain HTTP pointing at
a non-loopback host). This enforces transport-level confidentiality for
user-supplied API keys (ADQ-AI8; OWASP A02).

API keys are never logged, never included in exception messages, and never
returned by any public function in this module.
"""

from __future__ import annotations

import logging
from typing import Optional, Union
from urllib.parse import urlparse

from .credential_manager import AI_CREDENTIAL_NAMES, get_credential
from .llm_local import LocalLLMClient
from .llm_remote import RemoteLLMClient

logger = logging.getLogger(__name__)

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _validate_custom_base_url(base_url: str) -> str:
    """Return a normalized ``base_url`` or raise ``ValueError``.

    Rejects schemes other than ``https`` unless the host is a loopback
    address. The error message never includes any credential value.
    """
    if not base_url:
        raise ValueError(
            "Custom LLM provider requires ai_custom_base_url to be set."
        )
    parsed = urlparse(base_url)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(
            f"Custom LLM base URL is not a valid absolute URL: {base_url!r}"
        )
    if parsed.scheme == "https":
        return base_url
    if parsed.scheme == "http" and (parsed.hostname or "").lower() in _LOOPBACK_HOSTS:
        return base_url
    raise ValueError(
        "Custom LLM base URL must use HTTPS "
        "(HTTP is only allowed for localhost / 127.0.0.1)."
    )


def _lookup_key(provider: str, ephemeral: Optional[dict]) -> Optional[str]:
    """Return the API key for *provider*, preferring ephemeral over keyring.

    Lookup order per ADQ-AI9:

    1. ``ephemeral["{provider}_api_key"]``.
    2. ``ephemeral["custom_llm_api_key"]`` (only when ``provider == "custom"``).
    3. Persisted keyring credential ``"{provider}_api_key"``.
    4. Persisted keyring credential ``"custom_llm_api_key"`` (only when
       ``provider == "custom"``).
    """
    primary_name = f"{provider}_api_key"
    custom_name = "custom_llm_api_key"

    if ephemeral:
        value = ephemeral.get(primary_name)
        if value:
            return str(value)
        if provider == "custom":
            value = ephemeral.get(custom_name)
            if value:
                return str(value)

    # Only consult keyring for recognized AI credential slots.
    if primary_name in AI_CREDENTIAL_NAMES:
        value = get_credential(primary_name)
        if value:
            return value
    if provider == "custom":
        value = get_credential(custom_name)
        if value:
            return value
    return None


def build_llm_client_from_settings(
    settings: dict,
    ephemeral: Optional[dict] = None,
) -> Optional[Union[RemoteLLMClient, LocalLLMClient]]:
    """Construct an LLM client from persisted ``ai_*`` settings.

    Returns ``None`` when ``ai_provider`` is empty, when the provider needs a
    BYOK key and none is available, or when required fields are missing.
    Only raises ``ValueError`` for an insecure ``ai_custom_base_url``
    (see ``_validate_custom_base_url``).
    """
    provider = str(settings.get("ai_provider") or "").strip().lower()
    if not provider:
        return None

    # Local provider (ollama) — no remote key required.
    if provider == "local":
        model = (
            str(settings.get("ai_local_model") or "").strip()
            or str(settings.get("ai_model") or "").strip()
        )
        if not model:
            logger.info("AI local provider selected but no model configured; skipping.")
            return None
        endpoint = str(settings.get("ai_local_endpoint") or "").strip()
        if endpoint:
            return LocalLLMClient(model=model, endpoint=endpoint)
        return LocalLLMClient(model=model)

    # Validate custom-provider base URL *before* touching credentials so the
    # caller gets a deterministic ValueError even if no key has been stored.
    custom_base_url: Optional[str] = None
    if provider == "custom":
        custom_base_url = _validate_custom_base_url(
            str(settings.get("ai_custom_base_url") or "").strip()
        )

    key = _lookup_key(provider, ephemeral)
    if not key:
        logger.info(
            "AI provider '%s' selected but no API key is available; skipping.",
            provider,
        )
        return None

    model = str(settings.get("ai_model") or "").strip()
    if not model:
        logger.info(
            "AI provider '%s' selected but ai_model is empty; skipping.",
            provider,
        )
        return None

    try:
        return RemoteLLMClient(
            provider=provider,
            api_key=key,
            model=model,
            custom_base_url=custom_base_url,
        )
    except ValueError:
        # Re-raise provider-validation errors from RemoteLLMClient unchanged;
        # they contain no credential material.
        raise
