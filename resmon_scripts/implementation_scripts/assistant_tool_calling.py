"""Which providers can be asked to call a tool, and which resmon actually asks.

The parallel document is ``embeddings.PROVIDER_EMBEDDING`` and the parallel rule
is its rule: **every provider resmon lists gets an answer, and an answer resmon
could not establish says so rather than guessing.** ``test_assistant_tool_calling``
fails when a provider appears in any of resmon's provider lists without a row
here, so the surface cannot grow an unanswered corner.

Two facts per provider, deliberately separated, because conflating them is how a
capability table starts lying:

* ``state`` — does the *provider* support tool calling? A fact about someone
  else's API.
* ``assistant`` — can *resmon's assistant* use it? A fact about this codebase,
  and it is sometimes "no" for a provider whose answer above is "yes".

The second is the one a user needs and the first is the one that is true
independently of resmon, so a provider whose API grows tool calling does not
silently become "resmon supports it" and a provider resmon has not got round to
does not read as "it cannot be done".

## How each answer was established

The probe is the same shape ``embeddings`` used: send the field under test, send
a **nonsense** field as a control, and compare. A server that validates the body
before authenticating discriminates; one that authenticates first answers 401 to
everything and establishes nothing — which is not a failure of the probe, it is
the answer being unavailable from outside, and the row then says ``unknown``.

Run 2026-09-06 against every OpenAI-compatible endpoint in
``llm_remote._PROVIDER_SPECS`` plus Google, with an invalid key throughout:

| Provider | `tools` malformed | control | Discriminates? |
|---|---|---|---|
| xAI | 422 *"tools: invalid type: string, expected a sequence"* | 400 *"Model not found"* | **yes** |
| Google | 400 *"Invalid value at 'tools' (…v1beta.Tool)"* | 400 *"Unknown name … Cannot find field"* | **yes** |
| OpenAI | 401 | 401 | no |
| Together (meta) | 401 | 401 | no |
| DeepSeek | 401 | 401 | no |
| Alibaba | 401 | 401 | no |

OpenAI and Anthropic are established from the **pinned SDKs** instead, which is
better evidence than a probe and is checkable offline:
``test_assistant_tool_calling`` reads the installed signatures rather than
trusting this comment.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

__all__ = [
    "FAMILIES",
    "PROVIDER_TOOL_CALLING",
    "ProviderToolCalling",
    "tool_calling",
]

# The request shapes resmon's own loop knows how to build. Three, because
# ``google`` is neither: Gemini takes ``function_declarations`` inside ``tools``
# and answers with ``functionCall`` parts, and it is a provider a user can
# already select for summaries.
#
# **The brief named two** — "Anthropic tool use; OpenAI-compatible function
# calling" — and leaving Google out would have repeated 1.9's P8 miss exactly:
# that denominator also named ``_PROVIDER_SPECS`` plus a few and dropped the one
# provider with its own request shape.
FAMILIES = ("anthropic", "openai", "google")

_PROBED_ON = "2026-09-06"


@dataclass(frozen=True)
class ProviderToolCalling:
    """One provider's two answers, and how each was established."""

    state: str          # "yes" | "no" | "unknown" — about the provider's API
    reason: str         # rendered to the user, verbatim
    evidence: str       # how it was established
    assistant: str      # "api_key_runtime" | "cli_runtime" | "no"
    assistant_reason: str
    family: Optional[str] = None    # which request shape, when resmon drives it

    @property
    def offered(self) -> bool:
        """Whether Settings offers this provider as an assistant runtime."""
        return self.assistant == "api_key_runtime"


_SDK_NOTE = (
    "The pinned SDK is the evidence rather than a probe: a live probe cannot "
    "discriminate here, because authentication precedes body validation."
)


