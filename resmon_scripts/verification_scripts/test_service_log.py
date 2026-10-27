"""The background service's logs stay bounded (``service_log``).

launchd and systemd append to a service's output files forever; one user's
error log reached 231 MB. These tests drive rotation in child processes whose
standard streams are real files, exactly as a service unit leaves them, so the
descriptors being swapped are never this test process's own.

The last test starts the real service over a pre-filled log and checks that it
rotated the file it was handed and stamped what it wrote with the time.
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS = PROJECT_ROOT / "resmon_scripts"
sys.path.insert(0, str(SCRIPTS))

from implementation_scripts import service_log, service_manager  # noqa: E402

posix_only = pytest.mark.skipif(
    sys.platform == "win32", reason="renames an open file, which is the POSIX path",
)


def _child(code: str, *, stdout, stderr, env=None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        cwd=SCRIPTS, stdout=stdout, stderr=stderr, timeout=60,
        env={**os.environ, **(env or {})},
    )


def _numbered(path: Path) -> list[int]:
    """The ``line NNNNN`` numbers in a file, in order, ignoring marker lines."""
    if not path.exists():
        return []
    return [
        int(m.group(1))
        for m in re.finditer(r"^line (\d+)$", path.read_text(encoding="utf-8"), re.M)
    ]


_WRITE_AND_ROTATE = """
    import sys
    from implementation_scripts import service_log
    log = service_log.attach({attach_args})
    assert log is not None, "the stream was not found"
    {configure}
    for i in range({lines}):
        print(f"line {{i:05d}}", file=sys.stderr, flush=True)
        if i % 25 == 0:
            log.rotate_if_needed()
