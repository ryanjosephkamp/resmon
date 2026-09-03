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


# ---------------------------------------------------------------------------
# Batched abstract summarization (1.8.5)
# ---------------------------------------------------------------------------
#
# One agent-CLI call per paper is the dominant cost of the subscription lane:
# a process to start, a session to establish, and the constitution to read,
# every time. Batching sends N abstracts in one call and asks for N summaries.
#
# Two things make that safe rather than merely fast, and both are in the text
# below because a prompt is where they have to be said:
#
# 1. **Each summary draws only on its own document.** Papers in one sweep are
#    on one topic by construction, so a model given ten of them at once has
#    every opportunity to carry a number from paper three into paper seven's
#    summary. That is the accuracy failure this batching could introduce, and
#    D3 measures it with canary tokens rather than assuming it away.
# 2. **A missing entry is handled; an invented one is not.** See the note on
#    the schema below.

BATCH_DOCUMENT_TEMPLATE = (
    "===== DOCUMENT {index} =====\n"
    "{text}\n"
    "===== END DOCUMENT {index} ====="
)


def render_batch_documents(texts) -> str:
    """Render *texts* as numbered, delimited blocks starting at index 0."""
    return "\n\n".join(
        BATCH_DOCUMENT_TEMPLATE.format(index=i, text=text)
        for i, text in enumerate(texts)
    )


SUMMARIZE_ABSTRACTS_BATCH = (
    "Write every summary in strict adherence to the attached constitution.\n\n"
    "You are given {count} documents, numbered from 0. Summarize each one "
    "separately.\n"
    "Each summary draws only on its own document and never on another in this "
    "batch. Do not compare the documents, do not combine them, and never carry "
    "a fact, number or citation from one document into another's summary.\n"
    "Return one array entry per document, with `index` set to that document's "
    "number. If a document cannot be summarized, omit its entry rather than "
    "writing something to fill the slot: a missing entry is handled, an "
    "invented one is stored as a paper's summary.\n\n"
    "Tone: {tone}\n"
    "Target length for each summary: {length} ({word_count_band} words)\n"
    "Extraction goals: {extraction_goals}\n\n"
    "{documents}\n\n"
    "Produce the summaries now."
)


# The structured-output schema both CLIs are given.
#
# NOTE THE ABSENCE OF ``minItems`` / ``maxItems``, WHICH IS DELIBERATE AND WAS
# MEASURED. The obvious design pins the array to exactly N entries so a short
# answer is rejected by the CLI rather than by resmon. Both CLIs do enforce
# those keywords -- and both enforce them by making the model *fabricate* the
# missing entry:
#
#   claude 2.1.258, schema minItems/maxItems 3, two documents supplied
#     -> three summaries, the third invented ("Cats and dogs exhibit different
#        behavioral characteristics"), num_turns 3 rather than 2, is_error false.
#   codex 0.153.0-alpha.5, same schema, same two documents
#     -> three summaries, the third invented ("Cats and dogs are common pets"),
#        exit 0.
#
# That is the v1.8.4 failure again in a new place: constrain a model to produce
# something it does not have and it invents it, and the invention arrives as a
# clean success. A short array is a fact resmon can act on -- it retries those
# documents individually. A padded array is a fabricated summary attached to a
# real paper. So the schema describes the *shape* and resmon checks the count
# and the index set itself.
BATCH_SUMMARY_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "summaries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "summary": {"type": "string"},
                },
                "required": ["index", "summary"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summaries"],
    "additionalProperties": False,
}
