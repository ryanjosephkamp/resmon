"""The Backend job's log reaches the person reading it, whole.

Every Backend log in this repository was silently cut in half, on passing runs
as well as failing ones. ``gh run view --log`` reads with Go's ``bufio.Scanner``
at its default 64 KiB limit and stops, unchecked, at the first longer line;
``ci.yml`` runs ``pytest -v``; and one parametrised case carries a 256 KiB
``bytes`` value, which pytest renders into the test id. Measured on three jobs
including a passing one: 3,740 raw lines, 1,872 through ``gh``, the cut always
at (first over-long line − 1).

The irony is exact and it is written in ``ci.yml`` itself: ``-v`` was chosen so
"the last line printed is the last test that finished, which names the culprit
immediately". ``-v`` is what truncates the log, so the last visible line names
an innocent test.

Three properties hold the repair, and they are separate failures:

1. no test id is long enough to stop a reader (``conftest.py``'s
   ``pytest_make_parametrize_id``);
2. the suite step reports its own exit status, so a death by signal reads as
   128+N rather than as a bare red (``ci.yml``);
3. no test sits close enough to its timeout that ordinary runner load tips it
   over — pytest-timeout's ``thread`` method expires by calling ``os._exit(1)``
   and takes the summary with it.

Nothing here proves anything about ``gh``'s own behaviour. The 64 KiB figure is
Go's documented default and the cut was measured elsewhere; what this module
asserts is the thing in this repository's control, which is that no line gets
anywhere near it.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
VERIFICATION = PROJECT_ROOT / "resmon_scripts" / "verification_scripts"
CI_WORKFLOW = PROJECT_ROOT / ".github" / "workflows" / "ci.yml"

# Go's bufio.Scanner default, which is what `gh run view --log` reads with.
# The budget below is far under it: the point is not to sit just inside the
# limit but to be nowhere near a reader that might use a smaller one.
SCANNER_LIMIT_BYTES = 64 * 1024
ID_BUDGET_BYTES = 2048


def _collect(arguments: list[str]) -> list[str]:
    """Node ids from a real collection, in a subprocess.

    In-process would inherit this run's plugins, ``addopts`` and already
    imported modules — the reason ``live_suite.collect`` does the same.
    """
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q",
         "-p", "no:cacheprovider", "-p", "timeout", *arguments],
        cwd=str(PROJECT_ROOT), capture_output=True, text=True, timeout=600,
    )
    assert result.returncode in (0, 5), result.stdout[-3000:] + result.stderr[-2000:]
    return [line.strip() for line in result.stdout.splitlines() if "::" in line]


# ---------------------------------------------------------------------------
# 1. No test id truncates a log
# ---------------------------------------------------------------------------

def test_no_test_id_in_the_whole_suite_is_long_enough_to_cut_a_log():
    """Every case, live included, because ``-v`` prints them all.

    Before the cap this collected a 262,284-byte line from
    ``test_evidence_reader.py``. The assertion names the offender and its size
    rather than reporting a boolean, because the fix is always "describe that
    parameter instead of printing it".
    """
    nodeids = _collect(["-m", ""])
    assert nodeids, "the suite collected nothing"
    worst = max(nodeids, key=len)
    assert len(worst) <= ID_BUDGET_BYTES, (
        f"a test id is {len(worst)} bytes, and `gh run view --log` stops at the "
        f"first line over {SCANNER_LIMIT_BYTES}. Give the parameter a short id "
        f"in conftest.py's pytest_make_parametrize_id. The id begins: "
        f"{worst[:200]}"
    )


def test_the_bounds_case_keeps_ids_that_still_tell_its_four_cases_apart():
    """A cap that collapsed two cases into one id would be worse than the line.

    These are the four that carried the 256 KiB value. The two byte-length
    cases differ by one byte and the test's whole point is that the bound falls
    between them, so their ids have to differ there too.
    """
    nodeids = _collect([
        "-m", "",
        "resmon_scripts/verification_scripts/test_evidence_reader.py",
        "-k", "without_truncation",
    ])
    assert len(nodeids) == 4, nodeids
    assert len(set(nodeids)) == 4, f"the cap collapsed distinct cases: {nodeids}"
    joined = "\n".join(nodeids)
    assert "raw-bytes262144-None" in joined, joined
    assert "raw-bytes262145-too_large" in joined, joined


def test_a_short_parameter_is_left_to_pytest():
    """The hook must not rename everything; it is a cap, not a scheme."""
    from conftest import pytest_make_parametrize_id

    assert pytest_make_parametrize_id(None, b"a" * 10, "raw") is None
    assert pytest_make_parametrize_id(None, "short", "name") is None
    assert pytest_make_parametrize_id(None, 262144, "size") is None
    assert pytest_make_parametrize_id(None, None, "value") is None
    assert pytest_make_parametrize_id(None, b"a" * 262144, "raw") == "raw-bytes262144"
    assert pytest_make_parametrize_id(None, "x" * 300, "text") == "text-str300"


# ---------------------------------------------------------------------------
# 2. The suite step says how it died
# ---------------------------------------------------------------------------

def _suite_step() -> str:
    """The ``Run the hermetic test suite`` step, as text."""
    text = CI_WORKFLOW.read_text(encoding="utf-8")
    start = text.index("- name: Run the hermetic test suite")
    rest = text[start + 1:]
    end = rest.find("\n      - name:")
    return rest if end == -1 else rest[:end]


def test_the_suite_step_captures_and_re_raises_pytests_own_status():
    """A crashed run must not be able to report success.

    1.8.7 shipped a step whose pipeline put pytest's exit code behind ``tee``'s
    and a crashed Electron run exited 0. The shape here is the opposite: no
    pipe at all, the status captured into a variable, and that variable
    re-raised as the step's own.
    """
    step = _suite_step()
    assert "status=$?" in step
    assert 'exit "${status}"' in step
    assert "continue-on-error" not in step
    assert "|| true" not in step
    assert "| tee" not in step, (
        "a pipeline here would put pytest's status behind the last command's, "
        "which is the 1.8.7 defect"
    )


def test_the_suite_step_reports_the_status_and_the_peak_memory():
    """128+N is a diagnosis only if somebody prints the number."""
    step = _suite_step()
    assert "::notice title=Backend suite" in step
    assert "pytest exited ${status}" in step
    assert "137" in step and "139" in step, (
        "the notice should say what an over-128 status means, or it is just a "
        "number in a log"
    )
    assert "/usr/bin/time -v" in step
    assert "if [ -x /usr/bin/time ]" in step, (
        "a runner without GNU time must still run the suite"
    )


@pytest.mark.parametrize("script,expected", [
    ("exit 3", 3),
    ("exit 0", 0),
    ("sh -c 'kill -s KILL $$'", 137),
    ("sh -c 'kill -s SEGV $$'", 139),
])
def test_the_capture_and_re_raise_shape_really_preserves_a_status(script, expected):
    """The shell logic itself, run, including the two signal cases.

    GitHub runs each ``run:`` block under ``bash -e -o pipefail``, where a
    failing command would normally end the step before ``status=$?`` executed.
    That is the reason for the ``set +e`` around it, and the reason this is
    worth running rather than reading: the same four lines without the ``set
    +e`` pass every text assertion above and report the wrong thing.

    The signal cases send the signal to a child ``sh``, whose ``$$`` is its
    own pid. Two shorter spellings were tried and both were wrong in ways that
    looked right: a bare ``kill -s KILL $$`` inside a subshell targets the
    *parent* shell, because ``$$`` does not change in a subshell; and
    ``$BASHPID``, which does, is empty under the bash 3.2 that ships with
    macOS, so the command degenerated to a usage error and the case reported
    exit 1. Both are the class of mistake this module is about -- a check that
    appears to exercise a failure and exercises something else.
    """
    block = (
        "set +e\n"
        f"( {script} )\n"
        "status=$?\n"
        "set -e\n"
        'echo "pytest exited ${status}"\n'
        'exit "${status}"\n'
    )
    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", block],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == expected, result
    assert f"pytest exited {expected}" in result.stdout


# ---------------------------------------------------------------------------
# 3. Nothing is sitting on its timeout
# ---------------------------------------------------------------------------

INI_TIMEOUT = 120

# The two cases measured closest to the default limit on CI: 111.7-112.2 s over
# four jobs, and roughly 108 s. Both build a 256 KiB fixture that is the real
# production bound and cannot be shrunk to buy margin instead.
NEAR_THE_LIMIT = {
    "test_evidence_reader.py": "test_evidence_reuses_actual_library_text_limits_without_truncation",
    "test_library_text.py": "test_real_production_bounds_preserve_readable_or_refused_item",
}


@pytest.mark.parametrize("filename,case", sorted(NEAR_THE_LIMIT.items()))
def test_the_cases_measured_near_the_limit_carry_their_own_timeout(filename, case):
    """pytest-timeout's thread method ends the process, not the test.

    ``timeout_method = thread`` is the only method that works with this
    backend's threaded pipeline, and on expiry it calls ``os._exit(1)``: no
    summary, no report, and with ``-v`` the stack dump lands past wherever a
    log reader stopped. A case at 93% of the limit is therefore one slow runner
    away from a red nobody can read, which is the failure this whole module is
    about.
    """
    source = (VERIFICATION / filename).read_text(encoding="utf-8")
    index = source.index(f"def {case}(")
    preamble = source[:index]
    marks = re.findall(r"@pytest\.mark\.timeout\((\d+)\)", preamble)
    assert marks, (
        f"{filename}::{case} was measured at over 90% of pytest.ini's "
        f"{INI_TIMEOUT}s and carries no @pytest.mark.timeout"
    )
    assert int(marks[-1]) > INI_TIMEOUT, (
        f"{filename}::{case} declares a timeout of {marks[-1]}s, which is no "
        f"more headroom than the {INI_TIMEOUT}s default it already had"
    )


def test_the_ini_still_uses_the_thread_method_this_reasoning_depends_on():
    """If the method ever changes, the reasoning above needs rereading.

    ``thread`` is the one that calls ``os._exit``. Under ``signal`` an expiry
    raises inside the test and the summary survives, and the headroom above
    stops being the same kind of urgent.
    """
    ini = (PROJECT_ROOT / "pytest.ini").read_text(encoding="utf-8")
    assert "timeout_method = thread" in ini
    assert f"--timeout={INI_TIMEOUT}" in ini, (
        "the default timeout moved; recheck the two cases in NEAR_THE_LIMIT"
    )
