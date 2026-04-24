# resmon_scripts/implementation_scripts/summarizer.py
"""Token-aware chunking and summarization pipeline."""

import logging

import nltk
import tiktoken

from .prompt_templates import (
    SUMMARIZE_FULL_TEXT,
    AGGREGATE_SUMMARIES,
    length_band,
    constitution_sha256_prefix,
)

logger = logging.getLogger(__name__)

# Ensure punkt_tab data is available (downloaded once at install time)
try:
    nltk.data.find("tokenizers/punkt_tab")
except LookupError:
    nltk.download("punkt_tab", quiet=True)

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

_DEFAULT_MAX_TOKENS = 3000  # conservative default leaving room for prompt overhead
_DEFAULT_OVERLAP_TOKENS = 200
_CHARS_PER_TOKEN_HEURISTIC = 4  # rough estimate for non-tiktoken models


class SummarizationPipeline:
    """Route text through an LLM client with automatic token-aware chunking.

    Works with both ``RemoteLLMClient`` and ``LocalLLMClient`` — any object
    that exposes ``summarize(text, prompt_params) -> str`` and has a
    ``provider`` attribute (or not).
    """

    def __init__(self, llm_client, prompt_params: dict | None = None) -> None:
        self.llm_client = llm_client
        self.prompt_params = prompt_params or {}

        # Try to build a tiktoken encoder if the client uses an OpenAI model
        self._tiktoken_enc = None
        model = getattr(llm_client, "model", None)
        provider = getattr(llm_client, "provider", None)
        if provider == "openai" and model:
            try:
                self._tiktoken_enc = tiktoken.encoding_for_model(model)
            except KeyError:
                # Unknown model — fall back to cl100k_base (GPT-4 family)
                try:
                    self._tiktoken_enc = tiktoken.get_encoding("cl100k_base")
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # Token estimation
    # ------------------------------------------------------------------

    def estimate_tokens(self, text: str) -> int:
        """Estimate the token count of *text*.

        Uses tiktoken for OpenAI models; falls back to a ~4 chars/token
        heuristic for all others.
        """
        if not text:
            return 0
        if self._tiktoken_enc is not None:
            return len(self._tiktoken_enc.encode(text))
        return max(1, len(text) // _CHARS_PER_TOKEN_HEURISTIC)

    # ------------------------------------------------------------------
    # Chunking
    # ------------------------------------------------------------------

    def chunk_text(
        self,
        text: str,
        max_tokens: int = _DEFAULT_MAX_TOKENS,
        overlap_tokens: int = _DEFAULT_OVERLAP_TOKENS,
    ) -> list[str]:
        """Split *text* at sentence boundaries into chunks of ≤ *max_tokens*.

        Adjacent chunks share approximately *overlap_tokens* worth of trailing
        sentences from the previous chunk to preserve local context.
        """
        if not text or not text.strip():
            return []

        sentences = nltk.sent_tokenize(text)
        if not sentences:
            return []

        chunks: list[str] = []
        current_sentences: list[str] = []
        current_tokens = 0

        for sentence in sentences:
            sent_tokens = self.estimate_tokens(sentence)

            if current_tokens + sent_tokens > max_tokens and current_sentences:
                # Flush current chunk
                chunks.append(" ".join(current_sentences))

                # Build overlap from the tail of the current chunk
                overlap_sents: list[str] = []
                overlap_count = 0
                for s in reversed(current_sentences):
                    s_tok = self.estimate_tokens(s)
                    if overlap_count + s_tok > overlap_tokens:
                        break
                    overlap_sents.insert(0, s)
                    overlap_count += s_tok

                current_sentences = overlap_sents
                current_tokens = overlap_count

            current_sentences.append(sentence)
            current_tokens += sent_tokens

        # Final chunk
        if current_sentences:
            chunks.append(" ".join(current_sentences))

        return chunks

    # ------------------------------------------------------------------
    # Audit prefix (IMPL-AI13)
    # ------------------------------------------------------------------

    def _audit_prefix(self) -> str:
        """Return the ``[constitution: ... | model: ... | length: ...]`` prefix.

        Returns an empty string when ``prompt_params["_show_audit_prefix"]``
        is explicitly False. The constitution digest is cached by
        :func:`constitution_sha256_prefix`; failures there propagate because
        the constitution is mandatory (ADQ-AI1).
        """
        if self.prompt_params.get("_show_audit_prefix") is False:
            return ""
        provider = str(self.prompt_params.get("_audit_provider") or "").strip()
        if not provider:
            provider = str(getattr(self.llm_client, "provider", "") or "").strip() or "unknown"
        model = str(self.prompt_params.get("_audit_model") or "").strip()
        if not model:
            model = str(getattr(self.llm_client, "model", "") or "").strip() or "unknown"
        length_token = str(self.prompt_params.get("length") or "standard")
        band = length_band(length_token)
        try:
            const_hash = constitution_sha256_prefix(8)
        except Exception:  # pragma: no cover - constitution is mandatory
            const_hash = "unknown"
        return (
            f"[constitution: {const_hash} | model: {provider}/{model} "
            f"| length: {band}]"
        )

    def _decorate(self, summary: str) -> str:
        """Prepend the audit prefix to *summary* unless disabled."""
        prefix = self._audit_prefix()
        if not prefix:
            return summary
        if not summary:
            return prefix
        return f"{prefix}\n\n{summary}"

    # ------------------------------------------------------------------
    # Single-document summarization
    # ------------------------------------------------------------------

    def summarize_document(self, text: str) -> str:
        """Summarize a single document, chunking automatically if needed.

        If the document fits within ``_DEFAULT_MAX_TOKENS``, it is sent to
        the LLM in one call.  Otherwise it is split into chunks, each chunk
        is summarized, and the chunk summaries are aggregated.  If the
        aggregated summaries still exceed the context window, aggregation
        is applied recursively.
        """
        if not text or not text.strip():
            return ""

        token_count = self.estimate_tokens(text)

        if token_count <= _DEFAULT_MAX_TOKENS:
            # Fits in a single call
            return self._decorate(self.llm_client.summarize(text, self.prompt_params))

        # Chunk and summarize each chunk
        chunks = self.chunk_text(text)
        chunk_summaries = [
            self.llm_client.summarize(chunk, self.prompt_params)
            for chunk in chunks
        ]

        return self._decorate(self._aggregate_summaries(chunk_summaries))

    # ------------------------------------------------------------------
    # Batch summarization
    # ------------------------------------------------------------------

    def summarize_batch(self, documents: list[str]) -> list[str]:
        """Summarize a list of documents, returning per-document results."""
        results: list[str] = []
        for i, doc in enumerate(documents):
            logger.info("Summarizing document %d/%d", i + 1, len(documents))
            results.append(self.summarize_document(doc))
        return results

    # ------------------------------------------------------------------
    # Aggregation (with recursive fallback)
    # ------------------------------------------------------------------

    def _aggregate_summaries(self, summaries: list[str]) -> str:
        """Combine chunk summaries into a single coherent summary.

        Recurses if the concatenated summaries exceed the context window.
        """
        combined = "\n\n".join(summaries)
        combined_tokens = self.estimate_tokens(combined)

        if combined_tokens <= _DEFAULT_MAX_TOKENS:
            _length = self.prompt_params.get("length") or "standard"
            agg_prompt = AGGREGATE_SUMMARIES.format(
                chunk_summaries=combined,
                tone=self.prompt_params.get("tone", "technical"),
                length=_length,
                word_count_band=length_band(_length),
            )
            return self.llm_client.summarize(agg_prompt, self.prompt_params)

        # Recursive: re-chunk the summaries and aggregate again
        logger.info(
            "Chunk summaries exceed context window (%d tokens); "
            "recursively aggregating.",
            combined_tokens,
        )
        sub_chunks = self.chunk_text(combined)
        sub_summaries = [
            self.llm_client.summarize(chunk, self.prompt_params)
            for chunk in sub_chunks
        ]
        return self._aggregate_summaries(sub_summaries)
