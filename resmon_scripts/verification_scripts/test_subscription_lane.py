"""The subscription lane end to end: resolution, the cap, and the chain (1.8c).

The document cap is a product guard, not a technical one. An agent CLI spends
the same Claude Max or ChatGPT window the user does their own work in, so a
200-paper sweep routed through one can cost them the plan they actually need.
These tests pin that the guard cannot be removed by omission — from the
constructor, from a hand-edited chain, or from the legacy settings — and that
reaching it is recorded as a cap rather than as a failure.
"""

import json

import pytest

from implementation_scripts.ai_chain import ChainRunner
from implementation_scripts.ai_lanes import (
    DEFAULT_SUBSCRIPTION_DOC_CAP,
    AILane,
    parse_chain,
    resolve_chain,
)


# ---------------------------------------------------------------------------
# The cap cannot be lost by omission
# ---------------------------------------------------------------------------

def test_a_subscription_lane_is_capped_by_default():
    lane = AILane(kind="subscription", provider="claude_code")
    assert lane.doc_cap == DEFAULT_SUBSCRIPTION_DOC_CAP


def test_the_default_cap_is_twenty_five():
    """The agreed number. Changing it is a product decision, not a refactor."""
    assert DEFAULT_SUBSCRIPTION_DOC_CAP == 25


def test_other_lane_kinds_are_uncapped():
    """The cap exists because of what a subscription lane spends, not as policy."""
    assert AILane(kind="api_key", provider="anthropic", model="m").doc_cap is None
    assert AILane(kind="local", provider="local", model="m").doc_cap is None


def test_an_explicit_cap_is_honoured():
    lane = AILane(kind="subscription", provider="codex", doc_cap=3)
    assert lane.doc_cap == 3


@pytest.mark.parametrize("bad", [0, -5, "banana", None])
def test_an_unusable_cap_falls_back_to_the_default(bad):
    """A corrupt value must not be the thing that removes the guard.

    Zero in particular would read as 'no documents at all', which nobody means
    by it, and would silently disable the lane instead of capping it.
    """
    lanes = parse_chain(json.dumps([
        {"kind": "subscription", "provider": "codex", "doc_cap": bad},
    ]))
    assert lanes[0].doc_cap == DEFAULT_SUBSCRIPTION_DOC_CAP


def test_the_cap_survives_a_chain_round_trip():
    original = AILane(kind="subscription", provider="codex", doc_cap=7)
    restored = parse_chain(json.dumps([original.to_dict()]))[0]
    assert restored.doc_cap == 7
    assert restored.binary_path == original.binary_path


def test_legacy_settings_resolve_to_a_capped_subscription_lane():
    lanes = resolve_chain({"ai_provider": "claude_code", "ai_model": "opus"})
    assert lanes[0].kind == "subscription"
    assert lanes[0].doc_cap == DEFAULT_SUBSCRIPTION_DOC_CAP


def test_legacy_settings_honour_a_configured_cap():
    lanes = resolve_chain({
        "ai_provider": "codex",
        "ai_subscription_doc_cap": "5",
        "ai_cli_path": "/somewhere/codex",
    })
    assert lanes[0].doc_cap == 5
    assert lanes[0].binary_path == "/somewhere/codex"


# ---------------------------------------------------------------------------
# The cap in a running chain
# ---------------------------------------------------------------------------

class _CountingClient:
    """A stand-in lane client that records how many documents it saw."""

    def __init__(self, text="summary", provider="claude_code"):
        self.provider = provider
        self.model = "test-model"
        self.calls = 0
        self._text = text

    def summarize(self, text, prompt_params=None):
        self.calls += 1
        return self._text


class _NullDB:
    """execution_ai writes are best-effort; the runner must not depend on them."""


@pytest.fixture
def no_db_writes(monkeypatch):
    opened, finished = [], []
    monkeypatch.setattr(
        "implementation_scripts.ai_chain.start_ai_lane",
        lambda db, exec_id, index, **kw: opened.append((index, kw)),
    )
    monkeypatch.setattr(
        "implementation_scripts.ai_chain.finish_ai_lane",
        lambda db, exec_id, index, **kw: finished.append((index, kw)),
    )
    return {"opened": opened, "finished": finished}


def test_the_lane_stops_at_its_cap(no_db_writes):
    client = _CountingClient()
    lane = AILane(kind="subscription", provider="claude_code", doc_cap=3)
    runner = ChainRunner([lane], db=_NullDB(), exec_id=1, primary_client=client)

    for _ in range(10):
        runner.summarize_document("paper")

    assert client.calls == 3


