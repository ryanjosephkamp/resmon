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

import json
import os
import re
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import live_suite  # noqa: E402
from live_evidence import (  # noqa: E402
    CurrentRunSourceLedger,
    LiveEvidenceWriter,
    SourceQueryEvidence,
    reduce_evidence,
    stable_hash,
    validate_evidence,
)

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


def test_workflow_preserves_pytest_status_and_publishes_durable_evidence():
    text = WORKFLOW.read_text(encoding="utf-8")
    assert 'pytest -v -m "$RESMON_LIVE_SELECTION" 2>&1 | tee' in text
    assert "pytest_status=${PIPESTATUS[0]}" in text
    assert 'exit "$pytest_status"' in text
    assert "continue-on-error" not in text
    assert "|| true" not in text
    assert "live_suite.py --validate-evidence" in text
    assert "live_suite.py --evidence-summary" in text
    assert text.count("if: always()") >= 3
    assert (
        "actions/upload-artifact@"
        "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
    ) in text
    assert "if-no-files-found: error" in text
    for name in (
        "RESMON_LIVE_EVIDENCE_DIR",
        "RESMON_LIVE_CANDIDATE_SHA",
        "RESMON_LIVE_CHECKOUT_SHA",
        "RESMON_LIVE_SELECTION",
    ):
        assert name in text


def test_workflow_keeps_the_existing_triggers_and_runtime_bounds():
    text = WORKFLOW.read_text(encoding="utf-8")
    path_block = text.split("paths:", 1)[1].split("\n\npermissions:", 1)[0]
    assert re.findall(r"- '([^']+)'", path_block) == [
        ".github/workflows/live-network.yml",
        "resmon_scripts/verification_scripts/live_suite.py",
        "resmon_scripts/verification_scripts/test_live_suite.py",
        "pytest.ini",
    ]
    assert "- cron: '17 6 * * 1'" in text
    assert "workflow_dispatch:" in text
    assert "timeout-minutes: 45" in text
    assert "cancel-in-progress: false" in text


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


def _ledger(expected=("alpha", "beta")):
    query_ids = {slug: stable_hash({"slug": slug}) for slug in expected}
    nodeids = {slug: f"test_source[{slug}]" for slug in expected}
    return CurrentRunSourceLedger(
        expected,
        candidate_head="abc123",
        selection_id="selection-1",
        query_ids=query_ids,
        nodeids=nodeids,
        session_id="session-1",
    )


def _complete(ledger, slug, *, answered=True):
    ledger.start(slug, nodeid=f"test_source[{slug}]", query_id=ledger.query_ids[slug])
    ledger.finish(
        slug,
        result="answered_nonempty" if answered else "answered_empty",
        returned_count=1 if answered else 0,
    )


def test_current_run_ledger_is_order_independent_and_renders_catalog_order():
    ledger = _ledger(("alpha", "beta", "gamma", "omega"))
    for slug in ("gamma", "alpha", "omega", "beta"):
        _complete(ledger, slug, answered=slug in {"alpha", "omega"})
    summary = ledger.assert_threshold()
    assert summary["answered"] == ["alpha", "omega"]
    assert [record["slug"] for record in summary["records"]] == [
        "alpha", "beta", "gamma", "omega",
    ]


def test_current_run_ledger_fails_on_missing_or_unfinished_evidence():
    ledger = _ledger()
    ledger.start("alpha", nodeid="test_source[alpha]", query_id=ledger.query_ids["alpha"])
    with pytest.raises(AssertionError, match=r"missing=\['beta'\].*unfinished=\['alpha'\]"):
        ledger.summary()


