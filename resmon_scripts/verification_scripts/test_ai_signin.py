"""Checking an agent CLI's sign-in, and opening its own login, with fake binaries.

No real ``claude`` or ``codex`` is run here, in any form. The status commands
are stood in for by small scripts that print what a signed-in, signed-out,
expired or unreadable command might print, and the parser is held to saying
"signed in" only when the command said so.

What this cannot establish: the exact JSON the real ``claude auth status``
prints. That shape is not documented, which is why the parser reads only
fields that are present and falls back to the command's own words.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from implementation_scripts import ai_signin


# ---------------------------------------------------------------------------
# Parsing what a status command printed
# ---------------------------------------------------------------------------

def test_claude_json_signed_in_shows_email_and_plan():
    out = json.dumps({"loggedIn": True, "authMethod": "claude.ai",
                      "email": "reader@example.com", "subscriptionType": "max"})
    parsed = ai_signin.parse_status("claude_code", out, "", 0)
    assert parsed["state"] == "signed_in"
    assert parsed["email"] == "reader@example.com"
    assert parsed["plan"] == "max"
    assert parsed["said"] is None


def test_claude_json_signed_out():
    out = json.dumps({"loggedIn": False, "authMethod": "none"})
    parsed = ai_signin.parse_status("claude_code", out, "", 1)
    assert parsed["state"] == "signed_out"
    assert parsed["email"] is None


def test_claude_json_that_says_its_sign_in_expired():
    out = json.dumps({"loggedIn": False, "error": "OAuth session expired and could not be refreshed"})
    assert ai_signin.parse_status("claude_code", out, "", 1)["state"] == "expired"


def test_nested_fields_are_read_where_they_are():
    out = json.dumps({"authenticated": True, "account": {"emailAddress": "a@b.org", "plan": "pro"}})
    parsed = ai_signin.parse_status("claude_code", out, "", 0)
    assert (parsed["state"], parsed["email"], parsed["plan"]) == ("signed_in", "a@b.org", "pro")


def test_json_with_no_yes_or_no_is_unknown_even_with_an_email():
    """An email alone is not the command saying it is signed in."""
    out = json.dumps({"email": "reader@example.com", "status": "ok"})
    parsed = ai_signin.parse_status("claude_code", out, "", 0)
    assert parsed["state"] == "unknown"
    assert parsed["email"] == "reader@example.com"
    # The JSON itself is never repeated as "what it said".
    assert parsed["said"] is None


def test_odd_text_is_unknown_and_carries_the_commands_own_words():
    parsed = ai_signin.parse_status("claude_code", "Checking credentials... done\n", "", 0)
    assert parsed["state"] == "unknown"
    assert parsed["said"] == "Checking credentials... done"


@pytest.mark.parametrize("stdout, stderr, code, state, method", [
    ("Logged in using ChatGPT\n", "", 0, "signed_in", "ChatGPT"),
    ("", "Logged in using ChatGPT\n", 0, "signed_in", "ChatGPT"),
    ("Logged in using an API key - sk-proj-***ABCD\n", "", 0, "signed_in", "an API key"),
    ("Not logged in\n", "", 1, "signed_out", None),
    ("", "Your access token could not be refreshed. Please log in again.\n", 1, "expired", None),
    # Words that say signed in, from a command that failed, are not trusted.
    ("Logged in using ChatGPT\n", "", 2, "unknown", None),
])
def test_codex_status_words(stdout, stderr, code, state, method):
    parsed = ai_signin.parse_status("codex", stdout, stderr, code)
    assert parsed["state"] == state
    assert parsed["method"] == method


def test_a_key_in_the_output_never_reaches_what_is_shown():
    secret = "sk-ant-" + "a" * 40
    parsed = ai_signin.parse_status("claude_code", f"unexpected: {secret}\n", "", 0)
    assert secret not in json.dumps(parsed)


# ---------------------------------------------------------------------------
# Running a fake status command
# ---------------------------------------------------------------------------

def _fake(tmp_path: Path, body: str, name: str = "claude") -> str:
    """An executable that prints *body* (a Python snippet) and records its argv and env."""
    path = tmp_path / name
    record = tmp_path / f"{name}.argv.json"
    path.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        f"open({str(record)!r}, 'w').write(json.dumps({{'argv': sys.argv[1:], "
        "'resmon': sorted(k for k in os.environ if k.startswith('RESMON_'))}))\n"
        + body,
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


def _ran(tmp_path: Path, name: str = "claude") -> dict:
    return json.loads((tmp_path / f"{name}.argv.json").read_text(encoding="utf-8"))


def test_signed_in_through_a_fake_claude(tmp_path, monkeypatch):
    monkeypatch.setenv("RESMON_PORT", "9999")
    binary = _fake(tmp_path, "print(json.dumps({'loggedIn': True, 'email': 'r@example.com', "
                             "'subscriptionType': 'max'}))\n")
    result = ai_signin.check_sign_in("claude_code", binary)
    assert result["state"] == "signed_in"
    assert result["message"] == "The Claude Code command is signed in as r@example.com (max)."
    assert result["command"].endswith("auth status --json")
    ran = _ran(tmp_path)
    assert ran["argv"] == ["auth", "status", "--json"]
    # The environment the lanes use: the person's own, minus resmon's.
    assert ran["resmon"] == []


def test_not_signed_in_through_a_fake_claude(tmp_path):
    binary = _fake(tmp_path, "print(json.dumps({'loggedIn': False}))\nsys.exit(1)\n")
    result = ai_signin.check_sign_in("claude_code", binary)
    assert result["state"] == "signed_out"
    assert result["message"] == "The Claude Code command on this computer is not signed in."


def test_expired_through_a_fake_codex(tmp_path):
    binary = _fake(tmp_path, "sys.stderr.write('Error: token expired, run codex login\\n')\nsys.exit(1)\n",
                   name="codex")
    result = ai_signin.check_sign_in("codex", binary)
    assert result["state"] == "expired"
    assert _ran(tmp_path, "codex")["argv"] == ["login", "status"]
    assert "expired" in result["message"]


def test_odd_output_through_a_fake_claude(tmp_path):
    binary = _fake(tmp_path, "print('Checking credentials... done')\n")
    result = ai_signin.check_sign_in("claude_code", binary)
    assert result["state"] == "unknown"
    assert result["message"] == ("The Claude Code command did not say whether it is signed in. "
                                 "It said: Checking credentials... done")


def test_a_missing_binary_says_so_and_runs_nothing():
    result = ai_signin.check_sign_in("claude_code", None, not_found="No claude executable was found.")
    assert result["state"] == "missing"
    assert result["message"] == "No claude executable was found."


def test_a_binary_that_cannot_run_is_a_failure_not_an_exception(tmp_path):
    path = tmp_path / "claude"
    path.write_text("not a program", encoding="utf-8")       # not executable
    result = ai_signin.check_sign_in("claude_code", str(path))
    assert result["state"] == "failed"


def test_a_status_command_that_hangs_is_given_up_on(tmp_path, monkeypatch):
    monkeypatch.setattr(ai_signin, "STATUS_TIMEOUT_SECONDS", 1)
    binary = _fake(tmp_path, "import time\ntime.sleep(30)\n")
    result = ai_signin.check_sign_in("claude_code", binary)
    assert result["state"] == "failed"
    assert "did not answer" in result["message"]


# ---------------------------------------------------------------------------
# The .command script, and opening it
# ---------------------------------------------------------------------------

def test_the_script_runs_the_commands_own_login_and_says_where_to_go_next():
    script = ai_signin.sign_in_script("claude_code", "/Users/r/.local/bin/claude")
    assert script.startswith("#!/bin/sh\n")
    assert "\n/Users/r/.local/bin/claude auth login\n" in script
    assert "Return to resmon and choose Check again." in script
    assert "does not\n# see or keep the sign-in" in script
    codex = ai_signin.sign_in_script("codex", "/Applications/ChatGPT.app/Contents/Resources/codex")
    assert "\n/Applications/ChatGPT.app/Contents/Resources/codex login\n" in codex


def test_a_binary_path_with_spaces_is_one_argument(tmp_path):
    """Quoted for sh, and proven by running the script against a fake login."""
    folder = tmp_path / "My Tools (beta)"
    folder.mkdir()
    binary = _fake(folder, "print('fake login ran')\n")
    script_text = ai_signin.sign_in_script("claude_code", binary)
    assert f"'{binary}' auth login" in script_text
    script = tmp_path / "sign-in.command"
    script.write_text(script_text, encoding="utf-8")
    script.chmod(0o700)
    completed = subprocess.run(["/bin/sh", str(script)], capture_output=True, text=True,
                               env={**os.environ, "TERM": "dumb"}, timeout=20)
    assert completed.returncode == 0, completed.stderr
    assert "fake login ran" in completed.stdout
    assert "Done. Return to resmon and choose Check again." in completed.stdout
    assert _ran(folder)["argv"] == ["auth", "login"]
    # The script removed itself.
    assert not script.exists()


def test_on_macos_the_script_is_written_to_the_state_directory_and_opened(tmp_path):
    calls = []

    def opener(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    result = ai_signin.open_sign_in("claude_code", "/opt/claude bin/claude", tmp_path,
                                    platform="darwin", opener=opener)
    script = tmp_path / "sign-in" / "resmon-sign-in-claude-code.command"
    assert calls == [["open", str(script)]]
    assert result["opened"] is True and result["how"] == "terminal"
    assert result["command"] == "'/opt/claude bin/claude' auth login"
    assert script.read_text(encoding="utf-8") == ai_signin.sign_in_script(
        "claude_code", "/opt/claude bin/claude")
    assert stat.S_IMODE(script.stat().st_mode) == 0o700


def test_when_open_fails_the_command_is_given_to_copy(tmp_path):
    def opener(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 1, "", "no application")

    result = ai_signin.open_sign_in("codex", "/usr/local/bin/codex", tmp_path,
                                    platform="darwin", opener=opener)
    assert result["opened"] is False and result["how"] == "copy"
    assert result["command"] == "/usr/local/bin/codex login"
    assert not (tmp_path / "sign-in" / "resmon-sign-in-codex.command").exists()


@pytest.mark.parametrize("platform, command", [
    ("linux", "'/home/r/my bin/claude' auth login"),
    ("win32", '"C:\\Program Files\\claude\\claude.exe" auth login'),
])
def test_elsewhere_the_command_is_given_to_copy_and_nothing_is_opened(tmp_path, platform, command):
    def opener(argv, **kwargs):                          # pragma: no cover - must not run
        raise AssertionError("nothing is opened here")

    binary = "C:\\Program Files\\claude\\claude.exe" if platform == "win32" else "/home/r/my bin/claude"
    result = ai_signin.open_sign_in("claude_code", binary, tmp_path, platform=platform, opener=opener)
    assert result == {"provider": "claude_code", "command": command, "path": binary,
                      "opened": False, "how": "copy", "message": result["message"]}
    assert "then choose Check again" in result["message"]
    assert not (tmp_path / "sign-in").exists()


def test_no_binary_means_nothing_to_open(tmp_path):
    result = ai_signin.open_sign_in("claude_code", None, tmp_path, not_found="Not found.",
                                    platform="darwin")
    assert result["how"] == "none" and result["opened"] is False
    assert result["message"] == "Not found."
