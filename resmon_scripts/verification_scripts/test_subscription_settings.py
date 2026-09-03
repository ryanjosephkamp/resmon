"""Model lists, effort levels, and what resmon may claim about them (1.8.5 D5).

The whole subject of this file is the difference between two sentences:

    "These are the models this account can reach."
    "These are the names the command accepts."

``codex`` can support the first — ``codex debug models`` reports a real
catalog, with the reasoning levels each model supports. ``claude`` cannot: it
has no models-listing command, so what resmon offers is the aliases its
``--help`` documents, and the interface has to say which of the two it is
showing. A dropdown that presents both as the same kind of fact is the
overclaim this project rejects.

The effort control has the same shape one level down. None of the eight
API-key providers takes a reasoning-effort parameter, so offering the control
there would be a knob that silently does nothing.
"""

import json
import stat
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient  # noqa: E402

import resmon as resmon_mod  # noqa: E402
from implementation_scripts.ai_lanes import AILane  # noqa: E402
from implementation_scripts.ai_models import (  # noqa: E402
    CLAUDE_EFFORT_LEVELS,
    CLAUDE_MODEL_ALIASES,
    ModelListError,
    list_subscription_catalog,
)
from implementation_scripts.llm_subscription import SubscriptionLLMClient  # noqa: E402


# ---------------------------------------------------------------------------
# A fake `codex debug models`
# ---------------------------------------------------------------------------

_CATALOG = {
    "models": [
        {
            "slug": "gpt-5.6-sol", "visibility": "list",
            "default_reasoning_level": "low",
            "supported_reasoning_levels": [
                {"effort": "low"}, {"effort": "medium"}, {"effort": "high"},
                {"effort": "xhigh"}, {"effort": "max"}, {"effort": "ultra"},
            ],
        },
        {
            "slug": "gpt-5.5", "visibility": "list",
            "default_reasoning_level": "medium",
            "supported_reasoning_levels": [
                {"effort": "low"}, {"effort": "medium"}, {"effort": "high"},
                {"effort": "xhigh"},
            ],
        },
        # codex itself does not list this one. Offering it would be resmon
        # inventing a choice the tool declines to present.
        {"slug": "gpt-daybreak-red-latest", "visibility": "hide",
         "supported_reasoning_levels": [{"effort": "low"}]},
    ],
}