def test_current_run_ledger_rejects_duplicate_stale_head_query_and_selection():
    ledger = _ledger(("alpha",))
    base = SourceQueryEvidence(
        session_id=ledger.session_id,
        candidate_head=ledger.candidate_head,
        selection_id=ledger.selection_id,
        slug="alpha",
        nodeid="test_source[alpha]",
        query_id=ledger.query_ids["alpha"],
        started_at=1.0,
        finished_at=2.0,
        result="answered_nonempty",
        returned_count=1,
    )
    for changed, message in [
        ({"session_id": "old"}, "stale session"),
        ({"candidate_head": "wrong"}, "wrong candidate head"),
        ({"query_id": "wrong"}, "wrong query identity"),
        ({"selection_id": "wrong"}, "wrong selection identity"),
        ({"nodeid": "wrong"}, "wrong source case node id"),
    ]:
        with pytest.raises(AssertionError, match=message):
            ledger.accept(replace(base, **changed))
    ledger.accept(base)
    with pytest.raises(AssertionError, match="duplicate"):
        ledger.accept(base)


def test_current_run_ledger_threshold_keeps_empty_and_raised_in_denominator():
    ledger = _ledger(("alpha", "beta", "gamma", "omega"))
    _complete(ledger, "alpha", answered=True)
    _complete(ledger, "beta", answered=False)
    ledger.start("gamma", nodeid="test_source[gamma]", query_id=ledger.query_ids["gamma"])
    ledger.finish("gamma", result="raised", returned_count=None, error=RuntimeError("down"))
    _complete(ledger, "omega", answered=False)
    with pytest.raises(AssertionError, match="only 1 of 4"):
        ledger.assert_threshold()


@pytest.mark.parametrize("result,count", [
    ("answered_nonempty", 0),
    ("answered_nonempty", None),
    ("answered_empty", 1),
    ("raised", 1),
    ("unknown", 0),
])
def test_current_run_ledger_rejects_inconsistent_terminal_results(result, count):
    ledger = _ledger(("alpha",))
    ledger.start("alpha", nodeid="test_source[alpha]", query_id=ledger.query_ids["alpha"])
    with pytest.raises(AssertionError):
        ledger.finish("alpha", result=result, returned_count=count)


def test_current_run_ledger_rejects_duplicate_expected_source():
    with pytest.raises(ValueError, match="duplicate expected"):
        _ledger(("alpha", "alpha"))


def _report(nodeid, when, outcome, *, message="", returned=None):
    crash = SimpleNamespace(message=message) if message else None
    return SimpleNamespace(
        nodeid=nodeid,
        when=when,
        outcome=outcome,
        duration=0.01,
        user_properties=[] if returned is None else [("returned", returned), ("ignored", "secret")],
        longreprtext=message,
        longrepr=SimpleNamespace(reprcrash=crash) if crash else None,
        location=("test_live.py", 10, "test_case"),
    )


def _writer(root):
    return LiveEvidenceWriter(root, {
        "candidate_sha": "abc",
        "checkout_sha": "def",
        "selection": live_suite.SCHEDULED_SELECTION,
    })


def test_live_evidence_reduces_pass_fail_skip_and_teardown_failure(tmp_path):
    writer = _writer(tmp_path)
    nodes = ["test::pass", "test::fail", "test::skip", "test::teardown"]
    writer.collection(nodes, live_suite.SCHEDULED_SELECTION)
    for node in nodes:
        writer.start(node)
        writer.report(_report(
            node, "setup", "skipped" if node == nodes[2] else "passed",
        ))
    writer.report(_report(nodes[0], "call", "passed"))
    writer.report(_report(nodes[0], "teardown", "passed"))
    writer.report(_report(nodes[1], "call", "failed", message="assertion failed"))
    writer.report(_report(nodes[1], "teardown", "passed"))
    writer.report(_report(nodes[2], "teardown", "passed"))
    writer.report(_report(nodes[3], "call", "passed"))
    writer.report(_report(nodes[3], "teardown", "failed", message="cleanup failed"))
    writer.finish(1)
    reduction = validate_evidence(tmp_path)
    assert reduction["outcomes"] == {
        nodes[0]: "passed", nodes[1]: "failed",
        nodes[2]: "skipped", nodes[3]: "failed",
    }


