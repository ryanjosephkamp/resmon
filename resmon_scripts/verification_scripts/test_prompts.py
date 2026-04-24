# resmon_scripts/verification_scripts/test_prompts.py
"""Verification tests for prompt_templates constitution loader (IMPL-AI2)."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

# Ensure `resmon_scripts/` is on sys.path so `implementation_scripts` is importable.
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))


def _fresh_module():
    """Re-import prompt_templates so the module-level cache is reset."""
    if "implementation_scripts.prompt_templates" in sys.modules:
        del sys.modules["implementation_scripts.prompt_templates"]
    return importlib.import_module("implementation_scripts.prompt_templates")


def test_constitution_loaded_once():
    pt = _fresh_module()
    first = pt.load_constitution()
    second = pt.load_constitution()
    # Identity check: memoised string should be the same object on second call.
    assert first is second
    assert first.startswith("<!-- version: 1.0 -->")
    assert len(first.encode("utf-8")) <= 16_384


def test_system_preamble_contains_markers():
    pt = _fresh_module()
    rendered = pt.render_system_prompt()
    assert rendered.count("BEGIN SUMMARIZATION CONSTITUTION") == 1
    assert rendered.count("END SUMMARIZATION CONSTITUTION") == 1
    assert "senior research scientist" in rendered
    # Lazy SYSTEM_PREAMBLE should stringify to the same content.
    assert str(pt.SYSTEM_PREAMBLE) == rendered


def test_constitution_sha256_prefix():
    pt = _fresh_module()
    prefix = pt.constitution_sha256_prefix()
    assert len(prefix) == 8
    assert all(c in "0123456789abcdef" for c in prefix)
    assert pt.constitution_sha256_prefix(length=16) == (
        pt.constitution_sha256_prefix() + pt.constitution_sha256_prefix(length=16)[8:]
    )


def test_runtime_error_when_constitution_missing(monkeypatch):
    pt = _fresh_module()

    class _MissingTraversable:
        def joinpath(self, *_parts):
            return self

        def read_text(self, encoding="utf-8"):
            raise FileNotFoundError("simulated missing asset")

    def _fake_files(_package):
        return _MissingTraversable()

    monkeypatch.setattr(pt.resources, "files", _fake_files)
    # Clear the cache so the next call actually invokes the loader.
    monkeypatch.setattr(pt, "_CONSTITUTION_CACHE", None)

    with pytest.raises(RuntimeError, match="Summarization constitution missing"):
        pt.load_constitution()


# ---------------------------------------------------------------------------
# IMPL-AI3 — tightened templates + length-band mapping
# ---------------------------------------------------------------------------


def test_length_band_word_count_brief():
    pt = _fresh_module()
    band = pt.length_band("brief")
    assert "40" in band and "80" in band


def test_length_band_word_count_standard():
    pt = _fresh_module()
    band = pt.length_band("standard")
    assert "120" in band and "180" in band


def test_length_band_word_count_detailed():
    pt = _fresh_module()
    band = pt.length_band("detailed")
    assert "250" in band and "450" in band


def test_length_band_empty_falls_back_to_standard():
    pt = _fresh_module()
    assert pt.length_band("") == pt.length_band("standard")


def test_detailed_has_no_concise():
    pt = _fresh_module()
    abstract_body = "This abstract contains the word concise as a red herring."
    rendered = pt.SUMMARIZE_ABSTRACT.format(
        tone="technical",
        length="detailed",
        word_count_band=pt.length_band("detailed"),
        extraction_goals="key findings, methodology, contributions",
        abstract=abstract_body,
    )
    # Isolate the instruction section (everything outside the abstract body).
    instruction_section = rendered.replace(abstract_body, "")
    assert "concise" not in instruction_section.lower(), instruction_section


def test_all_templates_start_with_constitution_reminder():
    pt = _fresh_module()
    reminder = "strict adherence to the attached constitution"
    assert reminder in pt.SUMMARIZE_ABSTRACT
    assert reminder in pt.SUMMARIZE_FULL_TEXT
    assert reminder in pt.AGGREGATE_SUMMARIES


def test_templates_use_word_count_band_placeholder():
    pt = _fresh_module()
    for tmpl in (pt.SUMMARIZE_ABSTRACT, pt.SUMMARIZE_FULL_TEXT, pt.AGGREGATE_SUMMARIES):
        assert "{word_count_band}" in tmpl
        assert "{length}" in tmpl