def fake_codex(tmp_path, *, stdout=None, exit_code=0, name="codex"):
    script = tmp_path / name
    script.write_text(
        "#!/bin/sh\n"
        f"cat <<'JSON'\n{json.dumps(_CATALOG) if stdout is None else stdout}\nJSON\n"
        f"exit {exit_code}\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


# ---------------------------------------------------------------------------
# claude — aliases, and saying so
# ---------------------------------------------------------------------------

def test_claude_offers_the_aliases_its_help_documents():
    catalog = list_subscription_catalog("claude_code")
    assert catalog.models == list(CLAUDE_MODEL_ALIASES)
    assert catalog.error == ""


def test_claude_does_not_claim_the_list_is_the_account_s_models():
    """It is a documented alias list, and the interface renders which it is."""
    provenance = list_subscription_catalog("claude_code").provenance.lower()
    assert "alias" in provenance
    assert "not a list of models this account can reach" in provenance


def test_claude_offers_the_effort_levels_its_help_documents():
    catalog = list_subscription_catalog("claude_code")
    assert set(CLAUDE_EFFORT_LEVELS) == {"low", "medium", "high", "xhigh", "max"}
    for alias in CLAUDE_MODEL_ALIASES:
        assert catalog.efforts[alias] == list(CLAUDE_EFFORT_LEVELS)


# ---------------------------------------------------------------------------
# codex — a real catalog, read as one
# ---------------------------------------------------------------------------

def test_codex_reports_the_models_it_lists(tmp_path):
    catalog = list_subscription_catalog("codex", str(fake_codex(tmp_path)))
    assert catalog.models == ["gpt-5.6-sol", "gpt-5.5"]
    assert "codex debug models" in catalog.provenance


def test_codex_hidden_models_are_not_offered(tmp_path):
    catalog = list_subscription_catalog("codex", str(fake_codex(tmp_path)))
    assert "gpt-daybreak-red-latest" not in catalog.models


def test_codex_effort_levels_are_per_model(tmp_path):
    """The levels differ by model, and resmon must not flatten them.

    ``ultra`` exists for gpt-5.6-sol and not for gpt-5.5. Offering it for
    gpt-5.5 would be resmon claiming a level codex says that model does not
    take.
    """
    catalog = list_subscription_catalog("codex", str(fake_codex(tmp_path)))
    assert "ultra" in catalog.efforts["gpt-5.6-sol"]
    assert "ultra" not in catalog.efforts["gpt-5.5"]
    assert catalog.default_efforts["gpt-5.6-sol"] == "low"


@pytest.mark.parametrize("stdout", ["not json", "{}", '{"models": "nope"}', ""])
def test_an_unrecognised_catalog_shape_costs_the_dropdown_not_the_lane(tmp_path, stdout):
    """``debug`` is not a stable interface, so its output is not trusted blindly."""
    catalog = list_subscription_catalog(
        "codex", str(fake_codex(tmp_path, stdout=stdout)),
    )
    assert catalog.models == []
    assert catalog.error
    assert "type a model name" in catalog.error.lower()


def test_a_missing_codex_says_where_it_looked(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/nonexistent-resmon-test-dir")
    monkeypatch.setattr(
        "implementation_scripts.ai_cli._KNOWN_LOCATIONS",
        {"darwin": {"claude_code": (), "codex": ()},
         "linux": {"claude_code": (), "codex": ()},
         "win32": {"claude_code": (), "codex": ()}},
    )
    catalog = list_subscription_catalog("codex", None)
    assert catalog.models == []
    assert catalog.error


def test_an_unknown_provider_still_raises():
    with pytest.raises(ModelListError):
        list_subscription_catalog("anthropic")


# ---------------------------------------------------------------------------
# The endpoint — no key required, because there is no key
# ---------------------------------------------------------------------------

def _client():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app
    return TestClient(app)


def test_the_models_endpoint_answers_a_subscription_provider_without_a_key():
    """Asking for a key here would be the false "API key missing" again."""
    resp = _client().post("/api/ai/models", json={"provider": "claude_code"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["models"] == list(CLAUDE_MODEL_ALIASES)
    assert body["provenance"]


def test_the_models_endpoint_honours_a_configured_codex_path(tmp_path):
    resp = _client().post("/api/ai/models", json={
        "provider": "codex", "binary_path": str(fake_codex(tmp_path)),
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["models"] == ["gpt-5.6-sol", "gpt-5.5"]


def test_the_models_endpoint_still_demands_a_key_for_byok_providers():
    resp = _client().post("/api/ai/models", json={"provider": "openai"})
    assert resp.status_code == 400
    assert "key" in resp.text.lower()


# ---------------------------------------------------------------------------
# Effort reaches argv — the only place it can be said to work
# ---------------------------------------------------------------------------

def test_effort_reaches_the_claude_argv():
    client = SubscriptionLLMClient("claude_code", "/fake/claude", effort="xhigh")
    argv = client._claude_argv("prompt")
    assert argv[argv.index("--effort") + 1] == "xhigh"


def test_effort_reaches_the_codex_argv():
    client = SubscriptionLLMClient("codex", "/fake/codex", effort="high")
    argv = client._codex_argv("prompt", "/tmp/wd", "/tmp/out")
    assert "-c" in argv
    assert argv[argv.index("-c") + 1] == "model_reasoning_effort=high"


@pytest.mark.parametrize("provider,flag", [("claude_code", "--effort"), ("codex", "-c")])
def test_no_effort_flag_when_no_effort_is_set(provider, flag):
    """A lane with no effort must not pin one.

    codex in particular reads ``model_reasoning_effort`` from the user's own
    ``~/.codex/config.toml``. resmon passing a value it invented would silently
    override a preference the user set for themselves.
    """
    client = SubscriptionLLMClient(provider, f"/fake/{provider}")
    argv = (
        client._claude_argv("p") if provider == "claude_code"
        else client._codex_argv("p", "/tmp/wd", "/tmp/out")
    )
    assert flag not in argv


def test_the_lane_carries_effort_into_the_client():
    from implementation_scripts.llm_factory import build_client_for_lane
    import unittest.mock as mock

    lane = AILane(kind="subscription", provider="claude_code", effort="max")
    with mock.patch(
        "implementation_scripts.llm_factory.discover_cli",
        return_value=type("D", (), {"found": True, "path": "/fake/claude",
                                    "describe": lambda self: ""})(),
    ):
        client = build_client_for_lane(lane)
    assert client.effort == "max"


def test_the_audit_prefix_names_the_effort_only_when_one_was_set():
    from implementation_scripts.summarizer import SummarizationPipeline

    class _Client:
        provider, model = "claude_code", "opus"

        def summarize(self, text, prompt_params=None):
            return "a summary"

    with_effort = SummarizationPipeline(_Client(), {"_audit_effort": "xhigh"})
    assert "| effort: xhigh]" in with_effort._audit_prefix()

    # An empty `| effort:` on the eight API-key providers would imply a
    # control they do not have.
    without = SummarizationPipeline(_Client(), {})
    assert "effort" not in without._audit_prefix()
