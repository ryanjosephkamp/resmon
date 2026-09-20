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
    source_contract = {
        "module": "test_entity_search_live.py", "markexpr": "live_network",
        "catalog_sources": sorted(expected),
        "expected_nodeids": dict(sorted(nodeids.items())),
        "excluded_keyed_nodeids": {},
        "query_ids": dict(sorted(query_ids.items())),
    }
    return CurrentRunSourceLedger(
        expected,
        candidate_head="abc123",
        selection_id=stable_hash(source_contract),
        query_ids=query_ids,
        nodeids=nodeids,
        session_id="session-1",
        source_contract=source_contract,
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


def test_current_run_ledger_keeps_structured_partial_ids_without_changing_threshold():
    ledger = _ledger(("alpha", "beta"))
    for slug, outcome in (
        ("alpha", {
            "attempts": 2, "failures": 1, "last_call_failed": True,
            "last_status": 503, "last_detail": "http_503",
            "retained_cooldown_status": None, "explicit_reason": None,
            "explicit_detail": None,
        }),
        ("beta", {
            "attempts": 1, "failures": 0, "last_call_failed": False,
            "last_status": None, "last_detail": None,
            "retained_cooldown_status": None, "explicit_reason": None,
            "explicit_detail": None,
        }),
    ):
        ledger.start(slug, nodeid=f"test_source[{slug}]", query_id=ledger.query_ids[slug])
        ledger.finish(slug, result="answered_nonempty", returned_count=1, outcome=outcome)
    summary = ledger.assert_threshold()
    assert summary["answered"] == ["alpha", "beta"]
    assert summary["partial"] == ["alpha"]
    assert summary["minimum"] == 1
    assert isinstance(summary["records"][0]["outcome"], dict)


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


def test_current_run_ledger_rejects_opaque_outcome_text():
    ledger = _ledger(("alpha",))
    ledger.start("alpha", nodeid="test_source[alpha]", query_id=ledger.query_ids["alpha"])
    with pytest.raises(AssertionError, match="structured snapshot"):
        ledger.finish(
            "alpha", result="answered_nonempty", returned_count=1,
            outcome="{'attempts': 1}",  # type: ignore[arg-type]
        )


def _report(nodeid, when, outcome, *, message="", returned=None, properties=None):
    crash = SimpleNamespace(message=message) if message else None
    return SimpleNamespace(
        nodeid=nodeid,
        when=when,
        outcome=outcome,
        duration=0.01,
        user_properties=(
            list(properties or [])
            if returned is None
            else [("returned", returned), ("ignored", "secret"), *(properties or [])]
        ),
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



def _durable_ledger_fixture():
    prefix = "resmon_scripts/verification_scripts/test_entity_search_live.py::"
    expected = ("alpha", "beta")
    nodeids = {slug: f"{prefix}test_a_real_source_answers_a_real_author_query[{slug}]" for slug in expected}
    excluded = {"core": f"{prefix}test_a_real_source_answers_a_real_author_query[core]"}
    query_ids = {slug: stable_hash({"slug": slug}) for slug in expected}
    contract = {
        "module": "test_entity_search_live.py", "markexpr": live_suite.SCHEDULED_SELECTION,
        "catalog_sources": ["alpha", "beta", "core"],
        "expected_nodeids": nodeids, "excluded_keyed_nodeids": excluded,
        "query_ids": query_ids,
    }
    ledger = CurrentRunSourceLedger(
        expected, candidate_head="abc", selection_id=stable_hash(contract),
        query_ids=query_ids, nodeids=nodeids, session_id="source-session",
        source_contract=contract,
    )
    return ledger, nodeids, excluded


def _full_outcome(*, partial=False):
    return {
        "attempts": 2 if partial else 1,
        "failures": 1 if partial else 0,
        "last_call_failed": partial,
        "last_status": 503 if partial else 200,
        "last_detail": "authorization=SECRET" if partial else "ok",
        "retained_cooldown_status": None,
        "explicit_reason": None,
        "explicit_detail": {},
    }


def test_durable_source_ledger_roundtrip_keeps_call_outcomes_and_ignores_teardown_mirror(tmp_path):
    ledger, nodeids, excluded = _durable_ledger_fixture()
    for slug in ("beta", "alpha"):
        ledger.start(slug, nodeid=nodeids[slug], query_id=ledger.query_ids[slug])
        ledger.finish(slug, result="answered_nonempty", returned_count=1, outcome=_full_outcome(partial=slug == "alpha"))
    aggregate_node = "resmon_scripts/verification_scripts/test_entity_search_live.py::test_at_least_most_sources_answered"
    selected = [*nodeids.values(), *excluded.values(), aggregate_node]
    writer = _writer(tmp_path)
    writer.collection(selected, live_suite.SCHEDULED_SELECTION)
    for slug in ("alpha", "beta"):
        nodeid = nodeids[slug]
        prop = [("source_ledger", ledger.record(slug))]
        writer.start(nodeid)
        writer.report(_report(nodeid, "setup", "passed"))
        writer.report(_report(nodeid, "call", "failed" if slug == "alpha" else "passed", properties=prop))
        writer.report(_report(nodeid, "teardown", "passed", properties=prop))
    keyed_node = excluded["core"]
    writer.start(keyed_node)
    writer.report(_report(keyed_node, "setup", "passed"))
    writer.report(_report(keyed_node, "call", "skipped"))
    writer.report(_report(keyed_node, "teardown", "passed"))
    aggregate = ledger.durable_summary(nodeid=aggregate_node)
    writer.start(aggregate_node)
    writer.report(_report(aggregate_node, "setup", "passed"))
    writer.report(_report(aggregate_node, "call", "passed", properties=[("source_aggregate", aggregate)]))
    writer.report(_report(aggregate_node, "teardown", "passed", properties=[("source_aggregate", aggregate)]))
    writer.finish(1)
    reduction = validate_evidence(tmp_path)
    durable = reduction["source_ledger"]
    assert durable["answered"] == ["alpha", "beta"]
    assert durable["partial"] == ["alpha"]
    assert durable["minimum"] == 1 and durable["threshold_pass"] is True
    assert durable["complete"] is True and durable["acceptance_available"] is True
    assert durable["aggregate_case_outcome"] == "passed"
    assert {row["slug"]: row["source_case_outcome"] for row in durable["sources"]} == {"alpha": "failed", "beta": "passed"}
    events = [json.loads(line) for line in (tmp_path / "events.jsonl").read_text().splitlines()]
    assert sum("source_ledger" in event.get("properties", {}) for event in events) == 2
    assert "SECRET" not in (tmp_path / "events.jsonl").read_text()
    summary = live_suite.evidence_summary(tmp_path)
    assert "Complete denominator: 2 keyless sources; minimum 1" in summary
    assert "threshold **passed**; aggregate case **passed**" in summary
    assert "Answered: `alpha`, `beta`" in summary
    assert "Partial within answered: `alpha`" in summary
    assert "`alpha`: result `answered_nonempty`; returned 1; partial yes; source case `failed`" in summary
    assert "SECRET" not in summary


def test_durable_source_ledger_rejects_duplicate_call_property_and_malformed_outcome(tmp_path):
    ledger, nodeids, _ = _durable_ledger_fixture()
    ledger.start("alpha", nodeid=nodeids["alpha"], query_id=ledger.query_ids["alpha"])
    ledger.finish("alpha", result="answered_nonempty", returned_count=1, outcome=_full_outcome())
    writer = _writer(tmp_path)
    writer.collection([nodeids["alpha"]], live_suite.SCHEDULED_SELECTION)
    prop = ledger.record("alpha")
    with pytest.raises(AssertionError, match="duplicate structured"):
        writer.report(_report(nodeids["alpha"], "call", "passed", properties=[("source_ledger", prop), ("source_ledger", prop)]))
    malformed = json.loads(json.dumps(prop))
    malformed["outcome"]["extra"] = "hidden"
    with pytest.raises(AssertionError, match="exact structured schema"):
        writer.report(_report(nodeids["alpha"], "call", "passed", properties=[("source_ledger", malformed)]))


def test_durable_source_ledger_rejects_missing_structured_evidence(tmp_path):
    _, nodeids, _ = _durable_ledger_fixture()
    aggregate_node = (
        "resmon_scripts/verification_scripts/test_entity_search_live.py::"
        "test_at_least_most_sources_answered"
    )
    writer = _writer(tmp_path)
    writer.collection([*nodeids.values(), aggregate_node], live_suite.SCHEDULED_SELECTION)
    for nodeid in [*nodeids.values(), aggregate_node]:
        writer.start(nodeid)
        writer.report(_report(nodeid, "setup", "passed"))
        writer.report(_report(nodeid, "call", "passed"))
        writer.report(_report(nodeid, "teardown", "passed"))
    writer.finish(0)
    partial = reduce_evidence(tmp_path, require_finish=False)["source_ledger"]
    assert partial["complete"] is False
    assert partial["acceptance_available"] is False
    assert partial["observed"] == []
    assert partial["missing"] == ["alpha", "beta"]
    with pytest.raises(AssertionError):
        validate_evidence(tmp_path)


@pytest.mark.parametrize("cut", ["before-first", "midway", "before-aggregate"])
def test_incomplete_source_ledger_preserves_partial_summary_but_never_accepts(
    tmp_path, cut,
):
    ledger, nodeids, excluded = _durable_ledger_fixture()
    aggregate_node = (
        "resmon_scripts/verification_scripts/test_entity_search_live.py::"
        "test_at_least_most_sources_answered"
    )
    writer = _writer(tmp_path)
    writer.collection(
        [*nodeids.values(), *excluded.values(), aggregate_node],
        live_suite.SCHEDULED_SELECTION,
    )
    completed = [] if cut == "before-first" else ["alpha"]
    if cut == "before-aggregate":
        completed.append("beta")
    for slug in completed:
        ledger.start(slug, nodeid=nodeids[slug], query_id=ledger.query_ids[slug])
        ledger.finish(
            slug, result="answered_nonempty", returned_count=1,
            outcome=_full_outcome(partial=slug == "alpha"),
        )
        writer.start(nodeids[slug])
        writer.report(_report(nodeids[slug], "setup", "passed"))
        writer.report(_report(
            nodeids[slug], "call", "passed",
            properties=[("source_ledger", ledger.record(slug))],
        ))
        writer.report(_report(nodeids[slug], "teardown", "passed"))
    if cut == "before-aggregate":
        keyed_node = excluded["core"]
        writer.start(keyed_node)
        writer.report(_report(keyed_node, "setup", "passed"))
        writer.report(_report(keyed_node, "call", "skipped"))
        writer.report(_report(keyed_node, "teardown", "passed"))
    writer.finish(1)
    reduction = reduce_evidence(tmp_path, require_finish=False)
    durable = reduction["source_ledger"]
    assert durable["complete"] is False
    assert durable["acceptance_available"] is False
    assert durable["threshold_pass"] is None
    assert durable["aggregate_present"] is False
    assert durable["observed"] == completed
    assert durable["missing"] == sorted(set(nodeids) - set(completed))
    summary = live_suite.evidence_summary(tmp_path)
    assert "Source-response ledger — incomplete" in summary
    assert "No aggregate acceptance is available" in summary
    assert f"aggregate present: no" in summary
    with pytest.raises(AssertionError):
        validate_evidence(tmp_path)


@pytest.mark.parametrize(("field", "value"), [
    ("minimum", 1.0), ("minimum", True),
    ("record_count", 2.0), ("record_count", True),
])
def test_durable_source_ledger_rejects_non_integer_denominator_counts(
    tmp_path, field, value,
):
    ledger, nodeids, _ = _durable_ledger_fixture()
    for slug in ("alpha", "beta"):
        ledger.start(slug, nodeid=nodeids[slug], query_id=ledger.query_ids[slug])
        ledger.finish(
            slug, result="answered_nonempty", returned_count=1,
            outcome=_full_outcome(),
        )
    aggregate = ledger.durable_summary(nodeid=(
        "resmon_scripts/verification_scripts/test_entity_search_live.py::"
        "test_at_least_most_sources_answered"
    ))
    aggregate[field] = value
    writer = _writer(tmp_path)
    with pytest.raises(AssertionError, match="counts must be integers"):
        writer.report(_report(
            aggregate["nodeid"], "call", "passed",
            properties=[("source_aggregate", aggregate)],
        ))


def test_durable_source_ledger_rejects_reclassifying_keyless_source_as_keyed():
    prefix = "resmon_scripts/verification_scripts/test_entity_search_live.py::"
    expected_nodeids = {
        "alpha": f"{prefix}test_a_real_source_answers_a_real_author_query[alpha]",
    }
    excluded = {
        "oapen": f"{prefix}test_a_real_source_answers_a_real_author_query[oapen]",
    }
    query_ids = {"alpha": stable_hash({"slug": "alpha"})}
    contract = {
        "module": "test_entity_search_live.py",
        "markexpr": live_suite.SCHEDULED_SELECTION,
        "catalog_sources": ["alpha", "oapen"],
        "expected_nodeids": expected_nodeids,
        "excluded_keyed_nodeids": excluded,
        "query_ids": query_ids,
    }
    with pytest.raises(AssertionError, match="canonical keyed sources"):
        CurrentRunSourceLedger(
            ("alpha",), candidate_head="abc", selection_id=stable_hash(contract),
            query_ids=query_ids, nodeids=expected_nodeids, source_contract=contract,
        )


def _write_complete_durable_source_evidence(root):
    ledger, nodeids, excluded = _durable_ledger_fixture()
    for slug in ("alpha", "beta"):
        ledger.start(slug, nodeid=nodeids[slug], query_id=ledger.query_ids[slug])
        ledger.finish(slug, result="answered_nonempty", returned_count=1, outcome=_full_outcome())
    aggregate_node = "resmon_scripts/verification_scripts/test_entity_search_live.py::test_at_least_most_sources_answered"
    writer = _writer(root)
    writer.collection([*nodeids.values(), *excluded.values(), aggregate_node], live_suite.SCHEDULED_SELECTION)
    for slug in ("alpha", "beta"):
        writer.start(nodeids[slug]); writer.report(_report(nodeids[slug], "setup", "passed"))
        writer.report(_report(nodeids[slug], "call", "passed", properties=[("source_ledger", ledger.record(slug))]))
        writer.report(_report(nodeids[slug], "teardown", "passed"))
    for nodeid in excluded.values():
        writer.start(nodeid); writer.report(_report(nodeid, "setup", "passed")); writer.report(_report(nodeid, "call", "skipped")); writer.report(_report(nodeid, "teardown", "passed"))
    aggregate = ledger.durable_summary(nodeid=aggregate_node)
    writer.start(aggregate_node); writer.report(_report(aggregate_node, "setup", "passed")); writer.report(_report(aggregate_node, "call", "passed", properties=[("source_aggregate", aggregate)])); writer.report(_report(aggregate_node, "teardown", "passed")); writer.finish(0)
    return [
        json.loads(line)
        for line in (root / "events.jsonl").read_text().splitlines()
    ]


def _replace_events(root, events):
    (root / "events.jsonl").write_text(
        "".join(json.dumps(event, sort_keys=True) + "\n" for event in events),
        encoding="utf-8",
    )


@pytest.mark.parametrize("cut", ["source-call", "aggregate-call"])
def test_source_ledger_needs_complete_pytest_lifecycles(tmp_path, cut):
    events = _write_complete_durable_source_evidence(tmp_path)
    if cut == "source-call":
        target = next(
            index for index, event in enumerate(events)
            if event.get("event") == "report"
            and event.get("nodeid", "").endswith("[beta]")
            and event.get("phase") == "call"
        )
    else:
        target = next(
            index for index, event in enumerate(events)
            if "source_aggregate" in event.get("properties", {})
        )
    _replace_events(tmp_path, events[:target + 1])
    reduction = reduce_evidence(tmp_path, require_finish=False)
    durable = reduction["source_ledger"]
    assert durable["complete"] is False
    assert durable["acceptance_available"] is False
    assert durable["threshold_pass"] is None
    assert durable["incomplete_lifecycle"]
    summary = live_suite.evidence_summary(tmp_path)
    assert "Source-response ledger — incomplete" in summary
    assert "threshold **passed**" not in summary
    with pytest.raises(AssertionError):
        validate_evidence(tmp_path)


def test_partial_source_summary_bounds_markdown_and_invalid_outcome(tmp_path):
    events = _write_complete_durable_source_evidence(tmp_path)
    row_event = next(
        event for event in events if "source_ledger" in event.get("properties", {})
    )
    payload = "failed` <img src=x onerror=alert(1)>" * 20
    row_event["outcome"] = payload
    _replace_events(tmp_path, events)
    durable = reduce_evidence(tmp_path, require_finish=False)["source_ledger"]
    assert durable["complete"] is False
    assert durable["acceptance_available"] is False
    assert durable["sources"][0]["source_case_outcome"] is None
    summary = live_suite.evidence_summary(tmp_path)
    assert payload not in summary
    assert "source case `unavailable`" in summary
    with pytest.raises(AssertionError):
        validate_evidence(tmp_path)


def test_markdown_active_slug_is_rendered_inside_a_safe_code_span(tmp_path):
    slug = "alpha` <img src=x onerror=alert(1)>"
    prefix = "resmon_scripts/verification_scripts/test_entity_search_live.py::"
    nodeid = f"{prefix}test_a_real_source_answers_a_real_author_query[{slug}]"
    query_id = stable_hash({"slug": slug})
    contract = {
        "module": "test_entity_search_live.py",
        "markexpr": live_suite.SCHEDULED_SELECTION,
        "catalog_sources": [slug],
        "expected_nodeids": {slug: nodeid},
        "excluded_keyed_nodeids": {},
        "query_ids": {slug: query_id},
    }
    ledger = CurrentRunSourceLedger(
        (slug,), candidate_head="abc", selection_id=stable_hash(contract),
        query_ids={slug: query_id}, nodeids={slug: nodeid},
        session_id="source-session", source_contract=contract,
    )
    ledger.start(slug, nodeid=nodeid, query_id=query_id)
    ledger.finish(
        slug, result="answered_nonempty", returned_count=1,
        outcome=_full_outcome(),
    )
    aggregate_node = f"{prefix}test_at_least_most_sources_answered"
    writer = _writer(tmp_path)
    writer.collection([nodeid, aggregate_node], live_suite.SCHEDULED_SELECTION)
    writer.start(nodeid)
    writer.report(_report(nodeid, "setup", "passed"))
    writer.report(_report(
        nodeid, "call", "passed",
        properties=[("source_ledger", ledger.record(slug))],
    ))
    writer.report(_report(nodeid, "teardown", "passed"))
    writer.start(aggregate_node)
    writer.report(_report(aggregate_node, "setup", "passed"))
    writer.report(_report(
        aggregate_node, "call", "passed",
        properties=[
            ("source_aggregate", ledger.durable_summary(nodeid=aggregate_node)),
        ],
    ))
    writer.report(_report(aggregate_node, "teardown", "passed"))
    writer.finish(0)
    summary = live_suite.evidence_summary(tmp_path)
    assert "- ``alpha` <img src=x onerror=alert(1)>``:" in summary
    assert "- `alpha` <img" not in summary


def test_live_source_fixture_contract_is_independent_of_selected_items():
    from test_entity_search_live import source_response_ledger

    option = SimpleNamespace(markexpr=live_suite.SCHEDULED_SELECTION)
    config = SimpleNamespace(option=option, rootpath=PROJECT_ROOT)
    selection_shapes = [
        ["one-author"], ["keyed-only"], ["aggregate-only"],
        ["beta", "alpha"], ["full"],
    ]
    contracts = []
    for items in selection_shapes:
        request = SimpleNamespace(
            config=config, session=SimpleNamespace(items=items),
        )
        ledger = source_response_ledger.__wrapped__(request)
        contracts.append(ledger.source_contract)
        assert set(ledger.nodeids) == set(ledger.expected)
        with pytest.raises(AssertionError, match="incomplete"):
            ledger.assert_threshold()
    assert all(contract == contracts[0] for contract in contracts[1:])


def test_durable_source_ledger_reducer_rejects_stale_outer_run_and_shortened_denominator(tmp_path):
    events = _write_complete_durable_source_evidence(tmp_path)
    row_event = next(event for event in events if "source_ledger" in event.get("properties", {}))
    row_event["properties"]["source_ledger"]["evidence_run_id"] = "stale"
    _replace_events(tmp_path, events)
    with pytest.raises(AssertionError, match="wrong evidence_run_id"):
        validate_evidence(tmp_path)


def test_durable_source_ledger_reducer_rejects_property_moved_to_teardown(tmp_path):
    events = _write_complete_durable_source_evidence(tmp_path)
    row_event = next(
        event for event in events if "source_ledger" in event.get("properties", {})
    )
    teardown = next(
        event for event in events
        if event.get("event") == "report"
        and event.get("nodeid") == row_event["nodeid"]
        and event.get("phase") == "teardown"
    )
    row_event["phase"], teardown["phase"] = teardown["phase"], row_event["phase"]
    _replace_events(tmp_path, events)
    with pytest.raises(AssertionError, match="call-only"):
        validate_evidence(tmp_path)


def test_durable_source_ledger_reducer_rejects_threshold_call_mismatch(tmp_path):
    events = _write_complete_durable_source_evidence(tmp_path)
    aggregate_event = next(
        event for event in events if "source_aggregate" in event.get("properties", {})
    )
    assert aggregate_event["properties"]["source_aggregate"]["threshold_pass"] is True
    aggregate_event["outcome"] = "failed"
    _replace_events(tmp_path, events)
    with pytest.raises(AssertionError, match="contradicts threshold"):
        validate_evidence(tmp_path)


def test_durable_source_ledger_reducer_requires_raised_row_to_have_failed_call(tmp_path):
    events = _write_complete_durable_source_evidence(tmp_path)
    row_event = next(
        event for event in events if "source_ledger" in event.get("properties", {})
    )
    row = row_event["properties"]["source_ledger"]
    row.update({
        "result": "raised", "returned_count": None,
        "error_type": "RuntimeError", "error_message": "bounded failure",
    })
    _replace_events(tmp_path, events)
    with pytest.raises(AssertionError, match="raised source row must have a failed call"):
        validate_evidence(tmp_path)


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


@pytest.mark.parametrize("plugin_autoload", [True, False])
def test_real_pytest_failure_keeps_nonzero_status_and_durable_reports(
    tmp_path, plugin_autoload,
):
    case = tmp_path / "test_deliberate.py"
    case.write_text(
        "def test_pass():\n    pass\n\n"
        "def test_deliberate_failure():\n    assert False, 'deliberate proof'\n",
        encoding="utf-8",
    )
    evidence = tmp_path / "evidence"
    env = os.environ.copy()
    if plugin_autoload:
        env.pop("PYTEST_DISABLE_PLUGIN_AUTOLOAD", None)
    else:
        env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
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
            "-p", "timeout",
            "-p", "resmon_scripts.verification_scripts.conftest",
            "-p", "no:cacheprovider",
            "--timeout=5", "-q", str(case),
        ],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    # Preserve the complete child streams before making any assertion; hosted
    # failures must not be reduced to pytest's bounded assertion rendering.
    mode = "autoload-on" if plugin_autoload else "autoload-off"
    (tmp_path / f"{mode}.stdout").write_text(result.stdout, encoding="utf-8")
    (tmp_path / f"{mode}.stderr").write_text(result.stderr, encoding="utf-8")
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


# ---------------------------------------------------------------------------
# The provider-outage quarantine
# ---------------------------------------------------------------------------
#
# ``live_quarantine.json`` names at most two live cases whose failure may be
# excused while a provider is down. Each case still runs and still asserts.
# The mechanism is proved here the way B2 asks for a new gate: every branch
# is made to go red or green at a real pytest exit status, in a child process
# with the production conftest loaded. A matching failure passes the run, a
# non-matching one fails it, a pass is called a recovery, and an expired
# entry changes nothing.

from datetime import date, timedelta  # noqa: E402

from live_evidence import (  # noqa: E402
    QUARANTINE_FILE,
    QUARANTINE_MAX_DAYS,
    QUARANTINE_MAX_ENTRIES,
    asserted_line,
    load_quarantine,
    quarantine_disposition,
    quarantine_line,
    source_outcome_property,
    utc_today,
)


def _observation(vantage, observed, status="http_500"):
    return {
        "vantage": vantage, "observed": observed, "status": status,
        "reference": "synthetic observation for a hermetic proof",
    }


def _entry(nodeid, *, first, expires, signature="http_500", source="oapen", evidence=None):
    return {
        "nodeid": nodeid, "source": source, "signature": signature,
        "first_observed": first.isoformat(), "expires": expires.isoformat(),
        "reason": "synthetic provider outage",
        "evidence": evidence if evidence is not None else [
            _observation("runner", first.isoformat()),
            _observation("workstation", first.isoformat()),
        ],
    }


def _write_quarantine(path, entries):
    path.write_text(json.dumps({
        "schema": "resmon.live-quarantine.v1",
        "policy": "synthetic policy for a hermetic proof",
        "entries": entries,
    }), encoding="utf-8")
    return path


def test_the_shipped_quarantine_is_valid_and_names_scheduled_live_cases(collections):
    """Every entry names a case the weekly job really runs.

    An entry for a node that no longer exists would excuse nothing and still
    read as a quarantine in the summary. An entry for a local-only case would
    describe a job that never runs it.
    """
    entries = load_quarantine(QUARANTINE_FILE)
    assert len(entries) <= QUARANTINE_MAX_ENTRIES
    for entry in entries:
        assert entry.nodeid in collections["scheduled"], entry.nodeid
        assert entry.expires <= entry.first_observed + timedelta(days=QUARANTINE_MAX_DAYS)
        vantages = {item["vantage"] for item in entry.evidence if item["status"] == entry.signature}
        assert len(vantages) >= 2, entry.nodeid
    assert [entry.nodeid for entry in entries][:1] == [
        "resmon_scripts/verification_scripts/test_api_tier4.py::test_oapen_live_search",
    ]


def test_quarantine_admits_two_entries_and_rejects_a_third(tmp_path):
    first = utc_today()
    entries = [
        _entry(f"test_case.py::test_{index}", first=first, expires=first + timedelta(days=5))
        for index in range(3)
    ]
    assert len(load_quarantine(_write_quarantine(tmp_path / "two.json", entries[:2]))) == 2
    with pytest.raises(AssertionError, match="at most 2 live cases"):
        load_quarantine(_write_quarantine(tmp_path / "three.json", entries))


def test_quarantine_expiry_is_at_most_thirty_days_after_first_observed(tmp_path):
    first = utc_today() - timedelta(days=3)
    thirty = _entry("test_case.py::test_a", first=first, expires=first + timedelta(days=30))
    assert load_quarantine(_write_quarantine(tmp_path / "ok.json", [thirty]))
    late = _entry("test_case.py::test_a", first=first, expires=first + timedelta(days=31))
    with pytest.raises(AssertionError, match="at most 30 days"):
        load_quarantine(_write_quarantine(tmp_path / "late.json", [late]))
    backwards = _entry("test_case.py::test_a", first=first, expires=first - timedelta(days=1))
    with pytest.raises(AssertionError, match="expires before"):
        load_quarantine(_write_quarantine(tmp_path / "back.json", [backwards]))


@pytest.mark.parametrize("evidence,match", [
    ([_observation("runner", "2026-09-18"), _observation("runner", "2026-09-18")],
     "two vantage points"),
    ([_observation("runner", "2026-09-18"), _observation("workstation", "2026-09-18", "timeout")],
     "two vantage points"),
    ([_observation("runner", "2026-09-18")], "two to eight"),
    ([_observation("runner", "2026-09-19"), _observation("workstation", "2026-09-19")],
     "earliest observation"),
])
def test_quarantine_admission_needs_the_status_from_two_vantage_points(tmp_path, evidence, match):
    first = date(2026, 9, 18)
    entry = _entry("test_case.py::test_a", first=first,
                   expires=first + timedelta(days=10), evidence=evidence)
    with pytest.raises(AssertionError, match=match):
        load_quarantine(_write_quarantine(tmp_path / "q.json", [entry]))


@pytest.mark.parametrize("field,value,match", [
    ("signature", "HTTP 500 GenericJDBCException", "one failure category"),
    ("signature", "http_5000", "one failure category"),
    ("source", "OAPEN Library", "catalog slug"),
    ("nodeid", "test_case.py", "must name a test"),
])
def test_quarantine_fields_are_closed_vocabularies(tmp_path, field, value, match):
    first = utc_today()
    entry = _entry("test_case.py::test_a", first=first, expires=first + timedelta(days=1))
    entry[field] = value
    with pytest.raises(AssertionError, match=match):
        load_quarantine(_write_quarantine(tmp_path / "q.json", [entry]))


def test_the_denominator_is_derived_from_the_collection_it_is_given(tmp_path):
    """P6: "N of M" moves with the collection. It is not a typed number.

    Two collections of different sizes and one entry outside both prove the
    sentence counts what it is handed, and only what is in it.
    """
    today = utc_today()
    path = _write_quarantine(tmp_path / "q.json", [
        _entry("a.py::test_quarantined", first=today, expires=today + timedelta(days=30)),
        _entry("z.py::test_not_collected", first=today, expires=today + timedelta(days=30)),
    ])
    entries = load_quarantine(path)
    label = f"oapen, since {today.isoformat()}, http_500, expires {(today + timedelta(days=30)).isoformat()}"
    small = ["a.py::test_quarantined", "b.py::test_other", "c.py::test_third"]
    large = small + [f"d.py::test_{index}" for index in range(89)]
    assert quarantine_line(small, entries, today) == f"2 of 3 asserted; 1 quarantined ({label})"
    assert quarantine_line(large, entries, today) == f"91 of 92 asserted; 1 quarantined ({label})"
    assert quarantine_line(large, entries, today + timedelta(days=31)) == (
        "92 of 92 asserted; 0 quarantined")
    assert asserted_line(5, []) == "5 of 5 asserted; 0 quarantined"


def test_the_run_summary_quarantine_line_comes_from_the_scheduled_collection(collections):
    """P6 at the real summary: its M is the scheduled collection's length."""
    scheduled = collections["scheduled"]
    entries = load_quarantine(QUARANTINE_FILE)
    expected = quarantine_line(scheduled, entries, utc_today())
    active = sum(entry.active(utc_today()) for entry in entries if entry.nodeid in scheduled)
    assert expected.startswith(f"{len(scheduled) - active} of {len(scheduled)} asserted; {active} quarantined")
    rendered = live_suite.summary()
    assert f"**{expected}.**" in rendered


# Child-process proofs. The case file is written per branch. Its quarantined
# test records a real ``SearchOutcome`` snapshot, built through the same
# methods ``safe_request`` calls, and then asserts the way the OAPEN live
# case does. A second, unquarantined case makes the denominator two.
_CASE_FILE = '''
import os

import httpx
import pytest

from resmon_scripts.implementation_scripts import api_base
from resmon_scripts.verification_scripts.live_evidence import source_outcome_property

MODE = os.environ["QUARANTINE_PROOF_MODE"]


def _outcome(*steps):
    outcome = api_base.SearchOutcome()
    for kind, value, terminal in steps:
        outcome.note_attempt()
        failure = value if kind == "status" else httpx.ReadTimeout("slow")
        if terminal:
            outcome.note_failure(failure)
        else:
            outcome.note_retried_failure(failure)
    return outcome.snapshot()


@pytest.mark.live_network
def test_quarantined_provider(record_property):
    rows = 0
    if MODE in ("match", "crash"):
        snapshot = _outcome(("status", 500, False), ("timeout", None, True))
    elif MODE == "other_status":
        snapshot = _outcome(("status", 503, False), ("status", 503, True))
    elif MODE == "timeouts_only":
        snapshot = _outcome(("timeout", None, False), ("timeout", None, True))
    else:
        # The 500 was retried and the retry answered: rows came back.
        outcome = api_base.SearchOutcome()
        outcome.note_attempt()
        outcome.note_retried_failure(500)
        outcome.note_attempt()
        snapshot = outcome.snapshot()
        rows = 2
    record_property("source_outcome", source_outcome_property("oapen", snapshot))
    if MODE == "crash":
        raise TypeError("a crash is never a provider outage")
    assert rows == 2, snapshot["failure_history"]
    if MODE == "wrong_dates":
        assert "2019" >= "2020", "a publication year outside the requested window"


@pytest.mark.live_network
def test_unquarantined_neighbour():
    pass
'''

_QUARANTINED_NODE = "test_quarantine_case.py::test_quarantined_provider"


def _run_quarantine_case(tmp_path, mode, *, expired=False):
    """Run the case file under the production conftest. Returns (result, evidence)."""
    case = tmp_path / "test_quarantine_case.py"
    case.write_text(_CASE_FILE, encoding="utf-8")
    today = utc_today()
    if expired:
        first, expires = today - timedelta(days=30), today - timedelta(days=1)
    else:
        first, expires = today - timedelta(days=1), today + timedelta(days=29)
    quarantine = _write_quarantine(
        tmp_path / "quarantine.json",
        [_entry(_QUARANTINED_NODE, first=first, expires=expires)],
    )
    evidence = tmp_path / "evidence"
    env = os.environ.copy()
    env.update({
        "QUARANTINE_PROOF_MODE": mode,
        "RESMON_LIVE_QUARANTINE_FILE": str(quarantine),
        "RESMON_LIVE_EVIDENCE_DIR": str(evidence),
        "RESMON_LIVE_CANDIDATE_SHA": "candidate-proof",
        "RESMON_LIVE_CHECKOUT_SHA": "checkout-proof",
        "RESMON_LIVE_SELECTION": "live_network",
    })
    result = subprocess.run(
        [
            sys.executable, "-m", "pytest",
            "-c", str(PROJECT_ROOT / "pytest.ini"),
            "--rootdir", str(tmp_path),
            "-p", "timeout",
            "-p", "resmon_scripts.verification_scripts.conftest",
            "-p", "no:cacheprovider",
            "-m", "live_network",
            "--timeout=30", "-rx", "-v", str(case),
        ],
        cwd=PROJECT_ROOT, env=env, capture_output=True, text=True, timeout=120,
    )
    (tmp_path / f"{mode}.stdout").write_text(result.stdout, encoding="utf-8")
    (tmp_path / f"{mode}.stderr").write_text(result.stderr, encoding="utf-8")
    return result, evidence


@pytest.mark.parametrize("mode,expired,status,outcome,sentence,quarantined", [
    # Matching signature: the failure is excused and the run passes.
    ("match", False, pytest.ExitCode.OK, "skipped",
     "QUARANTINED test_quarantine_case.py::test_quarantined_provider: failed with "
     "the excused signature (observed http_500 -> timeout); not counted as a failure.", 1),
    # A different status, or a timeout alone, is a real failure.
    ("other_status", False, pytest.ExitCode.TESTS_FAILED, "failed",
     "NOT EXCUSED test_quarantine_case.py::test_quarantined_provider: failed, but not "
     "with the excused signature (observed http_503 -> http_503); counted as a failure.", 0),
    ("timeouts_only", False, pytest.ExitCode.TESTS_FAILED, "failed",
     "NOT EXCUSED test_quarantine_case.py::test_quarantined_provider: failed, but not "
     "with the excused signature (observed timeout -> timeout); counted as a failure.", 0),
    # The 500 is in the history, but the search answered and a date check
    # failed. That is a wrong answer, not an outage, and it counts.
    ("wrong_dates", False, pytest.ExitCode.TESTS_FAILED, "failed",
     "NOT EXCUSED test_quarantine_case.py::test_quarantined_provider: failed, but not "
     "with the excused signature (observed http_500); counted as a failure.", 0),
    # A matching outcome followed by a crash, not an assertion: it counts.
    ("crash", False, pytest.ExitCode.TESTS_FAILED, "failed",
     "NOT EXCUSED test_quarantine_case.py::test_quarantined_provider: failed, but not "
     "with the excused signature (observed http_500 -> timeout); counted as a failure.", 0),
    # A pass while quarantined is reported as a recovery; the run stays green.
    ("recovered", False, pytest.ExitCode.OK, "passed",
     "RECOVERED test_quarantine_case.py::test_quarantined_provider: passed while "
     "quarantined", 0),
    # An expired entry changes nothing: the matching failure fails the run.
    ("match", True, pytest.ExitCode.TESTS_FAILED, "failed",
     "EXPIRED test_quarantine_case.py::test_quarantined_provider: the quarantine", 0),
], ids=["match", "other-status", "timeouts-only", "wrong-dates", "crash", "recovered", "expired"])
def test_quarantine_branches_at_the_real_exit_status(
    tmp_path, mode, expired, status, outcome, sentence, quarantined,
):
    """P5: all five branches, observed at pytest's exit status and in both summaries."""
    result, evidence = _run_quarantine_case(tmp_path, mode, expired=expired)
    assert result.returncode == int(status), (result.stdout[-4000:], result.stderr[-2000:])

    # The terminal summary always prints the denominator from the session's
    # own live collection: two cases, one of them quarantined unless expired.
    active = 0 if expired else 1
    assert f"{2 - active} of 2 asserted; {active} quarantined" in result.stdout
    assert sentence in result.stdout, result.stdout[-4000:]
    if mode == "match" and not expired:
        assert "XFAIL" in result.stdout

    # The durable evidence agrees with the exit status and renders the same facts.
    reduction = validate_evidence(evidence)
    assert reduction["outcomes"][_QUARANTINED_NODE] == outcome
    assert reduction["finish"]["exitstatus"] == int(status)
    disposition = reduction["quarantine"]["dispositions"][_QUARANTINED_NODE]["disposition"]
    assert disposition == {
        "match": "expired" if expired else "excused", "recovered": "recovered",
    }.get(mode, "unmatched")
    rendered = live_suite.evidence_summary(evidence)
    assert f"**{2 - active} of 2 asserted; {active} quarantined" in rendered
    assert f", {quarantined} quarantined;" in rendered
    assert sentence.split(":")[0].split(" ")[0] in rendered
    assert "### Recorded source failure history" in rendered or mode == "recovered"


def test_an_unreadable_quarantine_excuses_nothing_and_fails_the_session(tmp_path):
    result, _evidence = _run_quarantine_case(tmp_path, "match")
    assert result.returncode == int(pytest.ExitCode.OK)
    (tmp_path / "quarantine.json").write_text("{not json", encoding="utf-8")
    env_result, _ = _run_quarantine_case_with_existing_file(tmp_path, "recovered")
    assert env_result.returncode == int(pytest.ExitCode.TESTS_FAILED)
    assert "QUARANTINE UNREADABLE" in env_result.stdout


def _run_quarantine_case_with_existing_file(tmp_path, mode):
    """Like ``_run_quarantine_case`` but keeps whatever quarantine file is there."""
    evidence = tmp_path / "evidence-existing"
    env = os.environ.copy()
    env.update({
        "QUARANTINE_PROOF_MODE": mode,
        "RESMON_LIVE_QUARANTINE_FILE": str(tmp_path / "quarantine.json"),
        "RESMON_LIVE_EVIDENCE_DIR": str(evidence),
        "RESMON_LIVE_CANDIDATE_SHA": "candidate-proof",
        "RESMON_LIVE_CHECKOUT_SHA": "checkout-proof",
        "RESMON_LIVE_SELECTION": "live_network",
    })
    result = subprocess.run(
        [
            sys.executable, "-m", "pytest",
            "-c", str(PROJECT_ROOT / "pytest.ini"),
            "--rootdir", str(tmp_path),
            "-p", "timeout",
            "-p", "resmon_scripts.verification_scripts.conftest",
            "-p", "no:cacheprovider",
            "-m", "live_network",
            "--timeout=30", "-v", str(tmp_path / "test_quarantine_case.py"),
        ],
        cwd=PROJECT_ROOT, env=env, capture_output=True, text=True, timeout=120,
    )
    return result, evidence


def test_the_reducer_rejects_a_disposition_that_contradicts_the_call(tmp_path):
    """The evidence cannot claim an excuse the exit status did not make."""
    record = {
        "nodeid": "test::quarantined", "source": "oapen", "signature": "http_500",
        "first_observed": "2026-09-18", "expires": "2026-10-18", "active": True,
    }
    writer = _writer(tmp_path)
    writer.collection(["test::quarantined"], live_suite.SCHEDULED_SELECTION, [record])
    writer.start("test::quarantined")
    writer.report(_report("test::quarantined", "setup", "passed"))
    writer.report(_report(
        "test::quarantined", "call", "failed", message="failed",
        properties=[("quarantine", {
            "entry": record, "disposition": "excused", "history": ["http_500"],
        })],
    ))
    writer.report(_report("test::quarantined", "teardown", "passed"))
    with pytest.raises(AssertionError, match="contradicts the call outcome"):
        reduce_evidence(tmp_path, require_finish=False)


def test_the_reducer_rejects_a_failed_quarantined_call_with_no_disposition(tmp_path):
    record = {
        "nodeid": "test::quarantined", "source": "oapen", "signature": "http_500",
        "first_observed": "2026-09-18", "expires": "2026-10-18", "active": True,
    }
    writer = _writer(tmp_path)
    writer.collection(["test::quarantined"], live_suite.SCHEDULED_SELECTION, [record])
    writer.start("test::quarantined")
    writer.report(_report("test::quarantined", "setup", "passed"))
    writer.report(_report("test::quarantined", "call", "failed", message="failed"))
    writer.report(_report("test::quarantined", "teardown", "passed"))
    with pytest.raises(AssertionError, match="must say its failure was not excused"):
        reduce_evidence(tmp_path, require_finish=False)


def test_source_outcome_property_keeps_categories_and_drops_text():
    snapshot = {
        "attempts": 2, "failures": 1, "last_call_failed": True,
        "last_status": None, "last_detail": "timeout",
        "retained_cooldown_status": None, "explicit_reason": None,
        "explicit_detail": None, "failure_history": ["http_500", "timeout"],
        "failure_history_omitted": 0,
        "unexpected": "https://example.invalid/?api_key=SECRETVALUE",
    }
    value = source_outcome_property("oapen", snapshot)
    assert value["failure_history"] == ["http_500", "timeout"]
    assert "SECRETVALUE" not in json.dumps(value)
    snapshot["failure_history"] = ["GenericJDBCException: Could not open connection"]
    with pytest.raises(AssertionError, match="failure history"):
        source_outcome_property("oapen", snapshot)


# ---------------------------------------------------------------------------
# The author-query cases record what their source did
# ---------------------------------------------------------------------------
#
# `test_api_tier4.py::test_oapen_live_search` records a `source_outcome`, which
# is the only reason the shipped quarantine entry can excuse it. The *other*
# OAPEN live case — the parametrised author query in
# `test_entity_search_live.py` — recorded none, so an entry naming it would
# have printed in the summary as a quarantine and excused nothing:
# `quarantine_disposition` needs exactly one recorded outcome in total and
# exactly one for the entry's source. Both halves are pinned below, and
# neither opens a socket.

import httpx  # noqa: E402

from implementation_scripts import api_base  # noqa: E402

import test_entity_search_live  # noqa: E402

_AUTHOR_QUERY_MODULE = "resmon_scripts/verification_scripts/test_entity_search_live.py"
_AUTHOR_QUERY_CASE = f"{_AUTHOR_QUERY_MODULE}::test_a_real_source_answers_a_real_author_query"


def _outage_snapshot():
    """The snapshot `safe_request` leaves behind on the OAPEN outage.

    Driven through `SearchOutcome`'s own methods rather than typed out, so the
    keys, the token vocabulary and the ordering are the ones production writes:
    a 500 that was retried, and a timeout that ended the search.
    """
    outcome = api_base.SearchOutcome()
    outcome.note_attempt()
    outcome.note_retried_failure(500)
    outcome.note_attempt()
    outcome.note_failure(httpx.ReadTimeout("slow"))
    return outcome.snapshot()


def test_a_recorded_author_query_outcome_is_what_lets_the_quarantine_excuse_it(tmp_path):
    """P1: with the property `excused`, without it `unmatched`.

    The real `quarantine_disposition`, a real entry read back through
    `load_quarantine`, and a real recorded property — no hand-written dicts.
    The second half is what the author-query case did before this change, and
    it is the whole reason an entry naming it would have been useless.
    """
    today = utc_today()
    entry = load_quarantine(_write_quarantine(tmp_path / "q.json", [
        _entry(f"{_AUTHOR_QUERY_CASE}[oapen]",
               first=today - timedelta(days=1), expires=today + timedelta(days=29)),
    ]))[0]
    recorded = source_outcome_property("oapen", _outage_snapshot())
    assert recorded["last_call_failed"] is True
    assert "http_500" in recorded["failure_history"]

    assert quarantine_disposition(
        entry, today, call_outcome="failed", assertion_failure=True,
        recorded=[recorded],
    ) == ("excused", ["http_500", "timeout"])

    # Today's behaviour without the property: the case is quarantined, runs,
    # fails with exactly the signature the entry names — and counts anyway.
    assert quarantine_disposition(
        entry, today, call_outcome="failed", assertion_failure=True, recorded=[],
    ) == ("unmatched", [])

    # Two sources on one report cannot say whose outage the failure was, so
    # the excuse fails closed rather than covering the second source too.
    assert quarantine_disposition(
        entry, today, call_outcome="failed", assertion_failure=True,
        recorded=[recorded, source_outcome_property("dblp", _outage_snapshot())],
    ) == ("unmatched", ["http_500", "timeout"])

    # The gate is pytest's own question — an `AssertionError` in the call
    # phase — and `pytest.fail` does not ask it. The strict-source branch of
    # the author-query case calls `pytest.fail` when the source answers with
    # nothing, which is the shape an OAPEN outage takes there, so that path
    # would still be `unmatched`. Recording the property is what this change
    # does; converting that branch is a separate decision, not one made here.
    assert not issubclass(pytest.fail.Exception, AssertionError)


# A client double for the real author-query module, registered with `-p` in a
# child process. It replaces the two names that module imported — `get_client`
# and `get_credential_for` — so every slug in the catalog denominator reaches a
# client call and records what a real one would. No askable source needs a key
# today; `get_credential_for` is replaced anyway so that a keyed source which
# later gains `entity_search` is covered rather than silently skipped out of
# the denominator. It also shuts the conftest socket guard again after that
# conftest has opened it for these `live_network` items: nothing in this run
# may leave the machine, and a double that leaked a real request fails here
# rather than quietly succeeding.
_ENTITY_DOUBLE_PLUGIN = '''
"""A hermetic stand-in for every askable source's client."""

import pytest


class _Double:
    """Answers one author query with one record that carries the asked name."""

    def __init__(self, slug):
        self.slug = slug

    def search_entity(self, profile, max_results=10):
        # Imported here, not at plugin load: the module under test puts
        # `resmon_scripts/` on `sys.path` when pytest imports it, and
        # `resmon_scripts.implementation_scripts.api_base` loaded any earlier
        # is a *second* module object — its own search outcome, its own
        # `Author` class, so `as_authors` would drop every author and the
        # recorded snapshot would show no attempt.
        from implementation_scripts import api_base  # noqa: PLC0415

        # One real attempt on the shared outcome, so the snapshot the case
        # records has the shape `safe_request` would have left behind: the
        # strict sources assert on `attempts` and on `last_call_failed`.
        api_base.search_outcome().note_attempt()
        name = profile["display_name"]
        url = ("https://dblp.org/rec/double1" if self.slug == "dblp"
               else "https://example.invalid/double1")
        return [api_base.NormalizedResult(
            source_repository=self.slug,
            external_id="double1",
            doi=None,
            title="A record from the hermetic double",
            authors=[api_base.Author(name=name, source_ids=((self.slug, "a1"),))],
            abstract=None,
            publication_date="2024-01-01",
            url=url,
        )]


def _shut_the_socket_guard(config):
    """Re-close the guard the production conftest opens for live_network."""
    closed = 0
    for plugin in config.pluginmanager.get_plugins():
        allow = getattr(plugin, "_allow_network", None)
        if isinstance(allow, dict) and "value" in allow:
            allow["value"] = False
            closed += 1
    assert closed == 1, f"expected one socket guard to shut, found {closed}"


@pytest.hookimpl(trylast=True)
def pytest_runtest_setup(item):
    module = getattr(item, "module", None)
    if module is not None and module.__name__.rsplit(".", 1)[-1] == "test_entity_search_live":
        module.get_client = _Double
        module.get_credential_for = lambda *args, **kwargs: "hermetic-double-key"
    _shut_the_socket_guard(item.config)
'''


def _run_author_query_hermetically(tmp_path):
    """Run the real author-query module against the double. Returns (result, evidence)."""
    (tmp_path / "entity_search_double.py").write_text(_ENTITY_DOUBLE_PLUGIN, encoding="utf-8")
    evidence = tmp_path / "evidence"
    env = os.environ.copy()
    env.update({
        "RESMON_LIVE_EVIDENCE_DIR": str(evidence),
        "RESMON_LIVE_CANDIDATE_SHA": "candidate-proof",
        "RESMON_LIVE_CHECKOUT_SHA": "checkout-proof",
        "RESMON_LIVE_SELECTION": "live_network",
        "PYTHONPATH": os.pathsep.join(
            [str(tmp_path)] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])),
    })
    result = subprocess.run(
        [
            sys.executable, "-m", "pytest",
            "-c", str(PROJECT_ROOT / "pytest.ini"),
            "-p", "timeout",
            "-p", "entity_search_double",
            "-p", "no:cacheprovider",
            "-m", "live_network",
            "--timeout=60", "-q", str(PROJECT_ROOT / _AUTHOR_QUERY_MODULE),
        ],
        cwd=PROJECT_ROOT, env=env, capture_output=True, text=True, timeout=300,
    )
    (tmp_path / "author-query.stdout").write_text(result.stdout, encoding="utf-8")
    (tmp_path / "author-query.stderr").write_text(result.stderr, encoding="utf-8")
    return result, evidence


