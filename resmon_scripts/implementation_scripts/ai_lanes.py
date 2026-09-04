# resmon_scripts/implementation_scripts/ai_lanes.py
"""Lanes: the ordered ways resmon will try to reach a model.

A **lane** is one route to an answer. Three kinds:

``api_key``
    A BYOK provider — what resmon has always had, now one option among three
    rather than the only door.
``local``
    Ollama on the user's machine. Nothing leaves the computer and nothing costs
    anything.
``subscription``
    The agent CLI the user already installed and authenticated, so AI usage
    draws on the Claude Max or ChatGPT plan they already pay for. Resolved here;
    the client that drives it arrives in 1.8c.

Until now :func:`llm_factory.build_llm_client_from_settings` returned a single
client, which meant there was nowhere to put a second choice. This module is the
change that makes a chain expressible. It resolves configuration into lanes and
builds a client from one; **executing** a chain — trying lane two when lane one
fails — is 1.8b.

Backward compatibility is a requirement, not a courtesy: standing rule,
functionality never decreases. A database that has only the old ``ai_provider``
keys resolves to a one-lane chain at read time. No data moves, no migration
runs, and nobody's app behaves differently until they add a second lane
themselves.

Nothing in this module holds or returns a credential value. A lane names the
keyring slot it needs (``credential_alias``); the value is fetched at
client-build time and never stored on the lane.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, asdict
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

__all__ = [
    "AILane",
    "DEFAULT_SUBSCRIPTION_BATCH_SIZE",
    "LANE_KINDS",
    "resolve_chain",
    "lane_from_legacy_settings",
    "parse_chain",
]

LANE_KINDS = ("subscription", "api_key", "local")

# Provider ids the subscription lane understands.
SUBSCRIPTION_PROVIDERS = ("claude_code", "codex")

# How many documents one execution may put through a subscription lane before
# it stands down.
#
# This is a guard rail rather than a technical limit. An agent CLI spends the
# same Claude Max or ChatGPT window the user does their own work in, so a
# 200-paper sweep routed through one is capable of exhausting the plan the user
# actually needs.
#
# **Fifty since 1.8.5, and the number moved because batching moved it.** At the
# default batch size of five, a measured paper costs 0.33× what it cost per
# document and 0.23× the input-side tokens — the constitution and the prompt
# scaffold are ~5.6k tokens paid once per call rather than once per paper. Fifty
# papers now spend rather less of the window than twenty-five did before
# batching existed.
#
# Not a hundred. Every real batched run in D3 came back one summary short of its
# batch, and each miss costs a re-send call; doubling is what the measurement
# supports, quadrupling is not.
#
# Reaching the cap is not a failure. The lane stands down, the chain carries on
# with the next lane, and execution_ai records that the cap was the reason.
DEFAULT_SUBSCRIPTION_DOC_CAP = 50

# How many documents one subscription-lane CLI call carries (1.8.5).
#
# One call per paper was the dominant cost of this lane: a process to start, a
# session to establish and the constitution to read, per abstract.
#
# **Five, not ten, and the number was measured rather than guessed.** Batching
# was expected to improve monotonically with size; it does not. Against the
# installed CLIs (``verification_scripts/measure_subscription_batching.py``,
# 2026-09-03):
#
#   claude, 25 real abstracts   per paper  5 -> 6.1s   10 -> 6.9s   25 -> 6.2s
#                               in band    5 -> 21/25  10 -> 19/25  25 -> 22/25
#   codex, 10 synthetic         per paper  5 -> 5.3s   10 -> 8.0s
#
# Ten was worse than five on both CLIs on speed, and worse on band compliance
# on the corpus that matters -- real abstracts. The one configuration where ten
# won was synthetic abstracts on claude, by a tenth of a second per paper.
#
# The reason batching stops paying is that it amortises the fixed cost of a
# call and cannot touch the generation itself, which is the same work whether
# it happens in one call or ten. Past a handful of documents there is little
# fixed cost left to spread.
#
# The number is a lane field rather than a constant so a slower machine, a
# stricter plan or a different CLI can change it without a release.
#
# Every other lane kind is 1 by construction. An HTTP request to an API-key
# provider has no fixed cost worth amortising, and batching there would trade a
# real accuracy risk -- several abstracts in one context -- for nothing.
DEFAULT_SUBSCRIPTION_BATCH_SIZE = 5

_PROVIDER_DISPLAY = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "google": "Google",
    "xai": "xAI",
    "meta": "Meta (Together)",
    "deepseek": "DeepSeek",
    "alibaba": "Alibaba",
    "custom": "Custom endpoint",
    "local": "Ollama",
    "claude_code": "Claude Code",
    "codex": "Codex",
}


@dataclass(frozen=True)
class AILane:
    """One way to reach a model.

    ``credential_alias`` is a keyring slot *name*. It is never a key value, and
    no field on this class ever holds one.
    """

    kind: str
    provider: str
    model: Optional[str] = None
    credential_alias: Optional[str] = None
    endpoint: Optional[str] = None        # local
    base_url: Optional[str] = None        # custom api_key provider
    binary_path: Optional[str] = None     # subscription
    doc_cap: Optional[int] = None         # subscription; None means uncapped
    batch_size: Optional[int] = None      # documents per call; 1 means no batching
    effort: Optional[str] = None          # subscription; the CLI's own effort level
    label: str = ""

    def __post_init__(self) -> None:
        if self.kind not in LANE_KINDS:
            raise ValueError(
                f"Unknown lane kind {self.kind!r}. Expected one of {', '.join(LANE_KINDS)}."
            )
        # A subscription lane is capped unless the user set their own number.
        # Defaulting here rather than at the call site means a lane built from
        # a hand-edited ai_chain, from the legacy settings, or straight from
        # the constructor all get the guard -- there is no path that produces
        # an uncapped subscription lane by omission.
        if self.kind == "subscription" and self.doc_cap is None:
            object.__setattr__(self, "doc_cap", DEFAULT_SUBSCRIPTION_DOC_CAP)
        # Batch size defaults the same way and for the same reason: a lane
        # built from a hand-edited chain, from the legacy settings or straight
        # from the constructor must not differ in how many documents one call
        # carries. Non-subscription lanes are pinned to 1 rather than left
        # unset, so "does this lane batch" is answerable without knowing the
        # kind.
        if self.batch_size is None:
            object.__setattr__(
                self, "batch_size",
                DEFAULT_SUBSCRIPTION_BATCH_SIZE if self.kind == "subscription" else 1,
            )
        if not self.label:
            # frozen dataclass — assign through object.__setattr__
            object.__setattr__(self, "label", describe_lane(self))

    def to_dict(self) -> dict:
        return asdict(self)


def describe_lane(lane: "AILane") -> str:
    """A short human label. This is what error reports and the UI name."""
    provider = _PROVIDER_DISPLAY.get(lane.provider, lane.provider or "unknown")
    if lane.model:
        return f"{provider} · {lane.model}"
    return provider


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------

def resolve_chain(settings: dict[str, Any]) -> list[AILane]:
    """Return the ordered lanes described by *settings*.

    Order of precedence:

    1. ``ai_chain`` — a JSON list of lane objects, once the user has built one.
    2. The legacy ``ai_provider`` / ``ai_model`` keys, as a **one-lane chain**.

    Returns ``[]`` when nothing is configured. An empty chain is not an error:
    "AI unconfigured" has always been a silent no-op branch and stays one.

    A malformed ``ai_chain`` falls back to the legacy keys rather than raising.
    A user should not lose AI entirely because one JSON blob got corrupted, and
    the fallback is the configuration they had before chains existed.
    """
    raw_chain = settings.get("ai_chain")
    if raw_chain:
        lanes = parse_chain(raw_chain)
        if lanes:
            return lanes
        logger.warning(
            "ai_chain present but no usable lanes parsed; "
            "falling back to the single-provider settings."
        )

    lane = lane_from_legacy_settings(settings)
    return [lane] if lane else []


def parse_chain(raw: Any) -> list[AILane]:
    """Parse ``ai_chain`` — a JSON string or an already-decoded list.

    Unusable entries are skipped with a warning rather than failing the whole
    chain: one bad lane should cost that lane, not the others.
    """
    if isinstance(raw, str):
        try:
            decoded = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            logger.warning("ai_chain is not valid JSON; ignoring it.")
            return []
    else:
        decoded = raw

    if not isinstance(decoded, list):
        logger.warning("ai_chain is not a list; ignoring it.")
        return []

    lanes: list[AILane] = []
    for index, entry in enumerate(decoded):
        lane = _lane_from_entry(entry, index)
        if lane is not None:
            lanes.append(lane)
    return lanes


def _lane_from_entry(entry: Any, index: int) -> Optional[AILane]:
    if not isinstance(entry, dict):
        logger.warning("ai_chain[%d] is not an object; skipping.", index)
        return None

    kind = str(entry.get("kind") or "").strip().lower()
    provider = str(entry.get("provider") or "").strip().lower()
    if kind not in LANE_KINDS:
        logger.warning("ai_chain[%d] has unknown kind %r; skipping.", index, kind)
        return None
    if not provider:
        logger.warning("ai_chain[%d] has no provider; skipping.", index)
        return None

    def _opt(name: str) -> Optional[str]:
        value = entry.get(name)
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    # A cap that will not parse, or that is zero or negative, falls back to the
    # default rather than being honoured. "0" would read as "no documents at
    # all", which nobody means by it, and a corrupt value must not be the thing
    # that removes the guard.
    doc_cap: Optional[int] = None
    raw_cap = entry.get("doc_cap")
    if raw_cap is not None:
        try:
            parsed = int(raw_cap)
        except (TypeError, ValueError):
            logger.warning(
                "ai_chain[%d] has a non-numeric doc_cap %r; using the default.",
                index, raw_cap,
            )
        else:
            if parsed > 0:
                doc_cap = parsed
            else:
                logger.warning(
                    "ai_chain[%d] has doc_cap %d; using the default.", index, parsed,
                )

    # A batch size that will not parse, or that is zero or negative, falls
    # back to the default. Unlike doc_cap this is not a guard rail -- a wrong
    # value costs speed, not the user's plan -- but silently running batches of
    # -3 would be worse than either.
    batch_size: Optional[int] = None
    raw_batch = entry.get("batch_size")
    if raw_batch is not None:
        try:
            parsed_batch = int(raw_batch)
        except (TypeError, ValueError):
            logger.warning(
                "ai_chain[%d] has a non-numeric batch_size %r; using the default.",
                index, raw_batch,
            )
        else:
            if parsed_batch > 0:
                batch_size = parsed_batch
            else:
                logger.warning(
                    "ai_chain[%d] has batch_size %d; using the default.",
                    index, parsed_batch,
                )

    try:
        return AILane(
            kind=kind,
            provider=provider,
            model=_opt("model"),
            credential_alias=_opt("credential_alias"),
            endpoint=_opt("endpoint"),
            base_url=_opt("base_url"),
            binary_path=_opt("binary_path"),
            doc_cap=doc_cap,
            batch_size=batch_size,
            effort=_opt("effort"),
            label=_opt("label") or "",
        )
    except ValueError as exc:  # pragma: no cover - kind already validated
        logger.warning("ai_chain[%d] rejected: %s", index, exc)
        return None


def lane_from_legacy_settings(settings: dict[str, Any]) -> Optional[AILane]:
    """Build the single lane implied by the pre-1.8 ``ai_*`` settings.

    This is the whole backward-compatibility story: existing configuration is
    read as a one-lane chain at load time. Nothing is written, so downgrading
    to an earlier build keeps working too.
    """
    provider = str(settings.get("ai_provider") or "").strip().lower()
    if not provider:
        return None

    if provider == "local":
        model = (
            str(settings.get("ai_local_model") or "").strip()
            or str(settings.get("ai_model") or "").strip()
            or None
        )
        endpoint = str(settings.get("ai_local_endpoint") or "").strip() or None
        return AILane(kind="local", provider="local", model=model, endpoint=endpoint)

    if provider in SUBSCRIPTION_PROVIDERS:
        raw_cap = settings.get("ai_subscription_doc_cap")
        doc_cap: Optional[int] = None
        if raw_cap is not None:
            try:
                parsed = int(raw_cap)
            except (TypeError, ValueError):
                parsed = 0
            if parsed > 0:
                doc_cap = parsed
        return AILane(
            kind="subscription",
            provider=provider,
            model=str(settings.get("ai_model") or "").strip() or None,
            binary_path=str(settings.get("ai_cli_path") or "").strip() or None,
            doc_cap=doc_cap,
            effort=str(settings.get("ai_effort") or "").strip() or None,
        )

    return AILane(
        kind="api_key",
        provider=provider,
        model=str(settings.get("ai_model") or "").strip() or None,
        credential_alias=credential_alias_for(provider),
        base_url=str(settings.get("ai_custom_base_url") or "").strip() or None,
    )


def credential_alias_for(provider: str) -> Optional[str]:
    """The keyring slot a BYOK provider reads from. A name, never a value."""
    provider = (provider or "").strip().lower()
    if not provider or provider == "local":
        return None
    if provider in SUBSCRIPTION_PROVIDERS:
        return None
    if provider == "custom":
        return "custom_llm_api_key"
    return f"{provider}_api_key"


def chain_to_json(lanes: Iterable[AILane]) -> str:
    """Serialize lanes for storage in ``app_settings['ai_chain']``."""
    return json.dumps([lane.to_dict() for lane in lanes])
