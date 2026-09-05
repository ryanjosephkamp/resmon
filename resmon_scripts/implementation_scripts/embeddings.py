# resmon_scripts/implementation_scripts/embeddings.py
"""The embedding lane: one model, one route, no chain.

Why this is not an ``AILane``
-----------------------------
A summary chain tries lane two when lane one fails, because two models produce
different prose and either is a usable summary. **Embeddings do not work that
way.** Two models produce vectors in unrelated spaces, and a corpus half embedded
by one and half by another is not a degraded index — it is a confidently wrong
one, ranking papers by an axis that means nothing. So an embedding lane is
single, has no fallback, and the model is recorded on every row it writes
(``document_embeddings.model``) so a mixture is detectable rather than silent.

What can actually embed
-----------------------
:data:`PROVIDER_EMBEDDING` answers *can this provider embed* for **every**
provider resmon lists, and each answer carries the evidence it rests on. Three
states, not two, because two would force a guess:

``yes``       the endpoint exists; resmon will offer the provider.
``no``        it does not; the lane is refused **at configuration**, with the
              sentence, rather than at backfill after the user has waited.
``unknown``   resmon could not establish it from outside. The provider is
              offered, the interface says the probe will settle it, and the
              probe does.

The evidence is a live observation, not a recollection. Each `yes` and `no` below
was established on 2026-09-05 by asking the provider's own API, with a **control
request to a path that cannot exist** — because an auth check that runs before
routing answers 401 for everything, and without the control a 401 on
``/embeddings`` would prove nothing. DeepSeek is `unknown` for exactly that
reason: it answered 401 for the control too.

The Ollama trap
---------------
The endpoint on the developer machine this was written against listed two models
on ``/api/tags`` and refused ``/api/embed`` with

    {"error": "This server does not support embeddings. Start it with `--embeddings`"}

which is llama.cpp's wording, passed through by Ollama 0.33.2 because the loaded
model is a chat model. **An endpoint that lists models may still refuse to
embed**, and the refusal must read as "this server cannot embed" — never as a
corpus with nothing in it to rank. :data:`CANNOT_EMBED_MARKERS` names that body
and :func:`probe_lane` turns it into a sentence a user can act on.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, asdict
from typing import Any, Optional, Sequence

import httpx

from .ai_errors import classify_exception

logger = logging.getLogger(__name__)

__all__ = [
    "CANNOT_EMBED_MARKERS",
    "DEFAULT_LOCAL_ENDPOINT",
    "EMBEDDING_SETTING_KEYS",
    "EmbeddingLane",
    "PROVIDER_EMBEDDING",
    "ProviderEmbedding",
    "build_lane",
    "build_text",
    "can_embed",
    "embed_texts",
    "estimate_cost",
    "probe_lane",
    "suggested_models",
]

DEFAULT_LOCAL_ENDPOINT = "http://localhost:11434"

# How many texts go in one request. Unlike the summary lane's batch size this is
# not a measured trade: an embedding request has no generation step, so the whole
# cost is transport and the only ceiling is the provider's own request limit.
# Thirty-two is comfortably under every documented one and keeps a single failed
# request cheap to retry.
DEFAULT_BATCH_SIZE = 32

# A vector this wide is not a vector. Guards against a misconfigured `custom`
# endpoint returning something enormous and the app trying to store it per paper.
MAX_DIMS = 8192


# ---------------------------------------------------------------------------
# Can this provider embed?
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProviderEmbedding:
    """One provider's answer, and what the answer rests on."""

    state: str  # "yes" | "no" | "unknown"
    reason: str  # rendered to the user, verbatim
    evidence: str  # how it was established; for the handback and the docstring reader
    path: Optional[str] = None  # appended to the provider's base URL
    default_model: Optional[str] = None

    @property
    def offered(self) -> bool:
        """Whether Settings offers this provider as an embedding lane at all."""
        return self.state in ("yes", "unknown")


_PROBED_ON = "2026-09-05"

