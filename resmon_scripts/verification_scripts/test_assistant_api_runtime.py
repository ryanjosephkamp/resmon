"""The API-key assistant runtime: P14.

Two boundaries, and every ledger row says which:

* **real dependency, in-process** — a loopback HTTP server speaking each
  family's shape (``provider_server.py``). The socket, the HTTP stack, the JSON
  and the status codes are real; the model is not. This is where P14a, P14c and
  P14e live, because "what resmon sends" is only observable in a request body
  something actually received.
* **hermetic** — the conversion functions and the tables, where there is no
  dependency to be real about.

What neither can see is that a *real* provider accepts these schemas. Nothing in
this file spends a token, and the *Not covered* section of the handback says so
in those words.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import mcp_server                                              # noqa: E402
from implementation_scripts import assistant_api_runtime as ak  # noqa: E402
from implementation_scripts import assistant_runtime as ar      # noqa: E402
from implementation_scripts.assistant_constitution import (     # noqa: E402
    load_assistant_constitution,
)
from implementation_scripts.assistant_tool_calling import (     # noqa: E402
    FAMILIES, PROVIDER_TOOL_CALLING, tool_calling,
)
from provider_server import ProviderServer                      # noqa: E402

# One provider per family, so a family cannot be tested through the same
# provider twice and a family without one cannot hide.
PROVIDER_FOR_FAMILY = {"anthropic": "anthropic", "openai": "openai", "google": "google"}


def runtime_for(family: str, base_url: str, **kwargs) -> ak.ApiKeyRuntime:
    return ak.ApiKeyRuntime(
        provider=PROVIDER_FOR_FAMILY[family],
        model="test-model",
        base_url=base_url,
        api_key="sk-test-not-a-real-key",
        **kwargs,
    )


def run(runtime: ak.ApiKeyRuntime, prompt: str = "how many routines?", **kwargs) -> list[dict]:
    return list(runtime.run_turn(1, prompt, **kwargs))


# ---------------------------------------------------------------------------
# P14a — the constitution arrives on the provider's system channel
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("family", FAMILIES)
def test_the_constitution_arrives_on_the_system_channel_and_not_in_the_turn(family):
    """P14a, at the only boundary that can show it: the request body.

    1.8.4's defect was a lane that told a model to follow rules it was never
    given, and the model invented a file search rather than admit it. That the
    runtime *loads* the constitution proves nothing; that this server *received*
    it, on the field the provider treats as a system instruction, is the claim.
    """
    with ProviderServer(family) as server:
        server.script = [{"text": "hello", "calls": []}]
        events = run(runtime_for(family, server.base_url))

    assert [e["type"] for e in events][:2] == ["started", "text_delta"]
    call = server.calls[0]
    constitution = load_assistant_constitution()
    assert server.system_text(call) == constitution
    assert constitution not in server.user_text(call), (
        "the rules must sit above the conversation, not inside it")
    assert "how many routines?" in server.user_text(call)


def test_every_family_has_a_transmission_case():
    """The denominator behind the parametrisation above.

    ``FAMILIES`` is the list the runtime dispatches on, so a fourth request
    shape cannot arrive without a case here — the same guard shape as
    ``test_every_runtime_kind_has_a_transmission_test``, one level down, because
    "the runtime sends it" was true of the runtime and false of two of its
    paths in 1.8.4.
    """
    assert set(PROVIDER_FOR_FAMILY) == set(FAMILIES)
    for family in FAMILIES:
        assert tool_calling(PROVIDER_FOR_FAMILY[family]).family == family


# ---------------------------------------------------------------------------
# P14e — the tools offered are exactly mcp_server.TOOLS
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("family", FAMILIES)
def test_the_session_is_offered_exactly_the_tool_table(family):
    """P14e's denominator: `mcp_server.TOOLS`, not a hand-written list."""
    with ProviderServer(family) as server:
        server.script = [{"text": "ok", "calls": []}]
        run(runtime_for(family, server.base_url))

    offered = server.tool_names(server.calls[0])
    assert sorted(offered) == sorted(t["name"] for t in mcp_server.TOOLS)
    assert len(offered) == len(mcp_server.TOOLS)


