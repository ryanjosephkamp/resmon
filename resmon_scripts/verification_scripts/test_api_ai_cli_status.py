"""GET /api/settings/ai/cli-status — subscription-lane CLI detection (1.8c).

The endpoint's job is to tell the user where resmon looked and what it found.
The thing it must never do is imply more than it checked: it stats files, it
does not run the binary, so it cannot know whether anyone is signed in. Saying
"ready" here would be a claim nobody verified, and the first paper of a real
run would then be where the user discovers otherwise.
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

import resmon as resmon_mod
from implementation_scripts.ai_cli import SUPPORTED_CLI_PROVIDERS


def _client():
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False
    from resmon import app
    return TestClient(app)


def test_reports_every_supported_provider():
    resp = _client().get("/api/settings/ai/cli-status")
    assert resp.status_code == 200

    providers = resp.json()["providers"]
    assert {p["provider"] for p in providers} == set(SUPPORTED_CLI_PROVIDERS)


def test_each_entry_carries_the_paths_that_were_searched():
    """'Not found' without the paths sends people to reinstall what they have."""
    for entry in _client().get("/api/settings/ai/cli-status").json()["providers"]:
        assert isinstance(entry["tried"], list)
        assert entry["tried"], entry["provider"]
        assert entry["detail"]


def test_never_claims_the_cli_is_signed_in():
    for entry in _client().get("/api/settings/ai/cli-status").json()["providers"]:
        assert entry["login_checked"] is False
        lowered = entry["detail"].lower()
        assert "signed in" not in lowered
        assert "logged in" not in lowered
        assert "ready" not in lowered


def test_returns_no_credential_material():
    """A detection endpoint has no business touching secrets."""
    body = _client().get("/api/settings/ai/cli-status").text.lower()
    for forbidden in ("api_key", "token", "secret", "password"):
        assert forbidden not in body


def test_a_configured_path_only_applies_to_its_own_provider(monkeypatch, tmp_path):
    """One ai_cli_path setting must not be reported as both CLIs.

    The setting belongs to whichever provider the user selected. Applying it to
    every provider would show Codex as "found" at the path of the Claude
    binary, which is a wrong answer rather than a missing one.
    """
    import stat

    binary = tmp_path / "claude"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(binary.stat().st_mode | stat.S_IXUSR)

    monkeypatch.setattr(
        resmon_mod, "_get_settings_group",
        lambda conn, group: {
            "ai_provider": "claude_code",
            "ai_cli_path": str(binary),
        },
    )
    monkeypatch.setenv("PATH", "/nonexistent-resmon-test-dir")
    monkeypatch.setattr(
        "implementation_scripts.ai_cli._KNOWN_LOCATIONS",
        {"darwin": {"claude_code": (), "codex": ()},
         "linux": {"claude_code": (), "codex": ()},
         "win32": {"claude_code": (), "codex": ()}},
    )

    providers = {
        p["provider"]: p
        for p in _client().get("/api/settings/ai/cli-status").json()["providers"]
    }

    assert providers["claude_code"]["found"] is True
    assert providers["claude_code"]["how"] == "configured"
    assert providers["codex"]["found"] is False
