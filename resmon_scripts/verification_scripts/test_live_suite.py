"""The live suite is split in two, and neither half can grow a gap quietly.

``live_suite.py`` declares which live tests a machine with nothing but a network
connection can run; ``.github/workflows/live-network.yml`` runs that half every
week. Everything here is about the seam between those two, because the failure
this exists to prevent is not a broken test — it is a live test that *nothing*
runs, which is what happened in 1.9 and stayed unheard for two releases.

Hermetic. It reads the workflow file as data and shells out to pytest's own
collector; it opens no socket.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import live_suite  # noqa: E402

WORKFLOW = PROJECT_ROOT / ".github" / "workflows" / "live-network.yml"


@pytest.fixture(scope="module")
def collections() -> dict[str, list[str]]:
    """Three real collections: the whole live suite, and its two halves."""
    return {
        "all": live_suite.collect("live_network"),
        "scheduled": live_suite.collect(live_suite.SCHEDULED_SELECTION),
        "local": live_suite.collect(live_suite.LOCAL_ONLY_SELECTION),
    }


def test_the_two_selections_partition_the_live_suite_exactly(collections):
    """P17a, with the collection itself as the denominator.

    Not a list of files and not a hand count: pytest's own collector, three
    times. A live test that carries no local-resource marker is in the weekly
    job by construction; one that carries a marker is out of it and named in the
    summary. **A test can be in neither only if this fails.**
    """
    everything = set(collections["all"])
    scheduled = set(collections["scheduled"])
    local = set(collections["local"])

    assert scheduled | local == everything, (
        "these live tests are in neither half and so are run by nothing: "
        f"{sorted(everything - scheduled - local)}"
    )
    assert not scheduled & local, (
        "a test cannot be both scheduled and unrunnable on a runner: "
        f"{sorted(scheduled & local)}"
    )
    assert scheduled, "the weekly job would run nothing at all"
    assert local, (
        "no live test needs a local resource any more — if that is really true, "
        "delete the marker and the workflow's summary section rather than "
        "leaving a section that describes nothing"
    )


def test_every_local_resource_marker_is_registered_and_used(collections):
    """A marker pytest does not know is a typo that silently selects nothing."""
    registered = (PROJECT_ROOT / "pytest.ini").read_text(encoding="utf-8")
    for marker, need in live_suite.LOCAL_RESOURCE_MARKERS.items():
        assert f"\n    {marker}:" in registered, (
            f"{marker} is not registered in pytest.ini, so `-m {marker}` would "
            "select nothing and the weekly job would run tests it cannot run"
        )
        assert live_suite.collect(f"live_network and {marker}"), (
            f"{marker} is declared and no test carries it")
        assert len(need) > 30, f"{marker} does not say what the machine must have"


def test_the_workflow_asks_the_code_for_its_selection_rather_than_repeating_it():
    """P17b. The expression exists once, and the workflow reads it.

    Asserting that two copies match would be the weaker version of this: it
    would pass while both were wrong together. There is no second copy — the
    workflow shells out to ``live_suite.py --selection`` — and this fails if one
    is ever pasted in.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "live_suite.py --selection" in text, (
        "the workflow no longer computes its selection from the code")
    hardcoded = re.findall(r'-m\s+["\']?live_network[^\n"\']*', text)
    assert not hardcoded, (
        f"the workflow hard-codes a marker expression: {hardcoded}")


def test_the_workflow_writes_what_it_did_not_run_into_its_summary():
    """P17c's checkable half. A green tick that hides a third of the suite is
    the thing this whole file is about; the UI-smoke jobs set the precedent."""
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "live_suite.py --summary" in text
    assert "GITHUB_STEP_SUMMARY" in text
    assert "if: always()" in text, (
        "the summary must be written even when the run fails — a failed run is "
        "exactly when someone reads it")


def test_the_summary_names_the_tests_it_could_not_run(collections):
    """And the summary is built from a collection, not from prose."""
    rendered = live_suite.summary()
    for node in collections["local"]:
        assert node in rendered, f"{node} was not run and is not named"
    assert str(len(collections["all"])) in rendered
    for marker in live_suite.LOCAL_RESOURCE_MARKERS:
        assert marker in rendered


def test_the_scheduled_half_needs_nothing_but_a_network(collections):
    """The four files that drive a real agent CLI are the ones held back.

    Named rather than counted so that a file moving between halves is a visible
    change to this test. The *count* is a denominator; the names are the claim.
    """
    files = {node.split("::")[0].split("/")[-1] for node in collections["local"]}
    assert files == {
        "test_assistant_live.py",
        "test_assistant_budget.py",
        "test_lane_constitution.py",
        "test_subscription_batching.py",
    }, files