# Every provider resmon lists. The denominator for P8 is this table checked
# against ``llm_remote._SUPPORTED_PROVIDERS`` plus ``local`` plus
# ``ai_lanes.SUBSCRIPTION_PROVIDERS``; ``test_embeddings.py`` fails if any of
# those has no row here, so a provider cannot be added without an answer.
#
# **The brief's P8 denominator named ``_PROVIDER_SPECS`` + anthropic + local +
# custom, which omits ``google``.** Google is in ``_SUPPORTED_PROVIDERS`` and has
# its own request path in ``llm_remote``; it is a provider a user can select, so
# it needs an answer like the rest. It has one, and it is `yes`.
PROVIDER_EMBEDDING: dict[str, ProviderEmbedding] = {
    "openai": ProviderEmbedding(
        state="yes",
        reason="OpenAI serves embeddings.",
        evidence=(
            f"{_PROBED_ON}: POST https://api.openai.com/v1/embeddings with an invalid key "
            "answered 401 'Incorrect API key provided'; the control POST to "
            "/v1/definitely-not-a-route-xyzzy with the same key answered 404. The route exists."
        ),
        path="/embeddings",
        default_model="text-embedding-3-small",
    ),
    "google": ProviderEmbedding(
        state="yes",
        reason="Google serves embeddings.",
        evidence=(
            f"{_PROBED_ON}: POST .../v1beta/models/gemini-embedding-001:embedContent with an "
            "invalid key answered 400 'API key not valid' — the same answer as the known-good "
            ":generateContent — while the control :xyzzyNotAMethod answered 404. Both "
            ":embedContent and :batchEmbedContents exist."
        ),
        path=":embedContent",
        default_model="gemini-embedding-001",
    ),
    "xai": ProviderEmbedding(
        state="yes",
        reason="xAI serves embeddings.",
        evidence=(
            f"{_PROBED_ON}: POST https://api.x.ai/v1/embeddings with an invalid key answered 400 "
            "'Incorrect API key provided'; the control answered 404 'The requested resource was "
            "not found'. The route exists."
        ),
        path="/embeddings",
        default_model=None,
    ),
    "meta": ProviderEmbedding(
        state="yes",
        reason="Together serves embeddings.",
        evidence=(
            f"{_PROBED_ON}: POST https://api.together.xyz/v1/embeddings with an invalid key "
            "answered 401 'Invalid API key provided'; the control answered 404. The route exists."
        ),
        path="/embeddings",
        default_model="BAAI/bge-large-en-v1.5",
    ),
    "alibaba": ProviderEmbedding(
        state="yes",
        reason="Alibaba Model Studio serves embeddings.",
        evidence=(
            f"{_PROBED_ON}: POST .../compatible-mode/v1/embeddings with an invalid key answered "
            "401 'Incorrect API key provided'; the control answered 404. The route exists."
        ),
        path="/embeddings",
        default_model="text-embedding-v3",
    ),
    "deepseek": ProviderEmbedding(
        state="unknown",
        reason=(
            "resmon could not establish whether DeepSeek serves embeddings. Its API answers "
            "401 for any path without a valid key — including paths that do not exist — so "
            "there is nothing to observe from outside. Enter a key and probe: the probe will "
            "give a definite answer."
        ),
        evidence=(
            f"{_PROBED_ON}: POST https://api.deepseek.com/v1/embeddings answered 401, and so did "
            "the control POST to /v1/definitely-not-a-route-xyzzy. Authentication precedes "
            "routing, so the 401 is not evidence that the route exists. Recording 'yes' here "
            "would be a guess wearing a citation."
        ),
        path="/embeddings",
        default_model=None,
    ),
    "anthropic": ProviderEmbedding(
        state="no",
        reason=(
            "Anthropic does not offer an embeddings API. An Anthropic key cannot embed, "
            "whatever it can do for summaries — pick a different provider, or use a local "
            "model, for semantic search."
        ),
        evidence=(
            f"{_PROBED_ON}, two independent observations. (1) POST "
            "https://api.anthropic.com/v1/embeddings answered 404 not_found_error, while the "
            "control POST to the known-good /v1/messages answered 401 authentication_error — so "
            "the 404 is the route's absence, not the key's. (2) The official SDK pinned in "
            "requirements.txt (anthropic 0.95.0) exposes messages, completions, models and beta, "
            "and no embeddings resource."
        ),
    ),
    "custom": ProviderEmbedding(
        state="unknown",
        reason=(
            "resmon cannot know in advance what a custom endpoint serves. It will be called "
            "at {base_url}/embeddings in the OpenAI-compatible shape; probe it to find out."
        ),
        evidence="Not knowable in advance: the base URL is the user's.",
        path="/embeddings",
        default_model=None,
    ),
    "local": ProviderEmbedding(
        state="yes",
        reason=(
            "Ollama serves embeddings, but only for a model that can embed. A chat model "
            "refuses, and the refusal is reported as such."
        ),
        evidence=(
            f"{_PROBED_ON}: POST http://127.0.0.1:11434/api/embed to Ollama 0.33.2 with "
            "nomic-embed-text returned 2 embeddings of 768 floats for a 2-string input. The same "
            "endpoint with the machine's chat models (gemma4:12b, gemma4:e2b) answered "
            "{\"error\": \"This server does not support embeddings. Start it with "
            "`--embeddings`\"} — see CANNOT_EMBED_MARKERS."
        ),
        path="/api/embed",
        default_model="nomic-embed-text",
    ),
    "claude_code": ProviderEmbedding(
        state="no",
        reason=(
            "The Claude Code CLI cannot produce embeddings — it has no command for it. "
            "The subscription that covers your summaries does not cover semantic search."
        ),
        evidence=(
            f"{_PROBED_ON}: `claude --help` (2.1.258) contains no occurrence of 'embed' and "
            "offers no embedding command."
        ),
    ),
    "codex": ProviderEmbedding(
        state="no",
        reason=(
            "The Codex CLI cannot produce embeddings — it has no command for it. "
            "The subscription that covers your summaries does not cover semantic search."
        ),
        evidence=(
            f"{_PROBED_ON}: `codex --help` (codex-cli 0.142.3, the binary bundled in the VS Code "
            "extension) contains no occurrence of 'embed'; its subcommand list — exec, review, "
            "login, logout, mcp, plugin, mcp-server, app-server, remote-control, app, completion, "
            "update, doctor, sandbox, debug, apply, resume, archive, delete, unarchive, fork, "
            "cloud, exec-server, features, help — has no embedding command."
        ),
    ),
}


