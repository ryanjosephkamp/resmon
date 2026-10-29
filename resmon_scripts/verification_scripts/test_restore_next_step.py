"""What a staged restore tells the user will apply it.

A restore runs when a backend starts. With the background service, reopening
the window is not a start: the service keeps running, so the old "Restart
resmon to restore" left the restore staged however often the window was
reopened. And where another service holds the lock, a window's own backend
refuses the restore at start. Each case gets the sentence that is true of it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

import resmon as resmon_mod  # noqa: E402
from implementation_scripts import daemon  # noqa: E402


def _lock(monkeypatch, payload):
    monkeypatch.setattr(daemon, "read_lock", lambda: payload)


def test_this_process_is_the_service_so_the_service_must_restart(monkeypatch):
    _lock(monkeypatch, {"pid": os.getpid(), "port": 8742})
    assert resmon_mod._how_a_staged_restore_runs()[0] == "service_restart"
    sentence = resmon_mod._when_a_staged_restore_runs()
    assert "background service holds your database" in sentence
    assert "not when you reopen this window" in sentence
    assert resmon_mod._restart_instructions()[0] in sentence
    assert sentence.endswith("Nothing has changed yet.")


def test_another_live_service_holds_the_lock(monkeypatch):
    # The parent of this test process is alive and is not this process.
    other = os.getppid()
    _lock(monkeypatch, {"pid": other, "port": 8742})
    # Restarting the app would not restore: its own backend would refuse.
    assert resmon_mod._how_a_staged_restore_runs()[0] == "service_stopped"
    sentence = resmon_mod._when_a_staged_restore_runs()
    assert f"Another resmon background service is running (pid {other})" in sentence
    assert "will not replace the database while it holds it" in sentence


def test_a_stale_lock_or_none_means_reopening_restores(monkeypatch):
    _lock(monkeypatch, None)
    assert resmon_mod._how_a_staged_restore_runs() == (
        "app_restart", "Quit resmon and open it again to restore. Nothing has changed yet.")
    # A pid no process has: what a crashed service leaves behind.
    _lock(monkeypatch, {"pid": 2 ** 22 + 12345, "port": 8742})
    assert resmon_mod._how_a_staged_restore_runs()[0] == "app_restart"
    assert resmon_mod._when_a_staged_restore_runs().startswith("Quit resmon and open it again")


def test_each_platform_names_a_real_restart(monkeypatch):
    for platform, expected in (
        ("darwin", "launchctl kickstart -k gui/$(id -u)/com.resmon.daemon"),
        ("linux", "systemctl --user restart resmon-daemon"),
        ("win32", "Task Scheduler"),
    ):
        monkeypatch.setattr(sys, "platform", platform)
        assert expected in resmon_mod._restart_instructions()[0]