PROVIDER_TOOL_CALLING: dict[str, ProviderToolCalling] = {
    "anthropic": ProviderToolCalling(
        state="yes",
        reason="Anthropic's Messages API takes tools and answers with tool_use blocks.",
        evidence=(
            f"{_PROBED_ON}: anthropic 0.95.0, the version pinned in "
            "requirements.txt — `messages.create` accepts `tools` and "
            "`tool_choice`, and `anthropic.types` carries `ToolUseBlock` and "
            f"`ToolResultBlockParam`. {_SDK_NOTE}"
        ),
        assistant="api_key_runtime",
        assistant_reason="resmon drives it directly with your key.",
        family="anthropic",
    ),
    "openai": ProviderToolCalling(
        state="yes",
        reason="OpenAI's chat completions take tools and answer with tool_calls.",
        evidence=(
            f"{_PROBED_ON}: openai 2.31.0, the version pinned in requirements.txt "
            "— `chat.completions.create` accepts `tools` and `tool_choice`. This "
            f"is also the API the OpenAI-compatible family is named after. {_SDK_NOTE}"
        ),
        assistant="api_key_runtime",
        assistant_reason="resmon drives it directly with your key.",
        family="openai",
    ),
    "google": ProviderToolCalling(
        state="yes",
        reason="Gemini takes function declarations and answers with function calls.",
        evidence=(
            f"{_PROBED_ON}: POST .../v1beta/models/gemini-2.0-flash:generateContent "
            "with an invalid key and `tools` set to a string answered 400 "
            "\"Invalid value at 'tools' "
            "(type.googleapis.com/google.ai.generativelanguage.v1beta.Tool)\", while "
            "the control field answered 400 \"Unknown name … Cannot find field\". "
            "The field exists and is typed."
        ),
        assistant="api_key_runtime",
        assistant_reason="resmon drives it directly with your key.",
        family="google",
    ),
    "xai": ProviderToolCalling(
        state="yes",
        reason="xAI's chat completions take tools.",
        evidence=(
            f"{_PROBED_ON}: POST https://api.x.ai/v1/chat/completions with an invalid "
            "key and `tools` set to a string answered 422 \"Failed to deserialize the "
            "JSON body … tools: invalid type: string, expected a sequence\", while the "
            "control field answered 400 \"Model not found\". The field exists and is a "
            "sequence."
        ),
        assistant="api_key_runtime",
        assistant_reason="resmon drives it directly with your key.",
        family="openai",
    ),
    "meta": ProviderToolCalling(
        state="unknown",
        reason=(
            "resmon could not establish from outside whether Together serves tool "
            "calling. Its API answers 401 for any body without a valid key, so there "
            "is nothing to observe. resmon will send the tools anyway and report "
            "exactly what comes back."
        ),
        evidence=(
            f"{_PROBED_ON}: the `tools` request and the nonsense-field control both "
            "answered 401. Authentication precedes validation, so neither answer is "
            "evidence about the field. Recording 'yes' here would be a guess wearing "
            "a citation."
        ),
        assistant="api_key_runtime",
        assistant_reason=(
            "resmon will try: the endpoint is OpenAI-compatible, and a provider that "
            "refuses tools says so in its own words rather than failing silently."
        ),
        family="openai",
    ),
    "deepseek": ProviderToolCalling(
        state="unknown",
        reason=(
            "resmon could not establish from outside whether DeepSeek serves tool "
            "calling. Its API answers 401 for any body without a valid key. resmon "
            "will send the tools anyway and report exactly what comes back."
        ),
        evidence=(
            f"{_PROBED_ON}: the `tools` request and the nonsense-field control both "
            "answered 401 'Authentication Fails'. The same wall the embeddings probe "
            "met at this provider."
        ),
        assistant="api_key_runtime",
        assistant_reason="resmon will try; the endpoint is OpenAI-compatible.",
        family="openai",
    ),
    "alibaba": ProviderToolCalling(
        state="unknown",
        reason=(
            "resmon could not establish from outside whether Alibaba Model Studio "
            "serves tool calling. Its API answers 401 for any body without a valid "
            "key. resmon will send the tools anyway and report what comes back."
        ),
        evidence=(
            f"{_PROBED_ON}: the `tools` request and the nonsense-field control both "
            "answered 401 'Incorrect API key provided'."
        ),
        assistant="api_key_runtime",
        assistant_reason="resmon will try; the endpoint is OpenAI-compatible.",
        family="openai",
    ),
    "custom": ProviderToolCalling(
        state="unknown",
        reason=(
            "resmon cannot know in advance what a custom endpoint serves. It will be "
            "called in the OpenAI-compatible shape, with tools; whatever it answers is "
            "what you will be shown."
        ),
        evidence="Not knowable in advance: the base URL is yours.",
        assistant="api_key_runtime",
        assistant_reason="resmon will try, in the OpenAI-compatible shape.",
        family="openai",
    ),
    "local": ProviderToolCalling(
        state="yes",
        reason=(
            "Ollama serves tool calling, for a model that supports it — but resmon's "
            "assistant does not drive Ollama yet. Ollama remains a summarisation lane."
        ),
        evidence=(
            f"{_PROBED_ON}: POST http://127.0.0.1:11434/api/chat to Ollama 0.33.2 with "
            "a one-function `tools` array and gemma4:e2b returned "
            "`message.tool_calls[0].function` = {name: 'resmon_probe', arguments: "
            "{'x': 'hello'}} — a real call, not a description of one."
        ),
        assistant="no",
        assistant_reason=(
            "An Ollama assistant runtime is a recorded open item rather than a gap "
            "found here (Capability Ledger 70); it was deliberately left out of this "
            "release. The probe above is what makes it cheap to add."
        ),
    ),
    "claude_code": ProviderToolCalling(
        state="yes",
        reason="The Claude Code CLI is an agent; calling tools is what it does.",
        evidence=(
            "2.0a: a real session's stream-json `init` message listed resmon's MCP "
            "tools, and a real model was watched calling one and blocking on the "
            "permission card."
        ),
        assistant="cli_runtime",
        assistant_reason=(
            "This is the assistant's first runtime: resmon drives the CLI you already "
            "signed into, so it spends your subscription rather than a key."
        ),
    ),
    "codex": ProviderToolCalling(
        state="yes",
        reason="The Codex CLI is an agent; calling tools is what it does.",
        evidence=(
            "2.0a, against codex-cli 0.153.1: an MCP server can be attached per "
            "invocation (`-c 'mcp_servers.resmon={…}'` is accepted under "
            "`--strict-config`)."
        ),
        assistant="no",
        assistant_reason=(
            "resmon can give a Codex session its own tools but cannot take away "
            "Codex's shell, and `codex exec` has no way for you to approve a command "
            "before it runs. Established against codex-cli 0.153.1 in 2.0a. Codex "
            "remains a summarisation lane, where it is given no tools at all."
        ),
    ),
}


def tool_calling(provider: str) -> ProviderToolCalling:
    """The tool-calling answer for *provider*.

    An unknown provider gets ``unknown`` and is not offered, rather than
    inheriting a capability nobody checked. The suite fails on the gap; the
    runtime degrades to saying so.
    """
    known = PROVIDER_TOOL_CALLING.get((provider or "").strip().lower())
    if known is not None:
        return known
    return ProviderToolCalling(
        state="unknown",
        reason=(
            f"resmon has no recorded answer for whether {provider!r} supports tool "
            "calling."
        ),
        evidence="No row in PROVIDER_TOOL_CALLING.",
        assistant="no",
        assistant_reason=(
            f"resmon does not know how to drive {provider!r} as an assistant."
        ),
    )