def can_embed(provider: str) -> ProviderEmbedding:
    """The embedding answer for *provider*.

    An unknown provider gets an ``unknown`` answer rather than a crash or a
    hopeful ``yes``: a provider added to ``llm_remote`` and not to the table
    above must not silently inherit a capability nobody checked. The test suite
    fails on that gap; the runtime degrades to "probe it".
    """
    known = PROVIDER_EMBEDDING.get((provider or "").strip().lower())
    if known is not None:
        return known
    return ProviderEmbedding(
        state="unknown",
        reason=(
            f"resmon has no recorded answer for whether {provider!r} serves embeddings. "
            "Probe it to find out."
        ),
        evidence="No row in PROVIDER_EMBEDDING.",
        path="/embeddings",
    )


def suggested_models(provider: str) -> list[str]:
    """Models resmon proposes for *provider*. Suggestions, never a closed list.

    A user may type any model name; these are the ones the interface offers
    first. For ``local`` they are the two the brief named as candidates, and the
    Settings tab replaces them with what the machine actually has once
    ``/api/tags`` answers.
    """
    provider = (provider or "").strip().lower()
    if provider == "local":
        return ["nomic-embed-text", "all-minilm", "mxbai-embed-large"]
    if provider == "openai":
        return ["text-embedding-3-small", "text-embedding-3-large"]
    if provider == "google":
        return ["gemini-embedding-001", "text-embedding-004"]
    if provider == "meta":
        return ["BAAI/bge-large-en-v1.5", "BAAI/bge-base-en-v1.5"]
    if provider == "alibaba":
        return ["text-embedding-v3"]
    return []


