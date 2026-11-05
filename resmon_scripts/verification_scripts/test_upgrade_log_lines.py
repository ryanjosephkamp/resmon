"""What a start that upgrades an older database writes to the engine's output.

The copy kept before an upgrade (``upgrade_copy``) and the one-time recount of
earlier runs' new papers (``database.upgrade_logger``) each say what they did in
an INFO line. The engine writes those lines, and every warning and error, to
its standard error with the time (``logger.install_engine_log``); no other INFO
line goes there, and uvicorn keeps its own configuration.

The tests start the engine the two ways it is started, each in a child process
with a state folder of its own and a free port, on a database written by the
1.0 engine at schema 25 (``fixtures/collections/schema_25.sql``):

* the background service's engine (``implementation_scripts.daemon``), its
  standard streams the unit's two files in ``<state>/logs``, as launchd and
  ``systemd --user`` leave them, which is the log the service keeps;
* a window's engine (``resmon.py <port>``), whose standard error the app reads
  and writes to its own output, a line at a time.

A second start, on the database the first one upgraded, writes neither line.
"""

from __future__ import annotations

import io
import logging
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS))

from implementation_scripts import database, upgrade_copy  # noqa: E402
from implementation_scripts import logger as engine_logger  # noqa: E402

from test_local_api_auth import _LOOPBACK_ONLY, _free_port  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "collections" / "schema_25.sql"

#: The start of a line the engine's handler wrote: the time, then the level and the logger.
_STAMP = r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3}"
_ENGINE_INFO = re.compile(rf"^{_STAMP} INFO (\S+): ", re.M)


def _older_database(state: Path) -> Path:
    path = state / "resmon.db"
    conn = sqlite3.connect(path)
    try:
        conn.executescript(FIXTURE.read_text(encoding="utf-8"))
        conn.commit()
        assert database.get_schema_version(conn) == 25
    finally:
        conn.close()
    return path


