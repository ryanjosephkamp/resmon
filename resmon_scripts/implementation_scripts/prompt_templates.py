# resmon_scripts/implementation_scripts/prompt_templates.py
"""Parameterized prompt templates for LLM-powered summarization."""

from __future__ import annotations

import hashlib
from importlib import resources

_CONSTITUTION_MAX_BYTES = 16_384
_CONSTITUTION_CACHE: str | None = None


def load_constitution() -> str:
    """Return the summarization-model constitution text, memoised at module scope.

    Loaded once per process via ``importlib.resources`` from
    ``implementation_scripts/assets/ai_summary_model_rules.md``. Size is
    capped at 16 KB to keep the prompt footprint bounded (ADQ-AI10).

    Raises
    ------
    RuntimeError
        If the constitution file cannot be located.
    AssertionError
        If the constitution exceeds ``_CONSTITUTION_MAX_BYTES``.
    """
    global _CONSTITUTION_CACHE
    if _CONSTITUTION_CACHE is not None:
        return _CONSTITUTION_CACHE

    try:
        content = (
            resources.files("implementation_scripts.assets")
            .joinpath("ai_summary_model_rules.md")
            .read_text(encoding="utf-8")
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "Summarization constitution missing at "
            "implementation_scripts/assets/ai_summary_model_rules.md"
        ) from exc

    assert len(content.encode("utf-8")) <= _CONSTITUTION_MAX_BYTES, (
        f"Summarization constitution exceeds {_CONSTITUTION_MAX_BYTES} bytes "
        f"(got {len(content.encode('utf-8'))})."
    )

    _CONSTITUTION_CACHE = content
    return content


def render_system_prompt() -> str:
    """Return the full system prompt (role-framing + constitution block)."""
    return (
        "You are a senior research scientist. Your top priority is scientific "
        "accuracy, rigor, and validity. You must strictly follow the governing "
        "constitution attached below. Do not introduce any facts, numbers, "
        "citations, or claims that are not explicitly present in the source "
        "text. If the source is ambiguous, say so; do not guess.\n\n"
        "BEGIN SUMMARIZATION CONSTITUTION\n"
        f"{load_constitution()}\n"
        "END SUMMARIZATION CONSTITUTION"
    )


def constitution_sha256_prefix(length: int = 8) -> str:
    """Return the leading ``length`` hex characters of the constitution's SHA-256."""
    digest = hashlib.sha256(load_constitution().encode("utf-8")).hexdigest()
    return digest[:length]


class _LazySystemPreamble:
    """String-like handle that renders the system preamble on demand.

    Kept as a descriptor-ish object so that importing ``prompt_templates``
    does not force the constitution file to be read (useful for tests and
    code paths that never touch summarization). String operations and
    equality comparisons transparently materialise the full preamble.
    """

    def __str__(self) -> str:
        return render_system_prompt()

    def __repr__(self) -> str:
        return self.__str__()

    def __eq__(self, other: object) -> bool:
        return str(self) == other

    def __ne__(self, other: object) -> bool:
        return not self.__eq__(other)

    def __hash__(self) -> int:
        return hash(str(self))

    def __contains__(self, item: object) -> bool:
        return item in str(self)

    def __len__(self) -> int:
        return len(str(self))


SYSTEM_PREAMBLE = _LazySystemPreamble()


# ---------------------------------------------------------------------------
# Length → word-count band mapping (ADQ-AI4, F2)
# ---------------------------------------------------------------------------

_LENGTH_BANDS: dict[str, str] = {
    "brief": "~40–80",
    "standard": "~120–180",
    "detailed": "~250–450",
}


def length_band(length: str) -> str:
    """Return the word-count band string for a given length token.

    Unknown or empty tokens fall back to the ``standard`` band, matching
    ADQ-AI4's decision that an unspecified length preference means
    ``standard`` rather than the historical silent ``short`` default.
    """
    if not length:
        return _LENGTH_BANDS["standard"]
    return _LENGTH_BANDS.get(length, _LENGTH_BANDS["standard"])


# ---------------------------------------------------------------------------
# Abstract summarization
# ---------------------------------------------------------------------------

SUMMARIZE_ABSTRACT = (
    "Write the summary in strict adherence to the attached constitution.\n\n"
    "Tone: {tone}\n"
    "Target length: {length} ({word_count_band} words)\n"
    "Extraction goals: {extraction_goals}\n\n"
    "Abstract:\n{abstract}\n\n"
    "Produce the summary now."
)

# ---------------------------------------------------------------------------
# Full-text summarization
# ---------------------------------------------------------------------------

SUMMARIZE_FULL_TEXT = (
    "Write the summary in strict adherence to the attached constitution.\n"
    "Focus on methodology, results, and the authors' own contributions. "
    "Omit boilerplate acknowledgments and formatting artefacts.\n\n"
    "Tone: {tone}\n"
    "Target length: {length} ({word_count_band} words)\n"
    "Extraction goals: {extraction_goals}\n\n"
    "Text:\n{text}\n\n"
    "Produce the summary now."
)

# ---------------------------------------------------------------------------
# Chunk-summary aggregation
# ---------------------------------------------------------------------------

AGGREGATE_SUMMARIES = (
    "Write the aggregated summary in strict adherence to the attached "
    "constitution.\n"
    "The following are summaries of individual sections of a scholarly "
    "paper. Combine them into a single coherent summary without adding any "
    "information that is not already present in the section summaries.\n\n"
    "Tone: {tone}\n"
    "Target length: {length} ({word_count_band} words)\n\n"
    "Section summaries:\n{chunk_summaries}\n\n"
    "Produce the unified summary now."
)