# ---------------------------------------------------------------------------
# The lane
# ---------------------------------------------------------------------------

EMBEDDING_LANE_KINDS = ("local", "api_key")


@dataclass(frozen=True)
class EmbeddingLane:
    """One route to an embedding model. Single by construction — no chain.

    ``credential_alias`` is a keyring slot *name*. No field here ever holds a key
    value, in the same way ``AILane`` does not.
    """

    kind: str
    provider: str
    model: str
    endpoint: Optional[str] = None  # local
    base_url: Optional[str] = None  # custom api_key provider
    credential_alias: Optional[str] = None
    batch_size: int = DEFAULT_BATCH_SIZE
    # Discovered by ``probe_lane`` and persisted, so the interface can say how
    # wide the vectors are before a backfill starts rather than after.
    dims: Optional[int] = None
    # The model's own input ceiling, in tokens, where resmon has one to record.
    input_limit: Optional[int] = None

    def __post_init__(self) -> None:
        if self.kind not in EMBEDDING_LANE_KINDS:
            raise ValueError(
                f"Unknown embedding lane kind {self.kind!r}. "
                f"Expected one of {', '.join(EMBEDDING_LANE_KINDS)}."
            )
        if not self.model:
            raise ValueError("An embedding lane needs a model; there is no default to fall to.")
        if self.batch_size is None or int(self.batch_size) < 1:
            object.__setattr__(self, "batch_size", DEFAULT_BATCH_SIZE)

    def to_dict(self) -> dict:
        return asdict(self)


# The settings keys this feature owns. They ride in **both**
# ``_SETTINGS_GROUPS["embeddings"]`` (so a PUT stores them) and the engine
# loader's read list (so a run sees them). Ledger 33 was precisely the omission
# of the second, and it cost the whole subscription lane its configuration.
EMBEDDING_SETTING_KEYS: tuple[str, ...] = (
    "embedding_enabled",
    "embedding_provider",
    "embedding_model",
    "embedding_endpoint",
    "embedding_base_url",
    "embedding_batch_size",
    "embedding_dims",
    "embedding_input_limit",
)


def build_lane(settings: dict[str, Any]) -> Optional[EmbeddingLane]:
    """Resolve the configured embedding lane, or ``None`` when there is none.

    ``None`` is not an error. "No embedding lane" is the state every install
    starts in and a large fraction will stay in, and every caller treats it as
    "this feature is off" rather than as a failure.

    A lane is **not** built for a provider whose recorded answer is ``no``. That
    is the configuration-time refusal P8 asks for: a user who picked Anthropic
    is told when they pick it, not after a backfill has run and produced nothing.
    """
    if str(settings.get("embedding_enabled") or "").strip().lower() not in ("1", "true", "yes"):
        return None

    provider = str(settings.get("embedding_provider") or "").strip().lower()
    if not provider:
        return None

    capability = can_embed(provider)
    if capability.state == "no":
        logger.warning(
            "Embedding lane not built: provider %r cannot embed. %s", provider, capability.reason
        )
        return None

    model = str(settings.get("embedding_model") or "").strip() or (
        capability.default_model or ""
    )
    if not model:
        return None

    def _int(key: str) -> Optional[int]:
        raw = settings.get(key)
        if raw in (None, ""):
            return None
        try:
            value = int(raw)
        except (TypeError, ValueError):
            logger.warning("%s is not a number (%r); ignoring it.", key, raw)
            return None
        return value if value > 0 else None

    if provider == "local":
        return EmbeddingLane(
            kind="local",
            provider="local",
            model=model,
            endpoint=str(settings.get("embedding_endpoint") or "").strip()
            or DEFAULT_LOCAL_ENDPOINT,
            batch_size=_int("embedding_batch_size") or DEFAULT_BATCH_SIZE,
            dims=_int("embedding_dims"),
            input_limit=_int("embedding_input_limit"),
        )

    return EmbeddingLane(
        kind="api_key",
        provider=provider,
        model=model,
        base_url=str(settings.get("embedding_base_url") or "").strip() or None,
        credential_alias=_credential_alias_for(provider),
        batch_size=_int("embedding_batch_size") or DEFAULT_BATCH_SIZE,
        dims=_int("embedding_dims"),
        input_limit=_int("embedding_input_limit"),
    )


