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

from .ai_lanes import AILane, resolve_chain
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


# ---------------------------------------------------------------------------
# Lane-aware construction (1.8a)
# ---------------------------------------------------------------------------
#
# ``build_llm_client_from_settings`` above is kept as-is: it is the pre-1.8
# entry point, it is what ``resmon.py`` calls today, and a pile of tests pin
# its exact behaviour including which failures return None and which raise.
# The functions below are the lane-shaped view of the same machinery. 1.8b
# moves the caller onto them; until then both exist and agree, because the
# one-lane chain a legacy configuration resolves to produces exactly the
# client the old path produced.


def build_client_for_lane(
    lane: AILane,
    ephemeral: Optional[dict] = None,
) -> Optional[Union[RemoteLLMClient, LocalLLMClient]]:
    """Construct the client for one lane, or ``None`` if it cannot be built.

    Returns ``None`` rather than raising for the ordinary "not configured"
    cases -- no model, no key -- because an unusable lane is a lane to skip,
    not a run to abort. The single exception is an insecure custom base URL,
    which raises ``ValueError``: sending a user's API key over plain HTTP to a
    non-loopback host is a mistake worth stopping for rather than silently
    routing around.
    """
    if lane.kind == "local":
        if not lane.model:
            logger.info("Lane %s has no model configured; skipping.", lane.label)
            return None
        if lane.endpoint:
            return LocalLLMClient(model=lane.model, endpoint=lane.endpoint)
        return LocalLLMClient(model=lane.model)

    if lane.kind == "subscription":
        # The client that drives an installed agent CLI arrives in 1.8c. Until
        # then a subscription lane resolves and records but cannot run, which
        # is reported honestly rather than pretended around.
        logger.info(
            "Lane %s is a subscription lane; no client implementation yet (1.8c).",
            lane.label,
        )
        return None

    # api_key
    custom_base_url: Optional[str] = None
    if lane.provider == "custom":
        custom_base_url = _validate_custom_base_url(lane.base_url or "")

    key = _lookup_key(lane.provider, ephemeral)
    if not key:
        logger.info("Lane %s has no API key available; skipping.", lane.label)
        return None
    if not lane.model:
        logger.info("Lane %s has no model configured; skipping.", lane.label)
        return None

    return RemoteLLMClient(
        provider=lane.provider,
        api_key=key,
        model=lane.model,
        custom_base_url=custom_base_url,
    )


def build_chain_from_settings(settings: dict) -> list[AILane]:
    """Resolve *settings* into the ordered lanes to try.

    A thin re-export so callers have one import for "how do I get the lanes",
    and so the resolution rules stay in :mod:`ai_lanes` where they are tested.
    """
    return resolve_chain(settings)
