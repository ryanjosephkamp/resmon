"""``update_settings`` admits a key by name, and withholds the rest: R6.

The guard on this tool used to be a substring denylist over key *names* —
``key``, ``token``, ``secret``, ``password``, ``passphrase``, ``credential``,
``auth``. ``ai_cli_path`` contains none of those words, and it is the path
``ai_cli.discover_cli`` honours first and ``ClaudeCliRuntime._stream`` hands to
``Popen`` with the user's own environment; ``ai_lanes`` reads the same setting
for the subscription summary lane, so the binary runs on routine summarization
with nobody watching. ``ai_custom_base_url`` and ``ai_local_endpoint`` decide
where the key, the prompt and the corpus text are POSTed. ``smtp_to`` decides
who receives the reports and ``export_directory`` decides where resmon writes
files.

For the embedded assistant each of those is confirm-gated and the card renders
the arguments, so a careful person would see it. **For an external MCP harness
there is no gate at all**: ``call_tool`` dispatches immediately and
``requires_confirmation`` is advisory metadata the contract says a caller may
ignore. R6 says destructive endpoints stay off the tool surface entirely, so
the decision moves into the server: a key is writable because someone listed
it, not because its name happens to avoid seven words.

Everything here is hermetic. The HTTP layer is stubbed the way
``test_mcp_server.py`` stubs it, and the denominator — how many settings keys
the app actually has — is read from ``resmon._SETTINGS_GROUPS`` rather than
written out here, so a key the app grows cannot slip past unclassified.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import mcp_server as mcp              # noqa: E402
import resmon as resmon_mod           # noqa: E402
from test_mcp_server import _payload, _stub  # noqa: E402

# The app's own key list, by group. Everything below counts against this.
APP_GROUPS: dict[str, list[str]] = {
    group: list(keys) for group, keys in resmon_mod._SETTINGS_GROUPS.items()
}
GROUP_OF: dict[str, str] = {
    key: group for group, keys in APP_GROUPS.items() for key in keys
}


def _group_stub(group: str) -> dict:
    """A backend double that serves the group's real key list."""
    body = {key: "" for key in APP_GROUPS[group]}
    if group == "embeddings":
        body = {"settings": body, "capability": {}}
    return {("GET", f"/api/settings/{group}"): body,
            ("PUT", f"/api/settings/{group}"): body}


# ---------------------------------------------------------------------------
# The partition
# ---------------------------------------------------------------------------

def test_every_settings_key_the_app_has_is_either_writable_or_withheld():
    """A new key is a decision someone has to make, not a default.

    This is the same shape as
    ``test_no_settings_group_the_app_has_is_silently_reachable`` one level
    down: the group allowlist forces a decision about a new *group*, and this
    forces one about a new *key*. The two lists must partition the app's real
    key list exactly — a key in neither is a key nobody classified, and a key
    in both is a contradiction.
    """
    app_keys = set(GROUP_OF)
    writable = set(mcp.SETTINGS_KEYS_WRITABLE)
    withheld = set(mcp.SETTINGS_KEYS_WITHHELD)

    assert writable & withheld == set(), "a key cannot be both"
    assert writable | withheld == app_keys, {
        "unclassified": sorted(app_keys - (writable | withheld)),
        "named_here_but_not_in_the_app": sorted((writable | withheld) - app_keys),
    }
    assert len(app_keys) == 41, (
        "the app's key count moved; the lists above need the same decision "
        "made about whatever changed"
    )


def test_every_withheld_key_carries_the_reason_it_is_withheld():
    """An exclusion a reviewer cannot read is an exclusion nobody checked."""
    for key, reason in mcp.SETTINGS_KEYS_WITHHELD.items():
        assert reason.strip(), key
        assert len(reason) > 15, f"{key}: {reason!r} does not say anything"


def test_every_key_the_route_digest_reads_is_withheld():
    """Seeded from the codebase's own notion of a route, not from taste.

    ``assistant_choices.route_digest`` hashes the settings that decide where a
    turn goes, and ``get_bound_runtime`` refuses to continue a conversation
    whose digest moved — so the codebase already treats these as the
    security-relevant ones. That guard notices a change *after* it is made and
    only for an already-bound conversation; this one stops the write. Driving
    the real function over the app's whole key list is what keeps the two from
    drifting apart, since neither file imports the other.
    """
    from implementation_scripts import assistant_choices

    branches = [("claude_cli", "claude_code"), ("api_key", "custom"),
                ("api_key", "anthropic")]
    moves_a_route: set[str] = set()
    for runtime, provider in branches:
        baseline = {key: "" for key in GROUP_OF}
        before = assistant_choices.route_digest(baseline, runtime, provider)
        for key in GROUP_OF:
            probe = dict(baseline, **{key: "/somewhere/else"})
            if assistant_choices.route_digest(probe, runtime, provider) != before:
                moves_a_route.add(key)

    assert moves_a_route, "the probe stopped reaching route_digest at all"
    assert moves_a_route <= set(mcp.SETTINGS_KEYS_WITHHELD), (
        "a setting that moves the assistant's route digest is writable: "
        f"{sorted(moves_a_route - set(mcp.SETTINGS_KEYS_WITHHELD))}"
    )


