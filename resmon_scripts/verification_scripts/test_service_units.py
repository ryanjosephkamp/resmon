# resmon_scripts/verification_scripts/test_service_units.py
"""Verification tests for the OS service units + Advanced toggle.

Covers:
* Template rendering resolves every ``{{PLACEHOLDER}}`` for the current OS.
* ``install()`` writes the unit file to the override path.
* ``uninstall()`` removes it.
* ``POST /api/service/install`` and ``/api/service/uninstall`` endpoints
  return the documented shape and flip ``is_installed()``.
* ``GET /api/service/status`` reflects state transitions.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "resmon_scripts"))

from fastapi.testclient import TestClient

import resmon as resmon_mod
from implementation_scripts import service_manager


def _reset_app_db() -> None:
    resmon_mod._db_path = ":memory:"
    resmon_mod._shared_conn = None
    resmon_mod._db_initialized = False


@pytest.fixture
def unit_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("RESMON_SERVICE_UNIT_DIR", str(tmp_path / "units"))
    yield tmp_path / "units"


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------


def test_template_exists_for_each_platform():
    """All three template files exist in resmon_scripts/service_units/."""
    base = service_manager.TEMPLATES_DIR
    assert (base / "com.resmon.daemon.plist").exists()
    assert (base / "resmon-daemon.service").exists()
    assert (base / "resmon-daemon.task.xml").exists()


def test_render_resolves_all_placeholders_current_platform():
    rendered = service_manager.render_template(
        python="/opt/resmon/venv/bin/python",
        port=8742,
        workdir=Path("/opt/resmon/resmon_scripts"),
        log_dir=Path("/opt/resmon/logs"),
    )
    for placeholder in service_manager.REQUIRED_PLACEHOLDERS:
        assert placeholder not in rendered
    assert "/opt/resmon/venv/bin/python" in rendered
    assert "8742" in rendered
    assert "/opt/resmon/resmon_scripts" in rendered


@pytest.mark.parametrize("template_name,expected_markers", [
    ("com.resmon.daemon.plist", ["com.resmon.daemon", "RunAtLoad"]),
    ("resmon-daemon.service", ["[Service]", "ExecStart=", "WantedBy="]),
    ("resmon-daemon.task.xml", ["<Task", "implementation_scripts.daemon"]),
])
def test_render_each_template(template_name, expected_markers):
    tpl = service_manager.TEMPLATES_DIR / template_name
    rendered = service_manager.render_template(
        python="/usr/bin/python3",
        port=9000,
        workdir=Path("/tmp/resmon"),
        log_dir=Path("/tmp/resmon/logs"),
        template=tpl,
    )
    for marker in expected_markers:
        assert marker in rendered
    # Every required placeholder resolved (LOG_DIR may legitimately be unused
    # by the Windows XML template, and that's fine because render_template
    # already asserts nothing leaks through).
    for placeholder in service_manager.REQUIRED_PLACEHOLDERS:
        assert placeholder not in rendered


# ---------------------------------------------------------------------------
# install / uninstall on the filesystem
# ---------------------------------------------------------------------------


def test_install_writes_unit_file(unit_dir):
    assert not service_manager.is_installed()
    path = service_manager.install(port=8742, register=False)
    assert path.exists()
    assert service_manager.is_installed()
    assert path.read_text(encoding="utf-8").strip() != ""


def test_uninstall_removes_unit_file(unit_dir):
    service_manager.install(port=8742, register=False)
    assert service_manager.is_installed()
    removed = service_manager.uninstall(deregister=False)
    assert removed is True
    assert not service_manager.is_installed()


def test_uninstall_when_absent_returns_false(unit_dir):
    assert service_manager.uninstall(deregister=False) is False


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------


def test_service_status_endpoint(unit_dir):
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())
    resp = client.get("/api/service/status")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) >= {"installed", "unit_path", "platform"}
    assert body["installed"] is False


def test_service_install_uninstall_endpoints(unit_dir):
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())

    resp = client.post("/api/service/install", json={"register": False, "port": 8742})
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"installed": True, "unit_path": str(service_manager.unit_path())}
    assert Path(body["unit_path"]).exists()

    # Status reflects installation
    status = client.get("/api/service/status").json()
    assert status["installed"] is True

    resp = client.post("/api/service/uninstall", json={"register": False})
    assert resp.status_code == 200
    body = resp.json()
    assert body["installed"] is False
    assert body["removed"] is True
    assert not Path(body["unit_path"]).exists()

    status = client.get("/api/service/status").json()
    assert status["installed"] is False


def test_install_endpoint_default_body(unit_dir):
    """POST with no body should still succeed (register defaults to False)."""
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())
    resp = client.post("/api/service/install")
    assert resp.status_code == 200
    assert resp.json()["installed"] is True
    # Cleanup
    client.post("/api/service/uninstall")


# ---------------------------------------------------------------------------
# The service serves the database of the backend that installed it
# ---------------------------------------------------------------------------
#
# A packaged app's backend runs with RESMON_DB_PATH and RESMON_REPORTS_DIR set
# by Electron. A unit it installs must carry both, or the daemon opens a
# database inside the app bundle and the app attaches to it.

_MAC_STATE = {
    "RESMON_DB_PATH": "/Users/someone/Library/Application Support/resmon/resmon.db",
    "RESMON_REPORTS_DIR": "/Users/someone/Library/Application Support/resmon/resmon_reports",
}


def test_state_arguments_follow_the_installing_process():
    assert service_manager.state_arguments({}) == []
    assert service_manager.state_arguments(_MAC_STATE) == [
        "--db-path=/Users/someone/Library/Application Support/resmon/resmon.db",
        "--reports-dir=/Users/someone/Library/Application Support/resmon/resmon_reports",
    ]


def test_state_arguments_are_made_absolute(tmp_path, monkeypatch):
    # The daemon's working directory is the unit's, not the installer's.
    monkeypatch.chdir(tmp_path)
    [arg] = service_manager.state_arguments({"RESMON_DB_PATH": "state/resmon.db"})
    assert arg == f"--db-path={tmp_path / 'state' / 'resmon.db'}"


def test_plist_passes_each_state_path_as_one_argument():
    import plistlib

    rendered = service_manager.render_template(
        python="/Applications/resmon.app/Contents/Resources/backend/python/bin/python3",
        port=8742,
        workdir=Path("/Applications/resmon.app/Contents/Resources/backend/resmon_scripts"),
        log_dir=Path("/tmp/logs"),
        template=service_manager.TEMPLATES_DIR / "com.resmon.daemon.plist",
        state_args=service_manager.state_arguments(_MAC_STATE),
    )
    unit = plistlib.loads(rendered.encode("utf-8"))
    assert unit["ProgramArguments"] == [
        "/Applications/resmon.app/Contents/Resources/backend/python/bin/python3",
        "-m", "implementation_scripts.daemon", "8742",
        "--db-path=/Users/someone/Library/Application Support/resmon/resmon.db",
        "--reports-dir=/Users/someone/Library/Application Support/resmon/resmon_reports",
    ]


def test_plist_without_state_is_unchanged_from_a_checkout():
    import plistlib

    rendered = service_manager.render_template(
        python="/usr/bin/python3", port=8742, workdir=Path("/tmp/resmon"),
        log_dir=Path("/tmp/logs"),
        template=service_manager.TEMPLATES_DIR / "com.resmon.daemon.plist",
        state_args=[],
    )
    unit = plistlib.loads(rendered.encode("utf-8"))
    assert unit["ProgramArguments"] == [
        "/usr/bin/python3", "-m", "implementation_scripts.daemon", "8742",
    ]


def test_systemd_unit_quotes_state_paths():
    import shlex

    rendered = service_manager.render_template(
        python="/usr/bin/python3", port=8742, workdir=Path("/tmp/resmon"),
        log_dir=Path("/tmp/logs"),
        template=service_manager.TEMPLATES_DIR / "resmon-daemon.service",
        state_args=["--db-path=/home/a b/100%/$HOME/resmon.db"],
    )
    [line] = [l for l in rendered.splitlines() if l.startswith("ExecStart=")]
    # % and $ are systemd specifiers and variables; doubled, they are literal.
    assert line.endswith(' "--db-path=/home/a b/100%%/$$HOME/resmon.db"')
    words = shlex.split(line[len("ExecStart="):])
    assert words[-1] == "--db-path=/home/a b/100%%/$$HOME/resmon.db"
    assert words[:4] == ["/usr/bin/python3", "-m", "implementation_scripts.daemon", "8742"]


def test_task_xml_quotes_state_paths():
    import xml.etree.ElementTree as ET

    rendered = service_manager.render_template(
        python=r"C:\Program Files\resmon\python.exe", port=8742,
        workdir=Path(r"C:\resmon"), log_dir=Path(r"C:\logs"),
        template=service_manager.TEMPLATES_DIR / "resmon-daemon.task.xml",
        state_args=[r"--db-path=C:\Users\a & b\AppData\Local\resmon\resmon.db"],
    )
    root = ET.fromstring(rendered)
    [arguments] = [e.text for e in root.iter() if e.tag.endswith("Arguments")]
    assert arguments == (
        r'-m implementation_scripts.daemon 8742 "--db-path=C:\Users\a & b\AppData\Local\resmon\resmon.db"'
        r' "--log-dir=C:\logs"'
    )


def test_install_writes_the_installing_backends_state(unit_dir, monkeypatch):
    for variable, value in _MAC_STATE.items():
        monkeypatch.setenv(variable, value)
    text = service_manager.install(port=8742, register=False).read_text(encoding="utf-8")
    assert "--db-path=/Users/someone/Library/Application Support/resmon/resmon.db" in text
    assert "--reports-dir=/Users/someone/Library/Application Support/resmon/resmon_reports" in text


def test_daemon_flags_set_the_database_config_opens(tmp_path):
    """The flags reach ``config.DEFAULT_DB_PATH`` in a fresh process.

    A subprocess, because ``config`` reads the variables at import and this
    test process imported it long ago.
    """
    import subprocess

    db = tmp_path / "with space" / "resmon.db"
    reports = tmp_path / "with space" / "resmon_reports"
    env = {k: v for k, v in os.environ.items()
           if k not in ("RESMON_DB_PATH", "RESMON_REPORTS_DIR")}
    code = (
        "import sys; from implementation_scripts import daemon; "
        "daemon._apply_state_args(sys.argv); "
        "from implementation_scripts import config; "
        "print(config.DEFAULT_DB_PATH); print(config.REPORTS_DIR)"
    )
    out = subprocess.run(
        [sys.executable, "-c", code, "8742", f"--db-path={db}", f"--reports-dir={reports}"],
        cwd=PROJECT_ROOT / "resmon_scripts", env=env, capture_output=True, text=True,
        timeout=60, check=True,
    ).stdout.splitlines()
    assert out == [str(db), str(reports)]


# ---------------------------------------------------------------------------
# A unit installed from the packaged app runs the app
# ---------------------------------------------------------------------------
#
# The app is the background service: it starts the engine as its child and posts
# the engine's notifications as resmon. Electron tells the engine it starts the
# executable to run (RESMON_APP_EXECUTABLE), and a unit installed from that
# engine starts it with --service. Every unit here is rendered or written under a
# temporary folder; none is registered with the system.

_MAC_APP = "/Applications/resmon.app/Contents/MacOS/resmon"
_APPIMAGE = "/home/a b/Apps/resmon-1.0.0-x86_64.AppImage"
_WIN_APP = r"C:\Users\a\AppData\Local\Programs\resmon\resmon.exe"
_WIN_STATE = r"--db-path=C:\Users\a\AppData\Local\resmon\resmon.db"


def test_plist_runs_the_app_with_the_state_flags_and_keeps_the_service_alive():
    import plistlib

    rendered = service_manager.render_template(
        port=8742, log_dir=Path("/tmp/logs"),
        template=service_manager.TEMPLATES_DIR / "com.resmon.daemon.plist",
        state_args=service_manager.state_arguments(_MAC_STATE), app_executable=_MAC_APP,
    )
    unit = plistlib.loads(rendered.encode("utf-8"))
    assert unit["ProgramArguments"] == [
        _MAC_APP, "--service", "--port=8742",
        "--db-path=/Users/someone/Library/Application Support/resmon/resmon.db",
        "--reports-dir=/Users/someone/Library/Application Support/resmon/resmon_reports",
    ]
    assert unit["WorkingDirectory"] == "/Applications/resmon.app/Contents/MacOS"
    # The app exits 1 when its engine dies, and KeepAlive starts it again.
    assert unit["KeepAlive"] is True
    assert unit["RunAtLoad"] is True
    # The window resmon opens while the service runs is drawn by this process, so it runs as an app
    # does: Background put it in launchd's background band, and every scroll lagged.
    assert unit["ProcessType"] == "Interactive"


def test_systemd_unit_runs_the_appimage_file_and_restarts_it_on_failure():
    import shlex

    rendered = service_manager.render_template(
        port=9000, log_dir=Path("/tmp/logs"),
        template=service_manager.TEMPLATES_DIR / "resmon-daemon.service",
        state_args=["--db-path=/home/a b/resmon.db"], app_executable=_APPIMAGE,
    )
    [line] = [l for l in rendered.splitlines() if l.startswith("ExecStart=")]
    assert shlex.split(line[len("ExecStart="):]) == [_APPIMAGE, "--service", "--port=9000", "--db-path=/home/a b/resmon.db"]
    assert "implementation_scripts" not in line
    assert "WorkingDirectory=/home/a b/Apps" in rendered
    assert "Restart=on-failure" in rendered


def test_task_runs_at_normal_priority_since_it_draws_the_window():
    """Task Scheduler starts a task below normal (7) unless told otherwise; the service draws the
    window resmon opens while it runs, so it asks for normal (5)."""
    import xml.etree.ElementTree as ET

    rendered = service_manager.render_template(
        port=8742, log_dir=Path(r"C:\logs"),
        template=service_manager.TEMPLATES_DIR / "resmon-daemon.task.xml",
        state_args=[_WIN_STATE], app_executable=_WIN_APP,
    )
    root = ET.fromstring(rendered)
    assert [e.text for e in root.iter() if e.tag.endswith("Priority")] == ["5"]


def test_task_xml_runs_the_app_with_service_in_its_arguments():
    import xml.etree.ElementTree as ET

    rendered = service_manager.render_template(
        port=8742, log_dir=Path(r"C:\logs"),
        template=service_manager.TEMPLATES_DIR / "resmon-daemon.task.xml",
        state_args=[_WIN_STATE], app_executable=_WIN_APP,
    )
    root = ET.fromstring(rendered)
    [command] = [e.text for e in root.iter() if e.tag.endswith("Command")]
    [arguments] = [e.text for e in root.iter() if e.tag.endswith("Arguments")]
    assert command == _WIN_APP
    # --log-dir is how the engine, a child of an app with no console, opens its own log.
    assert arguments == rf'--service --port=8742 "{_WIN_STATE}" "--log-dir=C:\logs"'


@pytest.mark.parametrize("template", ["com.resmon.daemon.plist", "resmon-daemon.service", "resmon-daemon.task.xml"])
def test_each_template_still_runs_the_engine_when_there_is_no_app(template):
    rendered = service_manager.render_template(
        python="/usr/bin/python3", port=8742, workdir=Path("/tmp/resmon"), log_dir=Path("/tmp/logs"),
        template=service_manager.TEMPLATES_DIR / template, state_args=[],
    )
    assert "implementation_scripts.daemon" in rendered
    assert "--service" not in rendered
    assert "{{" not in rendered


def test_a_unit_installed_by_the_packaged_apps_engine_runs_the_app(unit_dir, monkeypatch):
    monkeypatch.setattr(service_manager.sys, "platform", "darwin")
    monkeypatch.setenv("RESMON_APP_EXECUTABLE", _MAC_APP)
    path = service_manager.install(port=8742, register=False)
    text = path.read_text(encoding="utf-8")
    assert "--service" in text and _MAC_APP in text
    assert "implementation_scripts" not in text
    assert service_manager.unit_runs() == "app"


def test_a_unit_installed_from_a_checkout_runs_the_engine(unit_dir, monkeypatch):
    monkeypatch.delenv("RESMON_APP_EXECUTABLE", raising=False)
    path = service_manager.install(port=8742, register=False)
    assert "implementation_scripts.daemon" in path.read_text(encoding="utf-8")
    assert service_manager.unit_runs() == "engine"


def test_naming_the_interpreter_asks_for_the_engine_even_in_the_packaged_app(unit_dir, monkeypatch):
    monkeypatch.setattr(service_manager.sys, "platform", "darwin")
    monkeypatch.setenv("RESMON_APP_EXECUTABLE", _MAC_APP)
    path = service_manager.install(python="/usr/bin/python3", port=8742, register=False)
    assert "implementation_scripts.daemon" in path.read_text(encoding="utf-8")
    assert service_manager.unit_runs() == "engine"


def test_unit_runs_says_nothing_without_a_unit(unit_dir):
    assert service_manager.unit_runs() is None


def test_the_app_forwards_the_flags_the_engine_reads():
    """The flags a unit gives the app are the flags the daemon reads."""
    from implementation_scripts import daemon

    assert {flag for _, flag in service_manager.STATE_ARGUMENTS} == set(daemon._STATE_FLAGS)
    host = (PROJECT_ROOT / "resmon_scripts" / "frontend" / "electron" / "host.ts").read_text(encoding="utf-8")
    for flag in (*daemon._STATE_FLAGS, "--log-dir"):
        assert f"'{flag}='" in host


def test_status_says_what_the_installed_unit_runs_and_whether_the_app_could(unit_dir, monkeypatch):
    _reset_app_db()
    client = TestClient(resmon_mod.create_app())
    monkeypatch.setattr(service_manager.sys, "platform", "darwin")
    monkeypatch.delenv("RESMON_APP_EXECUTABLE", raising=False)
    none = client.get("/api/service/status").json()
    assert (none["runs"], none["app_available"]) == (None, False)

    service_manager.install(port=8742, register=False)
    engine = client.get("/api/service/status").json()
    assert (engine["runs"], engine["app_available"]) == ("engine", False)

    # The same unit, seen by an engine the packaged app started: the app could run it.
    monkeypatch.setenv("RESMON_APP_EXECUTABLE", _MAC_APP)
    assert client.get("/api/service/status").json()["app_available"] is True
    service_manager.install(port=8742, register=False)
    assert client.get("/api/service/status").json()["runs"] == "app"


@pytest.mark.parametrize("platform", ["darwin", "win32"])
def test_the_app_is_the_service_on_macos_and_windows(platform, monkeypatch):
    monkeypatch.setattr(service_manager.sys, "platform", platform)
    monkeypatch.setenv("RESMON_APP_EXECUTABLE", _MAC_APP)
    assert service_manager.default_app_executable() == _MAC_APP


def test_linux_runs_the_engine_even_when_told_an_app(unit_dir, monkeypatch):
    """A systemd --user unit has no display, which Electron needs; the engine runs headless."""
    monkeypatch.setattr(service_manager.sys, "platform", "linux")
    monkeypatch.setenv("RESMON_APP_EXECUTABLE", _APPIMAGE)
    assert service_manager.default_app_executable() is None
    text = service_manager.install(port=8742, register=False).read_text(encoding="utf-8")
    assert "implementation_scripts.daemon" in text and "--service" not in text
    assert service_manager.unit_runs() == "engine"
    # So Settings has no app to offer, and never says the engine runs "on its own".
    _reset_app_db()
    status = TestClient(resmon_mod.create_app()).get("/api/service/status").json()
    assert (status["runs"], status["app_available"]) == ("engine", False)


# ---------------------------------------------------------------------------
# A unit must not point into a place that disappears
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path, temporary", [
    ("/private/var/folders/ab/T/AppTranslocation/6F1D/d/resmon.app/Contents/MacOS/resmon", True),
    ("/Volumes/resmon 1.0.0/resmon.app/Contents/MacOS/resmon", True),
    ("/Applications/resmon.app/Contents/MacOS/resmon", False),
    ("/Users/ada/Applications/resmon.app/Contents/MacOS/resmon", False),
    ("/opt/AppTranslocationTools/python3", False),
])
def test_which_paths_will_not_be_there_next_time(path, temporary):
    assert service_manager.runs_from_temporary_place(path) is temporary


@pytest.mark.parametrize("app, python", [
    ("/private/var/folders/ab/T/AppTranslocation/6F1D/d/resmon.app/Contents/MacOS/resmon", None),
    ("/Volumes/resmon/resmon.app/Contents/MacOS/resmon", None),
    (None, "/Volumes/resmon/resmon.app/Contents/Resources/backend/python/bin/python3"),
])
def test_installing_from_a_temporary_place_is_refused_in_either_form(unit_dir, app, python):
    with pytest.raises(service_manager.TemporaryPlaceError, match="move resmon to Applications"):
        service_manager.install(port=8742, register=False, app_executable=app, python=python)
    assert not service_manager.is_installed()


def test_the_install_route_says_so_in_one_sentence_and_writes_nothing(unit_dir, monkeypatch):
    _reset_app_db()
    monkeypatch.setattr(service_manager.sys, "platform", "darwin")
    monkeypatch.setenv("RESMON_APP_EXECUTABLE", "/Volumes/resmon/resmon.app/Contents/MacOS/resmon")
    client = TestClient(resmon_mod.create_app())
    response = client.post("/api/service/install", json={"register": False})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "move resmon to Applications" in detail and detail.count(". ") == 0
    assert not service_manager.is_installed()
