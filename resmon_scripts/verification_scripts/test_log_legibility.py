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

import ast
import os
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
    from conftest import _MAX_PARAMETRIZE_ID, pytest_make_parametrize_id

    assert pytest_make_parametrize_id(None, b"a" * 10, "raw") is None
    assert pytest_make_parametrize_id(None, "short", "name") is None
    assert pytest_make_parametrize_id(None, 262144, "size") is None
    assert pytest_make_parametrize_id(None, None, "value") is None
    assert pytest_make_parametrize_id(None, "x" * _MAX_PARAMETRIZE_ID, "text") is None
    assert pytest_make_parametrize_id(None, b"a" * 262144, "raw") == "raw-bytes262144"
    assert (pytest_make_parametrize_id(None, "x" * (_MAX_PARAMETRIZE_ID + 1), "text")
            == f"text-str{_MAX_PARAMETRIZE_ID + 1}")


def test_the_cap_is_a_safety_limit_and_not_a_formatting_rule():
    """How tight the cap is, held as a decision rather than left to taste.

    It was 64 first, and a reviewer measured the cost: 20 of 3,562 ids changed
    with no collisions, but five lost readable content while sitting nowhere
    near any limit -- ``[raw-bytes74]`` among them, and this module's own gate
    rendered as ``[test_evidence_reader.py-case-str66]``. Re-measured at 512,
    14 ids change and those five are legible again.

    The floor below is what stops that happening again by accident. The
    ceiling is the point: a cap that is a meaningful fraction of the scanner
    limit is not a safety limit, it is a house style, and this hook should
    only ever be the former.
    """
    from conftest import _MAX_PARAMETRIZE_ID

    assert _MAX_PARAMETRIZE_ID >= 512, (
        "a cap under 512 rewrites ids that no reader has any trouble with"
    )
    assert _MAX_PARAMETRIZE_ID <= SCANNER_LIMIT_BYTES // 16, (
        "the cap has grown close enough to the 64 KiB scanner limit to stop "
        "being a safety margin"
    )


# ---------------------------------------------------------------------------
# 2. The suite step says how it died
# ---------------------------------------------------------------------------

def _suite_step() -> str:
    """The ``Run the hermetic test suite`` step, as text.

    Ends at the next step *or* the next job, whichever comes first. It used to
    look only for the next ``- name:``, and because this is the backend job's
    last step that ran on into ``lint:`` -- so an assertion about this step
    could have been satisfied by another job's text. Nothing was wrong because
    of it; it was wrong anyway.
    """
    text = CI_WORKFLOW.read_text(encoding="utf-8")
    start = text.index("- name: Run the hermetic test suite")
    lines = text[start:].splitlines()
    collected = [lines[0]]
    for line in lines[1:]:
        if line.startswith("      - name:"):
            break
        if line.strip() and not line.startswith("        "):
            break                                 # dedented out of this step
        collected.append(line)
    return "\n".join(collected)


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
    assert "if /usr/bin/time -v true" in step, (
        "a runner without GNU time must still run the suite, and the probe "
        "must test -v rather than the file: `-x /usr/bin/time` is true for "
        "BSD time, which has no -v"
    )


def _suite_run_block() -> str:
    """The suite step's shipped `run:` script, dedented, ready to execute.

    Taken out of ci.yml rather than retyped. The first version of this test
    ran a hand-written approximation -- `( script )` in place of the real
    if/else -- which a reviewer pointed out is not the shape that ships: it
    would have stayed green through an edit to either branch.
    """
    step = _suite_step()
    body = step.split("run: |", 1)[1]
    lines = []
    for line in body.splitlines()[1:]:
        if line.strip() and not line.startswith(" " * 10):
            break
        lines.append(line[10:])
    block = "\n".join(lines).rstrip() + "\n"
    assert "status=$?" in block and "/usr/bin/time" in block, block
    return block


