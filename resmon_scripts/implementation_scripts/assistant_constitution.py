"""The assistant's constitution, and the one function that loads it.

Separate from ``prompt_templates.load_constitution`` on purpose. That document
governs *summarising a paper*; this one governs *acting inside the app*, and
they say opposite things about tools — the summary lanes run with tools off and
the assistant cannot function without them. One file loading both would be one
edit away from sending the wrong rules to the wrong model.

**The 1.8.4 lesson is the whole reason this module has tests.** Every check on
the summary constitution asked whether the document *existed* — loads,
memoises, under 16 KB. What broke was whether it *arrived*: two lanes shipped
telling the model to follow an attached constitution with nothing attached, and
the agent CLI, unable to go looking, fabricated a file search and returned its
invented results as a paper's summary. So the tests that matter here are not in
this file at all; they are in ``test_assistant_constitution.py``, and they
assert transmission at each runtime's real boundary.
"""

from __future__ import annotations

import hashlib
from importlib import resources
from typing import Optional

__all__ = [
    "MAX_BYTES",
    "load_assistant_constitution",
    "assistant_constitution_sha256_prefix",
]

# The same ceiling the summary constitution carries. It is paid on every turn
# of every conversation, and a system prompt nobody is watching the size of is
# one that grows.
MAX_BYTES = 16_384

_CACHE: Optional[str] = None


def load_assistant_constitution() -> str:
    """Return the assistant constitution's text, memoised at module scope."""
    global _CACHE
    if _CACHE is not None:
        return _CACHE

    try:
        content = (
            resources.files("implementation_scripts.assets")
            .joinpath("assistant_rules.md")
            .read_text(encoding="utf-8")
        )
    except FileNotFoundError as exc:
        # Raised, never defaulted to an empty string. A runtime that started
        # with no constitution would be the 1.8.4 failure exactly: an agent
        # with tools, told to follow rules it was never given.
        raise RuntimeError(
            "Assistant constitution missing at "
            "implementation_scripts/assets/assistant_rules.md"
        ) from exc

    size = len(content.encode("utf-8"))
    if size > MAX_BYTES:
        raise AssertionError(
            f"Assistant constitution exceeds {MAX_BYTES} bytes (got {size})."
        )

    _CACHE = content
    return content


def assistant_constitution_sha256_prefix(length: int = 8) -> str:
    """The leading hex characters of the constitution's SHA-256.

    Recorded on a session so a transcript can be read against the rules that
    were actually in force when it happened, rather than against whatever the
    file says by the time someone opens it.
    """
    digest = hashlib.sha256(load_assistant_constitution().encode("utf-8")).hexdigest()
    return digest[:length]
