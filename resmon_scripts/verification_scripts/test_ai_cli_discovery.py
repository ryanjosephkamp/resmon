"""CLI discovery for the subscription lane (1.8c).

The order — explicit path, then known install locations, then PATH — is the
whole point of the module, and it is not arbitrary. A Finder-launched macOS app
inherits ``/usr/bin:/bin:/usr/sbin:/sbin`` because ``launchctl getenv PATH`` is
unset, and neither agent CLI lives there: ``claude`` sits under a user-local
prefix and ``codex`` sits *inside* ChatGPT.app. A PATH-first implementation
passes every developer's manual test and fails on every shipped machine, so the
order is pinned here rather than left to be re-derived.
"""

import os
import stat

import pytest

from implementation_scripts.ai_cli import (
    SUPPORTED_CLI_PROVIDERS,
    CLIDiscovery,
    discover_cli,
    known_locations,
)


def _make_executable(path):
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


@pytest.fixture
def no_path(monkeypatch):
    """An environment where PATH finds nothing — the packaged-app case."""
    monkeypatch.setenv("PATH", "/nonexistent-resmon-test-dir")
    return None


# ---------------------------------------------------------------------------
# Order
# ---------------------------------------------------------------------------

def test_explicit_path_wins_over_everything(tmp_path, monkeypatch):
    """A path the user set is used even when PATH would also find something."""
    chosen = _make_executable(tmp_path / "chosen")
    other_dir = tmp_path / "bin"
    other_dir.mkdir()
    _make_executable(other_dir / "claude")
    monkeypatch.setenv("PATH", str(other_dir))

    result = discover_cli("claude_code", chosen)

    assert result.found
    assert result.path == chosen
    assert result.how == "configured"


def test_known_location_is_preferred_over_path(tmp_path, monkeypatch):
    """The installer's location beats PATH, because PATH is the unreliable one."""
    installed = _make_executable(tmp_path / "installed-claude")
    on_path_dir = tmp_path / "bin"
    on_path_dir.mkdir()
    _make_executable(on_path_dir / "claude")
    monkeypatch.setenv("PATH", str(on_path_dir))
    monkeypatch.setattr(
        "implementation_scripts.ai_cli._KNOWN_LOCATIONS",
        {"darwin": {"claude_code": (installed,)}},
    )

    result = discover_cli("claude_code", platform="darwin")

    assert result.path == installed
    assert result.how == "known-location"


def test_path_is_the_last_resort(tmp_path, monkeypatch):
    """PATH still works — it is last, not absent."""
    on_path_dir = tmp_path / "bin"
    on_path_dir.mkdir()
    expected = _make_executable(on_path_dir / "claude")
    monkeypatch.setenv("PATH", str(on_path_dir))
    monkeypatch.setattr(
        "implementation_scripts.ai_cli._KNOWN_LOCATIONS",
        {"darwin": {"claude_code": ("/nonexistent/claude",)}},
    )

    result = discover_cli("claude_code", platform="darwin")

    assert result.path == expected
    assert result.how == "path"


# ---------------------------------------------------------------------------
# Not finding things
# ---------------------------------------------------------------------------

def test_a_bad_explicit_path_fails_rather_than_falling_through(tmp_path, monkeypatch):
    """Naming a path resmon cannot use is an error, not a hint.

    Falling through to a different binary than the one the user named would be
    worse than failing: they would be debugging a lane that is not the lane
    they configured.
    """
    on_path_dir = tmp_path / "bin"
    on_path_dir.mkdir()
    _make_executable(on_path_dir / "claude")
    monkeypatch.setenv("PATH", str(on_path_dir))

    result = discover_cli("claude_code", str(tmp_path / "does-not-exist"))

    assert not result.found
    assert result.how == "not-found"


def test_a_file_that_is_not_executable_is_not_a_find(tmp_path, no_path):
    """Exists is not the same as runnable, and saying so saves a wrong diagnosis."""
    candidate = tmp_path / "claude"
    candidate.write_text("#!/bin/sh\nexit 0\n")
    candidate.chmod(0o644)

    assert not discover_cli("claude_code", str(candidate)).found


def test_a_directory_is_not_a_find(tmp_path, no_path):
    target = tmp_path / "claude"
    target.mkdir()
    assert not discover_cli("claude_code", str(target)).found


def test_nothing_found_reports_where_it_looked(monkeypatch, no_path):
    """'Not found' alone sends people to reinstall a CLI they already have."""
    monkeypatch.setattr(
        "implementation_scripts.ai_cli._KNOWN_LOCATIONS",
        {"darwin": {"codex": ("/nonexistent/one", "/nonexistent/two")},
         "linux": {"codex": ()}},
    )
    result = discover_cli("codex", platform="darwin")

    assert not result.found
    assert "/nonexistent/one" in result.tried
    assert "/nonexistent/two" in result.tried
    assert any("PATH" in entry for entry in result.tried)


def test_unknown_provider_is_not_found(no_path):
    assert not discover_cli("some_other_agent").found


# ---------------------------------------------------------------------------
# What the user is told
# ---------------------------------------------------------------------------

def test_path_discovery_warns_about_the_packaged_app(tmp_path, monkeypatch):
    """Found-on-PATH carries the caveat, because that is the case that breaks."""
    on_path_dir = tmp_path / "bin"
    on_path_dir.mkdir()
    _make_executable(on_path_dir / "codex")
    monkeypatch.setenv("PATH", str(on_path_dir))
    monkeypatch.setattr(
        "implementation_scripts.ai_cli._KNOWN_LOCATIONS", {"darwin": {"codex": ()}},
    )

    detail = discover_cli("codex", platform="darwin").describe()

    assert "PATH" in detail
    assert "Finder" in detail


def test_describe_never_claims_the_cli_is_logged_in(tmp_path, no_path):
    """Finding a file establishes nothing about authentication."""
    found = discover_cli("claude_code", _make_executable(tmp_path / "claude"))
    text = found.describe().lower()
    assert "logged in" not in text
    assert "ready" not in text
    assert "signed in" not in text


def test_to_dict_is_serialisable_and_complete(tmp_path, no_path):
    payload = discover_cli("codex", _make_executable(tmp_path / "codex")).to_dict()
    assert payload["found"] is True
    assert set(payload) == {"provider", "path", "how", "found", "tried", "detail"}
    assert isinstance(payload["tried"], list)


# ---------------------------------------------------------------------------
# The location table
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("provider", SUPPORTED_CLI_PROVIDERS)
@pytest.mark.parametrize("platform", ["darwin", "linux", "win32"])
def test_every_supported_provider_has_candidates_on_every_platform(provider, platform):
    assert known_locations(provider, platform), (provider, platform)


def test_codex_looks_inside_the_chatgpt_bundle_on_macos():
    """The verified macOS location, and the reason the table exists at all.

    codex ships inside ChatGPT.app and is on no PATH anywhere. If this entry
    is lost, the lane silently stops working in the packaged app while
    continuing to work in every developer's terminal.
    """
    candidates = known_locations("codex", "darwin")
    assert any("ChatGPT.app" in c for c in candidates)


def test_claude_looks_in_the_user_local_prefix_on_macos():
    candidates = known_locations("claude_code", "darwin")
    assert any(c.startswith("~/.local/bin") for c in candidates)


def test_an_unknown_platform_falls_back_rather_than_returning_nothing():
    """A platform not in the table still gets candidates and PATH, not silence."""
    assert known_locations("claude_code", "freebsd13")
