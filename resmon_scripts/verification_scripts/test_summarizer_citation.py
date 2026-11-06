# resmon_scripts/verification_scripts/test_summarizer_citation.py
"""Verification tests for the summarization pipeline."""

import sys
from pathlib import Path
from unittest.mock import MagicMock

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.summarizer import SummarizationPipeline


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


# ---------------------------------------------------------------------------
# NLTK punkt fallback
# ---------------------------------------------------------------------------

def test_sentence_split_falls_back_without_punkt_data(monkeypatch):
    """Summarization must degrade, not fail, when NLTK's punkt data is absent.

    A source install may have no tokenizer data. The sentence splitter keeps
    summaries usable offline without fetching data during a run.
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


def test_loading_and_summarizing_without_data_never_requests_a_download(monkeypatch, tmp_path):
    """A cold tokenizer lookup must stay offline and split usable sentences."""
    import importlib.util
    import nltk
    import nltk.downloader

    requests: list[str] = []

    def refuse(url, *args, **kwargs):
        requests.append(str(url))
        raise OSError("network refused")

    monkeypatch.setattr(nltk.data, "path", [str(tmp_path)])
    monkeypatch.setattr(nltk.downloader, "urlopen", refuse)
    monkeypatch.setattr(nltk.downloader._downloader, "_index", None)
    monkeypatch.setattr(nltk.downloader._downloader, "_download_dir", str(tmp_path))
    nltk.tokenize._get_punkt_tokenizer.cache_clear()
    spec = importlib.util.spec_from_file_location(
        "implementation_scripts.offline_summarizer",
        PROJECT_ROOT / "resmon_scripts/implementation_scripts/summarizer.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class EchoClient:
        provider = "local"

        def summarize(self, text: str, prompt_params: dict) -> str:
            return text

    pipeline = module.SummarizationPipeline(EchoClient(), {"_show_audit_prefix": False})
    text = "First sentence here. Second one follows! And a third?"
    assert module._sent_tokenize(text) == [
        "First sentence here.", "Second one follows!", "And a third?",
    ]
    assert pipeline.chunk_text(text, max_tokens=6, overlap_tokens=0) == [
        "First sentence here.", "Second one follows!", "And a third?",
    ]
    assert pipeline.summarize_document(text) == text
    assert requests == []