@pytest.mark.parametrize("script,expected", [
    ("exit 3", 3),
    ("exit 0", 0),
    ("kill -s KILL $$", 137),
    ("kill -s SEGV $$", 139),
])
def test_the_shipped_run_block_preserves_a_status(tmp_path, script, expected):
    """ci.yml's own script, executed, with a stand-in on PATH for pytest.

    GitHub runs each ``run:`` block under ``bash -e -o pipefail``, where a
    failing command would normally end the step before ``status=$?`` ran. That
    is what the ``set +e`` is for, and why this is worth executing rather than
    grepping: the same lines without it satisfy every text assertion above and
    report the wrong thing.

    The stand-in is a real executable named ``pytest``, so ``$$`` inside it is
    its own pid -- the signal reaches the process whose status is being
    measured. Two shorter spellings were wrong first in ways that looked
    right: ``kill -s KILL $$`` inside a bash *subshell* targets the parent,
    because ``$$`` does not change in a subshell, and ``$BASHPID``, which
    does, is empty under the bash 3.2 that ships with macOS.

    **Which branch this exercises depends on the machine, and only one of
    them has ever been measured.** The probe picks GNU time where it exists
    and falls through where it does not, so a macOS developer runs the
    ``else`` and a Linux runner runs the ``if``. The ``if`` branch is the one
    that runs on CI -- the Backend job log carries a
    ``Maximum resident set size`` line, which only GNU time prints -- and
    **nobody has measured whether it preserves 128+N**. Reading GNU time's
    ``main()`` suggests it exits with ``WTERMSIG(status)``, the bare 9 or 11,
    which would make the notice wrong in exactly the case it exists for. An
    earlier draft of this docstring said a reviewer had confirmed otherwise;
    they had not -- their script used bash alone, with ``/usr/bin/true`` as
    the stand-in, so what it established was that bash's ``$?`` is 128+N.
    That sentence was a reading credited as a measurement, inside the module
    that exists because the two are not the same thing.

    This case is the instrument. On CI it takes the ``if`` branch and asserts
    137 and 139; if GNU time collapses them it goes red and the log settles
    the question.
    """
    shim = tmp_path / "bin"
    shim.mkdir()
    executable = shim / "pytest"
    executable.write_text("#!/bin/sh\n" + script + "\n", encoding="utf-8")
    executable.chmod(0o755)
    environment = dict(os.environ)
    environment["PATH"] = f"{shim}:{environment['PATH']}"

    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c",
         _suite_run_block().replace("${{ matrix.python-version }}", "3.11")],
        capture_output=True, text=True, timeout=120, env=environment,
    )
    assert result.returncode == expected, result
    assert f"pytest exited {expected}" in result.stdout


def test_the_block_under_test_is_the_one_ci_ships():
    """Guard the extraction itself: a mis-sliced block would test nothing."""
    block = _suite_run_block()
    shipped = CI_WORKFLOW.read_text(encoding="utf-8")
    for line in block.splitlines():
        if line.strip():
            assert line.strip() in shipped
    assert block.strip().endswith('exit "${status}"')
    assert "if /usr/bin/time -v true" in block, (
        "the probe must test the flag, not the file: `-x /usr/bin/time` is "
        "true for BSD time, which has no -v"
    )


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


def timeout_marks_on(source: str, case: str) -> list[int]:
    """The ``@pytest.mark.timeout(N)`` values on *case*'s own decorator list.

    Read with ``ast``, deliberately. The first version of this scanned
    ``source[:index]`` -- the whole file above the ``def`` -- with a regex and
    took the last match, so **any** timeout mark anywhere earlier in the file
    satisfied it. A reviewer moved the mark off the 112-second case and onto an
    unrelated one 43 lines above; the measured case silently went back to the
    120-second default and this gate reported two passes.

    That is the boundary-defect class this repository has now shipped three
    times: a check that is green under the exact failure it is named after.
    The technique that fixes it was already in the same diff --
    ``route_census.py`` reads decorator lists properly -- which is the part
    worth remembering. Attaching a check to a *region of text* rather than to
    the *object* it is about is the mistake; proximity in a file is not
    ownership.

    Raises rather than returning empty when the function is absent, because a
    renamed case must be a red here and not a silent pass.
    """
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name != case:
            continue
        values: list[int] = []
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call) or not decorator.args:
                continue
            function = decorator.func
            # pytest.mark.timeout(...) -- Attribute(timeout) on
            # Attribute(mark) on Name(pytest). Spelled out so that a
            # `mark.timeout` imported under another name does not match
            # something that is not pytest's.
            if (
                isinstance(function, ast.Attribute)
                and function.attr == "timeout"
                and isinstance(function.value, ast.Attribute)
                and function.value.attr == "mark"
                and isinstance(function.value.value, ast.Name)
                and function.value.value.id == "pytest"
                and isinstance(decorator.args[0], ast.Constant)
                and isinstance(decorator.args[0].value, int)
            ):
                values.append(decorator.args[0].value)
        return values
    raise AssertionError(f"no function named {case} in the source given")


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
    marks = timeout_marks_on(source, case)
    assert marks, (
        f"{filename}::{case} was measured at over 90% of pytest.ini's "
        f"{INI_TIMEOUT}s and carries no @pytest.mark.timeout of its own"
    )
    # The *last* decorator, not the largest. Stacked marks were measured
    # rather than assumed: `@timeout(300)` over `@timeout(2)` around a
    # five-second sleep expired at two seconds, and `@timeout(2)` over
    # `@timeout(300)` passed in 5.01 s. The decorator nearest the `def` --
    # last in `decorator_list` -- is the one pytest honours, both ways round.
    #
    # `max()` was here first and it is the same defect as the regex it
    # replaced, one level in: [300, 60] satisfied a gate whose whole job is
    # to guarantee headroom, while the effective limit was 60 -- half the
    # 120-second default the gate exists to improve on.
    effective = marks[-1]
    assert effective > INI_TIMEOUT, (
        f"{filename}::{case} declares {marks} and pytest honours the last of "
        f"them, {effective}s, which is no more headroom than the "
        f"{INI_TIMEOUT}s default it already had"
    )