# ---------------------------------------------------------------------------
# The refusal
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("key", sorted(GROUP_OF))
def test_a_key_is_writable_only_if_it_is_on_the_allowlist(key):
    """Every one of the app's keys, through the real tool, both ways.

    Parametrised over the app's key list rather than over a sample, so the
    denominator in the handback is the app's own and a key that changes sides
    has to change this file too.
    """
    group = GROUP_OF[key]
    stub = _stub(_group_stub(group))
    with stub:
        result = mcp.call_tool(
            "update_settings", {"group": group, "settings": {key: "a-value"}})

    if key in mcp.SETTINGS_KEYS_WITHHELD:
        assert result["isError"], f"{key} is withheld but the tool ran it"
        assert stub.seen == [], (
            f"{key} was refused but the backend was contacted anyway: "
            f"{stub.seen}")
        body = _payload(result)
        assert body["error"] == "invalid_argument"
        assert key in body["detail"]["refused_keys"]
    else:
        assert not result["isError"], f"{key} is writable but was refused: " \
                                      f"{_payload(result)}"
        assert any(call["method"] == "PUT" for call in stub.seen)


@pytest.mark.parametrize("key", [
    "ai_cli_path", "ai_custom_base_url", "ai_local_endpoint", "ai_provider",
    "assistant_runtime", "smtp_server", "smtp_to", "export_directory",
])
def test_the_keys_the_audit_named_are_refused_before_any_request_is_built(key):
    """The named cases, spelled out, so the regression is legible in the diff.

    Refused on the name before the group is fetched: a harness that can reach
    this tool at all never gets as far as a request that would change where
    resmon sends a key or what it executes.
    """
    group = GROUP_OF[key]
    stub = _stub(_group_stub(group))
    with stub:
        result = mcp.call_tool(
            "update_settings", {"group": group, "settings": {key: "/tmp/other"}})

    assert result["isError"]
    assert stub.seen == []
    assert "/tmp/other" not in json.dumps(_payload(result)), (
        "the refusal echoed the value it was refusing")


def test_a_refusal_names_every_withheld_key_in_a_mixed_call():
    """One withheld key poisons the call; the writable ones do not go through.

    A partial write would be the worst answer: the caller is told "some of
    that" and the diff it reads back is about a different set of keys than the
    one it asked for.
    """
    stub = _stub(_group_stub("ai"))
    with stub:
        result = mcp.call_tool("update_settings", {"group": "ai", "settings": {
            "ai_tone": "plain", "ai_cli_path": "/tmp/x",
            "ai_custom_base_url": "http://elsewhere.invalid"}})

    assert result["isError"]
    assert stub.seen == []
    body = _payload(result)
    assert body["detail"]["refused_keys"] == ["ai_cli_path", "ai_custom_base_url"]


def test_a_key_the_app_grows_later_is_withheld_until_someone_lists_it():
    """Default-deny. An unlisted name is refused before the group is read.

    The old guard's default was the other way round: a key was writable unless
    its name contained one of seven words, so every key the app grew arrived
    writable and nobody had to say so.
    """
    stub = _stub(_group_stub("ai"))
    with stub:
        result = mcp.call_tool("update_settings", {
            "group": "ai", "settings": {"ai_future_thing": "x"}})

    assert result["isError"]
    assert stub.seen == [], "an unlisted key must not reach the backend"


def test_a_credential_shaped_name_still_gets_the_credential_sentence():
    """The older, more specific refusal survives the allowlist above it.

    ``anthropic_api_key`` is not an app setting at all, so the allowlist alone
    would answer "that is not a setting this tool can change" — true, and less
    useful than "resmon's API keys live in the system keychain". The specific
    sentence is kept and checked first.
    """
    stub = _stub({})
    with stub:
        result = mcp.call_tool("update_settings", {
            "group": "ai", "settings": {"anthropic_api_key": "sk-real-value"}})

    body = _payload(result)
    assert result["isError"]
    assert stub.seen == []
    assert "keychain" in body["message"]
    assert "sk-real-value" not in json.dumps(body)


# ---------------------------------------------------------------------------
# What stays reachable
# ---------------------------------------------------------------------------

def test_the_reason_the_ai_group_is_reachable_at_all_still_works():
    """"Use opus for the assistant" is the likeliest thing anyone will ask.

    The comment above ``SETTINGS_GROUPS`` says the ``ai`` group is reachable
    deliberately for exactly this. Narrowing the key list must not take that
    away, so the model and effort keys on both lanes are checked by name.
    """
    for group, key in (("ai", "ai_model"), ("ai", "ai_effort"),
                       ("assistant", "assistant_model"),
                       ("assistant", "assistant_effort")):
        stub = _stub(_group_stub(group))
        with stub:
            result = mcp.call_tool(
                "update_settings", {"group": group, "settings": {key: "opus"}})
        assert not result["isError"], f"{group}/{key}: {_payload(result)}"


def test_every_group_on_the_allowlist_still_has_a_key_a_tool_can_change():
    """A group reachable in name only would be a lie in the tool's schema.

    ``SETTINGS_GROUPS`` is advertised as an enum on the ``group`` argument. A
    group all of whose keys are withheld would accept the argument and refuse
    every call, which is worse than not offering it.
    """
    for group in mcp.SETTINGS_GROUPS:
        writable = [k for k in APP_GROUPS[group]
                    if k in mcp.SETTINGS_KEYS_WRITABLE]
        assert writable, f"'{group}' is offered but nothing in it is writable"