def _credential_alias_for(provider: str) -> Optional[str]:
    """The keyring slot an embedding lane reads. A name, never a value.

    Deliberately the **same slot** the summary lane uses. A user with an OpenAI
    key has one OpenAI key, and asking them to enter it twice under two names
    would be a worse product and a second thing to leak.
    """
    from .ai_lanes import credential_alias_for

    return credential_alias_for(provider)


# ---------------------------------------------------------------------------
# The text that gets embedded
# ---------------------------------------------------------------------------

# ~4 characters per token, the same heuristic ``summarizer.py`` falls back to.
# Used here as the *only* estimator rather than as a fallback: tiktoken fetches
# its vocabulary over the network on first use, and an embedding run must not
# depend on that. It is an over-estimate for English prose, which is the safe
# direction for a truncation bound.
_CHARS_PER_TOKEN = 4

# Where resmon has no number from the model, assume a small window. Truncating
# text a model would have accepted costs a little recall; overflowing a model's
# window is an error per document, and on some providers a charge for it.
_ASSUMED_INPUT_LIMIT_TOKENS = 512


def build_text(
    title: Optional[str], abstract: Optional[str], input_limit: Optional[int] = None
) -> tuple[str, str]:
    """Return ``(text, fields)`` — what to embed, and what actually went in.

    ``fields`` is stored on the row. "title+abstract" and "title" are different
    vectors of different quality, and a paper whose source's terms did not let
    resmon keep the abstract gets the second. Recording which is the difference
    between a corpus that knows its own coverage and one that assumes it.

    The title is never truncated away: where the budget is too small for both,
    the abstract is cut and the title survives whole. A vector built from half an
    abstract and no title is worse than one built from a title.
    """
    title_text = (title or "").strip()
    abstract_text = (abstract or "").strip()
    budget_chars = (input_limit or _ASSUMED_INPUT_LIMIT_TOKENS) * _CHARS_PER_TOKEN

    if not abstract_text:
        return title_text[:budget_chars], "title"
    if not title_text:
        return abstract_text[:budget_chars], "abstract"

    joined = f"{title_text}\n\n{abstract_text}"
    if len(joined) <= budget_chars:
        return joined, "title+abstract"

    remaining = budget_chars - len(title_text) - 2
    if remaining <= 0:
        return title_text[:budget_chars], "title"
    return f"{title_text}\n\n{abstract_text[:remaining]}", "title+abstract(truncated)"