"""


@posix_only
def test_rotation_moves_the_file_aside_without_losing_a_line(tmp_path):
    err = tmp_path / "resmon-daemon.err.log"
    with err.open("ab") as handle:
        result = _child(
            _WRITE_AND_ROTATE.format(
                attach_args="max_bytes=1000, backups=2", configure="", lines=600,
            ),
            stdout=subprocess.PIPE, stderr=handle,
        )
    assert result.returncode == 0, result.stdout

    backups = sorted(p.name for p in tmp_path.iterdir())
    assert backups == [
        "resmon-daemon.err.log", "resmon-daemon.err.log.1", "resmon-daemon.err.log.2",
    ]
    # Bounded: 1,000 bytes plus at most the 25 lines written between checks.
    assert err.stat().st_size <= 1000 + 25 * len("line 00000\n") + 200

    # Nothing lost at a rotation: the three files read oldest to newest are one
    # unbroken run of numbers that ends with the last line written.
    numbers = (
        _numbered(tmp_path / "resmon-daemon.err.log.2")
        + _numbered(tmp_path / "resmon-daemon.err.log.1")
        + _numbered(err)
    )
    assert numbers[-1] == 599
    assert numbers == list(range(numbers[0], 600))

    first_line = err.read_text(encoding="utf-8").splitlines()[0]
    assert re.fullmatch(
        r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ resmon-daemon: log rotated; "
        r"earlier lines are in resmon-daemon\.err\.log\.1",
        first_line,
    ), first_line


@posix_only
def test_an_oversized_log_keeps_only_its_most_recent_whole_lines(tmp_path):
    # The 231 MB case, scaled down: the first start of a rotating service
    # inherits a file far past the cap.
    err = tmp_path / "resmon-daemon.err.log"
    err.write_text("".join(f"old {i:06d}\n" for i in range(5000)), encoding="utf-8")
    with err.open("ab") as handle:
        result = _child(
            """
            from implementation_scripts import service_log
            log = service_log.attach(max_bytes=4000, backups=2)
            assert log.rotate_if_needed()
            """,
            stdout=subprocess.PIPE, stderr=handle,
        )
    assert result.returncode == 0, result.stdout

    kept = (tmp_path / "resmon-daemon.err.log.1").read_text(encoding="utf-8")
    lines = kept.splitlines()
    assert re.fullmatch(
        r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ resmon-daemon: the [\d,]+ bytes before "
        r"this line were dropped when the log was rotated",
        lines[0],
    ), lines[0]
    assert all(re.fullmatch(r"old \d{6}", line) for line in lines[1:]), "a cut line survived"
    assert lines[-1] == "old 004999"
    assert len(kept.encode("utf-8")) <= 4000 + len(lines[0]) + 1
    assert not (tmp_path / "resmon-daemon.err.log.2").exists()


def test_a_pipe_is_not_a_log_to_rotate():
    result = _child(
        """
        from implementation_scripts import service_log
        print(service_log.attach() is None)
        """,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.decode().strip() == "True"


def test_windows_strategy_opens_its_own_files_and_copies_then_truncates(tmp_path):
    # Task Scheduler gives the service no output, so the unit passes
    # --log-dir. Exercised here with /dev/null (or NUL) standing in for
    # "no file", and the copy-and-truncate rotation Windows needs forced on.
    result = _child(
        _WRITE_AND_ROTATE.format(
            attach_args=f"{str(tmp_path)!r}, max_bytes=1000, backups=2",
            configure="log.copy_truncate = True",
            lines=300,
        ),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    assert result.returncode == 0
    err = tmp_path / "resmon-daemon.err.log"
    assert (tmp_path / "resmon-daemon.out.log").exists()
    assert (tmp_path / "resmon-daemon.err.log.1").exists()
    numbers = _numbered(tmp_path / "resmon-daemon.err.log.2") + _numbered(
        tmp_path / "resmon-daemon.err.log.1") + _numbered(err)
    assert numbers[-1] == 299
    assert numbers == list(range(numbers[0], 300))
    # Opened for append, so a truncated file is written from its start rather
    # than past a hole of zero bytes.
    assert b"\0" not in err.read_bytes()


def test_task_scheduler_unit_carries_the_log_directory():
    import xml.etree.ElementTree as ET

    rendered = service_manager.render_template(
        python=r"C:\resmon\python.exe", port=8742, workdir=Path(r"C:\resmon"),
        log_dir=Path(r"C:\Users\a b\AppData\Local\resmon\logs"),
        template=service_manager.TEMPLATES_DIR / "resmon-daemon.task.xml",
        state_args=[],
    )
    [arguments] = [e.text for e in ET.fromstring(rendered).iter() if e.tag.endswith("Arguments")]
    assert arguments.endswith(r' "--log-dir=C:\Users\a b\AppData\Local\resmon\logs"')


@posix_only
def test_the_service_rotates_the_log_its_unit_hands_it(tmp_path):
    """The real daemon, started the way launchd starts it, over a full log."""
    state = tmp_path / "state"
    logs = state / "logs"
    logs.mkdir(parents=True)
    err = logs / "resmon-daemon.err.log"
    out = logs / "resmon-daemon.out.log"
    err.write_text("".join(f"old {i:06d}\n" for i in range(20000)), encoding="utf-8")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port != 8742, "the installed service's port is never bound by a test"
    env = {
        **os.environ,
        "RESMON_STATE_DIR": str(state),
        "RESMON_PORT_FILE": str(state / "backend.port"),
        "RESMON_CHROMIUM_PROFILE": str(state / "chromium"),
        "RESMON_DISABLE_SCHEDULER": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHON_KEYRING_BACKEND": "keyring.backends.null.Keyring",
        service_log.MAX_BYTES_ENV: "20000",
        "PYTHONPATH": str(SCRIPTS),
    }
    env.pop("RESMON_DB_PATH", None)
    env.pop("RESMON_REPORTS_DIR", None)
    with err.open("ab") as err_handle, out.open("ab") as out_handle:
        proc = subprocess.Popen(
            [sys.executable, "-m", "implementation_scripts.daemon", str(port),
             f"--db-path={state / 'resmon.db'}", f"--reports-dir={state / 'reports'}"],
            cwd=SCRIPTS, env=env, stdout=out_handle, stderr=err_handle,
        )
    try:
        deadline = time.monotonic() + 60
        running = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} INFO: +Uvicorn running on", re.M)
        while time.monotonic() < deadline:
            assert proc.poll() is None, err.read_text(encoding="utf-8")[-2000:]
            if running.search(err.read_text(encoding="utf-8")):
                break
            time.sleep(0.2)
        else:
            pytest.fail("the service did not report that it was listening")

        current = err.read_text(encoding="utf-8")
        assert current.splitlines()[0].endswith(
            "resmon-daemon: log rotated; earlier lines are in resmon-daemon.err.log.1")
        assert re.search(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ resmon-daemon: starting \(pid "
                         + str(proc.pid) + r"\)$", current, re.M)
        assert "old 0" not in current
        kept = (logs / "resmon-daemon.err.log.1").read_text(encoding="utf-8")
        assert "were dropped when the log was rotated" in kept.splitlines()[0]
        assert kept.splitlines()[-1] == "old 019999"
        assert (logs / "resmon-daemon.err.log.1").stat().st_size < 21000
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
