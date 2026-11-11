"""A model id as a person reads it, and which report says what answered.

``model_display_name`` turns what a CLI reports into "Haiku 4.5" or "GPT-5.5"
and leaves anything it does not recognize as it was reported. The second
half of that is the one that matters: a version made up for an unknown id is
exactly the guess the pickers are built not to make.
"""

from __future__ import annotations

import pytest

from implementation_scripts.ai_model_names import answered_by, model_display_name


@pytest.mark.parametrize("model_id, name", [
    # Today's Claude ids, family first.
    ("claude-haiku-5-5", "Haiku 5.5"),
    ("claude-opus-5-5", "Opus 5.5"),
    ("claude-sonnet-5-5", "Sonnet 5.5"),
    ("claude-fable-5-1", "Fable 5.1"),
    # Dated and suffixed snapshots name the same model.
    ("claude-haiku-4-5-20251001", "Haiku 4.5"),
    ("claude-opus-4-1-20250805", "Opus 4.1"),
    ("claude-opus-4-20250514", "Opus 4"),
    ("claude-sonnet-4-5@20250929", "Sonnet 4.5"),
    ("claude-sonnet-4-5-latest", "Sonnet 4.5"),
    ("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "Sonnet 4.5"),
    ("anthropic/claude-haiku-5-5", "Haiku 5.5"),
    # A bracketed variant is kept as written rather than interpreted.
    ("claude-sonnet-4-5[1m]", "Sonnet 4.5 [1m]"),
    # The older order, version first.
    ("claude-3-5-sonnet-20241022", "Sonnet 3.5"),
    ("claude-3-opus-20240229", "Opus 3"),
    # Codex's models.
    ("gpt-5.5", "GPT-5.5"),
    ("gpt-5.5-codex", "GPT-5.5-Codex"),
    ("gpt-5-codex-mini", "GPT-5-Codex-Mini"),
    ("gpt-4o", "GPT-4o"),
    ("gpt-4.1-mini", "GPT-4.1-Mini"),
])
def test_a_known_id_is_named(model_id, name):
    assert model_display_name(model_id) == name


@pytest.mark.parametrize("model_id", [
    "haiku",                    # an alias is not a resolved id
    "fake-model",
    "o3",
    "gpt-oss-120b",
    "claude-something-new",
    "claude-haiku",             # no version: nothing to name it with
    "Claude-Haiku-4-5",         # not the lower case the CLIs report
    "my-claude-thing",
    "",
])
def test_an_unknown_id_is_shown_as_the_id_itself(model_id):
    assert model_display_name(model_id) == model_id


def test_a_value_that_is_not_a_string_is_shown_rather_than_raised_on():
    assert model_display_name(None) == ""
    assert model_display_name(42) == "42"


def _report(model, source, sequence=1):
    return {"sequence": sequence, "model": model, "source": source,
            "observed_at_utc": "2026-10-30T15:45:00+00:00"}


def test_the_billed_model_answers_over_the_one_announced_at_start():
    reports = [
        _report("haiku", "claude_system_init_model", 1),
        _report("claude-haiku-5-5", "claude_result_model_usage", 2),
        _report("claude-haiku-4-5-20251001", "claude_result_model_usage", 3),
    ]
    # The first usage report is the biggest writer; the runtime records them
    # in that order.
    assert answered_by(reports) == {
        "model": "claude-haiku-5-5", "name": "Haiku 5.5",
        "source": "claude_result_model_usage"}


def test_the_announced_model_is_used_only_when_nothing_better_was_reported():
    assert answered_by([_report("claude-opus-5-5", "claude_system_init_model")]) == {
        "model": "claude-opus-5-5", "name": "Opus 5.5", "source": "claude_system_init_model"}


def test_the_latest_provider_reply_names_an_api_turn():
    reports = [_report("gpt-5.5", "api_response_model", 1),
               _report("gpt-5.5-2026-01-01", "api_response_model", 2)]
    assert answered_by(reports)["model"] == "gpt-5.5-2026-01-01"


@pytest.mark.parametrize("reports", [[], None, {"unreadable": True}, [{"model": ""}], ["text"]])
def test_no_usable_report_is_no_answer(reports):
    assert answered_by(reports) is None