def test_live_evidence_rejects_zero_exit_status_with_failed_report(tmp_path):
    writer = _writer(tmp_path)
    writer.collection(["test::fail"], live_suite.SCHEDULED_SELECTION)
    writer.start("test::fail")
    writer.report(_report("test::fail", "setup", "passed"))
    writer.report(_report("test::fail", "call", "failed", message="failed"))
    writer.report(_report("test::fail", "teardown", "passed"))
    writer.finish(0)
    with pytest.raises(AssertionError, match="zero pytest status contradicts"):
        validate_evidence(tmp_path)


def test_live_evidence_redacts_bounds_and_ignores_arbitrary_properties(tmp_path):
    writer = _writer(tmp_path)
    writer.collection(["test::failure"], live_suite.SCHEDULED_SELECTION)
    writer.start("test::failure")
    writer.report(_report("test::failure", "setup", "passed"))
    writer.report(_report(
        "test::failure", "call", "failed",
        message=(
            'authorization=SECRET "token": "TOKENVALUE" '
            "Authorization: Bearer BEARERVALUE "
            "https://example.invalid/?api_key=QUERYVALUE&safe=1 "
            + ("x" * 2000)
        ),
        returned=3,
    ))
    writer.report(_report("test::failure", "teardown", "passed"))
    writer.finish(1)
    text = (tmp_path / "events.jsonl").read_text()
    for secret in ("SECRET", "TOKENVALUE", "BEARERVALUE", "QUERYVALUE"):
        assert secret not in text
    assert "ignored" not in text
    assert "[REDACTED]" in text
    report = next(event for event in map(json.loads, text.splitlines()) if event.get("event") == "report" and event["phase"] == "call")
    assert len(report["message"]) <= 512
    assert report["properties"] == {"returned": 3}


def test_live_evidence_truncated_prefix_is_unfinished_and_strict_validation_fails(tmp_path):
    writer = _writer(tmp_path)
    writer.collection(["test::interrupted"], live_suite.SCHEDULED_SELECTION)
    writer.start("test::interrupted")
    with (tmp_path / "events.jsonl").open("a") as handle:
        handle.write('{"event":"report"')
    assert reduce_evidence(tmp_path, require_finish=False)["unfinished"] == ["test::interrupted"]
    with pytest.raises(AssertionError, match="malformed evidence"):
        validate_evidence(tmp_path)


def test_live_evidence_rejects_missing_start_and_duplicate_phase(tmp_path):
    writer = _writer(tmp_path)
    writer.collection(["test::case"], live_suite.SCHEDULED_SELECTION)
    writer.report(_report("test::case", "call", "passed"))
    writer.report(_report("test::case", "teardown", "passed"))
    writer.finish(0)
    with pytest.raises(AssertionError, match=r"missing_starts=\['test::case'\]"):
        validate_evidence(tmp_path)

    duplicate = tmp_path / "duplicate"
    writer = _writer(duplicate)
    writer.collection(["test::case"], live_suite.SCHEDULED_SELECTION)
    writer.start("test::case")
    writer.report(_report("test::case", "setup", "passed"))
    writer.report(_report("test::case", "call", "passed"))
    writer.report(_report("test::case", "call", "passed"))
    writer.report(_report("test::case", "teardown", "passed"))
    with pytest.raises(AssertionError, match="duplicate_phases"):
        writer.finish(0)


def test_live_evidence_never_treats_teardown_only_as_passed(tmp_path):
    writer = _writer(tmp_path)
    writer.collection(["test::case"], live_suite.SCHEDULED_SELECTION)
    writer.start("test::case")
    writer.report(_report("test::case", "setup", "passed"))
    writer.report(_report("test::case", "teardown", "passed"))
    writer.finish(0)
    with pytest.raises(AssertionError, match="unfinished selected nodes"):
        validate_evidence(tmp_path)


