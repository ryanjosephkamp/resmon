"""The background service and launchd, against a stand-in for launchctl.

Every case here runs the macOS code path on a label of the suite's own
(``com.resmon.verification``, set in ``conftest.py``) and points
``RESMON_LAUNCHCTL`` at ``fixtures/fake_launchctl.py``, a small launchd held in
a JSON file. Nothing addresses the service a person runs, and nothing is
started: the stand-in records what it was asked and answers as launchctl does.

What it pins, each from a way the service went wrong:

* installing over a loaded job stops it first, where launchd refused the
  bootstrap and Settings answered HTTP 500;
* a stop that fails keeps the unit file, where the file was removed and
  Settings said "Not installed" while launchd went on restarting the job;
* installing or removing from the service's own engine is handed to a process
  outside the job, where the job was stopped under the request and never
  started again;
* macOS's Allow in the Background turned off is said, not retried.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import resmon as resmon_mod
from implementation_scripts import service_manager as sm

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="launchd's paths and process groups are POSIX")

LABEL = "com.resmon.verification"


class Launchd:
    """The stand-in's state, as a test reads and sets it."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def read(self) -> dict:
        return json.loads(self.path.read_text()) if self.path.exists() else {}

    def set(self, **values: object) -> None:
        state = self.read()
        state.update(values)
        self.path.write_text(json.dumps(state))

    def commands(self) -> list[str]:
        return [call[0] for call in self.read().get("calls", [])]

    def loaded(self) -> dict:
        return self.read().get("loaded", {})


@pytest.fixture
def launchd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Launchd:
    assert os.environ["RESMON_SERVICE_LABEL"] == LABEL
    state = tmp_path / "launchd.json"
    monkeypatch.setenv("FAKE_LAUNCHCTL_STATE", str(state))
    monkeypatch.setenv("RESMON_SERVICE_UNIT_DIR", str(tmp_path / "units"))
    monkeypatch.setattr(sm, "sys", SimpleNamespace(platform="darwin", executable=sys.executable))
    monkeypatch.setattr(sm, "_BOOTOUT_WAIT_SEC", 1.0)
    return Launchd(state)


def _install(**kwargs: object) -> sm.Outcome:
    return sm.install_unit(python=sys.executable, port=45990, register=True, **kwargs)


def test_the_unit_is_named_for_the_label_and_carries_it(launchd: Launchd) -> None:
    path = _install().path
    assert path.name == f"{LABEL}.plist"
    assert f"<string>{LABEL}</string>" in path.read_text()
    assert "com.resmon.daemon" not in path.read_text()


def test_a_label_launchd_would_not_take_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RESMON_SERVICE_LABEL", "com.resmon.x; rm -rf ~")
    with pytest.raises(ValueError):
        sm.service_label()


def test_install_starts_a_service_that_is_not_loaded(launchd: Launchd) -> None:
    assert sm.launchd_job().loaded is False
    _install()
    assert launchd.commands().count("bootstrap") == 1
    assert "bootout" not in launchd.commands()
    job = sm.launchd_job()
    assert job.loaded and job.pid == 4242


def test_install_over_a_loaded_job_stops_it_first(launchd: Launchd) -> None:
    # Another build's service, running under the label.
    launchd.set(loaded={LABEL: 1000})
    _install()
    calls = launchd.commands()
    assert calls.index("bootout") < calls.index("bootstrap")
    assert launchd.loaded() == {LABEL: 4242}


def test_install_when_macos_has_turned_it_off_says_so_and_writes_nothing(launchd: Launchd) -> None:
    launchd.set(disabled=[LABEL])
    with pytest.raises(sm.ServiceBlockedError) as said:
        _install()
    assert "Allow in the Background" in str(said.value)
    assert "bootstrap" not in launchd.commands()
    assert not sm.unit_path().exists()


def test_uninstall_stops_the_job_and_then_removes_the_file(launchd: Launchd) -> None:
    _install()
    done = sm.uninstall_unit(deregister=True)
    assert done.removed and not done.restarting
    assert launchd.loaded() == {}
    assert not sm.unit_path().exists()


def test_a_stop_that_fails_keeps_the_file_and_says_so(launchd: Launchd) -> None:
    _install()
    launchd.set(stuck=[LABEL])
    with pytest.raises(RuntimeError) as said:
        sm.uninstall_unit(deregister=True)
    assert "still installed" in str(said.value)
    assert "Boot-out failed: 5" in str(said.value)
    assert sm.unit_path().exists()
    assert sm.launchd_job().loaded


def test_uninstall_of_a_job_that_is_not_loaded_only_removes_the_file(launchd: Launchd) -> None:
    sm.install_unit(python=sys.executable, port=45990, register=False)
    assert sm.uninstall_unit(deregister=True).removed
    assert "bootout" not in launchd.commands()


def test_from_the_services_own_engine_a_process_outside_the_job_does_it(
        launchd: Launchd, monkeypatch: pytest.MonkeyPatch) -> None:
    # This process is the service's: its pid is the one launchd holds.
    launchd.set(loaded={LABEL: os.getpid()})
    handed: list[tuple[str, Path, object]] = []
    monkeypatch.setattr(sm, "_hand_off", lambda mode, path, app: handed.append((mode, path, app)))
    done = _install()
    assert done.restarting
    assert handed == [("replace", sm.unit_path(), None)]
    # Nothing was stopped from inside: the job still runs this process.
    assert "bootout" not in launchd.commands() and launchd.loaded() == {LABEL: os.getpid()}

    handed.clear()
    done = sm.uninstall_unit(deregister=True)
    assert done.restarting and not done.removed
    assert handed[0][0] == "remove"
    assert sm.unit_path().exists()


@pytest.mark.parametrize("mode", ["replace", "remove"])
def test_the_hand_off_stops_the_job_then_starts_it_again_or_removes_it(launchd: Launchd, mode: str) -> None:
    path = sm.install_unit(python=sys.executable, port=45990, register=False).path
    launchd.set(loaded={LABEL: 1000})
    # The script the hand-off starts, run here to its end, with no app to open.
    subprocess.run(["/bin/sh", "-c", sm._HAND_OFF, "hand-off", sm.launchctl_program(),
                    sm._target(), sm._domain(), str(path), mode, ""], check=True, timeout=60)
    if mode == "replace":
        assert launchd.loaded() == {LABEL: 4242}
        assert path.exists()
    else:
        assert launchd.loaded() == {}
        assert not path.exists()


def test_the_settings_routes_say_what_launchd_holds(launchd: Launchd) -> None:
    from fastapi.testclient import TestClient

    client = TestClient(resmon_mod.create_app())
    body = client.get("/api/service/status").json()
    assert body["installed"] is False and body["loaded"] is False and body["blocked"] is False

    answer = client.post("/api/service/install", json={"register": True, "port": 45990})
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"installed": True, "unit_path": str(sm.unit_path())}
    assert client.get("/api/service/status").json()["loaded"] is True

    launchd.set(stuck=[LABEL])
    refused = client.post("/api/service/uninstall", json={"register": True})
    assert refused.status_code == 500 and "still installed" in refused.text
    status = client.get("/api/service/status").json()
    assert status["installed"] is True and status["loaded"] is True

    launchd.set(stuck=[], disabled=[LABEL])
    blocked = client.post("/api/service/install", json={"register": True, "port": 45990})
    assert blocked.status_code == 409 and "Allow in the Background" in blocked.text
    assert client.get("/api/service/status").json()["blocked"] is True