def estimate_tokens(text: str) -> int:
    """A deliberately rough, network-free token estimate. See ``_CHARS_PER_TOKEN``."""
    return max(1, len(text or "") // _CHARS_PER_TOKEN)


# Published prices per million input tokens, recorded with the date they were
# read so a stale number is visible as stale rather than presented as current.
# A provider with no entry produces an estimate of ``None`` — "resmon does not
# know what this will cost" — never a zero, which would read as "free".
_PRICE_PER_MILLION_TOKENS: dict[tuple[str, str], float] = {
    ("openai", "text-embedding-3-small"): 0.02,
    ("openai", "text-embedding-3-large"): 0.13,
}
_PRICES_READ_ON = "2026-09-05"


def estimate_cost(lane: EmbeddingLane, texts: Sequence[str]) -> dict:
    """What a backfill will cost, before it starts. ``None`` where resmon cannot say.

    A local lane costs nothing and says so. An API-key lane with no price on
    record reports the token count and ``cost_usd: None`` — the user gets the
    number resmon actually has, and is told the other one is missing, rather
    than a confident zero.
    """
    tokens = sum(estimate_tokens(t) for t in texts)
    if lane.kind == "local":
        return {
            "documents": len(texts),
            "estimated_tokens": tokens,
            "cost_usd": 0.0,
            "note": "A local model runs on your machine and costs nothing to call.",
        }
    price = _PRICE_PER_MILLION_TOKENS.get((lane.provider, lane.model))
    if price is None:
        return {
            "documents": len(texts),
            "estimated_tokens": tokens,
            "cost_usd": None,
            "note": (
                f"resmon has no price on record for {lane.provider} / {lane.model}, so it "
                "cannot estimate the cost. The token figure above is an estimate at roughly "
                "four characters per token; check your provider's pricing page."
            ),
        }
    return {
        "documents": len(texts),
        "estimated_tokens": tokens,
        "cost_usd": round(tokens / 1_000_000 * price, 4),
        "note": (
            f"At {price} USD per million input tokens, the price published for "
            f"{lane.model} as read on {_PRICES_READ_ON}. Tokens are estimated at roughly "
            "four characters each, so treat this as an order of magnitude."
        ),
    }


# ---------------------------------------------------------------------------
# Calling the model
# ---------------------------------------------------------------------------

# The body Ollama returns when the loaded model cannot embed. It is llama.cpp's
# wording, passed through, and it is the difference between "this server cannot
# embed" and "there was nothing to rank". Matched on the distinctive phrase
# rather than the whole string so a wording change does not silently turn a
# capability answer back into a generic failure.
CANNOT_EMBED_MARKERS = (
    "does not support embeddings",
    "does not support embedding",
    "embedding not supported",
    "not an embedding model",
)


class EmbeddingUnavailable(RuntimeError):
    """The lane cannot embed, and the reason is a sentence for a person.

    Distinct from a transport failure on purpose. A server that is down should be
    retried; a chat model asked to embed should not be, and telling the two apart
    is the whole of P9.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _is_cannot_embed(body: str) -> bool:
    lowered = (body or "").lower()
    return any(marker in lowered for marker in CANNOT_EMBED_MARKERS)


def _local_endpoint(lane: EmbeddingLane) -> str:
    return (lane.endpoint or DEFAULT_LOCAL_ENDPOINT).rstrip("/")


def _api_base(lane: EmbeddingLane) -> str:
    if lane.provider == "custom":
        if not lane.base_url:
            raise EmbeddingUnavailable(
                "A custom embedding endpoint needs a base URL, and none is configured."
            )
        return lane.base_url.rstrip("/")
    if lane.provider == "google":
        return "https://generativelanguage.googleapis.com/v1beta"
    from .llm_remote import _PROVIDER_SPECS

    spec = _PROVIDER_SPECS.get(lane.provider)
    if spec is None:
        raise EmbeddingUnavailable(
            f"resmon has no endpoint on record for {lane.provider!r}."
        )
    return spec.base_url.rstrip("/")


def _read_api_key(lane: EmbeddingLane) -> str:
    from .credential_manager import get_credential

    if not lane.credential_alias:
        raise EmbeddingUnavailable(
            f"resmon does not know which key {lane.provider!r} should use."
        )
    key = get_credential(lane.credential_alias)
    if not key:
        raise EmbeddingUnavailable(
            f"No API key is stored for {lane.provider}. Add one in Settings → AI, "
            "then probe the lane again."
        )
    return key


def embed_texts(lane: EmbeddingLane, texts: Sequence[str]) -> list[list[float]]:
    """Embed *texts* through *lane*, in order. One vector per text, always.

    Raises :class:`EmbeddingUnavailable` when the lane cannot embed at all — a
    chat model, a missing key, a provider with no endpoint — and an
    :class:`~.ai_errors.AIError` for a transport failure, which the caller may
    retry. Those are different conditions and the caller acts differently on
    them, so they are different exceptions.

    **Order and count are part of the contract.** A ranking built from vectors
    silently reordered against their documents is not detectably wrong, it is
    just wrong, so a response whose length does not match the request is a
    failure rather than a partial success.
    """
    if not texts:
        return []
    out: list[list[float]] = []
    batch = max(1, int(lane.batch_size or DEFAULT_BATCH_SIZE))
    for start in range(0, len(texts), batch):
        slice_ = list(texts[start : start + batch])
        vectors = _embed_batch(lane, slice_)
        if len(vectors) != len(slice_):
            raise EmbeddingUnavailable(
                f"{lane.provider} returned {len(vectors)} vectors for {len(slice_)} texts. "
                "resmon will not guess which vector belongs to which paper."
            )
        out.extend(vectors)
    return out


def _embed_batch(lane: EmbeddingLane, texts: list[str]) -> list[list[float]]:
    if lane.kind == "local":
        return _embed_local(lane, texts)
    if lane.provider == "google":
        return _embed_google(lane, texts)
    return _embed_openai_compatible(lane, texts)


def _embed_local(lane: EmbeddingLane, texts: list[str]) -> list[list[float]]:
    url = f"{_local_endpoint(lane)}/api/embed"
    try:
        with httpx.Client(timeout=300) as client:
            response = client.post(url, json={"model": lane.model, "input": texts})
    except Exception as exc:
        raise classify_exception(exc, provider="local", model=lane.model) from None

    if response.status_code >= 400 or _is_cannot_embed(response.text):
        # Ollama answers the "I cannot embed" case with HTTP 200 in some
        # versions and 4xx in others, so the body is checked either way. The
        # marker test comes first because a server that says it cannot embed has
        # answered the question, whatever status it attached.
        if _is_cannot_embed(response.text):
            raise EmbeddingUnavailable(
                f"The server at {_local_endpoint(lane)} cannot produce embeddings with "
                f"{lane.model!r} — it answered: {_first_error(response.text)}. "
                "That is a chat model, not an embedding model. Pull an embedding model "
                "(for example `ollama pull nomic-embed-text`) and select it here."
            )
        raise EmbeddingUnavailable(
            f"The server at {_local_endpoint(lane)} answered HTTP {response.status_code}: "
            f"{_first_error(response.text)}"
        )

    payload = response.json()
    vectors = payload.get("embeddings")
    if vectors is None and payload.get("embedding") is not None:
        # The pre-0.3 single-input route. Kept because a user may be pointing at
        # an older Ollama, and one vector back for one text in is unambiguous.
        vectors = [payload["embedding"]]
    if not isinstance(vectors, list):
        raise EmbeddingUnavailable(
            f"The server at {_local_endpoint(lane)} answered without an 'embeddings' field. "
            "It may be Ollama-compatible for listing models without being so for embedding."
        )
    return [_validated(v) for v in vectors]


def _embed_openai_compatible(lane: EmbeddingLane, texts: list[str]) -> list[list[float]]:
    capability = can_embed(lane.provider)
    url = f"{_api_base(lane)}{capability.path or '/embeddings'}"
    key = _read_api_key(lane)
    try:
        with httpx.Client(timeout=300) as client:
            response = client.post(
                url,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"model": lane.model, "input": texts},
            )
    except Exception as exc:
        raise classify_exception(exc, provider=lane.provider, model=lane.model) from None

    if response.status_code == 404:
        # The provider's answer to "do you serve this route", now with a real
        # key behind it. This is the case ``unknown`` exists for.
        raise EmbeddingUnavailable(
            f"{lane.provider} answered 404 at {url}: it does not serve an embeddings endpoint "
            "there. Pick another provider for semantic search."
        )
    if response.status_code >= 400:
        raise EmbeddingUnavailable(
            f"{lane.provider} answered HTTP {response.status_code} at {url}: "
            f"{_first_error(response.text)}"
        )

    data = response.json().get("data")
    if not isinstance(data, list):
        raise EmbeddingUnavailable(
            f"{lane.provider} answered without a 'data' array; this endpoint is not "
            "OpenAI-compatible for embeddings."
        )
    # Sorted by the index the provider assigned rather than by arrival, because
    # the OpenAI shape permits reordering and a silently reordered batch is a
    # corpus ranked against the wrong papers.
    ordered = sorted(data, key=lambda row: int(row.get("index", 0)))
    return [_validated(row.get("embedding")) for row in ordered]


def _embed_google(lane: EmbeddingLane, texts: list[str]) -> list[list[float]]:
    base = _api_base(lane)
    key = _read_api_key(lane)
    url = f"{base}/models/{lane.model}:batchEmbedContents"
    body = {
        "requests": [
            {"model": f"models/{lane.model}", "content": {"parts": [{"text": text}]}}
            for text in texts
        ]
    }
    try:
        with httpx.Client(timeout=300) as client:
            response = client.post(
                url,
                headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                json=body,
            )
    except Exception as exc:
        raise classify_exception(exc, provider="google", model=lane.model) from None

    if response.status_code >= 400:
        raise EmbeddingUnavailable(
            f"Google answered HTTP {response.status_code} at {url}: {_first_error(response.text)}"
        )
    embeddings = response.json().get("embeddings")
    if not isinstance(embeddings, list):
        raise EmbeddingUnavailable("Google answered without an 'embeddings' array.")
    return [_validated(row.get("values")) for row in embeddings]


def _validated(vector: Any) -> list[float]:
    if not isinstance(vector, list) or not vector:
        raise EmbeddingUnavailable(
            "The provider returned something that is not a vector for at least one text."
        )
    if len(vector) > MAX_DIMS:
        raise EmbeddingUnavailable(
            f"The provider returned a {len(vector)}-dimensional vector, beyond the "
            f"{MAX_DIMS} resmon will store. Check the model name."
        )
    try:
        return [float(value) for value in vector]
    except (TypeError, ValueError):
        raise EmbeddingUnavailable(
            "The provider returned a vector containing values that are not numbers."
        ) from None


def _first_error(body: str) -> str:
    """A short, quotable fragment of an error body — for a sentence, not a log."""
    text = (body or "").strip()
    match = re.search(r'"(?:message|error)"\s*:\s*"([^"]{1,300})"', text)
    if match:
        return match.group(1)
    collapsed = " ".join(text.split())
    return collapsed[:300] if collapsed else "(an empty response)"


# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------

_PROBE_TEXT = "resmon embedding probe"


def probe_lane(lane: Optional[EmbeddingLane]) -> dict:
    """Ask the lane to embed one short string. Returns ``{ok, dims, model, reason}``.

    This is the only thing that turns a *claim* about a provider into a fact
    about this user's setup. ``PROVIDER_EMBEDDING`` says what the vendor serves;
    a probe says whether this key, this endpoint and this model actually answer —
    and for ``local`` that distinction is the whole feature, because the server
    is up, lists models, and still refuses.

    Never raises. A probe that threw would be a probe the Settings page had to
    wrap, and the reason is the product of the call.
    """
    if lane is None:
        return {
            "ok": False,
            "dims": None,
            "model": None,
            "reason": "No embedding lane is configured.",
        }

    capability = can_embed(lane.provider)
    if capability.state == "no":
        return {
            "ok": False,
            "dims": None,
            "model": lane.model,
            "reason": capability.reason,
        }

    try:
        vectors = embed_texts(lane, [_PROBE_TEXT])
    except EmbeddingUnavailable as exc:
        return {"ok": False, "dims": None, "model": lane.model, "reason": exc.reason}
    except Exception as exc:
        message = getattr(exc, "message", None) or str(exc)
        return {
            "ok": False,
            "dims": None,
            "model": lane.model,
            "reason": f"The embedding call failed: {message}",
        }

    if not vectors:
        return {
            "ok": False,
            "dims": None,
            "model": lane.model,
            "reason": "The provider accepted the request and returned no vector.",
        }
    dims = len(vectors[0])
    return {
        "ok": True,
        "dims": dims,
        "model": lane.model,
        "reason": f"{lane.model} answered with a {dims}-dimensional vector.",
    }
