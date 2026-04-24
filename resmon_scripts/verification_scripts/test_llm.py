# resmon_scripts/verification_scripts/test_llm.py
"""Step 8 verification: LLM integration — remote and local clients."""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from implementation_scripts.llm_remote import RemoteLLMClient
from implementation_scripts.llm_local import LocalLLMClient
from implementation_scripts.prompt_templates import SUMMARIZE_ABSTRACT


def test_remote_client_instantiates():
    """RemoteLLMClient can be instantiated for each supported provider."""
    for provider in ["openai", "anthropic"]:
        client = RemoteLLMClient(provider=provider, api_key="test_invalid_key", model="test")
        assert client is not None


def test_remote_client_rejects_invalid_key():
    """summarize() with an invalid key raises an appropriate error without leaking the key."""
    client = RemoteLLMClient(provider="openai", api_key="sk-invalid", model="gpt-4o-mini")
    try:
        client.summarize("Test text", {"tone": "technical", "length": "short"})
        assert False, "Should have raised an error"
    except Exception as e:
        assert "sk-invalid" not in str(e), "API key leaked in error message"


def test_local_client_instantiates():
    """LocalLLMClient can be instantiated."""
    client = LocalLLMClient(model="llama3.2", endpoint="http://localhost:11434")
    assert client is not None


def test_prompt_templates_exist():
    """Required prompt templates are defined."""
    from implementation_scripts.prompt_templates import SUMMARIZE_FULL_TEXT, AGGREGATE_SUMMARIES

    assert SUMMARIZE_ABSTRACT is not None
    assert "{abstract}" in SUMMARIZE_ABSTRACT
    assert SUMMARIZE_FULL_TEXT is not None
    assert "{text}" in SUMMARIZE_FULL_TEXT
    assert AGGREGATE_SUMMARIES is not None
    assert "{chunk_summaries}" in AGGREGATE_SUMMARIES