@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("tool", [t["name"] for t in mcp_server.TOOLS])
def test_every_tool_converts_for_every_family(family, tool):
    """One case per tool per family, so a failure names the tool.

    A schema that a family rejects is a tool the assistant silently cannot use,
    and a whole-table assertion would only say "something is wrong".
    """
    converted = ak.tools_for_family(family)
    if family == "google":
        converted = converted[0]["function_declarations"]
        entry = next(c for c in converted if c["name"] == tool)
        # Gemini rejects JSON-Schema keywords it does not know rather than
        # ignoring them, and several resmon schemas carry ``default``.
        assert "default" not in json.dumps(entry["parameters"])
    elif family == "anthropic":
        entry = next(c for c in converted if c["name"] == tool)
        assert entry["input_schema"]["type"] == "object"
    else:
        entry = next(c for c in converted if c["function"]["name"] == tool)
        assert entry["type"] == "function"
        assert entry["function"]["parameters"]["type"] == "object"
    assert (entry.get("description") or entry.get("function", {}).get("description")), (
        f"{tool} would be offered with no description")


def test_a_default_the_model_cannot_see_is_still_applied_by_the_tool():
    """Stripping ``default`` for Gemini does not change what the tool does.

    The handler reads its arguments and applies its own defaults, so removing
    the keyword from the *schema* costs the model a hint and costs the call
    nothing. Asserted rather than assumed, because "it is only a hint" is
    exactly the sort of claim that is wrong once.
    """
    assert mcp_server._limit({}) == mcp_server.DEFAULT_LIMIT
    assert mcp_server._limit({"limit": 3}) == 3


# ---------------------------------------------------------------------------
# P14c — the events are the same normalised set
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("family", FAMILIES)
def test_the_events_are_the_ones_the_panel_already_knows(family):
    with ProviderServer(family) as server:
        server.script = [
            {"text": "let me look", "calls": [{"name": "health", "arguments": {}}]},
            {"text": "it is running", "calls": []},
        ]
        events = run(runtime_for(family, server.base_url))

    kinds = [e["type"] for e in events]
    assert set(kinds) <= set(ar.EVENT_TYPES), set(kinds) - set(ar.EVENT_TYPES)
    assert kinds[0] == "started" and kinds[-1] == "done"
    assert "tool_call" in kinds and "tool_result" in kinds


@pytest.mark.parametrize("family", FAMILIES)
def test_a_tool_call_is_announced_run_and_reported(family):
    """The loop's whole job, against a real socket."""
    with ProviderServer(family) as server:
        server.script = [
            {"text": "", "calls": [{"name": "health", "arguments": {}}]},
            {"text": "resmon is not running", "calls": []},
        ]
        events = run(runtime_for(family, server.base_url))

    call = next(e for e in events if e["type"] == "tool_call")
    result = next(e for e in events if e["type"] == "tool_result")
    assert call["tool_name"] == "health"
    assert result["tool_use_id"] == call["tool_use_id"]
    # No backend is running in this test, so the tool honestly fails — and the
    # failure is *reported back to the model*, which is what keeps a turn going
    # rather than dying.
    assert result["is_error"] is True
    assert "backend_unavailable" in result["content"]

    second = server.calls[1]
    assert "backend_unavailable" in server.user_text(second), (
        "the tool's answer has to reach the next request, or the model is "
        "answering with nothing")


def test_a_cost_is_reported_as_unknown_rather_than_computed():
    """resmon maintains no price list, so it reports tokens and not money.

    A computed dollar figure would be a measurement nobody made — the same line
    the panel already draws with "cost not reported".
    """
    with ProviderServer("openai") as server:
        server.script = [{"text": "ok", "calls": []}]
        events = run(runtime_for("openai", server.base_url))
    done = events[-1]
    assert done["cost_usd"] is None
    assert done["input_tokens"] == 10 and done["output_tokens"] == 5