def test_every_author_query_case_records_one_source_outcome_for_its_own_slug(tmp_path):
    """P2/D3: the property reaches pytest's own report, for every slug, in the call phase.

    The denominator is `_askable()` — the capability table — not a list here,
    so a source that gains `entity_search` and no recorded outcome fails. The
    schema is not asserted by inspection: `validate_evidence` puts every
    recorded property through `_canonical_source_outcome`, refuses one that
    arrived outside the call phase, and the evidence writer refuses a second
    `source_outcome` on one report — so a passing run is also the proof that
    each case records exactly one.
    """
    result, evidence = _run_author_query_hermetically(tmp_path)
    assert result.returncode == int(pytest.ExitCode.OK), (
        result.stdout[-6000:], result.stderr[-2000:])

    reduction = validate_evidence(evidence)
    recorded = {
        nodeid: value["source"]
        for nodeid, value in reduction["quarantine"]["source_outcomes"].items()
    }
    slugs = test_entity_search_live._askable()
    expected = {f"{_AUTHOR_QUERY_CASE}[{slug}]": slug for slug in slugs}
    assert recorded == expected, (
        f"{len(recorded)} of {len(slugs)} askable sources recorded a source "
        f"outcome naming themselves; missing "
        f"{sorted(set(expected) - set(recorded))}")
