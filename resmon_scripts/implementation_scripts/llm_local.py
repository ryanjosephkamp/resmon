# resmon_scripts/implementation_scripts/llm_local.py
"""Local LLM client via the ollama REST API."""

import logging

import httpx

from .prompt_templates import SUMMARIZE_ABSTRACT, length_band

logger = logging.getLogger(__name__)

_DEFAULT_ENDPOINT = "http://localhost:11434"


class LocalLLMClient:
    """Local LLM client that communicates with an ollama instance.

    Uses the ollama REST API (``/api/generate`` for inference,
    ``/api/tags`` for model listing).
    """

    def __init__(self, model: str, endpoint: str = _DEFAULT_ENDPOINT) -> None:
        self.model = model
        self.endpoint = endpoint.rstrip("/")
        logger.info(
            "LocalLLMClient initialized: model=%s, endpoint=%s",
            model, self.endpoint,
        )

    # ------------------------------------------------------------------
    # Summarize
    # ------------------------------------------------------------------

    def summarize(self, text: str, prompt_params: dict | None = None) -> str:
        """Send *text* to the local ollama model and return the summary.

        *prompt_params* may contain ``tone``, ``length``, and
        ``extraction_goals``.
        """
        defaults = {
            "tone": "technical",
            "length": "standard",
            "extraction_goals": "key findings, methodology, contributions",
        }
        params = {**defaults, **{k: v for k, v in (prompt_params or {}).items() if v}}
        params.setdefault("abstract", text)
        params.setdefault("word_count_band", length_band(params.get("length", "")))

        prompt = SUMMARIZE_ABSTRACT.format(**params)

        with httpx.Client(timeout=120) as client:
            response = client.post(
                f"{self.endpoint}/api/generate",
                json={"model": self.model, "prompt": prompt, "stream": False},
            )
            response.raise_for_status()
            return response.json().get("response", "")

    # ------------------------------------------------------------------
    # List models
    # ------------------------------------------------------------------

    def list_available_models(self) -> list[str]:
        """GET ``/api/tags`` and return the names of available models."""
        with httpx.Client(timeout=30) as client:
            response = client.get(f"{self.endpoint}/api/tags")
            response.raise_for_status()
            data = response.json()
            models = data.get("models", [])
            return sorted(m.get("name", "") for m in models)
