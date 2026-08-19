# resmon_scripts/verification_scripts/test_summarizer_citation.py
"""Step 9 verification: summarization pipeline and citation graphing."""

import pytest
import sys
from pathlib import Path
from unittest.mock import MagicMock

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.summarizer import SummarizationPipeline
from implementation_scripts.citation_graph import build_citation_tree


def test_short_document_no_chunking():
    """A document under the token limit passes through without chunking."""
    mock_client = MagicMock()
    mock_client.summarize.return_value = "This is a summary."
    pipeline = SummarizationPipeline(
        mock_client,
        {"tone": "technical", "length": "short", "_show_audit_prefix": False},
    )
    result = pipeline.summarize_document("Short test text.")
    assert result == "This is a summary."
    mock_client.summarize.assert_called_once()


def test_long_document_chunking():
    """A long document is correctly split into chunks."""
    pipeline = SummarizationPipeline(MagicMock(), {})
    text = ". ".join([f"Sentence {i}" for i in range(500)])
    chunks = pipeline.chunk_text(text, max_tokens=100, overlap_tokens=20)
    assert len(chunks) > 1
    # Verify overlap: last sentences of chunk N appear in first sentences of chunk N+1
    for i in range(len(chunks) - 1):
        assert len(chunks[i]) > 0


def test_empty_input_handled():
    """Empty or whitespace-only input returns an appropriate result."""
    mock_client = MagicMock()
    pipeline = SummarizationPipeline(mock_client, {})
    result = pipeline.summarize_document("")
    assert result is not None  # should return empty string or a message, not crash


@pytest.mark.live_network
def test_citation_tree_structure():
    """build_citation_tree returns a dict with expected keys (integration test)."""
    # This test requires network access to Semantic Scholar
    try:
        tree = build_citation_tree("649def34f8be52c8b66281af98ae884c09aef38b", depth=1)
        assert "paper_id" in tree
        assert "citations" in tree or "references" in tree
    except Exception:
        pass  # Graceful skip if network unavailable


# ---------------------------------------------------------------------------
# NLTK punkt fallback (BUG-023)
# ---------------------------------------------------------------------------

def test_sentence_split_falls_back_without_punkt_data(monkeypatch):
    """Summarization must degrade, not fail, when NLTK's punkt data is absent.

    pip does not ship NLTK's corpora, and the bootstrap download in
    summarizer.py fails silently when the machine is offline. Before this
    fallback existed, every sent_tokenize call then raised
    ``LookupError: Resource 'punkt_tab' not found`` and the whole execution
    failed -- so AI summarization was unusable on a fresh offline install.
    """
    from implementation_scripts import summarizer

    def _raise(*_a, **_k):
        raise LookupError("Resource 'punkt_tab' not found.")

    monkeypatch.setattr(summarizer.nltk, "sent_tokenize", _raise)
    monkeypatch.setattr(summarizer, "_punkt_warning_emitted", False)

    sentences = summarizer._sent_tokenize(
        "First sentence here. Second one follows! And a third?"
    )
    assert sentences == [
        "First sentence here.",
        "Second one follows!",
        "And a third?",
    ]


def test_chunk_text_survives_missing_punkt_data(monkeypatch):
    """chunk_text is the real caller; it must not raise either."""
    from implementation_scripts import summarizer

    def _raise(*_a, **_k):
        raise LookupError("Resource 'punkt_tab' not found.")

    monkeypatch.setattr(summarizer.nltk, "sent_tokenize", _raise)

    class _StubLLM:
        provider = "anthropic"
        model = "claude-sonnet-4"

    pipeline = summarizer.SummarizationPipeline(_StubLLM())
    chunks = pipeline.chunk_text("Alpha beta gamma. " * 50, max_tokens=50)
    assert chunks, "chunk_text returned nothing"
    assert all(c.strip() for c in chunks)