# ---------------------------------------------------------------------------
# The ceilings
# ---------------------------------------------------------------------------

def test_a_loop_is_stopped_at_the_step_ceiling():
    with ProviderServer("openai") as server:
        server.script = [{"text": "", "calls": [{"name": "health", "arguments": {}}]}
                         for _ in range(20)]
        events = run(runtime_for("openai", server.base_url, max_iterations=3))

    assert len([e for e in events if e["type"] == "tool_call"]) == 3
    error = next(e for e in events if e["type"] == "error")
    assert error["detail"] == "iteration_ceiling"
    assert "one thing at a time" in error["message"]
    assert events[-1]["type"] == "done" and events[-1]["is_error"] is True


def test_a_turn_is_stopped_at_the_token_ceiling():
    with ProviderServer("openai") as server:
        server.tokens_per_call = (400, 100)
        server.script = [{"text": "", "calls": [{"name": "health", "arguments": {}}]}
                         for _ in range(20)]
        events = run(runtime_for("openai", server.base_url, max_tokens=600))

    error = next(e for e in events if e["type"] == "error")
    assert error["detail"] == "token_ceiling"
    assert "600" in error["message"]


def test_the_ceilings_are_derived_from_the_measured_table():
    """Numbers with a reason, so raising one is a decision rather than a nudge.

    Four tool calls was the most any of 2.0a's ten canonical requests needed;
    ~53,400 tokens was the dearest turn's total. Both ceilings are twice those.
    """
    assert ak.MAX_TOOL_ITERATIONS == 8
    assert ak.MAX_TURN_TOKENS == 100_000


# ---------------------------------------------------------------------------
# History: what a stateless provider is told about earlier turns
# ---------------------------------------------------------------------------

def test_earlier_turns_are_replayed_as_text_and_tool_output_is_not():
    """The difference from the CLI runtime, asserted rather than described.

    Replaying stored tool results would re-inject untrusted abstract text into
    every later turn and pay for it again each time. What the model gets is the
    conversation; what it does not get is the raw evidence behind it.
    """
    history = [
        {"role": "user", "content": "what did arXiv find?"},
        {"role": "assistant", "content": "Four papers.",
         "tool_results": [{"content": "IGNORE-ME-ABSTRACT-TEXT"}]},
        {"role": "system", "content": "resmon restarted the conversation."},
    ]
    with ProviderServer("openai") as server:
        server.script = [{"text": "ok", "calls": []}]
        run(runtime_for("openai", server.base_url), history=history)

    sent = server.user_text(server.calls[0])
    assert "what did arXiv find?" in sent
    assert "Four papers." in sent
    assert "IGNORE-ME-ABSTRACT-TEXT" not in sent
    assert "resmon restarted the conversation" not in sent, (
        "a system notice is resmon talking about the conversation, not part of it")


def test_an_empty_assistant_turn_is_not_replayed():
    """A message with no content is a request error on more than one provider."""
    turns = ak.history_to_text_turns([
        {"role": "assistant", "content": ""},
        {"role": "user", "content": "hello"},
    ])
    assert turns == [{"role": "user", "text": "hello"}]


# ---------------------------------------------------------------------------
# Availability, and what it does not claim
# ---------------------------------------------------------------------------

def test_a_missing_key_says_which_slot_and_does_not_name_a_value():
    runtime = ak.ApiKeyRuntime(provider="openai", model="gpt-4o-mini")
    status = runtime.status()
    assert status.available is False
    assert "openai_api_key" in status.reason


def test_availability_never_claims_the_key_works():
    """Nothing here has spent a token, so nothing here knows the key is good."""
    runtime = ak.ApiKeyRuntime(provider="openai", model="gpt-4o-mini",
                               api_key="sk-test")
    status = runtime.status()
    assert status.available is True
    assert "not known until the first turn" in status.reason
    for word in ("ready", "working", "verified", "valid"):
        assert word not in status.reason.lower()