def test_a_timeout_mark_on_a_neighbouring_case_does_not_count(tmp_path):
    """The reviewer's mutation, kept as a case.

    Moves the real mark off the measured case and onto a different one earlier
    in the same real file. The gate must see the measured case as unmarked.
    Driven over ``test_evidence_reader.py``'s own text rather than a sample,
    because the defect was specifically about distance within a real file.
    """
    filename = "test_evidence_reader.py"
    case = NEAR_THE_LIMIT[filename]
    source = (VERIFICATION / filename).read_text(encoding="utf-8")
    assert timeout_marks_on(source, case) == [300], "the fixture no longer matches the file"

    moved = source.replace("@pytest.mark.timeout(300)\n", "", 1)
    assert moved != source
    neighbour = "test_text_page_inputs_are_exact_integers_and_only_logical_page_one"
    anchor = f"def {neighbour}("
    # Above the neighbour's own decorators, which is where a tidying edit or a
    # careless move would actually land it.
    marker = '@pytest.mark.parametrize("page",'
    assert marker in moved and moved.index(marker) < moved.index(anchor)
    moved = moved.replace(marker, "@pytest.mark.timeout(300)\n" + marker, 1)

    assert timeout_marks_on(moved, neighbour) == [300], "the mutation did not land"
    assert timeout_marks_on(moved, case) == [], (
        "a timeout mark on a neighbouring case still counts for the measured "
        "one -- the gate is reading a region of text, not a decorator list"
    )


def test_the_last_stacked_mark_is_the_one_that_counts():
    """Stacked marks, measured rather than read.

    pytest honours the decorator nearest the ``def``. Measured both ways
    round against a five-second sleep under this repository's own
    ``timeout_method = thread``:

    ======================================  ==================
    ``@timeout(300)`` over ``@timeout(2)``  expired at 2 s
    ``@timeout(2)`` over ``@timeout(300)``  passed in 5.01 s
    ======================================  ==================

    So ``decorator_list[-1]`` is the effective one, and reducing with
    ``max()`` -- which this gate did first -- accepts ``[300, 60]`` while the
    real limit is 60: half the default the gate exists to improve on. A
    reviewer found that by stacking the marks rather than by reading the
    code, which is the same lesson this module keeps paying for.
    """
    source = (VERIFICATION / "test_library_text.py").read_text(encoding="utf-8")
    case = NEAR_THE_LIMIT["test_library_text.py"]
    assert timeout_marks_on(source, case) == [300]

    # A smaller mark added *below* the real one: pytest would enforce 60.
    worse = source.replace(
        "@pytest.mark.timeout(300)\n",
        "@pytest.mark.timeout(300)\n@pytest.mark.timeout(60)\n", 1)
    assert worse != source
    marks = timeout_marks_on(worse, case)
    assert marks == [300, 60], marks
    assert marks[-1] == 60, "the effective mark must be the last one, not the largest"
    assert max(marks) == 300, (
        "and max() must be seen to disagree, or this case proves nothing"
    )

    # Above the real one, the real one still wins -- order is what matters,
    # not size, so the gate must accept this.
    better = source.replace(
        "@pytest.mark.timeout(300)\n",
        "@pytest.mark.timeout(60)\n@pytest.mark.timeout(300)\n", 1)
    assert timeout_marks_on(better, case)[-1] == 300


def test_the_suite_step_reports_the_slowest_cases():
    """--durations is the only standing watch on the headroom, so guard it.

    Two cases sit at 90% and 93% of the 120-second limit and the only reason
    anybody knows that is a one-off measurement somebody happened to take.
    ``timeout_method = thread`` expires by calling ``os._exit(1)``, so the run
    that finally crosses the line reports nothing at all -- there is no red to
    read, which is why a standing watch and not an alert.

    This assertion exists because the flag was added with nothing holding it,
    which is the one place this change did not follow its own thesis.
    """
    step = _suite_step()
    assert "--durations=" in step, (
        "ci.yml no longer reports the slowest cases, so nothing is watching "
        "how close any of them is to pytest.ini's timeout"
    )
    count = int(re.search(r"--durations=(\d+)", step).group(1))
    assert count >= 10, (
        f"--durations={count} is too few to show the cases approaching the "
        "limit behind the two already known"
    )
    # Counted over the executable block, not the whole step: the comment
    # above it names the flag too, and a gate that counts prose is not
    # counting the thing it is about.
    block = _suite_run_block()
    assert block.count("pytest -v --durations=") == block.count("pytest -v"), (
        "both branches of the /usr/bin/time probe must report durations, or "
        "the watch depends on which runner picked the job up"
    )


def test_a_renamed_case_is_a_red_and_not_a_silent_pass():
    source = (VERIFICATION / "test_library_text.py").read_text(encoding="utf-8")
    with pytest.raises(AssertionError):
        timeout_marks_on(source, "test_a_name_that_is_not_in_this_file")


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