def test_partial_evidence_counts_unstarted_selected_nodes_as_unfinished(tmp_path):
    writer = _writer(tmp_path)
    writer.collection(["test::done", "test::unstarted"], live_suite.SCHEDULED_SELECTION)
    writer.start("test::done")
    writer.report(_report("test::done", "setup", "passed"))
    writer.report(_report("test::done", "call", "passed"))
    writer.report(_report("test::done", "teardown", "passed"))
    reduction = reduce_evidence(tmp_path, require_finish=False)
    assert reduction["outcomes"] == {"test::done": "passed"}
    assert reduction["unfinished"] == ["test::unstarted"]
    assert "1 unfinished" in live_suite.evidence_summary(tmp_path)


def test_live_evidence_rejects_mixed_candidate_identity(tmp_path):
    writer = _writer(tmp_path)
    writer.collection(["test::case"], live_suite.SCHEDULED_SELECTION)
    writer.start("test::case")
    writer.report(_report("test::case", "setup", "passed"))
    writer.report(_report("test::case", "call", "passed"))
    writer.report(_report("test::case", "teardown", "passed"))
    writer.finish(0)
    run = json.loads((tmp_path / "RUN.json").read_text())
    run["identity"]["candidate_sha"] = "different"
    (tmp_path / "RUN.json").write_text(json.dumps(run))
    with pytest.raises(AssertionError, match="invalid or mismatched selection receipt"):
        validate_evidence(tmp_path)
    selection = json.loads((tmp_path / "SELECTION.json").read_text())
    selection["identity"]["candidate_sha"] = "different"
    (tmp_path / "SELECTION.json").write_text(json.dumps(selection))
    events = [
        json.loads(line)
        for line in (tmp_path / "events.jsonl").read_text().splitlines()
    ]
    for event in events:
        if event.get("event") == "collection":
            event["identity"]["candidate_sha"] = "different"
    (tmp_path / "events.jsonl").write_text(
        "".join(json.dumps(event, sort_keys=True) + "\n" for event in events),
        encoding="utf-8",
    )
    with pytest.raises(AssertionError, match="run event does not match run receipt"):
        validate_evidence(tmp_path)


def test_real_pytest_failure_keeps_nonzero_status_and_durable_reports(tmp_path):
    case = tmp_path / "test_deliberate.py"
    case.write_text(
        "def test_pass():\n    pass\n\n"
        "def test_deliberate_failure():\n    assert False, 'deliberate proof'\n",
        encoding="utf-8",
    )
    evidence = tmp_path / "evidence"
    env = os.environ.copy()
    env.update({
        "RESMON_LIVE_EVIDENCE_DIR": str(evidence),
        "RESMON_LIVE_CANDIDATE_SHA": "candidate-proof",
        "RESMON_LIVE_CHECKOUT_SHA": "checkout-proof",
        "RESMON_LIVE_SELECTION": "deliberate-failure-proof",
    })
    result = subprocess.run(
        [
            sys.executable, "-m", "pytest",
            "-c", str(PROJECT_ROOT / "pytest.ini"),
            "-p", "pytest_timeout",
            "-p", "resmon_scripts.verification_scripts.conftest",
            "-p", "no:cacheprovider",
            "-q", str(case),
        ],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == int(pytest.ExitCode.TESTS_FAILED), (
        result.stdout, result.stderr,
    )
    reduction = validate_evidence(evidence)
    assert sorted(reduction["outcomes"].values()) == ["failed", "passed"]
    assert reduction["finish"]["exitstatus"] == int(pytest.ExitCode.TESTS_FAILED)


def test_live_evidence_writer_error_is_sticky_without_raising(tmp_path, monkeypatch):
    writer = _writer(tmp_path)
    monkeypatch.setattr(writer, "_append", lambda _value: (_ for _ in ()).throw(OSError("disk full")))
    writer.safe(writer.start, "test::case")
    assert writer.integrity_error is True


def test_entity_aggregate_contains_no_second_client_call():
    source = (PROJECT_ROOT / "resmon_scripts/verification_scripts/test_entity_search_live.py").read_text()
    aggregate = source.split("def test_at_least_most_sources_answered", 1)[1]
    assert "get_client(" not in aggregate
    assert "source_response_ledger.assert_threshold()" in aggregate