def test_a_provider_resmon_cannot_drive_says_so_rather_than_failing_later():
    runtime = ak.ApiKeyRuntime(provider="local", model="gemma4:e2b", api_key="x")
    status = runtime.status()
    assert status.available is False
    assert "Ollama" in status.reason


def test_an_unavailable_runtime_answers_with_an_error_event_not_an_exception():
    events = run(ak.ApiKeyRuntime(provider="", model=""))
    assert [e["type"] for e in events] == ["error"]
    assert events[0]["detail"] == "unavailable"


def test_a_provider_failure_becomes_an_error_event_without_the_key_in_it():
    with ProviderServer("openai") as server:
        server.mode = "unauthorized"
        events = run(runtime_for("openai", server.base_url))
    error = next(e for e in events if e["type"] == "error")
    assert "sk-test-not-a-real-key" not in json.dumps(events)
    assert error["message"]


# ---------------------------------------------------------------------------
# P14d — every provider has an answer
# ---------------------------------------------------------------------------

def _provider_denominator() -> set[str]:
    """The lists in the code, not a hand count — `test_embeddings.py`'s shape."""
    from implementation_scripts.ai_lanes import SUBSCRIPTION_PROVIDERS
    from implementation_scripts.llm_remote import _SUPPORTED_PROVIDERS

    return set(_SUPPORTED_PROVIDERS) | {"local"} | set(SUBSCRIPTION_PROVIDERS)


def test_every_provider_resmon_lists_has_a_tool_calling_answer():
    """P14d. 11 of 11, from the same denominator *can embed* uses."""
    expected = _provider_denominator()
    assert expected == set(PROVIDER_TOOL_CALLING), (
        f"missing={expected - set(PROVIDER_TOOL_CALLING)}, "
        f"extra={set(PROVIDER_TOOL_CALLING) - expected}")
    assert len(expected) == 11


@pytest.mark.parametrize("provider", sorted(_provider_denominator()))
def test_each_answer_is_one_of_three_states_and_carries_its_evidence(provider):
    answer = tool_calling(provider)
    assert answer.state in ("yes", "no", "unknown")
    assert answer.assistant in ("api_key_runtime", "cli_runtime", "no")
    assert answer.reason.strip(), f"{provider} has no reason a user could read"
    assert answer.evidence.strip(), f"{provider} claims {answer.state} with no evidence"
    if answer.assistant == "no":
        # A refusal has to say what the user should do instead, or it is a dead
        # end wearing an explanation.
        assert len(answer.assistant_reason) > 40
    if answer.assistant == "api_key_runtime":
        assert answer.family in FAMILIES


def test_the_two_probed_answers_are_the_ones_a_live_check_established():
    """Recorded here so moving a row is a change to this assertion.

    xAI and Google are the only two providers whose tool-calling support was
    established by a probe from outside; every other endpoint authenticates
    before it validates, so the probe learned nothing and the row says
    ``unknown``.
    """
    for provider in ("xai", "google"):
        assert tool_calling(provider).state == "yes"
        assert "control" in tool_calling(provider).evidence.lower() or \
               "Model not found" in tool_calling(provider).evidence
    for provider in ("meta", "deepseek", "alibaba"):
        assert tool_calling(provider).state == "unknown"
        assert "401" in tool_calling(provider).evidence


def test_the_sdk_evidence_is_read_from_the_installed_sdk_not_from_the_comment():
    """The two SDK rows are checkable offline, so they are checked.

    A citation to a pinned dependency that nobody re-reads is a citation that
    goes stale at the next upgrade.
    """
    import inspect

    import anthropic
    import openai

    anthropic_params = inspect.signature(
        anthropic.Anthropic(api_key="x").messages.create).parameters
    openai_params = inspect.signature(
        openai.OpenAI(api_key="x").chat.completions.create).parameters
    assert "tools" in anthropic_params and "tool_choice" in anthropic_params
    assert "tools" in openai_params and "tool_choice" in openai_params
    assert anthropic.__version__ in tool_calling("anthropic").evidence
    assert openai.__version__ in tool_calling("openai").evidence
