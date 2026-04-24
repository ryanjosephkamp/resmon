# resmon_scripts/implementation_scripts/llm_remote.py
"""Remote LLM clients for BYOK providers.

Supported providers (IMPL-AI5):
    openai, anthropic, google, xai, meta, deepseek, alibaba, custom

All OpenAI-compatible providers (openai, xai, meta, deepseek, alibaba, custom)
go through a single ``_openai_compatible_request`` helper driven by the
``_PROVIDER_SPECS`` registry. Anthropic keeps its official SDK. Google uses a
dedicated ``generativelanguage.googleapis.com`` endpoint with
``system_instruction`` semantics.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx
import anthropic

from .prompt_templates import SUMMARIZE_ABSTRACT, SYSTEM_PREAMBLE, length_band

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

_SUPPORTED_PROVIDERS = {
    "openai",
    "anthropic",
    "google",
    "xai",
    "meta",
    "deepseek",
    "alibaba",
    "custom",
}


@dataclass(frozen=True)
class ProviderSpec:
    """OpenAI-compatible provider endpoint record."""

    base_url: str
    default_model: str
    auth_style: str  # currently only "bearer"


_PROVIDER_SPECS: dict[str, ProviderSpec] = {
    "openai":   ProviderSpec("https://api.openai.com/v1",                              "gpt-4o-mini",                              "bearer"),
    "xai":      ProviderSpec("https://api.x.ai/v1",                                    "grok-2-latest",                            "bearer"),
    "meta":     ProviderSpec("https://api.together.xyz/v1",                            "meta-llama/Llama-3.3-70B-Instruct-Turbo",  "bearer"),
    "deepseek": ProviderSpec("https://api.deepseek.com/v1",                            "deepseek-chat",                            "bearer"),
    "alibaba":  ProviderSpec("https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen-plus",                                "bearer"),
}


_MAX_TOKENS_BY_LENGTH: dict[str, int] = {
    "brief": 256,
    "standard": 512,
    "detailed": 1024,
}
_DEFAULT_TEMPERATURE = 0.2

_CONTEXT_ERROR_MARKERS = (
    "context_length_exceeded",
    "context length",
    "prompt is too long",
    "maximum context",
)


def _max_tokens_for(length: str) -> int:
    return _MAX_TOKENS_BY_LENGTH.get(length or "standard", _MAX_TOKENS_BY_LENGTH["standard"])


def _is_context_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    body = ""
    resp = getattr(exc, "response", None)
    if resp is not None:
        try:
            body = resp.text.lower()
        except Exception:
            body = ""
    haystack = f"{msg}\n{body}"
    return any(marker in haystack for marker in _CONTEXT_ERROR_MARKERS)


def _openai_compatible_request(
    spec: "ProviderSpec",
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    params: dict[str, Any],
) -> str:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": params.get("temperature", _DEFAULT_TEMPERATURE),
        "max_tokens": params.get("max_tokens", _max_tokens_for(params.get("length", ""))),
    }
    with httpx.Client(timeout=120) as client:
        resp = client.post(f"{spec.base_url}/chat/completions", headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
    return data["choices"][0]["message"]["content"]


def _google_request(
    api_key: str,
    model: str,
    system_instruction: str,
    user_text: str,
    params: dict[str, Any],
) -> str:
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    payload = {
        "system_instruction": {"parts": [{"text": system_instruction}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": params.get("temperature", _DEFAULT_TEMPERATURE),
            "maxOutputTokens": params.get("max_tokens", _max_tokens_for(params.get("length", ""))),
        },
    }
    with httpx.Client(timeout=120) as client:
        resp = client.post(url, json=payload)
        resp.raise_for_status()
        data = resp.json()
    return data["candidates"][0]["content"]["parts"][0]["text"]


class RemoteLLMClient:
    """Unified remote LLM client.

    API keys are stored in memory only and never appear in log messages or
    exception text (constitution §8).
    """

    def __init__(
        self,
        provider: str,
        api_key: str,
        model: str,
        custom_base_url: str | None = None,
    ) -> None:
        if provider not in _SUPPORTED_PROVIDERS:
            raise ValueError(
                f"Unsupported provider '{provider}'. "
                f"Supported: {', '.join(sorted(_SUPPORTED_PROVIDERS))}"
            )
        self.provider = provider
        self.model = model
        self._api_key = api_key

        if provider == "custom":
            if not custom_base_url:
                raise ValueError("custom provider requires custom_base_url")
            self._spec: ProviderSpec | None = ProviderSpec(
                base_url=custom_base_url.rstrip("/"),
                default_model=model,
                auth_style="bearer",
            )
        elif provider in _PROVIDER_SPECS:
            self._spec = _PROVIDER_SPECS[provider]
        else:
            self._spec = None

        if provider == "anthropic":
            self._anthropic = anthropic.Anthropic(api_key=api_key)

        logger.info("RemoteLLMClient initialized: provider=%s, model=%s", provider, model)

    def summarize(self, text: str, prompt_params: dict | None = None) -> str:
        defaults = {
            "tone": "technical",
            "length": "standard",
            "extraction_goals": "key findings, methodology, contributions",
        }
        params = {**defaults, **{k: v for k, v in (prompt_params or {}).items() if v}}
        params.setdefault("abstract", text)
        params.setdefault("word_count_band", length_band(params.get("length", "")))

        def _render(abstract: str) -> str:
            local = {**params, "abstract": abstract}
            return SUMMARIZE_ABSTRACT.format(**local)

        try:
            return self._dispatch(_render(text), params)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 400 and _is_context_error(exc):
                return self._retry_halved(text, params, _render)
            safe = self._sanitize_error(exc)
            logger.error("Summarization failed (provider=%s): %s", self.provider, safe)
            raise RuntimeError(safe) from None
        except Exception as exc:
            if _is_context_error(exc):
                return self._retry_halved(text, params, _render)
            safe = self._sanitize_error(exc)
            logger.error("Summarization failed (provider=%s): %s", self.provider, safe)
            raise RuntimeError(safe) from None

    def _retry_halved(self, text: str, params: dict[str, Any], render) -> str:
        halved = text[: max(1, len(text) // 2)]
        logger.info(
            "Context-length error from provider=%s; retrying once with halved input (%d -> %d chars).",
            self.provider, len(text), len(halved),
        )
        try:
            return self._dispatch(render(halved), params)
        except Exception as retry_exc:
            safe = self._sanitize_error(retry_exc)
            logger.error("Retry failed (provider=%s): %s", self.provider, safe)
            raise RuntimeError(safe) from None

    def _dispatch(self, user_prompt: str, params: dict[str, Any]) -> str:
        system_text = str(SYSTEM_PREAMBLE)
        if self.provider == "anthropic":
            return self._call_anthropic(system_text, user_prompt, params)
        if self.provider == "google":
            return _google_request(self._api_key, self.model, system_text, user_prompt, params)
        assert self._spec is not None, f"missing ProviderSpec for provider={self.provider!r}"
        messages = [
            {"role": "system", "content": system_text},
            {"role": "user", "content": user_prompt},
        ]
        return _openai_compatible_request(self._spec, self._api_key, self.model, messages, params)

    def list_available_models(self) -> list[str]:
        try:
            if self.provider == "anthropic":
                resp = self._anthropic.models.list()
                return sorted(m.id for m in resp.data)
            if self.provider == "google":
                return [self.model]
            if self._spec is not None:
                headers = {"Authorization": f"Bearer {self._api_key}"}
                with httpx.Client(timeout=30) as client:
                    resp = client.get(f"{self._spec.base_url}/models", headers=headers)
                    resp.raise_for_status()
                    data = resp.json()
                items = data.get("data") if isinstance(data, dict) else None
                if not items:
                    return [self.model]
                return sorted(item.get("id", "") for item in items if item.get("id"))
            return [self.model]
        except Exception as exc:
            safe_msg = self._sanitize_error(exc)
            logger.error("list_available_models failed (provider=%s): %s", self.provider, safe_msg)
            raise RuntimeError(safe_msg) from None

    def _call_anthropic(self, system_text: str, prompt: str, params: dict[str, Any]) -> str:
        response = self._anthropic.messages.create(
            model=self.model,
            max_tokens=params.get("max_tokens", _max_tokens_for(params.get("length", ""))),
            system=system_text,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text

    def _sanitize_error(self, exc: Exception) -> str:
        msg = str(exc)
        if self._api_key and self._api_key in msg:
            msg = msg.replace(self._api_key, "[REDACTED]")
        return msg