def _start(how: str, state: Path) -> str:
    """Start the engine *how* it is started, on *state*, until it serves; what it wrote to standard error."""
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith("RESMON_")}
    env.update({
        "RESMON_STATE_DIR": str(state),
        "RESMON_PORT_FILE": str(state / "resmon.port"),
        "RESMON_CHROMIUM_PROFILE": str(state / "chromium"),
        "RESMON_DISABLE_SCHEDULER": "1",
        "RESMON_AI_CLI_DISCOVERY": "configured-only",
        "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": str(SCRIPTS),
    })
    if how == "service":
        logs = state / "logs"
        argv = ["module", "implementation_scripts.daemon", str(port),
                f"--db-path={state / 'resmon.db'}", f"--reports-dir={state / 'reports'}"]
    else:
        logs = state / "window-output"
        env["RESMON_DB_PATH"] = str(state / "resmon.db")
        env["RESMON_REPORTS_DIR"] = str(state / "reports")
        argv = ["script", str(SCRIPTS / "resmon.py"), str(port)]
    logs.mkdir(parents=True, exist_ok=True)
    err = logs / "resmon-daemon.err.log" if how == "service" else logs / f"stderr-{time.time_ns()}.log"
    out = logs / "resmon-daemon.out.log" if how == "service" else logs / f"stdout-{time.time_ns()}.log"
    offset = err.stat().st_size if err.exists() else 0
    with err.open("ab") as err_handle, out.open("ab") as out_handle:
        proc = subprocess.Popen([sys.executable, "-c", _LOOPBACK_ONLY, *argv],
                                cwd=SCRIPTS, env=env, stdout=out_handle, stderr=err_handle)
    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            written = err.read_bytes()[offset:].decode("utf-8", "replace")
            assert proc.poll() is None, written[-3000:]
            if "Uvicorn running on" in written:
                break
            time.sleep(0.2)
        else:
            pytest.fail(f"the {how} engine did not report that it was serving:\n{written[-3000:]}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
    return err.read_bytes()[offset:].decode("utf-8", "replace")


@pytest.mark.parametrize("how", ["service", "window"])
def test_an_upgrade_writes_both_lines_to_the_engines_output_and_a_current_start_neither(tmp_path, how):
    state = tmp_path / "state"
    state.mkdir()
    db = _older_database(state)
    copy = upgrade_copy.copy_path(db, 25)

    first = _start(how, state)

    assert copy.exists()
    kept = re.findall(
        rf"^{_STAMP} INFO {re.escape(upgrade_copy.logger.name)}: Kept a copy of the database before its "
        rf"upgrade from schema 25 to {database.SCHEMA_VERSION}: {re.escape(str(copy))}$", first, re.M)
    recounted = re.findall(
        rf"^{_STAMP} INFO {re.escape(database.upgrade_logger.name)}: Recounted which papers were new to "
        rf"earlier runs, once, from when each paper was first stored: .*The copy of the database kept "
        rf"before this start's upgrade is {re.escape(str(copy))}\.$", first, re.M)
    assert len(kept) == 1, first
    assert len(recounted) == 1, first
    # Only the upgrade's own loggers write INFO lines there.
    assert set(_ENGINE_INFO.findall(first)) <= set(engine_logger.UPGRADE_LOGGERS), first

    conn = sqlite3.connect(db)
    try:
        assert database.get_schema_version(conn) == database.SCHEMA_VERSION
    finally:
        conn.close()

    again = _start(how, state)

    assert "Uvicorn running on" in again
    assert "Kept a copy of the database" not in again, again
    assert "Recounted which papers were new" not in again, again
    assert not _ENGINE_INFO.findall(again), again


@pytest.fixture
def engine_log():
    """The engine's handler on the root logger, writing to a buffer, removed afterwards."""
    root = logging.getLogger()
    levels = {name: logging.getLogger(name).level for name in engine_logger.UPGRADE_LOGGERS}
    stream = io.StringIO()
    handler = engine_logger.install_engine_log(stream)
    try:
        yield handler, stream
    finally:
        root.removeHandler(handler)
        for name, level in levels.items():
            logging.getLogger(name).setLevel(level)


def test_the_handler_writes_warnings_and_the_upgrades_info_lines_and_nothing_else(engine_log):
    handler, stream = engine_log
    chatty = logging.getLogger("implementation_scripts.database")
    before = chatty.level
    chatty.setLevel(logging.INFO)
    try:
        upgrade_copy.logger.info("Kept a copy: %s", "here")
        database.upgrade_logger.info("Recounted: %d", 3)
        chatty.info("an INFO line of the rest of the module")
        logging.getLogger("implementation_scripts.sweep_engine").info("a run's INFO line")
        logging.getLogger("implementation_scripts.sweep_engine").debug("a run's DEBUG line")
        logging.getLogger("implementation_scripts.sweep_engine").warning("a warning")
        upgrade_copy.logger.warning("Not keeping a copy")
    finally:
        chatty.setLevel(before)

    lines = stream.getvalue().splitlines()
    assert [re.sub(rf"^{_STAMP} ", "", line) for line in lines] == [
        "INFO implementation_scripts.upgrade_copy: Kept a copy: here",
        "INFO implementation_scripts.database.upgrade: Recounted: 3",
        "WARNING implementation_scripts.sweep_engine: a warning",
        "WARNING implementation_scripts.upgrade_copy: Not keeping a copy",
    ]
    assert all(re.match(_STAMP, line) for line in lines)
    # Installed once: a second call hands back the same handler.
    assert engine_logger.install_engine_log(io.StringIO()) is handler
    assert sum(h is handler for h in logging.getLogger().handlers) == 1


def test_the_upgrade_loggers_are_the_ones_the_upgrade_writes_to():
    assert engine_logger.UPGRADE_LOGGERS == (upgrade_copy.logger.name, database.upgrade_logger.name)
