# resmon_scripts/implementation_scripts/ai_model_names.py
"""A model id, as the agent CLIs report it, in the words a person uses.

The pickers offer aliases (``haiku``, ``opus``) that each CLI resolves to its
newest model when it runs, so resmon cannot know the version before an answer
arrives and does not guess it. What an answer reports is a model id:
``claude-haiku-4-5-20251001`` from Claude Code's result envelope, ``gpt-5.5``
from codex's header. This module turns such an id into "Haiku 4.5" or
"GPT-5.5", and leaves any id it does not recognize exactly as it was reported:
a name made up for an unknown id would be the guess this exists to avoid.

Pure functions, no I/O.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Optional

__all__ = ["ANSWER_SOURCES", "answered_by", "model_display_name"]

# Prefixes a cloud provider puts in front of a Claude id, as in
# ``us.anthropic.claude-sonnet-4-5-20250929-v1:0`` or ``anthropic/claude-...``.
_CLOUD_PREFIX = re.compile(r"^(?:[a-z]{2,4}\.)?anthropic[./]")

# Suffixes that name a snapshot of the same model rather than another model:
# a release date (``-20251001``, ``@20250929``), ``-latest``, and a cloud
# catalogue's version tag (``-v1:0``).
_SNAPSHOT_SUFFIX = re.compile(r"(?:@\d{8}|-\d{8}|-latest|-v\d+(?::\d+)?)$")

# ``claude-haiku-5-5``, ``claude-opus-4-1``, ``claude-fable-5-1``, ``claude-opus-4``.
_CLAUDE_FAMILY_FIRST = re.compile(r"^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$")
# The older order: ``claude-3-5-sonnet``, ``claude-3-opus``.
_CLAUDE_VERSION_FIRST = re.compile(r"^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)$")

# ``gpt-5.5``, ``gpt-5.5-codex``, ``gpt-5-codex-mini``, ``gpt-4o``.
_GPT = re.compile(r"^gpt-(\d+(?:\.\d+)?[a-z]?)((?:-[a-z0-9.]+)*)$")


def _claude_name(model_id: str) -> Optional[str]:
    raw = _CLOUD_PREFIX.sub("", model_id)
    # A bracketed suffix (``[1m]``) names a variant; it is kept as written.
    bracket = ""
    if raw.endswith("]") and "[" in raw:
        raw, _, rest = raw.partition("[")
        bracket = f" [{rest}"
    # A snapshot can carry more than one marker (``-20250929-v1:0``).
    previous = None
    while previous != raw:
        previous = raw
        raw = _SNAPSHOT_SUFFIX.sub("", raw)
    match = _CLAUDE_FAMILY_FIRST.match(raw)
    if match:
        family, major, minor = match.groups()
    else:
        match = _CLAUDE_VERSION_FIRST.match(raw)
        if not match:
            return None
        major, minor, family = match.groups()
    version = f"{major}.{minor}" if minor is not None else major
    return f"{family.capitalize()} {version}{bracket}"


def _gpt_name(model_id: str) -> Optional[str]:
    match = _GPT.match(model_id)
    if not match:
        return None
    version, rest = match.groups()
    words = [word for word in rest.split("-") if word]
    # A word of letters is a name (``codex``, ``mini``) and is capitalized; a
    # word with a digit in it is a version or a size and is left as written.
    shown = [word.capitalize() if word.isalpha() else word for word in words]
    return "-".join(["GPT", version, *shown])


def model_display_name(model_id: Any) -> str:
    """``claude-haiku-4-5-20251001`` as "Haiku 4.5"; an unknown id unchanged.

    Never raises. A value that is not a string becomes its ``str``, so a
    malformed report is shown as what it was rather than hidden.
    """
    text = "" if model_id is None else str(model_id)
    stripped = text.strip()
    lowered = stripped.lower()
    if not stripped or lowered != stripped:
        # The CLIs report ids in lower case. Anything else is not one of the
        # shapes below, and is shown exactly as reported.
        return text
    if "claude-" in lowered:
        name = _claude_name(lowered)
        if name:
            return name
    if lowered.startswith("gpt-"):
        name = _gpt_name(lowered)
        if name:
            return name
    return text


# Which runtime report says which model wrote an answer, strongest first.
#
# ``claude_result_model_usage`` is the result envelope's ``modelUsage``: the
# models that were actually billed for the turn, the first being the one that
# wrote the most. The two API sources are the provider's own reply. The init
# message is last because it is what the CLI announced before it answered,
# which is a report of intent rather than of the answer.
ANSWER_SOURCES = (
    "claude_result_model_usage",
    "api_response_model",
    "google_response_modelVersion",
    "claude_system_init_model",
)


def answered_by(reports: Iterable[Any]) -> Optional[dict]:
    """The model a turn's reports say answered it, or ``None``.

    Takes the stored report list as it is read back. Anything that is not a
    report is skipped rather than trusted.
    """
    usable = [
        r for r in (reports if isinstance(reports, (list, tuple)) else [])
        if isinstance(r, dict) and isinstance(r.get("model"), str)
        and r["model"].strip() and isinstance(r.get("source"), str)
    ]
    for source in ANSWER_SOURCES:
        matches = [r for r in usable if r["source"] == source]
        if not matches:
            continue
        # ``modelUsage`` is recorded with the biggest writer first; for every
        # other source the latest report is the one nearest the answer.
        pick = matches[0] if source == "claude_result_model_usage" else matches[-1]
        return {
            "model": pick["model"],
            "name": model_display_name(pick["model"]),
            "source": source,
        }
    return None
