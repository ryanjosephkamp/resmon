"""The gate says what it did not select, or this suite is lying by omission.

``pytest -q`` ends with ``3404 passed, 2 skipped, 110 deselected`` and that is
the whole of it: no names, no modules, nothing in the GitHub run summary where
the person who merges is actually looking. Three modules' worth of real
failures hid behind that in one branch.

The weekly live job already does the honest version — it names every
``needs_agent_cli`` case it could not run, by node id, because an earlier
session established that a green tick must not imply a test nobody ran. These
cases hold the same property one level up, for the gate that deselects far
more.

Two halves, deliberately:

* the renderer, driven directly, including the two ways it has already been
  wrong (pytest's own ``parametrize`` counted as a project marker, and the
  live-network sentence printed for a deselection that had nothing to do with
  the network);
* a real ``pytest`` subprocess over a real live module, which is the only thing
  that proves the hook is wired to anything at all. A unit test of a renderer
  nobody calls is the exact failure this report exists to make visible.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from deselection_report import (
    HEADING,
    as_markdown,
    project_marker_names,
    render,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
PYTEST_INI = PROJECT_ROOT / "pytest.ini"

# A real live module, named rather than discovered: this suite asserts on its
# contents, so it has to be a file somebody notices when it changes.
LIVE_MODULE = "resmon_scripts/verification_scripts/test_entity_search_live.py"


# ---------------------------------------------------------------------------
# The renderer
# ---------------------------------------------------------------------------

def test_nothing_deselected_prints_nothing():
    """A run that selected everything must not grow a block saying so."""
    assert render([], collected=12) == []
    assert as_markdown([]) == ""


def test_the_report_counts_what_it_was_given():
    lines = render(
        [
            ("a/test_one.py::test_x", ["live_network"]),
            ("a/test_one.py::test_y", ["live_network"]),
            ("a/test_two.py::test_z", ["live_network", "needs_agent_cli"]),
        ],
        collected=97,
        markexpr="not live_network",
    )
    text = "\n".join(lines)
    assert "3 of 100 collected cases were deselected" in text
    assert 'by -m "not live_network"' in text
    assert "    2  live_network" in text
    assert "    1  live_network, needs_agent_cli" in text
    assert "By module (2):" in text
    assert "    2  test_one.py" in text
    assert "    1  test_two.py" in text


def test_the_module_list_is_capped_and_says_what_it_left_out():
    """A ``-k`` run deselects everything; the block must stay readable.

    The residue line carries the case count as well as the module count, so the
    numbers on screen still add up to the total in the first line.
    """
    deselected = [(f"a/test_{index}.py::test_x", ["live_network"]) for index in range(40)]
    lines = render(deselected, collected=0, keyword="something", module_limit=5)
    text = "\n".join(lines)
    assert 'by -k "something"' in text
    assert "By module (40):" in text
    assert "   35  in 35 further module(s), not listed" in text


def test_the_live_network_sentence_only_appears_when_it_is_true():
    """It names the weekly workflow, so it must not show for a ``-k`` filter."""
    network = render([("a/test_one.py::test_x", ["live_network"])], collected=1)
    assert any("live-network.yml" in line for line in network)

    by_name = render([("a/test_one.py::test_x", [])], collected=1)
    assert not any("live-network.yml" in line for line in by_name)
    assert any("no declared marker" in line for line in by_name)


def test_only_this_projects_markers_are_reported():
    """``parametrize`` is pytest's, and counting it made the report lie.

    ``config.getini("markers")`` comes back carrying pytest's own built-ins,
    because core registers them into that very setting at configure time. The
    first version of this report grouped 42 of the 110 deselected cases under
    ``live_network, parametrize`` and then told the reader, in the next
    sentence, that a case carrying a second marker runs on no runner — which is
    false of every one of them. The file is the only place that says which
    markers belong to this project.
    """
    names = project_marker_names(PYTEST_INI)
    assert names == {"live_network", "needs_agent_cli"}, names
    assert "parametrize" not in names


def test_an_unreadable_ini_reports_no_markers_rather_than_the_wrong_ones(tmp_path):
    assert project_marker_names(None) == set()
    assert project_marker_names(tmp_path / "does-not-exist.ini") == set()


def test_the_markdown_and_the_terminal_say_the_same_thing():
    """Two renderings of one statement; they are generated from one list."""
    lines = render([("a/test_one.py::test_x", ["live_network"])], collected=4)
    markdown = as_markdown(lines)
    assert markdown.startswith("## " + HEADING.capitalize())
    for line in lines:
        assert line in markdown


# ---------------------------------------------------------------------------
# The hook, in a real run
# ---------------------------------------------------------------------------

def _collect(arguments: list[str], step_summary: Path | None = None):
    """A real pytest collection in a subprocess.

    A subprocess for the reason ``live_suite.collect`` gives: this is called
    from inside a pytest run, and a nested in-process run would inherit the
    outer one's plugins, its ``addopts`` and its already-imported modules.
    """
    environment = dict(os.environ)
    environment.pop("GITHUB_STEP_SUMMARY", None)
    if step_summary is not None:
        environment["GITHUB_STEP_SUMMARY"] = str(step_summary)
    return subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q",
         "-p", "no:cacheprovider", "-p", "timeout", *arguments],
        cwd=str(PROJECT_ROOT), capture_output=True, text=True, timeout=300,
        env=environment,
    )


def test_a_real_run_names_the_modules_it_deselected(tmp_path):
    """The whole point, end to end, against a real module and the real conftest."""
    summary = tmp_path / "step-summary.md"
    result = _collect(["-m", "not live_network", LIVE_MODULE], summary)
    assert HEADING in result.stdout, result.stdout[-4000:]

    # The denominator comes from a second, independent collection of the same
    # file rather than from a number typed here, so the module growing a case
    # does not turn this red for no reason.
    live = _collect(["-m", "live_network", LIVE_MODULE])
    expected = len([line for line in live.stdout.splitlines() if "::" in line])
    assert expected > 0, "test_entity_search_live.py collected no live cases"
    assert f"{expected} of {expected} collected cases were deselected" in result.stdout
    assert "test_entity_search_live.py" in result.stdout.split(HEADING, 1)[1]

    assert summary.exists(), "nothing was written to GITHUB_STEP_SUMMARY"
    written = summary.read_text(encoding="utf-8")
    assert written.startswith("## ")
    assert "test_entity_search_live.py" in written
    assert f"{expected} of {expected} collected cases" in written


def test_a_real_run_that_deselects_nothing_writes_nothing(tmp_path):
    """The block is a statement, not decoration; silence must stay available."""
    summary = tmp_path / "step-summary.md"
    result = _collect(["-m", "", LIVE_MODULE], summary)
    assert HEADING not in result.stdout, result.stdout[-2000:]
    assert not summary.exists() or summary.read_text(encoding="utf-8") == ""


def test_the_default_hermetic_selection_is_the_one_being_reported(tmp_path):
    """Over the whole suite, with the gate's own arguments.

    The numbers are read from pytest's own trailing line and compared with the
    report's, so the two cannot drift apart: a report that said 94 while pytest
    said 110 would be worse than no report.
    """
    result = _collect(["-m", "not live_network"], tmp_path / "step-summary.md")
    trailing = [line for line in result.stdout.splitlines() if "deselected)" in line]
    assert trailing, result.stdout[-2000:]
    pytest_count = int(trailing[-1].split("(")[1].split(" deselected")[0])
    block = result.stdout.split(HEADING, 1)[1]
    assert f"{pytest_count} of " in block, block[:600]
    assert "live-network.yml" in block