def test_documents_past_the_cap_go_to_the_next_lane(no_db_writes):
    """The chain carries on; the papers are summarised, just not by that lane."""
    capped = _CountingClient(text="from the CLI")
    overflow = _CountingClient(text="from the API", provider="anthropic")

    runner = ChainRunner(
        [
            AILane(kind="subscription", provider="claude_code", doc_cap=2),
            AILane(kind="api_key", provider="anthropic", model="m"),
        ],
        db=_NullDB(), exec_id=1, primary_client=capped,
    )
    runner._states[1]._client = overflow
    runner._states[1]._built = True
    from implementation_scripts.summarizer import SummarizationPipeline
    runner._states[1]._pipeline = SummarizationPipeline(overflow)

    results = [runner.summarize_document("paper")[0] for _ in range(5)]

    # The pipeline prefixes a provenance header naming the model that produced
    # each summary, so these are containment checks rather than equality --
    # and the header is itself worth asserting on, since it is how a reader
    # tells which lane wrote which summary once a chain has fallen through.
    assert all("from the CLI" in r for r in results[:2])
    assert all("claude_code" in r for r in results[:2])
    assert all("from the API" in r for r in results[2:])
    assert all("anthropic" in r for r in results[2:])
    assert capped.calls == 2


def test_reaching_the_cap_is_recorded_as_a_cap_not_a_failure(no_db_writes):
    client = _CountingClient()
    lane = AILane(kind="subscription", provider="claude_code", doc_cap=1)
    runner = ChainRunner([lane], db=_NullDB(), exec_id=1, primary_client=client)

    runner.summarize_document("one")
    runner.summarize_document("two")

    summary = runner.lane_summaries()[0]
    assert summary["succeeded"] == 1
    assert summary["demoted"] is True
    assert "limit" in (summary["reason"] or "")

    runner.finish()
    outcome = no_db_writes["finished"][0][1]["outcome"]
    # One document attempted, one succeeded -- the lane did its job.
    assert outcome == "ok"
    assert "error_kind" not in outcome


def test_an_uncapped_lane_keeps_going(no_db_writes):
    client = _CountingClient()
    runner = ChainRunner(
        [AILane(kind="api_key", provider="anthropic", model="m")],
        db=_NullDB(), exec_id=1, primary_client=client,
    )
    for _ in range(30):
        runner.summarize_document("paper")
    assert client.calls == 30


# ---------------------------------------------------------------------------
# Building the client
# ---------------------------------------------------------------------------

def test_the_factory_builds_a_subscription_client_when_the_cli_is_found(
    tmp_path, monkeypatch,
):
    import stat

    from implementation_scripts.llm_factory import build_client_for_lane
    from implementation_scripts.llm_subscription import SubscriptionLLMClient

    binary = tmp_path / "claude"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(binary.stat().st_mode | stat.S_IXUSR)

    lane = AILane(
        kind="subscription", provider="claude_code",
        binary_path=str(binary), model="opus",
    )
    client = build_client_for_lane(lane)

    assert isinstance(client, SubscriptionLLMClient)
    assert client.binary_path == str(binary)
    assert client.model == "opus"


def test_the_factory_returns_none_when_the_cli_is_absent(monkeypatch):
    """An unusable lane is a lane to skip, not a run to abort."""
    from implementation_scripts.llm_factory import build_client_for_lane

    monkeypatch.setenv("PATH", "/nonexistent-resmon-test-dir")
    lane = AILane(
        kind="subscription", provider="claude_code",
        binary_path="/definitely/not/here",
    )
    assert build_client_for_lane(lane) is None


def test_a_missing_cli_lane_explains_where_it_looked(monkeypatch):
    """The skip reason is what the user reads; 'not implemented' is gone."""
    from implementation_scripts.ai_chain import _why_unusable

    monkeypatch.setenv("PATH", "/nonexistent-resmon-test-dir")
    reason = _why_unusable(
        AILane(kind="subscription", provider="codex", binary_path="/nope/codex")
    )
    assert "not implemented" not in reason.lower()
    assert "Settings" in reason


def test_a_subscription_lane_never_carries_a_credential_alias():
    """resmon never holds the plan credential; there is no slot for one."""
    lane = AILane(kind="subscription", provider="claude_code")
    assert lane.credential_alias is None
    assert "credential" not in json.dumps(lane.to_dict()).replace(
        '"credential_alias": null', ''
    )
