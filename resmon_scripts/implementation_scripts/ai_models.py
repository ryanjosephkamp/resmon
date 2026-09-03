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


# ---------------------------------------------------------------------------
# Subscription lanes (1.8.5)
# ---------------------------------------------------------------------------
#
# ``list_available_models`` above raises ``Unsupported provider`` for
# ``claude_code`` and ``codex``, which was correct while nothing could answer
# for them and is not correct now. But the two CLIs answer in genuinely
# different ways, and flattening that into one list would be the overclaim this
# project rejects:
#
# ``claude``  has **no** models-listing command. What it documents is aliases —
#             ``--help`` names 'fable', 'opus' and 'sonnet', and 'haiku' was
#             verified by running it. So the list resmon offers is *the aliases
#             the CLI accepts*, and the interface says so. It is not a list of
#             models this account can reach, and resmon has not checked that.
#
# ``codex``   does answer. ``codex debug models`` prints JSON with a slug, a
#             ``visibility`` flag and, per model, the reasoning levels that
#             model supports. That is a real catalog and it is used as one —
#             with the caveat, recorded here because it is load-bearing, that
#             ``debug`` is not a documented stable interface. If it changes
#             shape or disappears, this degrades to free text rather than
#             failing the lane.
#
# Neither call is made to decide whether the lane works. Only the first real
# summarization call establishes that, and that has not changed.

import json as _json  # noqa: E402  (module already imports what it needs above)
import subprocess  # noqa: E402

# How long ``codex debug models`` may take before resmon gives up on it. The
# Settings page waits on this, so it is short: an unavailable catalog costs the
# dropdown, not the lane.
_CLI_CATALOG_TIMEOUT = 20.0

# The aliases ``claude --help`` documents, plus the one verified by running it.
# Ordered strongest-first, which is also how the CLI's own help lists them.
CLAUDE_MODEL_ALIASES = ("fable", "opus", "sonnet", "haiku")

# ``claude --effort`` accepts these; the CLI rejects a level a model does not
# support, and resmon passes that rejection through rather than pre-judging it.
CLAUDE_EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")


class SubscriptionCatalog:
    """What resmon can honestly offer for one agent CLI.

    ``provenance`` is not decoration. "These are the aliases the command
    accepts" and "this is the catalog the command reported" are different
    claims, and the interface renders whichever one is true.
    """

    __slots__ = ("models", "provenance", "efforts", "default_efforts", "error")

    def __init__(
        self,
        models: list[str],
        provenance: str,
        efforts: dict[str, list[str]] | None = None,
        default_efforts: dict[str, str] | None = None,
        error: str = "",
    ) -> None:
        self.models = models
        self.provenance = provenance
        self.efforts = efforts or {}
        self.default_efforts = default_efforts or {}
        self.error = error

    def to_dict(self) -> dict:
        return {
            "models": list(self.models),
            "provenance": self.provenance,
            "efforts": {k: list(v) for k, v in self.efforts.items()},
            "default_efforts": dict(self.default_efforts),
            "error": self.error,
        }


def list_subscription_catalog(
    provider: str, binary_path: str | None = None,
) -> SubscriptionCatalog:
    """Return the models and effort levels *provider* can honestly offer."""
    provider = (provider or "").strip().lower()

    if provider == "claude_code":
        return SubscriptionCatalog(
            models=list(CLAUDE_MODEL_ALIASES),
            provenance=(
                "Aliases the claude command accepts — not a list of models "
                "this account can reach. resmon has not checked that."
            ),
            # One effort list for every alias: the CLI documents the levels
            # globally and rejects an unsupported one per model at call time.
            efforts={alias: list(CLAUDE_EFFORT_LEVELS) for alias in CLAUDE_MODEL_ALIASES},
        )

    if provider == "codex":
        return _codex_catalog(binary_path)

    raise ModelListError(f"Unsupported provider: {provider}")


def _codex_catalog(binary_path: str | None) -> SubscriptionCatalog:
    from .ai_cli import discover_cli

    discovery = discover_cli("codex", binary_path)
    if not discovery.found:
        return SubscriptionCatalog(
            models=[], provenance="", error=discovery.describe(),
        )

    try:
        completed = subprocess.run(
            [discovery.path or "", "debug", "models"],
            capture_output=True, text=True, timeout=_CLI_CATALOG_TIMEOUT,
            stdin=subprocess.DEVNULL, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.info("codex debug models did not answer: %s", exc)
        return SubscriptionCatalog(
            models=[], provenance="",
            error="The codex command did not answer with its model catalog.",
        )

    try:
        payload = _json.loads((completed.stdout or "").strip())
        entries = payload["models"]
        if not isinstance(entries, list):
            raise ValueError("models is not a list")
    except (ValueError, TypeError, KeyError):
        # `debug` is not a stable interface. A shape change costs the dropdown
        # and nothing else; free text still reaches the CLI.
        logger.info("codex debug models returned an unrecognised shape.")
        return SubscriptionCatalog(
            models=[], provenance="",
            error=(
                "The codex command's model catalog was not in a shape resmon "
                "recognises. Type a model name instead."
            ),
        )

    models: list[str] = []
    efforts: dict[str, list[str]] = {}
    defaults: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        slug = entry.get("slug")
        if not isinstance(slug, str) or not slug:
            continue
        # ``hide`` marks a model codex itself does not list to users. Offering
        # it would be resmon inventing a choice the tool declines to present.
        if entry.get("visibility") != "list":
            continue
        models.append(slug)
        levels = [
            level.get("effort")
            for level in entry.get("supported_reasoning_levels") or []
            if isinstance(level, dict) and isinstance(level.get("effort"), str)
        ]
        if levels:
            efforts[slug] = levels
        default_level = entry.get("default_reasoning_level")
        if isinstance(default_level, str) and default_level:
            defaults[slug] = default_level

    if not models:
        return SubscriptionCatalog(
            models=[], provenance="",
            error="The codex command reported no models it lists.",
        )

    return SubscriptionCatalog(
        models=models,
        provenance="Reported by `codex debug models` on this machine.",
        efforts=efforts,
        default_efforts=defaults,
    )
